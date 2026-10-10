// agentTree (src/client/agentTree.ts) — the pure model behind the Agent network card.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  AGENT_TREE_LIMIT,
  agentDurationOf,
  agentForestOf,
  agentIdentityOf,
  agentRowOf,
  agentTurnCompletedOf,
  agentStatsOf,
  barSegments,
  familyHue,
  fmtDurationCompact,
  layoutForest,
  lineageOf,
  pressureColorOf,
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
    // Wrong-typed members drop; non-numeric updatedAt zeroes; non-record projections drop.
    assert.deepEqual(agentRowOf({
      displayTitle: 1, title: null, parentId: 2, origin: false,
      running: 'yes', updatedAt: 'soon', projectionValues: 7,
    }), { running: false, blank: false, updatedAt: 0 })
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
    // A backwards open window clamps to zero instead of going negative.
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
    // An open turn carries no flag, so the subagent is still mid-work.
    assert.equal(agentTurnCompletedOf({ settledMs: 5000 }), false)
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

  test('timeline rows produce a full headline with parts and request count', () => {
    const cost: SessionCostUsage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } }
    const stats = agentStatsOf({
      contextTimeline: { ...timeline(500, 3), cost },
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
    assert.deepEqual(stats.costUsage, cost)
    assert.equal(stats.durationMs, 2000)
    assert.deepEqual(stats.identity, { mode: 'continuable', label: 'helper' })
  })

  test('split-generation rows: the precomputed tally serves without the request records', () => {
    // The slim wire head carries no `requests` collection — the Agent card
    // reads the host-precomputed tally off `counts.steps` instead.
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
    // The same one-decimal occupancy grid the overview card reads (headline.ts).
    const fractional = agentStatsOf({ contextPressure: { projectedTokens: 833, contextWindow: 1000 } })
    assert.equal(fractional.head?.pct, 83.3)
    // Falls back to the raw sample when no projection exists.
    const sampled = agentStatsOf({ contextPressure: { pressureTokens: 100 } })
    assert.deepEqual(sampled.head, { tokens: 100, window: undefined, pct: null, parts: [] })
    // A zero/invalid window never divides.
    const noWindow = agentStatsOf({ contextPressure: { projectedTokens: 5, contextWindow: 0 } })
    assert.deepEqual(noWindow.head, { tokens: 5, window: undefined, pct: null, parts: [] })
    // Pressure without any token figure is no head at all.
    assert.equal(agentStatsOf({ contextPressure: { contextWindow: 1000 } }).head, null)
  })

  test('usage sums into billed; a malformed usage value degrades whole (the buckets sum into the total)', () => {
    assert.equal(agentStatsOf({ tokenUsage: { uncachedInputTokens: 'x' } }).billed, null)
    assert.equal(agentStatsOf({ tokenUsage: null }).billed, null)
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

  test('synthesizes the current row when the list has not delivered it', () => {
    const forest = agentForestOf(snap({}), 's1')
    assert.ok(forest !== null)
    assert.equal(forest.solo, true)
    assert.equal(forest.nodes.length, 1)
    assert.equal(forest.nodes[0].id, 's1')
    assert.equal(forest.nodes[0].label, 's1')
    assert.equal(forest.nodes[0].isCurrent, true)
    assert.deepEqual(forest.edges, [])
  })

  test('a finished subagent turn marks the node done, and a running one never is', () => {
    const forest = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', projectionValues: { subagentTiming: { settledMs: 5000, lastTurnCompleted: true } } }),
      open: row({ parentId: 'root', projectionValues: { subagentTiming: { settledMs: 1000, active: { since: 10, through: 99 } } } }),
    }), 'root')
    assert.ok(forest !== null)
    const byId = new Map(forest.nodes.map(n => [n.id, n]))
    assert.equal(byId.get('kid')?.completed, true)
    // A turn still open carries no completion flag, and an agent with nothing done yet has
    // no steps either — neither claims to be finished.
    assert.equal(byId.get('open')?.completed, false)
    // A running session is never done, whatever its last closed turn said.
    const live = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', running: true, projectionValues: { subagentTiming: { settledMs: 5000, lastTurnCompleted: true } } }),
    }), 'root')
    assert.ok(live !== null)
    assert.equal(live.nodes.find(n => n.id === 'kid')?.completed, false)
  })

  test('a session that is not a subagent is done once it has folded steps and stopped running', () => {
    // A top-level session never carries a subagent-timing projection, so its own folded steps
    // are the only proof of finished work it can offer. Reached from a subagent's own tab, the
    // main agent is an ancestor node, not the current one — the same rule has to hold there.
    const idle = agentForestOf(snap({ root: row({}) }), 'root', { head: null, billed: null, requests: 9 })
    assert.ok(idle !== null)
    assert.equal(idle.nodes[0].completed, true)
    const ancestor = agentForestOf(snap({
      root: row({ projectionValues: { contextTimeline: timeline(10, 3) } }),
      kid: row({ parentId: 'root', origin: 'subagent' }),
    }), 'kid')
    assert.ok(ancestor !== null)
    assert.equal(ancestor.nodes.find(n => n.id === 'root')?.completed, true)
    // A session that has not run a step yet claims nothing.
    const fresh = agentForestOf(snap({ root: row({}) }), 'root', { head: null, billed: null, requests: 0 })
    assert.ok(fresh !== null)
    assert.equal(fresh.nodes[0].completed, false)
    // And a live parent is never done, however many steps it has folded.
    const live = agentForestOf(snap({ root: row({ running: true }) }), 'root', { head: null, billed: null, requests: 9 })
    assert.ok(live !== null)
    assert.equal(live.nodes[0].completed, false)
  })

  test('a subagent without the completion flag is never done on its steps alone', () => {
    // Steps alone would call an aborted subagent finished; only the harness flag may.
    const forest = agentForestOf(snap({
      root: row({ running: true }),
      kid: row({ parentId: 'root', origin: 'subagent', projectionValues: { contextTimeline: timeline(10, 3) } }),
    }), 'root')
    assert.ok(forest !== null)
    assert.equal(forest.nodes.find(n => n.id === 'kid')?.completed, false)
  })

  test('merges live self stats onto the current node', () => {
    const head = { tokens: 9, window: 10, pct: 90, parts: [] }
    const selfCost: SessionCostUsage = { p: { m: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
    const forest = agentForestOf(snap({}), 's1', { head, billed: 7, requests: 4, costUsage: selfCost, durationMs: 9000 })
    assert.ok(forest !== null)
    assert.equal(forest.nodes[0].head, head)
    assert.equal(forest.nodes[0].billed, 7)
    assert.equal(forest.nodes[0].requests, 4)
    assert.deepEqual(forest.nodes[0].costUsage, selfCost)
    // The current agent's own active time — no subagent-timing projection exists for it.
    assert.equal(forest.nodes[0].durationMs, 9000)
    // Null self fields keep the row-derived stats; zero requests never erases the row's count.
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

  test('injects fetched cold heads into rows whose own timeline is absent', () => {
    // A multi-category composition (the detail channel's slim head).
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
      warm: row({ parentId: 'root', projectionValues: { contextTimeline: timeline(100, 1) } }),
    }), 'root', undefined, new Map<string, unknown>([
      ['cold', composed],
      ['warm', composed],
      ['ghost', timeline(5)],
    ]))
    assert.ok(forest !== null)
    // Pressure anchors the occupancy; the fetched head supplies the composition arcs.
    const cold = forest.nodes.find(n => n.id === 'cold')
    assert.ok(cold !== undefined && cold.head !== null)
    assert.equal(cold.head.tokens, 500)
    assert.equal(cold.head.pct, 50)
    assert.ok(cold.head.parts.filter(p => p.value > 0).length >= 5, 'composed, not the single occupancy arc')
    // A row's own timeline outranks the injection; unrelated ids never inject.
    const warm = forest.nodes.find(n => n.id === 'warm')
    assert.equal(warm?.head?.tokens, 100)
    assert.ok(forest.nodes[0].head === null)
    // A row without projections folds from the fetched head alone.
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
      b: row({ parentId: 'root', displayTitle: 'Child B', running: true, updatedAt: 1 }),
      // Same running state and same updatedAt: the id tiebreak orders them.
      c2: row({ parentId: 'root', updatedAt: 3 }),
      c1: row({ parentId: 'root', updatedAt: 3 }),
      g: row({ parentId: 'a', updatedAt: 2 }),
      // An unrelated family never joins the forest.
      other: row({ displayTitle: 'Other' }),
      // A blank placeholder row is excluded (unless it is the current session).
      blank: row({ parentId: 'root', blank: true }),
      // Garbage rows degrade out of the row set entirely.
      junk: 'not-a-row',
      // An orphan whose parent is unknown hangs off nobody.
      orphan: row({ parentId: 'missing' }),
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
    assert.equal(forest.overflow, 0)
  })

  test('subagent flag comes from origin or a descriptor identity', () => {
    const forest = agentForestOf(snap({
      root: row({}),
      byOrigin: row({ parentId: 'root', origin: 'subagent' }),
      byDescriptor: row({ parentId: 'root', projectionValues: { subagent: { mode: 'one-shot', label: 'task' } } }),
    }), 'root')
    assert.ok(forest !== null)
    const byOrigin = forest.nodes.find(n => n.id === 'byOrigin')
    const byDescriptor = forest.nodes.find(n => n.id === 'byDescriptor')
    assert.equal(byOrigin?.subagent, true)
    assert.equal(byDescriptor?.subagent, true)
    assert.equal(byDescriptor?.label, 'task')
    assert.equal(forest.nodes[0].subagent, false)
  })

  test('a lineage cycle anchors at the repeated id instead of looping', () => {
    const forest = agentForestOf(snap({
      a: row({ parentId: 'b', displayTitle: 'A' }),
      b: row({ parentId: 'a', displayTitle: 'B' }),
    }), 'a')
    assert.ok(forest !== null)
    // a → b → a(chain hit): the walk roots at b, whose subtree holds both.
    assert.deepEqual(forest.nodes.map(n => n.id), ['b', 'a'])
    assert.equal(forest.overflow, 0)
  })

  test('siblings follow the parent catalog spawn order when cached', () => {
    // The activity heuristic alone would lead with running/recent a; the parent's
    // subagentCatalog (the harness header popup's own order) says b first.
    const forest = agentForestOf(snap({
      root: row({
        projectionValues: {
          subagentCatalog: [
            { id: 'b', createdAt: 2, mode: 'one-shot' },
            { id: 'a', createdAt: 1, mode: 'one-shot' },
          ],
        },
      }),
      a: row({ parentId: 'root', running: true, updatedAt: 9 }),
      b: row({ parentId: 'root', updatedAt: 1 }),
    }), 'root')
    assert.ok(forest !== null)
    assert.deepEqual(forest.nodes.map(n => n.id), ['root', 'b', 'a'])
  })

  test('uncataloged children sort after cataloged ones; malformed catalog entries drop alone', () => {
    const forest = agentForestOf(snap({
      root: row({
        projectionValues: {
          subagentCatalog: [
            { id: 'b', createdAt: 2 },
            'garbage',
            { id: 42 },
            { id: '' },
            // A repeated id keeps its first rank.
            { id: 'b', createdAt: 3 },
          ],
        },
      }),
      // Insertion order a→b→c makes the sort compare the cataloged b against the
      // uncataloged a in both argument directions.
      a: row({ parentId: 'root', updatedAt: 5 }),
      b: row({ parentId: 'root', updatedAt: 1 }),
      c: row({ parentId: 'root', running: true }),
    }), 'root')
    assert.ok(forest !== null)
    // b cataloged first; the uncataloged tail keeps the activity heuristic (running c, then a).
    assert.deepEqual(forest.nodes.map(n => n.id), ['root', 'b', 'c', 'a'])
  })

  test('a hostile or empty catalog value keeps the activity heuristic', () => {
    for (const cat of ['nope', 42, [], [null], [{ id: '' }]]) {
      const forest = agentForestOf(snap({
        root: row({ projectionValues: { subagentCatalog: cat } }),
        a: row({ parentId: 'root', updatedAt: 1 }),
        b: row({ parentId: 'root', updatedAt: 9 }),
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

  test('caps the subtree at AGENT_TREE_LIMIT and reports the exact overflow', () => {
    const byId: Record<string, unknown> = { root: row({}) }
    for (let i = 0; i < AGENT_TREE_LIMIT + 5; i++) byId['kid' + i] = row({ parentId: 'root', updatedAt: i })
    const forest = agentForestOf(snap(byId), 'root')
    assert.ok(forest !== null)
    assert.equal(forest.nodes.length, AGENT_TREE_LIMIT)
    // root + LIMIT+5 kids = LIMIT+6 members; the cap shows LIMIT.
    assert.equal(forest.overflow, 6)
  })
})

describe('subagentCostFoldOf', () => {
  const COST_A: SessionCostUsage = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } }
  const COST_B: SessionCostUsage = { 'zai-coding-cn': { 'glm-5.3-flash': { peak: { uncached: 10, cacheRead: 0, cacheWrite: 20, output: 0 } } } }

  /** A row whose timeline carries the given cost (a priced row when cost is given). */
  function costRow(parentId: string | undefined, cost?: SessionCostUsage): Record<string, unknown> {
    return row({
      ...(parentId !== undefined ? { parentId } : {}),
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
    // root's own usage stays out; a timeline row without cost contributes nothing.
    assert.deepEqual(fold.usage, mergeCostUsage(COST_B, COST_A))
    assert.deepEqual(fold.cold, [])
    // kid + grand + kid2 — the stranger and the detached orphan are no descendants.
    assert.equal(fold.count, 3)
  })

  test('a descendant without a timeline row is a cold fetch target until its head lands', () => {
    const byId = {
      root: costRow(undefined, COST_A),
      cold: row({ parentId: 'root', projectionValues: { contextPressure: { projectedTokens: 1 } } }),
      bare: row({ parentId: 'root' }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.equal(fold.usage, null, 'nothing warm or landed yet')
    assert.deepEqual(fold.cold, ['cold', 'bare'])
    assert.equal(fold.count, 2, 'a cold descendant is a subagent too')
    // The landed head injects the cold relative's usage and empties the fetch list.
    const landed = new Map<string, ContextTimeline>([['cold', { ...timeline(50), cost: COST_B }]])
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'root', landed).usage, COST_B)
    assert.deepEqual(subagentCostFoldOf(snap(byId), 'root', landed).cold, ['bare'])
  })

  test('a landed head whose cost is absent leaves the id warm but contributes nothing', () => {
    const byId = { root: costRow(undefined, COST_A), cold: row({ parentId: 'root' }) }
    const landed = new Map<string, ContextTimeline>([['cold', timeline(50)]])
    const fold = subagentCostFoldOf(snap(byId), 'root', landed)
    // The head landed (no more fetch targets) but carried no cost — and the
    // current session's own usage never counts in the subtree fold.
    assert.deepEqual(fold.usage, null)
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 1)
  })

  test('blank placeholders are not agents and a lineage cycle cannot loop the walk', () => {
    const byId: Record<string, unknown> = {
      root: costRow(undefined, COST_A),
      blank: row({ parentId: 'root', blank: true, projectionValues: { contextTimeline: { ...timeline(1), cost: COST_B } } }),
      a: row({ parentId: 'b' }),
      b: row({ parentId: 'a' }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.deepEqual(fold.usage, null, 'the blank usage and the detached cycle stay out (root\'s own cost never counts)')
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 0, 'the blank placeholder is no subagent either')
  })

  test('a cycle reachable from the current session is cut at the revisited id', () => {
    // The current session's row points at p, and p points back — the walk
    // must not re-enter the current session as its own "descendant".
    const byId: Record<string, unknown> = {
      root: row({ parentId: 'p', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_A } } }),
      p: row({ parentId: 'root', projectionValues: { contextTimeline: { ...timeline(1), cost: COST_B } } }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    assert.deepEqual(fold.usage, COST_B, 'p counts once; the current session never counts as its own child')
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 1)
  })

  test('hostile rows and timeline values degrade to fewer contributions', () => {
    const byId = {
      root: costRow(undefined, COST_A),
      junkRow: 5,
      hostileTimeline: row({ parentId: 'root', projectionValues: { contextTimeline: 'garbage' } }),
      hostileCost: row({
        parentId: 'root',
        projectionValues: { contextTimeline: { ...timeline(1), cost: { junk: 5, p: { m: { peak: { uncached: 'x', cacheRead: 7 } } } } } },
      }),
    }
    const fold = subagentCostFoldOf(snap(byId), 'root')
    // The hostile timeline sanitizes to a cost-less head (no contribution, no
    // throw); the hostile cost loses its junk branch and coerces its fields.
    assert.deepEqual(fold.usage, { p: { m: { peak: { uncached: 0, cacheRead: 7, cacheWrite: 0, output: 0 } } } })
    assert.deepEqual(fold.cold, [])
    assert.equal(fold.count, 2, 'the non-row never joined the walk')
  })
})

describe('layoutForest', () => {
  /** The natural cell pitch (agentTree.ts SLOT_MAX) — the width a roomy stage settles on. */
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
      head: null,
      requests: 0,
      billed: null,
      costUsage: null,
      durationMs: null,
      identity: null,
    }))
    // Depth follows the parent chain (one level per hop in this fixture).
    for (const n of nodes) {
      let d = 0
      let cur = n
      while (cur.parentId !== undefined) {
        d++
        cur = nodes.find(m => m.id === cur.parentId) as typeof cur
      }
      n.depth = d
    }
    // Family: the level-1 ancestor's index in (array = DFS) order; root = -1.
    const levelOne = nodes.filter(n => n.depth === 1)
    for (const n of nodes) {
      let cur = n
      while (cur.depth > 1) cur = nodes.find(m => m.id === cur.parentId) as typeof cur
      n.family = cur.depth === 0 ? -1 : levelOne.indexOf(cur)
    }
    return {
      nodes,
      edges: ids.filter(pair => pair[1] !== undefined).map(([to, from]) => ({ from: from as string, to })),
      overflow: 0,
      solo: ids.length === 1,
    }
  }

  test('single node: no links, minimal stage (even when a stage width is given)', () => {
    const layout = layoutForest(forestOf([['root']]), 500)
    assert.equal(layout.points.length, 1)
    assert.equal(layout.points[0].depth, 0)
    assert.equal(layout.links.length, 0)
    assert.equal(layout.width, SLOT)
    assert.equal(layout.height, 48 + 104 + 24)
    assert.equal(layout.cardW, SLOT - 12)
  })

  test('levels follow depth, siblings claim leaf slots, parents center over children', () => {
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['g', 'a']]))
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    // Two leaf cells (g under a, then b); root centers between them.
    assert.equal(pointOf.get('g')?.x, SLOT / 2)
    assert.equal(pointOf.get('a')?.x, SLOT / 2)
    assert.equal(pointOf.get('b')?.x, SLOT / 2 + SLOT)
    assert.equal(pointOf.get('root')?.x, SLOT)
    // One row per depth level.
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + 144)
    assert.equal(pointOf.get('g')?.y, 48 + 2 * 144)
    // Links exit the parent card's bottom edge and enter the child card's top edge.
    const linkG = layout.links.find(l => l.to === 'g')
    assert.ok(linkG !== undefined)
    assert.equal(linkG.x1, pointOf.get('a')?.x)
    assert.equal(linkG.y1, (pointOf.get('a')?.y as number) + 104)
    assert.equal(linkG.x2, pointOf.get('g')?.x)
    assert.equal(linkG.y2, pointOf.get('g')?.y)
    assert.equal(linkG.running, false)
    assert.equal(layout.links.find(l => l.to === 'b')?.running, true)
    // Links carry the family hue of the child's level-1 subtree: g inherits a's family (0); b is its own family (1).
    assert.equal(linkG.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'b')?.color, familyHue(1))
    assert.equal(layout.links.length, 3)
    assert.equal(layout.width, 2 * SLOT)
    assert.equal(layout.height, 48 + 2 * 144 + 104 + 24)
  })

  test('responsive: a wide stage keeps the natural pitch', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']])
    const layout = layoutForest(forest, 4000)
    assert.equal(layout.width, 3 * SLOT)
    assert.equal(layout.cardW, SLOT - 12)
  })

  test('responsive: a tighter stage compresses the slot pitch to fit exactly', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']])
    const layout = layoutForest(forest, 500)
    const slot = 500 / 3
    assert.equal(layout.width, 500)
    assert.equal(layout.cardW, slot - 12)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('a')?.x, slot / 2)
    assert.equal(pointOf.get('b')?.x, slot * 1.5)
    // With three leaves the root centers over the middle child (same x).
    assert.equal(pointOf.get('root')?.x, slot * 1.5)
  })

  test('responsive: a narrow stage folds the family into a single-column stack', () => {
    // Stage 180 → perLevel = max(1, 1) = 1: cards fold one per row — a readable
    // vertical stack instead of two crushed mini-cards; the layout still matches the stage exactly.
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root']]), 180)
    assert.equal(layout.width, 180)
    assert.equal(layout.cardW, 180 - 12)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.x, 90)
    assert.equal(pointOf.get('a')?.x, 90)
    assert.equal(pointOf.get('b')?.x, 90)
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + 144)
    assert.equal(pointOf.get('b')?.y, 48 + 2 * 144)
    assert.equal(layout.height, 48 + 2 * 144 + 104 + 24)
  })

  test('responsive: a level too wide even at the minimum pitch wraps into bands', () => {
    // Stage 300 → perLevel = floor(300/150) = 2: the 3-child level splits 2+1
    // at a 150px cell pitch; short bands center themselves.
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']]), 300)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.x, 150)
    assert.equal(pointOf.get('a')?.x, 75)
    assert.equal(pointOf.get('b')?.x, 75 + 150)
    assert.equal(pointOf.get('c')?.x, 150)
    // The wrapped band is a row of its own.
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('a')?.y, 48 + 144)
    assert.equal(pointOf.get('c')?.y, 48 + 2 * 144)
    // Links still join every child, the cross-band one included.
    const linkC = layout.links.find(l => l.to === 'c')
    assert.ok(linkC !== undefined)
    assert.equal(linkC.y1, 48 + 104)
    assert.equal(linkC.y2, 48 + 2 * 144)
    assert.equal(linkC.color, familyHue(2))
    assert.equal(layout.links.find(l => l.to === 'a')?.color, familyHue(0))
    assert.equal(layout.width, 300)
    assert.equal(layout.height, 48 + 2 * 144 + 104 + 24)
    assert.equal(layout.cardW, 150 - 12)
  })

  test('responsive: full bands at an intermediate pitch fit the stage exactly', () => {
    // Stage 400 → perLevel = 2; six children split 2+2+2 at a 200px cell pitch.
    const kids: [string, string?][] = [['root']]
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) kids.push([id, 'root'])
    const layout = layoutForest(forestOf(kids), 400)
    const slot = 400 / 2
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('a')?.x, slot / 2)
    assert.equal(pointOf.get('c')?.x, slot / 2)
    assert.equal(pointOf.get('d')?.y, 48 + 2 * 144)
    assert.equal(layout.width, 400)
    assert.equal(layout.links.length, 6)
    assert.equal(layout.cardW, slot - 12)
  })

  test('responsive: child bands interleave with later parent bands (kinship order)', () => {
    // Stage 320 → perLevel = 2. Root's children split [p1,p2] / [p3]; p1's
    // kids' band lands right after p1's own band — BEFORE p3's band, so a family never straddles a stranger's row.
    const layout = layoutForest(forestOf([
      ['root'],
      ['p1', 'root'],
      ['p2', 'root'],
      ['p3', 'root'],
      ['k1', 'p1'],
      ['k2', 'p1'],
    ]), 320)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.y, 48)
    assert.equal(pointOf.get('p1')?.y, 48 + 144)
    assert.equal(pointOf.get('k1')?.y, 48 + 2 * 144)
    assert.equal(pointOf.get('p3')?.y, 48 + 3 * 144)
    // Kinship interleave: p1's grandchildren sit between p1's band and p3's band.
    assert.ok((pointOf.get('k1')?.y as number) < (pointOf.get('p3')?.y as number))
    // Links keep their family hue through the interleave: p1's subtree is family 0, p3 is family 2.
    assert.equal(layout.links.find(l => l.to === 'k1')?.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'p3')?.color, familyHue(2))
    assert.equal(layout.width, 320)
    assert.equal(layout.height, 48 + 3 * 144 + 104 + 24)
  })

  test('responsive: a partially filled band flushes before an overflowing sibling group', () => {
    // Stage 300 → perLevel = 2. p1's single kid starts a band; p2's two kids
    // would overflow it, so the band flushes first (k1 alone, then k2a+k2b).
    const layout = layoutForest(forestOf([
      ['root'],
      ['p1', 'root'],
      ['p2', 'root'],
      ['k1', 'p1'],
      ['k2a', 'p2'],
      ['k2b', 'p2'],
    ]), 300)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('p1')?.y, 48 + 144)
    assert.equal(pointOf.get('k1')?.y, 48 + 2 * 144)
    assert.equal(pointOf.get('k2a')?.y, 48 + 3 * 144)
    assert.equal(pointOf.get('k2b')?.y, 48 + 3 * 144)
    assert.equal(layout.links.length, 5)
    // k2a/k2b inherit p2's family hue (1), k1 inherits p1's (0).
    assert.equal(layout.links.find(l => l.to === 'k2a')?.color, familyHue(1))
    assert.equal(layout.links.find(l => l.to === 'k1')?.color, familyHue(0))
  })
})

