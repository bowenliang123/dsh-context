// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { BoundedCache, byteSizeOf, lruTouch, lruTrim } from '../../src/client/boundedCache'
import { modalStoreOf, setPendingConsume, takePendingConsume, type ConsumeGuard } from '../../src/client/modalStore'
import { disposeRetention, makeRetentionCache, registerRetentionCleanup, retentionOf, RETENTION, trimRetentionMap } from '../../src/client/retention'
import { COMPACT_HEADROOM_TOKENS, COMPACT_THRESHOLD_RATIO, reserveGeometry } from '../../src/client/reserve'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { FileTypeGlyph, resolveFileGlyph, resolveIcon, IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown } from '../../src/client/primitives'
import { DICT_EN, type DictKey, DICTS } from '../../src/client/i18n'
import { formLabelOf, modeLabelOf } from '../../src/client/labels'
import { makeTranslate } from './helpers/kit'
import { blockSummaryOf, callNamesOf, callSummaryOf, summaryInArgs } from '../../src/client/callSummary'
import { type ConversationNodeLike } from '../../src/client/services'

describe('boundedCache', () => {

describe('byteSizeOf', () => {
  test('sizes JSON-serializable values by their serialized length', () => {
    assert.equal(byteSizeOf('abc'), 5)
    assert.equal(byteSizeOf(12), 2)
    assert.equal(byteSizeOf({ a: 1 }), JSON.stringify({ a: 1 }).length)
    assert.equal(byteSizeOf([1, 2]), 5)
    assert.equal(byteSizeOf(null), 4)
    assert.equal(byteSizeOf(undefined), 0)
  })

  test('a value JSON cannot serialize weighs nothing instead of throwing', () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    assert.equal(byteSizeOf(circular), 0)
    assert.equal(byteSizeOf(() => 1), 0)
  })
})

describe('BoundedCache', () => {
  test('set, get, size, bytes, and clear share one ledger', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 10, sizeOf: value => value })
    assert.equal(cache.size, 0)
    assert.equal(cache.bytes, 0)
    assert.equal(cache.get('a'), undefined)
    cache.set('a', 2)
    cache.set('b', 3)
    assert.equal(cache.size, 2)
    assert.equal(cache.bytes, 5)
    assert.equal(cache.get('a'), 2)
    cache.clear()
    assert.equal(cache.size, 0)
    assert.equal(cache.get('a'), undefined)
  })

  test('a read touches the entry, so the oldest untouched one is evicted first', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.get('a')
    cache.set('c', 3)
    assert.equal(cache.get('b'), undefined, 'the untouched entry went first')
    assert.equal(cache.get('a'), 1)
    assert.equal(cache.get('c'), 3)
  })

  test('a repeated set replaces the value and refreshes the age', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('a', 3)
    cache.set('c', 4)
    assert.equal(cache.get('a'), 3)
    assert.equal(cache.get('b'), undefined)
  })

  test('the entry bound protects the entry just set while trimming', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    assert.equal(cache.size, 2)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('b'), 2)
    assert.equal(cache.get('c'), 3)
  })

  test('the byte bound drops the oldest entries until the weight fits', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 10, maxBytes: 8, sizeOf: () => 4 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.size, 2)
    assert.equal(cache.bytes, 8)
    cache.set('c', 3)
    assert.equal(cache.size, 2)
    assert.equal(cache.get('a'), undefined)
    assert.equal(cache.get('c'), 3)
  })

  test('a single entry over the byte budget survives its own set and leaves on the next trim', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 10, maxBytes: 4, sizeOf: value => value })
    cache.set('huge', 100)
    assert.equal(cache.size, 1, 'the inserted entry is protected from its own trim')
    assert.equal(cache.bytes, 100)
    cache.trim()
    assert.equal(cache.size, 0)
  })

  test('the weighted bound and its reserve admit the next payload slot like the old registry', () => {
    const cache = new BoundedCache<string, number>({
      maxEntries: 10,
      maxWeight: 1,
      weightOf: value => (value === 1 ? 1 : 0),
    })
    cache.set('a', 0)
    cache.set('b', 0)
    cache.trim({ reserveWeight: 1 })
    assert.equal(cache.size, 2, 'light entries do not fill the heavy bound')
    cache.set('c', 1)
    assert.equal(cache.size, 3)
    cache.trim({ reserveWeight: 1 })
    assert.equal(cache.get('c'), undefined, 'the reserve counts as one more slot, so the weighed entry leaves')
    assert.equal(cache.size, 0)
  })

  test('minEntries keeps the last entry against an impossible budget', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 10, maxBytes: 1, minEntries: 1, sizeOf: () => 10 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.size, 1)
    assert.equal(cache.get('b'), 2)
  })

  test('non-evictable entries are skipped in favor of the ones behind them', () => {
    const cache = new BoundedCache<string, string>({
      maxEntries: 1,
      evictable: value => value !== 'pinned',
    })
    cache.set('a', 'pinned')
    cache.set('b', 'other')
    assert.equal(cache.size, 2, 'the pinned oldest entry outlives the bound')
    cache.set('c', 'third')
    assert.equal(cache.get('a'), 'pinned')
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.get('c'), 'third')
  })

  test('the eviction hook sees the evicted value and key; the default weight counts entries', () => {
    const evicted: string[] = []
    const cache = new BoundedCache<string, number>({
      maxEntries: 10,
      maxWeight: 1,
      onEvict: (value, key) => { evicted.push(`${key}:${String(value)}`) },
    })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a'), undefined)
    assert.deepEqual(evicted, ['a:1'])
  })

  test('an unconfigured size weighs nothing and a within-bounds trim is a no-op', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.trim({ protect: 'a' })
    assert.equal(cache.bytes, 0)
    assert.equal(cache.size, 2)
  })
})

