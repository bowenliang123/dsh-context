import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DETAIL_ROUTE, watchDetailChannel } from '../../src/host/detail'
import { resolveBounds } from '../../src/host/config'
import type { TimelineState } from '../../src/host/fold'
import { buildTimelineDetail, buildTimelineHead } from '../../src/host/foldWire'
import type { TimelineEvent } from '../../src/host/foldState'
import { assistantMessage, header, userMessage } from './helpers/events'
import { driveTimeline, timelineDef } from './helpers/projection'

const BOUNDS = resolveBounds({})

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessions?: unknown
  sessionQuery?: unknown
  sessionPersistence?: unknown
  stateOf?: (session: unknown, key: string) => unknown
  snapshot?: (session: unknown, keys: unknown) => unknown
}

function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessions' in spec) services.set('sessions', spec.sessions)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  if ('sessionPersistence' in spec) services.set('sessionPersistence', spec.sessionPersistence)
  const ctx = {
    get: (name: string) => services.get(name),
    sessionProjections: {
      stateOf: spec.stateOf ?? (() => undefined),
      snapshot: spec.snapshot ?? (() => ({ values: {} })),
    },
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { fetch?: { register?: unknown } }
    if (typeof conn.fetch?.register === 'function') {
      conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
        captured.path = route.path
        captured.fetch = route.fetch
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

async function call(captured: { fetch?: RouteFetch }, body: unknown): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

async function callRaw(captured: { fetch?: RouteFetch }, body: string): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${DETAIL_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  })
  return await captured.fetch!(request).then(r => r.json()) as Record<string, unknown>
}

function sessionsWith(session: unknown): { get(id: string): unknown } {
  return { get: (id: string) => (id === 's1' ? session : undefined) }
}

function okSession(): object {
  return { id: 's1' }
}

function headStateOf(events: TimelineEvent[]): TimelineState {
  const def = timelineDef({}, true)
  let state = def.init()
  for (const ev of events) state = def.apply(state, ev)
  return state
}

function sampleLog(): TimelineEvent[] {
  return [
    header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
    assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
  ]
}

function liveCtx(events: TimelineEvent[], head?: TimelineState | null): { ctx: Context; captured: { fetch?: RouteFetch } } {
  const headerOf = { id: 's1' }
  return ctxOf({
    connection: { fetch: { register: () => () => {} } },
    sessions: sessionsWith(okSession()),
    snapshot: head === null
      ? () => ({ values: {} })
      : () => ({ values: { contextTimeline: buildTimelineHead(head ?? headStateOf(events)) } }),
    sessionQuery: {
      observeSession: (id: string) => Promise.resolve(id === 's1'
        ? {
          source: 'live',
          header: headerOf,
          events,
          cursor: events.length - 1,
          [Symbol.dispose]: () => {},
        }
        : null),
    },
    sessionPersistence: { backend: 'live' },
  })
}

describe('watchDetailChannel registration', () => {
  test('the channel stays unregistered without either face or a working registrar', () => {
    const none = ctxOf({})
    watchDetailChannel(none.ctx, BOUNDS)
    assert.equal(none.captured.fetch, undefined)
    const sessionsOnly = ctxOf({ sessions: sessionsWith(okSession()) })
    watchDetailChannel(sessionsOnly.ctx, BOUNDS)
    assert.equal(sessionsOnly.captured.fetch, undefined)
    const connOnly = ctxOf({ connection: { fetch: { register: () => () => {} } } })
    watchDetailChannel(connOnly.ctx, BOUNDS)
    assert.equal(connOnly.captured.fetch, undefined)
    const noFetch = ctxOf({ connection: { fetch: {} }, sessions: sessionsWith(okSession()) })
    watchDetailChannel(noFetch.ctx, BOUNDS)
    assert.equal(noFetch.captured.fetch, undefined)
    const noGet = ctxOf({ connection: { fetch: { register: () => () => {} } }, sessions: { get: 42 } })
    watchDetailChannel(noGet.ctx, BOUNDS)
    assert.equal(noGet.captured.fetch, undefined)
  })

  test('the route registers with both faces and survives a rejecting registrar and unload', () => {
    const { ctx, captured, disposers } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
    })
    watchDetailChannel(ctx, BOUNDS)
    assert.equal(captured.path, '/api/dsh-context/detail')
    assert.equal(typeof captured.fetch, 'function')
    for (const d of disposers) d()
    const rejecting = {
      get: (name: string) =>
        name === 'connection'
          ? { fetch: { register: () => { throw new Error('registration rejected') } } }
          : name === 'sessions'
            ? sessionsWith(okSession())
            : undefined,
      sessionProjections: { stateOf: () => undefined },
      effect(fn: () => unknown) {
        fn()
        return () => {}
      },
      inject(deps: string[], cb: (c: unknown) => unknown) {
        if (deps.every(d => (d === 'connection' || d === 'sessions'))) cb(rejecting)
      },
    }
    assert.doesNotThrow(() => watchDetailChannel(rejecting as unknown as Context, BOUNDS))
  })
})

