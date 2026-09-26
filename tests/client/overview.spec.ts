// The Context Dashboard's data layer (src/client/overview.ts): the hostile-
// snapshot row join, filters, sorts, aggregations, and relative time — every
// guard branch with hostile fixtures.

import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import {
  aggregateDays,
  billedOf,
  createdDayOf,
  filterRows,
  groupCountsOf,
  inGroup,
  kpisOf,
  pageOf,
  projectOf,
  rangeStartOf,
  refreshSessions,
  relativeTime,
  requestActivityBackfill,
  rowsOfSnapshot,
  sessionGroupsOf,
  sessionsSnapshotOf,
  sortRows,
  timingSumOf,
  tokenPartsOf,
  turnsOf,
  UNGROUPED_KEY,
  usageTotalsOf,
  workspacesSnapshotOf,
  type OverviewRow,
} from '../../src/client/overview'
import type { ClientCtx } from '../../src/client/services'
import type { ContextActivity, ContextTimeline, SessionCostUsage } from '../../src/shared/types'

/** The minimal wire-valid timeline head, overridable per case. */
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

const COST: SessionCostUsage = {
  deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 10, output: 40 } } },
}

/** A session-list snapshot over rows of `{ id, row }` pairs. */
function snapshotOf(entries: [string, Record<string, unknown>][], current?: string): Record<string, unknown> {
  return {
    ids: entries.map(([id]) => id),
    byId: Object.fromEntries(entries),
    current,
    phase: 'ready',
  }
}

function rowOf(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: 's1',
    title: 'session one',
    updatedAt: 100,
    running: false,
    current: false,
    timeline: null,
    activity: null,
    ...over,
  }
}

describe('sessionsSnapshotOf', () => {
  test('a non-function seat reads null', () => {
    assert.equal(sessionsSnapshotOf({}), null)
    assert.equal(sessionsSnapshotOf({ useSessions: 7 }), null)
  })

  test('a throwing seat reads null instead of taking the render down', () => {
    assert.equal(sessionsSnapshotOf({ useSessions: () => { throw new Error('boom') } }), null)
  })

  test('the raw snapshot passes through', () => {
    const snap = { ids: [] }
    assert.equal(sessionsSnapshotOf({ useSessions: (sel: (s: unknown) => unknown) => sel(snap) }), snap)
  })
})

describe('rowsOfSnapshot', () => {
  test('unusable snapshots read null (the unavailable note, not an empty list)', () => {
    assert.equal(rowsOfSnapshot(null), null)
    assert.equal(rowsOfSnapshot(7), null)
    assert.equal(rowsOfSnapshot({}), null, 'ids missing')
    assert.equal(rowsOfSnapshot({ ids: 'x' }), null, 'ids not an array')
  })

  test('an empty ready list reads as a real empty array', () => {
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
      id: 'b', title: 'shown', updatedAt: 5, running: true, current: true,
      timeline: null, activity: null,
    })
    assert.equal(c.title, 'titled')
    assert.equal(c.current, false)
    assert.equal(d.title, 'd', 'the id is the last-resort title')
    assert.equal(e.title, 'e', 'empty strings fall through the ladder')
    assert.equal(e.cwd, '/repo')
    assert.equal(e.updatedAt, 0, 'a non-numeric stamp zeroes')
  })

  test('archived sessions drop; a hostile archive set fails open', () => {
    const snap = snapshotOf([
      ['a', { displayTitle: 'live' }],
      ['b', { displayTitle: 'archived' }],
      ['c', { displayTitle: 'kept' }],
    ])
    const rows = rowsOfSnapshot(snap, { archivedSessionIds: ['b', 7, null] })
    assert.ok(rows !== null)
    assert.deepEqual(rows.map(r => r.id), ['a', 'c'], 'archived ids drop; non-string entries archive nothing')
    // Fail-open shapes: an absent seat, a bare record, a malformed set, and a
    // throwing accessor all keep the full list.
    assert.equal(rowsOfSnapshot(snap)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, null)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, 7)?.length, 3)
    assert.equal(rowsOfSnapshot(snap, {})?.length, 3)
    assert.equal(rowsOfSnapshot(snap, { archivedSessionIds: 'x' })?.length, 3)
    assert.equal(rowsOfSnapshot(snap, { get archivedSessionIds() { throw new Error('boom') } })?.length, 3)
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