describe('BoundedCache retention', () => {
  test('every departure reports its reason: replace, trim, delete, clear and dispose', () => {
    const seen: string[] = []
    const cache = new BoundedCache<string, number>({
      maxEntries: 2,
      onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
    })
    cache.set('a', 1)
    cache.set('a', 2)
    cache.set('b', 3)
    cache.set('c', 4)
    cache.delete('b')
    cache.delete('missing')
    cache.set('d', 5)
    cache.clear()
    cache.set('e', 6)
    cache.dispose()
    assert.deepEqual(seen, ['a:replace', 'a:trim', 'b:delete', 'c:clear', 'd:clear', 'e:dispose'])
    assert.equal(cache.size, 0)
  })

  test('a read past the ttl lazily drops the entry and leaves the timer to be released', () => {
    let clock = 0
    const seen: string[] = []
    const cache = new BoundedCache<string, number>({
      maxEntries: 4,
      ttlMs: 100,
      now: () => clock,
      onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
    })
    cache.set('a', 1)
    clock = 99
    assert.equal(cache.get('a'), 1)
    clock = 101
    assert.equal(cache.get('a'), undefined)
    assert.deepEqual(seen, ['a:ttl'])
    cache.dispose()
  })

  test('the single expiry timer evicts without readers and tracks the earliest entry', () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const cache = new BoundedCache<string, number>({
        maxEntries: 8,
        ttlMs: 100,
        onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
      })
      cache.set('a', 1)
      vi.advanceTimersByTime(50)
      cache.set('b', 2)
      vi.advanceTimersByTime(50)
      assert.deepEqual(seen, ['a:ttl'])
      vi.advanceTimersByTime(50)
      assert.deepEqual(seen, ['a:ttl', 'b:ttl'])
      assert.equal(cache.size, 0)
      const silent = new BoundedCache<string, number>({ maxEntries: 2, ttlMs: 10 })
      silent.set('x', 1)
      vi.advanceTimersByTime(10)
      assert.equal(silent.size, 0)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('clear and delete cancel the pending expiry timer', () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const cache = new BoundedCache<string, number>({
        maxEntries: 8,
        ttlMs: 100,
        onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
      })
      cache.set('a', 1)
      cache.set('b', 2)
      cache.delete('b')
      vi.advanceTimersByTime(100)
      assert.deepEqual(seen, ['b:delete', 'a:ttl'])
      cache.set('c', 3)
      cache.clear()
      vi.advanceTimersByTime(100)
      assert.deepEqual(seen, ['b:delete', 'a:ttl', 'c:clear'])
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('the expiry sweep skips a pinned entry and purges the rest', () => {
    vi.useFakeTimers()
    try {
      const seen: string[] = []
      const cache = new BoundedCache<string, number>({
        maxEntries: 8,
        ttlMs: 100,
        evictable: value => value !== 1,
        onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
      })
      cache.set('a', 1)
      cache.set('b', 2)
      vi.advanceTimersByTime(100)
      assert.deepEqual(seen, ['b:ttl'])
      assert.equal(cache.size, 1)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a pinned entry skips ttl expiry until it becomes evictable', () => {
    vi.useFakeTimers()
    try {
      let clock = 0
      let pinned = true
      const seen: string[] = []
      const cache = new BoundedCache<string, number>({
        maxEntries: 8,
        ttlMs: 100,
        now: () => clock,
        evictable: () => !pinned,
        onEvict: (_value, key, reason) => { seen.push(`${key}:${reason}`) },
      })
      cache.set('a', 1)
      clock = 101
      vi.advanceTimersByTime(100)
      assert.equal(cache.size, 1)
      assert.equal(cache.get('a'), 1, 'a pinned expired entry still reads')
      pinned = false
      cache.set('b', 2)
      vi.advanceTimersByTime(1)
      assert.deepEqual(seen, ['a:ttl'])
      assert.equal(cache.size, 1)
      cache.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('reweight re-trims after asynchronous payload growth and ignores missing keys', () => {
    const cache = new BoundedCache<string, { n: number }>({
      maxEntries: 10,
      maxBytes: 8,
      sizeOf: value => value.n,
    })
    const grown = { n: 4 }
    cache.set('a', grown)
    cache.set('b', { n: 4 })
    grown.n = 100
    cache.reweight('a')
    assert.equal(cache.size, 1)
    assert.equal(cache.get('b'), undefined)
    assert.equal(cache.bytes, 100)
    cache.reweight('missing')
    assert.equal(cache.size, 1)
  })

  test('forEach visits every live entry in insertion order', () => {
    const cache = new BoundedCache<string, number>({ maxEntries: 4 })
    cache.set('a', 1)
    cache.set('b', 2)
    const seen: string[] = []
    cache.forEach((value, key) => { seen.push(`${key}:${String(value)}`) })
    assert.deepEqual(seen, ['a:1', 'b:2'])
  })

  test('the expiry timer is unref-ed when the host timer exposes unref', () => {
    const unref = vi.fn()
    const setSpy = vi.spyOn(globalThis, 'setTimeout').mockReturnValue({ unref } as never)
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(() => {})
    try {
      const cache = new BoundedCache<string, number>({ maxEntries: 2, ttlMs: 100 })
      cache.set('a', 1)
      assert.equal(unref.mock.calls.length, 1)
      cache.dispose()
      const bare = new BoundedCache<string, number>({ maxEntries: 2, ttlMs: 100 })
      bare.set('a', 1)
      bare.dispose()
    } finally {
      setSpy.mockRestore()
      clearSpy.mockRestore()
    }
  })
})

describe('ttl timer receiver', () => {
  test('calls unref on the timer object itself, never as a detached function', () => {
    const fake = { unref: function (this: unknown): void { receiver = this } }
    let receiver: unknown = 'unset'
    const real = globalThis.setTimeout
    vi.stubGlobal('setTimeout', () => fake as unknown as ReturnType<typeof setTimeout>)
    try {
      const cache = new BoundedCache<string, number>({ maxEntries: 4, ttlMs: 1_000 })
      cache.set('a', 1)
      assert.equal(receiver, fake, 'unref runs with its timer as receiver')
    } finally {
      vi.stubGlobal('setTimeout', real)
    }
  })
})

describe('ttl timer handles without unref', () => {
  test('a handle without unref is scheduled without throwing', () => {
    const real = globalThis.setTimeout
    vi.stubGlobal('setTimeout', () => ({}) as unknown as ReturnType<typeof setTimeout>)
    try {
      const cache = new BoundedCache<string, number>({ maxEntries: 4, ttlMs: 1_000 })
      cache.set('a', 1)
      assert.equal(cache.get('a'), 1)
      cache.dispose()
    } finally {
      vi.stubGlobal('setTimeout', real)
    }
  })
})
})

describe('lru', () => {

describe('lruTouch', () => {
  test('a hit moves the key to the newest end; a miss leaves the map alone', () => {
    const map = new Map<string, number>([['a', 1], ['b', 2], ['c', 3]])
    lruTouch(map, 'b')
    assert.deepEqual([...map.keys()], ['a', 'c', 'b'])
    lruTouch(map, 'gone')
    assert.deepEqual([...map.keys()], ['a', 'c', 'b'])
  })
})

describe('lruTrim', () => {
  test('drops the least recently used entries down to the cap and never below it', () => {
    const map = new Map<string, number>()
    for (let i = 0; i < 10; i++) {
      map.set(`k${i}`, i)
      lruTrim(map, 4)
    }
    assert.deepEqual([...map.keys()], ['k6', 'k7', 'k8', 'k9'])

    const small = new Map<string, number>([['a', 1], ['b', 2]])
    lruTrim(small, 4)
    assert.deepEqual([...small.keys()], ['a', 'b'])
    lruTrim(small, 2)
    assert.deepEqual([...small.keys()], ['a', 'b'])
    const empty = new Map<string, number>()
    lruTrim(empty, 0)
    assert.equal(empty.size, 0)
  })
})
})

describe('modalStore', () => {

describe('modalStoreOf', () => {
  test('returns the same store per session id, distinct stores across ids, starting closed', () => {
    assert.equal(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-a'))
    assert.notEqual(modalStoreOf('modal-same-a'), modalStoreOf('modal-same-b'))
    assert.equal(modalStoreOf('modal-initial').getSnapshot(), false)
  })

  test('set with a flipped value notifies once per change; a repeat notifies nothing', () => {
    const store = modalStoreOf('modal-flip')
    let calls = 0
    store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    assert.equal(store.getSnapshot(), true)
    store.set(true)
    assert.equal(calls, 1)
    store.set(false)
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot(), false)
  })

  test('unsubscribe stops notifications', () => {
    const store = modalStoreOf('modal-unsub')
    let calls = 0
    const unsubscribe = store.subscribe(() => { calls++ })
    store.set(true)
    assert.equal(calls, 1)
    unsubscribe()
    store.set(false)
    assert.equal(calls, 1)
  })
})

describe('pending consume guards', () => {
  test('take returns the guard once, then undefined; an absent guard reads undefined', () => {
    assert.equal(takePendingConsume('consume-absent'), undefined)
    const guard: ConsumeGuard = { kind: 'bare-token', token: '/context' }
    setPendingConsume('consume-once', guard)
    assert.equal(takePendingConsume('consume-once'), guard)
    assert.equal(takePendingConsume('consume-once'), undefined)
  })

  test('guards are isolated per session', () => {
    const guard: ConsumeGuard = { kind: 'span', span: { start: 0, end: 8, draftRev: 1 } }
    setPendingConsume('consume-iso-a', guard)
    assert.equal(takePendingConsume('consume-iso-b'), undefined)
    assert.equal(takePendingConsume('consume-iso-a'), guard)
  })
})

describe('modal store retention', () => {
  test('the store map stays bounded and the least recently read store drops', () => {
    for (let i = 0; i < 40; i++) modalStoreOf('modal-cap-' + i)
    const survivor = modalStoreOf('modal-cap-39')
    assert.equal(modalStoreOf('modal-cap-39'), survivor)
    assert.notEqual(modalStoreOf('modal-cap-0'), undefined)
    modalStoreOf('modal-cap-0')
    assert.notEqual(modalStoreOf('modal-cap-0'), modalStoreOf('modal-cap-39'))
  })

  test('a store left idle past the ttl is recreated closed', () => {
    vi.useFakeTimers()
    try {
      const store = modalStoreOf('modal-ttl')
      store.set(true)
      vi.advanceTimersByTime(10 * 60_000)
      assert.notEqual(modalStoreOf('modal-ttl'), store)
      assert.equal(modalStoreOf('modal-ttl').getSnapshot(), false)
    } finally {
      vi.useRealTimers()
    }
  })

  test('pending consume guards stay bounded, dropping the oldest', () => {
    for (let i = 0; i < 33; i++) setPendingConsume('guard-' + i, { kind: 'bare-token', token: 't' + i })
    assert.equal(takePendingConsume('guard-0'), undefined)
    assert.deepEqual(takePendingConsume('guard-32'), { kind: 'bare-token', token: 't32' })
  })

  test('dispose clears every stored modal state', () => {
    const store = modalStoreOf('modal-dispose')
    store.set(true)
    setPendingConsume('modal-dispose', { kind: 'bare-token', token: '/context' })
    disposeRetention()
    assert.notEqual(modalStoreOf('modal-dispose'), store)
    assert.equal(takePendingConsume('modal-dispose'), undefined)
  })
})
})

describe('reserve', () => {

function triggerAtOrLeftOfMasks(reserve: NonNullable<ReturnType<typeof reserveGeometry>>, window: number): boolean {
  return reserve.threshold <= window - reserve.output - reserve.headroom
}

describe('reserveGeometry', () => {
  test('no positive window: no reserve', () => {
    assert.equal(reserveGeometry(undefined, 256_000), undefined)
    assert.equal(reserveGeometry(0, 256_000), undefined)
    assert.equal(reserveGeometry(-1_000, 256_000), undefined)
    assert.equal(reserveGeometry(Number.NaN, 256_000), undefined)
    assert.equal(reserveGeometry(Number.POSITIVE_INFINITY, 256_000), undefined)
  })

  test('the deepseek defaults bind the pressure budget when it is smaller; a small output cap leaves the ratio binding', () => {
    const reserve = reserveGeometry(1_000_000, 256_000)
    assert.deepEqual(reserve, { threshold: 678_464, headroom: COMPACT_HEADROOM_TOKENS, output: 256_000 })
    assert.ok(triggerAtOrLeftOfMasks(reserve!, 1_000_000))
    const ratio = reserveGeometry(1_000_000, 8_000)
    assert.deepEqual(ratio, { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 8_000 })
    assert.equal(ratio!.threshold, Math.floor(1_000_000 * COMPACT_THRESHOLD_RATIO))
    assert.ok(triggerAtOrLeftOfMasks(ratio!, 1_000_000))
  })

  test('an unknown, non-positive, or non-finite output cap reserves no output', () => {
    const expected = { threshold: 800_000, headroom: COMPACT_HEADROOM_TOKENS, output: 0 }
    for (const cap of [undefined, 0, -8_000, Number.NaN, Number.POSITIVE_INFINITY] as const) {
      assert.deepEqual(reserveGeometry(1_000_000, cap), expected, String(cap))
    }
    assert.deepEqual(reserveGeometry(1_000_000, 'junk' as unknown as number), expected)
  })

  test('a window too small to hold the headroom reserves nothing, as dsh refuses that route', () => {
    assert.equal(reserveGeometry(65_536, 0), undefined)
    assert.equal(reserveGeometry(65_535, 0), undefined)
    assert.equal(reserveGeometry(1_000, 200), undefined)
    assert.equal(reserveGeometry(1_000, 1_000), undefined)
    assert.equal(reserveGeometry(1_000, 5_000), undefined)
    const tight = reserveGeometry(65_537, 0)
    assert.deepEqual(tight, { threshold: 1, headroom: COMPACT_HEADROOM_TOKENS, output: 0 })
    assert.ok(triggerAtOrLeftOfMasks(tight!, 65_537))
  })
})
})

describe('retention', () => {

describe('retention policies', () => {
  test('the policy table names a scope and bounds for every cache', () => {
    const names = Object.keys(RETENTION)
    assert.ok(names.length >= 20)
    for (const name of names) {
      const policy = retentionOf(name as keyof typeof RETENTION)
      assert.ok(Number.isInteger(policy.maxEntries) && policy.maxEntries > 0, name)
      assert.ok(policy.maxBytes === undefined || policy.maxBytes > 0, name)
      assert.ok(policy.maxWeight === undefined || policy.maxWeight > 0, name)
      assert.ok(policy.ttlMs === undefined || policy.ttlMs > 0, name)
      assert.ok(policy.scope === 'global' || policy.scope === 'session' || policy.scope === 'address' || policy.scope === 'owner', name)
    }
    assert.equal(retentionOf('agentHeads').ttlMs, 60_000)
    assert.equal(retentionOf('detailStores').maxWeight, 8)
    assert.equal(retentionOf('derivedOwner').scope, 'owner')
    assert.equal(retentionOf('derivedSeq').scope, 'owner')
  })

  test('the factory applies policy bounds and lets hooks override behavior', () => {
    const evicted: string[] = []
    const cache = makeRetentionCache<string, number>('commandHighlight', {
      onEvict: (_value, key, reason) => { evicted.push(`${key}:${reason}`) },
    })
    for (let i = 0; i < 601; i++) cache.set('k' + String(i), i)
    assert.equal(cache.size, 600)
    assert.equal(cache.get('k0'), undefined)
    assert.deepEqual(evicted, ['k0:trim'])
    cache.dispose()

    const plain = makeRetentionCache<string, number>('contentMissValues')
    for (let i = 0; i < 33; i++) plain.set('k' + String(i), i)
    assert.equal(plain.size, 32)
    plain.dispose()
  })

  test('the detail store policy carries byte and weight bounds without a ttl', () => {
    const cache = makeRetentionCache<string, number>('detailStores', { sizeOf: value => value })
    assert.equal(retentionOf('detailStores').ttlMs, undefined)
    cache.set('a', 1024)
    assert.equal(cache.bytes, 1024)
    cache.dispose()
  })

  test('trimRetentionMap bounds a plain map by its policy', () => {
    const map = new Map<number, number>()
    for (let i = 0; i < 40; i++) map.set(i, i)
    trimRetentionMap(map, 'modalPendingConsume')
    assert.equal(map.size, 32)
    assert.equal(map.has(7), false)
    assert.equal(map.has(8), true)
    trimRetentionMap(map, 'pendingFocus')
    assert.equal(map.size, 16)
  })
})

describe('retention disposal', () => {
  test('dispose runs every registered cleanup once and forgets them', () => {
    const ran: string[] = []
    const off = registerRetentionCleanup(() => { ran.push('kept') })
    registerRetentionCleanup(() => { ran.push('dropped') })
    off()
    disposeRetention()
    assert.deepEqual(ran, ['dropped'])
    disposeRetention()
    assert.deepEqual(ran, ['dropped'])
  })
})
})

describe('meta', () => {

const globals = globalThis as Record<string, unknown>

afterEach(() => {
  delete globals.__DSH_CTX_VERSION__
  delete globals.__DSH_CTX_REPO__
  vi.resetModules()
})

async function importMeta(): Promise<typeof import('../../src/client/meta')> {
  vi.resetModules()
  return await import('../../src/client/meta')
}

describe('meta', () => {
  test('without build defines the dev/test fallbacks apply', async () => {
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_NAME, 'dsh-context')
    assert.equal(meta.PLUGIN_VERSION, '0.0.0-dev')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'bowenliang123/dsh-context')
  })

  test('build defines win: the short form strips a github prefix and keeps any other URL whole', async () => {
    globals.__DSH_CTX_VERSION__ = '9.9.9'
    let meta = await importMeta()
    assert.equal(meta.PLUGIN_VERSION, '9.9.9')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')

    globals.__DSH_CTX_REPO__ = 'https://github.com/acme/widget'
    meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/acme/widget')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'acme/widget')

    globals.__DSH_CTX_REPO__ = 'http://git.example.com/acme/widget'
    meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO_SHORT, 'http://git.example.com/acme/widget')
  })
})
})

describe('seatGuards', () => {

const ROOT = join(process.cwd(), 'src/client')

const GUARD = /typeof\s+([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*(?:===|!==)\s*'function'/g

const HOOK = /(?:^|\.)(use[A-Z][\w$]*)$/

const CALL = (name: string): RegExp => new RegExp(`(?:\\b${name}\\s*\\(|\\b${name}\\s+as\\b[^;]{0,80}\\)\\s*\\()`)

function guardedSeatCalls(source: string): string[] {
  const offenders: string[] = []
  for (const match of source.matchAll(GUARD)) {
    const name = match[1].split('.').pop() as string
    if (!HOOK.test(name)) continue
    const start = (match.index ?? 0) + match[0].length
    if (CALL(name).test(source.slice(start, start + 260))) offenders.push(match[1])
  }
  return offenders
}

test('the seat guard scan flags conditional seat calls', () => {
  const source = [
    "const head = typeof useProjection === 'function' ? useProjection('contextTimeline') : undefined",
    'if (typeof useTabInfo === \'function\') { useTabInfo() }',
    "if (typeof useChat !== 'function') return undefined\nreturn useChat(sel)",
  ].join('\n')
  assert.deepEqual(guardedSeatCalls(source), ['useProjection', 'useTabInfo', 'useChat'])
})

test('no hook seat is called behind a typeof-function guard', () => {
  const offenders: string[] = []
  for (const rel of readdirSync(ROOT, { recursive: true, encoding: 'utf8' })) {
    if (!/\.tsx?$/.test(rel)) continue
    const source = readFileSync(join(ROOT, rel), 'utf8')
    for (const name of guardedSeatCalls(source)) offenders.push(`${rel}: ${name}`)
  }
  assert.deepEqual(offenders, [], 'call seats unconditionally and branch on their result')
})
})

describe('primitives', () => {

describe('resolveIcon', () => {
  const icon = function SomeIcon(): null { return null }

  test('a present export resolves to the component; a non-component, a missing name, or a hostile read renders nothing', () => {
    assert.equal(resolveIcon('icon', { icon }), icon)
    assert.equal(resolveIcon('icon', { icon: 42 })({}), null, 'a non-component export')
    assert.equal(resolveIcon('IconGhostOutlineRegular', {})({}), null, 'a future rename')
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    assert.equal(resolveIcon('IconBranchOutlineRegular', hostile)({}), null)
  })

  test('the module-level exports resolve against the pinned generation', () => {
    for (const icon of [IconBranch, IconPlus, IconCheck, IconCopy, IconClose, IconSettings, IconChevronDown]) {
      assert.equal(typeof icon, 'function', 'every seam resolves to a component')
    }
    assert.equal(typeof FileTypeGlyph, 'function', 'the file-type glyph resolves too')
  })
})

describe('resolveFileGlyph', () => {
  const glyph = function SomeGlyph(): null { return null }

  test('a present export resolves; a missing, non-component, or hostile read renders nothing', () => {
    assert.equal(resolveFileGlyph({ FileTypeIcon: glyph }), glyph)
    assert.equal(resolveFileGlyph({ FileTypeIcon: 42 })({}), null)
    assert.equal(resolveFileGlyph({})({}), null)
    const hostile = new Proxy({}, { get() { throw new Error('hostile export read') } })
    assert.equal(resolveFileGlyph(hostile)({}), null)
  })
})
})

describe('labels', () => {

const t = makeTranslate()

describe('formLabelOf', () => {
  test('maps every harness form to its dictionary label', () => {
    for (const form of ['instructions', 'catalog', 'snapshot', 'notice', 'relay', 'recall', 'context']) {
      assert.equal(formLabelOf(t, form), DICT_EN[`form.${form}` as DictKey], form)
    }
  })

  test('an unknown or absent form falls back to the generic context label', () => {
    assert.equal(formLabelOf(t, 'mystery'), DICT_EN['form.context'])
    assert.equal(formLabelOf(t, ''), DICT_EN['form.context'])
    assert.equal(formLabelOf(t, undefined), DICT_EN['form.context'])
  })
})

describe('modeLabelOf', () => {
  test('maps the known plan mode names to their dictionary labels', () => {
    assert.equal(modeLabelOf(t, 'plan.on'), DICT_EN['ev.mode.plan.on'])
    assert.equal(modeLabelOf(t, 'plan.off'), DICT_EN['ev.mode.plan.off'])
  })

  test('an unknown mode stays readable as its own name and an absent one keeps the legacy fallback', () => {
    assert.equal(modeLabelOf(t, 'goal'), 'goal')
    assert.equal(modeLabelOf(t, undefined), 'ev.mode.?')
  })
})
})

describe('i18n', () => {

const SRC = join(process.cwd(), 'src/client')

const I18N_MODULE = /^i18n(?:[A-Z][a-z]+)?\.ts$/

const DYNAMIC_PREFIXES = [
  'browser.kind.', 'browser.search.', 'cat.', 'cmds.filter.', 'cmds.sort.', 'ev.mode.',
  'files.kind.', 'files.sort.', 'fleet.comms.detail.', 'fleet.comms.kind.', 'fleet.kind.',
  'fleet.pulse.mode.', 'fleet.settled.', 'fleet.settledShort.', 'fleet.task.', 'form.',
  'kind.', 'ov.cover.', 'ov.date.wd.', 'ov.heat.metric.', 'ov.heat.mon.', 'ov.list.sort.',
  'ov.range.', 'tool.sort.',
]

function sourceText(): string {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/.test(file) && !I18N_MODULE.test(file))
  return files.map(file => readFileSync(join(SRC, file), 'utf8')).join('\n')
}

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

describe('dictionaries', () => {
  test('every supported locale has the complete key set and non-empty values', () => {
    const keys = Object.keys(DICT_EN).sort()
    assert.deepEqual(Object.keys(DICTS).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const [locale, dict] of Object.entries(DICTS)) {
      assert.deepEqual(Object.keys(dict).sort(), keys, locale)
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', `${locale}:${key}`)
        assert.ok(value.length > 0, `${locale}:${key}`)
      }
    }
  })

  test('every dictionary key is reachable from a literal or an enumerated dynamic namespace', () => {
    const source = sourceText()
    const literal = new Set(
      [...source.matchAll(/'([A-Za-z][\w.-]*)'|"([A-Za-z][\w.-]*)"/g)].map(match => match[1] ?? match[2]),
    )
    const unread = Object.keys(DICT_EN).filter(key => !literal.has(key)
      && !DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix)))
    assert.deepEqual(unread, [], 'dead keys: no literal use and no enumerated dynamic namespace')
  })

  test('every literal t() key exists in the dictionary', () => {
    const missing = new Set<string>()
    for (const match of sourceText().matchAll(/\bt\(\s*'([^']+)'/g)) {
      const key = match[1]
      if (key.endsWith('.')) continue
      if (!(key in DICT_EN)) missing.add(key)
    }
    assert.deepEqual([...missing], [], 'typo keys: a literal t() key the dictionaries do not carry')
  })

  test('interpolation placeholders agree between every locale and English', () => {
    for (const key of Object.keys(DICT_EN) as DictKey[]) {
      for (const [locale, dict] of Object.entries(DICTS)) {
        assert.deepEqual(placeholders(dict[key]), placeholders(DICT_EN[key]), `${locale}:${key}`)
      }
    }
  })
})
})

