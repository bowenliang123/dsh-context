// Headline derivation (src/client/headline.ts): the provider-anchored
// occupancy (projected → derived → heuristic), the window/pct pairing, and
// the anchored composition parts.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { headlineOf } from '../../src/client/headline'
import type { ContextTimeline, RequestRecord } from '../../src/shared/types'

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 10, tools: 20, user: 30, inject: 0, assistant: 40, tool: 0, total: 100 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

function req(over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq: 5, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 80, ...over }
}

describe('headlineOf occupancy', () => {
  test('the official projection supplies the anchored total and window', () => {
    const h = headlineOf(timeline(), { projectedTokens: 200, contextWindow: 1000 })
    assert.equal(h.tokens, 200)
    assert.equal(h.window, 1000)
    assert.equal(h.pct, 20)
  })

  test('the projection wins over the derived request anchor', () => {
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, { projectedTokens: 200 })
    assert.equal(h.tokens, 200)
  })

  test('a non-number projectedTokens falls through to the derived anchor', () => {
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, { projectedTokens: 'junk' as unknown as number })
    // lastReq.prompt + surface movement since: 150 + (100 - 80).
    assert.equal(h.tokens, 170)
  })

  test('without a projection the anchor derives from the last request', () => {
    const data = timeline({ requests: [req({ prompt: 150, total: 80 })] })
    const h = headlineOf(data, null)
    assert.equal(h.tokens, 170)
  })

  test('empty requests yield no derived anchor', () => {
    const h = headlineOf(timeline(), null)
    assert.equal(h.tokens, 100)
  })

  test('a request without a numeric prompt yields no derived anchor', () => {
    const data = timeline({ requests: [req()] })
    const h = headlineOf(data, null)
    assert.equal(h.tokens, 100)
  })

  test('tokens fall back to the heuristic total without any anchor', () => {
    const h = headlineOf(timeline())
    assert.equal(h.tokens, 100)
  })
})

describe('headlineOf window and pct', () => {
  test('the pressure window wins over the timeline window', () => {
    const data = timeline({ contextWindow: 1000 })
    const h = headlineOf(data, { contextWindow: 500 })
    assert.equal(h.window, 500)
    assert.equal(h.pct, 20)
  })

  test('the timeline window serves when the pressure has none', () => {
    const h = headlineOf(timeline({ contextWindow: 200 }), { contextWindow: 'junk' as unknown as number })
    assert.equal(h.window, 200)
    assert.equal(h.pct, 50)
  })

  test('without any window the pct is null', () => {
    const h = headlineOf(timeline(), null)
    assert.equal(h.window, undefined)
    assert.equal(h.pct, null)
  })

  test('a non-positive window yields a null pct', () => {
    const h = headlineOf(timeline({ contextWindow: 0 }), null)
    assert.equal(h.pct, null)
  })

  test('the pct clamps at 100', () => {
    const h = headlineOf(timeline(), { projectedTokens: 250, contextWindow: 100 })
    assert.equal(h.pct, 100)
  })
})

describe('headlineOf parts', () => {
  test('a known positive occupancy anchors the parts to it', () => {
    const h = headlineOf(timeline(), { projectedTokens: 200 })
    // Raw composition sums to 100 (10/20/30/0/40/0); anchored to 200.
    assert.deepEqual(
      h.parts.map(p => [p.key, p.value, p.raw]),
      [
        ['system', 20, 10],
        ['tools', 40, 20],
        ['user', 60, 30],
        ['inject', 0, 0],
        ['assistant', 80, 40],
        ['tool', 0, 0],
      ],
    )
  })

  test('without an occupancy the parts stay unanchored (value equals raw)', () => {
    const h = headlineOf(timeline(), null)
    assert.deepEqual(h.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [40, 40], [0, 0],
    ])
  })

  test('a zero occupancy does not anchor the parts', () => {
    const h = headlineOf(timeline(), { projectedTokens: 0 })
    assert.equal(h.tokens, 0)
    assert.deepEqual(h.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [40, 40], [0, 0],
    ])
  })
})