describe('lineageOf', () => {
  const forest = agentForestOf(snap({
    root: row({}),
    a: row({ parentId: 'root' }),
    b: row({ parentId: 'root' }),
    g: row({ parentId: 'a' }),
  }), 'root')
  assert.ok(forest !== null)

  test('null or unknown id lights nothing', () => {
    assert.equal(lineageOf(forest, null), null)
    assert.equal(lineageOf(forest, 'ghost'), null)
  })

  test('a leaf lights its ancestor chain only', () => {
    assert.deepEqual([...lineageOf(forest, 'g') ?? []].sort(), ['a', 'g', 'root'])
  })

  test('the root lights its whole subtree; a mid node lights both directions', () => {
    assert.deepEqual([...lineageOf(forest, 'root') ?? []].sort(), ['a', 'b', 'g', 'root'])
    assert.deepEqual([...lineageOf(forest, 'a') ?? []].sort(), ['a', 'g', 'root'])
  })

  test('a parentage cycle terminates instead of looping', () => {
    const cycle = agentForestOf(snap({
      a: row({ parentId: 'b' }),
      b: row({ parentId: 'a' }),
    }), 'a')
    assert.ok(cycle !== null)
    assert.deepEqual([...lineageOf(cycle, 'a') ?? []].sort(), ['a', 'b'])
  })
})

