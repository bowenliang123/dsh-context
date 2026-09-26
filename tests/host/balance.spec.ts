// The DeepSeek balance route (src/host/balance.ts): the deferred-inject
// gating on the connection face (load-order independent, absent face = no
// route), the per-request resolution of the llm-deepseek connection facts
// (settings section + credentials), the typed `null` for every
// not-configured or failed read (the route must never throw into the
// transport), the payload's hostile-entry dropping, and the read that serves
// every caller the platform's current figures (shared only while in flight).

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { BALANCE_ROUTE, balanceOfPayload, resetBalance, setBalanceFetcher, watchBalanceChannel } from '../../src/host/balance'

type RouteFetch = () => Promise<Response>

interface CtxSpec {
  connection?: unknown
  settings?: unknown
  credentials?: unknown
}

/**
 * A minimal host ctx double with cordis inject semantics: the callback runs
 * once its dependency list completes (here: immediately when the services
 * map has them, never otherwise), and its returned disposer is collected.
 */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  for (const key of ['connection', 'settings', 'credentials'] as const) {
    if (key in spec) services.set(key, spec[key])
  }
  const ctx = {
    get: (name: string) => services.get(name),
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
      const original = conn.fetch.register as (route: { path: string; fetch: RouteFetch }) => (() => void)
      // Delegate to the spec's own register (a hostile one still throws), so
      // the capture only lands when the registration actually mounted.
      conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
        const dispose = original(route)
        captured.path = route.path
        captured.fetch = route.fetch
        return () => {
          captured.fetch = undefined
          dispose()
        }
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

/** The harness settings face serving one namespace's resolved section. */
function settingsOf(section: unknown): { get(ns: string): unknown } {
  return { get: (ns: string) => (ns === 'llm-deepseek' ? section : undefined) }
}

/** The V4+ settings face projecting one row per configurable entry (`throws` fails the read). */
function settingsDescribeOf(rows: unknown, throws = false): { describe(): unknown } {
  return {
    describe() {
      if (throws) throw new Error('hostile describe')
      return rows
    },
  }
}

/** The harness credentials face serving one resolved value. */
function credentialsOf(value: unknown, calls?: string[]): { resolve(ref: string): Promise<{ value: unknown } | undefined> } {
  return {
    resolve(ref: string) {
      calls?.push(ref)
      if (value === undefined) return Promise.resolve(undefined)
      return Promise.resolve({ value })
    },
  }
}

const CNY_BALANCE = {
  is_available: true,
  balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }],
}

/** The all-configured ctx spec: a default section, a resolvable key. */
function configuredCtx(spec: CtxSpec = {}): CtxSpec {
  return {
    connection: { fetch: { register: () => () => {} } },
    settings: settingsOf({}),
    credentials: credentialsOf('sk-test'),
    ...spec,
  }
}

interface FetchLog { url?: string; auth?: string; accept?: string }

/** Stub the platform fetch to serve `body` (or fail per `mode`) and log each call. */
function stubPlatform(body: unknown | undefined, mode: 'ok' | 'reject' | 'status' | 'badjson' = 'ok'): { log: FetchLog[]; calls: () => number } {
  const log: FetchLog[] = []
  setBalanceFetcher(async (url, init) => {
    const headers = (init.headers ?? {}) as Record<string, string>
    log.push({ url, auth: headers.authorization, accept: headers.accept })
    if (mode === 'reject') return Promise.reject(new Error('down'))
    if (mode === 'status') return { ok: false, status: 401, json: async () => ({}) } as unknown as Response
    if (mode === 'badjson') return { ok: true, status: 200, json: () => Promise.reject(new Error('not json')) } as unknown as Response
    return { ok: true, status: 200, json: async () => body } as unknown as Response
  })
  return { log, calls: () => log.length }
}

async function serve(captured: { fetch?: RouteFetch }): Promise<Record<string, unknown>> {
  const response = await captured.fetch!()
  return await response.json() as Record<string, unknown>
}

beforeEach(() => {
  resetBalance()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(1_000_000)
})

afterEach(() => {
  resetBalance()
  setBalanceFetcher(null)
  vi.useRealTimers()
})

