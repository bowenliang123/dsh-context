import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { watchSnapshotRoute, SNAPSHOT_ROUTE } from '../../src/host/snapshotRoute'
import type {} from '../../src/shared/types'

const plugin = { name, inject, apply } as never
const noConfig = {} as never

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

async function bootWithRoutes(): Promise<{
  ctx: Context
  routes: Map<string, RouteBox>
  listed: { header: unknown }[]
  cacheMode: { throws: boolean }
  createSession: () => Session
}> {
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
    listSessions: () => Promise.resolve(listed),
  })
  const cacheMode = { throws: false }
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: unknown, keys: unknown) => {
      if (cacheMode.throws) throw new Error('cache read failed')
      assert.ok((keys as Set<string>).has('contextActivity'))
      assert.ok((keys as Set<string>).has('contextTimeline'))
      return { asOfSeq: 5, values: { contextActivity: { days: {} } } }
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

function appendRealEnvelopes(session: Session): void {
  session.append('request/header', {
    header: {
      config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
    },
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

async function callRoute(routes: Map<string, RouteBox>, body: unknown): Promise<{ ok: boolean; value?: Record<string, Record<string, unknown>>; error?: { code: string; message?: string } }> {
  const route = routes.get(SNAPSHOT_ROUTE)
  assert.ok(route !== undefined && route.fetch !== undefined, 'the snapshot route registered')
  const response = await route.fetch(new Request(`http://dsh.test${SNAPSHOT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return await response.json() as never
}

describe('dsh-context snapshot route', () => {
test('without the connection face the route never registers, and the watcher disposes cleanly', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {} as never)
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve([]) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    const dispose = watchSnapshotRoute(ctx)
    await ctx.plugin(plugin, noConfig)
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(routes.has(SNAPSHOT_ROUTE), false, 'no registrar, no route')
    dispose()
  })
  test('serves a live session from the registry, honors the ids filter, and drops unknown ids', async () => {
    const { routes, createSession } = await bootWithRoutes()
    const session = createSession()
    appendRealEnvelopes(session)

    const all = await callRoute(routes, {})
    assert.equal(all.ok, true)
    const row = all.value?.[session.header.id]
    assert.ok(row !== undefined, 'the live session serves its summary-excluded values on demand')
    assert.ok(row.contextTimeline !== undefined, 'the timeline head rides the snapshot route')
    assert.ok(row.contextActivity !== undefined, 'the activity ledger rides the snapshot route')

    const filtered = await callRoute(routes, { ids: [session.header.id, 'missing-session'] })
    assert.deepEqual(Object.keys(filtered.value ?? {}), [session.header.id], 'the ids filter drops unknown sessions')
  })

  test('a non-live session serves from the cache face, and a failed row is skipped whole', async () => {
    const { routes, listed, cacheMode } = await bootWithRoutes()
    listed.push({ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })

    const ok = await callRoute(routes, {})
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.value?.['cold-session-id'], { contextActivity: { days: {} } }, 'the cold row serves its cached values only')

    cacheMode.throws = true
    const degraded = await callRoute(routes, {})
    assert.equal(degraded.ok, true, 'a failed cache row skips whole and the route still serves')
    assert.equal(degraded.value?.['cold-session-id'], undefined)
  })

  test('a listing failure fails with the internal code', async () => {
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
    ctx.provide('sessionQuery', { listSessions: () => Promise.reject(new Error('scan failed')) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    await new Promise(resolve => setTimeout(resolve, 1))
    const result = await callRoute(routes, {})
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'gateway/internal')
  })

  test('empty ids mean all sessions; a hostile listing result or row reads as absence; non-Error failures stringify', async () => {
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
    let listing: unknown = [{ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }]
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(listing) })
    let cacheResult: unknown = { asOfSeq: 5, values: { contextActivity: { days: {} } } }
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => cacheResult })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)

    const all = await callRoute(routes, { ids: [] })
    assert.deepEqual(Object.keys(all.value ?? {}), ['cold-session-id'], 'empty ids mean all sessions')
    const typed = await callRoute(routes, { ids: [7, '', 'cold-session-id'] })
    assert.deepEqual(Object.keys(typed.value ?? {}), ['cold-session-id'], 'non-string ids drop')

    cacheResult = undefined
    const absent = await callRoute(routes, {})
    assert.deepEqual(absent.value?.['cold-session-id'], undefined, 'an unreadable cache row reads as absence')

    cacheResult = 42
    const junk = await callRoute(routes, {})
    assert.deepEqual(junk.value?.['cold-session-id'], undefined, 'a junk cache block reads as absence')

    listing = [null, { header: null }, { nope: true }, ...listing as unknown as { header: unknown }[]]
    cacheResult = { asOfSeq: 5, values: { contextActivity: { days: {} } } }
    const hostileRows = await callRoute(routes, {})
    assert.equal(hostileRows.ok, true, 'null entries and headerless rows skip whole')
    assert.deepEqual(Object.keys(hostileRows.value ?? {}), ['cold-session-id'])

    listing = 'not-a-listing'
    const flat = await callRoute(routes, {})
    assert.deepEqual(flat.value, {}, 'a non-array listing reads as an empty block')

    listing = Promise.reject('plain-string failure')
    const failed = await callRoute(routes, {})
    assert.equal(failed.ok, false)
    assert.equal(failed.error?.code, 'gateway/internal')
    assert.ok((failed.error?.message ?? '').includes('plain-string failure'), 'non-Error failures stringify')

    listing = [{ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }]
    const nullBody = await callRoute(routes, null)
    assert.equal(nullBody.ok, true, 'a JSON-null body reads as an unfiltered listing')

    cacheResult = { asOfSeq: 1, values: {} }
    const emptyValues = await callRoute(routes, 42)
    assert.deepEqual(emptyValues.value, {}, 'a non-object body reads as an unfiltered listing; empty served values drop the row')
  })

  test('a malformed body fails with the bad-request code', async () => {
    const { routes } = await bootWithRoutes()
    const result = await callRoute(routes, 'not json')
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'dsh-context/bad-request')
  })
})
