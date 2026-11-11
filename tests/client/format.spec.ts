// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test, afterEach, vi } from 'vitest'
import { cacheHitPercent, fmt, fmtBytes, fmtDateTime, fmtDuration, fmtShare, fmtTime } from '../../src/client/format'
import { headlineOf, occupancyPercent } from '../../src/client/headline'
import { type ContextTimeline, type RequestRecord, type ContextBreakdown, type Snapshot, type TokenUsage } from '../../src/shared/types'
import { anchoredParts, billedParts, officialParts, partsOf, type PartsPart } from '../../src/client/categories'
import { createContextSettings } from '../../src/client/settings'
import { watchPlacement } from '../../src/client/placement'
import { bareModelOf, familyVendorOf, isSubscriptionPlanProvider, labOf, lowerModelId, normalizeModelId, orgOf, suffixKeys } from '../../src/shared/priceIdentity'
import { canOpenPathsOf, openChildAsideVia, openPathVia, openPluginSettings, openResourceVia, openSessionVia, subagentChatAddressOf, type ClientCtx } from '../../src/client/services'
import { COMMANDS_ROUTE } from '../../src/client/apiRoutes'
import { commandPageOf, makeCommandPager } from '../../src/client/commandPages'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

describe('format', () => {

describe('fmt', () => {
  test('missing/NaN input shows the dash', () => {
    assert.equal(fmt(undefined), '—')
    assert.equal(fmt(null), '—')
    assert.equal(fmt(NaN), '—')
  })

  test('small numbers round to integers; thousands, millions, and billions take suffixes with one decimal', () => {
    assert.equal(fmt(0), '0')
    assert.equal(fmt(999.4), '999')
    assert.equal(fmt(1000), '1.0k')
    assert.equal(fmt(1534), '1.5k')
    assert.equal(fmt(1_000_000), '1.0M')
    assert.equal(fmt(128_000), '128.0k')
    assert.equal(fmt(1_000_000_000), '1.0B')
    assert.equal(fmt(1_055_900_000), '1.1B')
  })

  test('negatives keep their sign', () => {
    assert.equal(fmt(-1500), '-1.5k')
    assert.equal(fmt(-12), '-12')
    assert.equal(fmt(-2_000_000_000), '-2.0B')
  })
})

describe('fmtBytes', () => {
  test('missing/NaN/negative input shows the dash; B/kB/MB split at decimal thresholds', () => {
    assert.equal(fmtBytes(undefined), '—')
    assert.equal(fmtBytes(null), '—')
    assert.equal(fmtBytes(NaN), '—')
    assert.equal(fmtBytes(-1), '—')
    assert.equal(fmtBytes(512), '512 B')
    assert.equal(fmtBytes(2048), '2.0 kB')
    assert.equal(fmtBytes(3_500_000), '3.5 MB')
  })
})

describe('cacheHitPercent', () => {
  test('null when nothing was billed; otherwise two decimals, cut not rounded', () => {
    assert.equal(cacheHitPercent(5, 0), null)
    assert.equal(cacheHitPercent(0, -1), null)
    assert.equal(cacheHitPercent(1, 3), '33.33')
    assert.equal(cacheHitPercent(82499, 83000), '99.39')
    assert.equal(cacheHitPercent(83000, 83000), '100.00')
  })
})

describe('fmtTime / fmtDateTime', () => {
  test('invalid dates show the dash while valid instants carry the full reading', () => {
    assert.equal(fmtTime(NaN), '—')
    assert.match(fmtTime(1000), /^\d{2}:\d{2}:\d{2}$/)
    assert.equal(fmtDateTime(NaN), '—')
    assert.match(fmtDateTime(1000), /^\d{2}\/\d{2}\/\d{4}, \d{2}:\d{2}:\d{2}$/)
  })
})

describe('fmtShare', () => {
  test('nothing to total shows the dash; empty slices and crumbs never round up', () => {
    assert.equal(fmtShare(0, 0), '—')
    assert.equal(fmtShare(5, 0), '—')
    assert.equal(fmtShare(NaN, 100), '—')
    assert.equal(fmtShare(5, Infinity), '—')
    assert.equal(fmtShare(0, 100), '0.0%')
    assert.equal(fmtShare(-1, 100), '0.0%')
    assert.equal(fmtShare(1, 2000), '<0.1%')
    assert.equal(fmtShare(1, 1000), '0.1%')
    assert.equal(fmtShare(0.5, 100), '0.5%')
    assert.equal(fmtShare(1, 300), '0.3%')
  })

  test('shares carry one decimal and cap at 100', () => {
    assert.equal(fmtShare(844, 1000), '84.4%')
    assert.equal(fmtShare(738.4, 1000), '73.8%')
    assert.equal(fmtShare(996, 1000), '99.6%')
    assert.equal(fmtShare(3000, 1000), '100.0%')
    assert.equal(fmtShare(1, 3), '33.3%')
  })
})

describe('fmtDuration', () => {
  test('non-finite and non-positive input shows the dash', () => {
    assert.equal(fmtDuration(0), '—')
    assert.equal(fmtDuration(-5), '—')
    assert.equal(fmtDuration(NaN), '—')
    assert.equal(fmtDuration(Infinity), '—')
  })

  test('duration steps through raw ms, seconds, minutes, and hours', () => {
    assert.equal(fmtDuration(740), '740ms')
    assert.equal(fmtDuration(999.6), '1000ms')
    assert.equal(fmtDuration(12_300), '12.3s')
    assert.equal(fmtDuration(205_000), '3m25s')
    assert.equal(fmtDuration(600_000), '10m0s')
    assert.equal(fmtDuration(4_440_000), '1h14m')
    assert.equal(fmtDuration(7_320_000), '2h2m')
  })
})
})

