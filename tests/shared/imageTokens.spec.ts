import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateImageTokens } from '../../src/shared/imageTokens'

describe('estimateImageTokens', () => {
  test('prices the published v41 reference sizes', () => {
    for (const [width, height, expected] of [
      [100, 100, 184],
      [544, 544, 184],
      [640, 480, 206],
      [800, 800, 422],
      [1024, 768, 496],
      [1066, 600, 407],
      [1300, 1300, 994],
      [1920, 1080, 968],
      [2000, 2000, 994],
      [5000, 5000, 994],
      [300, 50, 200],
      [8192, 100, 593],
      [16, 8192, 590],
    ] as const) {
      assert.equal(estimateImageTokens(width, height), expected, `${width}x${height}`)
    }
  })

  test('caps every image at 1024 tokens', () => {
    for (const [width, height] of [[2000, 2000], [5000, 5000], [8192, 8192], [16, 8192], [9000, 1], [1, 9000]] as const) {
      const tokens = estimateImageTokens(width, height)
      assert.ok(tokens !== null && tokens <= 1024, `${width}x${height} -> ${tokens}`)
    }
  })

  test('prices small images at the documented scale-up floor', () => {
    assert.equal(estimateImageTokens(100, 100), estimateImageTokens(544, 544))
  })

  test('solves a one-row grid for an extremely wide image', () => {
    assert.equal(estimateImageTokens(9000, 1), 1024)
  })

  test('solves a one-column grid for an extremely tall image', () => {
    assert.equal(estimateImageTokens(1, 9000), 1024)
  })

  test('converges through repeated projection passes when the first is not a fixpoint', () => {
    assert.equal(estimateImageTokens(12, 1123), 380)
    assert.equal(estimateImageTokens(89, 2076), 254)
  })

  test('non-positive or non-finite dimensions return null', () => {
    assert.equal(estimateImageTokens(0, 100), null)
    assert.equal(estimateImageTokens(100, 0), null)
    assert.equal(estimateImageTokens(-5, 100), null)
    assert.equal(estimateImageTokens(100, -5), null)
    assert.equal(estimateImageTokens(NaN, 100), null)
    assert.equal(estimateImageTokens(100, Infinity), null)
  })

  test('every valid size lands inside the documented cap band', () => {
    for (let width = 16; width <= 4096; width *= 2) {
      for (let height = 16; height <= 4096; height *= 2) {
        const tokens = estimateImageTokens(width, height)
        assert.ok(tokens !== null && tokens >= 2 && tokens <= 1024, `${width}x${height} -> ${tokens}`)
      }
    }
  })

  test('prices subnormal dimensions as the published calculator does', () => {
    assert.equal(estimateImageTokens(1e-300, 1e-300), 2)
  })
})
