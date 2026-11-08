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

interface DirectOptions {
  listed?: unknown
  listThrows?: boolean
  persistence?: unknown
  sessions?: unknown
  snapshot?: (session: unknown, keys: Set<string>) => unknown
  cached?: (header: unknown, keys: Set<string>) => unknown
  observeSession?: (id: string, options: unknown) => Promise<unknown>
  coldReads?: { admit<T>(read: () => Promise<T>): Promise<T | undefined> }
  cost?: unknown
}

async function bootDirect(options: DirectOptions = {}): Promise<{
  routes: Map<string, RouteBox>
  calls: { list: number; stat: string[]; cachedHeaders: unknown[] }
}> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  const calls = { list: 0, stat: [] as string[], cachedHeaders: [] as unknown[] }
  ctx.provide('connection', {
    fetch: {
      register: (r: never) => {
        const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
        routes.set(route.path, route)
        return () => {}
      },
    },
  })
  ctx.provide('sessionQuery', {
    listSessions: () => {
      calls.list++
      if (options.listThrows === true) return Promise.reject(new Error('list failed'))
      return Promise.resolve(options.listed ?? [])
    },
    ...(options.observeSession === undefined ? {} : { observeSession: options.observeSession }),
  })
  ctx.provide('sessions', options.sessions ?? { get: () => undefined })
  ctx.provide('sessionProjections', {
    snapshot: (session: unknown, keys: Set<string>) => (options.snapshot === undefined ? undefined : options.snapshot(session, keys)),
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: unknown, keys: Set<string>) => {
      calls.cachedHeaders.push(header)
      if (options.cached === undefined) {
        const id = (header as { id?: string } | undefined)?.id
        return { asOfSeq: 7, values: { contextTimeline: { ok: true, model: id } } }
      }
      return options.cached(header, keys)
    },
  })
  if (options.persistence !== undefined) ctx.provide('sessionPersistence', options.persistence as never)
  watchHeadsChannel(ctx, {
    ...(options.coldReads === undefined ? {} : { coldReads: options.coldReads }),
    ...(options.cost === undefined ? {} : { cost: options.cost as never }),
  })
  for (let index = 0; index < 300 && !routes.has(HEADS_ROUTE); index++) await new Promise(resolve => setTimeout(resolve, 1))
  return { routes, calls }
}

function statOf(calls: { stat: string[] }, headers: Record<string, unknown>, overrides: Record<string, (id: string) => Promise<unknown>> = {}): unknown {
  return {
    stat: async (id: string) => {
      calls.stat.push(id)
      const override = overrides[id]
      if (override !== undefined) return override(id)
      const header = headers[id]
      return header === undefined ? undefined : { header }
    },
  }
}

const STAT_HEADER = { version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false }

describe('dsh-context heads route per-id resolution', () => {
  test('explicit ids resolve through sessionPersistence.stat without listing the corpus', async () => {
    const harness = await bootDirect({
      persistence: statOf({ stat: [] }, {
        'cold-a': { id: 'cold-a', ...STAT_HEADER },
        'cold-b': { id: 'cold-b', ...STAT_HEADER },
      }),
    })
    const persistence = harness.routes.size
    assert.equal(persistence, 1)
    const read = await callRoute(harness.routes, { ids: ['cold-a', 'cold-b', 'missing'] })
    assert.equal(read.ok, true)
    assert.deepEqual(Object.keys(read.value ?? {}).sort(), ['cold-a', 'cold-b'])
    assert.equal(harness.calls.list, 0, 'an explicit id batch never lists the whole corpus')
    assert.equal(harness.calls.cachedHeaders.length, 2, 'the stored header feeds the cache read')
  })

  test('a live session skips the per-id stat and a stat failure or junk answer drops only that id', async () => {
    const calls = { stat: [] as string[] }
    const harness = await bootDirect({
      persistence: statOf(calls, { 'cold-ok': { id: 'cold-ok', ...STAT_HEADER } }, {
        'cold-throw': () => Promise.reject(new Error('corrupt log')),
        'cold-junk': () => Promise.resolve('junk'),
        'cold-no-header': () => Promise.resolve({ header: null }),
      }),
      sessions: { get: (id: string) => (id === 'live' ? { id, seq: 3 } : undefined) },
      snapshot: () => ({ values: { contextTimeline: { ok: true, model: 'live' } } }),
    })
    const read = await callRoute(harness.routes, { ids: ['live', 'cold-ok', 'cold-throw', 'cold-junk', 'cold-no-header'] })
    assert.equal(read.ok, true)
    assert.deepEqual(Object.keys(read.value ?? {}).sort(), ['cold-ok', 'live'])
    assert.deepEqual(calls.stat, ['cold-ok', 'cold-throw', 'cold-junk', 'cold-no-header'], 'the live id never reaches stat')
    assert.equal(read.value?.live.head.model, 'live')
  })

  test('a throwing snapshot or cache read inside the per-id path skips only that id', async () => {
    const base = { version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false }
    const throwingSnapshot = await bootDirect({
      persistence: statOf({ stat: [] }, { 'cold-a': { id: 'cold-a', ...base } }),
      sessions: { get: (id: string) => (id === 'live' ? { id } : undefined) },
      snapshot: () => { throw new Error('snapshot broke') },
    })
    const liveFailed = await callRoute(throwingSnapshot.routes, { ids: ['live', 'cold-a'] })
    assert.deepEqual(Object.keys(liveFailed.value ?? {}), ['cold-a'])
    const throwingCached = await bootDirect({
      persistence: statOf({ stat: [] }, { 'cold-a': { id: 'cold-a', ...base } }),
      cached: () => { throw new Error('cache broke') },
    })
    const coldFailed = await callRoute(throwingCached.routes, { ids: ['cold-a'] })
    assert.equal(coldFailed.ok, true)
    assert.deepEqual(coldFailed.value, {})
  })

  test('a throwing live lookup skips that id, and a persistence face without stat falls back to the corpus list', async () => {
    const throwingGet = await bootDirect({
      persistence: statOf({ stat: [] }, {}),
      sessions: { get: () => { throw new Error('registry broke') } },
    })
    const skipped = await callRoute(throwingGet.routes, { ids: ['a'] })
    assert.deepEqual(skipped.value, {})

    const fallback = await bootDirect({ persistence: { notStat: true }, listed: [{ header: { id: 'cold-x', ...STAT_HEADER } }] })
    const read = await callRoute(fallback.routes, { ids: ['cold-x'] })
    assert.deepEqual(Object.keys(read.value ?? {}), ['cold-x'])
    assert.equal(fallback.calls.list, 1, 'without a stat face the corpus list is the fallback')
  })

  test('a non-safe watermark from the per-id cache read is dropped', async () => {
    const harness = await bootDirect({
      persistence: statOf({ stat: [] }, { 'cold-a': { id: 'cold-a', ...STAT_HEADER } }),
      cached: () => ({ asOfSeq: 1.5, values: { contextTimeline: { ok: true } } }),
    })
    const read = await callRoute(harness.routes, { ids: ['cold-a'] })
    assert.equal(read.value?.['cold-a']?.asOfSeq, undefined)
    assert.equal(read.value?.['cold-a']?.head.ok, true)
  })
})

