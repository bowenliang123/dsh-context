// agentTree (src/client/agentTree.ts) — the pure model behind the Agent
// network card: row/identity/timing narrowing, per-node stat folding from
// projection values, forest building over the session-list snapshot
// (lineage walk, sibling order, cap/overflow, cycles, self-stat merge),
// tidy layout, donut geometry, navigation and face narrowing, duration
// formatting.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  AGENT_NODE_R,
  AGENT_TREE_LIMIT,
  agentDurationOf,
  agentForestOf,
  agentIdentityOf,
  agentRowOf,
  agentStatsOf,
  donutSegments,
  fmtDuration,
  layoutForest,
  openAgentSession,
  sessionsFaceOf,
  type AgentForest,
  type SessionsFaceLike,
} from '../../src/client/agentTree'
import type { ContextTimeline } from '../../src/shared/types'

function timeline(total: number, requests = 0): ContextTimeline {
  return {
    ok: true,
    contextWindow: 1000,
    current: {
      system: 0, tools: 0, user: total, inject: 0, assistant: 0, tool: 0, total,
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
      running: false, completed: false, blank: false, updatedAt: 0,
    })
    assert.deepEqual(agentRowOf({
      displayTitle: 'Main', title: 'T', parentId: 'p', origin: 'subagent',
      running: true, completed: true, blank: true, updatedAt: 42,
      projectionValues: { title: 'x' },
    }), {
      displayTitle: 'Main', title: 'T', parentId: 'p', origin: 'subagent',
      running: true, completed: true, blank: true, updatedAt: 42,
      projections: { title: 'x' },
    })
    // Wrong-typed members drop; non-numeric updatedAt zeroes; non-record projections drop.
    assert.deepEqual(agentRowOf({
      displayTitle: 1, title: null, parentId: 2, origin: false,
      running: 'yes', updatedAt: 'soon', projectionValues: 7,
    }), { running: false, completed: false, blank: false, updatedAt: 0 })
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

describe('agentStatsOf', () => {
  test('absent values degrade to empty stats', () => {
    assert.deepEqual(agentStatsOf(undefined), {
      head: null, requests: 0, billed: null, durationMs: null, identity: null,
    })
    assert.deepEqual(agentStatsOf({}), {
      head: null, requests: 0, billed: null, durationMs: null, identity: null,
    })
  })

  test('timeline rows produce a full headline with parts and request count', () => {
    const stats = agentStatsOf({
      contextTimeline: timeline(500, 3),
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
    assert.equal(stats.durationMs, 2000)
    assert.deepEqual(stats.identity, { mode: 'continuable', label: 'helper' })
  })

  test('pressure-only rows still yield an occupancy head without slices', () => {
    const projected = agentStatsOf({ contextPressure: { projectedTokens: 250, contextWindow: 1000 } })
    assert.deepEqual(projected.head, { tokens: 250, window: 1000, pct: 25, parts: [] })
    // Falls back to the raw sample when no projection exists.
    const sampled = agentStatsOf({ contextPressure: { pressureTokens: 100 } })
    assert.deepEqual(sampled.head, { tokens: 100, window: undefined, pct: null, parts: [] })
    // A zero/invalid window never divides.
    const noWindow = agentStatsOf({ contextPressure: { projectedTokens: 5, contextWindow: 0 } })
    assert.deepEqual(noWindow.head, { tokens: 5, window: undefined, pct: null, parts: [] })
    // Pressure without any token figure is no head at all.
    assert.equal(agentStatsOf({ contextPressure: { contextWindow: 1000 } }).head, null)
  })

  test('usage sums into billed; malformed members zero out', () => {
    assert.equal(agentStatsOf({ tokenUsage: { uncachedInputTokens: 'x' } }).billed, 0)
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

  test('merges live self stats onto the current node', () => {
    const head = { tokens: 9, window: 10, pct: 90, parts: [] }
    const forest = agentForestOf(snap({}), 's1', { head, billed: 7, requests: 4 })
    assert.ok(forest !== null)
    assert.equal(forest.nodes[0].head, head)
    assert.equal(forest.nodes[0].billed, 7)
    assert.equal(forest.nodes[0].requests, 4)
    // Null self fields keep the row-derived stats; zero requests never erases the row's count.
    const withRow = agentForestOf(
      snap({
        s1: row({
          projectionValues: {
            contextTimeline: timeline(10, 2),
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
    assert.ok(withRow.nodes[0].head !== null)
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

describe('layoutForest', () => {
  function forestOf(ids: [string, string?][]): AgentForest {
    const nodes = ids.map(([id, parent], i) => ({
      id,
      label: id,
      ...(parent !== undefined ? { parentId: parent } : {}),
      depth: 0,
      isCurrent: i === 0,
      running: id === 'b',
      completed: false,
      subagent: parent !== undefined,
      head: null,
      requests: 0,
      billed: null,
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
    return {
      nodes,
      edges: ids.filter(pair => pair[1] !== undefined).map(([to, from]) => ({ from: from as string, to })),
      overflow: 0,
      solo: ids.length === 1,
    }
  }

  test('single node: no links, minimal stage', () => {
    const layout = layoutForest(forestOf([['root']]))
    assert.equal(layout.points.length, 1)
    assert.equal(layout.points[0].depth, 0)
    assert.equal(layout.links.length, 0)
    assert.equal(layout.width, 156)
    assert.equal(layout.height, 56 + 90 + 28)
  })

  test('levels follow depth, siblings claim leaf slots, parents center over children', () => {
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['g', 'a']]))
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    // Two leaf slots (g under a, then b); root centers between them.
    assert.equal(pointOf.get('g')?.x, 78)
    assert.equal(pointOf.get('a')?.x, 78)
    assert.equal(pointOf.get('b')?.x, 78 + 144)
    assert.equal(pointOf.get('root')?.x, 78 + 72)
    // One row per depth level.
    assert.equal(pointOf.get('root')?.y, 56)
    assert.equal(pointOf.get('a')?.y, 56 + 138)
    assert.equal(pointOf.get('g')?.y, 56 + 2 * 138)
    // Links exit the parent's cell bottom and enter the child's top.
    const linkG = layout.links.find(l => l.to === 'g')
    assert.ok(linkG !== undefined)
    assert.equal(linkG.x1, pointOf.get('a')?.x)
    assert.equal(linkG.y1, (pointOf.get('a')?.y as number) + 90)
    assert.equal(linkG.x2, pointOf.get('g')?.x)
    assert.equal(linkG.y2, (pointOf.get('g')?.y as number) - AGENT_NODE_R - 10)
    assert.equal(linkG.running, false)
    assert.equal(layout.links.find(l => l.to === 'b')?.running, true)
    assert.equal(layout.links.length, 3)
    assert.equal(layout.width, 156 + 144)
    assert.equal(layout.height, 56 + 2 * 138 + 90 + 28)
  })
})

describe('donutSegments', () => {
  test('empty and zero totals yield no segments', () => {
    assert.deepEqual(donutSegments([], 10), [])
    assert.deepEqual(donutSegments([{ key: 'user', color: 'c', value: 0 }], 10), [])
  })

  test('non-zero parts tile the circumference in order, negatives excluded', () => {
    const segs = donutSegments([
      { key: 'system', color: 'red', value: 1 },
      { key: 'user', color: 'green', value: -5 },
      { key: 'tool', color: 'blue', value: 3 },
    ], 10)
    const c = 2 * Math.PI * 10
    assert.equal(segs.length, 2)
    assert.equal(segs[0].len, c / 4)
    assert.equal(segs[0].offset, 0)
    assert.equal(segs[1].len, (3 * c) / 4)
    assert.equal(segs[1].offset, c / 4)
  })
})

describe('openAgentSession', () => {
  test('opens through the face and swallows the stale-row race', () => {
    const opened: string[] = []
    const face: SessionsFaceLike = { open: id => opened.push(id) }
    openAgentSession(face, 's1')
    assert.deepEqual(opened, ['s1'])
    openAgentSession(null, 's1')
    openAgentSession({}, 's1')
    openAgentSession({
      open: () => {
        throw new Error('unknown session')
      },
    }, 's1')
    assert.deepEqual(opened, ['s1'])
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
      get: () => ({ list: { getSnapshot: () => ({}), subscribe: () => () => {} }, open: () => {} }),
    })
    assert.ok(face !== null)
    assert.equal(typeof face.open, 'function')
  })
})

describe('fmtDuration', () => {
  test('compacts milliseconds', () => {
    assert.equal(fmtDuration(NaN), '—')
    assert.equal(fmtDuration(-5), '—')
    assert.equal(fmtDuration(42000), '42s')
    assert.equal(fmtDuration(185000), '3m05s')
    assert.equal(fmtDuration(4020000), '1h07m')
  })
})
