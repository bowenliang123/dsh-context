import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { tallyEntriesOf } from '../../src/client/tallySort'

describe('tallyEntriesOf', () => {
  test('an absent tally is empty', () => {
    assert.deepEqual(tallyEntriesOf(undefined), [])
  })

  test('sorts by count then name, covering both name-order arms', () => {
    assert.deepEqual(tallyEntriesOf({ low: 1, high: 3 }), [['high', 3], ['low', 1]])
    assert.deepEqual(tallyEntriesOf({ zeta: 1, alpha: 1 }), [['alpha', 1], ['zeta', 1]])
    assert.deepEqual(tallyEntriesOf({ alpha: 1, zeta: 1 }), [['alpha', 1], ['zeta', 1]])
  })
})
