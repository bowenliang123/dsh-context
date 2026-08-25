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
    // flash peak 0.014 + 2×0.44 + 1.32, flash off 0.007 + 2×0.22 + 0.66,
    // pro peak 0.044 + 2×1.32 + 3.96, pro off 0.022 + 2×0.66 + 1.98.
    close(estimateSessionCost(usage, 'usd'), 2.214 + 1.107 + 6.644 + 3.322)
  })

  test('prices with the CNY table', () => {
    const usage = { flash: { peak: bucket(M, M, M, M) } }
    close(estimateSessionCost(usage, 'cny'), 0.10 + 2 * 3.0 + 9.0)
  })

  test('a missing model family is skipped', () => {
    const usage = { pro: { peak: bucket(0, M, 0, 0) } }
    close(estimateSessionCost(usage, 'usd'), 1.32)
  })

  test('a missing pricing period is skipped', () => {
    const usage = { flash: { off: bucket(0, 0, 0, M) } }
    close(estimateSessionCost(usage, 'usd'), 0.66)
  })

  test('non-number bucket fields are coerced to zero by numOf', () => {
    const garbage = { cacheRead: NaN, uncached: 'x', cacheWrite: undefined, output: Infinity } as unknown as CostBucketTotals
    assert.equal(estimateSessionCost({ flash: { peak: garbage } }, 'usd'), 0)
  })

  test('garbage fields degrade while real fields still price', () => {
    const mixed = { cacheRead: M, uncached: NaN, cacheWrite: M / 2, output: 'junk' } as unknown as CostBucketTotals
    close(estimateSessionCost({ flash: { peak: mixed } }, 'usd'), 0.014 + 0.5 * 0.44)
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
      { family: 'deepseek-v4-flash', peak: { hit: 0.014, miss: 0.44, out: 1.32 }, off: { hit: 0.007, miss: 0.22, out: 0.66 } },
      { family: 'deepseek-v4-pro', peak: { hit: 0.044, miss: 1.32, out: 3.96 }, off: { hit: 0.022, miss: 0.66, out: 1.98 } },
    ])
  })

  test('lists the CNY table for the CNY currency', () => {
    assert.deepEqual(sessionPrices('cny'), [
      { family: 'deepseek-v4-flash', peak: { hit: 0.10, miss: 3.0, out: 9.0 }, off: { hit: 0.05, miss: 1.5, out: 4.5 } },
      { family: 'deepseek-v4-pro', peak: { hit: 0.30, miss: 9.0, out: 27.0 }, off: { hit: 0.15, miss: 4.5, out: 13.5 } },
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
