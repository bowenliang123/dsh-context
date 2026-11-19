import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, vi } from 'vitest'
import {
  PRICE_BOOK_FILE,
  PRICE_BOOK_FORMAT,
  createCatalogService,
  priceBookPath,
  type CatalogFetcher,
  type PriceCacheIo,
} from '../../src/host/catalog'
import { priceOf, priceSourceOf, pricesBookOf } from '../../src/shared/pricing'
import { until } from './helpers/backfill'
import { cacheIoOf } from './helpers/cacheIo'

describe('catalog', () => {

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
  cachePath?: string | null
  cacheIo?: PriceCacheIo
} = {}) {
  const calls: FetchCall[] = extra.calls ?? []
  return {
    calls,
    service: createCatalogService({
      fetch: fetcherOf(routes, calls),
      now: extra.now,
      currentVersion: extra.currentVersion ?? '0.82.2',
      cachePath: extra.cachePath === undefined ? null : extra.cachePath,
      ...extra.cacheIo === undefined ? {} : { cacheIo: extra.cacheIo },
    }),
  }
}

const CACHE_PATH = join(tmpdir(), 'dsh-context-test-price-book.v1.json')

function cachedBook(body: unknown, fetchedAt: unknown = 1_000, format: unknown = PRICE_BOOK_FORMAT): string {
  return JSON.stringify({ format, fetchedAt, source: body })
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
    assert.equal(priceOf(book, 'deepseek', 'deepseek-v4-flash')?.out, 0.6)
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
      const service = createCatalogService({ currentVersion: '0.82.2', cachePath: null })
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
      cachePath: null,
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

describe('catalog price cache', () => {
  test('serves a fresh persisted book without touching the network', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedBook(PRICES, 1_000))
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => 2_000, cachePath: CACHE_PATH, cacheIo: io })
    const read = await service.prices()
    assert.deepEqual(read, { value: null, ready: true, failed: false, checkedAt: 1_000 })
    assert.equal(calls.length, 0)
    assert.equal(io.writes, 0, 'a fresh cache is never rewritten')
    assert.equal(service.pricesVersion(), 1)
    assert.equal(priceOf(service.book(), 'deepseek', 'deepseek-v4-flash')?.out, 0.6)
  })

  test('serves a stale book first, refreshes behind it, and persists the new source', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedBook(PRICES, 0))
    let release!: (body: unknown) => void
    const pending = new Promise<unknown>((resolve) => { release = resolve })
    const calls: FetchCall[] = []
    const service = createCatalogService({
      fetch: (url) => {
        calls.push({ url })
        return pending.then(body => ({ ok: true, status: 200, json: async () => body }) as unknown as Response)
      },
      now: () => 2_000,
      cachePath: CACHE_PATH,
      cacheIo: io,
    })
    service.ensure()
    await until(() => (service.book() !== null ? true : undefined), 'the cached book never landed')
    assert.equal(calls.length, 1, 'the refresh is already in flight')
    assert.equal(service.pricesVersion(), 1, 'the stale book serves while the refresh is pending')
    assert.equal(priceOf(service.book(), 'deepseek', 'deepseek-v4-flash')?.out, 0.6)
    release(PRICES)
    const read = await service.prices()
    assert.equal(read.ready, true)
    assert.equal(service.pricesVersion(), 2, 'the refreshed book bumps the version')
    assert.equal(io.writes, 1)
    const saved = JSON.parse(io.files.get(CACHE_PATH) ?? '{}') as { format?: unknown; fetchedAt?: unknown; source?: unknown }
    assert.equal(saved.format, PRICE_BOOK_FORMAT)
    assert.equal(saved.fetchedAt, 2_000)
    assert.deepEqual(saved.source, PRICES)
  })

  test('ignores unusable persisted books and fetches instead', async () => {
    const cases: [string, string][] = [
      ['malformed json', '{'],
      ['a foreign format', cachedBook(PRICES, 1_000, PRICE_BOOK_FORMAT + 1)],
      ['a non-numeric timestamp', cachedBook(PRICES, 'now')],
      ['a negative timestamp', cachedBook(PRICES, -1)],
      ['a timestamp ahead of the clock', cachedBook(PRICES, 2_000 + 60 * 60 * 1000 + 1)],
      ['an empty book', cachedBook({})],
      ['an error body', cachedBook({ error: 'rate limited' })],
      ['a bad source', cachedBook([1, 2])],
      ['a null body', 'null'],
    ]
    for (const [label, body] of cases) {
      const io = cacheIoOf()
      io.files.set(CACHE_PATH, body)
      const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => 2_000, cachePath: CACHE_PATH, cacheIo: io })
      const read = await service.prices()
      assert.equal(read.ready, true, label)
      assert.equal(calls.length, 1, label)
      assert.equal(service.pricesVersion(), 1, label)
    }
    const io = cacheIoOf()
    io.failRead = true
    const failing = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => 2_000, cachePath: CACHE_PATH, cacheIo: io })
    assert.equal((await failing.service.prices()).ready, true, 'an unreadable cache falls back to the network')
    assert.equal(failing.calls.length, 1)
  })

  test('a failed cache write never disturbs the served book', async () => {
    const io = cacheIoOf()
    io.failWrite = true
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => 2_000, cachePath: CACHE_PATH, cacheIo: io })
    const read = await service.prices()
    assert.equal(io.writes, 1, 'the write is attempted before the read settles')
    assert.equal(read.ready, true)
    assert.equal(calls.length, 1)
    assert.ok(service.book() !== null)
  })

  test('an empty catalogue payload never replaces the persisted book', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedBook(PRICES, 0))
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: {} }], { now: () => 2_000, cachePath: CACHE_PATH, cacheIo: io })
    await service.prices()
    assert.equal(calls.length, 1)
    assert.equal(io.writes, 0, 'an empty source is never persisted')
    assert.deepEqual(JSON.parse(io.files.get(CACHE_PATH) ?? '{}').source, PRICES, 'the good persisted book survives')
  })

  test('a transient cache read failure is retried on a later ensure', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedBook(PRICES, 1_000))
    io.failRead = true
    let clock = 2_000
    const { service, calls } = catalogOf([{ match: isPricesUrl, reject: true }], { now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    await service.prices()
    assert.equal(service.book(), null)
    assert.equal(calls.length, 1)
    io.failRead = false
    clock += 30_000
    const read = await service.prices()
    assert.equal(read.ready, true, 'the retried read lands the persisted book')
    assert.equal(service.pricesVersion(), 1)
    assert.equal(calls.length, 1, 'the fresh persistent book needs no second fetch')
  })

  test('a second cache read failure settles the read latch', async () => {
    const io = cacheIoOf()
    io.failRead = true
    let clock = 2_000
    const { service } = catalogOf([{ match: isPricesUrl, reject: true }], { now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    await service.prices()
    clock += 30_000
    await service.prices()
    assert.equal(io.reads, 2)
    io.failRead = false
    io.files.set(CACHE_PATH, cachedBook(PRICES, 1_000))
    clock += 30_000
    await service.prices()
    assert.equal(io.reads, 2, 'the latch settles after two failed reads')
    assert.equal(service.book(), null)
  })

  test('defaults the cache path to the harness storage directory', async () => {
    const home = await mkdtemp(join('.tmp', 'dsh-context-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const service = createCatalogService({
        fetch: fetcherOf([{ match: isPricesUrl, body: PRICES }]),
        now: () => 2_000,
        currentVersion: '0.82.2',
      })
      await service.prices()
      await until(
        () => existsSync(join(home, 'storages', 'dsh-context', PRICE_BOOK_FILE)) || undefined,
        'the default cache path never wrote',
      )
      service.dispose()
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })

  test('a null cache path disables persistence', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedBook(PRICES, 1_000))
    const { service, calls } = catalogOf([{ match: isPricesUrl, body: PRICES }], { now: () => 2_000, cachePath: null, cacheIo: io })
    await service.prices()
    assert.equal(io.reads, 0)
    assert.equal(io.writes, 0)
    assert.equal(calls.length, 1)
  })

  test('the default cache io writes and reads the book on disk', async () => {
    const root = await mkdtemp(join('.tmp', 'dsh-context-price-book-'))
    const path = join(root, 'nested', 'price-book.v1.json')
    try {
      const first = catalogOf([{ match: isPricesUrl, body: PRICES }], { cachePath: path })
      await first.service.prices()
      await until(() => existsSync(path) || undefined, 'the price cache file never appeared')
      const saved = JSON.parse(await readFile(path, 'utf8')) as { format?: unknown }
      assert.equal(saved.format, PRICE_BOOK_FORMAT)
      const second = catalogOf([{ match: isPricesUrl, body: PRICES }], { cachePath: path })
      const read = await second.service.prices()
      assert.equal(read.ready, true)
      assert.equal(second.calls.length, 0, 'the persisted book serves the next process')
      first.service.dispose()
      second.service.dispose()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test('the price book path follows DSH_HOME and falls back to the home directory', () => {
    assert.equal(
      priceBookPath({ DSH_HOME: join('custom', 'dsh') }, join('home', 'u')),
      join('custom', 'dsh', 'storages', 'dsh-context', PRICE_BOOK_FILE),
    )
    assert.equal(priceBookPath({}, join('home', 'u')), join('home', 'u', '.dsh', 'storages', 'dsh-context', PRICE_BOOK_FILE))
    assert.equal(priceBookPath({ DSH_HOME: '   ' }, join('home', 'u')), join('home', 'u', '.dsh', 'storages', 'dsh-context', PRICE_BOOK_FILE))
  })
})
})

