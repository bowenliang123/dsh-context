import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CatalogEntry, CatalogService } from '../../src/host/catalog'
import type { ColdReadGate } from '../../src/host/coldRead'
import type { Recom } from '../../src/shared/recoms'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL } from '../../src/shared/recoms'
import { readRecoms, RECOM_ROUTE, setRecomFetcher, watchRecomChannel } from '../../src/host/recoms'
import { watchPromptInjection, type SystemPromptFace } from '../../src/host/promptInjection'
import { SKILLS_ROUTE, watchSkillCatalog } from '../../src/host/skills'
import { VERSION_ROUTE, watchVersionChannel } from '../../src/host/versionRoute'
import { connectionOf, fakeCtx, OPEN_GATE, postJson, SKIP_GATE, type FakeCtx, type FakeRoute } from './helpers/ctx'

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
