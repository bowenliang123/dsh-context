import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { assembleCached, cachedByData } from '../../../src/client/components/derivedCache'
import type { ContextHeaders } from '../../../src/shared/types'
import { timeline } from './contextViewHarness'

const headers: ContextHeaders = {
  headers: [{ seq: 1, time: 1, systemTokens: 0, tools: [] }],
}

describe('derived cache', () => {
  test('cachedByData reuses a value per projection and key', () => {
    const data = timeline()
    let calls = 0
    const compute = () => { calls++; return { calls } }
    const first = cachedByData(data, 'k', compute)
    const again = cachedByData(data, 'k', compute)
    assert.equal(first, again)
    assert.equal(calls, 1)
    const other = cachedByData(data, 'other', compute)
    assert.notEqual(first, other)
    assert.equal(calls, 2)
    const otherData = timeline()
    assert.notEqual(cachedByData(otherData, 'k', compute), first)
    assert.equal(calls, 3)
  })

  test('assembleCached reuses one assembled view per projection, headers and step', () => {
    const data = timeline()
    const live = assembleCached(data, null, null)
    assert.equal(assembleCached(data, null, null), live)
    const withHeaders = assembleCached(data, headers, null)
    assert.notEqual(withHeaders, live)
    assert.equal(assembleCached(data, headers, null), withHeaders)
    const otherHeaders: ContextHeaders = { headers: [] }
    assert.notEqual(assembleCached(data, otherHeaders, null), withHeaders)
  })
})

describe('derived cache bounds', () => {
  test('cachedByData keeps its inner map bounded and touches recency on hits', () => {
    const data = timeline()
    let calls = 0
    const compute = () => { calls++; return calls }
    const first = cachedByData(data, 'k0', compute)
    for (let i = 1; i < 16; i++) cachedByData(data, 'k' + i, compute)
    assert.equal(cachedByData(data, 'k0', compute), first, 'a hit replays and refreshes recency')
    cachedByData(data, 'k16', compute)
    assert.equal(cachedByData(data, 'k0', compute), first, 'the touched key survived the trim')
    assert.notEqual(cachedByData(data, 'k1', compute), 2, 'the untouched oldest key was recomputed')
  })

  test('assembleCached keeps its per-step map bounded', () => {
    const data = timeline()
    const first = assembleCached(data, null, 0)
    for (let seq = 1; seq < 8; seq++) assembleCached(data, null, seq)
    assert.equal(assembleCached(data, null, 0), first, 'a hit replays and refreshes recency')
    assembleCached(data, null, 8)
    assert.equal(assembleCached(data, null, 0), first, 'the touched step survived the trim')
    assert.notEqual(assembleCached(data, null, 1), first, 'the untouched oldest step was dropped')
  })
})
