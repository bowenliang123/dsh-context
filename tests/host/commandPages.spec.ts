import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { COMMANDS_ROUTE, watchCommandPageChannel } from '../../src/host/commandPages'
import { resolveBounds } from '../../src/host/config'
import { type TimelineEvent } from '../../src/host/foldState'
import { connectionOf, fakeCtx, observationOf, postJson, type FakeRoute, OPEN_GATE, SKIP_GATE, type FakeCtx } from './helpers/ctx'
import { toolCall, toolResult } from './helpers/events'
import { SKILLS_ROUTE, watchSkillCatalog } from '../../src/host/skills'
import { type ColdReadGate } from '../../src/host/coldRead'
import { type Context } from '@deepseek-ai/cordis'
import { watchPromptInjection, type SystemPromptFace } from '../../src/host/promptInjection'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, type Recom } from '../../src/shared/recoms'
import { readRecoms, setRecomFetcher, RECOM_ROUTE, watchRecomChannel } from '../../src/host/recoms'

describe('commandPages', () => {

const BOUNDS = resolveBounds({})

const call = (captured: FakeRoute, body: unknown): Promise<unknown> => postJson(captured, COMMANDS_ROUTE, body)

function bashCall(seq: number, callId: string, cmd: string): TimelineEvent {
  return toolCall(seq, { callId, name: 'bash', arguments: JSON.stringify({ command: cmd }) })
}

function bashResult(seq: number, callId: string, text: string): TimelineEvent {
  return toolResult(seq, { callId, content: [{ type: 'text', text }] })
}

function logOf(n: number): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (let i = 0; i < n; i++) {
    events.push(bashCall(2 * i + 1, `c${i}`, `cmd${i}`))
    events.push(bashResult(2 * i + 2, `c${i}`, 'ok'))
  }
  return events
}

interface PageValue {
  ok: boolean
  value: { commands: Array<{ seq: number; cmd: string; status: string; resultSeq?: number }>; atStart: boolean; total: number } | null
  error?: { code: string }
}

function routeWith(
  observe: (id: string, options: unknown) => Promise<unknown>,
  persistence?: () => unknown,
): { captured: FakeRoute; calls: unknown[] } {
  const calls: unknown[] = []
  const fake = fakeCtx({
    connection: connectionOf(),
    sessionQuery: {
      observeSession: (id: string, options: unknown) => {
        calls.push({ id, options })
        return observe(id, options)
      },
    },
  }, persistence === undefined ? {} : { serviceGetters: { sessionPersistence: persistence } })
  watchCommandPageChannel(fake.ctx, BOUNDS)
  return { captured: fake.captured, calls }
}

describe('watchCommandPageChannel gating', () => {
  test('the route stays unregistered without its faces or when the registry refuses', () => {
    const none = fakeCtx({})
    watchCommandPageChannel(none.ctx, BOUNDS)
    assert.equal(none.captured.fetch, undefined)

    const connectionOnly = fakeCtx({ connection: connectionOf() })
    watchCommandPageChannel(connectionOnly.ctx, BOUNDS)
    assert.equal(connectionOnly.captured.fetch, undefined)

    const noObserve = fakeCtx({ connection: connectionOf(), sessionQuery: {} })
    watchCommandPageChannel(noObserve.ctx, BOUNDS)
    assert.equal(noObserve.captured.fetch, undefined)

    const rejecting = fakeCtx({
      connection: { fetch: { register: () => { throw new Error('registration rejected') } } },
      sessionQuery: { observeSession: () => Promise.resolve(null) },
    })
    assert.doesNotThrow(() => watchCommandPageChannel(rejecting.ctx, BOUNDS))
    assert.equal(rejecting.captured.fetch, undefined)
  })

  test('registration opens the path and its effect disposer is collected', () => {
    const fake = fakeCtx({ connection: connectionOf(), sessionQuery: { observeSession: () => Promise.resolve(null) } })
    watchCommandPageChannel(fake.ctx, BOUNDS)
    assert.equal(fake.captured.path, '/api/dsh-context/commands')
    assert.equal(fake.disposers.length, 2, 'the route mount and the idle sweep both collect their disposer')
    for (const d of fake.disposers) d()
  })
})

describe('the command page route', () => {
  test('bad payloads fail with typed envelopes', async () => {
    const { captured } = routeWith(() => Promise.resolve(null))
    for (const body of [null, 42, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const result = await call(captured, body) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `payload ${JSON.stringify(body)} rejected`)
      assert.equal(result.error?.code, 'dsh-context/bad-request')
    }
    const raw = await call(captured, 'not json') as { ok: boolean; error?: { code: string } }
    assert.equal(raw.error?.code, 'dsh-context/bad-request')
    for (const beforeSeq of [-1, 'later', Number.NaN, Infinity]) {
      const result = await call(captured, { sessionId: 's1', beforeSeq }) as { ok: boolean; error?: { code: string } }
      assert.equal(result.ok, false, `beforeSeq ${String(beforeSeq)} rejected`)
    }
  })

  test('a missing observation, an absent log and a skipped cold read all answer the typed null', async () => {
    const absent = routeWith(() => Promise.resolve(null))
    assert.deepEqual(await call(absent.captured, { sessionId: 's1' }), { ok: true, value: null })

    const noEvents = routeWith(() => Promise.resolve({ source: 'live', cursor: 0 }))
    assert.deepEqual(await call(noEvents.captured, { sessionId: 's1', beforeSeq: 5 }), { ok: true, value: null })

    const notAnObject = routeWith(() => Promise.resolve(42))
    assert.deepEqual(await call(notAnObject.captured, { sessionId: 's1' }), { ok: true, value: null })

    const noCursor = routeWith(() => Promise.resolve({ source: 'live' }))
    assert.deepEqual(((await call(noCursor.captured, { sessionId: 's1' })) as PageValue).value, { commands: [], atStart: true, total: 0 })

    const gate = fakeCtx({ connection: connectionOf(), sessionQuery: { observeSession: () => Promise.resolve(null) } })
    let admitted = 0
    watchCommandPageChannel(gate.ctx, BOUNDS, {
      admit: <T>(_read: () => Promise<T>): Promise<T | undefined> => { admitted++; return Promise.resolve(undefined) },
    })
    assert.deepEqual(await call(gate.captured, { sessionId: 's1' }), { ok: true, value: null })
    assert.equal(admitted, 1)
  })

  test('a rejecting read answers the gateway error and the lease disposes', async () => {
    let disposed = 0
    const { captured } = routeWith(() => Promise.reject(new Error('persistence down')))
    const failed = await call(captured, { sessionId: 's1' }) as { ok: boolean; error: { code: string; message: string } }
    assert.equal(failed.ok, false)
    assert.equal(failed.error.code, 'gateway/internal')
    assert.equal(failed.error.message, 'persistence down')

    const lease = routeWith(() => Promise.resolve({
      ...observationOf(logOf(1)),
      [Symbol.dispose]: () => { disposed++ },
    }))
    const page = await call(lease.captured, { sessionId: 's1' }) as PageValue
    assert.equal(page.ok, true)
    assert.equal(disposed, 1, 'the observation lease disposed')
    const bare = routeWith(() => Promise.resolve({ source: 'live', cursor: 1, events: logOf(1) }))
    assert.equal(((await call(bare.captured, { sessionId: 's1' })) as PageValue).ok, true)

    const thrownString = routeWith(() => Promise.reject('persistence down'))
    const nonError = await call(thrownString.captured, { sessionId: 's1' }) as { ok: boolean; error: { message: string } }
    assert.equal(nonError.ok, false)
    assert.equal(nonError.error.message, 'persistence down')
  })

  test('pages walk backwards from the newest record and stop at the log head', async () => {
    const events = logOf(5)
    const { captured, calls } = routeWith(() => Promise.resolve(observationOf(events)))
    const newest = await call(captured, { sessionId: 's1', limit: 2 }) as PageValue
    assert.deepEqual(newest.value?.commands.map(c => c.seq), [7, 9])
    assert.equal(newest.value?.atStart, false)
    assert.equal(newest.value?.total, 5)
    assert.equal('call' in (newest.value?.commands[0] ?? {}), false, 'the pairing key stays off the wire')
    assert.deepEqual(calls, [{ id: 's1', options: { projectionMode: 'none' } }])

    const middle = await call(captured, { sessionId: 's1', beforeSeq: 7, limit: 2 }) as PageValue
    assert.deepEqual(middle.value?.commands.map(c => c.seq), [3, 5])
    assert.equal(middle.value?.atStart, false)

    const oldest = await call(captured, { sessionId: 's1', beforeSeq: 3, limit: 2 }) as PageValue
    assert.deepEqual(oldest.value?.commands.map(c => c.seq), [1])
    assert.equal(oldest.value?.atStart, true)

    const none = await call(captured, { sessionId: 's1', beforeSeq: 0 }) as PageValue
    assert.deepEqual(none.value, { commands: [], atStart: true, total: 5 })

    const all = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(all.value?.commands.map(c => c.seq), [1, 3, 5, 7, 9])
    assert.equal(all.value?.atStart, true)
  })

  test('the limit defaults to 400 and clamps to the 1..1000 range', async () => {
    const events = logOf(3)
    const { captured } = routeWith(() => Promise.resolve(observationOf(events)))
    const zero = await call(captured, { sessionId: 's1', limit: 0 }) as PageValue
    assert.equal(zero.value?.commands.length, 1)
    const string = await call(captured, { sessionId: 's1', limit: 'lots' }) as PageValue
    assert.equal(string.value?.commands.length, 3)
    const huge = await call(captured, { sessionId: 's1', limit: 50_000 }) as PageValue
    assert.equal(huge.value?.commands.length, 3)
  })

  test('a live log extends its cached fold without refolding the prefix', async () => {
    const events = logOf(2)
    let served: TimelineEvent[] = events.slice(0, 2)
    const { captured } = routeWith(() => Promise.resolve(observationOf(served)))
    const first = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(first.value?.commands.map(c => c.seq), [1])
    assert.equal(first.value?.total, 1)

    served = events
    const second = await call(captured, { sessionId: 's1' }) as PageValue
    assert.deepEqual(second.value?.commands.map(c => c.seq), [1, 3])
    assert.equal(second.value?.total, 2, 'the cached fold extended to the new cut')

    const same = await call(captured, { sessionId: 's1', beforeSeq: 3 }) as PageValue
    assert.deepEqual(same.value?.commands.map(c => c.seq), [1], 'an older page re-serves the cached fold')
  })

  test('a stored log re-serves a durable revision and refolds when it moves', async () => {
    const first = logOf(2)
    let events = first
    let revision = 'rev-1'
    const { captured } = routeWith(() => Promise.resolve(observationOf(events, { source: 'prepared', revision })))
    const a = await call(captured, { sessionId: 'cold1' }) as PageValue
    assert.deepEqual(a.value?.commands.map(c => c.seq), [1, 3])

    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 2, 'same revision reuses')

    events = logOf(1)
    revision = 'rev-2'
    const b = await call(captured, { sessionId: 'cold1' }) as PageValue
    assert.deepEqual(b.value?.commands.map(c => c.seq), [1])
    assert.equal(b.value?.total, 1, 'the moved revision refolded from the new log')
  })

  test('a swapped persistence identity never reuses a stored-log fold', async () => {
    let events = logOf(2)
    let backend: unknown = { name: 'a' }
    const { captured } = routeWith(
      () => Promise.resolve(observationOf(events, { source: 'prepared', revision: 'r1' })),
      () => backend,
    )
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 2)
    events = logOf(1)
    backend = { name: 'b' }
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 1, 'the swapped backend refolded')
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 1, 'the new identity reuses')
  })

  test('a re-bound persistence wrapper with the same identity reuses the stored fold', async () => {
    const events = logOf(2)
    const firstObservation = observationOf(events, { source: 'prepared', revision: 'r1' })
    const secondObservation = observationOf(events, { source: 'prepared', revision: 'r1' })
    secondObservation.events = new Proxy(logOf(2), {
      get: (target, key) => {
        if (key === 'length') return target.length
        if (typeof key === 'string' && /^\d+$/.test(key)) throw new Error('the cold fold ran again')
        return Reflect.get(target, key)
      },
    })
    let calls = 0
    const { captured } = routeWith(
      () => Promise.resolve(calls++ === 0 ? firstObservation : secondObservation),
      () => ({ identity: 'persistence-1', generation: calls }),
    )
    assert.equal(((await call(captured, { sessionId: 'cold1' })) as PageValue).value?.total, 2)
    const reused = (await call(captured, { sessionId: 'cold1' })) as PageValue
    assert.equal(reused.ok, true, 'the re-bound wrapper keeps the cached fold')
    assert.equal(reused.value?.total, 2)
  })

  test('an unkeyed stored log refolds per read and a source switch never reuses a keyed fold', async () => {
    let events = logOf(1)
    const unkeyed = routeWith(() => Promise.resolve(observationOf(events, { source: 'prepared' })))
    assert.equal(((await call(unkeyed.captured, { sessionId: 's1' })) as PageValue).value?.total, 1)
    events = logOf(2)
    assert.equal(((await call(unkeyed.captured, { sessionId: 's1' })) as PageValue).value?.total, 2, 'unkeyed logs refold')

    for (const revision of ['', 42]) {
      const weird = routeWith(() => Promise.resolve(observationOf(logOf(1), { source: 'prepared', revision })))
      assert.equal(((await call(weird.captured, { sessionId: 's3' })) as PageValue).value?.total, 1, `revision ${String(revision)} is unkeyed`)
    }

    let served = logOf(2)
    let source: 'live' | 'prepared' = 'prepared'
    const keyed = routeWith(() => Promise.resolve(observationOf(served, { source, ...(source === 'prepared' ? { revision: 'r1' } : {}) })))
    assert.equal(((await call(keyed.captured, { sessionId: 's2' })) as PageValue).value?.total, 2)
    source = 'live'
    served = logOf(1)
    const live = await call(keyed.captured, { sessionId: 's2' }) as PageValue
    assert.equal(live.value?.total, 1, 'the live source rebuilt instead of reusing the prepared fold')
  })

  test('a cut that moves backwards or disagrees with the event array folds defensively', async () => {
    let events = logOf(2)
    const { captured } = routeWith(() => Promise.resolve(observationOf(events)))
    assert.equal(((await call(captured, { sessionId: 's1' })) as PageValue).value?.total, 2)
    events = logOf(1)
    assert.equal(((await call(captured, { sessionId: 's1' })) as PageValue).value?.total, 1, 'a shorter cut drops the cached fold')

    const overlong = routeWith(() => Promise.resolve({ source: 'live', cursor: 2, events: logOf(2) }))
    assert.equal(((await call(overlong.captured, { sessionId: 's1' })) as PageValue).value?.total, 2, 'the fold stops at the cursor')

    const truncated = routeWith(() => Promise.resolve({ source: 'live', cursor: 10, events: logOf(1) }))
    assert.equal(((await call(truncated.captured, { sessionId: 's1' })) as PageValue).value?.total, 1, 'a short array stops the fold')
  })

  test('three sessions trim the fold cache and a monster log yields per chunk', async () => {
    const events = logOf(1)
    const { captured } = routeWith(id => Promise.resolve(observationOf(events.slice(0, id === 'a' ? 0 : 2), { revision: `r-${id}` })))
    assert.equal(((await call(captured, { sessionId: 'a' })) as PageValue).value?.total, 0)
    assert.equal(((await call(captured, { sessionId: 'b' })) as PageValue).value?.total, 1)
    assert.equal(((await call(captured, { sessionId: 'c' })) as PageValue).value?.total, 1)

    const monster: TimelineEvent[] = []
    for (let seq = 1; seq <= 2_001; seq++) monster.push({ type: 'todo/write', seq, time: seq, data: {} })
    monster.push(bashCall(2_002, 'c1', 'echo hi'))
    monster.push(bashResult(2_003, 'c1', 'hi'))
    const big = routeWith(() => Promise.resolve(observationOf(monster)))
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    try {
      const page = await call(big.captured, { sessionId: 'big' }) as PageValue
      assert.equal(page.value?.total, 1)
      const yields = timerSpy.mock.calls.filter(args => args[1] === 0).length
      assert.equal(yields, 2, 'two macrotask yields across 2,003 events')
    } finally {
      timerSpy.mockRestore()
    }
  })
})

