import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { disposeRetention, makeRetentionCache, registerRetentionCleanup, retentionOf, RETENTION, trimRetentionMap } from '../../src/client/retention'

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
      assert.ok(policy.scope === 'global' || policy.scope === 'session' || policy.scope === 'address', name)
    }
    assert.equal(retentionOf('agentHeads').ttlMs, 60_000)
    assert.equal(retentionOf('detailStores').maxWeight, 8)
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
