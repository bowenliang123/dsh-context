import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  AGENT_CARD_H,
  agentDurationOf,
  agentForestOf,
  agentIdentityOf,
  agentRowOf,
  agentSelfOf,
  agentTurnCompletedOf,
  agentStatsOf,
  barSegments,
  familyHue,
  familyParentOf,
  fmtDurationCompact,
  layoutForest,
  neighborhoodOf,
  pressureColorOf,
  providerModelLabelOf,
  sessionTitlesOf,
  sessionsFaceOf,
  subagentCostFoldOf,
  type AgentForest,
} from '../../src/client/agentTree'
import { mergeCostUsage } from '../../src/client/cost'
import type { ContextTimeline, SessionCostUsage } from '../../src/shared/types'

function timeline(total: number, requests = 0): ContextTimeline {
  return {
    ok: true,
    contextWindow: 1000,
    current: {
      system: 0, tools: 0, user: total, inject: 0, skill: 0, assistant: 0, tool: 0, total,
    },
    requests: Array.from({ length: requests }, (_, i) => ({
      seq: i + 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1,
    })),
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
}

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { running: false, updatedAt: 1, ...over }
}

function snap(byId: Record<string, unknown>): unknown {
  return { byId }
}

const LEVEL = 180

describe('agentRowOf', () => {
  test('rejects non-records and re-proves every field', () => {
    assert.equal(agentRowOf(null), null)
    assert.equal(agentRowOf('row'), null)
    assert.deepEqual(agentRowOf({}), {
      running: false, blank: false, updatedAt: 0,
    })
    assert.deepEqual(agentRowOf({
      displayTitle: 'Main', title: 'T', parentId: 'p', origin: 'subagent',
      running: true, blank: true, updatedAt: 42,
      projectionValues: { title: 'x' },
    }), {
      displayTitle: 'Main', title: 'T', parentId: 'p', origin: 'subagent',
      running: true, blank: true, updatedAt: 42,
      projections: { title: 'x' },
    })
    assert.deepEqual(agentRowOf({
      displayTitle: 1, title: null, parentId: 2, origin: false,
      running: 'yes', updatedAt: 'soon', projectionValues: 7,
    }), { running: false, blank: false, updatedAt: 0 })
    assert.deepEqual(agentRowOf({ origin: 'team' }), { running: false, blank: false, updatedAt: 0 })
  })
})

describe('familyParentOf', () => {
  test('only a subagent row draws a family edge — fork seed lineage does not', () => {
    assert.equal(familyParentOf({ parentId: 'p', origin: 'subagent', running: false, blank: false, updatedAt: 0 }), 'p')
    assert.equal(familyParentOf({ parentId: 'p', running: false, blank: false, updatedAt: 0 }), undefined)
    assert.equal(familyParentOf({ origin: 'subagent', running: false, blank: false, updatedAt: 0 }), undefined)
    assert.equal(familyParentOf(undefined), undefined)
  })
})

describe('agentIdentityOf', () => {
  test('narrows the subagent identity projection', () => {
    assert.equal(agentIdentityOf(null), null)
    assert.equal(agentIdentityOf('x'), null)
    assert.equal(agentIdentityOf({ mode: 'weird' }), null)
    assert.deepEqual(agentIdentityOf({ mode: 'one-shot' }), { mode: 'one-shot' })
    assert.deepEqual(agentIdentityOf({ mode: 'one-shot', label: '' }), { mode: 'one-shot' })
    assert.deepEqual(agentIdentityOf({ mode: 'continuable', label: 'researcher' }), { mode: 'continuable', label: 'researcher' })
  })
})

describe('agentDurationOf', () => {
  test('folds settled + open-turn milliseconds', () => {
    assert.equal(agentDurationOf(null), null)
    assert.equal(agentDurationOf('x'), null)
    assert.equal(agentDurationOf({}), null)
    assert.equal(agentDurationOf({ settledMs: 0 }), null)
    assert.equal(agentDurationOf({ settledMs: 5000 }), 5000)
    assert.equal(agentDurationOf({ settledMs: 1000, active: { since: 10, through: 4000 } }), 4990)
    assert.equal(agentDurationOf({ active: { since: 4000, through: 10 } }), null)
    assert.equal(agentDurationOf({ active: { since: 'x', through: 3000 } }), 3000)
  })
})

describe('agentTurnCompletedOf', () => {
  test('only the harness\'s own true flag counts as a finished turn', () => {
    assert.equal(agentTurnCompletedOf(null), false)
    assert.equal(agentTurnCompletedOf('x'), false)
    assert.equal(agentTurnCompletedOf({}), false)
    assert.equal(agentTurnCompletedOf({ lastTurnCompleted: 'yes' }), false)
    assert.equal(agentTurnCompletedOf({ lastTurnCompleted: false }), false)
    assert.equal(agentTurnCompletedOf({ lastTurnCompleted: true }), true)
  })
})

