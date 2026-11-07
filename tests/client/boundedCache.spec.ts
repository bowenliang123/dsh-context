import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
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
