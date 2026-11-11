import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { BALANCE_ROUTE, balanceOfPayload, resetBalance, setBalanceFetcher, watchBalanceChannel } from '../../src/host/balance'
import { fakeCtx, responseJson, type FakeCtx, type FakeRoute } from './helpers/ctx'
import { estimateAnswerTokens, estimateCallTokens, estimateMessage, estimateReasoningTokens, estimateToolSchema, estimateToolsTotal, firstText, imageCountOf, injectionSourceName, isInjection, toolCallNames, type ContentBlock } from '../../src/host/pricing'
import { createCostSource, withCost, withDetailCost } from '../../src/host/cost'
import { type CatalogService } from '../../src/host/catalog'
import { pricesBookOf, type ModelBook } from '../../src/shared/pricing'
import { type SessionCostUsage } from '../../src/shared/types'

describe('balance', () => {

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

describe('balance reads across credentials', () => {
  test('concurrent reads with different credentials never share one in-flight fetch', async () => {
    const alpha = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsOf({ apiKeyEnv: 'ALPHA_KEY' }),
      credentials: credentialsOf('sk-alpha'),
    })
    const beta = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      settings: settingsOf({ apiKeyEnv: 'BETA_KEY' }),
      credentials: credentialsOf('sk-beta'),
    })
    watchBalanceChannel(alpha.ctx)
    watchBalanceChannel(beta.ctx)
    const log: { url: string; auth: string }[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    setBalanceFetcher(async (url, init) => {
      const headers = (init.headers ?? {}) as Record<string, string>
      log.push({ url, auth: headers.authorization })
      await gate
      const body = headers.authorization.includes('alpha')
        ? { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '1.00', granted_balance: '1.00', topped_up_balance: '0.00' }] }
        : { is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '2.00', granted_balance: '2.00', topped_up_balance: '0.00' }] }
      return { ok: true, status: 200, json: async () => body } as unknown as Response
    })
    const a = serve(alpha.captured)
    await Promise.resolve()
    const b = serve(beta.captured)
    await Promise.resolve()
    release()
    const [x, y] = await Promise.all([a, b])
    assert.equal(log.length, 2, 'each credential fetches its own balance')
    assert.equal(log[1]?.auth, 'Bearer sk-beta', 'the second read carries its own key instead of joining the first')
    assert.notDeepEqual(x, y, 'the answers report their own accounts')
    assert.equal((x.value as { balances: { total: number }[] }).balances[0]?.total, 1)
    assert.equal((y.value as { balances: { total: number }[] }).balances[0]?.total, 2)
  })
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
})

