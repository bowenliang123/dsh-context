import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { billingSample, billedSampleSchema, sameAttempt } from '../../src/host/usage'

const buckets = { input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }
describe('persisted attempt sample', () => {
  test('invalid attempt ids or times never produce a checkpoint sample', () => {
    for (const data of [undefined, {}, { turn: '1', step: 1 }, { turn: 0.5, step: 1 }, { turn: -1, step: 1 },
      { turn: 1 }, { turn: 1, step: '1' }, { turn: 1, step: 0.5 }, { turn: 1, step: -1 }]) {
      assert.equal(billingSample(data, 0, buckets, ''), undefined)
    }
    assert.equal(billingSample({ turn: 1, step: 1 }, NaN, buckets, ''), undefined)
  })
  test('an unpriced sample serializes without undefined optional fields', () => {
    const sample = billingSample({ turn: 0, step: 0 }, 0, buckets, '')
    assert.deepEqual(sample, { turn: 0, step: 0, time: 0, provider: '', buckets })
    assert.deepEqual(billedSampleSchema.parse(JSON.parse(JSON.stringify(sample))), sample)
    assert.equal(sameAttempt(sample, undefined), false)
    assert.equal(sameAttempt(sample, { turn: 1, step: 0 }), false)
    assert.equal(sameAttempt(sample, { turn: 0, step: 1 }), false)
    assert.equal(sameAttempt(sample, { turn: 0, step: 0 }), true)
  })
})
