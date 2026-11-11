// @vitest-environment node

import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { balanceEntryOf, PLATFORM_BALANCE_STORAGE_KEY, platformBalanceOf, readPlatformBalance, resetPlatformBalance, setPlatformBalanceStorage, type StorageFace } from '../../src/client/balance'
import { type PlatformBalance } from '../../src/shared/types'
import { overviewValueOf } from '../../src/client/overviewSource'
import { BASE_COVERAGE, daysValue, pageValue, summaryRaw, summaryValue, tallyValue } from './helpers/overviewWire'

describe('balance', () => {

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
  test('a delivered wire balance parses whole; absent, shapeless, or entry-less payloads are no balance', () => {
    assert.deepEqual(platformBalanceOf(WIRE_BALANCE), WIRE_BALANCE)
    assert.equal(platformBalanceOf(undefined), null)
    assert.equal(platformBalanceOf(null), null)
    assert.equal(platformBalanceOf('balance'), null)
    assert.equal(platformBalanceOf([]), null)
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

  test('entries failing the shape or throwing on property access drop whole; valid siblings survive', () => {
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
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    assert.equal(platformBalanceOf({ balances: [hostile] }), null)
    const mixed = platformBalanceOf({ balances: [hostile, WIRE_BALANCE.balances[0]] })
    assert.deepEqual(mixed?.balances, [{ currency: 'CNY', total: 110, granted: 10, toppedUp: 100 }])
  })
})

describe('balanceEntryOf', () => {
  test('absent or empty balances pick nothing; otherwise the display currency wins and the first entry falls back', () => {
    assert.equal(balanceEntryOf(null, 'cny'), null)
    assert.equal(balanceEntryOf(undefined, 'usd'), null)
    assert.equal(balanceEntryOf({ isAvailable: true, balances: [] }, 'cny'), null)
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'cny'), WIRE_BALANCE.balances[0])
    assert.deepEqual(balanceEntryOf(WIRE_BALANCE, 'usd'), WIRE_BALANCE.balances[1])
    const eurOnly = platformBalanceOf({ balances: [{ currency: 'EUR', total: 2, granted: 0, toppedUp: 2 }] })
    assert.deepEqual(balanceEntryOf(eurOnly, 'usd'), eurOnly?.balances[0] ?? null)
  })
})

describe('readPlatformBalance', () => {
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

  test('unreadable or unwritable storage costs the head start, never the live figure', async () => {
    const throwing = new FakeStorage()
    vi.spyOn(throwing, 'getItem').mockImplementation(() => { throw new Error('denied') })
    setPlatformBalanceStorage(throwing)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const { seen, onRefresh } = collector()
    assert.equal(readPlatformBalance(onRefresh), null, 'no remembered figure to paint')
    await drain()
    assert.deepEqual(seen, [WIRE_BALANCE])

    const refusing = new FakeStorage()
    vi.spyOn(refusing, 'setItem').mockImplementation(() => { throw new Error('quota') })
    setPlatformBalanceStorage(refusing)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const second = collector()
    readPlatformBalance(second.onRefresh)
    await drain()
    assert.deepEqual(second.seen, [WIRE_BALANCE], 'the live figure still lands')
  })

  test('absent or refused storage is the same as empty storage: no remembered figure, no crash', async () => {
    const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
    try {
      for (const descriptor of [
        { configurable: true, value: undefined },
        { configurable: true, get() { throw new Error('denied') } },
      ]) {
        setPlatformBalanceStorage(undefined)
        resetPlatformBalance()
        Object.defineProperty(globalThis, 'localStorage', descriptor)
        stubRoute({ ok: true, value: WIRE_BALANCE })
        const { seen, onRefresh } = collector()
        assert.equal(readPlatformBalance(onRefresh), null)
        await drain()
        assert.deepEqual(seen, [WIRE_BALANCE], 'the read is unaffected')
        vi.unstubAllGlobals()
      }
    } finally {
      Object.defineProperty(globalThis, 'localStorage', real as PropertyDescriptor)
    }
  })

  test('a reset drops the remembered figure, its storage, the storage swap, and even a refused figure', async () => {
    const fake = seededStorage()
    stubRoute({ ok: true, value: WIRE_BALANCE })
    readPlatformBalance(() => {})
    await drain()
    resetPlatformBalance()
    assert.equal(fake.store.has(PLATFORM_BALANCE_STORAGE_KEY), false, 'storage is emptied')
    const { onRefresh } = collector()
    assert.equal(readPlatformBalance(onRefresh), null, 'real storage is re-detected, and it is empty too')

    setPlatformBalanceStorage(null)
    stubRoute({ ok: true, value: WIRE_BALANCE })
    readPlatformBalance(() => {})
    await drain()
    assert.deepEqual(readPlatformBalance(() => {}), WIRE_BALANCE)
    resetPlatformBalance()
    assert.equal(readPlatformBalance(() => {}), null, 'a reset over refused storage still clears the memory figure')
  })
})


