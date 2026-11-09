import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeFoldJournal } from '../../src/host/foldJournal'

describe('dsh-context fold journal', () => {
  test('drain returns the folded ids, the worker-folded subset, and clears both', () => {
    const journal = makeFoldJournal()
    journal.note('a')
    journal.note('b', true)
    const drained = journal.drain()
    assert.deepEqual(drained.ids, ['a', 'b'])
    assert.deepEqual(drained.workerIds, ['b'])
    assert.deepEqual(journal.drain(), { ids: [], workerIds: [] })
  })

  test('an id overflow reports the whole corpus dirty once, then recovers', () => {
    const journal = makeFoldJournal()
    for (let index = 0; index < 4_200; index++) journal.note(`s${index}`, true)
    const drained = journal.drain()
    assert.equal(drained.ids, null)
    assert.equal(drained.workerIds, null)
    assert.deepEqual(journal.drain(), { ids: [], workerIds: [] })
    journal.note('a', true)
    assert.deepEqual(journal.drain(), { ids: ['a'], workerIds: ['a'] })
  })
})
