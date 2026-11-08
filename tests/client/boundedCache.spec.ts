import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { BoundedCache, byteSizeOf } from '../../src/client/boundedCache'

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
