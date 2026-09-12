// Session-cost estimate (src/client/cost.ts): the model-price-book lookup
// (exact, case-insensitive, and the unambiguous cross-provider fallback), the
// USD→CNY conversion at the fixed 1 CNY = 0.15 USD, the null degradations,
// the numOf coercion of garbage bucket fields, and the money/rate formatting.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, formatCost, formatPriceRate, offPeakOf, priceOf, toCurrency } from '../../src/client/cost'
import type { ModelPrices } from '../../src/client/cost'
import type { CostBucketTotals } from '../../src/shared/types'

const M = 1_000_000

/** Real-shaped rates (deepseek-v4-flash on models.dev, no cache_write published). */
const FLASH = { hit: 0.003, miss: 0.15, write: 0.15, out: 0.6 }
const PRO = { hit: 0.003625, miss: 0.435, write: 0.435, out: 0.87 }
const KIMI = { hit: 0.19, miss: 0.95, write: 0.95, out: 4 }
const K3 = { hit: 0.3, miss: 3, write: 3, out: 15 }

/** The book is keyed by the models.dev provider ids, exactly as extracted. */
const BOOK: ModelPrices = {
  deepseek: { 'deepseek-v4-flash': FLASH, 'deepseek-v4-pro': PRO },
  moonshotai: { 'kimi-k2.7-code': KIMI, 'kimi-k3': K3 },
  'opencode-go': { 'deepseek-v4-flash': FLASH },
}

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number, message?: string): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, message ?? `expected ~${expected}, got ${actual}`)
}

describe('toCurrency', () => {
  test('USD passes through; CNY divides the fixed 0.15 rate', () => {
    assert.equal(toCurrency(1.2, 'usd'), 1.2)
    close(toCurrency(1.2, 'cny'), 8)
    close(toCurrency(0.3, 'cny'), 2)
  })
})

