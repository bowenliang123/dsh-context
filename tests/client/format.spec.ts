// Display formatting (src/client/format.ts): the k/M suffix style, byte
// sizes, the cache-hit truncation, locale-safe time, locale-unit durations,
// and leading slice shares.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { cacheHitPercent, fmt, fmtBytes, fmtDuration, fmtShare, fmtTime } from '../../src/client/format'

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

describe('fmtShare', () => {
  test('nothing to total shows the dash', () => {
    assert.equal(fmtShare(0, 0), '—')
    assert.equal(fmtShare(5, 0), '—')
    assert.equal(fmtShare(NaN, 100), '—')
    assert.equal(fmtShare(5, Infinity), '—')
  })

  test('empty slices are 0%; crumbs below a point round up to <1%', () => {
    assert.equal(fmtShare(0, 100), '0%')
    assert.equal(fmtShare(-1, 100), '0%')
    assert.equal(fmtShare(0.5, 100), '<1%')
    assert.equal(fmtShare(1, 300), '<1%')
  })

  test('shares round to whole percents and cap at 100', () => {
    assert.equal(fmtShare(844, 1000), '84%')
    assert.equal(fmtShare(996, 1000), '100%')
    assert.equal(fmtShare(3000, 1000), '100%')
    assert.equal(fmtShare(1, 3), '33%')
  })
})

describe('fmtDuration', () => {
  test('non-finite and non-positive input shows the dash', () => {
    assert.equal(fmtDuration(0, 'en'), '—')
    assert.equal(fmtDuration(-5, 'zh'), '—')
    assert.equal(fmtDuration(NaN, 'en'), '—')
    assert.equal(fmtDuration(Infinity, 'en'), '—')
  })

  test('sub-second stays in raw ms', () => {
    assert.equal(fmtDuration(740, 'en'), '740ms')
    assert.equal(fmtDuration(999.6, 'zh'), '1000ms')
  })

  test('under a minute: one-decimal seconds', () => {
    assert.equal(fmtDuration(12_300, 'en'), '12.3s')
    assert.equal(fmtDuration(12_300, 'zh'), '12.3秒')
  })

  test('under an hour: minutes and seconds', () => {
    assert.equal(fmtDuration(205_000, 'en'), '3m 25s')
    assert.equal(fmtDuration(205_000, 'zh'), '3分25秒')
    assert.equal(fmtDuration(600_000, 'en'), '10m 0s')
  })

  test('an hour and beyond: hours and minutes', () => {
    assert.equal(fmtDuration(4_440_000, 'en'), '1h 14m')
    assert.equal(fmtDuration(4_440_000, 'zh'), '1时14分')
    assert.equal(fmtDuration(7_320_000, 'en'), '2h 2m')
  })
})
