import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { SKILLS_ROUTE, watchSkillCatalog } from '../../src/host/skills'
import { connectionOf, fakeCtx, OPEN_GATE, postJson, SKIP_GATE } from './helpers/ctx'
import type { ColdReadGate } from '../../src/host/coldRead'
import type { FakeCtx, FakeRoute } from './helpers/ctx'

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
