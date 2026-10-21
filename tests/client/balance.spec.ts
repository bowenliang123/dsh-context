import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import {
  balanceEntryOf,
  PLATFORM_BALANCE_STORAGE_KEY,
  platformBalanceOf,
  readPlatformBalance,
  resetPlatformBalance,
  setPlatformBalanceStorage,
  type StorageFace,
} from '../../src/client/balance'
import type { PlatformBalance } from '../../src/shared/types'

const WIRE_BALANCE = {
  isAvailable: true,
  balances: [
    { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
    { currency: 'USD', total: 1.5, granted: 0.5, toppedUp: 1 },
  ],
}

function wire(total: number): { isAvailable: boolean; balances: { currency: string; total: number; granted: number; toppedUp: number }[] } {
  return { isAvailable: true, balances: [{ currency: 'CNY', total, granted: 0, toppedUp: total }] }
}

function stubRoute(body: unknown | undefined, mode: 'ok' | 'reject' | 'status' = 'ok'): { calls: () => number } {
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    if (mode === 'reject') throw new Error('down')
    if (mode === 'status') return { ok: false, status: 404, json: async () => ({}) }
    return { ok: true, status: 200, json: async () => body }
  })
  return { calls: () => n }
}

function gatedRoute(): { release: () => void; calls: () => number } {
  let release!: () => void
  const gate = new Promise<void>((resolve) => { release = resolve })
  let n = 0
  vi.stubGlobal('fetch', async () => {
    n++
    await gate
    return { ok: true, json: async () => ({ ok: true, value: WIRE_BALANCE }) }
  })
  return { release, calls: () => n }
}

class FakeStorage implements StorageFace {
  store = new Map<string, string>()
  constructor(seed?: Record<string, string>) {
    for (const [k, v] of Object.entries(seed ?? {})) this.store.set(k, v)
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value)
  }
  removeItem(key: string): void {
    this.store.delete(key)
  }
}

async function drain(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function collector(): { seen: PlatformBalance[]; onRefresh: (v: PlatformBalance) => void } {
  const seen: PlatformBalance[] = []
  return { seen, onRefresh: (v) => seen.push(v) }
}

function seededStorage(): FakeStorage {
  const fake = new FakeStorage({ [PLATFORM_BALANCE_STORAGE_KEY]: JSON.stringify(WIRE_BALANCE) })
  setPlatformBalanceStorage(fake)
  return fake
}

function clearRealStorage(): void {
  try {
    globalThis.localStorage.clear()
  } catch {
  }
}

beforeEach(() => {
  resetPlatformBalance()
  clearRealStorage()
})

afterEach(() => {
  resetPlatformBalance()
  clearRealStorage()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('platformBalanceOf', () => {
  test('a delivered wire balance parses whole', () => {
    assert.deepEqual(platformBalanceOf(WIRE_BALANCE), WIRE_BALANCE)
  })

  test('absent or non-record payloads are no balance', () => {
    assert.equal(platformBalanceOf(undefined), null)
    assert.equal(platformBalanceOf(null), null)
    assert.equal(platformBalanceOf('balance'), null)
    assert.equal(platformBalanceOf([]), null)
  })

  test('a payload with no valid entry is no balance', () => {
    assert.equal(platformBalanceOf({ isAvailable: true }), null)
    assert.equal(platformBalanceOf({ balances: 'CNY' }), null)
    assert.equal(platformBalanceOf({ balances: [null, 'CNY', [], {}] }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: '', total: 1, granted: 0, toppedUp: 0 }],
    }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: 'CNY', total: 'abc', granted: 0, toppedUp: 0 }],
    }), null)
    assert.equal(platformBalanceOf({
      balances: [{ currency: 'CNY', total: -1, granted: 0, toppedUp: 0 }],
    }), null)
  })

  test('entries failing the shape drop whole, valid siblings survive', () => {
    const balance = platformBalanceOf({
      isAvailable: false,
      balances: [
        null,
        { currency: 'EUR', total: 2, granted: 0 },
        { currency: 'EUR', total: 2, granted: 0, toppedUp: 2 },
      ],
    })
    assert.deepEqual(balance, {
      isAvailable: false,
      balances: [{ currency: 'EUR', total: 2, granted: 0, toppedUp: 2 }],
    })
  })

  test('a hostile entry throwing on property access drops without throwing', () => {
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    assert.equal(platformBalanceOf({ balances: [hostile] }), null)
    const mixed = platformBalanceOf({ balances: [hostile, WIRE_BALANCE.balances[0]] })
    assert.deepEqual(mixed?.balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }])
  })
})

