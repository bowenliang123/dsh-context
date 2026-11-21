// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { historyRowKey, mergeHistoryRows } from '../../src/client/historyMerge'

describe('history merge', () => {
  test('appends a newer tail without rebuilding the old rows', () => {
    const old = [{ seq: 1 }, { seq: 2 }]
    const merged = mergeHistoryRows(old, [{ seq: 3 }])
    assert.deepEqual(merged.map(row => row.seq), [1, 2, 3])
    assert.notEqual(merged, old)
    assert.equal(mergeHistoryRows(old, []), old)
  })

  test('deduplicates by ordinal and orders same-seq rows across rows without one', () => {
    const merged = mergeHistoryRows(
      [{ seq: 9 }, { seq: 10 }],
      [{ seq: 9, ord: 0 }, { seq: 9, ord: 1 }],
    )
    assert.deepEqual(merged.map(historyRowKey), ['9:', '9:0', '9:1', '10:'])
  })
})