describe('balance route registration', () => {
  test('no connection service never registers the route', () => {
    const { ctx, captured } = ctxOf(configuredCtx({ connection: undefined }))
    watchBalanceChannel(ctx)
    assert.equal(captured.fetch, undefined)
  })

  test('a connection without a fetch registry never registers the route', () => {
    const { ctx, captured } = ctxOf(configuredCtx({ connection: {} }))
    watchBalanceChannel(ctx)
    assert.equal(captured.fetch, undefined)
  })

  test('a connection whose register is not a function never registers the route', () => {
    const { ctx, captured } = ctxOf(configuredCtx({ connection: { fetch: { register: 42 } } }))
    watchBalanceChannel(ctx)
    assert.equal(captured.fetch, undefined)
  })

  test('a rejecting registry is swallowed — the plugin stays up, no route', () => {
    const { ctx, captured } = ctxOf(configuredCtx({
      connection: { fetch: { register: () => { throw new Error('hostile registry') } } },
    }))
    assert.doesNotThrow(() => watchBalanceChannel(ctx))
    assert.equal(captured.fetch, undefined)
  })

  test('the route mounts under its path and the disposer withdraws it', () => {
    const { ctx, captured, disposers } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    assert.equal(captured.path, BALANCE_ROUTE)
    assert.equal(typeof captured.fetch, 'function')
    for (const dispose of disposers) dispose()
    assert.equal(captured.fetch, undefined)
  })
})

describe('balance route outcomes', () => {
  test('the configured platform serves the redacted balance through the public API defaults', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsOf({}),
      credentials: credentialsOf('sk-test', refs),
    })
    watchBalanceChannel(ctx)
    const { log, calls } = stubPlatform(CNY_BALANCE)
    const reply = await serve(captured)
    assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
    assert.equal(calls(), 1)
    assert.equal(log[0]?.url, 'https://api.deepseek.com/user/balance')
    assert.equal(log[0]?.auth, 'Bearer sk-test')
    assert.equal(log[0]?.accept, 'application/json')
    assert.deepEqual(reply, {
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] },
    })
  })

  test('the section\'s credential ref and endpoint override win, trailing slashes trimmed', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsOf({ apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: 'https://proxy.test///' }),
      credentials: credentialsOf('sk-proxy', refs),
    })
    watchBalanceChannel(ctx)
    const { log } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['MY_DEEPSEEK_KEY'])
    assert.equal(log[0]?.url, 'https://proxy.test/user/balance')
    assert.equal(log[0]?.auth, 'Bearer sk-proxy')
  })

  test('an already-numeric amount variant and an unavailable flag pass through', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    stubPlatform({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: 0.5, granted_balance: 0, topped_up_balance: 0.5 }],
    })
    const reply = await serve(captured)
    assert.deepEqual(reply, {
      ok: true,
      value: { isAvailable: false, balances: [{ currency: 'USD', total: 0.5, granted: 0, toppedUp: 0.5 }] },
    })
  })

  test('every not-configured shape serves a typed null without touching the platform', async () => {
    const absent: CtxSpec[] = [
      configuredCtx({ settings: undefined }),
      configuredCtx({ settings: {} }),
      configuredCtx({ settings: { get: 'nope' } }),
      configuredCtx({ settings: settingsOf(undefined) }),
      configuredCtx({ settings: settingsOf('not a section') }),
      configuredCtx({ credentials: undefined }),
      configuredCtx({ credentials: {} }),
      configuredCtx({ credentials: { resolve: () => Promise.resolve(undefined) } }),
      configuredCtx({ credentials: { resolve: () => Promise.resolve({ value: '' }) } }),
      configuredCtx({ credentials: { resolve: () => Promise.reject(new Error('store down')) } }),
    ]
    for (const spec of absent) {
      resetBalance()
      const { ctx, captured } = ctxOf(spec)
      watchBalanceChannel(ctx)
      const { calls } = stubPlatform(CNY_BALANCE)
      const reply = await serve(captured)
      assert.deepEqual(reply, { ok: true, value: null })
      assert.equal(calls(), 0)
    }
  })

  test('every platform failure serves a typed null', async () => {
    const failures: [string, unknown | undefined, 'ok' | 'reject' | 'status' | 'badjson'][] = [
      ['transport down', CNY_BALANCE, 'reject'],
      ['non-ok status', CNY_BALANCE, 'status'],
      ['non-JSON body', CNY_BALANCE, 'badjson'],
      ['payload not a record', 'nope', 'ok'],
      ['balance_infos missing', {}, 'ok'],
      ['balance_infos not an array', { balance_infos: 'CNY' }, 'ok'],
      ['null entry', { balance_infos: [null] }, 'ok'],
      ['primitive entry', { balance_infos: ['CNY'] }, 'ok'],
      ['entry not a record', { balance_infos: [[]] }, 'ok'],
      ['missing currency', { balance_infos: [{ granted_balance: '0', topped_up_balance: '0' }] }, 'ok'],
      ['empty currency', { balance_infos: [{ currency: '', granted_balance: '0', topped_up_balance: '0' }] }, 'ok'],
      ['non-numeric part', { balance_infos: [{ currency: 'CNY', granted_balance: 'abc', topped_up_balance: '0' }] }, 'ok'],
      ['NaN part', { balance_infos: [{ currency: 'CNY', granted_balance: 'NaN', topped_up_balance: '0' }] }, 'ok'],
      ['negative part', { balance_infos: [{ currency: 'CNY', granted_balance: '-1', topped_up_balance: '0' }] }, 'ok'],
      ['missing part', { balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00' }] }, 'ok'],
      ['all entries invalid', { balance_infos: [null, { currency: 'CNY' }] }, 'ok'],
    ]
    for (const [label, body, mode] of failures) {
      resetBalance()
      const { ctx, captured } = ctxOf(configuredCtx())
      watchBalanceChannel(ctx)
      stubPlatform(body, mode)
      const reply = await serve(captured)
      assert.deepEqual(reply, { ok: true, value: null }, label)
    }
  })

  test('a hostile entry throwing on property access drops whole, valid siblings survive', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    stubPlatform({ is_available: true, balance_infos: [hostile, CNY_BALANCE.balance_infos[0]] })
    const reply = await serve(captured)
    assert.deepEqual(reply, {
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] },
    })
  })
})

