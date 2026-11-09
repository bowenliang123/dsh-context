import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFoldCache, type FoldCacheOptions } from '../../src/host/foldCache'
import { fakeCtx } from './helpers/ctx'

afterEach(() => {
  vi.useRealTimers()
})

function cacheOf<V>(options: FoldCacheOptions<V>): ReturnType<typeof makeFoldCache<V>> {
  return makeFoldCache(fakeCtx({}).ctx, options)
}

describe('fold cache', () => {
  test('bounds entries, promotes accepted reads, and misses are undefined', () => {
    const cache = cacheOf<number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a', () => true), 1)
    cache.set('c', 3)
    assert.equal(cache.get('a', () => true), 1, 'a read is promoted')
    assert.equal(cache.get('b', () => true), undefined, 'the least recently used entry was evicted')
    assert.equal(cache.get('c', () => true), 3)
    assert.equal(cache.get('missing', () => true), undefined)
  })

  test('a rejected read does not promote', () => {
    const cache = cacheOf<number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a', () => false), undefined)
    cache.set('c', 3)
    assert.equal(cache.get('a', () => true), undefined, 'the rejected read left a as the oldest entry')
    assert.equal(cache.get('b', () => true), 2)
    assert.equal(cache.get('c', () => true), 3)
  })

  test('bounds bytes without evicting the entry just stored', () => {
    const cache = cacheOf<number>({ maxEntries: 8, maxBytes: 10, bytesOf: value => value })
    cache.set('a', 6)
    cache.set('b', 6)
    assert.equal(cache.get('a', () => true), undefined, 'the older entry made room')
    assert.equal(cache.get('b', () => true), 6)
    cache.set('huge', 20)
    assert.equal(cache.get('b', () => true), undefined)
    assert.equal(cache.get('huge', () => true), 20, 'an entry larger than the budget stays')
  })

  test('sweeps after idle and runs the sweep hook', () => {
    vi.useFakeTimers()
    const swept = vi.fn()
    const cache = cacheOf<number>({ maxEntries: 2, idleMs: 10, onSweep: swept })
    cache.set('a', 1)
    cache.touch()
    vi.advanceTimersByTime(9)
    assert.equal(cache.get('a', () => true), 1)
    vi.advanceTimersByTime(1)
    assert.equal(cache.get('a', () => true), undefined)
    assert.equal(swept.mock.calls.length, 1)
  })

  test('sweeps without a hook', () => {
    vi.useFakeTimers()
    const cache = cacheOf<number>({ maxEntries: 2, idleMs: 10 })
    cache.set('a', 1)
    cache.touch()
    vi.advanceTimersByTime(10)
    assert.equal(cache.get('a', () => true), undefined)
  })

  test('defaults to the twenty-second idle window and resets on each touch', () => {
    vi.useFakeTimers()
    const swept = vi.fn()
    const cache = cacheOf<number>({ maxEntries: 2, onSweep: swept })
    cache.set('a', 1)
    cache.touch()
    cache.touch()
    vi.advanceTimersByTime(20_000)
    assert.equal(cache.get('a', () => true), undefined)
    assert.equal(swept.mock.calls.length, 1)
    cache.set('b', 2)
    cache.touch()
    vi.advanceTimersByTime(20_000)
    assert.equal(cache.get('b', () => true), undefined)
    assert.equal(swept.mock.calls.length, 2)
  })

  test('the context teardown disarms the sweep and clears the store', () => {
    vi.useFakeTimers()
    const fake = fakeCtx({})
    const cache = makeFoldCache<number>(fake.ctx, { maxEntries: 2, idleMs: 10 })
    cache.set('a', 1)
    cache.touch()
    fake.dispose()
    vi.advanceTimersByTime(10)
    assert.equal(cache.get('a', () => true), undefined)
  })
})