describe('command page cache idle sweep', () => {
  test('drops the cached fold after inactivity and dispose clears the armed sweep', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: async () => observationOf(logOf(2), { revision: 'r1' }) },
    })
    watchCommandPageChannel(fake.ctx, BOUNDS, undefined, { idleSweepMs: 5 })
    await call(fake.captured, { sessionId: 's1' })
    await new Promise(resolve => setTimeout(resolve, 20))
    await call(fake.captured, { sessionId: 's1' })
    const third = await call(fake.captured, { sessionId: 's1' }) as { ok: boolean }
    assert.equal(third.ok, true)
    fake.dispose()
    assert.doesNotThrow(() => { fake.dispose() })
  })
})
})

describe('skills', () => {

interface CtxSpec {
  connection?: unknown
  skills?: unknown
  sessionQuery?: unknown
  agents?: unknown
  agentPresets?: unknown
}

const ctxOf = (spec: CtxSpec): FakeCtx => fakeCtx(spec)

function registryOf(rows: unknown, log?: unknown[]): { list: (options: unknown) => Promise<unknown> } {
  return {
    list: async (options: unknown) => {
      log?.push(options)
      if (rows instanceof Error) throw rows
      return rows
    },
  }
}

function queryOf(observation: unknown, opts: { throws?: boolean; disposed?: string[]; log?: unknown[] } = {}): { observeSession: (id: string, options: unknown) => Promise<unknown> } {
  return {
    observeSession: async (_id: string, options: unknown) => {
      opts.log?.push(options)
      if (opts.throws === true) throw new Error('no such session')
      const obs = observation as Record<string, unknown>
      if (obs !== null && typeof obs === 'object' && opts.disposed !== undefined && !(Symbol.dispose in obs)) {
        (obs as unknown as Record<symbol, unknown>)[Symbol.dispose] = () => { opts.disposed?.push('disposed') }
      }
      return observation
    },
  }
}

const ROWS = [
  { name: 'tdd', description: 'Test-driven development', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents', invocation: {}, provider: 'fs' },
  { name: 'ask-matt', description: 'A router', source: 'project-agents' },
]

const serve = (captured: FakeRoute, body: unknown = {}): Promise<Record<string, unknown>> => postJson(captured, SKILLS_ROUTE, body)

function armed(spec: Omit<CtxSpec, 'connection'> = {}): FakeRoute {
  return armedWith(OPEN_GATE, spec)
}

function armedWith(gate: ColdReadGate, spec: Omit<CtxSpec, 'connection'> = {}): FakeRoute {
  const fake = fakeCtx({ connection: connectionOf(), ...spec })
  watchSkillCatalog(fake.ctx, gate)
  return fake.captured
}

describe('skills route registration', () => {
  test('a missing or unusable connection registry never mounts the route; a rejecting one stays up, a good one mounts', () => {
    for (const spec of [{ skills: registryOf(ROWS) }, { connection: {}, skills: registryOf(ROWS) }]) {
      const { ctx, captured } = ctxOf(spec)
      watchSkillCatalog(ctx)
      assert.equal(captured.fetch, undefined)
    }
    const rejecting = ctxOf({
      connection: { fetch: { register: () => { throw new Error('hostile registry') } } },
      skills: registryOf(ROWS),
    })
    assert.doesNotThrow(() => watchSkillCatalog(rejecting.ctx))
    assert.equal(rejecting.captured.fetch, undefined)
    assert.equal(armed({ skills: registryOf(ROWS) }).path, SKILLS_ROUTE)
  })
})

describe('skills route: the session-addressed resolution', () => {
  test('a cold session reads its view through the cold-read gate with projections off, from the durable header', async () => {
    const observed: unknown[] = []
    const captured = armed({
      skills: registryOf(ROWS),
      sessionQuery: queryOf(
        { header: { cwd: '/repo/cold', agentPreset: 'preset-x' } },
        { log: observed },
      ),
      agents: { get: () => undefined },
      agentPresets: {
        acquireScope: async (id?: string) => ({ key: 'scope-key', ...(id === undefined ? {} : {}) }),
      },
    })
    const reply = await serve(captured, { sessionId: 'cold-1' })
    assert.deepEqual(observed, [{ projectionMode: 'none' }], 'the observation skips every projection fold')
    assert.deepEqual((reply.value as { skills: unknown[] }).skills.length, 2, 'the header preset still scopes the read')
  })

  test('the session’s observation overrides the body cwd and feeds the preset to the scope lease', async () => {
    const listLog: unknown[] = []
    const disposed: string[] = []
    const leases: (string | undefined)[] = []
    const captured = armed({
      skills: registryOf(ROWS, listLog),
      sessionQuery: queryOf(
        { header: { cwd: '/repo/from-session', agentPreset: 'deep' } },
        { disposed },
      ),
      agents: { get: () => undefined },
      agentPresets: {
        acquireScope: async (id?: string) => {
          leases.push(id)
          return { key: 'scope-key', [Symbol.asyncDispose]: async () => { disposed.push('lease') } }
        },
      },
    })
    const reply = await serve(captured, { sessionId: 's1', cwd: '/repo/from-body' })
    assert.deepEqual(listLog, [{ cwd: '/repo/from-session', scope: 'scope-key' }], 'the observation’s cwd wins; the lease’s key scopes the read')
    assert.deepEqual(leases, ['deep'], 'the recorded preset selects the standing scope')
    assert.deepEqual(disposed.sort(), ['disposed', 'lease'], 'the observation and the lease both release')
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })

  test('a live agent’s preset-scoped registry wins, scoped by the agent itself', async () => {
    const globalLog: unknown[] = []
    const scopedLog: unknown[] = []
    const agent = { ctx: 'live-agent' }
    const captured = armed({
      skills: registryOf([], globalLog),
      sessionQuery: queryOf({ header: { cwd: '/repo/x' }, projections: { values: {} } }),
      agents: { get: (id: string) => (id === 's1' ? agent : undefined) },
      agentPresets: {
        serviceFor: (a: unknown, name: string) => (a === agent && name === 'skills' ? registryOf(ROWS, scopedLog) : undefined),
        acquireScope: async () => { throw new Error('must not lease for a live agent') },
      },
    })
    await serve(captured, { sessionId: 's1' })
    assert.deepEqual(scopedLog, [{ cwd: '/repo/x', scope: agent }])
    assert.deepEqual(globalLog, [], 'the global registry never reads')
  })

  test('a live agent without a usable preset face falls back to the unscoped global registry', async () => {
    const scopedLog: unknown[] = []
    const scoped = armed({
      skills: registryOf(ROWS, scopedLog),
      agents: { get: () => ({}) },
      agentPresets: { serviceFor: () => ({ noList: true }) },
    })
    const liveLog: unknown[] = []
    const live = armed({ skills: registryOf(ROWS, liveLog), agents: { get: () => null }, agentPresets: {} })
    for (const captured of [scoped, live]) {
      const reply = await serve(captured, { sessionId: 's1' })
      assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
    }
    assert.deepEqual(scopedLog, [{}], 'a serviceFor face without list reads unscoped')
    assert.deepEqual(liveLog, [{}], 'an agent with no preset faces reads unscoped')
  })

  test('a lease without a key, a throwing agents face, and a throwing lease all degrade to the unscoped global read', async () => {
    const unkeyed: unknown[] = []
    const unkeyedRoute = armed({
      skills: registryOf(ROWS, unkeyed),
      agents: { get: () => undefined },
      agentPresets: { acquireScope: async () => ({}) },
    })
    await serve(unkeyedRoute, { sessionId: 's1' })
    assert.deepEqual(unkeyed, [{}])
    const log: unknown[] = []
    const captured = armed({
      skills: registryOf(ROWS, log),
      agents: { get: () => { throw new Error('hostile agents') } },
      agentPresets: { acquireScope: async () => { throw new Error('unknown preset') } },
    })
    const reply = await serve(captured, { sessionId: 's1' })
    assert.deepEqual(log, [{}])
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })

  test('every observation gap leaves the body’s cwd as the only selector', async () => {
    const bodies: unknown[] = [{ sessionId: 's1', cwd: '/repo/body' }, { sessionId: '', cwd: '/repo/body' }, { sessionId: 7, cwd: '/repo/body' }]
    for (const query of [undefined, {}, { observeSession: 42 }, queryOf(null, { throws: true }), queryOf(null)]) {
      const log: unknown[] = []
      const captured = armed({ skills: registryOf([], log), ...(query === undefined ? {} : { sessionQuery: query }) })
      for (const body of bodies) await serve(captured, body)
      assert.deepEqual(log, bodies.map(() => ({ cwd: '/repo/body' })))
    }
    const log: unknown[] = []
    const captured = armed({ skills: registryOf([], log) })
    for (const body of [{ cwd: '/repo/alpha' }, {}, { cwd: 42 }, { cwd: '' }, 'not a record']) await serve(captured, JSON.stringify(body))
    assert.deepEqual(log, [{ cwd: '/repo/alpha' }, {}, {}, {}, {}])
  })

  test('an absent, unusable, or throwing registry and a broken body answer typed values, never a transport throw', async () => {
    for (const skills of [undefined, {}, { list: 42 }]) {
      assert.deepEqual(await serve(armed(skills === undefined ? {} : { skills })), { ok: true, value: null })
    }
    assert.deepEqual(await serve(armed({ skills: registryOf(new Error('disk down')) })), { ok: true, value: null })
    assert.deepEqual(await serve(armed({ skills: registryOf('not an array') })), { ok: true, value: { skills: [] } })
    const captured = armed({ skills: registryOf(ROWS) })
    const response = await captured.fetch!(new Request('http://localhost' + SKILLS_ROUTE, { method: 'POST', body: 'not json' }))
    assert.deepEqual(await response.json(), { ok: true, value: null })
  })

  test('a hostile lease disposer is swallowed after the read landed', async () => {
    const captured = armed({
      skills: registryOf(ROWS),
      agentPresets: {
        acquireScope: async () => ({ key: 'k', [Symbol.asyncDispose]: async () => { throw new Error('hostile dispose') } }),
      },
    })
    const reply = await serve(captured, { sessionId: 's1' })
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2)
  })
})

describe('skills route outcomes', () => {
  test('the registry’s summaries narrow to the wire entries — name, description, path, source only', async () => {
    const reply = await serve(armed({ skills: registryOf(ROWS) }))
    assert.deepEqual(reply, {
      ok: true,
      value: {
        skills: [
          { name: 'tdd', description: 'Test-driven development', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents' },
          { name: 'ask-matt', description: 'A router', source: 'project-agents' },
        ],
      },
    })
  })

  test('entries failing the name proof drop whole; description defaults empty; path/source ride only when proved', async () => {
    const registry = registryOf([
      null,
      'row',
      [],
      { description: 'no name' },
      { name: '' },
      { name: 42 },
      { name: 'bare' },
      { name: 'odd', description: 7, path: '', source: '' },
    ])
    assert.deepEqual(await serve(armed({ skills: registry })), {
      ok: true,
      value: { skills: [{ name: 'bare', description: '' }, { name: 'odd', description: '' }] },
    })
  })

  test('the serve bound caps a runaway registry', async () => {
    const registry = registryOf(Array.from({ length: 600 }, (_, i) => ({ name: `s${i}` })))
    const reply = await serve(armed({ skills: registry }))
    const value = reply.value as { skills: unknown[] }
    assert.equal(value.skills.length, 500)
  })
})


describe('skills route cold-read gate', () => {
  test('a shed cold read answers with the preset-less registry view and never throws', async () => {
    const captured = armedWith(SKIP_GATE, {
      skills: registryOf(ROWS),
      sessionQuery: queryOf({ header: { cwd: '/repo/cold', agentPreset: 'preset-x' } }),
      agents: { get: () => undefined },
      agentPresets: { acquireScope: async () => ({ key: 'scope-key' }) },
    })
    const reply = await serve(captured, { sessionId: 'cold-1' })
    assert.equal(reply.ok, true)
    assert.equal((reply.value as { skills: unknown[] }).skills.length, 2, 'the registry view still serves without the observation')
    const listLog: unknown[] = []
    const scoped = armedWith(SKIP_GATE, {
      skills: registryOf(ROWS, listLog),
      sessionQuery: queryOf({ header: { cwd: '/repo/cold' } }),
      agents: { get: () => undefined },
    })
    await serve(scoped, { sessionId: 'cold-2' })
    assert.deepEqual(listLog, [{}], 'no preset and no observation leaves the default scope')
  })
})
})

describe('promptInjection', () => {

type RegisteredSection = {
  name: string
  order: number
  text: string | ((context: unknown) => string)
  interpolate?: boolean
}

function fakeSystemPrompt(): SystemPromptFace & { registered: RegisteredSection[] } {
  const registered: RegisteredSection[] = []
  return {
    registered,
    section(section: RegisteredSection): () => void {
      registered.push(section)
      return () => {}
    },
    getSectionOrder(name: string): number {
      const orders: Record<string, number> = { HARNESS_IDENTITY: -1000, DEPLOYMENT_PERSONA_SUFFIX: 10200 }
      return orders[name] ?? 0
    },
  }
}

function ctxWith(systemPrompt: unknown): Context {
  return {
    inject: (_names: unknown, cb: (inner: unknown) => void) => { cb({ systemPrompt }) },
  } as unknown as Context
}

function ref(box: { value: unknown }): { get: () => unknown } {
  return { get: () => box.value }
}

function textOf(section: RegisteredSection | undefined): string {
  return typeof section?.text === 'function' ? section.text(undefined) : ''
}

describe('watchPromptInjection', () => {
  test('registers both sections outside every allocated slot, with literal text', () => {
    const face = fakeSystemPrompt()
    watchPromptInjection(ctxWith(face), { promptPrefix: 'FIRST', promptSuffix: 'LAST' } as never)
    assert.deepEqual(face.registered.map(section => section.name), [
      'dsh-context:prompt-prefix',
      'dsh-context:prompt-suffix',
    ])
    const [prefix, suffix] = face.registered
    assert.equal(prefix.order, -2000, 'ahead of HARNESS_IDENTITY, anchored through the harness registry')
    assert.equal(suffix.order, 11200, 'behind DEPLOYMENT_PERSONA_SUFFIX')
    assert.equal(textOf(prefix), 'FIRST')
    assert.equal(textOf(suffix), 'LAST')
    assert.ok(face.registered.every(section => section.interpolate === false), 'the text is literal, never variable-interpolated')
  })

  test('a volatile reference is read at each assembly; a plain string stays static; non-strings and blanks read empty', () => {
    const face = fakeSystemPrompt()
    const box = { value: 'before' as unknown }
    watchPromptInjection(ctxWith(face), { promptPrefix: ref(box), promptSuffix: '' } as never)
    const prefix = face.registered[0]
    assert.equal(textOf(prefix), 'before')
    box.value = 'after'
    assert.equal(textOf(prefix), 'after', 'the loader rewrites the reference in place; the next assembly reads it')

    const staticFace = fakeSystemPrompt()
    watchPromptInjection(ctxWith(staticFace), { promptPrefix: 'static', promptSuffix: 42 } as never)
    const [staticPrefix, staticSuffix] = staticFace.registered
    assert.equal(textOf(staticPrefix), 'static')
    assert.equal(textOf(staticSuffix), '')
    const refFace = fakeSystemPrompt()
    const nonString = { value: 7 }
    watchPromptInjection(ctxWith(refFace), { promptPrefix: ref(nonString), promptSuffix: ref(nonString) } as never)
    assert.equal(textOf(refFace.registered[0]), '', 'a reference carrying a non-string reads as empty')

    const blankFace = fakeSystemPrompt()
    watchPromptInjection(ctxWith(blankFace), { promptPrefix: '  \n\t ', promptSuffix: '\nline one\n\nline two\n' } as never)
    const [blank, suffix] = blankFace.registered
    assert.equal(textOf(blank), '', 'a blank prompt contributes nothing')
    assert.equal(textOf(suffix), '\nline one\n\nline two\n', 'the configured bytes are preserved')
  })

  test('an absent or malformed prompt registry degrades to a no-op', () => {
    assert.doesNotThrow(() => watchPromptInjection(ctxWith(undefined), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({}), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({ section: () => {} }), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith({ getSectionOrder: () => 0 }), {} as never))
    assert.doesNotThrow(() => watchPromptInjection(ctxWith(null), {} as never))
  })

  test('the deferred inject rides the real cordis: early, late, and never-provided compositions', async () => {
    const { Context } = await import('@deepseek-ai/cordis')

    const early = new Context()
    early.provide('systemPrompt', fakeSystemPrompt())
    await new Promise(resolve => setTimeout(resolve, 10))
    watchPromptInjection(early, { promptPrefix: 'P' } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal((early.reflect.get('systemPrompt') as unknown as { registered: RegisteredSection[] }).registered.length, 2, 'the service first: both sections register')

    const late = new Context()
    watchPromptInjection(late, { promptPrefix: 'P' } as never)
    await new Promise(resolve => setTimeout(resolve, 10))
    const lateFace = fakeSystemPrompt()
    late.provide('systemPrompt', lateFace)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(lateFace.registered.length, 2, 'the service later: the pending inject fires on the provide')

    const never = new Context()
    assert.doesNotThrow(() => watchPromptInjection(never, {} as never))
    await new Promise(resolve => setTimeout(resolve, 10))
  })
})
})

describe('recoms', () => {

function recom(id: string): Recom {
  return { ...DEFAULT_RECOM, id }
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

afterEach(() => {
  setRecomFetcher(null)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('recom reads', () => {
  test('a read fetches the fixed URL and returns every validated entry in source order', async () => {
    const calls: { url: string; accept?: string; signal?: AbortSignal }[] = []
    setRecomFetcher(async (url, init) => {
      const headers = init.headers as Record<string, string>
      calls.push({ url, accept: headers.accept, signal: init.signal ?? undefined })
      return response([recom('first'), recom('second')])
    })
    const read = await readRecoms()
    assert.deepEqual(read.recoms.map(item => item.id), ['first', 'second'])
    assert.equal(read.degraded, false)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, RECOM_DATA_URL)
    assert.equal(calls[0]?.accept, 'application/json')
    assert.ok(calls[0]?.signal instanceof AbortSignal)
  })

  test('transport, HTTP, JSON, and payload failures all return the degraded default list', async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(response([], false)),
      () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) } as unknown as Response),
      () => Promise.resolve(response({ nope: true })),
      () => Promise.resolve(response([])),
    ]
    for (const run of failures) {
      setRecomFetcher(run)
      const read = await readRecoms()
      assert.deepEqual(read.recoms, [DEFAULT_RECOM])
      assert.equal(read.degraded, true)
    }
  })

  test('every primary failure falls through to the mirror before the default', async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(response([], false)),
      () => Promise.resolve(response([])),
    ]
    for (const fail of failures) {
      const urls: string[] = []
      setRecomFetcher(async (url) => {
        urls.push(url)
        return url === RECOM_DATA_URL ? fail() : response([recom('mirror')])
      })
      const read = await readRecoms()
      assert.deepEqual(read.recoms.map(item => item.id), ['mirror'])
      assert.equal(read.degraded, false)
      assert.deepEqual(urls, [RECOM_DATA_URL, RECOM_DATA_MIRROR_URL])
    }
  })

  test('resetting the fetcher restores the real global fetch', async () => {
    setRecomFetcher(async () => { throw new Error('stub') })
    setRecomFetcher(null)
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      seen.push(String(url))
      return response([recom('global')])
    })
    const read = await readRecoms()
    assert.deepEqual(read.recoms.map(item => item.id), ['global'])
    assert.equal(read.degraded, false)
    assert.deepEqual(seen, [RECOM_DATA_URL])
  })
})