describe('billedOf / turnsOf', () => {
  test('billed sums the cost buckets; absent cost reads null', () => {
    assert.equal(billedOf(null), null)
    assert.equal(billedOf({ current: 1 } as never), null)
    assert.equal(billedOf({ cost: COST } as never), 200)
  })

  test('turns prefer the precomputed count and fall back to the records', () => {
    assert.equal(turnsOf(null), 0)
    assert.equal(turnsOf({ requests: [{}, {}] } as never), 2)
    assert.equal(turnsOf({ counts: { turns: 7 }, requests: [{}] } as never), 7)
  })
})

describe('rangeStartOf', () => {
  test('each window’s start instant; all is unbounded', () => {
    const now = 31 * 86_400_000
    assert.equal(rangeStartOf('24h', now), now - 86_400_000)
    assert.equal(rangeStartOf('7d', now), now - 7 * 86_400_000)
    assert.equal(rangeStartOf('30d', now), now - 30 * 86_400_000)
    assert.equal(rangeStartOf('all', now), null)
  })
})

describe('filterRows', () => {
  const rows = [
    rowOf({ id: 'old', title: 'ancient logs', updatedAt: 100 }),
    rowOf({ id: 'new', title: 'fresh fix', cwd: '/repo/app', updatedAt: 10 * 86_400_000 }),
    rowOf({
      id: 'active',
      title: 'busy bee',
      updatedAt: 10 * 86_400_000,
      activity: { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 0, requests: 0 } } },
    }),
  ]
  const now = 11 * 86_400_000

  test('the range window filters by last activity', () => {
    assert.deepEqual(filterRows(rows, { range: '24h', day: null, query: '' }, now).map(r => r.id), ['new', 'active'])
    assert.deepEqual(filterRows(rows, { range: '7d', day: null, query: '' }, now).map(r => r.id), ['new', 'active'])
    assert.deepEqual(filterRows(rows, { range: 'all', day: null, query: '' }, now).map(r => r.id), ['old', 'new', 'active'])
    // The 24h window's own boundary: inside by minutes, outside by an hour.
    const hRows = [
      rowOf({ id: 'fresh', title: 'just now', updatedAt: now - 2 * 3_600_000 }),
      rowOf({ id: 'yesterday', title: 'a day ago', updatedAt: now - 25 * 3_600_000 }),
    ]
    assert.deepEqual(filterRows(hRows, { range: '24h', day: null, query: '' }, now).map(r => r.id), ['fresh'])
  })

  test('the day pin keeps only sessions contributing to that day', () => {
    assert.deepEqual(filterRows(rows, { range: 'all', day: '2026-09-16', query: '' }, now).map(r => r.id), ['active'])
    assert.deepEqual(filterRows(rows, { range: 'all', day: '2026-09-10', query: '' }, now), [], 'a zero day is no contribution')
    assert.deepEqual(filterRows(rows, { range: 'all', day: '2026-09-11', query: '' }, now), [], 'no ledger entry')
  })

  test('the query matches title, directory, or last message, case-insensitively', () => {
    assert.deepEqual(filterRows(rows, { range: 'all', day: null, query: 'FRESH' }, now).map(r => r.id), ['new'])
    assert.deepEqual(filterRows(rows, { range: 'all', day: null, query: '/repo' }, now).map(r => r.id), ['new'])
    assert.deepEqual(filterRows(rows, { range: 'all', day: null, query: '  ' }, now).length, 3, 'a blank query matches all')
    assert.deepEqual(filterRows(rows, { range: 'all', day: null, query: 'zzz' }, now), [])
    // The session's newest own message joins the haystack.
    const talked = rowOf({ id: 'talk', title: 'quiet title', timeline: { lastUser: 'ship the QUARTERLY report' } as unknown as ContextTimeline })
    assert.deepEqual(filterRows([talked], { range: 'all', day: null, query: 'quarterly' }, now).map(r => r.id), ['talk'])
    assert.deepEqual(filterRows([talked], { range: 'all', day: null, query: 'quiet' }, now).map(r => r.id), ['talk'], 'the title still matches')
    // A non-string last message (a hostile fold shape) never matches.
    const odd = rowOf({ id: 'odd', title: 'odd one', timeline: { lastUser: 42 } as unknown as ContextTimeline })
    assert.deepEqual(filterRows([odd], { range: 'all', day: null, query: '42' }, now), [])
  })
})

