// The model-price book (src/client/modelPrices.ts): the boundary sanitizer
// over the models.dev payload (every field re-proved, junk entries dropped
// whole) and the fetch store (kick on first subscribe, visible failure with
// a backed-off automatic retry, test-loader injection).

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { getModelPricesSnap, pricesBookOf, resetModelPrices, setModelPricesLoader, subscribeModelPrices } from '../../src/client/modelPrices'
import type { ModelPricesSnap } from '../../src/client/modelPrices'

/** A minimal but real-shaped slice of the models.dev /api.json payload. */
const FIXTURE = {
  deepseek: {
    models: {
      'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, reasoning: 0.6, cache_read: 0.003 } },
      'deepseek-v4-pro': { cost: { input: 0.435, output: 0.87 } },
      'glm-free': { cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 } },
      'broken-missing-input': { cost: { output: 1 } },
      'broken-missing-output': { cost: { input: 1 } },
      'broken-negative': { cost: { input: -1, output: 1 } },
      'broken-nan': { cost: { input: Number.NaN, output: Number.POSITIVE_INFINITY } },
      'broken-no-cost': {},
      'broken-not-record': null,
    },
  },
  moonshotai: { models: { 'kimi-k2.7-code': { cost: { input: 1.9, output: 8, cache_read: 0.38, cache_write: 3 } } } },
  minimax: { models: { 'broken-input': { cost: { input: 'junk', output: 2 } } } },
  zhipuai: { models: 'nope' },
  'junk-provider': 7,
  'provider-the-plugin-never-maps': { models: { m: { cost: { input: 1, output: 2 } } } },
}

describe('pricesBookOf', () => {
  test('extracts every pricing provider under its registry id, skipping junk entries', () => {
    assert.deepEqual(pricesBookOf(FIXTURE), {
      deepseek: {
        'deepseek-v4-flash': { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 },
        'deepseek-v4-pro': { hit: 0.435, miss: 0.435, write: 0.435, out: 0.87 },
        'glm-free': { hit: 0, miss: 0, write: 0, out: 0 },
      },
      moonshotai: { 'kimi-k2.7-code': { hit: 0.38, miss: 1.9, write: 3, out: 8 } },
      'provider-the-plugin-never-maps': { m: { hit: 1, miss: 1, write: 1, out: 2 } },
    })
  })

  test('absent cache prices fall back to the input rate', () => {
    const book = pricesBookOf(FIXTURE)
    assert.equal(book?.deepseek?.['deepseek-v4-pro']?.write, 0.435)
  })

  test('a payload that is not a record prices null; an empty one prices an empty book', () => {
    assert.equal(pricesBookOf(null), null)
    assert.equal(pricesBookOf('x'), null)
    assert.equal(pricesBookOf([FIXTURE]), null)
    assert.deepEqual(pricesBookOf({}), {})
  })
})

describe('the price store', () => {
  let snaps: ModelPricesSnap[]

  /** Drain the fire() promise chain (fake timers keep setTimeout inert). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    snaps = []
    resetModelPrices()
  })

  afterEach(() => {
    resetModelPrices()
    vi.useRealTimers()
  })

  test('dormant until subscribed, then one fetch fills the book', async () => {
    let calls = 0
    setModelPricesLoader(() => {
      calls++
      return Promise.resolve(FIXTURE)
    })
    assert.deepEqual(getModelPricesSnap(), { prices: null, failed: false })
    const seen: ModelPricesSnap[] = []
    const un = subscribeModelPrices(() => seen.push(getModelPricesSnap()))
    // A second subscription in the same tick finds the fetch already in
    // flight and never re-kicks.
    const un2 = subscribeModelPrices(() => {})
    await settle()
    assert.equal(calls, 1)
    assert.equal(getModelPricesSnap().failed, false)
    assert.ok(getModelPricesSnap().prices !== null)
    assert.ok(seen.length > 0, 'listeners hear the transition')
    un2()
    await settle()
    assert.equal(calls, 1)
    un()
  })

  test('a garbage payload fails visibly and retries with doubling backoff', async () => {
    let calls = 0
    setModelPricesLoader(() => {
      calls++
      return Promise.resolve(calls < 3 ? 'garbage' : FIXTURE)
    })
    subscribeModelPrices(() => snaps.push(getModelPricesSnap()))
    await settle()
    assert.deepEqual(getModelPricesSnap(), { prices: null, failed: true })
    // A subscriber joining while the retry timer is armed never re-kicks.
    subscribeModelPrices(() => {})
    // First retry waits 30s, misses, then backs off to 60s.
    await vi.advanceTimersByTimeAsync(29_999)
    assert.equal(calls, 1)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls, 2)
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(calls, 2, 'the second retry waits the doubled 60s')
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(calls, 3)
    assert.equal(getModelPricesSnap().failed, false, 'a successful retry clears the failure')
    assert.ok(getModelPricesSnap().prices !== null)
  })

  test('a rejected fetch backs off too and stays capped', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    subscribeModelPrices(() => snaps.push(getModelPricesSnap()))
    await settle()
    assert.equal(getModelPricesSnap().failed, true)
    // failures=2 → the next wait is 60s, and the cap holds after that.
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(getModelPricesSnap().failed, true)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(240_000)
    assert.ok(getModelPricesSnap().failed, 'still failing, still retrying (capped at ×8)')
  })

  test('resetModelPrices drops the book and the pending retry', async () => {
    let calls = 0
    setModelPricesLoader(() => {
      calls++
      return Promise.reject(new Error('down'))
    })
    subscribeModelPrices(() => {})
    await settle()
    assert.equal(calls, 1)
    resetModelPrices()
    await vi.advanceTimersByTimeAsync(10 * 240_000)
    assert.equal(calls, 1, 'the armed retry went with the reset')
    assert.deepEqual(getModelPricesSnap(), { prices: null, failed: false })
  })

  test('an unsubscribe detaches the listener; a restore reverts to the SDK loader', async () => {
    setModelPricesLoader(() => Promise.resolve(FIXTURE))
    const seen: ModelPricesSnap[] = []
    const un = subscribeModelPrices(() => seen.push(getModelPricesSnap()))
    un()
    await settle()
    assert.deepEqual(seen, [], 'no emissions after unsubscribing')
    assert.deepEqual(getModelPricesSnap().prices, pricesBookOf(FIXTURE), 'the in-flight fetch still lands silently')
    // The SDK loader is restored without firing (no subscription, no kick).
    setModelPricesLoader(null)
    assert.deepEqual(getModelPricesSnap().prices, pricesBookOf(FIXTURE))
  })

  test('the default loader reads models.dev through the SDK client', async () => {
    const responses = [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    ]
    const fetchMock = vi.fn((_input: URL | RequestInfo): Promise<Response> => Promise.resolve(responses.shift() ?? new Response('{}', { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      resetModelPrices()
      setModelPricesLoader(null)
      subscribeModelPrices(() => snaps.push(getModelPricesSnap()))
      await settle()
      const requested = String(fetchMock.mock.calls[0]?.[0])
      assert.equal(requested, 'https://models.dev/api.json')
      assert.deepEqual(getModelPricesSnap(), { prices: null, failed: true }, 'a non-JSON body fails the boundary and retries')
      await vi.advanceTimersByTimeAsync(30_000)
      assert.deepEqual(getModelPricesSnap().prices, pricesBookOf(FIXTURE), 'the retry lands the sanitized book')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