describe('barSegments', () => {
  test('no window and no composition yield no segments at all', () => {
    assert.deepEqual(barSegments([], null, 'gray'), [])
    assert.deepEqual(barSegments([{ key: 'user', color: 'c', value: 0 }], null, 'gray'), [])
  })

  test('no window: composition fills the whole bar, negatives excluded', () => {
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

  test('pressure-only rows draw one threshold-colored fill plus the free remainder', () => {
    const segs = barSegments([], 40, 'orange')
    assert.equal(segs.length, 2)
    assert.equal(segs[0].key, 'fill')
    assert.equal(segs[0].color, 'orange')
    assert.equal(segs[0].share, 0.4)
    assert.equal(segs[1].free, true)
    assert.equal(segs[1].share, 0.6)
  })

  test('zero occupancy on a known window draws just the free remainder; out-of-range pct clamps', () => {
    const zero = barSegments([{ key: 'system', color: 'red', value: 5 }], 0, 'gray')
    assert.equal(zero.length, 1)
    assert.equal(zero[0].free, true)
    assert.equal(zero[0].share, 1)
    // Over-100 pct clamps to a full bar with no remainder.
    const over = barSegments([{ key: 'system', color: 'red', value: 5 }], 150, 'gray')
    assert.equal(over.length, 1)
    assert.equal(over[0].share, 1)
    // Negative pct clamps to empty.
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
