import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, test, vi } from 'vitest'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, type Recom } from '../../src/shared/recoms'
import {
  RECOM_CACHE_FILE,
  RECOM_CACHE_FORMAT,
  RECOM_ROUTE,
  readRecoms,
  setRecomFetcher,
  watchRecomChannel,
  type RecomCacheIo,
  type RecomChannelOptions,
} from '../../src/host/recoms'
import { cacheIoOf } from './helpers/cacheIo'
import { connectionOf, fakeCtx } from './helpers/ctx'
import { until } from './helpers/backfill'

describe('recoms', () => {

function recom(id: string): Recom {
  return { ...DEFAULT_RECOM, id }
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

interface Route {
  path: string
  fetch: () => Promise<Response>
}

function mount(options: RecomChannelOptions = {}): Route {
  const harness = fakeCtx({ connection: connectionOf(() => () => {}) })
  watchRecomChannel(harness.ctx, options)
  const route = harness.routes.get(RECOM_ROUTE)
  const fetch = route?.fetch
  if (fetch === undefined) assert.fail('the recom route was not mounted')
  return { path: String(route?.path), fetch: () => fetch(new Request('http://localhost/')) }
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
      assert.doesNotThrow(() => watchRecomChannel(fakeCtx({ connection }).ctx, { cachePath: null }))
    }
    let clock = 1_000
    const calls: string[] = []
    setRecomFetcher(async () => {
      calls.push('ok')
      return response([recom('route'), recom('second')])
    })
    const route = mount({ now: () => clock, cachePath: null })
    assert.equal(route.path, RECOM_ROUTE)
    const reply = await route.fetch()
    assert.equal(reply.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await reply.json(), { ok: true, value: [recom('route'), recom('second')], degraded: false })
    setRecomFetcher(async () => {
      calls.push('down')
      throw new Error('down')
    })
    const cached = await route.fetch()
    assert.deepEqual(await cached.json(), { ok: true, value: [recom('route'), recom('second')], degraded: false }, 'a fresh slot answers from the TTL cache')
    assert.deepEqual(calls, ['ok'])
    clock += 60 * 60 * 1000
    const fallback = await route.fetch()
    assert.deepEqual(await fallback.json(), { ok: true, value: [recom('route'), recom('second')], degraded: true }, 'a failed refresh keeps the last good list, degraded')
    assert.deepEqual(calls, ['ok', 'down', 'down'], 'the expired slot refetched the primary and the mirror')
    const backoff = await route.fetch()
    assert.deepEqual(await backoff.json(), { ok: true, value: [recom('route'), recom('second')], degraded: true }, 'the backoff window serves the last good list')
    assert.deepEqual(calls, ['ok', 'down', 'down'], 'the backoff window skips the network')
    clock += 30_000
    setRecomFetcher(async () => {
      calls.push('ok')
      return response([recom('after-backoff')])
    })
    const recovered = await route.fetch()
    assert.deepEqual(await recovered.json(), { ok: true, value: [recom('after-backoff')], degraded: false }, 'the backoff window expires into a fresh read')

    setRecomFetcher(async () => response([recom('default-now')]))
    const plain = mount({ cachePath: null })
    assert.deepEqual(await (await plain.fetch()).json(), { ok: true, value: [recom('default-now')], degraded: false }, 'the default wall clock serves the same protocol')
  })
})

const CACHE_PATH = '/state/recoms.v1.json'


function cachedRecoms(recoms: Recom[], fetchedAt: number, format: unknown = RECOM_CACHE_FORMAT): string {
  return JSON.stringify({ format, fetchedAt, recoms })
}

