import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { noteCostPending, notePricingPending, registerCostRefresh, resetCostRefresh } from '../../src/client/costRefresh'
import { resetInvalidations, subscribeInvalidations } from '../../src/client/invalidation'

const PENDING = { usd: null, ready: false }

let kinds: string[] = []

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
}

beforeEach(() => {
  vi.useFakeTimers()
  resetCostRefresh()
  resetInvalidations()
  kinds = []
  subscribeInvalidations((event) => { kinds.push(event.kind) })
})

afterEach(() => {
  resetCostRefresh()
  resetInvalidations()
  vi.useRealTimers()
})

describe('noteCostPending', () => {
  test('walks the pending ladder 1.5s → 4s → 10s and stops after three attempts', async () => {
    noteCostPending(PENDING)
    assert.equal(vi.getTimerCount(), 1)
    await advance(1_499)
    assert.deepEqual(kinds, [])
    await advance(1)
    assert.deepEqual(kinds, ['pricing'])
    assert.equal(vi.getTimerCount(), 0, 'the invalidation-triggered refetch re-arms the next rung')
    noteCostPending(PENDING)
    await advance(4_000)
    assert.deepEqual(kinds, ['pricing', 'pricing'])
    noteCostPending(PENDING)
    await advance(10_000)
    assert.deepEqual(kinds, ['pricing', 'pricing', 'pricing'])
    assert.equal(vi.getTimerCount(), 0)
    noteCostPending(PENDING)
    assert.equal(vi.getTimerCount(), 0, 'a pending read after three attempts arms nothing')
    await advance(100_000)
    assert.equal(kinds.length, 3)
  })

  test('repeated pending notes reuse the armed timer instead of stacking', async () => {
    noteCostPending(PENDING)
    noteCostPending(PENDING)
    noteCostPending(PENDING)
    assert.equal(vi.getTimerCount(), 1)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing'])
    assert.equal(vi.getTimerCount(), 0)
  })

  test('a ready read resets the ladder but never cancels another source pending retry', async () => {
    noteCostPending(PENDING)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing'])
    noteCostPending(PENDING)
    assert.equal(vi.getTimerCount(), 1)
    noteCostPending({ usd: 0.5, ready: true })
    assert.equal(vi.getTimerCount(), 1, 'a ready read from another source keeps the armed refresh')
    await advance(4_000)
    assert.deepEqual(kinds, ['pricing', 'pricing'])
    noteCostPending(PENDING)
    await advance(10_000)
    assert.deepEqual(kinds, ['pricing', 'pricing', 'pricing'], 'the ready read restarted the ladder')
  })

  test('an undefined or null read is a no-op', async () => {
    noteCostPending(undefined)
    noteCostPending(null)
    assert.equal(vi.getTimerCount(), 0)
    await advance(100_000)
    assert.deepEqual(kinds, [])
  })

  test('a ready read after the ladder is exhausted restarts it', async () => {
    noteCostPending(PENDING)
    await advance(1_500)
    noteCostPending(PENDING)
    await advance(4_000)
    noteCostPending(PENDING)
    await advance(10_000)
    assert.equal(kinds.length, 3)
    noteCostPending(PENDING)
    await advance(100_000)
    assert.equal(kinds.length, 3)
    noteCostPending({ usd: 0.5, ready: true })
    noteCostPending(PENDING)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing', 'pricing', 'pricing', 'pricing'])
  })
})

describe('notePricingPending', () => {
  test('a false flag walks the same pricing-invalidation ladder', async () => {
    notePricingPending(false)
    await advance(1_500)
    notePricingPending(false)
    await advance(4_000)
    notePricingPending(false)
    await advance(10_000)
    assert.deepEqual(kinds, ['pricing', 'pricing', 'pricing'])
    assert.equal(vi.getTimerCount(), 0)
  })

  test('a true flag resets the ladder without cancelling the pending retry', async () => {
    notePricingPending(false)
    await advance(1_500)
    notePricingPending(false)
    assert.equal(vi.getTimerCount(), 1)
    notePricingPending(true)
    assert.equal(vi.getTimerCount(), 1)
    await advance(4_000)
    assert.deepEqual(kinds, ['pricing', 'pricing'])
    notePricingPending(false)
    await advance(10_000)
    assert.deepEqual(kinds, ['pricing', 'pricing', 'pricing'])
  })

  test('an undefined flag is a no-op', async () => {
    notePricingPending(undefined)
    assert.equal(vi.getTimerCount(), 0)
    await advance(100_000)
    assert.deepEqual(kinds, [])
  })
})

describe('resetCostRefresh', () => {
  test('clears the armed timer and the ladder, and is safe without either', async () => {
    resetCostRefresh()
    assert.equal(vi.getTimerCount(), 0)
    noteCostPending(PENDING)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing'])
    noteCostPending(PENDING)
    assert.equal(vi.getTimerCount(), 1)
    resetCostRefresh()
    assert.equal(vi.getTimerCount(), 0, 'the armed retry is cleared')
    await advance(100_000)
    assert.equal(kinds.length, 1)
    noteCostPending(PENDING)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing', 'pricing'], 'the reset restarted the ladder')
  })
})

describe('registerCostRefresh', () => {
  test('the retry fire also refreshes projections and unregister stops it', async () => {
    const refreshed: number[] = []
    const off = registerCostRefresh(() => { refreshed.push(1) })
    noteCostPending(PENDING)
    await advance(1_500)
    assert.deepEqual(kinds, ['pricing'])
    assert.deepEqual(refreshed, [1])
    off()
    noteCostPending(PENDING)
    await advance(4_000)
    assert.deepEqual(refreshed, [1], 'the unregistered hook is not called')
    const other = registerCostRefresh(() => { refreshed.push(2) })
    registerCostRefresh(null)
    other()
    noteCostPending(PENDING)
    await advance(10_000)
    assert.deepEqual(refreshed, [1])
  })
})