describe('agentStatsOf', () => {
  test('absent values degrade to empty stats', () => {
    assert.deepEqual(agentStatsOf(undefined), {
      head: null, requests: 0, billed: null, costUsage: null, durationMs: null, identity: null,
    })
    assert.deepEqual(agentStatsOf({}), {
      head: null, requests: 0, billed: null, costUsage: null, durationMs: null, identity: null,
    })
  })

  test('timeline rows produce a full headline; a malformed usage degrades billed to null', () => {
    const cost: SessionCostUsage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } }
    const stats = agentStatsOf({
      contextTimeline: { ...timeline(500, 3), cost, model: 'deepseek-flash', reasoningEffort: 'max' },
      contextPressure: { projectedTokens: 800, contextWindow: 1000 },
      contextBreakdown: { systemTokens: 10, toolsTokens: 20, messageTokens: 470 },
      tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 },
      subagentTiming: { settledMs: 2000 },
      subagent: { mode: 'continuable', label: 'helper' },
    })
    assert.ok(stats.head !== null)
    assert.equal(stats.head.tokens, 800)
    assert.equal(stats.head.window, 1000)
    assert.equal(stats.head.pct, 80)
    assert.ok(stats.head.parts.length > 0)
    assert.equal(stats.requests, 3)
    assert.equal(stats.billed, 200)
    assert.equal(agentStatsOf({ tokenUsage: { uncachedInputTokens: 'x' } }).billed, null, 'a malformed usage never fabricates a figure')
    assert.deepEqual(stats.costUsage, cost)
    assert.equal(stats.durationMs, 2000)
    assert.deepEqual(stats.identity, { mode: 'continuable', label: 'helper' })
    assert.equal(stats.model, 'deepseek-flash')
    assert.equal(stats.reasoningEffort, 'max')
    const bare = agentStatsOf({ contextTimeline: timeline(100, 1) })
    assert.equal(bare.model, undefined)
    assert.equal(bare.reasoningEffort, undefined)
  })

  test('providerModelLabelOf drops absent parts without a lone separator', () => {
    assert.equal(providerModelLabelOf('deepseek', 'deepseek-flash', 'high'), 'deepseek · deepseek-flash (high)')
    assert.equal(providerModelLabelOf('deepseek', 'deepseek-flash', undefined), 'deepseek · deepseek-flash')
    assert.equal(providerModelLabelOf('deepseek', undefined, 'high'), 'deepseek')
    assert.equal(providerModelLabelOf(undefined, 'deepseek-flash', 'max'), 'deepseek-flash (max)')
    assert.equal(providerModelLabelOf(undefined, undefined, undefined), '')
    assert.equal(providerModelLabelOf('', 'deepseek-flash', 'high'), 'deepseek-flash (high)')
    assert.equal(providerModelLabelOf('deepseek', '', 'high'), 'deepseek')
    assert.equal(providerModelLabelOf('', '', undefined), '')
  })

  test('split-generation rows: the precomputed tally serves without the request records', () => {
    const slim = {
      ...timeline(500, 0),
      counts: { turns: 2, steps: 7, injects: 1, compactions: 0, prunes: 0 },
      detailRev: 7,
    }
    const stats = agentStatsOf({ contextTimeline: slim })
    assert.equal(stats.requests, 7)
    assert.ok(stats.head !== null, 'the head still derives from the slim row')
  })

  test('pressure-only rows still yield an occupancy head without slices', () => {
    const projected = agentStatsOf({ contextPressure: { projectedTokens: 250, contextWindow: 1000 } })
    assert.deepEqual(projected.head, { tokens: 250, window: 1000, pct: 25, parts: [] })
    const fractional = agentStatsOf({ contextPressure: { projectedTokens: 833, contextWindow: 1000 } })
    assert.equal(fractional.head?.pct, 83.3)
    const sampled = agentStatsOf({ contextPressure: { pressureTokens: 100 } })
    assert.deepEqual(sampled.head, { tokens: 100, window: undefined, pct: null, parts: [] })
    const noWindow = agentStatsOf({ contextPressure: { projectedTokens: 5, contextWindow: 0 } })
    assert.deepEqual(noWindow.head, { tokens: 5, window: undefined, pct: null, parts: [] })
    assert.equal(agentStatsOf({ contextPressure: { contextWindow: 1000 } }).head, null)
  })
})

describe('agentSelfOf', () => {
  const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  const USAGE = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 30, cacheWriteTokens: 20 }
  const COST: SessionCostUsage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } }

  test("the view's own projections fill every figure, with the head's step tally over the served records", () => {
    const self = agentSelfOf(
      { ...timeline(500, 3), cost: COST, timing: TIMING, counts: { turns: 1, steps: 9, injects: 0, compactions: 0, prunes: 0 } },
      { projectedTokens: 800, contextWindow: 1000 },
      { systemTokens: 10, toolsTokens: 20, messageTokens: 470 },
      USAGE,
    )
    assert.equal(self.head?.tokens, 800, 'the pressure anchor leads the headline')
    assert.equal(self.head?.pct, 80)
    assert.equal(self.billed, 200)
    assert.equal(self.requests, 9, 'the precomputed tally leads the records')
    assert.deepEqual(self.costUsage, COST)
    assert.equal(self.durationMs, TIMING.wallMs, 'a top-level session has no subagent timing: its own wall time stands in')
  })

  test('absent projections and a zero wall time degrade to null, never a fabricated figure', () => {
    const bare = agentSelfOf(timeline(500, 3), null, null, null)
    assert.equal(bare.head?.tokens, 500)
    assert.equal(bare.billed, null)
    assert.equal(bare.requests, 3, 'no tally on the wire value: the served records count')
    assert.equal(bare.costUsage, null)
    assert.equal(bare.durationMs, null)
    assert.equal(agentSelfOf({ ...timeline(500, 3), timing: { ...TIMING, wallMs: 0 } }, null, null, null).durationMs, null)
  })
})

