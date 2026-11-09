import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, type Recom } from '../../src/shared/recoms'
import { readRecoms, setRecomFetcher, RECOM_ROUTE, watchRecomChannel } from '../../src/host/recoms'

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
