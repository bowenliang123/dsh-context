import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import {
  dayRangeWindow,
  groupCountsOf,
  inGroup,
  projectOf,
  refreshSessions,
  requestActivityBackfill,
  rowHasTally,
  sessionGroupsOf,
  skillLoadsOf,
  tallyStatsOf,
  UNGROUPED_KEY,
  workspacesSnapshotOf,
  type OverviewRow,
} from '../../src/client/overview'
import type { ClientCtx } from '../../src/client/services'
import { dayKeyOf } from '../../src/shared/days'
import type { ContextActivity } from '../../src/shared/types'
import { rowOf, win } from './overview.fixtures'

const NOW = Date.UTC(2026, 8, 20, 12)
const day = (back: number): string => {
  const key = dayKeyOf(NOW - back * 86_400_000)
  assert.ok(key !== null)
  return key
}

describe('skillLoadsOf', () => {
  function rowWith(id: string, days: ContextActivity['days']): OverviewRow {
    return rowOf({ id, activity: { days } })
  }

  test('the range’s day floor scopes the aggregation; every member sums and the last load maximizes', () => {
    const rows = [
      rowOf({ id: 'bare' }),
      rowWith('empty-day', { [day(0)]: { tokens: 2, requests: 1 } }),
      rowWith('a', {
        [day(0)]: { tokens: 1, requests: 1, skills: { tdd: { n: 2, last: NOW - 1000 } } },
        [day(10)]: { tokens: 1, requests: 1, skills: { tdd: { n: 5, last: NOW - 900_000 }, stale: { n: 1, last: NOW - 900_000 } } },
      }),
      rowWith('b', {
        [day(1)]: { tokens: 1, requests: 1, skills: { tdd: { n: 3, last: NOW - 2000 }, grill: { n: 1, last: NOW - 500 } } },
      }),
    ]
    assert.deepEqual(skillLoadsOf(rows, { scope: win('7d', NOW), day: null }), [
      { name: 'tdd', n: 5, sessions: 2, last: NOW - 1000 },
      { name: 'grill', n: 1, sessions: 1, last: NOW - 500 },
    ], 'the 10-days-ago entries fall below the floor')
    assert.deepEqual(skillLoadsOf(rows, { scope: win('today', NOW), day: null }), [
      { name: 'tdd', n: 2, sessions: 1, last: NOW - 1000 },
    ], "today's floor admits this very day only")
    assert.deepEqual(skillLoadsOf(rows, { scope: win('all', NOW), day: null }), [
      { name: 'tdd', n: 10, sessions: 2, last: NOW - 1000 },
      { name: 'grill', n: 1, sessions: 1, last: NOW - 500 },
      { name: 'stale', n: 1, sessions: 1, last: NOW - 900_000 },
    ])
    const ranged = [
      rowWith('a', {
        [day(0)]: { tokens: 1, requests: 1, skills: { fresh: { n: 1, last: NOW } } },
        [day(1)]: { tokens: 1, requests: 1, skills: { edge: { n: 2, last: NOW } } },
        [day(5)]: { tokens: 1, requests: 1, skills: { late: { n: 4, last: NOW } } },
      }),
    ]
    const scope = dayRangeWindow({ from: day(4), to: day(1) })
    assert.ok(scope !== null)
    assert.deepEqual(skillLoadsOf(ranged, { scope, day: null }).map(s => s.name), ['edge'], 'the end day counts whole; the day past it does not')
    assert.equal(rowHasTally(ranged[0], 'skills', 'late', { scope, day: null }), false)
    assert.equal(rowHasTally(ranged[0], 'skills', 'edge', { scope, day: null }), true)
  })

  test('the loader tally counts a row once however many of its days carry the name', () => {
    const rows = [
      rowWith('a', {
        [day(0)]: { tokens: 1, requests: 1, skills: { tdd: { n: 1, last: NOW - 3000 } } },
        [day(1)]: { tokens: 1, requests: 1, skills: { tdd: { n: 1, last: NOW - 2000 } } },
      }),
      rowWith('b', { [day(0)]: { tokens: 1, requests: 1, skills: { tdd: { n: 1, last: NOW - 500 } } } }),
    ]
    assert.deepEqual(skillLoadsOf(rows, { scope: win('all', NOW), day: null }), [
      { name: 'tdd', n: 3, sessions: 2, last: NOW - 500 },
    ])
  })

  test('the sort keys reorder; ties fall to the next key, then the name', () => {
    const rows = [
      rowWith('a', {
        [day(0)]: {
          tokens: 1,
          requests: 1,
          skills: {
            alpha: { n: 3, last: NOW - 3000 },
            beta: { n: 1, last: NOW - 1000 },
            gamma: { n: 2, last: NOW - 500 },
            delta: { n: 1, last: NOW - 700 },
            epsilon: { n: 1, last: NOW - 700 },
          },
        },
      }),
      rowWith('b', { [day(0)]: { tokens: 1, requests: 1, skills: { beta: { n: 1, last: NOW - 2000 } } } }),
    ]
    const names = (sort?: 'loads' | 'recent'): string[] =>
      skillLoadsOf(rows, { scope: win('all', NOW), day: null, sort }).map(s => s.name)
    assert.deepEqual(names(), ['alpha', 'gamma', 'beta', 'delta', 'epsilon'], 'loads (the default): loads desc, then recent — the gamma/beta tie breaks on freshness')
    assert.deepEqual(names('loads'), ['alpha', 'gamma', 'beta', 'delta', 'epsilon'], 'the explicit key matches the omission')
    assert.deepEqual(names('recent'), ['gamma', 'delta', 'epsilon', 'beta', 'alpha'], 'recent: the freshest first')
    const tied = [rowWith('t', {
      [day(0)]: { tokens: 1, requests: 1, skills: { zeta: { n: 1, last: NOW }, eta: { n: 1, last: NOW } } },
    })]
    assert.deepEqual(skillLoadsOf(tied, { scope: win('all', NOW), day: null }).map(s => s.name), ['eta', 'zeta'], 'a full tie breaks on the name')
  })

  test('the heatmap’s pinned day scopes to that day exactly', () => {
    const rows = [
      rowWith('a', {
        [day(0)]: { tokens: 1, requests: 1, skills: { tdd: { n: 2, last: NOW - 1000 } } },
        [day(1)]: { tokens: 1, requests: 1, skills: { grill: { n: 4, last: NOW - 80_000 } } },
      }),
    ]
    assert.deepEqual(skillLoadsOf(rows, { scope: win('all', NOW), day: day(1) }), [
      { name: 'grill', n: 4, sessions: 1, last: NOW - 80_000 },
    ])
  })
})

