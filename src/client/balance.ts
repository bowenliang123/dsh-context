/** The Insights header balance: the remembered figure paints at once, one background route read corrects it. */

import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { BALANCE_ROUTE } from './apiRoutes'
import { asRecord } from './services'

const STORAGE_KEY = 'dsh-context:platform-balance'

export interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function setPlatformBalanceStorage(next: StorageFace | null | undefined): void {
  storage = next
}

export const PLATFORM_BALANCE_STORAGE_KEY = STORAGE_KEY

function amountOf(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null
}

export function platformBalanceOf(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
    // A hostile entry may throw on access; it drops whole, the entries that prove their shape serve on.
    try {
      const entry = asRecord(info)
      if (entry === null) continue
      const currency = entry.currency
      const total = amountOf(entry.total)
      const granted = amountOf(entry.granted)
      const toppedUp = amountOf(entry.toppedUp)
      if (typeof currency !== 'string' || currency === ''
        || total === null || granted === null || toppedUp === null) continue
      balances.push({ currency, total, granted, toppedUp })
    } catch {
      continue
    }
  }
  return balances.length > 0
    ? { isAvailable: data.isAvailable === true, balances }
    : null
}

/** A funded entry beats a zero one; a figure in another currency beats none. */
export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalanceEntry | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const want = currency === 'cny' ? 'CNY' : 'USD'
  const preferred = balance.balances.find(entry => entry.currency === want)
  if (preferred !== undefined && preferred.total > 0) return preferred
  return balance.balances.find(entry => entry.total > 0) ?? preferred ?? balance.balances[0]
}

let cached: PlatformBalance | null = null
let refreshing: Promise<void> | null = null
const landingCallbacks = new Set<(value: PlatformBalance) => void>()

let storage: StorageFace | null | undefined

function storageFn(): StorageFace | null {
  if (storage !== undefined) return storage
  try {
    const found: unknown = globalThis.localStorage
    storage = found === null || found === undefined ? null : found as StorageFace
  } catch {
    // Some privacy modes throw on mere storage access.
    storage = null
  }
  return storage
}

function storedBalance(): PlatformBalance | null {
  try {
    const raw = storageFn()?.getItem(STORAGE_KEY)
    return raw === null || raw === undefined ? null : platformBalanceOf(JSON.parse(raw))
  } catch {
    return null
  }
}

function rememberBalance(value: PlatformBalance | null): void {
  try {
    storageFn()?.setItem(STORAGE_KEY, JSON.stringify(value))
  } catch {
    // A refused write costs only the next open's head start; the live figure renders.
  }
}

async function readRoute(): Promise<PlatformBalance | null> {
  try {
    const response = await fetch(BALANCE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    if (!response.ok) return null
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true || r.value === null || r.value === undefined) return null
    return platformBalanceOf(r.value)
  } catch {
    return null
  }
}

/** One route read per open, `onRefresh` on landing; `refreshing` is assigned before awaiting so opens join it. */
export function readPlatformBalance(onRefresh: (value: PlatformBalance) => void): PlatformBalance | null {
  landingCallbacks.add(onRefresh)
  if (refreshing === null) {
    refreshing = (async () => {
      const value = await readRoute()
      if (value === null) return
      cached = value
      rememberBalance(value)
      for (const waiter of landingCallbacks) waiter(value)
    })().finally(() => {
      refreshing = null
      landingCallbacks.clear()
    })
  }
  return cached ?? storedBalance()
}

export function resetPlatformBalance(): void {
  cached = null
  refreshing = null
  landingCallbacks.clear()
  try {
    storageFn()?.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to drop */
  }
  storage = undefined
}