describe('dsh-context heads route cold fallback', () => {
  const HEAD_EVENTS = [
    { type: 'request/header', seq: 0, time: 1, data: { header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } }, reason: 'initial' } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' } } },
  ]

  function observationOf(events: unknown): unknown {
    return { events, [Symbol.dispose]() {} }
  }

  const COST = { read: () => ({ usd: 0.5, ready: true }), usd: () => 0.5, ready: () => true }

  test('a session with neither a live snapshot nor a cache row folds the durable head', async () => {
    const harness = await bootDirect({
      listed: [],
      cached: () => undefined,
      observeSession: () => Promise.resolve(observationOf(HEAD_EVENTS)),
      cost: COST,
    })
    const read = await callRoute(harness.routes, { ids: ['cold-fold'] })
    const picked = read.value?.['cold-fold']
    assert.ok(picked !== undefined)
    assert.equal(picked.head.ok, true)
    assert.equal(picked.asOfSeq, 1)
    assert.deepEqual(picked.head.costRead, { usd: 0.5, ready: true })
  })

  test('an unreadable observation, a non-array event log and a rejecting observe drop only that id', async () => {
    const harness = await bootDirect({
      listed: [],
      cached: () => undefined,
      observeSession: (id) => Promise.resolve(id === 'bad-shape' ? observationOf('junk') : observationOf(HEAD_EVENTS)),
    })
    assert.deepEqual((await callRoute(harness.routes, { ids: ['bad-shape'] })).value, {})
    const rejecting = await bootDirect({
      listed: [],
      cached: () => undefined,
      observeSession: () => Promise.reject(new Error('down')),
    })
    assert.deepEqual((await callRoute(rejecting.routes, { ids: ['x'] })).value, {})
    const throwingGate = await bootDirect({
      listed: [],
      cached: () => undefined,
      observeSession: () => Promise.resolve(observationOf(HEAD_EVENTS)),
      coldReads: { admit: () => { throw new Error('gate down') } },
    })
    assert.deepEqual((await callRoute(throwingGate.routes, { ids: ['x'] })).value, {})
  })

  test('an absent observe face never cold-reads', async () => {
    const harness = await bootDirect({ listed: [], cached: () => undefined })
    assert.deepEqual((await callRoute(harness.routes, { ids: ['cold-none'] })).value, {})
  })

  test('a stale live snapshot falls through the stat cache to the durable head', async () => {
    const harness = await bootDirect({
      persistence: statOf({ stat: [] }, { 'cold-a': { id: 'cold-a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }),
      sessions: { get: () => ({ id: 'cold-a' }) },
      snapshot: () => ({ values: {} }),
      cached: () => undefined,
      observeSession: () => Promise.resolve(observationOf(HEAD_EVENTS)),
    })
    const read = await callRoute(harness.routes, { ids: ['cold-a'] })
    assert.equal(read.value?.['cold-a']?.head.ok, true)
  })

  test('a throwing live snapshot falls back instead of dropping the id', async () => {
    const harness = await bootDirect({
      sessions: { get: () => ({ id: 'cold-b' }) },
      snapshot: () => { throw new Error('projection gone') },
      listed: [{ header: { id: 'cold-b', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }],
      cached: () => undefined,
      observeSession: () => Promise.resolve(observationOf([])),
    })
    const read = await callRoute(harness.routes, { ids: ['cold-b'] })
    assert.equal(read.value?.['cold-b']?.head.ok, true)
    assert.equal(read.value?.['cold-b']?.asOfSeq, undefined, 'an empty log carries no watermark')
  })
})