describe('rowHasTally', () => {

  test('the scope’s day predicate decides — the range floor, the pinned day, and the skill-less days', () => {
    const row = rowOf({
      id: 'a',
      activity: {
        days: {
          [day(0)]: { tokens: 1, requests: 1, skills: { tdd: { n: 2, last: NOW - 1000 } } },
          [day(1)]: { tokens: 1, requests: 1 },
          [day(10)]: { tokens: 1, requests: 1, skills: { grill: { n: 1, last: NOW - 900_000 } } },
        },
      },
    })
    assert.equal(rowHasTally(row, 'skills', 'tdd', { scope: win('today', NOW), day: null }), true, "loaded today — inside today's floor")
    assert.equal(rowHasTally(row, 'skills', 'grill', { scope: win('today', NOW), day: null }), false, 'the 10-days-ago load falls below the floor')
    assert.equal(rowHasTally(row, 'skills', 'grill', { scope: win('all', NOW), day: null }), true)
    assert.equal(rowHasTally(row, 'skills', 'tdd', { scope: win('all', NOW), day: day(1) }), false, 'the pinned day admits only itself')
    assert.equal(rowHasTally(row, 'skills', 'grill', { scope: win('all', NOW), day: day(10) }), true)
    assert.equal(rowHasTally(row, 'skills', 'never', { scope: win('all', NOW), day: null }), false, 'a name no day carries')
    assert.equal(rowHasTally(rowOf({ id: 'bare' }), 'skills', 'tdd', { scope: win('all', NOW), day: null }), false, 'no ledger at all')
  })
})