describe('agentForestOf', () => {
  test('null without an anchor or a byId table', () => {
    assert.equal(agentForestOf(null, 's1'), null)
    assert.equal(agentForestOf({}, 's1'), null)
    assert.equal(agentForestOf({ byId: 'nope' }, 's1'), null)
    assert.equal(agentForestOf(snap({}), undefined), null)
    assert.equal(agentForestOf(snap({}), ''), null)
  })

  test('synthesizes the missing current row, then merges live self stats onto it', () => {
    const synth = agentForestOf(snap({}), 's1')
    assert.ok(synth !== null)
    assert.equal(synth.solo, true)
    assert.equal(synth.nodes.length, 1)
    assert.equal(synth.nodes[0].id, 's1')
    assert.equal(synth.nodes[0].label, 's1')
    assert.equal(synth.nodes[0].isCurrent, true)
    assert.deepEqual(synth.edges, [])
    const head = { tokens: 9, window: 10, pct: 90, parts: [] }
    const selfCost: SessionCostUsage = { p: { m: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const forest = agentForestOf(snap({}), 's1', { head, billed: 7, requests: 4, costUsage: selfCost, durationMs: 9000 })
    assert.ok(forest !== null)
    assert.equal(forest.nodes[0].head, head)
    assert.equal(forest.nodes[0].billed, 7)
    assert.equal(forest.nodes[0].requests, 4)
    assert.deepEqual(forest.nodes[0].costUsage, selfCost)
    assert.equal(forest.nodes[0].durationMs, 9000)
    const rowCost: SessionCostUsage = { p: { m: { off: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 9 } } } }
    const withRow = agentForestOf(
      snap({
        s1: row({
          projectionValues: {
            contextTimeline: { ...timeline(10, 2), cost: rowCost },
            tokenUsage: { uncachedInputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 1 },
          },
        }),
      }),
      's1',
      { head: null, billed: null, requests: 0 },
    )
    assert.ok(withRow !== null)
    assert.equal(withRow.nodes[0].requests, 2)
    assert.equal(withRow.nodes[0].billed, 4)
    assert.deepEqual(withRow.nodes[0].costUsage, rowCost)
    assert.ok(withRow.nodes[0].head !== null)
  })

  test('completed follows the harness rule: the finished-turn flag for subagents, folded steps for a stopped session', () => {
    const forest = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', origin: 'subagent', projectionValues: { subagentTiming: { settledMs: 5000, lastTurnCompleted: true } } }),
      open: row({ parentId: 'root', origin: 'subagent', projectionValues: { subagentTiming: { settledMs: 1000, active: { since: 10, through: 99 } } } }),
    }), 'root')
    assert.ok(forest !== null)
    const byId = new Map(forest.nodes.map(n => [n.id, n]))
    assert.equal(byId.get('kid')?.completed, true)
    assert.equal(byId.get('open')?.completed, false)
    const live = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', origin: 'subagent', running: true, projectionValues: { subagentTiming: { settledMs: 5000, lastTurnCompleted: true } } }),
    }), 'root')
    assert.ok(live !== null)
    assert.equal(live.nodes.find(n => n.id === 'kid')?.completed, false)

    const idle = agentForestOf(snap({ root: row({}) }), 'root', { head: null, billed: null, requests: 9 })
    assert.ok(idle !== null)
    assert.equal(idle.nodes[0].completed, true)
    const ancestor = agentForestOf(snap({
      root: row({ projectionValues: { contextTimeline: timeline(10, 3) } }),
      kid: row({ parentId: 'root', origin: 'subagent' }),
    }), 'kid')
    assert.ok(ancestor !== null)
    assert.equal(ancestor.nodes.find(n => n.id === 'root')?.completed, true)
    const fresh = agentForestOf(snap({ root: row({}) }), 'root', { head: null, billed: null, requests: 0 })
    assert.ok(fresh !== null)
    assert.equal(fresh.nodes[0].completed, false)
    const running = agentForestOf(snap({ root: row({ running: true }) }), 'root', { head: null, billed: null, requests: 9 })
    assert.ok(running !== null)
    assert.equal(running.nodes[0].completed, false)

    const flagged = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextTimeline: timeline(10, 3) } }),
    }), 'root')
    assert.ok(flagged !== null)
    assert.equal(flagged.nodes.find(n => n.id === 'kid')?.completed, false, 'folded steps alone never finish a subagent')
  })

  test('injects fetched cold heads into rows whose own timeline is absent', () => {
    const composed: ContextTimeline = {
      ok: true,
      contextWindow: 1000,
      current: { system: 100, tools: 50, user: 200, inject: 50, skill: 0, assistant: 150, tool: 50, total: 600 },
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
    }
    const forest = agentForestOf(snap({
      root: row({ displayTitle: 'Root' }),
      cold: row({
        parentId: 'root', origin: 'subagent', updatedAt: 2,
        projectionValues: { contextPressure: { projectedTokens: 500, contextWindow: 1000 } },
      }),
      warm: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextTimeline: timeline(100, 1) } }),
    }), 'root', undefined, new Map<string, unknown>([
      ['cold', composed],
      ['warm', composed],
      ['ghost', timeline(5)],
    ]))
    assert.ok(forest !== null)
    const cold = forest.nodes.find(n => n.id === 'cold')
    assert.ok(cold !== undefined && cold.head !== null)
    assert.equal(cold.head.tokens, 500)
    assert.equal(cold.head.pct, 50)
    assert.ok(cold.head.parts.filter(p => p.value > 0).length >= 5, 'composed, not the single occupancy arc')
    const warm = forest.nodes.find(n => n.id === 'warm')
    assert.equal(warm?.head?.tokens, 100)
    assert.ok(forest.nodes[0].head === null)
    const solo = agentForestOf(snap({
      s1: row({}),
    }), 's1', undefined, new Map([['s1', composed]]))
    assert.ok(solo !== null)
    const soloHead = solo.nodes[0].head
    assert.ok(soloHead !== null)
    assert.equal(soloHead.tokens, 600, 'no pressure anchor: the fold total carries')
    assert.equal(soloHead.pct, 60)
  })

  test('a hostile fetched head degrades back to the pressure-only ring', () => {
    const byId = {
      root: row({ displayTitle: 'Root' }),
      cold: row({
        parentId: 'root', origin: 'subagent', updatedAt: 2,
        projectionValues: { contextPressure: { projectedTokens: 500, contextWindow: 1000 } },
      }),
    }
    for (const junk of ['garbage', null, 42]) {
      const forest = agentForestOf(snap(byId), 'root', undefined, new Map([['cold', junk]]))
      assert.ok(forest !== null)
      const cold = forest.nodes.find(n => n.id === 'cold')
      assert.ok(cold !== undefined && cold.head !== null)
      assert.equal(cold.head.tokens, 500, 'pressure still anchors the ring')
      assert.equal(cold.head.parts.length, 0, 'no composition invented from junk')
    }
  })

  test('walks the lineage up to the topmost ancestor and DFSes the subtree', () => {
    const forest = agentForestOf(snap({
      root: row({ displayTitle: 'Root', running: true, updatedAt: 5 }),
      a: row({ parentId: 'root', title: 'Child A', origin: 'subagent', updatedAt: 3 }),
      b: row({ parentId: 'root', displayTitle: 'Child B', origin: 'subagent', running: true, updatedAt: 1 }),
      c2: row({ parentId: 'root', origin: 'subagent', updatedAt: 3 }),
      c1: row({ parentId: 'root', origin: 'subagent', updatedAt: 3 }),
      g: row({ parentId: 'a', origin: 'subagent', updatedAt: 2 }),
      other: row({ displayTitle: 'Other' }),
      blank: row({ parentId: 'root', origin: 'subagent', blank: true }),
      junk: 'not-a-row',
      orphan: row({ parentId: 'missing', origin: 'subagent' }),
    }), 'g')
    assert.ok(forest !== null)
    assert.deepEqual(forest.nodes.map(n => n.id), ['root', 'b', 'a', 'g', 'c1', 'c2'])
    assert.deepEqual(forest.edges, [
      { from: 'root', to: 'b' },
      { from: 'root', to: 'a' },
      { from: 'a', to: 'g' },
      { from: 'root', to: 'c1' },
      { from: 'root', to: 'c2' },
    ])
    assert.equal(forest.nodes[0].label, 'Root')
    assert.equal(forest.nodes[0].running, true)
    assert.equal(forest.nodes[3].isCurrent, true)
    assert.equal(forest.nodes[3].depth, 2)
    assert.equal(forest.nodes[1].parentId, 'root')
    assert.equal(forest.solo, false)
  })

  test('a forked session roots its own family and never joins the source it was cut from', () => {
    const byId = {
      source: row({ displayTitle: 'Source' }),
      fork: row({ parentId: 'source', displayTitle: 'Source (1)' }),
      kid: row({ parentId: 'source', origin: 'subagent' }),
      forkKid: row({ parentId: 'fork', origin: 'subagent' }),
      forkOfFork: row({ parentId: 'fork' }),
    }
    const source = agentForestOf(snap(byId), 'source')
    assert.ok(source !== null)
    assert.deepEqual(source.nodes.map(n => n.id), ['source', 'kid'])
    const fork = agentForestOf(snap(byId), 'fork')
    assert.ok(fork !== null)
    assert.deepEqual(fork.nodes.map(n => n.id), ['fork', 'forkKid'])
    assert.equal(fork.nodes[0].parentId, undefined)
    const belowFork = agentForestOf(snap(byId), 'forkKid')
    assert.ok(belowFork !== null)
    assert.deepEqual(belowFork.nodes.map(n => n.id), ['fork', 'forkKid'])
    const nested = agentForestOf(snap(byId), 'forkOfFork')
    assert.ok(nested !== null)
    assert.deepEqual(nested.nodes.map(n => n.id), ['forkOfFork'])
  })

  test('subagent flag comes from origin or a descriptor identity', () => {
    const forest = agentForestOf(snap({
      root: row({}),
      byOrigin: row({ parentId: 'root', origin: 'subagent' }),
    }), 'root')
    assert.ok(forest !== null)
    assert.equal(forest.nodes.find(n => n.id === 'byOrigin')?.subagent, true)
    assert.equal(forest.nodes[0].subagent, false)
    const self = agentForestOf(snap({
      self: row({ projectionValues: { subagent: { mode: 'continuable', label: 'task' } } }),
    }), 'self')
    assert.ok(self !== null)
    assert.equal(self.nodes[0].subagent, true)
    assert.equal(self.nodes[0].label, 'task')
  })

  test('a lineage cycle anchors at the repeated id instead of looping', () => {
    const forest = agentForestOf(snap({
      a: row({ parentId: 'b', origin: 'subagent', displayTitle: 'A' }),
      b: row({ parentId: 'a', origin: 'subagent', displayTitle: 'B' }),
    }), 'a')
    assert.ok(forest !== null)
    assert.deepEqual(forest.nodes.map(n => n.id), ['b', 'a'])
  })

  test('cataloged children follow the parent catalog order; uncataloged ones fall after; malformed entries drop alone', () => {
    const forest = agentForestOf(snap({
      root: row({
        projectionValues: {
          subagentCatalog: [
            { id: 'b', createdAt: 2 },
            { id: 'a', createdAt: 1 },
            'garbage',
            { id: 42 },
            { id: '' },
            { id: 'b', createdAt: 3 },
          ],
        },
      }),
      a: row({ parentId: 'root', origin: 'subagent', updatedAt: 5 }),
      b: row({ parentId: 'root', origin: 'subagent', updatedAt: 1 }),
      c: row({ parentId: 'root', origin: 'subagent', running: true }),
    }), 'root')
    assert.ok(forest !== null)
    assert.deepEqual(forest.nodes.map(n => n.id), ['root', 'b', 'a', 'c'])
    const reversed = agentForestOf(snap({
      root: row({ projectionValues: { subagentCatalog: [{ id: 'b', createdAt: 1 }] } }),
      a: row({ parentId: 'root', origin: 'subagent' }),
      b: row({ parentId: 'root', origin: 'subagent' }),
    }), 'root')
    assert.ok(reversed !== null)
    assert.deepEqual(reversed.nodes.map(n => n.id), ['root', 'b', 'a'])

    const wide: Record<string, unknown> = { root: row({}) }
    for (let i = 0; i < 105; i += 1) wide[`k${i}`] = row({ parentId: 'root', origin: 'subagent' })
    const whole = agentForestOf(snap(wide), 'root')
    assert.ok(whole !== null)
    assert.equal(whole.nodes.length, 106, 'the whole family folds, however large')
    assert.equal(whole.edges.length, 105)
  })

  test('a hostile or empty catalog value keeps the activity heuristic', () => {
    for (const cat of ['nope', 42, [], [null], [{ id: '' }]]) {
      const forest = agentForestOf(snap({
        root: row({ projectionValues: { subagentCatalog: cat } }),
        a: row({ parentId: 'root', origin: 'subagent', updatedAt: 1 }),
        b: row({ parentId: 'root', origin: 'subagent', running: true, updatedAt: 9 }),
      }), 'root')
      assert.ok(forest !== null)
      assert.deepEqual(forest.nodes.map(n => n.id), ['root', 'b', 'a'], `catalog ${JSON.stringify(cat)} ignored`)
    }
  })

  test('the blank current session survives the blank filter', () => {
    const forest = agentForestOf(snap({ s1: row({ blank: true, displayTitle: 'Fresh' }) }), 's1')
    assert.ok(forest !== null)
    assert.equal(forest.nodes.length, 1)
    assert.equal(forest.nodes[0].label, 'Fresh')
  })
})

