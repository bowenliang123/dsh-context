import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { billedOf, coveredRowsOf, rowsOfSnapshot, sessionsSnapshotOf, tokenPartsOf } from '../../src/client/overview'
import { mergeCostUsage } from '../../src/client/cost'
import type { SessionCostUsage } from '../../src/shared/types'
import { COST } from './overview.fixtures'

function timelineOf(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 10, tools: 20, user: 30, inject: 5, skill: 5, assistant: 40, tool: 50, total: 160 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

function snapshotOf(entries: [string, Record<string, unknown>][], current?: string): Record<string, unknown> {
  return {
    ids: entries.map(([id]) => id),
    byId: Object.fromEntries(entries),
    current,
    phase: 'ready',
  }
}

describe('sessionsSnapshotOf', () => {
  test('a non-function or throwing seat reads null; the raw snapshot passes through', () => {
    assert.equal(sessionsSnapshotOf({}), null)
    assert.equal(sessionsSnapshotOf({ useSessions: 7 }), null)
    assert.equal(sessionsSnapshotOf({ useSessions: () => { throw new Error('boom') } }), null)
    const snap = { ids: [] }
    assert.equal(sessionsSnapshotOf({ useSessions: (sel: (s: unknown) => unknown) => sel(snap) }), snap)
  })
})

describe('rowsOfSnapshot', () => {
  test('unusable snapshots read null; an empty or id-less ready list reads as a real empty array', () => {
    assert.equal(rowsOfSnapshot(null), null)
    assert.equal(rowsOfSnapshot(7), null)
    assert.equal(rowsOfSnapshot({}), null, 'ids missing')
    assert.equal(rowsOfSnapshot({ ids: 'x' }), null, 'ids not an array')
    assert.deepEqual(rowsOfSnapshot({ ids: [], byId: {} }), [])
    assert.deepEqual(rowsOfSnapshot({ ids: ['s1'] }), [], 'byId absent: the row is skipped')
    assert.deepEqual(rowsOfSnapshot({ ids: [7, 's1'], byId: {} }), [], 'non-string ids drop')
  })

  test('blank rows drop; metadata derives on the display ladder', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['a', { blank: true, displayTitle: 'blank one' }],
      ['b', { displayTitle: 'shown', updatedAt: 5, running: true }],
      ['c', { title: 'titled' }],
      ['d', {}],
      ['e', { displayTitle: '', title: '', cwd: '/repo', updatedAt: 'x' }],
    ], 'b'))
    assert.ok(rows !== null)
    assert.equal(rows.length, 4)
    const [b, c, d, e] = rows
    assert.deepEqual(b, {
      id: 'b', title: 'shown', updatedAt: 5, running: true, current: true, archived: false,
      timeline: null, activity: null, family: [null], familyActivity: [null], familyCost: null,
    })
    assert.equal(c.title, 'titled')
    assert.equal(c.current, false)
    assert.equal(d.title, 'd', 'the id is the last-resort title')
    assert.equal(e.title, 'e', 'empty strings fall through the ladder')
    assert.equal(e.cwd, '/repo')
    assert.equal(e.updatedAt, 0, 'a non-numeric stamp zeroes')
  })

  test('archived sessions are tagged, not dropped; a hostile archive set fails open', () => {
    const snap = snapshotOf([
      ['a', { displayTitle: 'live' }],
      ['b', { displayTitle: 'archived' }],
      ['c', { displayTitle: 'kept' }],
    ])
    const rows = rowsOfSnapshot(snap, { archivedSessionIds: ['b', 7, null] })
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['a', 'b', 'c'])
    assert.equal(rows[1].archived, true, 'the archived id tags its row')
    assert.equal(rows[0].archived, false)
    assert.equal(rows[2].archived, false, 'non-string entries archive nothing')
    assert.equal(rowsOfSnapshot(snap)?.length, 3)
    const hostileWorkspaces = [null, 7, {}, { archivedSessionIds: 'x' }, { get archivedSessionIds() { throw new Error('boom') } }]
    for (const [i, workspaces] of hostileWorkspaces.entries()) {
      assert.equal(rowsOfSnapshot(snap, workspaces)?.length, 3, `hostile archive set ${i}`)
    }
  })

  test('projection values are sanitized per row; hostile payloads degrade to nulls', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['a', {
        displayTitle: 'good',
        projectionValues: {
          contextTimeline: timelineOf({ counts: { turns: 2, steps: 3, injects: 0, compactions: 0, prunes: 0 } }),
          contextActivity: { days: { '2026-09-16': { tokens: 15, requests: 1 } } },
        },
      }],
      ['b', { displayTitle: 'junk', projectionValues: { contextTimeline: 7, contextActivity: 'x' } }],
    ]))
    assert.ok(rows !== null)
    const [a, b] = rows
    assert.equal(a.timeline?.counts?.turns, 2)
    assert.equal(a.activity?.days['2026-09-16'].tokens, 15)
    assert.equal(b.timeline, null)
    assert.equal(b.activity, null)
  })

  test('a hostile row that throws on access drops whole; the list survives', () => {
    const hostile = new Proxy({}, { get: () => { throw new Error('boom') } })
    const rows = rowsOfSnapshot({ ids: ['x', 'y'], byId: { x: hostile, y: { displayTitle: 'fine' } } })
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, 'y')
  })
})

