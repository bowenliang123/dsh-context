import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { createCatalogService, type CatalogFetcher } from '../../src/host/catalog'

const PRICES = {
  deepseek: {
    models: {
      'deepseek-v4-flash': {
        cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15 },
        canonical_model_id: 'deepseek/deepseek-v4-flash',
      },
    },
  },
}

import { readFileSync } from 'node:fs'

interface FetchCall { url: string }

function fetcherOf(
  routes: readonly { match: (url: string) => boolean; body?: unknown; status?: number; reject?: boolean }[],
  calls: FetchCall[] = [],
): CatalogFetcher {
  return (url) => {
    calls.push({ url })
    const route = routes.find(candidate => candidate.match(url))
    if (route === undefined) return Promise.reject(new Error('unexpected ' + url))
    if (route.reject === true) return Promise.reject(new Error('down'))
    return Promise.resolve({
      ok: (route.status ?? 200) === 200,
      status: route.status ?? 200,
      json: async () => route.body,
    } as unknown as Response)
  }
}

function catalogOf(routes: readonly { match: (url: string) => boolean; body?: unknown; status?: number; reject?: boolean }[], extra: {
  now?: () => number
  currentVersion?: string
  calls?: FetchCall[]
} = {}) {
  const calls: FetchCall[] = extra.calls ?? []
  return {
    calls,
    service: createCatalogService({
      fetch: fetcherOf(routes, calls),
      now: extra.now,
      currentVersion: extra.currentVersion ?? '0.82.2',
    }),
  }
}

const isVersionUrl = (url: string): boolean => url.includes('registry.npmjs.org') || url.includes('registry.npmmirror.com')
const isPricesUrl = (url: string): boolean => url === 'https://models.dev/api.json'

describe('catalog service', () => {
  test('serves the npm latest version, falling back to the mirror and caching for the TTL', async () => {
    let clock = 1_000
    const calls: FetchCall[] = []
    const { service } = catalogOf([
      { match: url => url.includes('registry.npmjs.org'), body: { version: '' } },
      { match: url => url.includes('registry.npmmirror.com'), body: { version: '0.83.0' } },
    ], { calls, now: () => clock })
    assert.equal(service.currentVersion(), '0.82.2')
    const first = await service.version()
    assert.deepEqual(first, { value: '0.83.0', ready: true, failed: false, checkedAt: 1_000 })
    assert.equal(calls.length, 2)
    const cached = await service.version()
    assert.equal(cached.value, '0.83.0')
    assert.equal(calls.length, 2)
    clock += 60 * 60 * 1000
    await service.version()
    assert.equal(calls.length, 4)
  })

  test('reports a failed version check when every registry fails or answers garbage', async () => {
    const { service, calls } = catalogOf([
      { match: isVersionUrl, reject: true },
    ])
    const read = await service.version()
    assert.deepEqual(read, { value: null, ready: false, failed: true, checkedAt: read.checkedAt })
    assert.equal(calls.length, 2)
    const retry = await service.version()
    assert.equal(retry.failed, true)
    assert.equal(calls.length, 2, 'a failed check is cached until the TTL')
    const garbage = catalogOf([{ match: isVersionUrl, body: { version: 7 } }]).service
    assert.equal((await garbage.version()).failed, true)
  })

  test('coalesces concurrent version checks into one fetch pair', async () => {
    const { service, calls } = catalogOf([
      { match: isVersionUrl, body: { version: '0.83.1' } },
    ])
    const [a, b] = await Promise.all([service.version(), service.version()])
    assert.equal(a.value, '0.83.1')
    assert.equal(b.value, '0.83.1')
    assert.equal(calls.length, 1)
  })

  test('parses the models.dev catalog into a compact price book once', async () => {
    let clock = 5_000
    const { service, calls } = catalogOf([
      { match: isPricesUrl, body: PRICES },
    ], { now: () => clock })
    assert.equal(service.book(), null)
    const read = await service.prices()
    assert.equal(read.ready, true)
    assert.equal(read.failed, false)
    const book = service.book()
    assert.ok(book !== null)
    assert.equal(book.prices.deepseek['deepseek-v4-flash'].miss, 0.15)
    assert.equal(book.index.byModel.get('deepseek-v4-flash')?.[0]?.rate.out, 0.6)
    const again = await service.prices()
    assert.equal(again.ready, true)
    assert.equal(calls.length, 1)
    clock += 60 * 60 * 1000
    await service.prices()
    assert.equal(calls.length, 2)
  })

  test('degrades a malformed or unreachable price catalog without throwing', async () => {
    const malformed = catalogOf([{ match: isPricesUrl, body: [1, 2, 3] }], { now: () => 0 }).service
    assert.deepEqual(await malformed.prices(), { value: null, ready: false, failed: true, checkedAt: 0 })
    assert.equal(malformed.book(), null)
    const rejected = catalogOf([{ match: isPricesUrl, reject: true }]).service
    const read = await rejected.prices()
    assert.equal(read.ready, false)
    assert.equal(read.failed, true)
    assert.equal(read.ready, false)
  })

  test('dispose stops later reads from serving a book', async () => {
    const { service } = catalogOf([{ match: isPricesUrl, body: PRICES }])
    await service.prices()
    assert.ok(service.book() !== null)
    service.dispose()
    assert.equal(service.book(), null)
    await service.ensure()
    assert.equal(service.book(), null)
  })

  test('a non-ok registry response counts as a failed check', async () => {
    const { service } = catalogOf([{ match: isVersionUrl, status: 500 }])
    const read = await service.version()
    assert.equal(read.ready, false)
    assert.equal(read.failed, true)
  })
})

