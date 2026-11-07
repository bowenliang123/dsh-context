import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { HEADS_ROUTE, watchHeadsChannel } from '../../src/host/headsRoute'
import { apply, inject, name } from '../../src/host/index'
import type {} from '../../src/shared/types'

const plugin = { name, inject, apply } as never
const noConfig = {} as never

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

interface Harness {
  ctx: Context
  routes: Map<string, RouteBox>
  listed: { header: unknown }[]
  cacheMode: { throws: boolean; empty: boolean; requested: string[]; asOf: unknown }
  createSession: () => Session
}

async function boot(options: { queryThrows?: boolean | string } = {}): Promise<Harness> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  ctx.provide('connection', {
    fetch: {
      register: (r: never) => {
        const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
        routes.set(route.path, route)
        return () => {}
      },
    },
  })
  const listed: { header: unknown }[] = []
  ctx.provide('sessionQuery', {
    listSessions: () => options.queryThrows === true
      ? Promise.reject(new Error('list failed'))
      : options.queryThrows === undefined
        ? Promise.resolve(listed)
        : Promise.reject(options.queryThrows),
  })
  const cacheMode = { throws: false, empty: false, requested: [] as string[], asOf: 5 as unknown }
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: { id?: string }, keys: Set<string>) => {
      if (cacheMode.throws) throw new Error('cache read failed')
      assert.ok(keys.has('contextTimeline'))
      cacheMode.requested.push(header?.id ?? '')
      if (cacheMode.empty) return { values: {} }
      return { ...(cacheMode.asOf === undefined ? {} : { asOfSeq: cacheMode.asOf }), values: { contextTimeline: { ok: true, model: 'cached' } } }
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(plugin, noConfig)
  return {
    ctx,
    routes,
    listed,
    cacheMode,
    createSession: () => {
      const session = ctx.sessions.create()
      listed.push({ header: session.header })
      return session
    },
  }
}

async function callRoute(routes: Map<string, RouteBox>, body: unknown): Promise<{ ok: boolean; value?: Record<string, { head: Record<string, unknown>; asOfSeq?: number }>; error?: { code: string; message?: string } }> {
  if (!routes.has(HEADS_ROUTE)) await new Promise(resolve => setTimeout(resolve, 1))
  const route = routes.get(HEADS_ROUTE)
  assert.ok(route !== undefined && route.fetch !== undefined, 'the heads route registered')
  const response = await route.fetch(new Request(`http://dsh.test${HEADS_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return await response.json() as never
}

function appendHead(session: Session): void {
  session.append('request/header', {
    header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } },
    reason: 'initial',
  })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 0,
    message: { content: [{ type: 'text', text: 'hello' }] },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as never, { surfaceOp: 'append' })
}

describe('dsh-context heads route', () => {
  test('without the connection face the route never registers', async () => {
    const ctx = new Context()
    ctx.provide('connection', {} as never)
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve([]) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    watchHeadsChannel(ctx)
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(ctx.get('connection'), ctx.get('connection'))
  })

  test('serves live heads and cold cached heads in one request, deduping and filtering ids', async () => {
    const h = await boot()
    const session = h.createSession()
    appendHead(session)
    h.listed.push({ header: { id: 'cold-1', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })

    const read = await callRoute(h.routes, { ids: [session.header.id, 'cold-1', session.header.id, '', 'missing', 7] })
    assert.equal(read.ok, true)
    assert.deepEqual(Object.keys(read.value ?? {}).sort(), [session.header.id, 'cold-1'].sort())
    assert.equal(read.value?.[session.header.id]?.head.ok, true)
    assert.equal(read.value?.['cold-1']?.head.model, 'cached')
    assert.equal(read.value?.['cold-1']?.asOfSeq, 5)
    assert.deepEqual(h.cacheMode.requested, ['cold-1'], 'only the cold id reaches the cache')
  })

  test('rejects a missing or non-array ids body, and keeps only the first 64 ids', async () => {
    const h = await boot()
    assert.equal((await callRoute(h.routes, {})).error?.code, 'dsh-context/bad-request')
    assert.equal((await callRoute(h.routes, { ids: 'nope' })).error?.code, 'dsh-context/bad-request')
    assert.equal((await callRoute(h.routes, 'null')).error?.code, 'dsh-context/bad-request')
    const ids = Array.from({ length: 70 }, (_, i) => `cap-${i}`)
    for (const id of ids) h.listed.push({ header: { id, version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    const read = await callRoute(h.routes, { ids })
    assert.equal(read.ok, true)
    assert.equal(Object.keys(read.value ?? {}).length, 64, 'the batch is capped')
    assert.equal(h.cacheMode.requested.length, 64)
  })

  test('skips failed and empty rows while still serving the rest', async () => {
    const h = await boot()
    h.listed.push({ header: { id: 'cold-a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    h.listed.push({ header: { id: 'cold-b', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    h.cacheMode.throws = true
    const failed = await callRoute(h.routes, { ids: ['cold-a'] })
    assert.deepEqual(failed.value, {})
    h.cacheMode.throws = false
    h.cacheMode.empty = true
    const empty = await callRoute(h.routes, { ids: ['cold-a'] })
    assert.deepEqual(empty.value, {}, 'a row without a head is dropped')
    h.cacheMode.empty = false
    h.cacheMode.requested.length = 0
    const ok = await callRoute(h.routes, { ids: ['cold-a', 'cold-b'] })
    assert.equal(Object.keys(ok.value ?? {}).length, 2)
  })

  test('malformed bodies are rejected before the listing, and header-less records are skipped', async () => {
    const h = await boot()
    assert.equal((await callRoute(h.routes, '{')).ok, false, 'a malformed JSON body fails at the gate')
    h.listed.push({ header: null })
    h.listed.push({ header: {} })
    h.listed.push({ header: { id: 7 } })
    h.listed.push({ header: { id: 'cold-real', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    const read = await callRoute(h.routes, { ids: ['cold-real'] })
    assert.deepEqual(Object.keys(read.value ?? {}), ['cold-real'])
    const empty = await callRoute(h.routes, { ids: ['ghost'] })
    assert.deepEqual(empty.value, {})
  })

  test('a non-safe asOfSeq is dropped and an absent one stays absent', async () => {
    const h = await boot()
    h.listed.push({ header: { id: 'cold-a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    h.cacheMode.asOf = 1.5
    const fractional = await callRoute(h.routes, { ids: ['cold-a'] })
    assert.equal(fractional.value?.['cold-a']?.asOfSeq, undefined)
    h.cacheMode.asOf = undefined
    const absent = await callRoute(h.routes, { ids: ['cold-a'] })
    assert.equal(absent.value?.['cold-a']?.asOfSeq, undefined)
    assert.equal(absent.value?.['cold-a']?.head.model, 'cached')
  })

  test('an unlistable sessionQuery fails internally', async () => {
    const h = await boot({ queryThrows: true })
    const read = await callRoute(h.routes, { ids: ['x'] })
    assert.equal(read.ok, false)
    assert.equal(read.error?.code, 'gateway/internal')
    const nonError = await boot({ queryThrows: 'boom' })
    const failed = await callRoute(nonError.routes, { ids: ['x'] })
    assert.equal(failed.error?.message, 'boom')
  })

  test('a non-array listing serves an empty map', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(null) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    const read = await callRoute(routes, { ids: ['x'] })
    assert.deepEqual(read.value, {})
  })
})