describe('subagentCostFoldOf', () => {
  const COST_A: SessionCostUsage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } }
  const COST_B: SessionCostUsage = { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 20, output: 0 } } } }

  function costRow(parentId: string | undefined, cost?: SessionCostUsage): Record<string, unknown> {
    return row({
      ...(parentId !== undefined ? { parentId, origin: 'subagent' } : {}),
      projectionValues: { contextTimeline: { ...timeline(100), ...(cost !== undefined ? { cost } : {}) } },
    })
  }

  test('absent snapshot or anchor folds nothing', () => {
    assert.deepEqual(subagentCostFoldOf(undefined, 's1'), { usage: null, cold: [], count: 0 })
    assert.deepEqual(subagentCostFoldOf(snap({}), 's1'), { usage: null, cold: [], count: 0 })
    assert.deepEqual(subagentCostFoldOf(snap({ s1: row({}) }), undefined), { usage: null, cold: [], count: 0 })
    assert.deepEqual(subagentCostFoldOf(snap({ s1: row({}) }), ''), { usage: null, cold: [], count: 0 })
  })

  test('merges the whole descendant subtree, never the current session itself', () => {
    const byId = {
      root: costRow(undefined, COST_A),
      kid: costRow('root', COST_B),
      grand: costRow('kid', COST_A),
      kid2: costRow('root'),
      stranger: costRow(undefined, COST_B),
      orphan: costRow('missing', COST_B),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.deepEqual(fold.usage, mergeCostUsage(COST_B, COST_A))
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 3)
  })

  test('a descendant without a timeline row is a cold fetch target until its head lands', () => {
    const byId = {
      root: costRow(undefined, COST_A),
      cold: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextPressure: { projectedTokens: 1 } } }),
      bare: row({ parentId: 'root', origin: 'subagent' }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.equal(fold.usage, null, 'nothing warm or landed yet')
    assert.deepEqual(fold.cold, ['cold', 'bare'])
    assert.equal(fold.count, 2, 'a cold descendant is a subagent too')
    const landed = new Map<string, ContextTimeline>([['cold', { ...timeline(50), cost: COST_B }]])
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'root', landed).usage, COST_B)
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'root', landed).cold, ['bare'])
  })

  test('a landed head whose cost is absent leaves the id warm but contributes nothing', () => {
    const byId = { root: costRow(undefined, COST_A), cold: row({ parentId: 'root', origin: 'subagent' }) }
    const landed = new Map<string, ContextTimeline>([['cold', timeline(50)]])
    const fold = subagentCostFoldOf(snap(byId), 'root', landed)
    assert.deepEqual(fold.usage, null)
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 1)
  })

  test('blank placeholders are not agents and a lineage cycle is cut at the revisited id', () => {
    const byId: Record<string, unknown> = {
      root: costRow(undefined, COST_A),
      blank: row({ parentId: 'root', origin: 'subagent', blank: true, projectionValues: { contextTimeline: { ...timeline(1), cost: COST_B } } }),
      a: row({ parentId: 'b' }),
      b: row({ parentId: 'a' }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.deepEqual(fold.usage, null, 'the blank usage and the detached cycle stay out (root\'s own cost never counts)')
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 0, 'the blank placeholder is no subagent either')
    const cyclic: Record<string, unknown> = {
      root: row({ parentId: 'p', origin: 'subagent', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_A } } }),
      p: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_B } } }),
    }
    const cut = subagentCostFoldOf(snap(cyclic), 'root')
    assert.deepEqual(cut.usage, COST_B, 'p counts once; the current session never counts as its own child')
    assert.deepEqual(cut.cold, [])
    assert.equal(cut.count, 1)
  })

  test('hostile rows and timeline values degrade to fewer contributions', () => {
    const byId = {
      root: costRow(undefined, COST_A),
      junkRow: 5,
      hostileTimeline: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextTimeline: 'garbage' } }),
      hostileCost: row({
        parentId: 'root', origin: 'subagent',
        projectionValues: { contextTimeline: { ...timeline(1), cost: { junk: 5, p: { m: { peak: { uncached: 'x', cacheRead: 7 } } } } } },
      }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.deepEqual(fold.usage, { p: { m: { peak: { uncached: 0, cacheRead: 7, cacheWrite: 0, output: 0 } } } })
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 2, 'the non-row never joined the walk')
  })

  test('a forked session’s subtree is no subagent cost — the fork anchors its own', () => {
    const byId: Record<string, unknown> = {
      root: costRow(undefined, COST_A),
      fork: row({ parentId: 'root', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_B } } }),
      forkKid: row({ parentId: 'fork', origin: 'subagent', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_A } } }),
    }
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'root'), { usage: null, cold: [], count: 0 })
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'fork'), { usage: COST_A, cold: [], count: 1 })
  })
})

