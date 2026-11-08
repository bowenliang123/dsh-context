import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createCostSource, withCost, withDetailCost } from '../../src/host/cost'
import type { CatalogService } from '../../src/host/catalog'
import { pricesBookOf, type ModelBook } from '../../src/shared/pricing'
import type { SessionCostUsage } from '../../src/shared/types'

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
