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