describe('tallyStatsOf', () => {

  test('the tool and command tables fold per field with the same scope rules; each row counts once per name', () => {
    const rows = [
      rowOf({
        id: 'a',
        activity: {
          days: {
            [day(0)]: {
              tokens: 1,
              requests: 1,
              tools: { read: { n: 2, last: NOW - 1000 }, bash: { n: 1, last: NOW - 500 } },
              cmds: { git: { n: 1, last: NOW - 900 } },
            },
            [day(1)]: {
              tokens: 1,
              requests: 1,
              tools: { read: { n: 3, last: NOW - 2000 } },
              cmds: { pnpm: { n: 2, last: NOW - 800 } },
            },
            [day(10)]: { tokens: 1, requests: 1, tools: { grep: { n: 4, last: NOW - 50 } } },
          },
        },
      }),
      rowOf({
        id: 'b',
        activity: {
          days: {
            [day(1)]: {
              tokens: 1,
              requests: 1,
              tools: { read: { n: 1, last: NOW - 100 } },
              cmds: { git: { n: 2, last: NOW - 700 } },
            },
          },
        },
      }),
    ]
    assert.deepEqual(tallyStatsOf(rows, { scope: win('7d', NOW), day: null, field: 'tools' }), [
      { name: 'read', n: 6, sessions: 2, last: NOW - 100 },
      { name: 'bash', n: 1, sessions: 1, last: NOW - 500 },
    ], 'the 10-days-ago grep falls below the floor')
    assert.deepEqual(
      tallyStatsOf(rows, { scope: win('all', NOW), day: null, field: 'tools' }).map(s => s.name),
      ['read', 'grep', 'bash'],
      'count desc, then freshness',
    )
    assert.deepEqual(tallyStatsOf(rows, { scope: win('all', NOW), day: null, field: 'cmds' }), [
      { name: 'git', n: 3, sessions: 2, last: NOW - 700 },
      { name: 'pnpm', n: 2, sessions: 1, last: NOW - 800 },
    ])
    assert.deepEqual(tallyStatsOf(rows, { scope: win('all', NOW), day: day(0), field: 'cmds' }), [
      { name: 'git', n: 1, sessions: 1, last: NOW - 900 },
    ], 'the pinned day admits only itself')
    assert.deepEqual(
      tallyStatsOf(rows, { scope: win('all', NOW), day: null, field: 'cmds', sort: 'recent' }).map(s => s.name),
      ['git', 'pnpm'],
    )
    assert.deepEqual(tallyStatsOf([rowOf({ id: 'bare' })], { scope: win('all', NOW), day: null, field: 'tools' }), [])

    assert.equal(rowHasTally(rows[1], 'tools', 'read', { scope: win('all', NOW), day: null }), true)
    assert.equal(rowHasTally(rows[1], 'tools', 'grep', { scope: win('7d', NOW), day: null }), false)
    assert.equal(rowHasTally(rows[0], 'cmds', 'git', { scope: win('7d', NOW), day: day(1) }), false)
    assert.equal(rowHasTally(rowOf({ id: 'bare' }), 'cmds', 'git', { scope: win('all', NOW), day: null }), false)
  })
})

describe('workspacesSnapshotOf', () => {
  test('a non-function or throwing seat reads null; the raw snapshot passes through', () => {
    assert.equal(workspacesSnapshotOf({}), null)
    assert.equal(workspacesSnapshotOf({ useWorkspaces: 7 }), null)
    assert.equal(workspacesSnapshotOf({ useWorkspaces: () => { throw new Error('boom') } }), null)
    const snap = { items: [] }
    assert.equal(workspacesSnapshotOf({ useWorkspaces: (sel: (s: unknown) => unknown) => sel(snap) }), snap)
  })
})

describe('sessionGroupsOf', () => {
  test('unusable snapshots read null; membership projects to a session → title map with the first claim winning', () => {
    assert.equal(sessionGroupsOf(null), null)
    assert.equal(sessionGroupsOf(7), null)
    assert.equal(sessionGroupsOf({}), null, 'items missing')
    assert.equal(sessionGroupsOf({ items: 'x' }), null, 'items not an array')
    const groups = sessionGroupsOf({
      items: [
        { title: 'dsh-context', sessionIds: ['a', 'b'] },
        { title: 'other', sessionIds: ['b', 'c'] },
        { title: '', sessionIds: ['d'] },
        { sessionIds: ['e'] },
        { title: 'listless' },
        { title: 'junk-ids', sessionIds: [7, 'f'] },
        'garbage',
      ],
    })
    assert.deepEqual(groups, { a: 'dsh-context', b: 'dsh-context', c: 'other', f: 'junk-ids' })
  })
})

describe('projectOf', () => {
  test('the basename of the session cwd (both separators), absent without one', () => {
    assert.equal(projectOf(undefined), undefined)
    assert.equal(projectOf(''), undefined)
    assert.equal(projectOf('/Users/bw/dev/dsh-context'), 'dsh-context')
    assert.equal(projectOf('/Users/bw/dev/dsh-context/'), 'dsh-context')
    assert.equal(projectOf('C:\\dev\\repo'), 'repo')
    assert.equal(projectOf('/'), undefined)
  })
})

