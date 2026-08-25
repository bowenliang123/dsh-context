// The official DeepSeek vision image-token calculator port
// (src/shared/imageTokens.ts). Reference values verified against the docs
// calculator itself (see the module header); the pixel sweep pins the
// documented 117–384 band and the null contract for degenerate input.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateImageTokens } from '../../src/shared/imageTokens'

describe('estimateImageTokens', () => {
  // Verified against https://api-docs.deepseek.com/zh-cn/quick_start/token_usage.
  test.each([
    [2048, 1365, 313],
    [800, 600, 341],
    [2048, 2048, 349],
    [512, 512, 201],
    [100, 100, 117],
    [1920, 1080, 369],
    [400, 900, 249],
  ])('%i×%i → %i tokens (docs calculator reference)', (w, h, expected) => {
    assert.equal(estimateImageTokens(w, h), expected)
  })

  test('every valid size lands inside the documented cap band', () => {
    // The documented band is 117–384; aspect ratios at the 8:1 clamp price
    // slightly under it (128×16 → 113) — same patch grid as the docs
    // calculator, so pin the observed floor rather than the marketing one.
    for (let w = 16; w <= 4096; w *= 2) {
      for (let h = 16; h <= 4096; h *= 2) {
        const tokens = estimateImageTokens(w, h)
        assert.ok(tokens !== null && tokens >= 113 && tokens <= 384, `${w}×${h} → ${tokens}`)
      }
    }
  })

  test('extreme aspect ratios clamp to the 8:1 band before patching', () => {
    assert.ok(estimateImageTokens(8000, 1000) !== null)
    assert.ok(estimateImageTokens(1000, 8000) !== null)
  })

  test('a tall strip beyond the ~190:1 grid threshold solves on the collapsed-width arm', () => {
    // The padded grid overflows the budget (860 tokens) and ratio 214 >
    // 189.5, so the solve collapses width to one patch unit (gridW < 1 arm).
    assert.equal(estimateImageTokens(50, 12000), 381)
  })

  test('a first-solve overflow walks the budget down until the grid fits', () => {
    // Parity terms can push the solved grid a token or two over budget; the
    // loop decrements until it fits (found by fuzz: 360×3243 exercises it).
    assert.equal(estimateImageTokens(360, 3243), 281)
  })

  test('non-positive or non-finite dimensions return null', () => {
    assert.equal(estimateImageTokens(0, 100), null)
    assert.equal(estimateImageTokens(100, 0), null)
    assert.equal(estimateImageTokens(-5, 100), null)
    assert.equal(estimateImageTokens(100, -5), null)
    assert.equal(estimateImageTokens(NaN, 100), null)
    assert.equal(estimateImageTokens(100, Infinity), null)
  })

  test('astronomical (finite) dimensions fail to converge and return null instead of throwing', () => {
    // w×h overflows to Infinity: the fixed-point iteration never stabilizes,
    // so the 9-iteration cap narrows to null (untrusted-log defense).
    assert.equal(estimateImageTokens(Number.MAX_VALUE, Number.MAX_VALUE), null)
    assert.equal(estimateImageTokens(1e308, 1e308), null)
  })
})