describe('headline', () => {

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
  test('the projection anchors first, then the derived request/`last` anchor, then the heuristic total', () => {
    const h = headlineOf(timeline(), { projectedTokens: 200, contextWindow: 1000 })
    assert.equal(h.tokens, 200)
    assert.equal(h.window, 1000)
    assert.equal(h.pct, 20)
    assert.equal(headlineOf(timeline({ requests: [req({ prompt: 150 })] }), { projectedTokens: 200 }).tokens, 200)
    const data = timeline({ requests: [req({ prompt: 150 })] })
    assert.equal(headlineOf(data, { projectedTokens: 'junk' as unknown as number }).tokens, 170)
    assert.equal(headlineOf(data, { pressureTokens: 'junk' as unknown as number }).tokens, 170)
    const sample = headlineOf(data, { pressureTokens: 150, contextWindow: 1000 })
    assert.equal(sample.tokens, 150, 'the bare provider sample serves when the projection carries no forward value')
    assert.equal(sample.pct, 15)
    assert.equal(headlineOf(timeline({ requests: [req({ prompt: 150, total: 80 })] }), null).tokens, 170)
    assert.equal(headlineOf(timeline({ last: { seq: 9, total: 80, prompt: 150 } }), null).tokens, 170)
    assert.equal(headlineOf(timeline(), null).tokens, 100, 'empty requests yield no anchor')
    assert.equal(headlineOf(timeline({ requests: [req()] }), null).tokens, 100, 'a request without a numeric prompt yields no anchor')
    assert.equal(headlineOf(timeline({ last: { seq: 9, total: 80 } }), null).tokens, 100, 'a `last` without a numeric prompt yields no anchor')
    assert.equal(headlineOf(timeline()).tokens, 100, 'no anchor anywhere')
  })
})

describe('headlineOf window and pct', () => {
  test("the pressure window wins over the timeline one; pct uses the plugin's 0.1 grid, not the kernel's whole-percent rounding; no or non-positive windows yield a null pct; pct clamps", () => {
    assert.equal(headlineOf(timeline({ contextWindow: 1000 }), { contextWindow: 500 }).window, 500)
    assert.equal(headlineOf(timeline({ contextWindow: 1000 }), { contextWindow: 500 }).pct, 20)
    const fallback = headlineOf(timeline({ contextWindow: 200 }), { contextWindow: 'junk' as unknown as number })
    assert.equal(fallback.window, 200)
    assert.equal(fallback.pct, 50)
    const bare = headlineOf(timeline(), null)
    assert.equal(bare.window, undefined)
    assert.equal(bare.pct, null)
    assert.equal(headlineOf(timeline({ contextWindow: 0 }), null).pct, null)
    assert.equal(headlineOf(timeline(), { projectedTokens: 200, contextWindow: 300 }).pct, 66.7)
    assert.equal(headlineOf(timeline(), { projectedTokens: 1, contextWindow: 1_000_000 }).pct, 0)
    assert.equal(headlineOf(timeline(), { projectedTokens: 250, contextWindow: 100 }).pct, 100)
    assert.equal(occupancyPercent(400, 300), 100)
  })
})

describe('headlineOf reserve', () => {
  test('the window and output cap resolve the two masks; no cap leaves the headroom mask; no window leaves no reserve', () => {
    const h = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 256_000 }), null)
    assert.deepEqual(h.reserve, { threshold: 678_464, headroom: 65_536, output: 256_000 })
    const pressured = headlineOf(timeline({ maxOutputTokens: 256_000 }), { contextWindow: 1_000_000 })
    assert.deepEqual(pressured.reserve, { threshold: 678_464, headroom: 65_536, output: 256_000 })
    const uncapped = headlineOf(timeline({ contextWindow: 1_000_000 }), null)
    assert.deepEqual(uncapped.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    const hostile = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 'junk' as unknown as number }), null)
    assert.deepEqual(hostile.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    const zero = headlineOf(timeline({ contextWindow: 1_000_000, maxOutputTokens: 0 }), null)
    assert.deepEqual(zero.reserve, { threshold: 800_000, headroom: 65_536, output: 0 })
    assert.equal(headlineOf(timeline({ maxOutputTokens: 256_000 }), null).reserve, undefined)
  })
})

describe('headlineOf parts', () => {
  test('a positive occupancy anchors the parts to it; without one they stay unanchored (value equals raw)', () => {
    assert.deepEqual(headlineOf(timeline(), { projectedTokens: 200 }).parts.map(p => [p.key, p.value, p.raw]), [
      ['system', 20, 10],
      ['tools', 40, 20],
      ['user', 60, 30],
      ['inject', 0, 0],
      ['skill', 0, 0],
      ['assistant', 80, 40],
      ['tool', 0, 0],
    ])
    assert.deepEqual(headlineOf(timeline(), null).parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
    const zero = headlineOf(timeline(), { projectedTokens: 0 })
    assert.equal(zero.tokens, 0)
    assert.deepEqual(zero.parts.map(p => [p.value, p.raw]), [
      [10, 10], [20, 20], [30, 30], [0, 0], [0, 0], [40, 40], [0, 0],
    ])
  })
})
})