describe('layoutForest', () => {
  const SLOT = 276

  function forestOf(ids: [string, string?][]): AgentForest {
    const nodes = ids.map(([id, parent], i) => ({
      id,
      label: id,
      ...(parent !== undefined ? { parentId: parent } : {}),
      depth: 0,
      family: 0,
      isCurrent: i === 0,
      running: id === 'b',
      completed: false,
      subagent: parent !== undefined,
      updatedAt: 0,
      head: null,
      requests: 0,
      billed: null,
      costUsage: null,
      durationMs: null,
      identity: null,
    }))
    for (const n of nodes) {
      let d = 0
      let cur = n
      while (cur.parentId !== undefined) {
        d++
        cur = nodes.find(m => m.id === cur.parentId) as typeof cur
      }
      n.depth = d
    }
    const levelOne = nodes.filter(n => n.depth === 1)
    for (const n of nodes) {
      let cur = n
      while (cur.depth > 1) cur = nodes.find(m => m.id === cur.parentId) as typeof cur
      n.family = cur.depth === 0 ? -1 : levelOne.indexOf(cur)
    }
    return {
      nodes,
      edges: ids.filter(pair => pair[1] !== undefined).map(([to, from]) => ({ from: from as string, to })),
      solo: ids.length === 1,
    }
  }

  test('single node: no links, minimal stage (even when a stage width is given)', () => {
    const layout = layoutForest(forestOf([['root']]), 500)
    assert.equal(layout.points.length, 1)
    assert.equal(layout.points[0].depth, 0)
    assert.equal(layout.links.length, 0)
    assert.equal(layout.width, SLOT)
    assert.equal(layout.height, 48 + AGENT_CARD_H + 24)
    assert.equal(layout.cardW, SLOT - 12)
  })

  test('levels follow depth, siblings claim leaf slots, parents center over children; a wide stage keeps the natural pitch', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['g', 'a']])
    const layout = layoutForest(forest)
    assert.equal(layoutForest(forest, 4000).width, 2 * SLOT, 'a wide stage keeps the natural pitch')
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('g')?.x, SLOT / 2)
    assert.equal(pointOf.get('a')?.x, SLOT / 2)
    assert.equal(pointOf.get('b')?.x, SLOT / 2 + SLOT)
    assert.equal(pointOf.get('root')?.x, SLOT)
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + LEVEL)
    assert.equal(pointOf.get('g')?.y, 48 + 2 * LEVEL)
    const linkG = layout.links.find(l => l.to === 'g')
    assert.ok(linkG !== undefined)
    assert.equal(linkG.x1, pointOf.get('a')?.x)
    assert.equal(linkG.y1, (pointOf.get('a')?.y as number) + AGENT_CARD_H)
    assert.equal(linkG.x2, pointOf.get('g')?.x)
    assert.equal(linkG.y2, pointOf.get('g')?.y)
    assert.equal(linkG.running, false)
    assert.equal(layout.links.find(l => l.to === 'b')?.running, true)
    assert.equal(linkG.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'b')?.color, familyHue(1))
    assert.equal(layout.links.length, 3)
    assert.equal(layout.width, 2 * SLOT)
    assert.equal(layout.height, 48 + 2 * LEVEL + AGENT_CARD_H + 24)
  })

  test('responsive: a tighter stage compresses the pitch to fit exactly; a narrow stage folds into a single-column stack', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']])
    const tight = layoutForest(forest, 600)
    const slot = 600 / 3
    assert.equal(tight.width, 600)
    assert.equal(tight.cardW, slot - 12)
    const tightPoint = new Map(tight.points.map(p => [p.id, p]))
    assert.equal(tightPoint.get('a')?.x, slot / 2)
    assert.equal(tightPoint.get('b')?.x, slot * 1.5)
    assert.equal(tightPoint.get('root')?.x, slot * 1.5)

    const narrow = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root']]), 180)
    assert.equal(narrow.width, 180)
    assert.equal(narrow.cardW, 180 - 12)
    const pointOf = new Map(narrow.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.x, 90)
    assert.equal(pointOf.get('a')?.x, 90)
    assert.equal(pointOf.get('b')?.x, 90)
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + LEVEL)
    assert.equal(pointOf.get('b')?.y, 48 + 2 * LEVEL)
    assert.equal(narrow.height, 48 + 2 * LEVEL + AGENT_CARD_H + 24)
  })

  test('responsive: an over-wide level wraps into bands, and full bands at an intermediate pitch fit the stage exactly', () => {
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']]), 400)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.x, 200)
    assert.equal(pointOf.get('a')?.x, 100)
    assert.equal(pointOf.get('b')?.x, 100 + 200)
    assert.equal(pointOf.get('c')?.x, 200)
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + LEVEL)
    assert.equal(pointOf.get('c')?.y, 48 + 2 * LEVEL)
    const linkC = layout.links.find(l => l.to === 'c')
    assert.ok(linkC !== undefined)
    assert.equal(linkC.y1, 48 + AGENT_CARD_H)
    assert.equal(linkC.y2, 48 + 2 * LEVEL)
    assert.equal(linkC.color, familyHue(2))
    assert.equal(layout.links.find(l => l.to === 'a')?.color, familyHue(0))
    assert.equal(layout.width, 400)
    assert.equal(layout.height, 48 + 2 * LEVEL + AGENT_CARD_H + 24)
    assert.equal(layout.cardW, 200 - 12)

    const kids: [string, string?][] = [['root']]
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) kids.push([id, 'root'])
    const full = layoutForest(forestOf(kids), 400)
    const slot = 400 / 2
    const fullPoint = new Map(full.points.map(p => [p.id, p]))
    assert.equal(fullPoint.get('a')?.x, slot / 2)
    assert.equal(fullPoint.get('c')?.x, slot / 2)
    assert.equal(fullPoint.get('d')?.y, 48 + 2 * LEVEL)
    assert.equal(full.width, 400)
    assert.equal(full.links.length, 6)
    assert.equal(full.cardW, slot - 12)
  })

  test('responsive: child bands interleave with later parent bands; a partial band flushes before an overflowing sibling group', () => {
    const layout = layoutForest(forestOf([
      ['root'],
      ['p1', 'root'],
      ['p2', 'root'],
      ['p3', 'root'],
      ['k1', 'p1'],
      ['k2', 'p1'],
    ]), 400)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('p1')?.y, 48 + LEVEL)
    assert.equal(pointOf.get('k1')?.y, 48 + 2 * LEVEL)
    assert.equal(pointOf.get('p3')?.y, 48 + 3 * LEVEL)
    assert.ok((pointOf.get('k1')?.y as number) < (pointOf.get('p3')?.y as number))
    assert.equal(layout.links.find(l => l.to === 'k1')?.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'p3')?.color, familyHue(2))
    assert.equal(layout.width, 400)
    assert.equal(layout.height, 48 + 3 * LEVEL + AGENT_CARD_H + 24)

    const partial = layoutForest(forestOf([
      ['root'],
      ['p1', 'root'],
      ['p2', 'root'],
      ['k1', 'p1'],
      ['k2a', 'p2'],
      ['k2b', 'p2'],
    ]), 400)
    const partialPoint = new Map(partial.points.map(p => [p.id, p]))
    assert.equal(partialPoint.get('p1')?.y, 48 + LEVEL)
    assert.equal(partialPoint.get('k1')?.y, 48 + 2 * LEVEL)
    assert.equal(partialPoint.get('k2a')?.y, 48 + 3 * LEVEL)
    assert.equal(partialPoint.get('k2b')?.y, 48 + 3 * LEVEL)
    assert.equal(partial.links.length, 5)
    assert.equal(partial.links.find(l => l.to === 'k2a')?.color, familyHue(1))
    assert.equal(partial.links.find(l => l.to === 'k1')?.color, familyHue(0))
  })

  test('compact geometry tightens cards and links without changing parent centering or band placement', () => {
    const natural = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['g', 'a']]), 0, true)
    const naturalPoint = new Map(natural.points.map(p => [p.id, p]))
    assert.equal(natural.width, 464)
    assert.equal(natural.cardW, 222)
    assert.equal(naturalPoint.get('root')?.x, 232)
    assert.equal(naturalPoint.get('a')?.x, 116)
    assert.equal(naturalPoint.get('b')?.x, 348)
    assert.equal(naturalPoint.get('root')?.y, 32)
    assert.equal(naturalPoint.get('a')?.y, 168)
    assert.equal(naturalPoint.get('g')?.y, 304)
    assert.equal(natural.links.find(l => l.to === 'g')?.y1, 260)
    assert.equal(natural.height, 420)

    const band = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']]), 400, true)
    const bandPoint = new Map(band.points.map(p => [p.id, p]))
    assert.equal(band.cardW, 190)
    assert.equal(bandPoint.get('root')?.x, 200)
    assert.equal(bandPoint.get('a')?.x, 100)
    assert.equal(bandPoint.get('b')?.x, 300)
    assert.equal(bandPoint.get('c')?.x, 200)
    assert.equal(bandPoint.get('a')?.y, 168)
    assert.equal(bandPoint.get('c')?.y, 304)
    assert.equal(band.links.find(l => l.to === 'c')?.y1, 124)
    assert.equal(band.height, 420)
  })
})