describe('recom route', () => {
  test('a usable connection serves the complete list with no-store, and absent registries stay inert', async () => {
    for (const connection of [undefined, {}]) {
      const ctx = {
        inject: (_deps: string[], cb: (c: unknown) => void) => cb({ get: () => connection, effect: () => {} }),
      }
      assert.doesNotThrow(() => watchRecomChannel(ctx as unknown as Context))
    }
    let clock = 1_000
    let route: { path: string; fetch: () => Promise<Response> } | undefined
    const ctx = {
      get: () => ({ fetch: { register: (next: typeof route) => { route = next; return () => {} } } }),
      effect: (fn: () => unknown) => fn(),
      inject(_deps: string[], cb: (c: unknown) => void) { cb(ctx) },
    }
    const calls: string[] = []
    setRecomFetcher(async () => {
      calls.push('ok')
      return response([recom('route'), recom('second')])
    })
    watchRecomChannel(ctx as unknown as Context, { now: () => clock })
    assert.equal(route?.path, RECOM_ROUTE)
    const reply = await route?.fetch()
    assert.equal(reply?.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await reply?.json(), { ok: true, value: [recom('route'), recom('second')], degraded: false })
    setRecomFetcher(async () => {
      calls.push('down')
      throw new Error('down')
    })
    const cached = await route?.fetch()
    assert.deepEqual(await cached?.json(), { ok: true, value: [recom('route'), recom('second')], degraded: false }, 'a fresh slot answers from the TTL cache')
    assert.deepEqual(calls, ['ok'])
    clock += 60 * 60 * 1000
    const fallback = await route?.fetch()
    assert.deepEqual(await fallback?.json(), { ok: true, value: [DEFAULT_RECOM], degraded: true })
    assert.deepEqual(calls, ['ok', 'down', 'down'], 'the expired slot refetched the primary and the mirror')
    const backoff = await route?.fetch()
    assert.deepEqual(await backoff?.json(), { ok: true, value: [DEFAULT_RECOM], degraded: true }, 'a degraded slot serves the default during the backoff window')
    assert.deepEqual(calls, ['ok', 'down', 'down'], 'the backoff window skips the network')
    clock += 30_000
    setRecomFetcher(async () => {
      calls.push('ok')
      return response([recom('after-backoff')])
    })
    const recovered = await route?.fetch()
    assert.deepEqual(await recovered?.json(), { ok: true, value: [recom('after-backoff')], degraded: false }, 'the backoff window expires into a fresh read')

    setRecomFetcher(async () => response([recom('default-now')]))
    let plainRoute: { path: string; fetch: () => Promise<Response> } | undefined
    const plainCtx = {
      get: () => ({ fetch: { register: (next: typeof plainRoute) => { plainRoute = next; return () => {} } } }),
      effect: (fn: () => unknown) => fn(),
      inject(_deps: string[], cb: (c: unknown) => void) { cb(plainCtx) },
    }
    watchRecomChannel(plainCtx as unknown as Context)
    const plain = await plainRoute?.fetch()
    assert.deepEqual(await plain?.json(), { ok: true, value: [recom('default-now')], degraded: false }, 'the default wall clock serves the same protocol')
  })
})
})
