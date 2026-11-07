import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { lruTouch, lruTrim } from '../../src/client/boundedCache'

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