describe('priceOf', () => {
  test('a mapped dsh provider id resolves to its models.dev branch', () => {
    assert.equal(priceOf(BOOK, 'deepseek-official', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf(BOOK, 'kimi-coding', 'kimi-k2.7-code'), KIMI)
  })

  test('an unmapped dsh provider id passes through to the book verbatim', () => {
    assert.equal(priceOf(BOOK, 'opencode-go', 'deepseek-v4-flash'), FLASH)
    assert.equal(priceOf({ anthropic: { claude: KIMI } }, 'anthropic', 'claude'), KIMI)
  })

  test('a known provider falls back to a case-insensitive model match', () => {
    assert.equal(priceOf({ minimax: { 'MiniMax-M2.5': KIMI } }, 'minimax-cn', 'minimax-m2.5'), KIMI)
  })

  test('a short dsh model id suffix-matches its namespaced registry id', () => {
    assert.equal(priceOf(BOOK, 'kimi-coding', 'k3'), K3)
    assert.equal(priceOf(BOOK, 'kimi-coding', 'K3'), K3, 'the suffix tier is case-insensitive too')
  })

  test('several suffix candidates in one branch are ambiguous', () => {
    const book: ModelPrices = { moonshotai: { 'kimi-k3': K3, 'other-k3': KIMI } }
    assert.equal(priceOf(book, 'kimi-coding', 'k3'), null)
  })

  test('a known provider with an unknown model prices null (no cross-provider guess)', () => {
    assert.equal(priceOf(BOOK, 'deepseek', 'kimi-k2.7-code'), null)
  })

  test('a provider the book does not carry prices the model only when unambiguous book-wide', () => {
    assert.equal(priceOf(BOOK, '', 'kimi-k2.7-code'), KIMI, 'unambiguous: exactly one branch carries it')
    assert.equal(priceOf(BOOK, 'future-provider', 'kimi-k2.7-code'), KIMI)
    assert.equal(priceOf(BOOK, '', 'deepseek-v4-flash'), null, 'ambiguous: two branches carry it')
    assert.equal(priceOf(BOOK, '', 'mystery'), null)
  })

  test('a null or missing book prices nothing', () => {
    assert.equal(priceOf(null, 'deepseek-official', 'deepseek-v4-flash'), null)
    assert.equal(priceOf(undefined, '', 'kimi-k2.7-code'), null)
  })
})

describe('estimateSessionCost', () => {
  test('null usage or null book prices to null', () => {
    assert.equal(estimateSessionCost(null, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, BOOK, 'cny'), null)
    assert.equal(estimateSessionCost({}, null, 'usd'), null)
  })

  test('usage without any priced bucket returns null', () => {
    assert.equal(estimateSessionCost({}, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost({ 'deepseek-official': { unknown: { peak: bucket(0, M, 0, 0) } } }, BOOK, 'usd'), null)
    assert.equal(estimateSessionCost({ unmapped: { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }, BOOK, 'usd'), null)
  })

  test('prices every period bucket at its own rate (hit / miss / write / out)', () => {
    const usage = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(M, M, M, M) },
        'deepseek-v4-pro': { peak: bucket(M, M, M, M) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, M) } },
    }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.903 + (0.003625 + 0.435 + 0.435 + 0.87) + 0.95 + 4)
  })

  test('off-peak buckets price at half the book rate for DeepSeek only', () => {
    const split = { peak: bucket(0, M, 0, 0), off: bucket(0, M, 0, 0) }
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': split } }, BOOK, 'usd'), 0.15 + 0.075)
    close(
      estimateSessionCost({ 'kimi-coding': { 'kimi-k2.7-code': split } }, BOOK, 'usd'),
      0.95 + 0.95,
      'a flat-rate provider bills an off bucket at list price, never half',
    )
  })

  test('a missing model is skipped while priced ones still sum', () => {
    const usage = { 'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.95)
  })

  test('the CNY currency converts the USD total at 1 CNY = 0.15 USD', () => {
    const usage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } } }
    close(estimateSessionCost(usage, BOOK, 'cny'), 1)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: garbage } } }, BOOK, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ 'deepseek-official': { 'deepseek-v4-flash': { peak: mixed } } }, BOOK, 'usd'), 0.003 + 0.5 * 0.15)
  })

  test('hostile provider branches, periods, and buckets are skipped, not fatal', () => {
    const usage = {
      junk: 'x',
      'kimi-coding': { broken: null, 'kimi-k2.7-code': { peak: 'junk', off: bucket(0, M, 0, 0) } },
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(0, M, 0, 0) } },
    } as unknown as { [provider: string]: Record<string, Record<string, CostBucketTotals>> }
    close(estimateSessionCost(usage, BOOK, 'usd'), 0.15 + 0.95)
  })
})

describe('offPeakOf', () => {
  test('halves every rate component', () => {
    assert.deepEqual(offPeakOf(FLASH), { hit: 0.0015, miss: 0.075, write: 0.075, out: 0.3 })
  })
})

describe('formatCost', () => {
  test('amounts of at least 1 use fixed two-decimal notation', () => {
    assert.equal(formatCost(3.456, 'usd'), '$3.46')
    assert.equal(formatCost(1, 'usd'), '$1.00')
  })

  test('amounts below 1 use two-significant-digit precision', () => {
    assert.equal(formatCost(0.014, 'usd'), '$0.014')
    assert.equal(formatCost(0.5, 'usd'), '$0.50')
  })

  test('the CNY currency uses the yen symbol', () => {
    assert.equal(formatCost(12.3, 'cny'), '¥12.30')
    assert.equal(formatCost(0.66, 'cny'), '¥0.66')
  })
})

describe('formatPriceRate', () => {
  test('trims trailing zeros from a fixed-notation figure', () => {
    assert.equal(formatPriceRate(3.0, 'cny'), '¥3')
    assert.equal(formatPriceRate(4.5, 'cny'), '¥4.5')
  })

  test('trims trailing zeros from a precision-notation figure', () => {
    assert.equal(formatPriceRate(0.007, 'usd'), '$0.007')
    assert.equal(formatPriceRate(0.1, 'usd'), '$0.1')
  })

  test('strips the dot left behind when every decimal was a zero', () => {
    assert.equal(formatPriceRate(9.0, 'cny'), '¥9')
    assert.equal(formatPriceRate(1.5, 'cny'), '¥1.5')
  })
})