describe('platform balance storage ttl', () => {
  test('a fresh envelope paints; a stale envelope is dropped and removed', async () => {
    stubRoute({ ok: true, value: wire(5) })
    const fresh = new FakeStorage()
    setPlatformBalanceStorage(fresh)
    const { onRefresh } = collector()
    readPlatformBalance(onRefresh)
    await drain()
    const raw = fresh.store.get(PLATFORM_BALANCE_STORAGE_KEY)
    assert.ok(raw !== undefined && JSON.parse(raw).at !== undefined, 'the write carries a timestamp')

    const parsed = JSON.parse(raw) as { at: number; balance: unknown }
    const replay = new FakeStorage({ [PLATFORM_BALANCE_STORAGE_KEY]: JSON.stringify(parsed) })
    resetPlatformBalance()
    setPlatformBalanceStorage(replay)
    assert.deepEqual(readPlatformBalance(() => {}), wire(5), 'a fresh envelope paints at once')

    const stale = new FakeStorage({ [PLATFORM_BALANCE_STORAGE_KEY]: JSON.stringify({ at: Date.now() - 11 * 60_000, balance: parsed.balance }) })
    resetPlatformBalance()
    setPlatformBalanceStorage(stale)
    assert.equal(readPlatformBalance(() => {}), null, 'a stale envelope never paints')
    assert.equal(stale.store.has(PLATFORM_BALANCE_STORAGE_KEY), false, 'the stale entry is removed')
  })
})
})

