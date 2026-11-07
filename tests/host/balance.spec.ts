import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { BALANCE_ROUTE, balanceOfPayload, resetBalance, setBalanceFetcher, watchBalanceChannel } from '../../src/host/balance'
import { fakeCtx, responseJson } from './helpers/ctx'
import type { FakeCtx, FakeRoute } from './helpers/ctx'

interface CtxSpec {
  connection?: unknown
  settings?: unknown
  credentials?: unknown
  llm?: unknown
}

const ctxOf = (spec: CtxSpec): FakeCtx => fakeCtx(spec)

const serve = (captured: FakeRoute): Promise<Record<string, unknown>> => responseJson(captured)

function settingsDescribeOf(rows: unknown, throws = false): { describe(options?: { redactSecrets?: boolean }): unknown; options: unknown[] } {
  const options: unknown[] = []
  return {
    options,
    describe(opts) {
      options.push(opts)
      if (throws) throw new Error('hostile describe')
      return rows
    },
  }
}

function settingsOf(section: unknown): { describe(options?: { redactSecrets?: boolean }): unknown; options: unknown[] } {
  return settingsDescribeOf([{ ns: 'llm-deepseek', value: section }])
}

function llmDirectoryOf(settingsNs: string, extra: unknown[] = []): { listConfigurableProviders(): unknown } {
  return {
    listConfigurableProviders: () => [
      { provider: 'deepseek-account', displayName: 'DeepSeek Account', settingsNs: 'llm-deepseek-account', settingsPath: [] },
      { provider: 'deepseek-official', displayName: 'DeepSeek', settingsNs, settingsPath: [] },
      ...extra,
    ],
  }
}

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

function configuredCtx(spec: CtxSpec = {}): CtxSpec {
  return {
    connection: { fetch: { register: () => () => {} } },
    settings: settingsOf({ apiKeyEnv: 'DEEPSEEK_API_KEY' }),
    credentials: credentialsOf('sk-test'),
    ...spec,
  }
}

interface FetchLog { url?: string; auth?: string; accept?: string }

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
  test('only a usable connection registry mounts the route; absent and rejecting registries leave it unregistered', () => {
    for (const connection of [undefined, {}, { fetch: { register: 42 } }]) {
      const { ctx, captured } = ctxOf(configuredCtx({ connection }))
      watchBalanceChannel(ctx)
      assert.equal(captured.fetch, undefined)
    }
    const { ctx, captured } = ctxOf(configuredCtx({
      connection: { fetch: { register: () => { throw new Error('hostile registry') } } },
    }))
    assert.doesNotThrow(() => watchBalanceChannel(ctx))
    assert.equal(captured.fetch, undefined)

    const mounted = ctxOf(configuredCtx())
    watchBalanceChannel(mounted.ctx)
    assert.equal(mounted.captured.path, BALANCE_ROUTE)
    for (const dispose of mounted.disposers) dispose()
    assert.equal(mounted.captured.fetch, undefined, 'the disposer withdraws the route')
  })
})

