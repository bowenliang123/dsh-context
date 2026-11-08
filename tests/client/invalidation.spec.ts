import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { invalidate, resetInvalidations, subscribeInvalidations } from '../../src/client/invalidation'
import type { InvalidationEvent } from '../../src/client/invalidation'

describe('invalidation seam', () => {
  test('events deliver kind plus only the provided scope fields', () => {
    const seen: InvalidationEvent[] = []
    const off = subscribeInvalidations(event => { seen.push(event) })
    try {
      invalidate('overview')
      invalidate('sessions', { revision: 4 })
      invalidate('heads', { sessionId: 's1' })
      invalidate('pricing', { sessionId: 's1', revision: 2 })
      assert.deepEqual(seen, [
        { kind: 'overview' },
        { kind: 'sessions', revision: 4 },
        { kind: 'heads', sessionId: 's1' },
        { kind: 'pricing', sessionId: 's1', revision: 2 },
      ])
    } finally {
      off()
      resetInvalidations()
    }
  })

  test('unsubscribe and reset stop delivery, including listeners changed mid-dispatch', () => {
    const seen: string[] = []
    const second = (event: InvalidationEvent): void => { seen.push('second:' + event.kind) }
    const offFirst = subscribeInvalidations(() => {
      seen.push('first')
      offFirst()
      offSecond()
    })
    const offSecond = subscribeInvalidations(second)
    try {
      invalidate('fleet')
      assert.deepEqual(seen, ['first', 'second:fleet'])
      invalidate('fleet')
      assert.deepEqual(seen, ['first', 'second:fleet'])
      subscribeInvalidations(event => { seen.push('third:' + event.kind) })
      resetInvalidations()
      invalidate('overview')
      assert.deepEqual(seen, ['first', 'second:fleet'])
    } finally {
      offFirst()
      offSecond()
      resetInvalidations()
    }
  })

  test('a listener added during dispatch runs from the next event only', () => {
    const seen: string[] = []
    const off = subscribeInvalidations(() => {
      seen.push('outer')
      subscribeInvalidations(() => { seen.push('inner') })
    })
    try {
      invalidate('fleet')
      assert.deepEqual(seen, ['outer'])
      invalidate('fleet')
      assert.deepEqual(seen, ['outer', 'outer', 'inner'])
    } finally {
      off()
      resetInvalidations()
    }
  })
})