describe('pricing', () => {

describe('estimateToolsTotal', () => {
  test('an empty tool list prices zero; a non-empty one prices the whole-array JSON plus one block', () => {
    assert.equal(estimateToolsTotal([]), 0)
    const tools = [{ name: 'bash', description: 'run a command' }]
    assert.equal(estimateToolsTotal(tools), Math.ceil(JSON.stringify(tools).length / 4) + 4)
  })
})

describe('estimateReasoningTokens', () => {
  test('only reasoning blocks price; a missing array, junk members, and other arms contribute nothing', () => {
    assert.equal(estimateReasoningTokens(undefined), 0)
    assert.equal(estimateReasoningTokens('x'), 0)
    assert.equal(estimateReasoningTokens([null, 7, { type: 'text', text: '0123456789abcdef' }]), 0)
    assert.equal(estimateReasoningTokens([{ type: 'reasoning', text: '0123456789abcdef' }]), 8)
    assert.equal(estimateReasoningTokens([{ type: 'reasoning' }]), 4, 'an empty reasoning block is overhead only')
  })
})

describe('estimateAnswerTokens', () => {
  test('only text blocks price; a missing array, junk members, and other arms contribute nothing', () => {
    assert.equal(estimateAnswerTokens(undefined), 0)
    assert.equal(estimateAnswerTokens('x'), 0)
    assert.equal(estimateAnswerTokens([null, 7, { type: 'reasoning', text: '0123456789abcdef' }]), 0)
    assert.equal(estimateAnswerTokens([{ type: 'text', text: '0123456789abcdef' }]), 8)
    assert.equal(estimateAnswerTokens([{ type: 'text' }]), 4, 'an empty text block is overhead only')
    assert.equal(estimateAnswerTokens([
      { type: 'text', text: 'hello' },
      { type: 'text', text: 'world' },
      { type: 'tool-call', name: 'bash', arguments: '{}' },
    ]), 12, 'two 5-char blocks at 2 + 4 each')
  })
})

describe('estimateCallTokens', () => {
  test('only tool-call blocks price: the name, the arguments and one block overhead', () => {
    assert.equal(estimateCallTokens(undefined), 0)
    assert.equal(estimateCallTokens('x'), 0)
    assert.equal(estimateCallTokens([null, 7, { type: 'text', text: '0123456789abcdef' }]), 0)
    assert.equal(estimateCallTokens([{ type: 'tool-call', name: 'bash', arguments: '{}' }]), 6)
    assert.equal(estimateCallTokens([{ type: 'tool-call' }]), 4)
  })
})

describe('estimateMessage', () => {
  test('text, reasoning, tool-call, retired wrapper and unknown blocks price their own arm plus block and role overhead', () => {
    assert.equal(estimateMessage({ content: [{ type: 'text', text: '0123456789abcdef' }] }), 12)
    assert.equal(estimateMessage({ content: [{ type: 'reasoning', text: '0123456789abcdef' }] }), 12)
    assert.equal(estimateMessage({ content: [{ type: 'text' }] }), 8, 'a text block with no text is overhead only')
    assert.equal(estimateMessage({ content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }] }), 10)
    assert.equal(estimateMessage({ content: [{ type: 'tool-call' }] }), 8)
    for (const block of [
      { type: 'tool-result', content: [{ type: 'text', text: 'ok' }] },
      { type: 'mystery', payload: { a: 1 } },
    ]) {
      assert.equal(estimateMessage({ content: [block] }), 4 + Math.ceil(JSON.stringify(block).length / 4) + 4)
    }
  })

  test('image blocks price through the vision calculator only with two finite dimensions', () => {
    assert.equal(
      estimateMessage({ content: [{ type: 'image', attachment: { width: 800, height: 600 } }] }),
      317 + 8,
    )
    for (const attachment of [null, 'ref', { width: 800 }, { width: NaN, height: 100 }]) {
      const block = { type: 'image', attachment } as unknown as ContentBlock
      assert.equal(estimateMessage({ content: [block] }), Math.ceil(JSON.stringify(block).length / 4) + 8, JSON.stringify(attachment))
    }
  })

  test('a message without an array content pays role framing only; emptyIsZero short-circuits empties to zero', () => {
    assert.equal(estimateMessage({}), 4)
    assert.equal(estimateMessage({ content: 'not-an-array' as never }), 4)
    assert.equal(estimateMessage(null), 4)
    assert.equal(estimateMessage(undefined), 4)
    assert.equal(estimateMessage(null, true), 0)
    assert.equal(estimateMessage(undefined, true), 0)
    assert.equal(estimateMessage({}, true), 0)
    assert.equal(estimateMessage({ content: [] }, true), 0)
    assert.equal(estimateMessage({ content: 'x' as never }, true), 0)
    assert.equal(estimateMessage({ content: [{ type: 'text', text: 'abcd' }] }, true), 9)
  })
})

describe('estimateToolSchema', () => {
  test('prices the tool JSON plus one block', () => {
    const tool = { name: 'bash' }
    assert.equal(estimateToolSchema(tool), Math.ceil(JSON.stringify(tool).length / 4) + 4)
  })
})

describe('imageCountOf', () => {
  test('counts image blocks, recursing into nested content; non-array input counts zero', () => {
    assert.equal(imageCountOf([
      { type: 'image' },
      { type: 'tool-result', content: [{ type: 'image' }, { type: 'text', text: 'x' }] },
      { type: 'text', text: 'y' },
    ]), 2)
    assert.equal(imageCountOf(undefined), 0)
    assert.equal(imageCountOf('x' as never), 0)
  })
})

describe('firstText', () => {
  test('returns the first non-blank text block, whitespace-normalized and truncated to 80', () => {
    const long = 'word '.repeat(30)
    const out = firstText([{ type: 'text', text: long }])
    assert.equal(out.length, 80)
    assert.ok(!out.includes('  '))
  })

  test('skips non-text blocks, non-string text, and whitespace-only text; non-array input yields empty', () => {
    assert.equal(firstText([
      { type: 'image' },
      { type: 'text' },
      { type: 'text', text: '   \n\t ' },
      { type: 'text', text: '  real   text ' },
    ]), 'real text')
    assert.equal(firstText(undefined), '')
    assert.equal(firstText(null as never), '')
  })
})