describe('callSummary', () => {

function conv(over: Partial<ConversationNodeLike> = {}): ConversationNodeLike {
  return { kind: 'assistant', seq: 1, ...over }
}

describe('summaryInArgs', () => {
  test('the keys win in description, file_path, path, filePath order; unusable values skip', () => {
    assert.equal(summaryInArgs(null), null)
    assert.equal(summaryInArgs({ description: 'd', file_path: 'f', path: 'p', filePath: 'fp' }), 'd')
    assert.equal(summaryInArgs({ file_path: 'f', path: 'p', filePath: 'fp' }), 'f')
    assert.equal(summaryInArgs({ path: 'p', filePath: 'fp' }), 'p')
    assert.equal(summaryInArgs({ filePath: 'fp' }), 'fp')
    assert.equal(summaryInArgs({ description: '', file_path: 'f' }), 'f')
    assert.equal(summaryInArgs({ description: 42, path: 'p' }), 'p')
    assert.equal(summaryInArgs({ foo: 'bar' }), null)
  })
})

describe('callSummaryOf', () => {
  test('an undefined conversation, a missing call, or an unusable payload yields null; otherwise the call\'s args supply the summary', () => {
    assert.equal(callSummaryOf(undefined), null)
    assert.equal(callSummaryOf(conv()), null)
    assert.equal(callSummaryOf(conv({ call: null })), null)
    assert.equal(callSummaryOf(conv({ call: { name: 'bash', argsRaw: '{oops' } })), null)
    assert.equal(callSummaryOf(conv({ call: { name: 'edit', argsRaw: '{"file_path":"a.ts"}' } })), 'a.ts')
  })
})

describe('blockSummaryOf', () => {
  test('an undefined conversation or non-array blocks yield null; unusable entries skip and the first usable tool-call summary wins', () => {
    assert.equal(blockSummaryOf(undefined), null)
    assert.equal(blockSummaryOf(conv({ blocks: 'junk' as unknown as unknown[] })), null)
    const blocks = [
      null,
      42,
      { kind: 'text' },
      { kind: 'tool-call', argsRaw: '{oops' },
      { kind: 'tool-call', argsRaw: '{"foo":1}' },
      { kind: 'tool-call', argsRaw: '{"description":"first"}' },
      { kind: 'tool-call', argsRaw: '{"description":"second"}' },
    ]
    assert.equal(blockSummaryOf(conv({ blocks })), 'first')
    assert.equal(blockSummaryOf(conv({ blocks: [{ kind: 'tool-call', argsRaw: '{oops' }, null] })), null)
  })
})

describe('callNamesOf', () => {
  test('an undefined conversation or non-array blocks yield an empty list; mixed entries filter to names', () => {
    assert.deepEqual(callNamesOf(undefined), [])
    assert.deepEqual(callNamesOf(conv({ blocks: 'junk' as unknown as unknown[] })), [])
    const blocks = [
      null,
      42,
      { kind: 'text', name: 'not-a-call' },
      { kind: 'tool-call' },
      { kind: 'tool-call', name: 42 },
      { kind: 'tool-call', name: 'bash' },
      { kind: 'tool-call', name: 'read' },
    ]
    assert.deepEqual(callNamesOf(conv({ blocks })), ['bash', 'read'])
  })
})
})
