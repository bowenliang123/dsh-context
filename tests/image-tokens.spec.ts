/**
 * The ported DeepSeek image-token calculator (src/shared/imageTokens.ts)
 * must reproduce the official docs calculator (图片 Token 计算器 on
 * https://api-docs.deepseek.com/zh-cn/quick_start/token_usage) exactly —
 * these reference values were produced by running the calculator's own
 * shipped JavaScript.
 */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { estimateImageTokens } from '../src/shared/imageTokens.ts'

test('image token estimates match the official DeepSeek docs calculator', () => {
  const cases = [
    // [width, height, official tokens]
    [2048, 1365, 313],
    [800, 600, 341],
    [800, 800, 349],
    [2000, 2000, 349],
    [5000, 5000, 349],
    [2048, 2048, 349],
    [8192, 8192, 349],
    [384, 384, 117],
    [100, 100, 117],
    [50, 50, 117],
    [1, 1, 117],
    [512, 512, 201],
    [1920, 1080, 369],
    [6000, 4000, 313],
    [4096, 512, 301],
    [400, 900, 249],
    [422, 473, 149],
    [240, 240, 117],
  ]
  for (const [w, h, expected] of cases) {
    assert.equal(estimateImageTokens(w, h), expected, `${w}×${h}`)
  }
  // Degenerate dimensions price nothing (callers fall back).
  assert.equal(estimateImageTokens(0, 100), null)
  assert.equal(estimateImageTokens(100, 0), null)
  assert.equal(estimateImageTokens(-5, 10), null)
  assert.equal(estimateImageTokens(Number.NaN, 10), null)
  assert.equal(estimateImageTokens(Number.POSITIVE_INFINITY, 10), null)
  console.log('✔ image token calculator matches the official DeepSeek docs calculator')
})