describe('toolCallNames', () => {
  test('collects tool-call block names in order; non-array input yields an empty list', () => {
    assert.deepEqual(toolCallNames([
      { type: 'tool-call', name: 'bash' },
      { type: 'text', text: 'x' },
      { type: 'tool-call', name: 'read' },
      { type: 'tool-call' },
    ]), ['bash', 'read'])
    assert.deepEqual(toolCallNames(undefined), [])
  })
})

describe('injectionSourceName', () => {
  test('agent-instructions sources name their deduped change paths; plugin ids, kinds, and unreadable sources degrade', () => {
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }, { path: 'docs/TEAM.md' }],
    }), 'AGENTS.md, docs/TEAM.md')
    assert.equal(injectionSourceName({
      kind: 'agent-instructions',
      changes: [null, { path: '' }, { path: 'A.md' }],
    }), 'A.md')
    for (const source of [
      { kind: 'agent-instructions', changes: [null] },
      { kind: 'agent-instructions', changes: [] },
      { kind: 'agent-instructions' },
    ]) {
      assert.equal(injectionSourceName(source), 'agent-instructions')
    }
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: 'dsh-agent-presets' }), 'dsh-agent-presets')
    assert.equal(injectionSourceName({ kind: 'plugin', plugin: '' }), 'plugin')
    assert.equal(injectionSourceName({ kind: 'goal' }), 'goal')
    assert.equal(injectionSourceName({ kind: '' }), '')
    assert.equal(injectionSourceName({}), '')
    assert.equal(injectionSourceName(undefined), '', 'a missing source degrades to empty instead of throwing (issue #69)')
    assert.equal(injectionSourceName(null), '')
  })
})

describe('isInjection', () => {
  test('any non-user kind or a transport form marks an injection; null and plain user sources do not', () => {
    assert.equal(isInjection(null), false)
    assert.equal(isInjection(undefined), false)
    assert.equal(isInjection({ kind: 'user' }), false)
    assert.equal(isInjection({ kind: '' }), false)
    assert.equal(isInjection({}), false)
    assert.equal(isInjection({ kind: 'plugin', form: 'notice' }), true)
    assert.equal(isInjection({ kind: 'user', form: 'rpc' }), true)
    assert.equal(isInjection({ form: 'notice' }), true)
  })
})

describe('hostile block shapes', () => {
  test('null and primitive elements degrade to overhead instead of throwing', () => {
    const junk = [null, 7, 'x'] as never
    assert.ok(estimateMessage({ content: junk }) > 0)
    assert.equal(imageCountOf(junk), 0)
    assert.equal(firstText(junk), '')
    assert.deepEqual(toolCallNames(junk), [])
    const nested = [{ type: 'tool-result', content: [null, { type: 'image' }] }] as never
    assert.equal(imageCountOf(nested), 1)
    assert.ok(estimateMessage({ content: nested }) > 0)
  })
})
})