describe('overviewValue', () => {

describe('overviewValueOf', () => {
  test('garbage, a missing revision, and a payload without a part reject', () => {
    for (const bad of [null, undefined, 7, 'x', [], {}, { revision: '' }, { revision: 7 }, { revision: 'r1' }]) {
      assert.equal(overviewValueOf(bad), null, `${JSON.stringify(bad)} decodes to null`)
    }
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true }), null, 'no part selects nothing')
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, other: 1 }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: 'yes', days: [] }), null, 'pricingReady must be a boolean')
    assert.equal(overviewValueOf({ revision: 'r1', unchanged: false, days: [] }), null, 'a false unchanged flag still needs pricingReady')
  })

  test('the unchanged reply decodes on its revision alone', () => {
    assert.deepEqual(overviewValueOf({ revision: 'r2', unchanged: true }), { revision: 'r2', unchanged: true })
    assert.deepEqual(
      overviewValueOf({ revision: 'r2', unchanged: true, pricingReady: 'ignored', days: [] }),
      { revision: 'r2', unchanged: true },
      'an unchanged reply needs no part payload',
    )
  })

  test('a valid summary normalizes every field', () => {
    const decoded = overviewValueOf(summaryValue())
    assert.deepEqual(decoded, {
      revision: 'r1',
      pricingReady: true,
      summary: {
        sessions: 2,
        sessionsTotal: 3,
        sessionsArchived: 1,
        archivedScoped: 1,
        tokens: 1800,
        turns: 5,
        costUsd: 0.5,
        costSessions: 1,
        usageSessions: 1,
        cacheHit: '33.33',
        tokenParts: [{ key: 'system', value: 100 }, { key: 'tools', value: 20 }],
        timing: { wallMs: 1000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
        coverage: BASE_COVERAGE,
      },
    })
  })

  test('a summary tolerates absent optional fields and a null cost', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: {
        sessions: 0,
        sessionsTotal: 0,
        tokens: 0,
        turns: 0,
        costUsd: null,
        costSessions: 0,
        usageSessions: 0,
        coverage: BASE_COVERAGE,
      },
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.equal(decoded.summary.sessionsArchived, 0)
    assert.equal(decoded.summary.archivedScoped, 0)
    assert.equal(decoded.summary.cacheHit, null)
    assert.equal(decoded.summary.tokenParts, null)
    assert.equal(decoded.summary.timing, null)
    const loose = overviewValueOf(summaryValue({
      summary: summaryRaw({ cacheHit: 42, sessionsArchived: -1, tokenParts: { not: 'an array' }, timing: null }),
    }))
    assert.ok(loose !== null && 'summary' in loose)
    assert.equal(loose.summary.cacheHit, null, 'a non-string hit rate reads absent')
    assert.equal(loose.summary.sessionsArchived, 0, 'a hostile archived count floors to zero')
    assert.equal(loose.summary.tokenParts, null)
    assert.equal(loose.summary.timing, null)
    const explicitNulls = overviewValueOf(summaryValue({ summary: summaryRaw({ cacheHit: null, tokenParts: null }) }))
    assert.ok(explicitNulls !== null && 'summary' in explicitNulls)
    assert.equal(explicitNulls.summary.cacheHit, null)
    assert.equal(explicitNulls.summary.tokenParts, null)
    const nonListParts = overviewValueOf(summaryValue({ summary: summaryRaw({ tokenParts: 'x' }) }))
    assert.ok(nonListParts !== null && 'summary' in nonListParts)
    assert.equal(nonListParts.summary.tokenParts, null, 'a non-list tokenParts reads absent')
  })

  test('hostile summary fields reject the whole summary part', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['sessions', { sessions: '2' }],
      ['sessions negative', { sessions: -1 }],
      ['sessionsTotal', { sessionsTotal: undefined }],
      ['tokens', { tokens: 'x' }],
      ['turns', { turns: -2 }],
      ['costSessions', { costSessions: null }],
      ['usageSessions', { usageSessions: '1' }],
      ['costUsd', { costUsd: 'free' }],
      ['coverage absent', { coverage: undefined }],
      ['coverage complete', { coverage: { ...BASE_COVERAGE, complete: 'yes' } }],
      ['coverage running', { coverage: { ...BASE_COVERAGE, running: 1 } }],
      ['coverage remaining', { coverage: { ...BASE_COVERAGE, remaining: -1 } }],
      ['coverage failed', { coverage: { ...BASE_COVERAGE, failed: 'x' } }],
      ['coverage total', { coverage: { ...BASE_COVERAGE, total: null } }],
      ['coverage covered', { coverage: { ...BASE_COVERAGE, covered: -1 } }],
      ['coverage unsupported', { coverage: { ...BASE_COVERAGE, unsupported: 'x' } }],
      ['coverage garbage', { coverage: 7 }],
    ]
    for (const [label, over] of cases) {
      assert.equal(overviewValueOf(summaryValue({ summary: summaryRaw(over) })), null, `${label} rejects`)
    }
  })

  test('a summary tokenParts list drops malformed entries and keeps usable keys', () => {
    const decoded = overviewValueOf(summaryValue({
      summary: summaryRaw({
        tokenParts: [
          { key: 'system', value: 5 },
          null,
          { key: '', value: 3 },
          { value: 4 },
          { key: 'tools' },
          { key: 'user', value: Number.NaN },
          { key: 'assistant', value: 0 },
        ],
      }),
    }))
    assert.ok(decoded !== null && 'summary' in decoded)
    assert.deepEqual(decoded.summary.tokenParts, [
      { key: 'system', value: 5 },
      { key: 'assistant', value: 0 },
    ])
  })

  test('a valid days part filters malformed entries and keeps null costs', () => {
    const decoded = overviewValueOf(daysValue({
      days: [
        { key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 },
        { key: '2026-09-15', tokens: 0, sessions: 0, costUsd: null },
        null,
        { tokens: 1, sessions: 1 },
        { key: '', tokens: 1, sessions: 1 },
        { key: '2026-09-14', tokens: -1, sessions: 1 },
        { key: '2026-09-13', tokens: 1, sessions: -1 },
        { key: '2026-09-12', tokens: 1, sessions: 1, costUsd: 'x' },
      ],
    }))
    assert.ok(decoded !== null && 'days' in decoded)
    assert.deepEqual(decoded.days, [
      { key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 },
      { key: '2026-09-15', tokens: 0, sessions: 0, costUsd: null },
      { key: '2026-09-12', tokens: 1, sessions: 1, costUsd: null },
    ])
    assert.equal(overviewValueOf(daysValue({ days: {} })), null, 'days must be a list')
  })

  test('a valid page part decodes rows, groups, and the scope total', () => {
    const decoded = overviewValueOf(pageValue())
    assert.ok(decoded !== null && 'page' in decoded)
    assert.equal(decoded.pricingReady, false)
    assert.deepEqual(decoded.page.items, [{
      id: 's1',
      title: 'one',
      cwd: '/repo',
      updatedAt: 5,
      running: true,
      archived: false,
      group: 'w',
      tokens: 10,
      turns: 2,
      steps: 3,
      parts: [{ key: 'system', value: 7 }],
      total: 7,
      contextWindow: 100,
      maxOutputTokens: 50,
      model: 'm',
      lastUser: 'hi',
      costUsd: 0.25,
      createdDay: '2026-09-10',
    }])
    assert.deepEqual(decoded.page.groups, [{ key: 'w', count: 1 }])
    assert.equal(decoded.page.scopeTotal, 4)
  })

  test('a page part defaults optional row fields, drops malformed rows, and falls back to its own total', () => {
    const decoded = overviewValueOf(pageValue({
      page: {
        items: [
          { id: 's2', title: 'two', updatedAt: 1, parts: [], costUsd: null },
          null,
          { title: 'no id', updatedAt: 1, parts: [] },
          { id: 'no title', updatedAt: 1, parts: [] },
          { id: 'no stamp', title: 'x', parts: [] },
          { id: 'no parts', title: 'x', updatedAt: 1 },
          { id: 'bad parts', title: 'x', updatedAt: 1, parts: 'x' },
          { id: 'hostile parts', title: 'x', updatedAt: 1, parts: [null, { key: '' }] },
        ],
        index: 0,
        count: 1,
        total: 7,
      },
    }))
    assert.ok(decoded !== null && 'page' in decoded)
    assert.deepEqual(decoded.page.items, [
      { id: 's2', title: 'two', updatedAt: 1, running: false, archived: false, tokens: 0, turns: 0, parts: [], total: 0, costUsd: null },
      { id: 'hostile parts', title: 'x', updatedAt: 1, running: false, archived: false, tokens: 0, turns: 0, parts: [], total: 0, costUsd: null },
    ])
    assert.deepEqual(decoded.page.groups, [])
    assert.equal(decoded.page.scopeTotal, 7)
  })

  test('hostile page containers reject the page part', () => {
    const bads: [string, Record<string, unknown>][] = [
      ['items', { page: { items: 'x', index: 0, count: 1, total: 1 } }],
      ['index', { page: { items: [], index: -1, count: 1, total: 1 } }],
      ['count', { page: { items: [], index: 0, count: '1', total: 1 } }],
      ['total', { page: { items: [], index: 0, count: 1, total: null } }],
      ['page record', { page: 7 }],
    ]
    for (const [label, over] of bads) {
      assert.equal(overviewValueOf(pageValue(over)), null, `${label} rejects`)
    }
    const hostileGroups = overviewValueOf(pageValue({
      page: { items: [], index: 0, count: 1, total: 0, scopeTotal: 0, groups: [null, { key: '' }, { key: 'w' }, { key: 'w', count: -1 }, { key: 'ok', count: 2 }] },
    }))
    assert.ok(hostileGroups !== null && 'page' in hostileGroups)
    assert.deepEqual(hostileGroups.page.groups, [{ key: 'ok', count: 2 }])
    const nonList = overviewValueOf(pageValue({ page: { items: [], index: 0, count: 1, total: 0, groups: {} } }))
    assert.ok(nonList !== null && 'page' in nonList)
    assert.deepEqual(nonList.page.groups, [])
  })

  test('a valid tally decodes; a hostile tally rejects', () => {
    const decoded = overviewValueOf(tallyValue())
    assert.deepEqual(decoded, {
      revision: 'r1',
      pricingReady: true,
      tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
    })
    const filtered = overviewValueOf(tallyValue({
      tally: {
        field: 'skills',
        stats: [
          { name: 'tdd', n: 1, sessions: 1, last: 1 },
          null,
          { name: '', n: 1, sessions: 1, last: 1 },
          { n: 1, sessions: 1, last: 1 },
          { name: 'a', n: -1, sessions: 1, last: 1 },
          { name: 'b', n: 1, sessions: 'x', last: 1 },
          { name: 'c', n: 1, sessions: 1, last: 'x' },
        ],
      },
    }))
    assert.ok(filtered !== null && 'tally' in filtered)
    assert.deepEqual(filtered.tally.stats, [{ name: 'tdd', n: 1, sessions: 1, last: 1 }])
    const bads: [string, Record<string, unknown>][] = [
      ['tally record', { tally: 7 }],
      ['stats list', { tally: { field: 'tools', stats: {} } }],
      ['field', { tally: { field: 'other', stats: [] } }],
    ]
    for (const [label, over] of bads) {
      assert.equal(overviewValueOf(tallyValue(over)), null, `${label} rejects`)
    }
  })

  test('a malformed selected part rejects instead of falling through to another part', () => {
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, summary: null, days: [] }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, days: null, tally: { field: 'tools', stats: [] } }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, page: null, tally: { field: 'tools', stats: [] } }), null)
    assert.equal(overviewValueOf({ revision: 'r1', pricingReady: true, tally: null }), null)
    const firstWins = overviewValueOf({ revision: 'r1', pricingReady: true, tally: null, page: pageValue().page })
    assert.ok(firstWins !== null && 'page' in firstWins, 'the first present part wins')
    assert.deepEqual(firstWins.page, pageValue().page)
  })
})
})
