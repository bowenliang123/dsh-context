// Session-cost estimate (src/client/cost.ts): the hardcoded DeepSeek V4
// price lookup over family × period buckets, the null degradations, the
// numOf coercion of garbage bucket fields, and the money/rate formatting.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSessionCost, formatCost, formatPriceRate, sessionPrices } from '../../src/client/cost'
import type { CostBucketTotals } from '../../src/shared/types'

const M = 1_000_000

function bucket(cacheRead: number, uncached: number, cacheWrite: number, output: number): CostBucketTotals {
  return { cacheRead, uncached, cacheWrite, output }
}

function close(actual: number | null, expected: number): void {
  assert.ok(actual !== null && Math.abs(actual - expected) < 1e-9, `expected ~${expected}, got ${actual}`)
}

describe('estimateSessionCost', () => {
  test('null or undefined usage prices to null', () => {
    assert.equal(estimateSessionCost(null, 'usd'), null)
    assert.equal(estimateSessionCost(undefined, 'cny'), null)
  })

  test('usage without any priced bucket returns null', () => {
    assert.equal(estimateSessionCost({}, 'usd'), null)
  })

  test('prices all four family × period buckets with the USD table', () => {
    const usage = {
      flash: { peak: bucket(M, M, M, M), off: bucket(M, M, M, M) },
      pro: { peak: bucket(M, M, M, M), off: bucket(M, M, M, M) },
    }
    // Flash peak 0.006 + 2×0.3 + 1.2, Flash off 0.003 + 2×0.15 + 0.6; Pro
    // bills at the same Flash rates while the routing window lasts.
    close(estimateSessionCost(usage, 'usd'), 2 * (1.806 + 0.903))
  })

  test('prices with the CNY table', () => {
    const usage = { flash: { peak: bucket(M, M, M, M) } }
    close(estimateSessionCost(usage, 'cny'), 0.04 + 2 * 2 + 8)
  })

  test('a missing model family is skipped', () => {
    const usage = { pro: { peak: bucket(0, M, 0, 0) } }
    close(estimateSessionCost(usage, 'usd'), 0.3)
  })

  test('a missing pricing period is skipped', () => {
    const usage = { flash: { off: bucket(0, 0, 0, M) } }
    close(estimateSessionCost(usage, 'usd'), 0.6)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ flash: { peak: garbage } }, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ flash: { peak: mixed } }, 'usd'), 0.006 + 0.5 * 0.3)
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

describe('sessionPrices', () => {
  test('lists flash before pro with their peak and off-peak triples (USD)', () => {
    assert.deepEqual(sessionPrices('usd'), [
      { family: 'deepseek-v4.1-flash / deepseek-flash', peak: { hit: 0.006, miss: 0.3, out: 1.2 }, off: { hit: 0.003, miss: 0.15, out: 0.6 } },
      { family: 'deepseek-v4-pro', peak: { hit: 0.006, miss: 0.3, out: 1.2 }, off: { hit: 0.003, miss: 0.15, out: 0.6 } },
    ])
  })

  test('lists the CNY table for the CNY currency', () => {
    assert.deepEqual(sessionPrices('cny'), [
      { family: 'deepseek-v4.1-flash / deepseek-flash', peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
      { family: 'deepseek-v4-pro', peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
    ])
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