describe('priceSourceOf', () => {
  test('keeps the cost record and canonical id of every priced model', () => {
    const source = priceSourceOf({
      deepseek: {
        npm: '@ai-sdk/openai-compatible',
        models: {
          'deepseek-v4-flash': {
            name: 'DeepSeek V4 Flash',
            limit: { context: 128000 },
            cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15, reasoning: 0.6 },
            canonical_model_id: 'deepseek/deepseek-v4-flash',
          },
          free: { cost: { input: 0, output: 0 } },
        },
      },
      junk: 7,
      broken: { models: 'nope' },
      other: { models: { failed: {} } },
    })
    assert.deepEqual(source, {
      deepseek: {
        models: {
          'deepseek-v4-flash': {
            cost: { input: 0.15, output: 0.6, cache_read: 0.003, cache_write: 0.15, reasoning: 0.6 },
            canonical_model_id: 'deepseek/deepseek-v4-flash',
          },
          free: { cost: { input: 0, output: 0 } },
        },
      },
    })
    assert.equal(priceSourceOf(null), null)
    assert.equal(priceSourceOf('x'), null)
    assert.equal(priceSourceOf([1]), null)
  })

  test('hostile keys and a non-record model never reach the saved source', () => {
    const payload = JSON.parse('{"__proto__":{"models":{"m":{"cost":{"input":1,"output":2}}}},"deepseek":{"models":{"__proto__":{"cost":{"input":1,"output":2}},"constructor":{"cost":{"input":1,"output":2}},"real":{"cost":{"input":1,"output":2}}}}}') as Record<string, unknown>
    const source = priceSourceOf(payload)
    assert.deepEqual(source, { deepseek: { models: { real: { cost: { input: 1, output: 2 } } } } })
  })

  test('a model without a cost record is dropped, and absent numbers are omitted', () => {
    assert.deepEqual(priceSourceOf({
      p: { models: { broken: null, bare: { cost: {} }, partial: { cost: { cache_read: 1 } } } },
    }), { p: { models: { bare: { cost: {} }, partial: { cost: { cache_read: 1 } } } } })
  })

  test('the pruned source rebuilds the same price book as the payload', () => {
    const payload = {
      deepseek: {
        models: {
          'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 }, canonical_model_id: 'deepseek/deepseek-v4-flash' },
        },
      },
    }
    assert.deepEqual(pricesBookOf(priceSourceOf(payload)), pricesBookOf(payload))
  })
})