describe('categories', () => {

function current(over: Partial<Snapshot['current']> = {}): Snapshot['current'] {
  return { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function values(parts: PartsPart[]): Record<string, number> {
  return Object.fromEntries(parts.map(p => [p.key, p.value]))
}

function part(value: number, raw?: number): PartsPart {
  return raw === undefined ? { key: 'k', color: '#000', value } : { key: 'k', color: '#000', value, raw }
}

describe('partsOf', () => {
  test('reads all seven categories in CATS order with their colors; missing keys fall back to zero', () => {
    const parts = partsOf(current({ system: 1, tools: 2, user: 3, inject: 4, skill: 5, assistant: 6, tool: 7 }))
    assert.deepEqual(parts.map(p => [p.key, p.color, p.value]), [
      ['system', 'var(--color-indigo-500)', 1],
      ['tools', 'var(--color-amber-500)', 2],
      ['user', 'var(--color-green-500)', 3],
      ['inject', 'var(--color-purple-500)', 4],
      ['skill', 'var(--color-orange-500)', 5],
      ['assistant', 'var(--color-blue-500)', 6],
      ['tool', 'var(--color-teal-500)', 7],
    ])
    assert.deepEqual(values(partsOf({ system: 5, user: 10 } as unknown as Snapshot['current'])), { system: 5, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })
})

describe('officialParts', () => {
  test('without a breakdown the fold sums serve as-is; a breakdown supplies system/tools/messages, falling back per field', () => {
    const cur = current({ system: 5, tools: 7, user: 10, assistant: 30, tool: 60, total: 112 })
    assert.deepEqual(values(officialParts(cur, null)), { system: 5, tools: 7, user: 10, inject: 0, skill: 0, assistant: 30, tool: 60 })
    const partial = officialParts(current({ system: 1, tools: 2, user: 10, total: 13 }), { systemTokens: 9 } as unknown as ContextBreakdown)
    assert.deepEqual(values(partial), { system: 9, tools: 2, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0 })
    const delivered = officialParts(current({ system: 1, tools: 2, user: 50, assistant: 50, total: 102 }), { systemTokens: 100, toolsTokens: 200, messageTokens: 20 })
    assert.deepEqual(values(delivered), { system: 100, tools: 200, user: 10, inject: 0, skill: 0, assistant: 10, tool: 0 })
  })

  test('rounding residue lands on the largest category, a negative residue clamps to zero, and an empty surface yields zero message shares', () => {
    const residue = officialParts(current({ system: 1, tools: 2, user: 33, assistant: 33, tool: 34, total: 103 }), { systemTokens: 0, toolsTokens: 0, messageTokens: 10 })
    assert.deepEqual(values(residue), { system: 0, tools: 0, user: 3, inject: 0, skill: 0, assistant: 3, tool: 4 })
    const clamped = officialParts(current({ user: 25, inject: 25, assistant: 25, tool: 25, total: 100 }), { systemTokens: 0, toolsTokens: 0, messageTokens: 2 })
    assert.deepEqual(values(clamped), { system: 0, tools: 0, user: 0, inject: 1, skill: 0, assistant: 1, tool: 1 })
    const empty = officialParts(current(), { systemTokens: 1, toolsTokens: 2, messageTokens: 100 })
    assert.deepEqual(values(empty), { system: 1, tools: 2, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 })
  })
})

describe('anchoredParts', () => {
  test('a null or non-positive target, or a zero raw total, returns the parts unchanged with raw defaulted', () => {
    assert.deepEqual(anchoredParts([part(100), part(50, 20)], null), [
      { key: 'k', color: '#000', value: 100, raw: 100 },
      { key: 'k', color: '#000', value: 50, raw: 20 },
    ])
    assert.deepEqual(anchoredParts([part(100)], 0), [{ key: 'k', color: '#000', value: 100, raw: 100 }])
    assert.deepEqual(anchoredParts([part(0), part(0)], 100), [
      { key: 'k', color: '#000', value: 0, raw: 0 },
      { key: 'k', color: '#000', value: 0, raw: 0 },
    ])
  })

  test('a target equal to the raw total rewrites value to raw; otherwise values scale by the raw ratios', () => {
    assert.deepEqual(anchoredParts([part(10, 60), part(90, 40)], 100).map(p => [p.value, p.raw]), [[60, 60], [40, 40]])
    assert.deepEqual(anchoredParts([part(0, 20), part(0, 50)], 40).map(p => p.value), [11, 29])
  })
})

describe('billedParts', () => {
  const USAGE: TokenUsage = { uncachedInputTokens: 300, outputTokens: 60, cacheReadTokens: 100, cacheWriteTokens: 0 }

  test('the billed input splits by the estimated ratios, the assistant rest joins tool results, and the split scales when billed input differs', () => {
    const cur = current({ system: 50, tools: 50, user: 100, inject: 0, assistant: 100, tool: 100, total: 400 })
    assert.deepEqual(billedParts(cur, null, USAGE).map(p => [p.key, p.color, p.value]), [
      ['system', 'var(--color-indigo-500)', 50],
      ['tools', 'var(--color-amber-500)', 50],
      ['user', 'var(--color-green-500)', 100],
      ['inject', 'var(--color-purple-500)', 0],
      ['skill', 'var(--color-orange-500)', 0],
      ['toolCalls', 'var(--color-teal-500)', 260],
      ['thinking', 'var(--color-violet-500)', 0],
      ['answers', 'var(--color-pink-500)', 0],
    ])
    const scaled = billedParts(current({ system: 100, user: 100, total: 200 }), null, { ...USAGE, uncachedInputTokens: 400, cacheReadTokens: 0, outputTokens: 0 })
    assert.deepEqual(values(scaled), { system: 200, tools: 0, user: 200, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 0 })
  })

  test('a delivered breakdown supplies the split ratios; a zero billed input zeroes the prompt split but keeps the output remainder', () => {
    const cur = current({ user: 150, assistant: 150, total: 300 })
    const split = billedParts(cur, { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }, { ...USAGE, uncachedInputTokens: 800, cacheReadTokens: 0 })
    assert.deepEqual(values(split), { system: 200, tools: 200, user: 200, inject: 0, skill: 0, toolCalls: 260, answers: 0, thinking: 0 })
    const zero = billedParts(current({ system: 100, user: 100, total: 200 }), null, { uncachedInputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 })
    assert.deepEqual(values(zero), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 25, answers: 0, thinking: 0 })
  })

  test('the assistant bucket splits by content ratios, and the same ratios split the generated output', () => {
    const cur = current({ system: 100, assistant: 100, assistantReasoning: 60, assistantCallTokens: 40, total: 200 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20, calls: 60 })
    assert.deepEqual(values(parts), { system: 100, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 70, answers: 0, thinking: 80 })
    assert.deepEqual(parts.map(p => p.value).reduce((a, b) => a + b, 0), 250, 'the parts still total the chat line')
  })

  test('reply text splits out of the assistant bucket and output, and a text-only session never lands a token on Tool Calls', () => {
    const cur = current({ assistant: 100, assistantReasoning: 60, assistantAnswerTokens: 20, total: 100 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20, answers: 10 })
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 55, thinking: 95 })
    assert.deepEqual(parts.map(p => p.value).reduce((a, b) => a + b, 0), 150, 'the parts still total the chat line')
  })

  test('reasoning and answers never exceed their source buckets: hostile shares clamp to the assistant and output remainders', () => {
    const reasoned = billedParts(
      current({ assistant: 100, assistantReasoning: 200, total: 100 }),
      null,
      { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 999 },
    )
    assert.deepEqual(values(reasoned), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 110 })
    const answered = billedParts(
      current({ assistant: 100, assistantReasoning: 80, assistantAnswerTokens: 90, total: 100 }),
      null,
      { uncachedInputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 10, answers: 999 },
    )
    assert.deepEqual(values(answered), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 20, thinking: 90 })
  })

  test('generated reasoning and answers need no live subset, and a zero billed input still splits the output remainder', () => {
    const cur = current({ assistant: 200, total: 200 })
    const parts = billedParts(cur, null, { uncachedInputTokens: 200, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, { reasoning: 20 })
    assert.deepEqual(values(parts), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 200, answers: 0, thinking: 50 })
    const noInput = billedParts(
      current({ assistant: 100, total: 100 }),
      null,
      { uncachedInputTokens: 0, outputTokens: 25, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: 10, answers: 5 },
    )
    assert.deepEqual(values(noInput), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 15, thinking: 10 })
  })

  test('an all-zero composition leaves the billed input unattributed, and hostile buckets never yield negative parts', () => {
    assert.deepEqual(values(billedParts(current(), null, USAGE)), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 60, answers: 0, thinking: 0 })
    const hostile = billedParts(
      current({ system: 100, assistantReasoning: -5, assistantAnswerTokens: -7, total: 100 }),
      null,
      { uncachedInputTokens: -10, outputTokens: -5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      { reasoning: -10, answers: -20 },
    )
    assert.deepEqual(values(hostile), { system: 0, tools: 0, user: 0, inject: 0, skill: 0, toolCalls: 0, answers: 0, thinking: 0 })
  })
})
})