describe('rowsOfSnapshot: subagent rows', () => {
  test('subagent-origin rows drop out (the workspace browser’s own exclusion)', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['main', { displayTitle: 'main session' }],
      ['child', { displayTitle: 'subagent run', origin: 'subagent', parentId: 'main' }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['main'])
  })
})

describe('rowsOfSnapshot: the family fold', () => {
  const COST2: SessionCostUsage = { zhipuai: { m: { peak: { uncached: 300, cacheRead: 0, cacheWrite: 0, output: 0 } } } }
  function billedHead(tokens: number, cost?: SessionCostUsage): Record<string, unknown> {
    return timelineOf({
      current: { system: 0, tools: 0, user: tokens, inject: 0, skill: 0, assistant: 0, tool: 0, total: tokens },
      ...(cost !== undefined ? { cost } : {}),
    })
  }

  test('every descendant level folds into the root row’s family — members, cost, and days merge', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', {
        displayTitle: 'root',
        projectionValues: {
          contextTimeline: billedHead(100, COST),
          contextActivity: { days: { '2026-09-16': { tokens: 5, requests: 1, cost: COST, turns: 1, toolCalls: 1, toolsMs: 100, wallMs: 1_000, tools: { read: { n: 2, last: 10 }, bash: { n: 1, last: 20 } }, cmds: { git: { n: 1, last: 30 } } }, '2026-09-12': { tokens: 2, requests: 1 }, '2026-09-13': { tokens: 1, requests: 1 }, '2026-09-14': { tokens: 1, requests: 1, turns: 2 }, '2026-09-11': { tokens: 1, requests: 1 } } },
        },
      }],
      ['kid', {
        origin: 'subagent', parentId: 'root',
        projectionValues: {
          contextTimeline: billedHead(50, COST2),
          contextActivity: { days: { '2026-09-16': { tokens: 7, requests: 2, cost: COST2, turns: 1, toolCalls: 2, toolsMs: 200, wallMs: 2_000, tools: { read: { n: 3, last: 40 } }, cmds: { git: { n: 2, last: 50 }, pnpm: { n: 1, last: 60 } } }, '2026-09-13': { tokens: 1, requests: 1 }, '2026-09-14': { tokens: 1, requests: 1 }, '2026-09-11': { tokens: 1, requests: 1, turns: 3 } } },
        },
      }],
      ['grand', {
        origin: 'subagent', parentId: 'kid',
        projectionValues: {
          contextTimeline: billedHead(25),
          contextActivity: {
            days: {
              '2026-09-16': { tokens: 4, requests: 1, turns: 1, toolCalls: 3, toolsMs: 300, wallMs: 3_000, tools: { grep: { n: 1, last: 70 } } },
              '2026-09-15': { tokens: 3, requests: 1, turns: 1, toolCalls: 4, toolsMs: 400, wallMs: 4_000 },
            },
          },
        },
      }],
      ['stranger', { displayTitle: 'unrelated' }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['root', 'stranger'], 'subagent-origin rows stay unlisted')
    const [root, stranger] = rows
    assert.equal(root.family.length, 3, 'self + kid + grand — all levels')
    assert.equal(root.familyActivity?.length, 3, 'the per-member ledgers align with the family')
    assert.equal(billedOf(root), 500)
    assert.equal(billedOf(stranger), null)
    assert.equal(root.activity?.days['2026-09-16'].tokens, 16)
    assert.equal(root.activity?.days['2026-09-16'].requests, 4)
    assert.deepEqual(root.activity?.days['2026-09-16'].cost, mergeCostUsage(COST, COST2))
    assert.equal(root.activity?.days['2026-09-16'].turns, 3)
    assert.equal(root.activity?.days['2026-09-16'].toolCalls, 6)
    assert.equal(root.activity?.days['2026-09-16'].toolsMs, 600)
    assert.equal(root.activity?.days['2026-09-16'].wallMs, 6_000)
    assert.deepEqual(root.activity?.days['2026-09-16'].tools, {
      read: { n: 5, last: 40 },
      bash: { n: 1, last: 20 },
      grep: { n: 1, last: 70 },
    }, 'the family’s per-tool tallies sum by name and keep the latest instant')
    assert.deepEqual(root.activity?.days['2026-09-16'].cmds, {
      git: { n: 3, last: 50 },
      pnpm: { n: 1, last: 60 },
    }, 'the family’s per-program tallies sum the same way')
    assert.equal(root.activity?.days['2026-09-15'].tokens, 3)
    assert.equal(root.activity?.days['2026-09-15'].turns, 1)
    assert.equal(root.activity?.days['2026-09-15'].toolCalls, 4)
    assert.equal(root.activity?.days['2026-09-15'].toolsMs, 400)
    assert.equal(root.activity?.days['2026-09-15'].wallMs, 4_000)
    assert.equal(root.activity?.days['2026-09-15'].cost, undefined)
    assert.equal(root.activity?.days['2026-09-12'].turns, undefined, 'a day no member carried a tally for leaves it absent')
    assert.equal(root.activity?.days['2026-09-12'].wallMs, undefined)
    assert.equal(root.activity?.days['2026-09-13'].turns, undefined, 'a tally absent in every carrier stays absent')
    assert.equal(root.activity?.days['2026-09-14'].turns, 2, 'a tally carried by one member survives the merge')
    assert.equal(root.activity?.days['2026-09-11'].turns, 3, 'a tally arriving from a later member starts the sum')
    const parts = tokenPartsOf([root])
    assert.deepEqual(parts, {
      total: 500,
      parts: [
        { key: 'user', color: 'var(--color-green-500)', value: 460 },
        { key: 'toolCalls', color: 'var(--color-teal-500)', value: 40 },
      ],
    })
  })

  test('an unlisted subtree (a subagent whose root never lists) leaks nowhere', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', { displayTitle: 'root', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['ghost', { origin: 'subagent', parentId: 'missing', projectionValues: { contextTimeline: billedHead(999, COST2) } }],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(billedOf(rows[0]), 200, 'the ghost subtree folds into no row')
  })

  test('a blank placeholder’s subtree stays out, and a forked row’s seed lineage is no subtree edge', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', { displayTitle: 'root', parentId: 'source', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['p', { origin: 'subagent', parentId: 'root', projectionValues: { contextTimeline: billedHead(2, COST2) } }],
      ['blank', { blank: true, parentId: 'root', projectionValues: { contextTimeline: billedHead(9, COST2) } }],
      ['under-blank', { origin: 'subagent', parentId: 'blank', projectionValues: { contextTimeline: billedHead(9, COST2) } }],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].family.length, 2, 'root + p; the blank is no agent and its child never links through')
    assert.equal(billedOf(rows[0]), 500, 'COST + COST2')
  })

  test('a forked row never folds its source, and the source keeps the fork out of its family', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['source', { displayTitle: 'source', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['fork', { displayTitle: 'source (1)', parentId: 'source', projectionValues: { contextTimeline: billedHead(10, COST2) } }],
      ['sub', { origin: 'subagent', parentId: 'source', projectionValues: { contextTimeline: billedHead(100) } }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['source', 'fork'])
    assert.equal(rows[0].family.length, 2, 'source + its subagent only')
    assert.equal(billedOf(rows[0]), 200, 'the fork cost (300) never rides the source family')
    assert.equal(rows[1].family.length, 1, 'the fork is its own family — the source never folds into it')
    assert.equal(billedOf(rows[1]), 300)
  })

  test('the daily ledgers’ skill tables merge name by name (loads sum, last takes the max)', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', {
        displayTitle: 'root',
        projectionValues: {
          contextActivity: { days: { '2026-09-16': { tokens: 5, requests: 1, skills: { tdd: { n: 2, last: 100 }, solo: { n: 1, last: 90 } } } } },
        },
      }],
      ['kid', {
        origin: 'subagent', parentId: 'root',
        projectionValues: {
          contextActivity: { days: { '2026-09-16': { tokens: 7, requests: 2, skills: { tdd: { n: 3, last: 200 }, fresh: { n: 1, last: 300 } } } } },
        },
      }],
    ]))
    assert.ok(rows !== null)
    assert.deepEqual(rows[0].activity?.days['2026-09-16'].skills, {
      tdd: { n: 5, last: 200 },
      solo: { n: 1, last: 90 },
      fresh: { n: 1, last: 300 },
    })
  })

  test('hostile descendant projections degrade to null members, never a throw', () => {
    const rows = rowsOfSnapshot(snapshotOf([
      ['root', { displayTitle: 'root', projectionValues: { contextTimeline: billedHead(1, COST) } }],
      ['kid', { origin: 'subagent', parentId: 'root', projectionValues: { contextTimeline: 7, contextActivity: 'x' } }],
      ['junk', 5 as unknown as Record<string, unknown>],
    ]))
    assert.ok(rows !== null)
    assert.equal(rows[0].family.length, 2)
    assert.equal(rows[0].family[1], null, 'the hostile head sanitizes to null in place')
    assert.equal(rows[0].activity, null, 'no member carried a ledger → the family has none')
    assert.equal(billedOf(rows[0]), 200)
  })

  test('a childless family serves its own parts directly, aliasing a fully quantified fee and re-merging a sparse one', () => {
    const activity = { days: { '2026-09-16': { tokens: 15, requests: 1 } } }
    const timeline = timelineOf({ cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 1, cacheRead: 2, cacheWrite: 3, output: 4 } } } } })
    const rows = rowsOfSnapshot(snapshotOf([
      ['solo', { displayTitle: 'solo', projectionValues: { contextTimeline: timeline, contextActivity: activity } }],
    ]))
    assert.ok(rows !== null)
    const row = rows[0]
    assert.ok(row.family.length === 1 && row.family[0] === row.timeline)
    const familyActivity = row.familyActivity ?? []
    assert.ok(familyActivity.length === 1 && familyActivity[0] === row.activity)
    assert.ok(row.familyCost === row.timeline?.cost, 'a fully quantified fee aliases')
    assert.ok(row.activity === (activity as never), 'the sanitized ledger keeps its identity')

    const sparse = rowsOfSnapshot(snapshotOf([
      ['solo', { displayTitle: 'solo', projectionValues: { contextTimeline: timelineOf({ cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 5 } } } } }) } }],
    ]))
    assert.ok(sparse !== null)
    assert.deepEqual(sparse[0].familyCost, {
      deepseek: { 'deepseek-v4': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    })
  })
})

