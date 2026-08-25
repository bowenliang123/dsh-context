// The cordis `config:` block contract (src/host/config.ts): defaults fill,
// strict keys, integer/lower-bound validation — exercised through the REAL
// Standard-Schema validator cordis itself runs before apply.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Config, DEFAULT_BOUNDS, resolveBounds } from '../../src/host/config'

describe('Config validator', () => {
  test('an absent config (a loader row without config:) resolves to defaults', () => {
    assert.deepEqual(Config.parse(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds({}), DEFAULT_BOUNDS)
  })

  test('each field overrides independently', () => {
    assert.equal(resolveBounds({ maxRequestSteps: 7 }).maxRequestSteps, 7)
    assert.equal(resolveBounds({ maxKeptTurns: 7 }).maxKeptTurns, 7)
    assert.equal(resolveBounds({ maxEvents: 7 }).maxEvents, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxNodes, 7)
    assert.equal(resolveBounds({ maxArchiveNodes: 7 }).maxArchiveNodes, 7)
    // Untouched fields keep their defaults.
    assert.equal(resolveBounds({ maxNodes: 7 }).maxEvents, DEFAULT_BOUNDS.maxEvents)
  })

  test('rejects zero/negative bounds (min 1)', () => {
    assert.throws(() => Config.parse({ maxRequestSteps: 0 }))
    assert.throws(() => Config.parse({ maxNodes: -1 }))
  })

  test('rejects non-integer bounds', () => {
    assert.throws(() => Config.parse({ maxEvents: 1.5 }))
  })

  test('rejects non-number bounds', () => {
    assert.throws(() => Config.parse({ maxKeptTurns: '300' }))
  })

  test('strict: unknown keys fail loudly', () => {
    assert.throws(() => Config.parse({ unknown: 1 }))
  })
})