describe('sortRows', () => {
  const cheap = rowOf({ id: 'cheap', updatedAt: 1, timeline: { current: { total: 50 }, cost: COST } as unknown as ContextTimeline })
  const dear = rowOf({
    id: 'dear',
    updatedAt: 2,
    timeline: {
      current: { total: 900 },
      cost: { deepseek: { m: { peak: { uncached: 1000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    } as unknown as ContextTimeline,
  })
  const plain = rowOf({ id: 'plain', updatedAt: 3 })

  test('recent orders by last activity, tokens by billed volume, context by current size', () => {
    const input = [cheap, plain, dear]
    assert.deepEqual(sortRows(input, 'recent').map(r => r.id), ['plain', 'dear', 'cheap'])
    assert.deepEqual(sortRows(input, 'tokens').map(r => r.id), ['dear', 'cheap', 'plain'], 'a data-less row sinks')
    assert.deepEqual(sortRows(input, 'context').map(r => r.id), ['dear', 'cheap', 'plain'])
    assert.deepEqual(input.map(r => r.id), ['cheap', 'plain', 'dear'], 'the input is never mutated')
  })
})

describe('pageOf', () => {
  const rows = Array.from({ length: 50 }, (_, i) => `s${i}`)

  test('a short list renders as one page holding everything', () => {
    assert.deepEqual(pageOf(['a', 'b'], 0), { items: ['a', 'b'], index: 0, count: 1 })
    assert.deepEqual(pageOf([], 0), { items: [], index: 0, count: 1 }, 'an empty list still renders one page')
  })

  test('pages slice the rows at the fixed size', () => {
    const first = pageOf(rows, 0)
    assert.equal(first.count, 5)
    assert.equal(first.items.length, 12)
    assert.deepEqual(pageOf(rows, 4), { items: rows.slice(48), index: 4, count: 5 }, 'the tail page holds the rest')
  })

  test('an out-of-range request clamps into the live range', () => {
    assert.equal(pageOf(rows, -1).index, 0, 'a negative request lands on the first page')
    assert.equal(pageOf(rows, 9).index, 4, 'a page that a shrink left out of range lands on the last')
  })
})

describe('createdDayOf', () => {
  const activity = { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 1, requests: 1 } } }

  test('the earliest ledger day stands in for the creation date', () => {
    assert.equal(createdDayOf(activity as ContextActivity), '2026-09-10')
    assert.equal(
      createdDayOf({ days: { '2026-09-10': { tokens: 1, requests: 1 }, '2026-09-16': { tokens: 5, requests: 1 } } } as ContextActivity),
      '2026-09-10',
      'a later day never displaces the earliest',
    )
  })

  test('no ledger, no days record, or an empty one names no creation date', () => {
    assert.equal(createdDayOf(null), undefined)
    assert.equal(createdDayOf({} as ContextActivity), undefined)
    assert.equal(createdDayOf({ days: {} } as ContextActivity), undefined)
  })
})

describe('usageTotalsOf', () => {
  test('absent or empty usage reads null (the caller keeps its dash)', () => {
    assert.equal(usageTotalsOf(null), null)
    assert.equal(usageTotalsOf(undefined), null)
    assert.equal(usageTotalsOf({}), null)
    assert.equal(usageTotalsOf({ deepseek: {} }), null)
    assert.equal(usageTotalsOf({ deepseek: { m: {} } }), null)
  })

  test('buckets sum per bucket and in total', () => {
    const totals = usageTotalsOf({
      deepseek: { a: { peak: { uncached: 10, cacheRead: 5, cacheWrite: 2, output: 3 }, off: { uncached: 4, cacheRead: 1, cacheWrite: 1, output: 1 } } },
      other: { b: { peak: { uncached: 1, cacheRead: 0, cacheWrite: 0, output: 2 } } },
    })
    assert.deepEqual(totals, { input: 15, cacheRead: 6, cacheWrite: 3, output: 6, total: 30 })
  })
})

describe('timingSumOf', () => {
  test('no timing anywhere reads null', () => {
    assert.equal(timingSumOf([]), null)
    assert.equal(timingSumOf([rowOf()]), null)
    assert.equal(timingSumOf([rowOf({ timeline: { requests: [] } as unknown as ContextTimeline })]), null)
  })

  test('sums the required fields and merges the per-tool tallies; the inputs stay untouched', () => {
    const a = { wallMs: 100, ttftMs: 10, genMs: 60, calls: 2, toolsMs: 30, toolCalls: 3, tools: { read: { calls: 2, ms: 20 } } }
    const b = { wallMs: 50, ttftMs: 5, genMs: 30, calls: 1, toolsMs: 10, toolCalls: 1, tools: { read: { calls: 1, ms: 5 }, write: { calls: 1, ms: 10 } } }
    const sum = timingSumOf([
      rowOf({ timeline: { timing: a } as unknown as ContextTimeline }),
      rowOf({ timeline: { timing: b } as unknown as ContextTimeline }),
    ])
    assert.deepEqual(sum, {
      wallMs: 150, ttftMs: 15, genMs: 90, calls: 3, toolsMs: 40, toolCalls: 4,
      tools: { read: { calls: 3, ms: 25 }, write: { calls: 1, ms: 10 } },
    })
    // The rows' own totals are never mutated, and a field no row carries
    // stays absent (the card's un-split / no-chip fallbacks key off absence).
    assert.deepEqual(a.tools.read, { calls: 2, ms: 20 })
    assert.equal('reasoningMs' in (sum as object), false)
    assert.equal('speedMs' in (sum as object), false)
  })

  test('the additive-optional fields sum their carriers only', () => {
    const split = {
      wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
      reasoningMs: 4, reasoningBlocks: 2, textMs: 5, textBlocks: 1, speedTokens: 100, speedMs: 2_000,
    }
    const preSplit = { wallMs: 1, ttftMs: 1, genMs: 10, calls: 1, toolsMs: 0, toolCalls: 0, tools: {} }
    const rowsOf = (timings: unknown[]): OverviewRow[] =>
      timings.map(timing => rowOf({ timeline: { timing } as unknown as ContextTimeline }))
    // Carrier first: the pre-split row adds nothing to the decode split.
    const sum = timingSumOf(rowsOf([split, preSplit]))
    const reverse = timingSumOf(rowsOf([preSplit, split]))
    for (const merged of [sum, reverse]) {
      assert.equal(merged?.genMs, 20, 'the generation window sums every row')
      assert.equal(merged?.reasoningMs, 4)
      assert.equal(merged?.reasoningBlocks, 2)
      assert.equal(merged?.textMs, 5)
      assert.equal(merged?.textBlocks, 1)
      assert.equal(merged?.toolArgMs, undefined, 'no row carries a tool-arg split')
      assert.equal(merged?.speedTokens, 100)
      assert.equal(merged?.speedMs, 2_000)
    }
    // Two carriers of one field sum both.
    const both = timingSumOf(rowsOf([split, { ...split, reasoningMs: 6, speedTokens: 50 }]))
    assert.equal(both?.reasoningMs, 10)
    assert.equal(both?.speedTokens, 150)
  })
})

describe('tokenPartsOf', () => {
  // The standard composition: system 100, tools 50, and a 350-token message
  // surface (user 30, inject 10, skill 10, assistant 200, tool 100).
  const STANDARD_CURRENT = { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }
  const TINY_CURRENT = { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }

  test('nothing billed reads null', () => {
    assert.equal(tokenPartsOf([]), null)
    assert.equal(tokenPartsOf([rowOf()]), null)
    assert.equal(
      tokenPartsOf([rowOf({ timeline: { current: STANDARD_CURRENT, requests: [] } as unknown as ContextTimeline })]),
      null,
      'a composition without billed buckets contributes nothing',
    )
  })

  test('folds each session\'s billedParts estimate by category; totals stay billed-exact', () => {
    const rows = [
      rowOf({ timeline: { current: STANDARD_CURRENT, cost: COST, requests: [] } as unknown as ContextTimeline }),
      rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } }, requests: [] } as unknown as ContextTimeline }),
    ]
    const folded = tokenPartsOf(rows)
    // Session 1: input 160 proportioned by 100:50:350 → 32/16/10/3/3/64/32, output 40.
    // Session 2: input 10 lands on its only category; its zero output adds nothing.
    assert.deepEqual(folded, {
      total: 210,
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
        { key: 'user', color: 'var(--color-green-500)', value: 10 },
        { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
        { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
        { key: 'assistant', color: 'var(--color-blue-500)', value: 64 },
        { key: 'tool', color: 'var(--color-teal-500)', value: 32 },
        { key: 'output', color: 'var(--color-pink-500)', value: 40 },
      ],
    })
  })

  test('a non-finite composition estimate drops whole instead of poisoning the sums', () => {
    const hostile = rowOf({
      timeline: {
        current: { system: Number.NaN, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: Number.NaN },
        cost: { deepseek: { m: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
        requests: [],
      } as unknown as ContextTimeline,
    })
    const plain = rowOf({ timeline: { current: TINY_CURRENT, cost: { deepseek: { m2: { peak: { uncached: 10, cacheRead: 0, cacheWrite: 0, output: 0 } } } } } as unknown as ContextTimeline })
    assert.deepEqual(tokenPartsOf([hostile]), { parts: [], total: 0 })
    assert.deepEqual(tokenPartsOf([hostile, plain]), {
      total: 10,
      parts: [{ key: 'system', color: 'var(--color-indigo-500)', value: 10 }],
    })
  })
})

