import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, type Recom } from '../../src/shared/recoms'
import { readRecom, resetRecomRotation, setRecomFetcher, RECOM_ROUTE, watchRecomChannel } from '../../src/host/recoms'

function recom(id: string): Recom {
  return { ...DEFAULT_RECOM, id }
}

function response(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

afterEach(() => {
  setRecomFetcher(null)
  resetRecomRotation()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('recom reads', () => {
  test('every read fetches the fixed URL and rotates the validated entries in order', async () => {
    const calls: { url: string; accept?: string; signal?: AbortSignal }[] = []
    setRecomFetcher(async (url, init) => {
      const headers = init.headers as Record<string, string>
      calls.push({ url, accept: headers.accept, signal: init.signal ?? undefined })
      return response([recom('first'), recom('second')])
    })
    assert.equal((await readRecom()).recom.id, 'first')
    assert.equal((await readRecom()).recom.id, 'second')
    assert.equal((await readRecom()).recom.id, 'first')
    assert.equal(calls.length, 3)
    assert.equal(calls[0]?.url, RECOM_DATA_URL)
    assert.equal(calls[0]?.accept, 'application/json')
    assert.ok(calls[0]?.signal instanceof AbortSignal)
  })

  test('transport, HTTP, JSON, payload, and selection failures all return the default', async () => {
    const failures: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error('down')),
      () => Promise.resolve(response([], false)),
      () => Promise.resolve({ ok: true, json: () => Promise.reject(new Error('bad json')) } as unknown as Response),
      () => Promise.resolve(response({ nope: true })),
      () => Promise.resolve(response([])),
    ]
    for (const run of failures) {
      setRecomFetcher(run)
      const read = await readRecom()
      assert.deepEqual(read.recom, DEFAULT_RECOM)
      assert.equal(read.degraded, true)
    }
    setRecomFetcher(async () => { throw new Error('fetch failed') })
    const read = await readRecom()
    assert.deepEqual(read.recom, DEFAULT_RECOM)
    assert.equal(read.degraded, true)
  })

  test('a failed read does not advance the rotation', async () => {
    setRecomFetcher(async () => response([]))
    const failed = await readRecom()
    assert.deepEqual(failed.recom, DEFAULT_RECOM)
    assert.equal(failed.degraded, true)
    setRecomFetcher(async () => response([recom('after-failure')]))
    assert.equal((await readRecom()).recom.id, 'after-failure')
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
      const read = await readRecom()
      assert.equal(read.recom.id, 'mirror')
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
    const read = await readRecom()
    assert.equal(read.recom.id, 'global')
    assert.equal(read.degraded, false)
    assert.deepEqual(seen, [RECOM_DATA_URL])
  })
})

describe('recom route', () => {
  test('a usable connection serves the selected value with no-store, and absent registries stay inert', async () => {
    for (const connection of [undefined, {}]) {
      const ctx = {
        inject: (_deps: string[], cb: (c: unknown) => void) => cb({ get: () => connection, effect: () => {} }),
      }
      assert.doesNotThrow(() => watchRecomChannel(ctx as unknown as Context))
    }
    let route: { path: string; fetch: () => Promise<Response> } | undefined
    const ctx = {
      get: () => ({ fetch: { register: (next: typeof route) => { route = next; return () => {} } } }),
      effect: (fn: () => unknown) => fn(),
      inject(_deps: string[], cb: (c: unknown) => void) { cb(ctx) },
    }
    setRecomFetcher(async () => response([recom('route')]))
    watchRecomChannel(ctx as unknown as Context)
    assert.equal(route?.path, RECOM_ROUTE)
    const reply = await route?.fetch()
    assert.equal(reply?.headers.get('cache-control'), 'no-store')
    assert.deepEqual(await reply?.json(), { ok: true, value: recom('route'), degraded: false })
    setRecomFetcher(async () => { throw new Error('down') })
    const fallback = await route?.fetch()
    assert.deepEqual(await fallback?.json(), { ok: true, value: DEFAULT_RECOM, degraded: true })
  })
})
