import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { HEADS_ROUTE, watchHeadsChannel } from '../../src/host/headsRoute'
import { apply, inject, name } from '../../src/host/index'
import { watchSnapshotRoute, SNAPSHOT_IDS_MAX, SNAPSHOT_ROUTE } from '../../src/host/snapshotRoute'
import { type CatalogEntry, type CatalogService } from '../../src/host/catalog'
import { VERSION_ROUTE, watchVersionChannel } from '../../src/host/versionRoute'

describe('headsRoute', () => {

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
})

describe('snapshotRoute', () => {

const plugin = { name, inject, apply } as never
const noConfig = {} as never

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

async function bootWithRoutes(): Promise<{
  ctx: Context
  routes: Map<string, RouteBox>
  listed: { header: unknown }[]
  cacheMode: { throws: boolean; empty: boolean; requested: string[]; values?: Record<string, unknown> }
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
  const cacheMode: { throws: boolean; empty: boolean; requested: string[]; values?: Record<string, unknown> } = { throws: false, empty: false, requested: [] }
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: unknown, keys: unknown) => {
      if (cacheMode.throws) throw new Error('cache read failed')
      assert.ok((keys as Set<string>).has('contextActivity'))
      assert.ok((keys as Set<string>).has('contextTimeline'))
      if (cacheMode.empty) return { values: {} }
      if (cacheMode.values !== undefined) return { asOfSeq: 5, values: cacheMode.values }
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

async function callRoute(routes: Map<string, RouteBox>, body: unknown): Promise<{ ok: boolean; value?: Record<string, Record<string, unknown>>; error?: { code: string; message?: string }; revision?: string; unchanged?: boolean }> {
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
    watchSnapshotRoute(ctx)
    await ctx.plugin(plugin, noConfig)
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(routes.has(SNAPSHOT_ROUTE), false, 'no registrar, no route')
  })
  test('serves a live session from the registry, honors the ids filter, and drops unknown ids', async () => {
    const { routes, createSession } = await bootWithRoutes()
    const session = createSession()
    appendRealEnvelopes(session)

    const all = await callRoute(routes, {})
    assert.equal(all.ok, true)
    const row = all.value?.[session.header.id]
    assert.ok(row !== undefined, 'the live session serves its summary-excluded values on demand')
    const compact = row.contextTimeline as Record<string, unknown>
    assert.ok(compact !== undefined, 'the timeline digest rides the snapshot route')
    assert.ok(compact.current !== undefined, 'the digest carries the composition')
    assert.deepEqual(Object.keys(compact.counts as Record<string, unknown>).sort(), ['steps', 'turns'])
    assert.equal('last' in compact, false, 'the digest drops the pressure cursor')
    assert.equal('nodes' in compact, false, 'the digest never carries the surface')
    assert.equal('requests' in compact, false, 'the digest never carries the request window')
    assert.equal('events' in compact, false, 'the digest never carries the event window')
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

  test('compacts the served timeline to the overview fields and drops hostile members', async () => {
    const h = await bootWithRoutes()
    h.listed.push({ header: { id: 'digest-1', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    h.cacheMode.values = {
      contextTimeline: {
        ok: 'yes',
        current: { system: 1, total: 2 },
        contextWindow: 128000,
        counts: { turns: 3, steps: 'bad', injects: 9 },
        cost: { p: { m: { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } },
        timing: { wallMs: 10, ttftMs: 'bad', tools: { bash: { calls: 1, ms: 2 } }, calls: 4 },
        lastUser: 'hi',
        systems: [{ seq: 1, time: 1, tokens: 1 }],
        generatedReasoning: 3,
        generatedAnswerTokens: 4,
        generatedCallTokens: 5,
        costRead: { usd: 1.5, ready: true },
      },
      contextActivity: { days: { '2026-11-01': { tokens: 5, requests: 1 } } },
    }
    const read = await callRoute(h.routes, { ids: ['digest-1'] })
    const row = read.value?.['digest-1'] as Record<string, unknown>
    const digest = row.contextTimeline as Record<string, unknown>
    assert.equal(digest.ok, 'yes')
    assert.deepEqual(digest.current, { system: 1, total: 2 })
    assert.equal(digest.contextWindow, 128000)
    assert.deepEqual(digest.counts, { turns: 3 })
    assert.equal('injects' in (digest.counts as object), false)
    assert.equal('systems' in digest, false)
    assert.deepEqual(digest.timing, { tools: {}, wallMs: 10, calls: 4 })
    assert.equal(digest.lastUser, 'hi')
    assert.equal(digest.generatedReasoning, 3)
    assert.equal(digest.generatedAnswerTokens, 4)
    assert.equal(digest.generatedCallTokens, 5)
    assert.deepEqual(digest.costRead, { usd: 1.5, ready: true })
    assert.deepEqual(row.contextActivity, { days: { '2026-11-01': { tokens: 5, requests: 1 } } })
    const bare = { ...h.cacheMode }
    bare.values = { contextTimeline: {} }
    h.cacheMode.values = bare.values
    const empty = await callRoute(h.routes, { ids: ['digest-1'] })
    const emptyRow = empty.value?.['digest-1'] as Record<string, unknown>
    assert.deepEqual(emptyRow.contextTimeline, { ok: true })
    h.cacheMode.values = { contextTimeline: { timing: { bogus: 1 } } }
    const noTiming = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.deepEqual((noTiming.value?.['digest-1'] as Record<string, unknown>).contextTimeline, { ok: true }, 'a timing without figures is omitted')
    h.cacheMode.values = { contextTimeline: { counts: { injects: 4 } } }
    const noCounts = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.deepEqual((noCounts.value?.['digest-1'] as Record<string, unknown>).contextTimeline, { ok: true })
    h.cacheMode.values = { contextTimeline: 'nope' }
    const dropped = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.equal(dropped.value?.['digest-1'], undefined, 'a non-object timeline yields no row')
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

  test('a matching revision skips the rows and replies tiny; another ids set still gets its rows', async () => {
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
    const listed = [
      { header: { id: 'a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } },
      { header: { id: 'b', version: 4, createdAt: 2, cwd: '/tmp', isSeeded: false } },
    ]
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(listed) })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionProjections', { snapshot: () => undefined })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: { id: string }) => ({ asOfSeq: 5, values: { contextTimeline: { ok: true, model: header.id } } }),
    })
    let version = 0
    const backfill = Object.assign(() => {}, {
      coverage: () => ({ complete: true, remaining: 0, failed: 0, running: false, total: 0, covered: 0, unsupported: 0 }),
      version: () => version,
      foldedSince: (marker: number) => ({ version: marker, ids: [], workerIds: [] }),
    })
    watchSnapshotRoute(ctx, backfill)
    await new Promise(resolve => setTimeout(resolve, 2))
    const first = await callRoute(routes, {}) as { ok: boolean; value: Record<string, unknown>; revision?: string }
    assert.ok(typeof first.revision === 'string', 'a full reply carries its revision')
    const revision = first.revision as string
    const unchanged = await callRoute(routes, { revision }) as { ok: boolean; value: unknown; revision?: string; unchanged?: boolean }
    assert.deepEqual(unchanged, { ok: true, value: {}, revision, unchanged: true })
    const subset = await callRoute(routes, { revision, ids: ['a'] }) as { value: Record<string, unknown>; revision?: string }
    assert.deepEqual(Object.keys(subset.value), ['a'], 'a never-served ids set gets its rows even at the current revision')
    const repeated = await callRoute(routes, { revision, ids: ['a'] }) as { value: unknown; unchanged?: boolean }
    assert.deepEqual(repeated, { ok: true, value: {}, revision, unchanged: true })
    version = 1
    const moved = await callRoute(routes, { revision, ids: ['a'] }) as { value: Record<string, unknown>; revision?: string; unchanged?: boolean }
    assert.equal(moved.unchanged, undefined, 'a backfill write invalidates the revision')
    assert.notEqual(moved.revision, revision)
    assert.deepEqual(Object.keys(moved.value), ['a'])
  })

  test('without a backfill handle the route still carries a revision and skips on a match', async () => {
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
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve([]) })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionProjections', { snapshot: () => undefined })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    watchSnapshotRoute(ctx)
    await new Promise(resolve => setTimeout(resolve, 2))
    const first = await callRoute(routes, {}) as { revision?: string }
    assert.ok(typeof first.revision === 'string')
    const second = await callRoute(routes, { revision: first.revision }) as { unchanged?: boolean }
    assert.equal(second.unchanged, true)
  })

  test('a malformed body fails with the bad-request code', async () => {
    const { routes } = await bootWithRoutes()
    const result = await callRoute(routes, 'not json')
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'dsh-context/bad-request')
  })
})



describe('snapshot ids cap', () => {
  test('an oversized ids list is refused rather than silently truncated', async () => {
    const h = await bootWithRoutes()
    const sessions: Session[] = []
    for (let i = 0; i < SNAPSHOT_IDS_MAX; i++) {
      const session = h.createSession()
      appendRealEnvelopes(session)
      sessions.push(session)
    }
    const exact = await callRoute(h.routes, { ids: sessions.map(session => session.header.id) })
    assert.equal(exact.ok, true, 'exactly the cap still serves')
    const over = await callRoute(h.routes, { ids: [...sessions.map(session => session.header.id), 'one-too-many'] })
    assert.equal(over.ok, false)
    assert.equal(over.error?.code, 'dsh-context/bad-request')
  })
})
})

describe('versionRoute', () => {

type RouteFetch = (request: Request) => Promise<Response>

interface Captured {
  path?: string
  methods?: readonly string[]
  requestBody?: string
  fetch?: RouteFetch
}

interface Mounted {
  ctx: Context
  route: Captured
  labels: string[]
}

function mountableCtx(options: { connection?: unknown; noConnection?: boolean; throwOnRegister?: boolean } = {}): Mounted {
  const route: Captured = {}
  const labels: string[] = []
  const connection = options.connection !== undefined
    ? options.connection
    : options.noConnection === true
      ? undefined
      : {
        fetch: {
          register: (next: Captured) => {
            if (options.throwOnRegister === true) throw new Error('no seam')
            Object.assign(route, next)
            return () => {}
          },
        },
      }
  const inner = {
    get: (name: string) => (name === 'connection' ? connection : undefined),
    effect: (fn: () => unknown, label?: string) => {
      if (label !== undefined) labels.push(label)
      const dispose = fn()
      return typeof dispose === 'function' ? dispose : () => {}
    },
  }
  const ctx = { inject: (_deps: string[], cb: (c: unknown) => unknown) => { cb(inner) } }
  return { ctx: ctx as unknown as Context, route, labels }
}

function serviceOf(entry: Partial<CatalogEntry<string>> = {}, current: string | null = '0.82.2'): CatalogService {
  const read: CatalogEntry<string> = { value: null, ready: false, failed: false, checkedAt: 0, ...entry }
  return {
    ensure: () => {},
    book: () => null,
    pricesVersion: () => 0,
    version: async () => read,
    prices: async () => ({ value: null, ready: false, failed: false, checkedAt: 0 }),
    currentVersion: () => current ?? undefined,
    dispose: () => {},
  }
}

describe('version route', () => {
  test('mounts the POST route with its label and answers ready/latest', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.84.0', ready: true, failed: false, checkedAt: 7 }))
    assert.equal(mounted.route.path, VERSION_ROUTE)
    assert.deepEqual(mounted.route.methods, ['POST'])
    assert.equal(mounted.route.requestBody, 'buffered')
    assert.deepEqual(mounted.labels, ['dsh-context: version route'], 'the route carries its effect label')
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await response.json(), {
      ok: true,
      value: { ready: true, failed: false, checkedAt: 7, current: '0.82.2', updateAvailable: true, latest: '0.84.0' },
    })
  })

  test('the host-side compare marks a same-version registry read as no update', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.82.2', ready: true, failed: false, checkedAt: 7 }))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.equal(body.value.updateAvailable, false)
  })

  test('answers without a latest version when the registry check is not ready', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: null, ready: false, failed: true, checkedAt: 5 }))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.deepEqual(body.value, { ready: false, failed: true, checkedAt: 5, current: '0.82.2', updateAvailable: null })
    assert.ok(!('latest' in body.value))
  })

  test('answers a null current version when the host cannot name itself', async () => {
    const mounted = mountableCtx()
    watchVersionChannel(mounted.ctx, serviceOf({ value: '0.91.0', ready: true, failed: false, checkedAt: 3 }, null))
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const body = await response.json() as { value: Record<string, unknown> }
    assert.equal(body.value.current, null)
    assert.equal(body.value.latest, '0.91.0')
    assert.equal(body.value.updateAvailable, null, 'no current version means no host-side compare')
  })

  test('isolates a throwing service behind the internal error reply', async () => {
    const mounted = mountableCtx()
    const thrown = {
      ...serviceOf(),
      version: () => Promise.reject(new Error('boom')),
    }
    watchVersionChannel(mounted.ctx, thrown)
    const response = await mounted.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    assert.deepEqual(await response.json(), {
      ok: false,
      error: { code: 'gateway/internal', message: 'boom' },
    })
    const plain = mountableCtx()
    watchVersionChannel(plain.ctx, { ...serviceOf(), version: () => Promise.reject('plain failure') })
    const plainResponse = await plain.route.fetch!(new Request('http://dsh.test' + VERSION_ROUTE, { method: 'POST' }))
    const plainBody = await plainResponse.json() as { error: Record<string, unknown> }
    assert.equal(plainBody.error.message, 'plain failure')
  })

  test('stays inert without a connection or a working register seam', () => {
    const inert = [
      mountableCtx({ noConnection: true }),
      mountableCtx({ connection: {} }),
      mountableCtx({ connection: { fetch: {} } }),
      mountableCtx({ throwOnRegister: true }),
    ]
    for (const mounted of inert) {
      assert.doesNotThrow(() => watchVersionChannel(mounted.ctx, serviceOf()))
      assert.equal(mounted.route.path, undefined)
      assert.equal(mounted.route.fetch, undefined)
    }
    for (const mounted of inert.slice(0, 3)) assert.deepEqual(mounted.labels, [], 'no effect mounts without a seam')
  })
})
})