describe('kpisOf', () => {
  const prices = { deepseek: { 'deepseek-v4': { hit: 0.1, miss: 1, write: 1, out: 2 } } }

  test('aggregates sessions, tokens, turns, cost, cache hit, tools, and time across the range', () => {
    const rows = [
      rowOf({
        timeline: {
          cost: COST,
          counts: { turns: 3 },
          current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
          requests: [],
          timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7, tools: {} },
        } as unknown as ContextTimeline,
      }),
      rowOf({
        timeline: {
          requests: [{}, {}],
          timing: { wallMs: 30_000, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} },
        } as unknown as ContextTimeline,
      }),
    ]
    const kpi = kpisOf(rows, 5, prices, 'usd')
    assert.equal(kpi.sessions, 2)
    assert.equal(kpi.listed, 5)
    assert.equal(kpi.tokens, 200)
    assert.equal(kpi.turns, 5)
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the DeepSeek peak bucket doubles: 2 × (50×0.1 + 100×1 + 10×1 + 40×2) per 1M')
    assert.equal(kpi.cacheHit, '31.25', '50 reads of 160 billed input, truncated')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 1, 'only the billed session feeds the cache-hit rate')
    assert.equal(kpi.toolCalls, 7, 'tool calls sum across rows')
    assert.equal(kpi.toolsMs, 20_000)
    assert.equal(kpi.calls, 6)
    assert.equal(kpi.wallMs, 120_000)
    // The aggregate cards' sources: the composition-folded billed split (the
    // unbilled session adds nothing) and the summed timing totals.
    assert.equal(kpi.tokenParts?.total, 200)
    assert.deepEqual(kpi.tokenParts?.parts.find(p => p.key === 'system'), { key: 'system', color: 'var(--color-indigo-500)', value: 32 })
    assert.deepEqual(kpi.timing, { wallMs: 120_000, ttftMs: 1_000, genMs: 30_000, calls: 6, toolsMs: 20_000, toolCalls: 7, tools: {} })
  })

  test('a session with usage the book cannot price feeds the cache-hit rate but prices to nothing', () => {
    const rows = [
      rowOf({ timeline: { cost: COST, current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 }, requests: [] } as unknown as ContextTimeline }),
      rowOf({
        timeline: {
          cost: { openai: { 'gpt-5': { peak: { uncached: 10, cacheRead: 5, cacheWrite: 1, output: 2 } } } },
          current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
          requests: [],
        } as unknown as ContextTimeline,
      }),
      rowOf(),
    ]
    const kpi = kpisOf(rows, 3, prices, 'usd')
    assert.equal(kpi.costSessions, 1, 'only the priced session counts toward the cost cell')
    assert.equal(kpi.usageSessions, 2, 'both billed sessions feed the cache-hit rate')
    assert.ok(kpi.cost !== null && Math.abs(kpi.cost - 390e-6) < 1e-12, 'the unpriced session adds nothing to the estimate')
    assert.equal(kpi.tokenParts?.total, 218, 'both sessions\' billed totals fold into the split')
    assert.equal(kpi.timing, null)
  })

  test('an unbilled set zeroes and dashes', () => {
    const kpi = kpisOf([rowOf()], 1, null, 'cny')
    assert.equal(kpi.tokens, 0)
    assert.equal(kpi.turns, 0)
    assert.equal(kpi.cost, null)
    assert.equal(kpi.cacheHit, null)
    assert.equal(kpi.costSessions, 0)
    assert.equal(kpi.usageSessions, 0)
    assert.equal(kpi.toolCalls, 0, 'no timing folds to zeroed tools and time')
    assert.equal(kpi.toolsMs, 0)
    assert.equal(kpi.calls, 0)
    assert.equal(kpi.wallMs, 0)
    assert.equal(kpi.tokenParts, null)
    assert.equal(kpi.timing, null)
  })
})