describe('the detail route', () => {
  test('bad payloads fail with typed envelopes', async () => {
    const { ctx, captured } = liveCtx(sampleLog())
    watchDetailChannel(ctx, BOUNDS)
    for (const body of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await call(captured, body) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(body)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
    const raw = await callRaw(captured, 'not json') as { ok: boolean; error?: { code: string } }
    assert.equal(raw.ok, false)
    assert.equal(raw.error?.code, 'dsh-context/bad-request')
  })

  test('a session outside the live set and an absent observation resolve to the typed null', async () => {
    const { ctx, captured } = liveCtx(sampleLog(), null)
    watchDetailChannel(ctx, BOUNDS)
    assert.deepEqual(await call(captured, { sessionId: 'gone' }), { ok: true, value: null })
    const absent = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: () => Promise.resolve(null) },
    })
    watchDetailChannel(absent.ctx, BOUNDS)
    assert.deepEqual(await call(absent.captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a cold session (never entered into the live store) folds its detail off the observed log', async () => {
    const events = sampleLog()
    let disposed = 0
    let observedOptions: unknown
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: (id: string, opts: unknown) => {
          observedOptions = opts
          return Promise.resolve(id === 'cold1'
            ? { events, [Symbol.dispose]: () => { disposed++ } }
            : null)
        },
      },
    })
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 'cold1' }) as {
      ok: boolean
      value: { rev: number; requests: unknown[]; nodes: unknown[]; head: { current: { total: number } } } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null)
    assert.equal(result.value.requests.length, 1, 'the observed log folded')
    assert.equal(result.value.nodes.length, 2)
    assert.ok(result.value.head.current.total > 0, 'the slim head rides the cold fold')
    assert.deepEqual(observedOptions, { projectionMode: 'none' }, 'the observation skips projection work')
    assert.equal(disposed, 1, 'the observation lease disposed after the fold')
    assert.deepEqual(await call(captured, { sessionId: 'nobody' }), { ok: true, value: null })

    const bare = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: () => Promise.resolve({ events: [events[1]] }) },
    })
    watchDetailChannel(bare.ctx, BOUNDS)
    const bareResult = await call(bare.captured, { sessionId: 'cold1' }) as { ok: boolean; value: { nodes: unknown[] } | null }
    assert.equal(bareResult.ok, true)
    assert.equal(bareResult.value?.nodes.length, 1, 'an observation without a dispose face still serves')
  })

  test('a sessionQuery without the observe face (or a rejecting read) degrades cleanly', async () => {
    const noFace = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {},
    })
    watchDetailChannel(noFace.ctx, BOUNDS)
    assert.deepEqual(await call(noFace.captured, { sessionId: 'cold' }), { ok: true, value: null })
    const rejecting = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: {
        observeSession: () => Promise.reject(new Error('persistence down')),
      },
    })
    watchDetailChannel(rejecting.ctx, BOUNDS)
    const result = await call(rejecting.captured, { sessionId: 'cold' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'gateway/internal')
    assert.equal(result.error.message, 'persistence down')
  })

  test('the cold-read gate applies to cold reads only: a skipped read answers null, a live read never touches it', async () => {
    let observed = 0
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: {
        observeSession: () => {
          observed++
          return Promise.resolve({ events: [] })
        },
      },
    })
    let admitted = 0
    watchDetailChannel(ctx, BOUNDS, {
      admit: <T>(_read: () => Promise<T>): Promise<T | undefined> => {
        admitted++
        return Promise.resolve(undefined)
      },
    })
    assert.deepEqual(await call(captured, { sessionId: 'cold1' }), { ok: true, value: null })
    assert.equal(admitted, 1, 'the cold read went through the gate')
    assert.equal(observed, 0, 'a skipped read never touches the log')

    const live = liveCtx(sampleLog())
    watchDetailChannel(live.ctx, BOUNDS, {
      admit: () => Promise.reject(new Error('the gate must not see a live read')),
    })
    const result = await call(live.captured, { sessionId: 's1' }) as { ok: boolean; value: { rev: number } | null }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null, 'the live read served its detail without the gate')
  })

  test('serves the folded live detail with its revision', async () => {
    const { ctx, captured } = liveCtx(sampleLog())
    watchDetailChannel(ctx, BOUNDS)
    const result = await call(captured, { sessionId: 's1' }) as { ok: true; value: { rev: number; requests: unknown[]; nodes: unknown[]; head: { current: { total: number } } } }
    assert.equal(result.ok, true)
    assert.equal(result.value.rev, 2, 'two detail-mutating folds')
    assert.equal(result.value.requests.length, 1)
    assert.equal(result.value.nodes.length, 2)
    assert.ok(result.value.head.current.total > 0, 'the slim head rides the live read too')
  })

  test('a live read folds only the appended tail and invalidates the cached payload', async () => {
    const events = sampleLog()
    const headerOf = { id: 's1' }
    let observed: TimelineEvent[] = events
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: () => Promise.resolve({ source: 'live', header: headerOf, events: observed, cursor: observed.length - 1, [Symbol.dispose]: () => {} }) },
    })
    watchDetailChannel(ctx, BOUNDS)
    const first = await call(captured, { sessionId: 's1' }) as { value: { requests: unknown[]; rev: number } }
    assert.equal(first.value.requests.length, 1)
    observed = [...events, userMessage(4, [{ type: 'text', text: 'more' }], { kind: 'user' })]
    const second = await call(captured, { sessionId: 's1' }) as { value: { requests: unknown[]; rev: number; nodes: unknown[] } }
    assert.equal(second.value.requests.length, 1)
    assert.equal(second.value.nodes.length, 3, 'the appended message folded onto the cached state')
    const third = await call(captured, { sessionId: 's1' }) as { value: unknown }
    assert.deepEqual(third.value, second.value, 'an unchanged log re-serves the cached payload')
  })

  test('an unchanged live log re-serves the detail without materializing its events', async () => {
    const events = sampleLog()
    const headerOf = { id: 's1' }
    let reads = 0
    const observation = {
      source: 'live',
      header: headerOf,
      cursor: events.length - 1,
      get events() {
        reads++
        return events
      },
      [Symbol.dispose]: () => {},
    }
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: { observeSession: () => Promise.resolve(observation) },
    })
    watchDetailChannel(ctx, BOUNDS)
    const first = await call(captured, { sessionId: 's1' })
    const second = await call(captured, { sessionId: 's1' })
    assert.deepEqual(second, first)
    assert.equal(reads, 1, 'the unchanged log is never materialized a second time')
  })

  test('a live cache hit serves head-only and an unchanged re-read without refolding', async () => {
    const events = sampleLog()
    const headerOf = { id: 's1' }
    let reads = 0
    let withCursor = true
    const observation = () => ({
      source: 'live',
      header: headerOf,
      ...(withCursor ? { cursor: events.length - 1 } : {}),
      get events() {
        reads++
        return events
      },
      [Symbol.dispose]: () => {},
    })
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      sessionQuery: { observeSession: () => Promise.resolve(observation()) },
    })
    watchDetailChannel(ctx, BOUNDS)
    const full = await call(captured, { sessionId: 's1' })
    const head = await call(captured, { sessionId: 's1', head: true }) as { value: { rev: number; head: { current: { total: number } } } }
    assert.equal(head.value.rev, 2)
    assert.ok(head.value.head.current.total > 0)
    assert.equal(reads, 1, 'the head hit served from the cached state')
    withCursor = false
    const again = await call(captured, { sessionId: 's1' })
    assert.deepEqual(again, full, 'the unchanged live log re-serves the cached payload')
    assert.equal(reads, 2, 'only the cursor-less observation materialized the log again')
  })

  test('a head read serves the envelope only, live and cold', async () => {
    const live = liveCtx(sampleLog())
    watchDetailChannel(live.ctx, BOUNDS)
    const liveHead = await call(live.captured, { sessionId: 's1', head: true }) as { ok: true; value: { rev: number; head: { current: { total: number } }; requests?: unknown } }
    assert.equal(liveHead.ok, true)
    assert.equal(liveHead.value.rev, 2)
    assert.ok(liveHead.value.head.current.total > 0)
    assert.equal(liveHead.value.requests, undefined, 'the collections never ride a head read')

    const fresh = liveCtx([header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })])
    watchDetailChannel(fresh.ctx, BOUNDS)
    const freshHead = await call(fresh.captured, { sessionId: 's1', head: true }) as { ok: true; value: { rev: number; head: { model?: unknown } } }
    assert.equal(freshHead.value.rev, 0)
    assert.equal(freshHead.value.head.model, 'deepseek-v4-flash')

    const cold = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: () => Promise.resolve({
        source: 'prepared',
        revision: 'rev-1',
        events: sampleLog(),
        [Symbol.dispose]: () => {},
      }) },
      sessionPersistence: { backend: 'default' },
    })
    watchDetailChannel(cold.ctx, BOUNDS)
    const coldHead = await call(cold.captured, { sessionId: 'cold1', head: true }) as { ok: true; value: { rev: number; head: { model?: unknown }; requests?: unknown } }
    assert.equal(coldHead.ok, true)
    assert.ok(coldHead.value.head !== undefined)
    assert.equal(coldHead.value.requests, undefined, 'the cold head read serves the envelope only')
    const full = await call(cold.captured, { sessionId: 'cold1' }) as { ok: true; value: { requests: unknown[] } }
    assert.equal(full.ok, true)
    assert.ok(Array.isArray(full.value.requests))
    const cachedHead = await call(cold.captured, { sessionId: 'cold1', head: true }) as { ok: true; value: { rev: number; head?: unknown } }
    assert.equal(cachedHead.ok, true)
    assert.ok(cachedHead.value.head !== undefined)

    const unkeyed = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      snapshot: () => ({ values: { contextTimeline: { current: { total: 1 } } } }),
    })
    watchDetailChannel(unkeyed.ctx, BOUNDS)
    const unkeyedHead = await call(unkeyed.captured, { sessionId: 's1', head: true }) as { ok: true; value: { rev: number; head: { current: { total: number } } } }
    assert.equal(unkeyedHead.ok, true)
    assert.equal(unkeyedHead.value.rev, 0, 'a head without its revision defaults to zero')
    assert.equal(unkeyedHead.value.head.current.total, 1)

    const unkeyedCold = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: () => Promise.resolve({
        events: [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })],
        [Symbol.dispose]: () => {},
      }) },
      sessionPersistence: { backend: 'default' },
    })
    watchDetailChannel(unkeyedCold.ctx, BOUNDS)
    const unkeyedColdHead = await call(unkeyedCold.captured, { sessionId: 'cold2', head: true }) as { ok: true; value: { rev: number; head: { model?: unknown } } }
    assert.equal(unkeyedColdHead.ok, true)
    assert.equal(unkeyedColdHead.value.head.model, 'deepseek-v4-flash')
  })

  test('hostile reads degrade to the failure envelope, never a throw', async () => {
    const throwingGet = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw new Error('hostile sessions')
        },
      },
    })
    watchDetailChannel(throwingGet.ctx, BOUNDS)
    const r1 = await call(throwingGet.captured, { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(r1.ok, false)
    assert.equal(r1.error.code, 'gateway/internal')
    assert.equal(r1.error.message, 'hostile sessions')

    const throwingState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      snapshot: () => {
        throw new Error('hostile registry')
      },
    })
    watchDetailChannel(throwingState.ctx, BOUNDS)
    const r2 = await call(throwingState.captured, { sessionId: 's1', head: true }) as { ok: boolean; value: unknown }
    assert.equal(r2.ok, true)
    assert.equal(r2.value, null, 'the throwing head face falls through to the observation path')

    const junkState = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      snapshot: () => ({ values: {} }),
    })
    watchDetailChannel(junkState.ctx, BOUNDS)
    const r3 = await call(junkState.captured, { sessionId: 's1', head: true }) as { ok: boolean; value: unknown }
    assert.equal(r3.ok, true)
    assert.equal(r3.value, null, 'an absent head view falls through too')

    const stringThrow = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: {
        get: () => {
          throw 'string boom'
        },
      },
    })
    watchDetailChannel(stringThrow.ctx, BOUNDS)
    const r4 = await call(stringThrow.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(r4.ok, false)
    assert.equal(r4.error.message, 'string boom')
  })
})

