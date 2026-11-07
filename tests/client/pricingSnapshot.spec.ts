import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { estimateSessionCost } from '../../src/client/cost'
import { getModelPricesSnap, pricesBookOf, resetModelPrices, setModelPricesLoader, subscribeModelPrices } from '../../src/client/modelPrices'
import { cachedSessionCost, flushPricingSnapshot, loadPricingSnapshot, rememberPricingBook, resetPricingSnapshot } from '../../src/client/pricingSnapshot'
import type { SessionCostUsage } from '../../src/shared/types'
import { kpisOf } from '../../src/client/overview'
import { rowOf } from './overview.fixtures'

const data = { p: { models: { m: { cost: { input: 1, output: 2 }, canonical_model_id: 'p/m' } } } }
const usage = (tokens: number): SessionCostUsage => ({ p: { m: { off: { uncached: tokens, cacheRead: 0, cacheWrite: 0, output: 0 } } } })
const book = (): NonNullable<ReturnType<typeof pricesBookOf>> => pricesBookOf(data)!

async function settle(): Promise<void> {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

describe('durable pricing snapshots', () => {
  let stored: unknown
  let writes: number

  beforeEach(() => {
    vi.useFakeTimers()
    resetModelPrices()
    stored = null
    writes = 0
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { write?: unknown }
      if (body.write !== undefined) {
        stored = body.write
        writes++
      }
      return Response.json({ ok: true, value: stored })
    }))
  })

  afterEach(() => {
    resetModelPrices()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  test('a reload reuses historical amounts and calculates only changed content, in either currency', async () => {
    await loadPricingSnapshot()
    const first = book()
    rememberPricingBook(first)
    const calculate = vi.fn(() => 3)
    assert.equal(cachedSessionCost(usage(10), first, calculate), 3)
    assert.equal(cachedSessionCost(usage(20), first, calculate), 3)
    await flushPricingSnapshot()
    assert.equal(writes, 1)
    resetPricingSnapshot()
    await loadPricingSnapshot()
    const restored = book()
    assert.equal(cachedSessionCost(usage(10), restored, calculate), 3)
    assert.equal(cachedSessionCost(usage(20), restored, calculate), 3)
    assert.equal(calculate.mock.calls.length, 2)
    cachedSessionCost(usage(21), restored, calculate)
    assert.equal(calculate.mock.calls.length, 3)
    assert.equal(estimateSessionCost(usage(1_000_000), restored, 'usd'), 1)
    assert.equal(estimateSessionCost(usage(1_000_000), restored, 'cny'), 1 / 0.15)
  })

  test('a thousand-session overview restores prices and reprices only changed rows and aggregates', async () => {
    await loadPricingSnapshot()
    const rows = Array.from({ length: 1000 }, (_, i) => rowOf({ id: String(i), familyCost: usage(i + 1) }))
    const cold = kpisOf(rows, book(), 'usd')
    await flushPricingSnapshot()
    resetPricingSnapshot()
    const restored = pricesBookOf(await loadPricingSnapshot())!
    let reads = 0
    Object.defineProperty(restored.prices.p.m, 'miss', { get: () => { reads++; return 1 } })
    const warm = kpisOf(rows, restored, 'usd')
    assert.deepEqual(warm, cold)
    assert.equal(warm.sessions, 1000)
    assert.equal(reads, 1, 'only the price-book revision is read; every amount is restored')
    kpisOf(rows, restored, 'cny')
    assert.equal(reads, 1, 'currency changes reuse cached USD amounts')
    estimateSessionCost(usage(2_000_000), restored, 'usd')
    const readsPerAmount = reads - 1
    assert.ok(readsPerAmount > 0)
    reads = 1
    rows[0].familyCost!.p.m.off!.uncached = 1001
    const changed = kpisOf(rows, restored, 'usd')
    assert.equal(reads, 1 + 2 * readsPerAmount, 'one changed row and the changed full-scope aggregate are priced')
    assert.equal(changed.tokens, cold.tokens + 1000)
    assert.ok(Math.abs(changed.cost! - cold.cost! - 0.001) < 1e-12)
    rows.pop()
    const deleted = kpisOf(rows, restored, 'usd')
    assert.equal(deleted.sessions, 999)
    assert.equal(deleted.tokens, cold.tokens)
    assert.equal(deleted.cost, cold.cost)
    assert.equal(reads, 1 + 2 * readsPerAmount, 'deleted sessions do not leak into totals or invalidate surviving amounts')
  })

  test('pricing changes invalidate old money while reordered equivalent input and null or free prices stay reusable', () => {
    const first = book()
    const compute = vi.fn(() => null)
    cachedSessionCost(usage(1), first, compute)
    cachedSessionCost(usage(1), book(), compute)
    assert.equal(compute.mock.calls.length, 1)
    const changed = pricesBookOf({ p: { models: { m: { cost: { input: 2, output: 2 } } } } })!
    assert.equal(estimateSessionCost(usage(1_000_000), changed, 'usd'), 2)
    const free = pricesBookOf({ p: { models: { m: { cost: { input: 0, output: 0 } } } } })!
    assert.equal(estimateSessionCost(usage(1_000_000), free, 'usd'), 0)
    assert.equal(estimateSessionCost(usage(1_000_000), free, 'usd'), 0)
  })

  test('price-book round trips preserve distinct canonicals hidden by deduplicated case-folded lookups', async () => {
    const first = pricesBookOf({
      router: { models: {
        M: { cost: { input: 1, output: 1 }, canonical_model_id: 'alpha/m' },
        m: { cost: { input: 1, output: 1 }, canonical_model_id: 'beta/m' },
      } },
      openai: { models: { 'gpt-x': { cost: { input: 2, output: 2 } } } },
    })!
    const routed = { router: { 'gpt-x': usage(1_000_000).p.m } }
    await loadPricingSnapshot()
    assert.equal(estimateSessionCost(routed, first, 'usd'), 2)
    await flushPricingSnapshot()
    resetPricingSnapshot()
    const restored = pricesBookOf(await loadPricingSnapshot())!
    assert.deepEqual(restored.canonical, first.canonical)
    assert.equal(estimateSessionCost(routed, restored, 'usd'), 2)
    routed.router['gpt-x'].off!.uncached *= 2
    assert.equal(estimateSessionCost(routed, restored, 'usd'), 4)
  })

  test('price-book round trips preserve candidate order when case-folded identities carry different labs', async () => {
    const first = pricesBookOf({
      router: { models: {
        m: { cost: { input: 1, output: 1 }, canonical_model_id: 'beta/m' },
        M: { cost: { input: 1, output: 1 }, canonical_model_id: 'alpha/m' },
      } },
      alpha: { models: { m: { cost: { input: 2, output: 2 } } } },
      beta: { models: { m: { cost: { input: 3, output: 3 } } } },
    })!
    const routed = { unknown: { m: usage(1_000_000).p.m } }
    await loadPricingSnapshot()
    assert.equal(estimateSessionCost(routed, first, 'usd'), 3)
    await flushPricingSnapshot()
    resetPricingSnapshot()
    const restored = pricesBookOf(await loadPricingSnapshot())!
    assert.equal(estimateSessionCost(routed, restored, 'usd'), 3)
    routed.unknown.m.off!.uncached *= 2
    assert.equal(estimateSessionCost(routed, restored, 'usd'), 6)
  })

  test('warm prices appear before an offline refresh finishes and preserve canonical matching', async () => {
    await loadPricingSnapshot()
    rememberPricingBook(book())
    estimateSessionCost(usage(1_000_000), book(), 'usd')
    await flushPricingSnapshot()
    resetModelPrices()
    setModelPricesLoader(() => Promise.reject(new Error('offline')))
    const stop = subscribeModelPrices(() => {})
    await settle()
    assert.ok(getModelPricesSnap().book)
    assert.equal(getModelPricesSnap().failed, true)
    assert.equal(estimateSessionCost(usage(1_000_000), getModelPricesSnap().book, 'usd'), 1)
    stop()
    await vi.advanceTimersByTimeAsync(30_000)
    setModelPricesLoader(async () => ({ p: { models: { m: { cost: { input: 2, output: 2 } } } } }))
    subscribeModelPrices(() => {})
    await settle()
    assert.equal(getModelPricesSnap().failed, false)
    assert.equal(estimateSessionCost(usage(1_000_000), getModelPricesSnap().book, 'usd'), 2)
  })

  test('corrupt or unavailable storage never prevents a fresh accurate calculation', async () => {
    stored = { version: 0, revision: '', entries: [] }
    assert.equal(await loadPricingSnapshot(), null)
    assert.equal(estimateSessionCost(usage(1_000_000), book(), 'usd'), 1)
    resetPricingSnapshot()
    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new Error('unavailable'))))
    assert.equal(await loadPricingSnapshot(), null)
    rememberPricingBook(book())
    await flushPricingSnapshot()
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(estimateSessionCost(usage(1_000_000), book(), 'usd'), 1)
  })

  test('malformed entries are skipped and an invalid book timestamp discards the snapshot', async () => {
    await loadPricingSnapshot()
    rememberPricingBook(book())
    await flushPricingSnapshot()
    const valid = stored as { book: { at: unknown }; entries: unknown[] }
    valid.entries = [null, [], ['a', false], ['b', Number.POSITIVE_INFINITY], ['c', 0], ['c', 0], ['d', null]]
    resetPricingSnapshot()
    assert.deepEqual(pricesBookOf(await loadPricingSnapshot()), book())
    valid.book.at = 'bad'
    resetPricingSnapshot()
    assert.equal(await loadPricingSnapshot(), null)
  })

  test('bounded retention evicts only cached amounts, never the authoritative usage', () => {
    const first = book()
    const compute = vi.fn(() => 1)
    for (let i = 0; i <= 20_000; i++) cachedSessionCost(usage(i), first, compute)
    assert.equal(compute.mock.calls.length, 20_001)
    cachedSessionCost(usage(20_000), first, compute)
    assert.equal(compute.mock.calls.length, 20_001)
    cachedSessionCost(usage(0), first, compute)
    assert.equal(compute.mock.calls.length, 20_002)
  })

  test('debounced writes include changes made during an in-flight write', async () => {
    await loadPricingSnapshot()
    rememberPricingBook(book())
    let finish: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = flushPricingSnapshot()
    cachedSessionCost(usage(1), book(), () => 2)
    await flushPricingSnapshot()
    finish?.(Response.json({ ok: true }))
    await pending
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(vi.mocked(fetch).mock.calls.length, 1)
  })

  test('rejected writes retry, ignore stale completions and never persist invalid amounts or oversized keys', async () => {
    await loadPricingSnapshot()
    const first = book()
    rememberPricingBook(first)
    for (const invalid of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const compute = vi.fn(() => invalid)
      cachedSessionCost(usage(9), first, compute)
      cachedSessionCost(usage(9), first, compute)
      assert.equal(compute.mock.calls.length, 2)
    }
    const huge = { ['x'.repeat(20_001)]: usage(1).p }
    const compute = vi.fn(() => 1)
    cachedSessionCost(huge, first, compute)
    cachedSessionCost(huge, first, compute)
    assert.equal(compute.mock.calls.length, 2)
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: false }, { status: 503 })))
    await flushPricingSnapshot()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ ok: true })))
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(vi.mocked(fetch).mock.calls.length, 1)
    cachedSessionCost(usage(10), first, () => 1)
    let finish: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = flushPricingSnapshot()
    resetPricingSnapshot()
    finish?.(Response.json({ ok: false }))
    await pending
    await vi.advanceTimersByTimeAsync(30_000)
    assert.equal(vi.mocked(fetch).mock.calls.length, 1)
  })

  test('debouncing shares one read and corrupt book recovery does not block fresh prices', async () => {
    const first = loadPricingSnapshot()
    assert.equal(loadPricingSnapshot(), first)
    await first
    rememberPricingBook(book())
    cachedSessionCost(usage(1), book(), () => 1)
    await vi.advanceTimersByTimeAsync(500)
    assert.equal(writes, 1)
    const snapshot = stored as { book: { data: unknown } }
    snapshot.book.data = { p: { get models() { throw new Error('corrupt') } } }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, value: snapshot }) })))
    resetModelPrices()
    setModelPricesLoader(async () => data)
    subscribeModelPrices(() => {})
    await settle()
    assert.ok(getModelPricesSnap().book)
    assert.equal(getModelPricesSnap().failed, false)
  })

  test('usage ordering, malformed buckets and missing price-index candidates remain deterministic', () => {
    const first = book()
    first.index.byModel.clear()
    const compute = vi.fn(() => 1)
    const malformed = { z: null, p: { z: null, m: { peak: {}, off: { output: 2 } } } } as unknown as SessionCostUsage
    const reordered = { p: { m: { off: { output: 2 }, peak: {} }, z: null }, z: null } as unknown as SessionCostUsage
    cachedSessionCost(malformed, first, compute)
    cachedSessionCost(reordered, first, compute)
    assert.equal(compute.mock.calls.length, 1)
  })

  test('wire byte limits evict derived entries for large Unicode books and skip oversized books', async () => {
    await loadPricingSnapshot()
    const large = pricesBookOf({ ['界'.repeat(1_650_000)]: data.p })!
    for (let i = 0; i < 50; i++) {
      cachedSessionCost({ ['界'.repeat(19_000) + i]: usage(1).p }, large, () => 1)
    }
    await flushPricingSnapshot()
    assert.equal(writes, 1)
    assert.ok((stored as { entries: unknown[] }).entries.length < 50)
    assert.ok(new TextEncoder().encode(JSON.stringify({ write: stored })).length <= 12 * 1024 * 1024)
    rememberPricingBook(pricesBookOf({ ['界'.repeat(2_200_000)]: data.p })!)
    await flushPricingSnapshot()
    assert.equal(writes, 1)
    rememberPricingBook(pricesBookOf({ ['x'.repeat(2_200_000)]: data.p })!)
    await flushPricingSnapshot()
    assert.equal(writes, 1)
  })

  test('resets ignore stale load and write completions', async () => {
    let finish: ((response: Response) => void) | undefined
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(resolve => { finish = resolve })))
    const pending = loadPricingSnapshot()
    resetPricingSnapshot()
    finish?.(Response.json({ ok: true, value: { version: 1, revision: '', book: { at: 1, data }, entries: [] } }))
    assert.equal(await pending, null)
  })
})
