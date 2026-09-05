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
  familyHue,
  ringSegments,
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
      family: 0,
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
    assert.equal(layout.width, 184)
    assert.equal(layout.height, 56 + 90 + 28)
    assert.equal(layout.captionW, 184 - 8)
  })

  test('levels follow depth, siblings claim leaf slots, parents center over children', () => {
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['g', 'a']]))
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    // Two leaf cells (g under a, then b); root centers between them.
    assert.equal(pointOf.get('g')?.x, 92)
    assert.equal(pointOf.get('a')?.x, 92)
    assert.equal(pointOf.get('b')?.x, 92 + 184)
    assert.equal(pointOf.get('root')?.x, 92 + 92)
    // One row per depth level.
    assert.equal(pointOf.get('root')?.y, 56)
    assert.equal(pointOf.get('a')?.y, 56 + 154)
    assert.equal(pointOf.get('g')?.y, 56 + 2 * 154)
    // Links exit the parent's cell bottom and enter the child's top.
    const linkG = layout.links.find(l => l.to === 'g')
    assert.ok(linkG !== undefined)
    assert.equal(linkG.x1, pointOf.get('a')?.x)
    assert.equal(linkG.y1, (pointOf.get('a')?.y as number) + 90)
    assert.equal(linkG.x2, pointOf.get('g')?.x)
    assert.equal(linkG.y2, (pointOf.get('g')?.y as number) - AGENT_NODE_R - 10)
    assert.equal(linkG.running, false)
    assert.equal(layout.links.find(l => l.to === 'b')?.running, true)
    // Links carry the family hue of the child's level-1 subtree: g inherits
    // a's family (0); b is its own family (1).
    assert.equal(linkG.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'b')?.color, familyHue(1))
    assert.equal(layout.links.length, 3)
    assert.equal(layout.width, 2 * 184)
    assert.equal(layout.height, 56 + 2 * 154 + 90 + 28)
  })

  test('responsive: a wide stage keeps the natural pitch', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']])
    const layout = layoutForest(forest, 4000)
    assert.equal(layout.width, 3 * 184)
    assert.equal(layout.captionW, 184 - 8)
  })

  test('responsive: a tighter stage compresses the slot pitch to fit exactly', () => {
    const forest = forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']])
    const layout = layoutForest(forest, 500)
    const slot = 500 / 3
    assert.equal(layout.width, 500)
    assert.equal(layout.captionW, slot - 8)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('a')?.x, slot / 2)
    assert.equal(pointOf.get('b')?.x, slot * 1.5)
    // With three leaves the root centers over the middle child (same x).
    assert.equal(pointOf.get('root')?.x, slot * 1.5)
  })

  test('responsive: two leaves on a narrow stage compress below the minimum pitch (no wrap needed)', () => {
    // Stage 180 → perLevel = max(2, 1) = 2, and 2 leaves fit: the pitch just
    // drops to 90px — the layout always matches the stage, never scrolls.
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root']]), 180)
    assert.equal(layout.width, 180)
    assert.equal(layout.captionW, 90 - 8)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('a')?.x, 45)
    assert.equal(pointOf.get('b')?.x, 135)
    assert.equal(pointOf.get('root')?.x, 90)
  })

  test('responsive: a level too wide even at the minimum pitch wraps into bands', () => {
    // Stage 300 → perLevel = floor(300/112) = 2: the 3-child level splits 2+1
    // at a 150px cell pitch; short bands center themselves.
    const layout = layoutForest(forestOf([['root'], ['a', 'root'], ['b', 'root'], ['c', 'root']]), 300)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.x, 150)
    assert.equal(pointOf.get('a')?.x, 75)
    assert.equal(pointOf.get('b')?.x, 75 + 150)
    assert.equal(pointOf.get('c')?.x, 150)
    // The wrapped band is a row of its own.
    assert.equal(pointOf.get('root')?.y, 56)
    assert.equal(pointOf.get('a')?.y, 56 + 154)
    assert.equal(pointOf.get('c')?.y, 56 + 2 * 154)
    // Links still join every child — the cross-band one keeps the bezier fallback.
    const linkC = layout.links.find(l => l.to === 'c')
    assert.ok(linkC !== undefined)
    assert.equal(linkC.y1, 56 + 90)
    assert.equal(linkC.y2, 56 + 2 * 154 - AGENT_NODE_R - 10)
    assert.equal(linkC.color, familyHue(2))
    assert.equal(layout.links.find(l => l.to === 'a')?.color, familyHue(0))
    assert.equal(layout.width, 300)
    assert.equal(layout.height, 56 + 2 * 154 + 90 + 28)
    assert.equal(layout.captionW, 150 - 8)
  })

  test('responsive: full bands at an intermediate pitch fit the stage exactly', () => {
    // Stage 400 → perLevel = 3; six children split 3+3 at a 133px cell pitch.
    const kids: [string, string?][] = [['root']]
    for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) kids.push([id, 'root'])
    const layout = layoutForest(forestOf(kids), 400)
    const slot = 400 / 3
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('a')?.x, slot / 2)
    assert.equal(pointOf.get('c')?.x, slot * 2.5)
    assert.equal(pointOf.get('d')?.y, 56 + 2 * 154)
    assert.equal(layout.width, 400)
    assert.equal(layout.links.length, 6)
    assert.equal(layout.captionW, slot - 8)
  })

  test('responsive: child bands interleave with later parent bands (kinship order)', () => {
    // Stage 224 → perLevel = 2. Root's children split [p1,p2] / [p3]; p1's
    // kids' band lands right after p1's own band — BEFORE p3's band, so a
    // family never straddles a stranger's row.
    const layout = layoutForest(forestOf([
      ['root'],
      ['p1', 'root'],
      ['p2', 'root'],
      ['p3', 'root'],
      ['k1', 'p1'],
      ['k2', 'p1'],
    ]), 224)
    const pointOf = new Map(layout.points.map(p => [p.id, p]))
    assert.equal(pointOf.get('root')?.y, 56)
    assert.equal(pointOf.get('p1')?.y, 56 + 154)
    assert.equal(pointOf.get('k1')?.y, 56 + 2 * 154)
    assert.equal(pointOf.get('p3')?.y, 56 + 3 * 154)
    // Kinship interleave: p1's grandchildren sit between p1's band and p3's band.
    assert.ok((pointOf.get('k1')?.y as number) < (pointOf.get('p3')?.y as number))
    // Links keep their family hue through the interleave: p1's subtree is
    // family 0, p3 is family 2.
    assert.equal(layout.links.find(l => l.to === 'k1')?.color, familyHue(0))
    assert.equal(layout.links.find(l => l.to === 'p3')?.color, familyHue(2))
    assert.equal(layout.width, 224)
    assert.equal(layout.height, 56 + 3 * 154 + 90 + 28)
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
    assert.equal(pointOf.get('p1')?.y, 56 + 154)
    assert.equal(pointOf.get('k1')?.y, 56 + 2 * 154)
    assert.equal(pointOf.get('k2a')?.y, 56 + 3 * 154)
    assert.equal(pointOf.get('k2b')?.y, 56 + 3 * 154)
    assert.equal(layout.links.length, 5)
    // k2a/k2b inherit p2's family hue (1), k1 inherits p1's (0).
    assert.equal(layout.links.find(l => l.to === 'k2a')?.color, familyHue(1))
    assert.equal(layout.links.find(l => l.to === 'k1')?.color, familyHue(0))
  })
})