describe('neighborhoodOf', () => {
  const forest = agentForestOf(snap({
    root: row({}),
    a: row({ parentId: 'root', origin: 'subagent' }),
    b: row({ parentId: 'root', origin: 'subagent' }),
    g: row({ parentId: 'a', origin: 'subagent' }),
  }), 'root')
  assert.ok(forest !== null)

  test('null or unknown id lights nothing', () => {
    assert.equal(neighborhoodOf(forest, null), null)
    assert.equal(neighborhoodOf(forest, 'ghost'), null)
  })

  test('lights the node with its parent and direct children only; a parentage cycle terminates', () => {
    assert.deepEqual([...neighborhoodOf(forest, 'g') ?? []].sort(), ['a', 'g'])
    assert.deepEqual([...neighborhoodOf(forest, 'root') ?? []].sort(), ['a', 'b', 'root'])
    assert.deepEqual([...neighborhoodOf(forest, 'a') ?? []].sort(), ['a', 'g', 'root'])
    const cycle = agentForestOf(snap({
      a: row({ parentId: 'b', origin: 'subagent' }),
      b: row({ parentId: 'a', origin: 'subagent' }),
    }), 'a')
    assert.ok(cycle !== null)
    assert.deepEqual([...neighborhoodOf(cycle, 'a') ?? []].sort(), ['a', 'b'])
  })
})