describe('balanceEntryOf', () => {
  test('absent or empty balances pick nothing', () => {
    assert.equal(balanceEntryOf(null, 'cny'), null)
    assert.equal(balanceEntryOf(undefined, 'usd'), null)
    assert.equal(balanceEntryOf({ isAvailable: true, balances: [] }, 'cny'), null)
  })

  test('the display currency wins; the account\'s first currency is the fallback', () => {
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'cny'), WIRE_BALANCE.balances[0])
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'usd'), WIRE_BALANCE.balances[1])
    const eurOnly = platformBalanceOf({ balances: [{ currency: 'EUR', total: 2, granted: 0, toppedUp: 2 }] })
    assert.deepEqual(balanceEntryOf(eurOnly, 'usd'), eurOnly?.balances[0] ?? null)
  })

  test('a zero entry never shadows the funded one', () => {
    // A CNY account also answers a zero USD entry, so the display currency alone would paint $0.00.
    const cnyFunded = platformBalanceOf({
      balances: [
        { currency: 'CNY', total: 58.97, granted: 0, toppedUp: 58.97 },
        { currency: 'USD', total: 0, granted: 0, toppedUp: 0 },
      ],
    })
    assert.deepEqual(balanceEntryOf(cnyFunded, 'usd'), cnyFunded?.balances[0])
    assert.deepEqual(balanceEntryOf(cnyFunded, 'cny'), cnyFunded?.balances[0])
  })

  test('an all-zero account falls back to the display currency, then to its first entry', () => {
    const allZero = platformBalanceOf({
      balances: [
        { currency: 'CNY', total: 0, granted: 0, toppedUp: 0 },
        { currency: 'USD', total: 0, granted: 0, toppedUp: 0 },
      ],
    })
    assert.deepEqual(balanceEntryOf(allZero, 'usd'), allZero?.balances[1], 'nothing funded: the display currency still names one')
    const eurZero = platformBalanceOf({ balances: [{ currency: 'EUR', total: 0, granted: 0, toppedUp: 0 }] })
    assert.deepEqual(balanceEntryOf(eurZero, 'usd'), eurZero?.balances[0], 'an account without the wanted currency shows its first entry')
  })
})