describe('ringSegments', () => {
  test('no window and no composition yield no segments at all', () => {
    assert.deepEqual(ringSegments([], null, 10, 'gray'), [])
    assert.deepEqual(ringSegments([{ key: 'user', color: 'c', value: 0 }], null, 10, 'gray'), [])
  })

  test('no window: composition fills the whole circle, negatives excluded', () => {
    const segs = ringSegments([
      { key: 'system', color: 'red', value: 1 },
      { key: 'user', color: 'green', value: -5 },
      { key: 'tool', color: 'blue', value: 3 },
    ], null, 10, 'gray')
    const c = 2 * Math.PI * 10
    assert.equal(segs.length, 2)
    assert.equal(segs[0].len, c / 4)
    assert.equal(segs[0].offset, 0)
    assert.equal(segs[0].free, false)
    assert.equal(segs[1].len, (3 * c) / 4)
    assert.equal(segs[1].offset, c / 4)
  })

  test('a known window scales composition to the occupancy share and appends the free remainder', () => {
    const segs = ringSegments([
      { key: 'system', color: 'red', value: 1 },
      { key: 'tool', color: 'blue', value: 3 },
    ], 50, 10, 'gray')
    const c = 2 * Math.PI * 10
    assert.equal(segs.length, 3)
    assert.equal(segs[0].len, c / 8)
    assert.equal(segs[1].len, (3 * c) / 8)
    assert.equal(segs[1].offset, c / 8)
    assert.equal(segs[2].free, true)
    assert.equal(segs[2].len, c / 2)
    assert.equal(segs[2].offset, c / 2)
  })

  test('pressure-only rows draw one threshold-colored arc plus the free remainder', () => {
    const segs = ringSegments([], 40, 10, 'orange')
    const c = 2 * Math.PI * 10
    assert.equal(segs.length, 2)
    assert.equal(segs[0].key, 'fill')
    assert.equal(segs[0].color, 'orange')
    assert.equal(segs[0].len, c * 0.4)
    assert.equal(segs[1].free, true)
    assert.equal(segs[1].len, c * 0.6)
  })

  test('zero occupancy on a known window draws just the free outline; out-of-range pct clamps', () => {
    const c = 2 * Math.PI * 10
    const zero = ringSegments([{ key: 'system', color: 'red', value: 5 }], 0, 10, 'gray')
    assert.equal(zero.length, 1)
    assert.equal(zero[0].free, true)
    assert.equal(zero[0].len, c)
    // Over-100 pct clamps to a full circle with no remainder.
    const over = ringSegments([{ key: 'system', color: 'red', value: 5 }], 150, 10, 'gray')
    assert.equal(over.length, 1)
    assert.equal(over[0].len, c)
    // Negative pct clamps to empty.
    const neg = ringSegments([], -5, 10, 'gray')
    assert.equal(neg.length, 1)
    assert.equal(neg[0].free, true)
  })
})

describe('familyHue', () => {
  test('consecutive families sit far apart on the color wheel and hues cycle', () => {
    assert.equal(familyHue(0), 'hsl(0 58% 52%)')
    assert.equal(familyHue(1), 'hsl(138 58% 52%)')
    assert.equal(familyHue(2), 'hsl(275 58% 52%)')
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
