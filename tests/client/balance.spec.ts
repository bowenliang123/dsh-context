// The wallet-balance store (src/client/balance.ts): the boundary sanitizer over
// the delivered envelope, and the store's kick-on-first-subscribe, the
// kept-value-on-failure path and the backed-off automatic retry (the route read
// is loader-injected).

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import type { WalletBalance } from '../../src/shared/types'
import {
  getWalletBalanceSnap,
  resetWalletBalance,
  setWalletBalanceLoader,
  subscribeWalletBalance,
  walletBalanceOf,
} from '../../src/client/balance'

/** One delivered route envelope. */
function envelope(value: unknown): object {
  return { ok: true, value }
}

describe('walletBalanceOf', () => {
  test('accepts a finite non-negative amount with a known currency', () => {
    assert.deepEqual(walletBalanceOf({ currency: 'cny', amount: 0 }), { currency: 'cny', amount: 0 })
    assert.deepEqual(walletBalanceOf({ currency: 'usd', amount: 12.34 }), { currency: 'usd', amount: 12.34 })
  })

  test('an unknown or absent currency drops the value', () => {
    assert.equal(walletBalanceOf({ currency: 'jpy', amount: 1 }), null)
    assert.equal(walletBalanceOf({ amount: 1 }), null)
  })

  test('untrustworthy amounts and non-records drop the value', () => {
    assert.equal(walletBalanceOf({ currency: 'cny', amount: '1' }), null)
    assert.equal(walletBalanceOf({ currency: 'cny', amount: Number.NaN }), null)
    assert.equal(walletBalanceOf({ currency: 'cny', amount: Number.POSITIVE_INFINITY }), null)
    assert.equal(walletBalanceOf({ currency: 'cny', amount: -1 }), null)
    assert.equal(walletBalanceOf(null), null)
    assert.equal(walletBalanceOf('x'), null)
    assert.equal(walletBalanceOf([]), null)
  })
})

describe('the wallet store', () => {
  /** Drain the fire() promise chain (fake timers keep setTimeout inert). */
  async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  }

  beforeEach(() => {
    vi.useFakeTimers()
    resetWalletBalance()
  })

  afterEach(() => {
    resetWalletBalance()
    vi.useRealTimers()
  })

  test('the first subscribe kicks one read and publishes the value', async () => {
    let calls = 0
    setWalletBalanceLoader(async () => {
      calls++
      return envelope({ currency: 'cny', amount: 1.84 })
    })
    const seen: (WalletBalance | null)[] = []
    const un = subscribeWalletBalance(() => seen.push(getWalletBalanceSnap()))
    await settle()
    assert.equal(calls, 1)
    assert.deepEqual(getWalletBalanceSnap(), { currency: 'cny', amount: 1.84 })
    // A second subscriber re-uses the same store: no extra read.
    const un2 = subscribeWalletBalance(() => {})
    await settle()
    assert.equal(calls, 1)
    un()
    un2()
  })

  test('a failed read keeps the last value and retries with a doubling wait', async () => {
    let calls = 0
    setWalletBalanceLoader(async () => {
      calls++
      if (calls === 1) return envelope({ currency: 'cny', amount: 9 })
      throw new Error('route down')
    })
    const un = subscribeWalletBalance(() => {})
    await settle()
    assert.deepEqual(getWalletBalanceSnap(), { currency: 'cny', amount: 9 })
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(getWalletBalanceSnap(), { currency: 'cny', amount: 9 })
    await vi.advanceTimersByTimeAsync(29_999)
    await settle()
    assert.equal(calls, 2)
    await vi.advanceTimersByTimeAsync(1)
    await settle()
    assert.equal(calls, 3)
    un()
  })

  test('a malformed envelope is a failed read, never a throw', async () => {
    let calls = 0
    setWalletBalanceLoader(async () => {
      calls++
      return { ok: true, value: { currency: 'cny', amount: 'junk' } }
    })
    const un = subscribeWalletBalance(() => {})
    await settle()
    assert.equal(getWalletBalanceSnap(), null)
    assert.equal(calls, 1)
    un()
  })

  test('the steady cadence keeps the value fresh while subscribed', async () => {
    let calls = 0
    setWalletBalanceLoader(async () => {
      calls++
      return envelope({ currency: 'cny', amount: calls })
    })
    const un = subscribeWalletBalance(() => {})
    await settle()
    await vi.advanceTimersByTimeAsync(30_000)
    await settle()
    assert.equal(calls, 2)
    assert.deepEqual(getWalletBalanceSnap(), { currency: 'cny', amount: 2 })
    un()
  })

  test('the last unsubscribe stops the polling', async () => {
    let calls = 0
    setWalletBalanceLoader(async () => {
      calls++
      return envelope({ currency: 'cny', amount: 1 })
    })
    const un = subscribeWalletBalance(() => {})
    await settle()
    un()
    await vi.advanceTimersByTimeAsync(120_000)
    await settle()
    assert.equal(calls, 1)
  })
})