describe('balance route outcomes', () => {
  test('the configured platform serves the redacted balance through the public API defaults; numeric and unavailable variants pass through', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsOf({ apiKeyEnv: 'DEEPSEEK_API_KEY' }),
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
    resetBalance()
    const numeric = ctxOf(configuredCtx())
    watchBalanceChannel(numeric.ctx)
    stubPlatform({
      is_available: false,
      balance_infos: [{ currency: 'USD', total_balance: 0.5, granted_balance: 0, topped_up_balance: 0.5 }],
    })
    assert.deepEqual(await serve(numeric.captured), {
      ok: true,
      value: { isAvailable: false, balances: [{ currency: 'USD', total: 0.5, granted: 0, toppedUp: 0.5 }] },
    })
  })

  test('the section\'s credential ref and endpoint override win, only the origin counts', async () => {
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

  test('every not-configured shape serves a typed null without touching the platform', async () => {
    const absent: CtxSpec[] = [
      configuredCtx({ settings: undefined }),
      configuredCtx({ settings: {} }),
      configuredCtx({ settings: { describe: 'nope' } }),
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

describe('provider directory (the llm service)', () => {
  test('the provider directory names the DeepSeek row, whatever the entry is called, and the stock id serves', async () => {
    const refs: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      llm: llmDirectoryOf('my-deepseek'),
      settings: settingsDescribeOf([
        { ns: 'ui-theme', value: { preference: 'light' } },
        { ns: 'my-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'enabled' } },
        { ns: 'llm-pi-ai', value: { providers: { tokener: { apiKeyEnv: 'TOKENER_API_KEY' } } } },
      ]),
      credentials: credentialsOf('sk-v4', refs),
    })
    watchBalanceChannel(ctx)
    const { log } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
    assert.equal(log[0]?.url, 'https://api.deepseek.com/user/balance')
    assert.equal(log[0]?.auth, 'Bearer sk-v4')

    const stockRefs: string[] = []
    const stock = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      llm: llmDirectoryOf('llm-deepseek'),
      settings: settingsDescribeOf([{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]),
      credentials: credentialsOf('sk-stock', stockRefs),
    })
    watchBalanceChannel(stock.ctx)
    const stockFetch = stubPlatform(CNY_BALANCE)
    await serve(stock.captured)
    assert.deepEqual(stockRefs, ['DEEPSEEK_API_KEY'], 'the stock id the directory names serves too')
    assert.equal(stockFetch.log[0]?.url, 'https://api.deepseek.com/user/balance')
  })

  test('every broken provider directory leaves the stock ids serving', async () => {
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    const directories: unknown[] = [
      { listConfigurableProviders: () => { throw new Error('hostile directory') } },
      { listConfigurableProviders: 'not a function' },
      { listConfigurableProviders: () => 'not a list' },
      { listConfigurableProviders: () => [null, 'entry', 42] },
      { listConfigurableProviders: () => [{ provider: 'deepseek-official' }] },
      { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: 42 }] },
      { listConfigurableProviders: () => [{ provider: 'deepseek-official', settingsNs: '' }] },
      { listConfigurableProviders: () => [hostile] },
    ]
    for (const llm of directories) {
      resetBalance()
      const refs: string[] = []
      const { ctx, captured } = ctxOf({
        connection: { fetch: { register: () => () => {} } },
        llm,
        settings: settingsDescribeOf([{ ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]),
        credentials: credentialsOf('sk-stock', refs),
      })
      watchBalanceChannel(ctx)
      const { log } = stubPlatform(CNY_BALANCE)
      await serve(captured)
      assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
      assert.equal(log[0]?.url, 'https://api.deepseek.com/user/balance')
    }
  })
})

describe('settings face (the Config-form projection)', () => {
  test('the projection is read redacted, so a row\'s literal key never enters the fold', async () => {
    const settings = settingsOf({ apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: 'sk-literal' })
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings,
      credentials: credentialsOf('sk-test'),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(settings.options, [{ redactSecrets: true }])
  })

  test('rows are selected by the DeepSeek id: another provider is never read, and the first same-id row wins', async () => {
    const refs: string[] = []
    const other = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'renamed-a', value: { apiKeyEnv: 'FIRST_KEY' } },
        { ns: 'renamed-b', value: { apiKeyEnv: 'SECOND_KEY' } },
        { ns: 'llm-pi-ai', value: { providers: { tokener: { apiKeyEnv: 'TOKENER_KEY' } } } },
      ]),
      credentials: credentialsOf('sk-shape', refs),
    })
    watchBalanceChannel(other.ctx)
    const otherFetch = stubPlatform(CNY_BALANCE)
    assert.deepEqual(await serve(other.captured), { ok: true, value: null })
    assert.deepEqual(refs, [])
    assert.equal(otherFetch.calls(), 0)

    resetBalance()
    const winners: string[] = []
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 42, value: { apiKeyEnv: 'NO_ID_KEY' } },
        { ns: 'some-provider', value: { apiKeyEnv: 'OTHER_KEY' } },
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'PRODUCT_KEY' } },
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'SECOND_KEY' } },
      ]),
      credentials: credentialsOf('sk-product', winners),
    })
    watchBalanceChannel(ctx)
    stubPlatform(CNY_BALANCE)
    await serve(captured)
    assert.deepEqual(winners, ['PRODUCT_KEY'], 'the DeepSeek row wins; its first occurrence names the credential ref')
  })

  test('a missing credential ref or an unresolved key means no request at all', async () => {
    const unresolvedRefs: string[] = []
    const unresolved = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
        { ns: 'web-deepseek-api', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } },
      ]),
      credentials: credentialsOf(undefined, unresolvedRefs),
    })
    watchBalanceChannel(unresolved.ctx)
    const unresolvedFetch = stubPlatform(CNY_BALANCE)
    assert.deepEqual(await serve(unresolved.captured), { ok: true, value: null })
    assert.deepEqual(unresolvedRefs, ['DEEPSEEK_API_KEY'], 'the shared credential ref is read once, not once per row')
    assert.equal(unresolvedFetch.calls(), 0)

    const refs: string[] = []
    const refLess = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([{ ns: 'llm-deepseek', value: { baseURL: 'https://api.deepseek.com' } }]),
      credentials: credentialsOf('sk-test', refs),
    })
    watchBalanceChannel(refLess.ctx)
    const refLessFetch = stubPlatform(CNY_BALANCE)
    assert.deepEqual(await serve(refLess.captured), { ok: true, value: null })
    assert.deepEqual(refs, [])
    assert.equal(refLessFetch.calls(), 0)
  })

  test('only the endpoint origin counts: a path-carrying row collapses, non-HTTP(S) overrides fall back to the platform root', async () => {
    resetBalance()
    const refs: string[] = []
    const web = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([
        { ns: 'web-deepseek-api', value: { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1/tools' } },
      ]),
      credentials: credentialsOf('sk-web', refs),
    })
    watchBalanceChannel(web.ctx)
    const webFetch = stubPlatform(CNY_BALANCE)
    await serve(web.captured)
    assert.deepEqual(refs, ['DEEPSEEK_API_KEY'])
    assert.equal(webFetch.log[0]?.url, 'https://api.deepseek.com/user/balance')
    for (const baseURL of ['not a url', 'file:///tmp/dsh', 'ftp://api.deepseek.com/v1']) {
      resetBalance()
      const { ctx, captured } = ctxOf({
        connection: { fetch: { register: () => () => {} } },
        settings: settingsOf({ apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL }),
        credentials: credentialsOf('sk-test'),
      })
      watchBalanceChannel(ctx)
      const { log } = stubPlatform(CNY_BALANCE)
      await serve(captured)
      assert.equal(log[0]?.url, 'https://api.deepseek.com/user/balance', baseURL)
    }
  })

  test('broken describe shapes and a hostile row serve a typed null without touching the platform; a valid sibling survives', async () => {
    const faces: unknown[] = [
      settingsDescribeOf('not an array'),
      settingsDescribeOf(null),
      settingsDescribeOf([]),
      settingsDescribeOf([null, 'row', 42, [], {}]),
      settingsDescribeOf([{ value: null }, { ns: 'llm-deepseek' }, { value: 'section' }]),
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
    resetBalance()
    const refs: string[] = []
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsDescribeOf([hostile, { ns: 'llm-deepseek', value: { apiKeyEnv: 'DEEPSEEK_API_KEY' } }]),
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
  test('multiple currencies keep their entries in order; a platform total that disagrees with its parts is not used', () => {
    const balance = balanceOfPayload({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
        { currency: 'USD', total_balance: '1.00', granted_balance: '0.00', topped_up_balance: '1.00' },
      ],
    })
    assert.deepEqual(balance?.balances.map(b => b.currency), ['CNY', 'USD'])
    const disagreed = balanceOfPayload({
      is_available: true,
      balance_infos: [
        { currency: 'CNY', total_balance: '940.67', granted_balance: '920.85', topped_up_balance: '19.81' },
      ],
    })
    assert.deepEqual(disagreed?.balances, [{ currency: 'CNY', total: 940.66, granted: 920.85, toppedUp: 19.81 }])
    for (const totalField of [{}, { total_balance: 'abc' }, { total_balance: '-1' }, { total_balance: null }]) {
      assert.deepEqual(balanceOfPayload({
        is_available: true,
        balance_infos: [{ currency: 'CNY', granted_balance: '10.00', topped_up_balance: '100.00', ...totalField }],
      })?.balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }])
    }
    assert.equal(balanceOfPayload({
      is_available: true,
      balance_infos: [{ currency: 'CNY', total_balance: '110.00' }],
    }), null)
  })
})

describe('balance reads', () => {
  test('no read is remembered — every call reaches the platform, and a failure retries at once', async () => {
    const { ctx, captured } = ctxOf(configuredCtx())
    watchBalanceChannel(ctx)
    const { calls } = stubPlatform(CNY_BALANCE)
    await serve(captured)
    await serve(captured)
    vi.setSystemTime(1_000_000 + 4 * 60_000)
    const settled = await serve(captured)
    assert.equal(calls(), 3, 'the account moves with every billed request, so no read is served from a cache')
    assert.deepEqual(settled, { ok: true, value: { isAvailable: true, balances: [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }] } })
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
