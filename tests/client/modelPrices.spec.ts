import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { getModelPricesSnap, pricesBookOf, resetModelPrices, setModelPricesLoader, subscribeModelPrices } from '../../src/client/modelPrices'
import type { ModelPricesSnap } from '../../src/client/modelPrices'

const FIXTURE = {
  deepseek: {
    npm: '@ai-sdk/openai-compatible',
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
  anthropic: {
    npm: '@ai-sdk/anthropic',
    models: { 'claude-sonnet-5': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } },
  },
  gateway: {
    npm: '@ai-sdk/openai-compatible',
    models: { 'claude-sonnet-5': { cost: { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 } } },
  },
  foreign: {
    npm: '@ai-sdk/openai',
    models: { 'claude-sonnet-5': { cost: { input: 9, output: 9, cache_read: 9, cache_write: 9 } } },
  },
  moonshotai: { models: { 'kimi-k2.7-code': { cost: { input: 1.9, output: 8, cache_read: 0.38, cache_write: 3 } } } },
  minimax: { models: { 'broken-input': { cost: { input: 'junk', output: 2 } } } },
  zhipuai: { models: 'nope' },
  'junk-provider': 7,
  'provider-the-plugin-never-maps': { models: { m: { cost: { input: 1, output: 2 } } } },
}

describe('pricesBookOf', () => {
  test('extracts every pricing provider under its registry id, skipping junk entries', () => {
    const { prices } = pricesBookOf(FIXTURE) ?? {}
    assert.deepEqual(prices, {
      deepseek: {
        'deepseek-v4-flash': { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 },
        'deepseek-v4-pro': { hit: 0.435, miss: 0.435, write: 0.435, out: 0.87 },
        'glm-free': { hit: 0, miss: 0, write: 0, out: 0 },
      },
      anthropic: { 'claude-sonnet-5': { hit: 0.2, miss: 2, write: 2.5, out: 10 } },
      gateway: { 'claude-sonnet-5': { hit: 0.2, miss: 2, write: 2.5, out: 10 } },
      foreign: { 'claude-sonnet-5': { hit: 9, miss: 9, write: 9, out: 9 } },
      moonshotai: { 'kimi-k2.7-code': { hit: 0.38, miss: 1.9, write: 3, out: 8 } },
      'provider-the-plugin-never-maps': { m: { hit: 1, miss: 1, write: 1, out: 2 } },
    })
    assert.equal(pricesBookOf(null), null)
    assert.equal(pricesBookOf('x'), null)
    assert.equal(pricesBookOf([FIXTURE]), null)
    assert.deepEqual(pricesBookOf({}), { prices: {}, index: { byModel: new Map(), byNormalized: new Map(), branches: new Map() }, canonical: {} }, 'an empty payload prices an empty book')
  })

  test('prototype-like registry names never change object prototypes', () => {
    const model = { cost: { input: 1, output: 2 } }
    const payload = Object.fromEntries(['__proto__', 'constructor', 'prototype', 'p'].map(id => [id, {
      models: Object.fromEntries(['__proto__', 'constructor', 'prototype', 'm'].map(mid => [mid, model])),
    }]))
    assert.deepEqual(pricesBookOf(payload)?.prices, { p: { m: { hit: 1, miss: 1, write: 1, out: 2 } } })
  })

  test('canonical ids join the branch index and mark its labs', () => {
    const book = pricesBookOf({
      p: {
        models: {
          a: { cost: { input: 1, output: 2 }, canonical_model_id: 'lab/a' },
          b: { cost: { input: 3, output: 4 }, canonical_model_id: 'lab/b' },
          c: { cost: { input: 5, output: 6 } },
        },
      },
    })
    const branch = book?.index.branches.get('p')
    assert.equal(branch?.labs.size, 1)
    assert.deepEqual(branch?.byExact.get('a')?.[0], { pid: 'p', mid: 'a', rate: { hit: 1, miss: 1, write: 1, out: 2 }, canonical: 'lab/a', lab: 'lab' })
    assert.equal(branch?.byExact.get('c')?.[0]?.canonical, undefined)
  })
})