describe('placement', () => {

function mountSpy(): { factory: () => () => void; mounted: () => number; disposed: () => number } {
  let mountedCount = 0
  let disposedCount = 0
  return {
    factory: () => {
      mountedCount += 1
      return () => { disposedCount += 1 }
    },
    mounted: () => mountedCount,
    disposed: () => disposedCount,
  }
}

describe('watchPlacement', () => {
  test("the default 'all' mounts both; flips dispose only the dropped side and remount it on return, with no churn", () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'sidebar')
    assert.equal(tab.disposed(), 1, 'the dropped tab registration was disposed')
    assert.equal(tab.mounted(), 1, 'no remount churn')
    assert.equal(sidebar.disposed(), 0, 'the sidebar stays mounted')
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'tab')
    assert.equal(sidebar.disposed(), 1)
    assert.equal(sidebar.mounted(), 1)
    assert.equal(tab.mounted(), 2, 'the tab comes back')
    assert.equal(tab.disposed(), 1)
    dispose()
  })

  test("'hide' unwinds both without remount churn; 'all' restores both; unrelated preference changes never remount", () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })

    settings.set('defaultGranularity', 'turn')
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'hide')
    assert.equal(tab.disposed(), 1)
    assert.equal(sidebar.disposed(), 1)
    settings.set('defaultPlacement', 'hide')
    assert.equal(tab.mounted(), 1, 'a hidden panel entry never churns')
    assert.equal(sidebar.mounted(), 1)

    settings.set('defaultPlacement', 'all')
    assert.equal(tab.mounted(), 2)
    assert.equal(sidebar.mounted(), 2)
    settings.set('defaultPlacement', 'tab')
    settings.set('defaultPlacement', 'all')
    assert.equal(tab.mounted(), 2, 'the kept side is never churned')
    assert.equal(sidebar.mounted(), 3, 'the dropped side remounts once')
    assert.equal(sidebar.disposed(), 2)
    dispose()
    assert.equal(tab.disposed(), 2)
    assert.equal(sidebar.disposed(), 3)
  })

  test("a 'tab'-only or 'sidebar'-only start mounts just that side", () => {
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'tab')
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 0)
    dispose()
    assert.equal(tab.disposed(), 1)
    assert.equal(sidebar.disposed(), 0)

    const again = createContextSettings()
    again.set('defaultPlacement', 'sidebar')
    const tab2 = mountSpy()
    const sidebar2 = mountSpy()
    const dispose2 = watchPlacement(again, { tab: tab2.factory, sidebar: sidebar2.factory })
    assert.equal(tab2.mounted(), 0)
    assert.equal(sidebar2.mounted(), 1)
    dispose2()
  })

  test('the watcher disposer unwinds every mount and detaches the store', () => {
    const settings = createContextSettings()
    const tab = mountSpy()
    const sidebar = mountSpy()
    const dispose = watchPlacement(settings, { tab: tab.factory, sidebar: sidebar.factory })
    dispose()
    assert.equal(tab.disposed(), 1)
    assert.equal(sidebar.disposed(), 1)
    settings.set('defaultPlacement', 'sidebar')
    assert.equal(tab.mounted(), 1)
    assert.equal(sidebar.mounted(), 1)
    assert.doesNotThrow(dispose)
    assert.equal(tab.disposed(), 1, 'no double unwind')
  })

  test('a disposerless mount is tolerated and still counted as mounted — later publishes never register a second copy', () => {
    const settings = createContextSettings()
    const dispose = watchPlacement(settings, {
      tab: () => undefined,
      sidebar: () => undefined,
    })
    assert.doesNotThrow(() => { settings.set('defaultPlacement', 'tab') })
    assert.doesNotThrow(() => { dispose() })

    const counted = createContextSettings()
    let tabs = 0
    let sidebars = 0
    watchPlacement(counted, {
      tab: () => { tabs += 1; return undefined },
      sidebar: () => { sidebars += 1; return undefined },
    })
    assert.equal(tabs, 1)
    assert.equal(sidebars, 1)
    counted.set('defaultGranularity', 'turn')
    counted.set('defaultPlacement', 'tab')
    assert.equal(tabs, 1, 'the tab is never mounted twice')
    assert.equal(sidebars, 1, 'the sidebar unwound once and does not come back on its own')
    counted.set('defaultPlacement', 'all')
    assert.equal(tabs, 1)
    assert.equal(sidebars, 2)
  })
})
})

