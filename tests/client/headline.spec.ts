// Headline derivation (src/client/headline.ts): the provider-anchored occupancy ladder, the window/pct pairing
// on the kernel's occupancy grid, and the anchored composition parts.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { headlineOf, occupancyPercent, wireGapOf, WIRE_GAP_MIN } from '../../src/client/headline'
import type { ContextTimeline, RequestRecord } from '../../src/shared/types'

function timeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 10, tools: 20, user: 30, inject: 0, skill: 0, assistant: 40, tool: 0, total: 100 },
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

  test('the bare provider sample serves when the projection carries no forward value', () => {
    // The kernel's own order (contextOccupancy: projectedTokens ?? pressureTokens),
    // ahead of the plugin's derived anchor — the sample's 150, not the derived 170.
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, { pressureTokens: 150, contextWindow: 1000 })
    assert.equal(h.tokens, 150)
    assert.equal(h.pct, 15)
  })

  test('a non-number pressureTokens falls through to the derived anchor', () => {
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, { pressureTokens: 'junk' as unknown as number })
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

  test('the split head anchors the derivation from `last` (the records ride the detail channel)', () => {
    const h = headlineOf(timeline({ last: { seq: 9, total: 80, prompt: 150 } }), null)
    assert.equal(h.tokens, 170)
  })

  test('a `last` without a numeric prompt yields no derived anchor', () => {
    const h = headlineOf(timeline({ last: { seq: 9, total: 80 } }), null)
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

  test('the pct keeps one decimal on the kernel\'s occupancy grid', () => {
    // The kernel reads round(200 / 300 * 100) = 67; the plugin prints 66.7.
    const h = headlineOf(timeline(), { projectedTokens: 200, contextWindow: 300 })
    assert.equal(h.pct, 66.7)
    assert.equal(headlineOf(timeline(), { projectedTokens: 1, contextWindow: 1_000_000 }).pct, 0)
  })

  test('the pct clamps at 100', () => {
    const h = headlineOf(timeline(), { projectedTokens: 250, contextWindow: 100 })
    assert.equal(h.pct, 100)
    // An occupancy past its own window (a compacted/shrunk route) never over-reads.
    assert.equal(occupancyPercent(400, 300), 100)
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
        ['skill', 0, 0],
        ['assistant', 80, 40],
        ['tool', 0, 0],
      ],
    )
  })

  test('without an occupancy the parts stay unanchored (value equals raw)', () => {
    const h = headlineOf(timeline(), null)
    assert.deepEqual(h.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
  })

  test('a zero occupancy does not anchor the parts', () => {
    const h = headlineOf(timeline(), { projectedTokens: 0 })
    assert.equal(h.tokens, 0)
    assert.deepEqual(h.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
  })
})

describe('headlineOf sampled', () => {
  test('exposes the provider sample behind a projected anchor', () => {
    const h = headlineOf(timeline(), { projectedTokens: 200, pressureTokens: 150 })
    assert.equal(h.tokens, 200)
    assert.equal(h.sampled, 150)
  })

  test('exposes the bare sample when it anchors the headline', () => {
    const h = headlineOf(timeline(), { pressureTokens: 150 })
    assert.equal(h.sampled, 150)
  })

  test('a projection without its own sample falls back to the derived request prompt', () => {
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, { projectedTokens: 999 })
    assert.equal(h.sampled, 150)
  })

  test('without a projection the derived request prompt serves as the sample', () => {
    const data = timeline({ requests: [req({ prompt: 150 })] })
    const h = headlineOf(data, null)
    assert.equal(h.sampled, 150)
  })

  test('the split head anchors the sample from `last`', () => {
    const h = headlineOf(timeline({ last: { seq: 9, total: 80, prompt: 150 } }), null)
    assert.equal(h.sampled, 150)
  })

  test('non-number samples expose nothing', () => {
    const data = timeline({ requests: [req({ prompt: 'junk' as unknown as number })] })
    assert.equal(headlineOf(data, { pressureTokens: 'junk' as unknown as number }).sampled, undefined)
    assert.equal(headlineOf(timeline({ last: { seq: 9, total: 80 } }), null).sampled, undefined)
  })
})

describe('wireGapOf', () => {
  test('flags the sample when the headline outgrows it by ratio and margin', () => {
    assert.equal(wireGapOf({ tokens: 1_000_000, sampled: 300_000 }), 300_000)
  })

  test('exactly twice the sample with the minimum margin flags', () => {
    assert.equal(wireGapOf({ tokens: WIRE_GAP_MIN * 2, sampled: WIRE_GAP_MIN }), WIRE_GAP_MIN)
  })

  test('below the absolute margin no flag at the exact ratio', () => {
    // Ratio holds (8000 = 2 × 4000) but the 4000 gap stays under the minimum.
    assert.equal(wireGapOf({ tokens: 8000, sampled: 4000 }), null)
  })

  test('below the ratio no flag even past the absolute margin', () => {
    assert.equal(wireGapOf({ tokens: 7_000, sampled: 4_000 }), null)
  })

  test('a sample above the headline never flags (the heuristic underpricing direction)', () => {
    assert.equal(wireGapOf({ tokens: 300_000, sampled: 500_000 }), null)
  })

  test('no sample or non-positive values yield nothing', () => {
    assert.equal(wireGapOf({ tokens: 1_000_000 }), null)
    assert.equal(wireGapOf({ tokens: 1_000_000, sampled: 0 }), null)
    assert.equal(wireGapOf({ tokens: 0, sampled: 100 }), null)
  })
})