describe('the price store', () => {
  let snaps: ModelPricesSnap[]

  async function settle(): Promise<void> {
    for (let i = 0; i < 30; i++) await Promise.resolve()
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
    assert.deepEqual(getModelPricesSnap(), { book: null, failed: false })
    const seen: ModelPricesSnap[] = []
    const un = subscribeModelPrices(() => seen.push(getModelPricesSnap()))
    const un2 = subscribeModelPrices(() => {})
    await settle()
    assert.equal(calls, 1)
    assert.equal(getModelPricesSnap().failed, false)
    assert.ok(getModelPricesSnap().book !== null)
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
    assert.deepEqual(getModelPricesSnap(), { book: null, failed: true })
    subscribeModelPrices(() => {})
    await vi.advanceTimersByTimeAsync(29_999)
    assert.equal(calls, 1)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls, 2)
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(calls, 2, 'the second retry waits the doubled 60s')
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(calls, 3)
    assert.equal(getModelPricesSnap().failed, false, 'a successful retry clears the failure')
    assert.ok(getModelPricesSnap().book !== null)
  })

  test('the retry cycle stops once its last subscriber leaves, and a new subscribe kicks it again', async () => {
    let calls = 0
    setModelPricesLoader(() => {
      calls++
      return Promise.reject(new Error('down'))
    })
    const off = subscribeModelPrices(() => {})
    await settle()
    assert.equal(calls, 1)
    off()
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(calls, 1, 'the idle cycle reaches no loader')
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    assert.equal(calls, 1, 'no poll happens without a subscriber')
    subscribeModelPrices(() => {})
    await settle()
    assert.equal(calls, 2, 'a fresh subscribe kicks a fresh read')
  })

  test('a rejected fetch backs off too and stays capped', async () => {
    setModelPricesLoader(() => Promise.reject(new Error('down')))
    subscribeModelPrices(() => snaps.push(getModelPricesSnap()))
    await settle()
    assert.equal(getModelPricesSnap().failed, true)
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
    assert.deepEqual(getModelPricesSnap(), { book: null, failed: false })
  })

  test('an unsubscribe detaches the listener; a restore reverts to the SDK loader', async () => {
    setModelPricesLoader(() => Promise.resolve(FIXTURE))
    const seen: ModelPricesSnap[] = []
    const un = subscribeModelPrices(() => seen.push(getModelPricesSnap()))
    un()
    await settle()
    assert.deepEqual(seen, [], 'no emissions after unsubscribing')
    assert.deepEqual(getModelPricesSnap().book, pricesBookOf(FIXTURE), 'the in-flight fetch still lands silently')
    setModelPricesLoader(null)
    assert.deepEqual(getModelPricesSnap().book, pricesBookOf(FIXTURE))
  })

  test('reset ignores pending persisted reads and both resolved and rejected old refreshes', async () => {
    let read: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { read = resolve })))
    setModelPricesLoader(async () => FIXTURE)
    subscribeModelPrices(() => {})
    resetModelPrices()
    read?.(Response.json({ ok: true, value: null }))
    await settle()
    assert.equal(getModelPricesSnap().book, null)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true, value: null })))
    for (const reject of [false, true]) {
      let finish: ((value: unknown) => void) | undefined
      let fail: ((error: Error) => void) | undefined
      setModelPricesLoader(() => new Promise((resolve, rejectLoad) => { finish = resolve; fail = rejectLoad }))
      subscribeModelPrices(() => {})
      await settle()
      resetModelPrices()
      if (reject) fail?.(new Error('stale'))
      else finish?.(FIXTURE)
      await settle()
      assert.deepEqual(getModelPricesSnap(), { book: null, failed: false })
    }
    vi.unstubAllGlobals()
  })

  test('the default loader reads models.dev through the SDK client', async () => {
    const responses = [
      new Response('not json', { status: 200 }),
      new Response(JSON.stringify(FIXTURE), { status: 200 }),
    ]
    const fetchMock = vi.fn((input: URL | RequestInfo): Promise<Response> => Promise.resolve(
      String(input) === 'api/dsh-context/pricing-snapshot'
        ? Response.json({ ok: true, value: null })
        : responses.shift() ?? new Response('{}', { status: 200 }),
    ))
    vi.stubGlobal('fetch', fetchMock)
    try {
      resetModelPrices()
      setModelPricesLoader(null)
      subscribeModelPrices(() => snaps.push(getModelPricesSnap()))
      await settle()
      const requested = String(fetchMock.mock.calls.find(call => String(call[0]).startsWith('https:'))?.[0])
      assert.equal(requested, 'https://models.dev/api.json')
      assert.deepEqual(getModelPricesSnap(), { book: null, failed: true }, 'a non-JSON body fails the boundary and retries')
      await vi.advanceTimersByTimeAsync(30_000)
      assert.deepEqual(getModelPricesSnap().book, pricesBookOf(FIXTURE), 'the retry lands the sanitized book')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