describe('cost', () => {

const USING = {
  deepseek: {
    'deepseek-v4-flash': {
      peak: { uncached: 1_000_000, cacheRead: 1_000_000, cacheWrite: 0, output: 1_000_000 },
      off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 1_000_000 },
    },
  },
} satisfies SessionCostUsage

const BOOK_PAYLOAD = {
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
  mystery: {
    models: {
      unknown: { cost: { input: 1, output: 2 } },
    },
  },
}

function bookOf(): ModelBook {
  const book = pricesBookOf(BOOK_PAYLOAD)
  assert.ok(book !== null)
  return book
}

function catalogOf(book: ModelBook | null, current: string | undefined = '0.82.2'): CatalogService {
  return {
    ensure: () => {},
    book: () => book,
    pricesVersion: () => 0,
    version: async () => ({ value: null, ready: false, failed: false, checkedAt: 0 }),
    prices: async () => ({ value: null, ready: book !== null, failed: false, checkedAt: 0 }),
    currentVersion: () => current,
    dispose: () => {},
  }
}

describe('host cost source', () => {
  test('returns undefined for an absent usage and a pending read before the catalog is ready', () => {
    const cost = createCostSource(catalogOf(null))
    assert.equal(cost.read(undefined), undefined)
    assert.equal(cost.read(null), undefined)
    assert.deepEqual(cost.read(USING), { usd: null, ready: false })
    assert.equal(cost.usd(USING), null)
    assert.equal(cost.usd(null), null)
    assert.equal(cost.ready(), false)
  })

  test('computes USD with the DeepSeek peak factor and resolves price faces', () => {
    const cost = createCostSource(catalogOf(bookOf()))
    assert.equal(cost.ready(), true)
    const read = cost.read(USING)
    assert.ok(read !== undefined)
    assert.equal(read.ready, true)
    const peak = (0.15 + 0.003 + 0.6) * 2
    const off = 0.15 + 0.6
    assert.ok(Math.abs((read.usd ?? 0) - (peak + off)) < 1e-9)
    assert.deepEqual(read.faces?.map(face => [face.provider, face.model, face.via, face.confidence]), [
      ['deepseek', 'deepseek-v4-flash', 'direct', 'high'],
    ])
    assert.equal(read.misses, undefined)
    assert.ok(Math.abs((cost.usd(USING) ?? 0) - (peak + off)) < 1e-9)
  })

  test('reports unpriced models as misses and an empty usage without money', () => {
    const cost = createCostSource(catalogOf(bookOf()))
    const read = cost.read({
      ghost: { phantom: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
    assert.ok(read !== undefined)
    assert.equal(read.usd, null)
    assert.equal(read.faces, undefined)
    assert.deepEqual(read.misses?.map(miss => miss.provider), ['ghost'])
    const empty = cost.read({})
    assert.ok(empty !== undefined)
    assert.equal(empty.usd, null)
    assert.equal(empty.ready, true)
    assert.equal(empty.faces, undefined)
    assert.equal(empty.misses, undefined)
  })

  test('resolves a face without a canonical id and reports ambiguous candidates', () => {
    const plain = createCostSource(catalogOf(bookOf()))
    const read = plain.read({
      mystery: { unknown: { peak: { uncached: 2, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
    assert.ok(read !== undefined)
    assert.equal(read.faces?.[0].canonical, undefined)
    assert.ok((read.usd ?? 0) > 0)
    const ambiguousBook = pricesBookOf({
      alpha: { models: { shared: { cost: { input: 1, output: 2 } } } },
      beta: { models: { shared: { cost: { input: 3, output: 4 } } } },
    })
    assert.ok(ambiguousBook !== null)
    const ambiguous = createCostSource(catalogOf(ambiguousBook)).read({
      zzz: { shared: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
    assert.ok(ambiguous !== undefined)
    assert.equal(ambiguous.usd, null)
    assert.deepEqual(ambiguous.misses?.map(miss => [miss.reason, miss.candidates]), [['ambiguous', 2]])
  })

  test('adds costRead to timeline-shaped values only when a usage exists', () => {
    const cost = createCostSource(catalogOf(bookOf()))
    const plain = { ok: true }
    assert.equal(withCost(undefined, plain), plain)
    assert.equal(withCost(cost, plain), plain)
    const timeline = { ok: true, cost: USING }
    const priced = withCost(cost, timeline)
    assert.notEqual(priced, timeline)
    assert.equal(priced.costRead?.ready, true)
    assert.ok(typeof priced.costRead?.usd === 'number')
  })

  test('wraps detail heads with host cost and passes unusable details through', () => {
    const cost = createCostSource(catalogOf(bookOf()))
    const untouched = { rev: 1 }
    assert.deepEqual(withDetailCost(undefined, untouched), untouched)
    const bare = { rev: 1 }
    assert.equal(withDetailCost(cost, bare), bare)
    const detail = { rev: 2, head: { ok: true, cost: USING } }
    const wrapped = withDetailCost(cost, detail)
    assert.notEqual(wrapped, detail)
    assert.equal(wrapped.head.costRead?.ready, true)
  })
})

describe('host cost source plumbing', () => {
  test('every cost read ensures the catalogue and exposes its price version', () => {
    let ensures = 0
    let version = 0
    const base = catalogOf(bookOf())
    const cost = createCostSource({
      ...base,
      ensure: () => { ensures += 1 },
      pricesVersion: () => version,
    })
    assert.equal(cost.version?.(), 0)
    const read = cost.read(USING)
    assert.equal(read?.ready, true)
    assert.equal(ensures, 1, 'a ready book still asks for the TTL refresh check')
    cost.usd(USING)
    assert.equal(ensures, 2)
    version = 7
    assert.equal(cost.version?.(), 7)
  })
})
})
