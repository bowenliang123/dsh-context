/**
 * The client's wallet-balance read (host/balance.ts route): the Context card
 * shows what is LEFT in the provider account beside its cost estimates. One
 * same-origin GET per refresh while the card is subscribed, kicked on the
 * first subscribe; a failed or absent route keeps the last accepted value and
 * retries with a doubling backoff (never a spinner, never an unhandled
 * rejection), and a card that never receives one simply renders no balance
 * cell.
 *
 * The delivered envelope is untrusted wire input, so `walletBalanceOf`
 * re-proves it at the boundary: only a finite non-negative amount and a known
 * currency are accepted; anything else is a failed read (the retry path).
 */

import { useSyncExternalStore } from 'react'
import { asRecord } from './services'
import type { WalletBalance } from '../shared/types'

/** The host route this store reads (host/balance.ts). */
export const BALANCE_ROUTE = '/api/dsh-context/balance'

/** The steady refresh cadence: the wallet moves slowly, and this keeps it honest. */
const REFRESH_MS = 30_000

/** The retry backoff base; each consecutive failure doubles the wait, capped at 3 doublings. */
const RETRY_BASE_MS = 30_000

/**
 * Re-prove one delivered `{ ok, value }` envelope at the boundary: the wallet
 * value, or null when the envelope is absent, failed, or malformed.
 */
export function walletBalanceOf(value: unknown): WalletBalance | null {
  const record = asRecord(value)
  if (record === null) return null
  const amount = record.amount
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount < 0) return null
  const currency = record.currency === 'usd' ? 'usd' : record.currency === 'cny' ? 'cny' : null
  if (currency === null) return null
  return { currency, amount }
}
/** One raw route read; the store owns the envelope sanitizing. */
type Loader = () => Promise<unknown>

const defaultLoader: Loader = async () => {
  const response = await fetch(BALANCE_ROUTE, { cache: 'no-store' })
  if (!response.ok) throw new Error(`dsh-context: balance route HTTP ${response.status}`)
  return await response.json() as unknown
}

let loader: Loader = defaultLoader
let snap: WalletBalance | null = null
let inFlight = false
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

/** Arm the next read: the steady cadence while healthy, a doubling wait after failures. */
function arm(): void {
  if (listeners.size === 0 || timer !== null) return
  timer = setTimeout(() => {
    timer = null
    void fire()
  }, failures === 0 ? REFRESH_MS : RETRY_BASE_MS * 2 ** Math.min(failures - 1, 3))
}

async function fire(): Promise<void> {
  inFlight = true
  try {
    const body = asRecord(await loader())
    const value = body !== null && body.ok === true ? walletBalanceOf(body.value) : null
    if (value !== null) {
      snap = value
      failures = 0
    } else {
      failures++
    }
  } catch {
    failures++
  }
  inFlight = false
  arm()
  for (const fn of listeners) fn()
}

/** The useSyncExternalStore seam: subscribing also kicks the first read. */
export const subscribeWalletBalance = (fn: () => void): (() => void) => {
  listeners.add(fn)
  if (timer === null && !inFlight && snap === null) void fire()
  return () => {
    listeners.delete(fn)
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
}

export const getWalletBalanceSnap = (): WalletBalance | null => snap

/** The Context card's read of the account wallet (null until a read lands). */
export function useWalletBalance(): WalletBalance | null {
  return useSyncExternalStore(subscribeWalletBalance, getWalletBalanceSnap)
}

/** Test isolation: drop the value, the timer, and the listeners. */
export function resetWalletBalance(): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  snap = null
  inFlight = false
  failures = 0
  listeners.clear()
}

/** Test seam: replace the route read with a stub; null restores the default. */
export function setWalletBalanceLoader(next: Loader | null): void {
  loader = next ?? defaultLoader
}