describe('settings faces across generations', () => {
  test('the V4+ describe face serves the facts by the provider row\'s own shape', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'ui-theme', value: { preference: 'light' } },
        { ns: 'llm-pi-ai', value: { providers: { tokener: { apiKeyEnv: 'TOKENER_API_KEY' } } } },
        { ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://proxy.test///', thinking: 'enabled' } },
      ]),
      credentials: credentialsOf('sk-v4', refs),
    })
    watchBalanceChannel(ctx)
    const { log } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
    assert.equal(log[0]?.url, 'https://proxy.test/user/balance')
    assert.equal(log[0]?.auth, 'Bearer sk-v4')
  })

  test('a provider row under an unknown entry id serves by shape; the first shape wins', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'renamed-a', value: { apiKeyEnv: 'FIRST_KEY' } },
        { ns: 'renamed-b', value: { apiKeyEnv: 'SECOND_KEY' } },
      ]),
      credentials: credentialsOf('sk-shape', refs),
    })
    watchBalanceChannel(ctx)
    const { log } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['FIRST_KEY'])
    assert.equal(log[0]?.url, 'https://api.deepseek.com/user/balance')
  })

  test('the served entry ids win over an earlier shape-only row', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'some-provider', value: { apiKeyEnv: 'OTHER_KEY' } },
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'PRODUCT_KEY' } },
      ]),
      credentials: credentialsOf('sk-product', refs),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['PRODUCT_KEY'])
  })

  test('a V3 section that reads absent falls through to the describe face', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: {
        get: () => undefined,
        describe: () => [{ ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'FALLBACK_KEY' } }],
      },
      credentials: credentialsOf('sk-fallback', refs),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['FALLBACK_KEY'])
  })

  test('the V3 section wins when both faces are served', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: {
        get: (ns: string) => (ns === 'llm-deepseek' ? { apiKeyEnv: 'V3_KEY' } : undefined),
        describe: () => [{ ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'V4_KEY' } }],
      },
      credentials: credentialsOf('sk-both', refs),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['V3_KEY'])
  })

  test('every broken describe shape serves a typed null without touching the platform', async () => {
    const faces: unknown[] = [
      settingsDescribeOf('not an array'),
      settingsDescribeOf(null),
      settingsDescribeOf([]),
      settingsDescribeOf([null, 'row', 42, [], {}]),
      settingsDescribeOf([{ value: null }, { ns: 'llm-deepseek-api-key' }, { value: 'section' }]),
      settingsDescribeOf([{ value: {} }, { value: { apiKeyEnv: '' } }, { value: { apiKeyEnv: 42 } }]),
      settingsDescribeOf([], true),
    ]
    for (const settings of faces) {
      resetBalance()
      const { ctx, captured } = ctxOf({
        connection: { fetch: { register: () => () => {} } },
        settings,
        credentials: credentialsOf('sk-test'),
      })
      watchBalanceChannel(ctx)
      const { calls } = stubPlatform(CNY_BALANCE)
      const reply = await serve(captured)
      assert.deepEqual(reply, { ok: true, value: null })
      assert.equal(calls(), 0)
    }
  })

  test('a hostile row throwing on property access drops whole, valid siblings survive', async () => {
    const refs: string[] = []
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([hostile, { ns: 'llm-deepseek-api-key', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]),
      credentials: credentialsOf('sk-test', refs),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    const reply = await serve(captured)
    assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
    assert.deepEqual(reply, {
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] },
    })
  })
})