describe('refreshSessions', () => {
  test('dispatches the baseline re-pull; rejections and hostility swallow', async () => {
    let pulls = 0
    const ctxWith = (services: Record<string, unknown>): ClientCtx => ({ get: (n: string) => services[n] }) as unknown as ClientCtx
    refreshSessions(ctxWith({ sessions: { refresh: () => { pulls++; return Promise.resolve() } } }))
    assert.equal(pulls, 1)
    refreshSessions(ctxWith({ sessions: { refresh: () => Promise.reject(new Error('down')) } }))
    refreshSessions(ctxWith({ sessions: { refresh: () => 'not a promise' as never } }))
    refreshSessions(ctxWith({ sessions: {} }))
    refreshSessions(ctxWith({ sessions: { refresh: 7 } }))
    refreshSessions(ctxWith({}))
    refreshSessions(ctxWith({ sessions: { refresh: () => { throw new Error('boom') } } }))
    refreshSessions({ get: () => { throw new Error('boom') } } as unknown as ClientCtx)
    await new Promise(resolve => setTimeout(resolve, 5))
  })
})

describe('requestActivityBackfill', () => {
  test('POSTs the warm-up trigger route once per call; rejections and hostility swallow', async () => {
    const calls: [string, RequestInit | undefined][] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      calls.push([String(url), init])
      return { ok: true }
    })
    requestActivityBackfill()
    assert.deepEqual(calls, [['api/dsh-context/backfill', { method: 'POST' }]])
    vi.stubGlobal('fetch', async () => Promise.reject(new Error('route absent')))
    requestActivityBackfill()
    vi.stubGlobal('fetch', () => { throw new Error('hostile transport') })
    requestActivityBackfill()
    vi.unstubAllGlobals()
    await new Promise(resolve => setTimeout(resolve, 5))
  })
})

describe('groupCountsOf', () => {
  const rows = [
    rowOf({ id: 'a' }),
    rowOf({ id: 'b' }),
    rowOf({ id: 'c' }),
    rowOf({ id: 'd' }),
  ]

  test('counts rows per workspace in registry order; the first claim wins; unusable snapshots read empty', () => {
    const counts = groupCountsOf(rows, {
      items: [
        { title: 'one', sessionIds: ['a', 'b'] },
        { title: 'two', sessionIds: ['c'] },
        { title: 'empty', sessionIds: ['zzz'] },
        { title: '', sessionIds: ['d'] },
        { sessionIds: ['d'] },
        { title: 'junk', sessionIds: 'not-an-array' },
        'garbage',
      ],
    })
    assert.deepEqual(counts, [
      { key: 'one', count: 2 },
      { key: 'two', count: 1 },
      { key: UNGROUPED_KEY, count: 1 },
    ], 'd has no claim; the empty group drops')
    assert.deepEqual(groupCountsOf(rows, {
      items: [
        { title: 'one', sessionIds: ['a'] },
        { title: 'two', sessionIds: ['a'] },
      ],
    }), [
      { key: 'one', count: 1 },
      { key: UNGROUPED_KEY, count: 3 },
    ], 'the first claim wins')
    assert.deepEqual(groupCountsOf(rows, null), [])
    assert.deepEqual(groupCountsOf(rows, { items: 'x' }), [])
    assert.deepEqual(groupCountsOf([], { items: [{ title: 'one', sessionIds: ['a'] }] }), [], 'no rows, no chips')
  })
})

describe('inGroup', () => {
  const groups = { a: 'one', b: 'two' }

  test('a title matches its claimed rows; the ungrouped key matches claimless ones', () => {
    assert.equal(inGroup(rowOf({ id: 'a' }), 'one', groups), true)
    assert.equal(inGroup(rowOf({ id: 'b' }), 'one', groups), false)
    assert.equal(inGroup(rowOf({ id: 'c' }), UNGROUPED_KEY, groups), true)
    assert.equal(inGroup(rowOf({ id: 'a' }), UNGROUPED_KEY, groups), false)
    assert.equal(inGroup(rowOf({ id: 'a' }), 'one', null), false, 'no groups map: nothing matches a title')
    assert.equal(inGroup(rowOf({ id: 'a' }), UNGROUPED_KEY, null), true, 'no groups map: everything is ungrouped')
  })
})