describe('priceIdentity', () => {

describe('path helpers', () => {
  test('lowercases and trims the lookup key', () => {
    assert.equal(lowerModelId('  Claude-Sonnet-4.5 '), 'claude-sonnet-4.5')
  })

  test('bareModelOf keeps the last segment', () => {
    assert.equal(bareModelOf('anthropic/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('openrouter/anthropic/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('/claude-sonnet-5'), 'claude-sonnet-5')
    assert.equal(bareModelOf('claude-sonnet-5'), 'claude-sonnet-5')
  })

  test('orgOf returns the first segment only when there is one', () => {
    assert.equal(orgOf('google-vertex/gemini-4-argon'), 'google-vertex')
    assert.equal(orgOf('openrouter/anthropic/claude'), 'openrouter')
    assert.equal(orgOf('gemini-4-argon'), undefined)
    assert.equal(orgOf('/gemini-4-argon'), undefined)
  })

  test('labOf reads the lab from a canonical id', () => {
    assert.equal(labOf('anthropic/claude-sonnet-5'), 'anthropic')
    assert.equal(labOf('claude-sonnet-5'), undefined)
    assert.equal(labOf('/claude-sonnet-5'), undefined)
  })
})

describe('normalizeModelId', () => {
  test('strips gateway paths, billing variants, and resource decorations', () => {
    assert.equal(normalizeModelId('workers-ai/@cf/zai-org/GLM-5.2:free@default'), 'zai-org/glm-5-2:free')
    assert.equal(normalizeModelId('accounts/fireworks/models/deepseek-v4p1-flash'), 'deepseek-v4-1-flash')
    assert.equal(normalizeModelId('accounts/fireworks/routers/kimi-k3-fast'), 'kimi-k3-fast')
    assert.equal(normalizeModelId('hf:zai-org/GLM-5.2'), 'zai-org/glm-5-2')
    assert.equal(normalizeModelId('global.anthropic.claude-opus-4-6-v1:0'), 'anthropic-claude-opus-4-6')
    assert.equal(normalizeModelId('us.anthropic.claude-opus-4-6-v1:0'), 'anthropic-claude-opus-4-6')
    assert.equal(normalizeModelId('eu.mistral-large'), 'mistral-large')
    assert.equal(normalizeModelId('apac.gemini-2.5-pro'), 'gemini-2-5-pro')
    assert.equal(normalizeModelId('claude-sonnet-4-5@20250929'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('claude-sonnet-4-5@default'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('gpt-5.6-sol-20260709'), 'gpt-5-6-sol')
    assert.equal(normalizeModelId('gpt-5.6-sol-260709'), 'gpt-5-6-sol')
    assert.equal(normalizeModelId('claude-sonnet-4.5'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('claude-sonnet-4.5:free'), 'claude-sonnet-4-5:free')
    assert.equal(normalizeModelId('claude-sonnet-4.5:batch'), 'claude-sonnet-4-5:batch')
    assert.equal(normalizeModelId('claude-sonnet-4.5-latest'), 'claude-sonnet-4-5')
    assert.equal(normalizeModelId('deepseek-v4p1-flash'), 'deepseek-v4-1-flash')
    assert.equal(normalizeModelId('__weird__--model__'), 'weird-model')
  })
})

describe('suffix and form helpers', () => {
  test('suffixKeys emits slash/dash tails', () => {
    assert.deepEqual(suffixKeys('kimi-k3'), ['k3'])
    assert.deepEqual(suffixKeys('anthropic/claude-fable-5'), ['claude-fable-5', 'fable-5', '5'])
    assert.deepEqual(suffixKeys('a-a'), ['a'])
    assert.deepEqual(suffixKeys('single'), [])
  })

})

describe('isSubscriptionPlanProvider', () => {
  test('recognizes plan branches but not ordinary routes or subscription products', () => {
    assert.equal(isSubscriptionPlanProvider('kimi-code-plan-global'), true)
    assert.equal(isSubscriptionPlanProvider('zai-coding-plan'), true)
    assert.equal(isSubscriptionPlanProvider('alibaba-token-plan-cn'), true)
    assert.equal(isSubscriptionPlanProvider('xiaomi-token-plan-ams'), true)
    assert.equal(isSubscriptionPlanProvider('kimi-coding'), false)
    assert.equal(isSubscriptionPlanProvider('opencode'), false)
    assert.equal(isSubscriptionPlanProvider('github-copilot'), false)
    assert.equal(isSubscriptionPlanProvider('moonshotai'), false)
  })
})

describe('familyVendorOf', () => {
  test('maps mainstream families to their maker; unknown families have no vendor hint', () => {
    assert.equal(familyVendorOf('anthropic/claude-sonnet-4.5'), 'anthropic')
    assert.equal(familyVendorOf('openai/gpt-5.6-sol'), 'openai')
    assert.equal(familyVendorOf('o1-preview'), 'openai')
    assert.equal(familyVendorOf('gemini-4-argon'), 'google')
    assert.equal(familyVendorOf('gemma-3-27b'), 'google')
    assert.equal(familyVendorOf('deepseek-v4-pro'), 'deepseek')
    assert.equal(familyVendorOf('kimi-k3'), 'moonshotai')
    assert.equal(familyVendorOf('z-ai/glm-5.3'), 'zhipuai')
    assert.equal(familyVendorOf('Qwen3.8-Max'), 'alibaba')
    assert.equal(familyVendorOf('x-ai/grok-4.6'), 'xai')
    assert.equal(familyVendorOf('meta-llama/Llama-4'), 'meta')
    assert.equal(familyVendorOf('MiniMax-M2.5'), 'minimax')
    assert.equal(familyVendorOf('mimo-v2.5'), 'xiaomi')
    assert.equal(familyVendorOf('mistral-large'), 'mistral')
    assert.equal(familyVendorOf('codestral-2'), 'mistral')
    assert.equal(familyVendorOf('pixtral-large'), 'mistral')
    assert.equal(familyVendorOf('command-a'), 'cohere')
    assert.equal(familyVendorOf('nemotron-4'), 'nvidia')
    assert.equal(familyVendorOf('k3'), undefined)
    assert.equal(familyVendorOf('mystery-model'), undefined)
  })
})
})

describe('servicesNavigation', () => {

const ctxWith = (services: Record<string, unknown>): ClientCtx =>
  ({ get: (name: string) => services[name] }) as unknown as ClientCtx

describe('canOpenPathsOf / openPathVia', () => {
  const rpcConn = (routes: Record<string, () => unknown>, over: Record<string, unknown> = {}): Record<string, unknown> => ({
    isLoopback: true,
    rpc: { call: (channel: string, endpoint: string) => Promise.resolve(routes[endpoint]?.()) },
    ...over,
  })
  const openable = (): Record<string, unknown> =>
    rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: true }) })

  test('the capability remote gates the opener behind the loopback fact; hostile connections and failed transports resolve false', async () => {
    assert.equal(await canOpenPathsOf(ctxWith({ connection: openable() })), true)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: true, value: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => ({ ok: false }) }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: rpcConn({ 'session/canOpenWorkspacePath': () => 'garbage' }) })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: false, rpc: openable().rpc } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({})), false)
    const throwProp = (): never => { throw new Error('boom') }
    assert.equal(await canOpenPathsOf({ get: throwProp } as unknown as ClientCtx), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { get call(): unknown { return throwProp() } } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { get isLoopback(): boolean { return throwProp() }, rpc: openable().rpc } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: 7 } } })), false)
    assert.equal(await canOpenPathsOf(ctxWith({ connection: { isLoopback: true, rpc: { call: () => Promise.reject(new Error('offline')) } } })), false)
  })

  test('openPathVia returns a fire-and-forget caller that forwards the path and swallows failures', () => {
    const open = openPathVia(ctxWith({ connection: { rpc: { call: () => Promise.reject(new Error('no desktop')) } } }))
    assert.ok(open !== undefined)
    open('/repo/a.ts')
    const syncThrow = openPathVia(ctxWith({ connection: { rpc: { call: () => { throw new Error('sync') } } } }))
    syncThrow!('/repo/a.ts')
    assert.equal(openPathVia(ctxWith({})), undefined)
    const calls: { channel: string; endpoint: string; payload: unknown }[] = []
    const forwarding = openPathVia(ctxWith({
      connection: {
        rpc: {
          call: (channel: string, endpoint: string, payload: unknown) => {
            calls.push({ channel, endpoint, payload })
            return Promise.resolve({ ok: true, value: { opened: true } })
          },
        },
      },
    }))
    forwarding!('/repo/a.ts')
    assert.deepEqual(calls, [{ channel: '/api', endpoint: 'session/openWorkspacePath', payload: { args: { request: { path: '/repo/a.ts' } } } }])
  })
})