describe('coveredRowsOf', () => {
  test('all passes the list through; the narrow scopes split on the archived tag', () => {
    const rows = [
      { id: 'a', archived: false },
      { id: 'b', archived: true },
      { id: 'c', archived: true },
    ] as unknown as Parameters<typeof coveredRowsOf>[0]
    assert.equal(coveredRowsOf(rows, 'all'), rows)
    assert.deepEqual(coveredRowsOf(rows, 'active').map(r => r.id), ['a'])
    assert.deepEqual(coveredRowsOf(rows, 'archived').map(r => r.id), ['b', 'c'])
    assert.equal(coveredRowsOf([], 'archived').length, 0)
    assert.deepEqual(coveredRowsOf([], 'all'), [])
  })
})

describe('rowsOfSnapshot caching', () => {
  test('unchanged rows keep their identity across snapshots; a changed row and its flags re-derive', () => {
    const snap = snapshotOf([
      ['a', { displayTitle: 'a', updatedAt: 1 }],
      ['b', { displayTitle: 'b', updatedAt: 2 }],
    ], 'a')
    const first = rowsOfSnapshot(snap)!
    const next = rowsOfSnapshot({
      ...snap,
      byId: { ...(snap.byId as object), b: { displayTitle: 'b', updatedAt: 3 } },
      current: 'a',
    })!
    assert.equal(next[0], first[0], 'a is untouched')
    assert.notEqual(next[1], first[1], 'b changed')
    const moved = rowsOfSnapshot({ ...snap, current: 'b' })!
    assert.notEqual(moved[0], first[0], 'the current flag is part of the cached variant')
    assert.equal(moved[1].current, true)
    assert.equal(first[1].current, false)
    const arch = rowsOfSnapshot(snap, { archivedSessionIds: ['a'] })!
    assert.notEqual(arch[0], first[0], 'the archived flag is part of the cached variant')
    assert.equal(arch[0].archived, true)
  })
})