describe('balanceOfPayload (direct)', () => {
  test('multiple currencies keep their entries in order', () => {
    const balance = balanceOfPayload({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
      ],
    })
    assert.deepEqual(balance?.balances.map(b => b.currency), ['CNY', 'USD'])
  })

  test('a platform total that disagrees with its parts is not used', () => {
    const balance = balanceOfPayload({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '940.67', granted_balance: '920.85', topped_up_balance: '19.81' },
      ],
    })
    assert.deepEqual(balance?.balances, [{ currency: 'CNY', total: 940.66, granted: 920.85, toppedUp: 19.81 }])
    // The parts are what prove the entry, so a total the platform gets wrong
    // (or omits) never drops it: total_balance is not read at all.
    for (const totalField of [{}, { total_balance: 'abc' }, { total_balance: '-1' }, { total_balance: null }]) {
      assert.deepEqual(balanceOfPayload({
        is_available: true,
        balance_infos: [{ currency: 'CNY', granted_balance: '10.00', topped_up_balance: '100.00', ...totalField }],
      })?.balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }])
    }
    // Without both parts there is no total to derive, whatever total_balance says.
    assert.equal(balanceOfPayload({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
    }), null)
  })

  test('a hostile entry object drops without throwing', () => {
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    assert.equal(balanceOfPayload({ is_available: true, balance_infos: [hostile] }), null)
  })
})

describe('balance reads', () => {
  test('every read goes to the platform — no answer is remembered', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    const { calls } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    await serve(captured)
    vi.setSystemTime(1_000_000 + 4 * 60_000)
    const settled = await serve(captured)
    assert.equal(calls(), 3, 'the account moves with every billed request, so no read is served from a cache')
    assert.deepEqual(settled, { ok: true, value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] } })
  })

  test('a failing read is not remembered either — the next read retries at once', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    let fails = 0
    setBalanceFetcher(async () => {
      fails++
      throw new Error('down')
    })
    await serve(captured)
    await serve(captured)
    assert.equal(fails, 2)
    assert.deepEqual(await serve(captured), { ok: true, value: null })
  })

  test('clearing the seam restores the default fetcher over the real global fetch', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    setBalanceFetcher(async () => {
      throw new Error('bypassed')
    })
    setBalanceFetcher(null)
    const seen: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      seen.push(String(url))
      return { ok: true, json: async () => CNY_BALANCE } as unknown as Response
    })
    const reply = await serve(captured)
    assert.deepEqual(seen, ['https://api.deepseek.com/user/balance'])
    assert.deepEqual(reply, {
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] },
    })
    vi.unstubAllGlobals()
  })

  test('concurrent identical reads share the one in-flight platform fetch', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    let entries = 0
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    setBalanceFetcher(async () => {
      entries++
      await gate
      return { ok: true, json: async () => CNY_BALANCE } as unknown as Response
    })
    const first = serve(captured)
    const second = serve(captured)
    await Promise.resolve()
    release()
    const [a, b] = await Promise.all([first, second])
    assert.deepEqual(a, b)
    assert.equal(entries, 1)
  })
})