describe('openResourceVia', () => {

  test('forwards the address and options to the Sidebar face and reports the open', () => {
    const calls: { address: string; options: unknown }[] = []
    const open = openResourceVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }))
    assert.ok(open !== undefined)
    assert.equal(open('dsh-resource://file/session/s1/a.ts', { kind: 'subagentchat', preferNewPane: true }), true)
    assert.deepEqual(calls, [{ address: 'dsh-resource://file/session/s1/a.ts', options: { kind: 'subagentchat', preferNewPane: true } }])
  })

  test('an absent or hostile face yields no opener at all', () => {
    assert.equal(openResourceVia(ctxWith({})), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: null })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: {} })), undefined)
    assert.equal(openResourceVia(ctxWith({ sidebarRight: { openResource: 7 } })), undefined)
    assert.equal(openResourceVia({ get: () => { throw new Error('boom') } } as unknown as ClientCtx), undefined)
  })

  test('a refusal reports false instead of throwing, and the face is re-proved per call', () => {
    const open = openResourceVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }))
    assert.equal(open!('dsh-resource://file/session/s1/a.ts'), false)
    const services: Record<string, unknown> = { sidebarRight: { openResource: () => {} } }
    const proven = openResourceVia(ctxWith(services))
    assert.ok(proven !== undefined)
    services.sidebarRight = undefined
    assert.equal(proven('dsh-resource://file/session/s1/a.ts'), false, 'a revoked service refuses after the opener was built')
  })
})