describe('barSegments', () => {
  test('no window: composition fills the whole bar (negatives excluded); no composition yields no segments', () => {
    assert.deepEqual(barSegments([], null, 'gray'), [])
    const segs = barSegments([
      { key: 'system', color: 'red', value: 1 },
      { key: 'user', color: 'green', value: -5 },
      { key: 'tool', color: 'blue', value: 3 },
    ], null, 'gray')
    assert.equal(segs.length, 2)
    assert.equal(segs[0].share, 0.25)
    assert.equal(segs[0].free, false)
    assert.equal(segs[1].share, 0.75)
  })

  test('a known window scales composition to the occupancy share and appends the free remainder', () => {
    const segs = barSegments([
      { key: 'system', color: 'red', value: 1 },
      { key: 'tool', color: 'blue', value: 3 },
    ], 50, 'gray')
    assert.equal(segs.length, 3)
    assert.equal(segs[0].share, 0.125)
    assert.equal(segs[1].share, 0.375)
    assert.equal(segs[2].free, true)
    assert.equal(segs[2].share, 0.5)
  })

  test('pressure-only rows draw one threshold-colored fill; zero occupancy, out-of-range pct, and negatives clamp', () => {
    const segs = barSegments([], 40, 'orange')
    assert.equal(segs.length, 2)
    assert.equal(segs[0].key, 'fill')
    assert.equal(segs[0].color, 'orange')
    assert.equal(segs[0].share, 0.4)
    assert.equal(segs[1].free, true)
    assert.equal(segs[1].share, 0.6)
    const zero = barSegments([{ key: 'system', color: 'red', value: 5 }], 0, 'gray')
    assert.equal(zero.length, 1)
    assert.equal(zero[0].free, true)
    assert.equal(zero[0].share, 1)
    const over = barSegments([{ key: 'system', color: 'red', value: 5 }], 150, 'gray')
    assert.equal(over.length, 1)
    assert.equal(over[0].share, 1)
    const neg = barSegments([], -5, 'gray')
    assert.equal(neg.length, 1)
    assert.equal(neg[0].free, true)
  })
})