describe('aggregateDays', () => {
  test('merges every row’s ledger, skipping rows without one', () => {
    const rows = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-15': { tokens: 2, requests: 2 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 7, requests: 3 } } } }),
      rowOf(),
    ]
    assert.deepEqual(aggregateDays(rows), {
      '2026-09-16': { tokens: 12, requests: 4, sessions: 2 },
      '2026-09-15': { tokens: 2, requests: 2, sessions: 1 },
    })
  })

  test('a zeroed day entry is no activity: it counts no session and makes no day', () => {
    const rows = [
      rowOf({ activity: { days: { '2026-09-16': { tokens: 0, requests: 0 }, '2026-09-15': { tokens: 3, requests: 1 } } } }),
      rowOf({ activity: { days: { '2026-09-16': { tokens: 1, requests: 1 } } } }),
    ]
    assert.deepEqual(aggregateDays(rows), {
      '2026-09-16': { tokens: 1, requests: 1, sessions: 1 },
      '2026-09-15': { tokens: 3, requests: 1, sessions: 1 },
    })
  })
})

describe('relativeTime', () => {
  const t = (key: string, params?: Record<string, string | number>): string =>
    params === undefined ? key : `${key}:${String(params.n)}`
  const now = 10 * 86_400_000

  test('steps through just-now, minutes, hours, days', () => {
    assert.equal(relativeTime(t, now, now), 'ov.time.now')
    assert.equal(relativeTime(t, now - 59_000, now), 'ov.time.now')
    assert.equal(relativeTime(t, now - 5 * 60_000, now), 'ov.time.m:5')
    assert.equal(relativeTime(t, now - 59 * 60_000, now), 'ov.time.m:59')
    assert.equal(relativeTime(t, now - 3 * 3_600_000, now), 'ov.time.h:3')
    assert.equal(relativeTime(t, now - 23 * 3_600_000, now), 'ov.time.h:23')
    assert.equal(relativeTime(t, now - 9 * 86_400_000, now), 'ov.time.d:9')
  })

  test('future and invalid stamps read as just-now (clock skew is not an error)', () => {
    assert.equal(relativeTime(t, now + 60_000, now), 'ov.time.now')
    assert.equal(relativeTime(t, Number.NaN, now), 'ov.time.now')
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
  test('unusable snapshots read null', () => {
    assert.equal(sessionGroupsOf(null), null)
    assert.equal(sessionGroupsOf(7), null)
    assert.equal(sessionGroupsOf({}), null, 'items missing')
    assert.equal(sessionGroupsOf({ items: 'x' }), null, 'items not an array')
  })

  test('membership projects to a session → title map; first claim wins', () => {
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
    assert.deepEqual(calls, [['/api/dsh-context/backfill', { method: 'POST' }]])
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

  test('counts rows per workspace in registry order, ungrouped last', () => {
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
  })

  test('the first claim wins and unusable snapshots count every row ungrouped or empty', () => {
    const counts = groupCountsOf(rows, {
      items: [
        { title: 'one', sessionIds: ['a'] },
        { title: 'two', sessionIds: ['a'] },
      ],
    })
    assert.deepEqual(counts, [
      { key: 'one', count: 1 },
      { key: UNGROUPED_KEY, count: 3 },
    ])
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