describe('recom cache', () => {
  test('serves a persisted list at once and refreshes behind it', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedRecoms([recom('cached')], 1_000))
    let clock = 1_000 + 60_000
    const calls: string[] = []
    setRecomFetcher(async () => {
      calls.push('ok')
      return response([recom('fresh')])
    })
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    const first = await route.fetch()
    assert.deepEqual(await first.json(), { ok: true, value: [recom('cached')], degraded: false }, 'the persisted list serves before the network')
    assert.equal(calls.length, 1, 'the refresh starts behind the reply')
    await until(() => (io.writes > 0 ? true : undefined), 'the refreshed list never persisted')
    const saved = JSON.parse(io.files.get(CACHE_PATH) ?? '{}') as { format?: unknown; fetchedAt?: unknown; recoms?: Recom[] }
    assert.equal(saved.format, RECOM_CACHE_FORMAT)
    assert.equal(saved.fetchedAt, clock)
    assert.deepEqual(saved.recoms?.map(item => item.id), ['fresh'])
    clock += 60_000
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false }, 'the refreshed slot serves afterwards')
  })

  test('a persisted list past the TTL serves as degraded and survives failed refreshes', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedRecoms([recom('cached')], 1_000))
    let clock = 1_000 + 2 * 60 * 60 * 1000
    setRecomFetcher(async () => { throw new Error('down') })
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('cached')], degraded: true }, 'a stale persisted list is marked degraded')
    clock += 30_000
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('cached')], degraded: true }, 'a failed refresh keeps the persisted list instead of the default')
    assert.equal(io.writes, 0, 'a degraded read is never persisted')
  })

  test('a persisted list beyond the max age is ignored', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedRecoms([recom('ancient')], 1_000))
    setRecomFetcher(async () => response([recom('fresh')]))
    const stale = mount({ now: () => 1_000 + 31 * 24 * 60 * 60 * 1000, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await stale.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false })
  })

  test('a slightly ahead timestamp is tolerated', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedRecoms([recom('cached')], 1_000 + 60_000))
    setRecomFetcher(async () => response([recom('fresh')]))
    const route = mount({ now: () => 1_000, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('cached')], degraded: false })
  })

  test('a corrupt, foreign, empty, or clock-skewed persisted list is ignored', async () => {
    const future = 1_000 + 31 * 24 * 60 * 60 * 1000
    const cases: [string, string][] = [
      ['malformed json', '{'],
      ['a foreign format', cachedRecoms([recom('x')], 1_000, RECOM_CACHE_FORMAT + 1)],
      ['a non-numeric timestamp', JSON.stringify({ format: RECOM_CACHE_FORMAT, fetchedAt: 'now', recoms: [recom('x')] })],
      ['a negative timestamp', cachedRecoms([recom('x')], -1)],
      ['a timestamp ahead of the clock', cachedRecoms([recom('x')], future)],
      ['an empty list', cachedRecoms([], 1_000)],
      ['unusable entries', JSON.stringify({ format: RECOM_CACHE_FORMAT, fetchedAt: 1_000, recoms: [{ id: '' }] })],
      ['a null body', 'null'],
    ]
    for (const [label, body] of cases) {
      const io = cacheIoOf()
      io.files.set(CACHE_PATH, body)
      setRecomFetcher(async () => response([recom('fresh')]))
      const route = mount({ now: () => 1_000, cachePath: CACHE_PATH, cacheIo: io })
      assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false }, label)
    }
  })

  test('cache read and write failures never break the route', async () => {
    const io = cacheIoOf()
    io.failRead = true
    setRecomFetcher(async () => response([recom('fresh')]))
    const readFailing = mount({ now: () => 1_000, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await readFailing.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false })
    io.failRead = false
    io.failWrite = true
    io.writes = 0
    const writeFailing = mount({ now: () => 1_000, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await writeFailing.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false })
    assert.equal(io.writes, 1, 'the write was attempted')
  })

  test('a failed first read with no cache serves the degraded default', async () => {
    const io = cacheIoOf()
    setRecomFetcher(async () => { throw new Error('down') })
    const route = mount({ now: () => 1_000, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [DEFAULT_RECOM], degraded: true })
    assert.equal(io.writes, 0)
  })

  test('a null cache path disables persistence', async () => {
    const io = cacheIoOf()
    setRecomFetcher(async () => response([recom('fresh')]))
    const route = mount({ now: () => 1_000, cachePath: null, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false })
    assert.equal(io.reads, 0)
    assert.equal(io.writes, 0)
  })

  test('a later failed refresh falls back to the last good list, not the default', async () => {
    const io = cacheIoOf()
    let clock = 1_000
    setRecomFetcher(async () => response([recom('good')]))
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('good')], degraded: false })
    clock += 2 * 60 * 60 * 1000
    setRecomFetcher(async () => { throw new Error('down') })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('good')], degraded: true }, 'the last good list outlives a failed refresh')
  })

  test('a transient cache read failure is retried on a later request', async () => {
    const io = cacheIoOf()
    io.files.set(CACHE_PATH, cachedRecoms([recom('cached')], 1_000))
    io.failRead = true
    let clock = 1_000 + 2 * 60 * 60 * 1000
    setRecomFetcher(async () => { throw new Error('down') })
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [DEFAULT_RECOM], degraded: true })
    io.failRead = false
    clock += 30_000
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('cached')], degraded: true }, 'the retried read lands the persisted list')
    assert.equal(io.reads, 2)
  })

  test('a second cache read failure settles the read latch', async () => {
    const io = cacheIoOf()
    io.failRead = true
    let clock = 1_000
    setRecomFetcher(async () => { throw new Error('down') })
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    await route.fetch()
    clock += 30_000
    await route.fetch()
    assert.equal(io.reads, 2)
    clock += 30_000
    await route.fetch()
    assert.equal(io.reads, 2, 'the latch settles after two failed reads')
  })

  test('a late disk read leaves a concurrent fresh slot in place', async () => {
    let release!: (value: string) => void
    const io: RecomCacheIo = {
      read: () => new Promise<string>((resolve) => { release = resolve }),
      write: async () => {},
    }
    setRecomFetcher(async () => response([recom('fresh')]))
    let clock = 1_000 + 60_000
    const route = mount({ now: () => clock, cachePath: CACHE_PATH, cacheIo: io })
    const slow = route.fetch()
    const fast = route.fetch()
    assert.deepEqual(await (await fast).json(), { ok: true, value: [recom('fresh')], degraded: false })
    release(cachedRecoms([recom('cached')], 1_000))
    assert.deepEqual(await (await slow).json(), { ok: true, value: [recom('cached')], degraded: false }, 'the cold request answers from disk')
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: false }, 'the late disk read leaves the fresh slot in place')
    clock += 60 * 60 * 1000
    setRecomFetcher(async () => { throw new Error('down') })
    assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('fresh')], degraded: true }, 'a failed refresh keeps the newer network list')
  })

  test('defaults the cache path to the harness storage directory', async () => {
    const home = await mkdtemp(join('.tmp', 'dsh-context-recom-home-'))
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      setRecomFetcher(async () => response([recom('default-path')]))
      const route = mount({ now: () => 5_000 })
      assert.deepEqual(await (await route.fetch()).json(), { ok: true, value: [recom('default-path')], degraded: false })
      const file = join(home, 'storages', 'dsh-context', RECOM_CACHE_FILE)
      await until(() => (existsSync(file) ? true : undefined), 'the default cache path never wrote')
      const saved = JSON.parse(readFileSync(file, 'utf8')) as { format?: unknown }
      assert.equal(saved.format, RECOM_CACHE_FORMAT)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
      await rm(home, { recursive: true, force: true })
    }
  })
})
})