describe('readPlatformBalance', () => {
  test('nothing remembered shows nothing while the first read is pending', async () => {
    const { release } = gatedRoute()
    const { seen, onRefresh } = collector()
    assert.equal(readPlatformBalance(onRefresh), null, 'no remembered figure to paint')
    release()
    await drain()
    assert.equal(seen.length, 1, 'the read still lands once answered')
  })

  test('a landing figure reports through the refresh and is served from memory next time', async () => {
    const { calls } = stubRoute({ ok: true, value: WIRE_BALANCE })
    const first = collector()
    assert.equal(readPlatformBalance(first.onRefresh), null, 'the first open has nothing to paint')
    await drain()
    assert.deepEqual(first.seen, [WIRE_BALANCE])
    assert.equal(calls(), 1)

    const second = collector()
    assert.deepEqual(readPlatformBalance(second.onRefresh), WIRE_BALANCE, 'the memory figure paints at once')
    await drain()
    assert.deepEqual(second.seen, [WIRE_BALANCE])
    assert.equal(calls(), 2, 'every open revalidates regardless of what it could paint')
  })

  test('the stored figure paints before the read lands, then the live one replaces it', async () => {
    seededStorage()
    const fresh = wire(99)
    stubRoute({ ok: true, value: fresh })
    const { seen, onRefresh } = collector()
    assert.deepEqual(readPlatformBalance(onRefresh), WIRE_BALANCE, 'the stored figure shows at once')
    await drain()
    assert.deepEqual(seen, [fresh])
    assert.deepEqual(readPlatformBalance(() => {}), fresh, 'memory now outranks storage')
  })

  test('an open while a read is in flight joins that read and lands with it (issue #82)', async () => {
    const { release, calls } = gatedRoute()
    const a = collector()
    const b = collector()
    assert.equal(readPlatformBalance(a.onRefresh), null)
    assert.equal(readPlatformBalance(b.onRefresh), null, 'nothing remembered until a read lands')
    await Promise.resolve()
    release()
    await drain()
    assert.deepEqual(a.seen, [WIRE_BALANCE], 'the open that started the read reports its figure')
    assert.deepEqual(b.seen, [WIRE_BALANCE], 'the joining open takes the landing for its own too')
    assert.equal(calls(), 1, 'one read serves both opens')
    assert.deepEqual(readPlatformBalance(() => {}), WIRE_BALANCE, 'and the joined read is the memory figure afterwards')
  })

  test('a joiner after one read landed starts a fresh read of its own', async () => {
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const first = collector()
    readPlatformBalance(first.onRefresh)
    await drain()
    const gated = gatedRoute()
    const second = collector()
    assert.deepEqual(readPlatformBalance(second.onRefresh), WIRE_BALANCE, 'the memory figure paints at once')
    await Promise.resolve()
    gated.release()
    await drain()
    assert.deepEqual(second.seen, [WIRE_BALANCE], 'its own read revalidates and reports')
    assert.equal(gated.calls(), 1, 'the fresh read went through the new gate')
  })

  test('every absent answer notifies nobody and keeps the remembered figure', async () => {
    for (const [label, body, mode] of [
      ['route absent (404)', undefined, 'status'],
      ['transport down', undefined, 'reject'],
      ['definitive absence', { ok: true, value: null }, 'ok'],
      ['bad envelope', { ok: false }, 'ok'],
      ['value not a record', { ok: true, value: 'nope' }, 'ok'],
    ] as [string, unknown, 'ok' | 'reject' | 'status'][]) {
      resetPlatformBalance()
      seededStorage()
      stubRoute(body, mode)
      const { seen, onRefresh } = collector()
      assert.deepEqual(readPlatformBalance(onRefresh), WIRE_BALANCE, label)
      await drain()
      assert.equal(seen.length, 0, label)
      assert.deepEqual(readPlatformBalance(() => {}), WIRE_BALANCE, label + ' — the figure survives the miss')
    }
  })

  test('garbage in storage is no remembered figure', async () => {
    stubRoute({ ok: true, value: WIRE_BALANCE })
    for (const raw of ['not json', 'null', '"CNY"', '{"isAvailable":true}', '{"balances":[{"currency":"CNY"}]}']) {
      resetPlatformBalance()
      setPlatformBalanceStorage(new FakeStorage({ [PLATFORM_BALANCE_STORAGE_KEY]: raw }))
      const { onRefresh } = collector()
      assert.equal(readPlatformBalance(onRefresh), null, raw)
      await drain()
      assert.deepEqual(readPlatformBalance(() => {}), WIRE_BALANCE)
    }
  })

  test('unreadable storage costs the head start, never the read', async () => {
    const throwing = new FakeStorage()
    vi.spyOn(throwing, 'getItem').mockImplementation(() => { throw new Error('denied') })
    setPlatformBalanceStorage(throwing)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const { seen, onRefresh } = collector()
    assert.equal(readPlatformBalance(onRefresh), null, 'no remembered figure to paint')
    await drain()
    assert.deepEqual(seen, [WIRE_BALANCE])
  })

  test('unwritable storage never blocks the live figure', async () => {
    const refusing = new FakeStorage()
    vi.spyOn(refusing, 'setItem').mockImplementation(() => { throw new Error('quota') })
    setPlatformBalanceStorage(refusing)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const { seen, onRefresh } = collector()
    readPlatformBalance(onRefresh)
    await drain()
    assert.deepEqual(seen, [WIRE_BALANCE])
  })

  test('absent storage is the same as empty storage', async () => {
    setPlatformBalanceStorage(undefined)
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: undefined })
    try {
      stubRoute({ ok: true, value: WIRE_BALANCE })
      const { seen, onRefresh } = collector()
      assert.equal(readPlatformBalance(onRefresh), null)
      await drain()
      assert.deepEqual(seen, [WIRE_BALANCE], 'the read is unaffected')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real as PropertyDescriptor)
    }
  })

  test('storage itself can be refused: no remembered figure, no crash', async () => {
    setPlatformBalanceStorage(undefined)
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('denied') } })
    try {
      stubRoute({ ok: true, value: WIRE_BALANCE })
      const { seen, onRefresh } = collector()
      assert.equal(readPlatformBalance(onRefresh), null)
      await drain()
      assert.deepEqual(seen, [WIRE_BALANCE], 'the read is unaffected')
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real as PropertyDescriptor)
    }
  })

  test('a reset drops the remembered figure, its storage, and the storage swap', async () => {
    const fake = seededStorage()
    stubRoute({ ok: true, value: WIRE_BALANCE })
    readPlatformBalance(() => {})
    await drain()
    resetPlatformBalance()
    assert.equal(fake.store.has(PLATFORM_BALANCE_STORAGE_KEY), false, 'storage is emptied')
    const { onRefresh } = collector()
    assert.equal(readPlatformBalance(onRefresh), null, 'real storage is re-detected, and it is empty too')
  })

  test('a reset over refused storage still clears the memory figure', async () => {
    setPlatformBalanceStorage(null)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    readPlatformBalance(() => {})
    await drain()
    assert.deepEqual(readPlatformBalance(() => {}), WIRE_BALANCE)
    resetPlatformBalance()
    assert.equal(readPlatformBalance(() => {}), null)
  })
})
