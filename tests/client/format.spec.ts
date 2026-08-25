// Display formatting (src/client/format.ts): the k/M suffix style, byte
// sizes, the cache-hit truncation, and locale-safe time.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { cacheHitPercent, fmt, fmtBytes, fmtTime } from '../../src/client/format'

describe('fmt', () => {
  test('missing/NaN input shows the dash', () => {
    assert.equal(fmt(undefined), '—')
    assert.equal(fmt(null), '—')
    assert.equal(fmt(NaN), '—')
  })

  test('small numbers round to integers', () => {
    assert.equal(fmt(0), '0')
    assert.equal(fmt(999.4), '999')
  })

  test('thousands and millions take suffixes with one decimal', () => {
    assert.equal(fmt(1000), '1.0k')
    assert.equal(fmt(1534), '1.5k')
    assert.equal(fmt(1_000_000), '1.0M')
    assert.equal(fmt(128_000), '128.0k')
  })

  test('negatives keep their sign', () => {
    assert.equal(fmt(-1500), '-1.5k')
    assert.equal(fmt(-12), '-12')
  })
})

describe('fmtBytes', () => {
  test('missing/NaN/negative input shows the dash', () => {
    assert.equal(fmtBytes(undefined), '—')
    assert.equal(fmtBytes(null), '—')
    assert.equal(fmtBytes(NaN), '—')
    assert.equal(fmtBytes(-1), '—')
  })

  test('B/kB/MB at decimal thresholds', () => {
    assert.equal(fmtBytes(512), '512 B')
    assert.equal(fmtBytes(2048), '2.0 kB')
    assert.equal(fmtBytes(3_500_000), '3.5 MB')
  })
})

describe('cacheHitPercent', () => {
  test('null when nothing was billed', () => {
    assert.equal(cacheHitPercent(5, 0), null)
    assert.equal(cacheHitPercent(0, -1), null)
  })

  test('truncates to two decimals (cut, not round)', () => {
    assert.equal(cacheHitPercent(1, 3), '33.33')
    assert.equal(cacheHitPercent(82499, 83000), '99.39')
    assert.equal(cacheHitPercent(83000, 83000), '100.00')
  })
})

describe('fmtTime', () => {
  test('invalid dates show the dash instead of throwing', () => {
    assert.equal(fmtTime(NaN), '—')
  })

  test('valid timestamps format as 24-hour HH:MM:SS', () => {
    assert.match(fmtTime(1000), /^\d{2}:\d{2}:\d{2}$/)
  })
})