describe('openSessionVia', () => {

  test('jumps through the view owner\'s own verb (issue #90), invoked bound to its service instance', () => {
    const opened: string[] = []
    openSessionVia(ctxWith({
      uiWorkspace: { openSession(id: string) { opened.push(id) } },
    }), 's2')
    assert.deepEqual(opened, ['s2'])
    let seen: unknown
    const face = {
      target: 's4',
      openSession(this: { target: string }, id: string) { seen = `${this.target}:${id}` },
    }
    openSessionVia(ctxWith({ uiWorkspace: face }), 's4')
    assert.equal(seen, 's4:s4')
  })

  test('a missing, verb-less, or hostile face never throws into the click handler', () => {
    for (const ctx of [
      ctxWith({}),
      ctxWith({ uiWorkspace: {} }),
      ctxWith({ uiWorkspace: { openSession: 7 } }),
      ctxWith({ uiWorkspace: { openSession: () => { throw new Error('boom') } } }),
      ctxWith({ uiWorkspace: { get openSession() { throw new Error('boom') } } }),
      { get: () => { throw new Error('boom') } } as unknown as ClientCtx,
    ]) openSessionVia(ctx, 's5')
  })
})

describe('openPluginSettings', () => {

  test('opens this bundle\'s page through the panel\'s own verb, bound to its service instance', () => {
    const opened: string[] = []
    openPluginSettings(ctxWith({ pluginNavigation: { openBundle: (name: string) => { opened.push(name) } } }))
    assert.deepEqual(opened, ['dsh-context'])
    let seen: unknown
    const face = {
      target: 'bundle',
      openBundle(this: { target: string }, name: string) { seen = `${this.target}:${name}` },
    }
    openPluginSettings(ctxWith({ pluginNavigation: face }))
    assert.equal(seen, 'bundle:dsh-context')
  })

  test('a shell without the Plugins panel module, a verb-less face, or a hostile face never throws', () => {
    for (const ctx of [
      ctxWith({}),
      ctxWith({ pluginNavigation: null }),
      ctxWith({ pluginNavigation: {} }),
      ctxWith({ pluginNavigation: { openBundle: 7 } }),
      ctxWith({ pluginNavigation: { openBundle: () => { throw new Error('boom') } } }),
      ctxWith({ pluginNavigation: { get openBundle() { throw new Error('boom') } } }),
      { get: () => { throw new Error('boom') } } as unknown as ClientCtx,
    ]) openPluginSettings(ctx)
  })
})

describe('openChildAsideVia', () => {

  test('the address mirrors the shipped catalog\'s canonical spelling', () => {
    assert.equal(
      subagentChatAddressOf({ parentSessionId: 'p1', childSessionId: 'c/1', mode: 'continuable' }),
      'dsh-resource://subagentchat/session/c%2F1?parent=p1&mode=continuable',
    )
  })

  test('opens the aside resource with the catalog\'s own options; a row without its projection rides the unknown mode', () => {
    const calls: { address: string; options: unknown }[] = []
    const ok = openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1', mode: 'one-shot' })
    assert.ok(ok)
    assert.equal(calls[0]?.address, 'dsh-resource://subagentchat/session/c1?parent=p1&mode=one-shot')
    assert.deepEqual(calls[0]?.options, { kind: 'subagentchat', preferNewPane: true })
    openChildAsideVia(ctxWith({
      sidebarRight: { openResource: (address: string, options?: unknown) => { calls.push({ address, options }) } },
    }), { parentSessionId: 'p1', childSessionId: 'c1' })
    assert.equal(calls[1]?.address, 'dsh-resource://subagentchat/session/c1?parent=p1&mode=unknown')
  })

  test('a parent-less address, an absent column, or an address no type claims reports false without throwing', () => {
    const opened: string[] = []
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: (a: string) => { opened.push(a) } } }), { childSessionId: 'c1' }),
      false,
    )
    assert.deepEqual(opened, [])
    const address = { parentSessionId: 'p1', childSessionId: 'c1', mode: 'continuable' } as const
    assert.equal(openChildAsideVia(ctxWith({}), address), false)
    assert.equal(
      openChildAsideVia(ctxWith({ sidebarRight: { openResource: () => { throw new Error('no type claims it') } } }), address),
      false,
    )
  })
})
})

