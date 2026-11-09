import { amountOf } from '../shared/decode'
import type { PlatformBalance, PlatformBalanceEntry } from '../shared/types'
import { BALANCE_ROUTE } from './apiRoutes'
import { postRouteQuietly } from './route'
import { asRecord } from './services'

const STORAGE_KEY = 'dsh-context:platform-balance'

export const BALANCE_STORAGE_TTL_MS = 10 * 60 * 1000

export interface StorageFace {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

export function setPlatformBalanceStorage(next: StorageFace | null | undefined): void {
  storage = next
}

export const PLATFORM_BALANCE_STORAGE_KEY = STORAGE_KEY

export function platformBalanceOf(value: unknown): PlatformBalance | null {
  const data = asRecord(value)
  if (data === null) return null
  const infos = Array.isArray(data.balances) ? data.balances : []
  const balances: PlatformBalanceEntry[] = []
  for (const info of infos) {
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

export function balanceEntryOf(
  balance: PlatformBalance | null | undefined,
  currency: 'cny' | 'usd',
): PlatformBalanceEntry | null {
  if (balance === null || balance === undefined || balance.balances.length === 0) return null
  const want = currency === 'cny' ? 'CNY' : 'USD'
  return balance.balances.find(entry => entry.currency === want) ?? balance.balances[0]
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
    storage = null
  }
  return storage
}

function storedBalance(): PlatformBalance | null {
  try {
    const raw = storageFn()?.getItem(STORAGE_KEY)
    if (raw === null || raw === undefined) return null
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return platformBalanceOf(parsed)
    const envelope = parsed as Record<string, unknown>
    if (typeof envelope.at !== 'number' || !Number.isFinite(envelope.at)) return platformBalanceOf(parsed)
    if (Date.now() - envelope.at > BALANCE_STORAGE_TTL_MS) {
      storageFn()?.removeItem(STORAGE_KEY)
      return null
    }
    return platformBalanceOf(envelope.balance)
  } catch {
    return null
  }
}

function rememberBalance(value: PlatformBalance | null): void {
  try {
    storageFn()?.setItem(STORAGE_KEY, JSON.stringify({ at: Date.now(), balance: value }))
  } catch {
  }
}

async function readRoute(): Promise<PlatformBalance | null> {
  return postRouteQuietly(BALANCE_ROUTE, {}, platformBalanceOf)
}

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
  }
  storage = undefined
}