describe('the cold fold (issue #145)', () => {
  function coldCtx(observe: (id: string) => Promise<unknown>, persistence: unknown = { backend: 'default' }): { ctx: Context; captured: { fetch?: RouteFetch } } {
    return ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessions: sessionsWith(okSession()),
      stateOf: () => undefined,
      sessionQuery: { observeSession: (id: string) => observe(id) },
      sessionPersistence: persistence,
    })
  }

  function manyEvents(count: number): TimelineEvent[] {
    const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
    for (let seq = 2; seq <= count; seq++) {
      events.push(seq % 2 === 0
        ? userMessage(seq, [{ type: 'text', text: `question ${seq}` }], { kind: 'user' })
        : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
    }
    return events
  }

  test('a monster log folds to the byte-identical detail, yielding to the event loop per chunk', async () => {
    const events = manyEvents(2_001)
    const { ctx, captured } = coldCtx(() => Promise.resolve({ events, [Symbol.dispose]: () => {} }))
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      watchDetailChannel(ctx, BOUNDS)
      const result = await call(captured, { sessionId: 'cold1' }) as { ok: boolean; value: unknown }
      assert.equal(result.ok, true)
      const reference = buildTimelineDetail(driveTimeline(events).state, BOUNDS)
      assert.deepStrictEqual(result.value, reference, 'the yielding fold produces the identical payload')
      const yields = timerSpy.mock.calls.filter(args => args[1] === 0).length
      assert.equal(yields, 2, 'two macrotask yields across 2,001 events')
    } finally {
      timerSpy.mockRestore()
    }
  })

  test('an unchanged log (same durable revision) re-serves the payload without refolding', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    let disposed = 0
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      revision: 'dev:ino:100:42:42',
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => { disposed++ },
    }))
    watchDetailChannel(ctx, BOUNDS)
    const first = await call(captured, { sessionId: 'cold1' })
    const second = await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 1, 'the second read never touched the log')
    assert.deepEqual(second, first, 'the re-served payload is identical')
    assert.equal(disposed, 2, 'both observation leases released')
  })

  test('a changed revision refolds; an observation without a revision never keys the cache', async () => {
    const events = manyEvents(5)
    let eventReads = 0
    let revision: string | undefined = 'r1'
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      get revision() { return revision },
      get events() {
        eventReads++
        return events
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    revision = 'r2'
    await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 2, 'the changed log refolded instead of serving stale data')
    revision = undefined
    await call(captured, { sessionId: 'cold1' })
    await call(captured, { sessionId: 'cold1' })
    assert.equal(eventReads, 4, 'no revision — every read folds, as before')
  })

  test('the cache holds four sessions; the evicted oldest refolds, the kept newest re-serves', async () => {
    const reads = new Map<string, number>()
    const { ctx, captured } = coldCtx((id) => Promise.resolve({
      revision: `r-${id}`,
      get events() {
        reads.set(id, (reads.get(id) ?? 0) + 1)
        return manyEvents(5)
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) await call(captured, { sessionId: id })
    assert.deepEqual([...reads.values()], [1, 1, 1, 1, 1], 'every first read folded')
    await call(captured, { sessionId: 'c5' })
    assert.equal(reads.get('c5'), 1, 'the newest entry survived eviction')
    await call(captured, { sessionId: 'c1' })
    assert.equal(reads.get('c1'), 2, 'the evicted oldest refolded on its next read')
  })

  test('a swapped persistence instance and a remount never alias a stale payload', async () => {
    const events = manyEvents(5)
    let swappedReads = 0
    const observe = (): Promise<unknown> => Promise.resolve({
      revision: 'same-token-from-two-backends',
      get events() {
        swappedReads++
        return events
      },
      [Symbol.dispose]: () => {},
    })
    const first = coldCtx(observe, { backend: 'one' })
    watchDetailChannel(first.ctx, BOUNDS)
    await call(first.captured, { sessionId: 'cold1' })
    const second = coldCtx(observe, { backend: 'two' })
    watchDetailChannel(second.ctx, BOUNDS)
    await call(second.captured, { sessionId: 'cold1' })
    assert.equal(swappedReads, 2, 'a replaced persistence invalidates every cached payload (the dsh trust tuple)')

    let remountReads = 0
    const { ctx, captured } = coldCtx(() => Promise.resolve({
      revision: 'r1',
      get events() {
        remountReads++
        return events
      },
      [Symbol.dispose]: () => {},
    }))
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    watchDetailChannel(ctx, BOUNDS)
    await call(captured, { sessionId: 'cold1' })
    assert.equal(remountReads, 2, 'the remounted route folds against its own cache')
  })
})