describe('pressureColorOf', () => {
  test('occupancy thresholds', () => {
    assert.equal(pressureColorOf(null), 'var(--dsw-alias-border-l1)')
    assert.equal(pressureColorOf(95), 'var(--color-red-500)')
    assert.equal(pressureColorOf(70), 'var(--color-amber-500)')
    assert.equal(pressureColorOf(12), 'var(--color-green-500)')
  })
})

describe('familyHue', () => {
  test('consecutive families sit far apart on the color wheel and hues cycle', () => {
    assert.equal(familyHue(0), 'hsl(0 58% 52%)')
    assert.equal(familyHue(1), 'hsl(138 58% 52%)')
    assert.equal(familyHue(2), 'hsl(275 58% 52%)')
  })
})

describe('sessionsFaceOf', () => {
  test('requires the outward service and its list feed', () => {
    assert.equal(sessionsFaceOf({ get: () => undefined }), null)
    assert.equal(sessionsFaceOf({ get: () => 'sessions' }), null)
    assert.equal(sessionsFaceOf({ get: () => ({}) }), null)
    assert.equal(sessionsFaceOf({ get: () => ({ list: {} }) }), null)
    assert.equal(sessionsFaceOf({ get: () => ({ list: { getSnapshot: () => ({}) } }) }), null)
    const face = sessionsFaceOf({
      get: () => ({ list: { getSnapshot: () => ({}), subscribe: () => () => {} } }),
    })
    assert.ok(face !== null)
  })
})

describe('fmtDurationCompact', () => {
  test('compacts milliseconds', () => {
    assert.equal(fmtDurationCompact(NaN), '—')
    assert.equal(fmtDurationCompact(-5), '—')
    assert.equal(fmtDurationCompact(42000), '42s')
    assert.equal(fmtDurationCompact(185000), '3m05s')
    assert.equal(fmtDurationCompact(4020000), '1h07m')
  })
})

describe('sessionTitlesOf', () => {
  test('clean titles win; a system-reminder title falls back to the descriptor label', () => {
    assert.deepEqual([...sessionTitlesOf(null)], [])
    assert.deepEqual([...sessionTitlesOf({})], [])
    assert.deepEqual([...sessionTitlesOf({ byId: 'nope' })], [])
    const titles = sessionTitlesOf({
      byId: {
        a: { displayTitle: 'A display', title: 'A raw' },
        b: { title: 'B raw' },
        c: { displayTitle: 'C display' },
        d: {},
        e: null,
        f: { displayTitle: '<system-reminder> x', title: '<system-reminder> y', projectionValues: { subagent: { label: 'Clean label' } } },
        g: { displayTitle: '<system-reminder> x' },
        h: { displayTitle: '  ', title: 'H raw' },
        i: { projectionValues: { subagent: { label: 42 } } },
        j: { projectionValues: { subagent: { label: '' } } },
      },
    })
    assert.deepEqual([...titles.entries()], [
      ['a', 'A display'],
      ['b', 'B raw'],
      ['c', 'C display'],
      ['f', 'Clean label'],
      ['h', 'H raw'],
    ])
  })
})

describe('agentRowOf caching', () => {
  test('one immutable row object derives once; a new object derives anew', () => {
    const row = { displayTitle: 'A', running: true, updatedAt: 4 }
    assert.equal(agentRowOf(row), agentRowOf(row))
    const next = { ...row, running: false }
    assert.notEqual(agentRowOf(next), agentRowOf(next) === null ? null : agentRowOf(row))
    assert.equal(agentRowOf(next)?.running, false)
  })
})