describe('commandPages', () => {

afterEach(() => { vi.unstubAllGlobals() })

function record(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false, ...over }
}

describe('commandPageOf', () => {
  test('proves every field and keeps the valid optionals', () => {
    const page = commandPageOf({
      commands: [record({
        resultSeq: 2, parent: 3, turn: 1, step: 2, end: 11, exit: 0, outChars: 5, timeoutMs: 9, gone: 4,
        description: 'list', cwd: '/repo', sandbox: 'danger-full-access', signal: 'SIGKILL',
        cmdTruncated: true, background: true, codeMode: true, exitInferred: true, timedOut: true,
        stopped: true, denied: true, outTruncated: true, stderr: true, derived: true,
      })],
      atStart: false,
      total: 7,
    })
    assert.deepEqual(page, {
      commands: [{
        seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false,
        resultSeq: 2, parent: 3, turn: 1, step: 2, end: 11, exit: 0, outChars: 5, timeoutMs: 9, gone: 4,
        description: 'list', cwd: '/repo', sandbox: 'danger-full-access', signal: 'SIGKILL',
        cmdTruncated: true, background: true, codeMode: true, exitInferred: true, timedOut: true,
        stopped: true, denied: true, outTruncated: true, stderr: true, derived: true,
      }],
      atStart: false,
      total: 7,
    })
  })

  test('drops wrong-typed optionals and skips entries that fail the core shape', () => {
    const page = commandPageOf({
      commands: [
        record({ resultSeq: '2', parent: Number.NaN, turn: Infinity, step: '1', end: null, exit: 'zero', outChars: '9', gone: {}, description: 4, cwd: null, sandbox: 2, signal: [], cmdTruncated: 1, background: 'yes', derived: false }),
        null,
        42,
        record({ cmd: undefined }),
        record({ status: 'exploded' }),
        record({ err: 'no' }),
        record({ seq: '1' }),
        record({ time: null }),
        record({ start: 'x' }),
        record({ tool: 7 }),
        record({ seq: 2 }),
      ],
      atStart: true,
      total: 11,
    })
    assert.deepEqual(page?.commands, [
      { seq: 1, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false },
      { seq: 2, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false },
    ])
    assert.equal(page?.total, 11, 'the page total counts the log, not the readable entries')
  })

  test('rejects a page whose envelope fails the shape', () => {
    for (const value of [
      null,
      42,
      {},
      { atStart: true, commands: [] },
      { atStart: 'yes', commands: [], total: 0 },
      { atStart: true, commands: {}, total: 0 },
      { atStart: true, commands: [], total: -1 },
      { atStart: true, commands: [], total: Number.NaN },
      { atStart: true, commands: [], total: '3' },
    ]) assert.equal(commandPageOf(value), null, `rejected ${JSON.stringify(value)}`)
  })
})

describe('makeCommandPager', () => {
  test('an empty session id arms nothing', () => {
    assert.equal(makeCommandPager(''), undefined)
  })

  test('posts the read and re-proves the reply', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { commands: [record()], atStart: true, total: 1 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pager = makeCommandPager('s1', 7)
    assert.ok(pager !== undefined)
    const page = await pager(12)
    assert.deepEqual(page?.commands.map(c => c.seq), [1])
    assert.equal(fetchMock.mock.calls.length, 1)
    const [route, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    assert.equal(route, COMMANDS_ROUTE)
    assert.equal(init.method, 'POST')
    assert.deepEqual(JSON.parse(String(init.body)), { sessionId: 's1', beforeSeq: 12, limit: 7 })
  })

  test('the page size stays a host policy unless one is given', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { commands: [record()], atStart: true, total: 1 } }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    await pager(3)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    assert.deepEqual(JSON.parse(String(init.body)), { sessionId: 's1', beforeSeq: 3 })
  })

  test('the route\'s null answer stays null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    assert.equal(await pager(0), null)
  })

  test('every transport or shape failure rejects', async () => {
    const cases: unknown[] = [
      { ok: false, status: 502, json: async () => ({ ok: true, value: null }) },
      { ok: true, status: 200, json: async () => null },
      { ok: true, status: 200, json: async () => ({ ok: false }) },
      { ok: true, status: 200, json: async () => ({ ok: true, value: { atStart: true, commands: [], total: 'x' } }) },
    ]
    const pager = makeCommandPager('s1')
    assert.ok(pager !== undefined)
    for (const response of cases) {
      vi.stubGlobal('fetch', async () => response)
      await assert.rejects(pager(0))
    }
  })
})
})

describe('surfaceTakeover', () => {

const TAKEOVER = /\[data-conversation-scroll\]\[data-lc-surface\] > \[data-composer-seat\]:not\(:has\(([^)]*)\)\)/

test('the pane takeover hides the composer seat unless a compact decision card is pending', () => {
  const css = readFileSync(join(process.cwd(), 'src/client/styles/base.css'), 'utf8')
  const match = css.match(TAKEOVER)
  assert.ok(match, 'the takeover rule must keep its selector shape')
  assert.deepEqual(
    match[1].split(',').map(key => key.trim()).sort(),
    ['[data-approval-key]', '[data-plan-review-key]'].sort(),
    'a pending ask_user_question card must never keep the seat over the dashboard; only the compact approval and plan-review cards may',
  )
})
})