describe('catalog defaults', () => {
  test('defaults its fetch to the global one, and ensure() only kicks the price fetch', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (url: string | URL) => {
      calls.push(String(url))
      return { ok: true, status: 200, json: async () => PRICES } as unknown as Response
    })
    try {
      const service = createCatalogService({ currentVersion: '0.82.2' })
      assert.equal(service.book(), null)
      service.ensure()
      const read = await service.prices()
      assert.equal(read.ready, true)
      assert.ok(service.book() !== null, 'the price fetch lands in the book')
      assert.deepEqual(calls, ['https://models.dev/api.json'], 'ensure never checks the registry')
      service.dispose()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('reads the plugin version from its own package manifest when no override is injected', async () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }
    const service = createCatalogService({
      fetch: fetcherOf([{ match: isVersionUrl, body: { version: '0.90.0' } }]),
    })
    assert.equal(service.currentVersion(), pkg.version)
    assert.equal((await service.version()).value, '0.90.0')
  })
})

describe('catalog refresh and failure backoff', () => {
  test('a stale price book refreshes after the TTL and bumps the prices version', async () => {
    let clock = 1_000
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => clock })
    await service.prices()
    assert.equal(calls.length, 1)
    assert.equal(service.pricesVersion(), 1, 'the first successful book is version one')
    clock += 60 * 60 * 1000
    await service.prices()
    assert.equal(calls.length, 2, 'the TTL expiry refetches the catalogue')
    assert.equal(service.pricesVersion(), 2, 'a refreshed book bumps the version so revisions move')
  })

  test('a failed price fetch backs off before the next attempt and then retries', async () => {
    let clock = 1_000
    const calls: FetchCall[] = []
    const { service } = catalogOf([{ match: isPricesUrl, reject: true }], { now: () => clock, calls })
    await service.prices()
    assert.equal(calls.length, 1)
    assert.equal(service.book(), null)
    service.ensure()
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls.length, 1, 'an immediate retry stays inside the failure backoff')
    assert.equal(service.pricesVersion(), 0)
    clock += 30_000
    await service.prices()
    assert.equal(calls.length, 2, 'the backoff expires and the fetch is retried')
  })
})
