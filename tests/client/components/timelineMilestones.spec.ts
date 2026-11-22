import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import {
  bandItemsOf,
  eventTargetIndex,
  fitBandItemsOf,
  isMetricEntry,
  metricPeaksOf,
  milestoneJumpSeq,
  milestoneKindOf,
  milestonesOf,
  type MilestoneGroup,
} from '../../../src/client/components/timelineMilestones'

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: seq,
    seq,
    turn: 1,
    step: seq,
    system: 100,
    tools: 0,
    user: 0,
    inject: 0,
    assistant: 0,
    tool: 0,
    total: 100,
    ...over,
  }
}

function ev(over: Partial<ContextEventRecord> & { kind: ContextEventRecord['kind'] }): ContextEventRecord {
  return { seq: 1, time: 1, ...over }
}

function group(over: Partial<MilestoneGroup> & { targetIdx: number; anchor: 'boundary' | 'bar' }): MilestoneGroup {
  return {
    key: (over.anchor === 'bar' ? 'm:' : 'b:') + String(over.targetIdx),
    targetSeq: over.targetIdx + 1,
    targetTurn: 1,
    leadKind: 'compaction',
    entries: [{ kind: 'compaction', events: [] }],
    count: 1,
    ...over,
  }
}

describe('milestoneKindOf', () => {
  test('maps context changes, workflow milestones, agent spawns, skills, and agent messages; everything else is ignored', () => {
    assert.equal(milestoneKindOf(ev({ kind: 'compaction' })), 'compaction')
    assert.equal(milestoneKindOf(ev({ kind: 'prune' })), 'prune')
    assert.equal(milestoneKindOf(ev({ kind: 'model' })), 'model')
    assert.equal(milestoneKindOf(ev({ kind: 'agent' })), 'spawn')
    assert.equal(milestoneKindOf(ev({ kind: 'goal-create', name: 'Ship' })), 'goal-create')
    assert.equal(milestoneKindOf(ev({ kind: 'goal-complete', name: 'Ship' })), 'goal-complete')
    assert.equal(milestoneKindOf(ev({ kind: 'todo-add', items: ['a'] })), 'todo-add')
    assert.equal(milestoneKindOf(ev({ kind: 'todo-done', items: ['a'] })), 'todo-done')
    assert.equal(milestoneKindOf(ev({ kind: 'ask', items: ['q'] })), 'ask')
    assert.equal(milestoneKindOf(ev({ kind: 'team-task-create', name: 't' })), 'team-task-create')
    assert.equal(milestoneKindOf(ev({ kind: 'team-task-complete', name: 't' })), 'team-task-complete')
    assert.equal(milestoneKindOf(ev({ kind: 'inject', sub: 'skill' })), 'skill')
    assert.equal(milestoneKindOf(ev({ kind: 'inject', agent: 'reviewer' })), 'agent')
    assert.equal(milestoneKindOf(ev({ kind: 'inject', name: 'subagent-settled' })), 'agent')
    assert.equal(milestoneKindOf(ev({ kind: 'inject', name: 'hook' })), null)
    assert.equal(milestoneKindOf(ev({ kind: 'inject', agent: '' })), null)
    assert.equal(milestoneKindOf(ev({ kind: 'inject' })), null)
    assert.equal(milestoneKindOf(ev({ kind: 'mode' })), null)
  })
})

describe('eventTargetIndex', () => {
  const requests = [req(10, { turn: 1 }), req(20, { turn: 1 }), req(30, { turn: 2 })]

  test('steps land on the first request logged after the event', () => {
    assert.equal(eventTargetIndex(requests, ev({ seq: 21, kind: 'compaction' }), 'step'), 2)
    assert.equal(eventTargetIndex(requests, ev({ seq: 5, kind: 'compaction' }), 'step'), 0)
    assert.equal(eventTargetIndex(requests, ev({ seq: 99, kind: 'compaction' }), 'step'), -1)
  })

  test('turns land on their aggregate bar, falling back to the seq boundary when the turn is absent', () => {
    assert.equal(eventTargetIndex(requests, ev({ seq: 25, turn: 2, kind: 'compaction' }), 'turn'), 2)
    assert.equal(eventTargetIndex(requests, ev({ seq: 25, turn: 9, kind: 'compaction' }), 'turn'), 2)
    assert.equal(eventTargetIndex(requests, ev({ seq: 25, kind: 'compaction' }), 'turn'), 2)
    assert.equal(eventTargetIndex([req(10, { turn: undefined })], ev({ seq: 5, turn: 0, kind: 'compaction' }), 'turn'), 0)
    assert.equal(eventTargetIndex(requests, ev({ seq: 40, kind: 'compaction' }), 'turn'), -1)
  })
})

describe('metricPeaksOf', () => {
  test('finds the largest positive step duration and total growth, skipping the first step', () => {
    const requests = [
      req(1, { total: 100, activeMs: 10 }),
      req(2, { total: 400, activeMs: 30 }),
      req(3, { total: 350 }),
      req(4, { total: 500, activeMs: 20 }),
    ]
    assert.deepEqual(metricPeaksOf(requests), {
      longest: { idx: 1, value: 30 },
      growth: { idx: 1, value: 300 },
    })
  })

  test('ties keep the earliest step, while absent durations and non-positive growth stay null', () => {
    const tied = [
      req(1, { total: 100, activeMs: 30 }),
      req(2, { total: 200, activeMs: 30 }),
      req(3, { total: 300, activeMs: 30 }),
    ]
    assert.deepEqual(metricPeaksOf(tied), {
      longest: { idx: 0, value: 30 },
      growth: { idx: 1, value: 100 },
    })
    assert.deepEqual(metricPeaksOf([req(1), req(2, { total: 50 })]), { longest: null, growth: null })
    assert.deepEqual(metricPeaksOf([req(1, { activeMs: 0, total: 0 })]), { longest: null, growth: null })
    assert.deepEqual(metricPeaksOf([]), { longest: null, growth: null })
  })
})

describe('milestonesOf', () => {
  test('groups same-kind events at one boundary, keeps distinct kinds, and adds both metric peaks', () => {
    const requests = [
      req(1, { turn: 1, total: 100, activeMs: 5 }),
      req(2, { turn: 1, total: 200, activeMs: 20 }),
      req(3, { turn: 2, total: 150 }),
      req(4, { turn: 2, total: 300, activeMs: 10 }),
    ]
    const events = [
      ev({ seq: 2, kind: 'compaction', tokens: 10 }),
      ev({ seq: 2, kind: 'prune', tokens: 5 }),
      ev({ seq: 3, kind: 'inject', sub: 'skill', name: 'review', agent: 'ignored' }),
      ev({ seq: 3, kind: 'inject' }),
      ev({ seq: 3, kind: 'mode' }),
      ev({ seq: 4, kind: 'model', from: 'a', to: 'b' }),
      ev({ seq: 4, kind: 'agent', name: 'explorer' }),
      ev({ seq: 99, kind: 'compaction' }),
    ]
    const groups = milestonesOf(requests, events, 'step')
    assert.deepEqual(groups.map(g => [g.key, g.anchor, g.entries.map(e => e.kind), g.count]), [
      ['b:1', 'boundary', ['compaction', 'prune'], 2],
      ['m:1', 'bar', ['longest'], 1],
      ['b:2', 'boundary', ['skill'], 1],
      ['b:3', 'boundary', ['spawn', 'model'], 2],
      ['m:3', 'bar', ['growth'], 1],
    ])
    assert.equal(groups[0].leadKind, 'compaction')
    assert.equal(groups[0].targetTurn, 1)
    assert.equal(groups[3].leadKind, 'spawn')
    assert.equal(groups[3].targetSeq, 4)
    const compaction = groups[0].entries[0]
    assert.ok(!isMetricEntry(compaction))
    assert.equal(compaction.events.length, 1)
    assert.equal(groups[1].entries[0].kind, 'longest')
    assert.equal(isMetricEntry(groups[1].entries[0]), true)
  })

  test('turn granularity collapses events onto their turn bar and preserves the first lead kind', () => {
    const requests = [req(2, { turn: 1, stepCount: 2 }), req(3, { turn: 2 })]
    const groups = milestonesOf(requests, [
      ev({ seq: 2, turn: 1, kind: 'prune' }),
      ev({ seq: 3, turn: 2, kind: 'agent', name: 'worker' }),
    ], 'turn')
    assert.deepEqual(groups.map(g => [g.targetIdx, g.leadKind]), [[0, 'prune'], [1, 'spawn']])
  })

  test('an empty history has no milestones', () => {
    assert.deepEqual(milestonesOf([], [ev({ kind: 'compaction' })], 'step'), [])
  })

  test('workflow milestones share a step in priority order', () => {
    const groups = milestonesOf([
      req(10),
      req(20),
    ], [
      ev({ seq: 5, kind: 'todo-add', count: 2, items: ['a', 'b'] }),
      ev({ seq: 5, kind: 'goal-create', name: 'Ship' }),
      ev({ seq: 15, kind: 'ask', count: 1, items: ['q'] }),
      ev({ seq: 15, kind: 'team-task-complete', name: 'Build' }),
    ], 'step')
    assert.deepEqual(groups.map(g => [g.targetIdx, g.entries.map(entry => entry.kind)]), [
      [0, ['goal-create', 'todo-add']],
      [1, ['team-task-complete', 'ask']],
    ])
    assert.equal(groups[0].leadKind, 'goal-create')
    assert.equal(groups[1].leadKind, 'team-task-complete')
  })

  test('a request without a turn keeps a null target turn and repeated kinds share one entry', () => {
    const groups = milestonesOf(
      [req(1, { turn: undefined }), req(2, { turn: undefined })],
      [ev({ seq: 2, kind: 'compaction' }), ev({ seq: 2, kind: 'compaction' })],
      'step',
    )
    assert.equal(groups[0].targetTurn, null)
    assert.equal(groups[0].count, 2)
    const entry = groups[0].entries[0]
    assert.ok(!isMetricEntry(entry))
    assert.equal(entry.events.length, 2)
  })
})

describe('milestoneJumpSeq', () => {
  test('prefers an event seq over the aggregate target seq', () => {
    const metric = group({
      targetIdx: 3,
      anchor: 'bar',
      leadKind: 'longest',
      entries: [{ kind: 'longest', value: 10 }],
    })
    assert.equal(milestoneJumpSeq(metric), 4)
    const events = group({
      targetIdx: 1,
      anchor: 'boundary',
      targetSeq: 30,
      entries: [{ kind: 'compaction', events: [ev({ seq: 15, kind: 'compaction' })] }],
    })
    assert.equal(milestoneJumpSeq(events), 15)
  })
})

describe('bandItemsOf', () => {
  test('positions boundary and bar anchors, clamps the first edge, filters the window, and packs icons by spacing', () => {
    const groups = [
      group({ targetIdx: 0, anchor: 'boundary' }),
      group({ targetIdx: 2, anchor: 'bar' }),
      group({ targetIdx: 3, anchor: 'bar' }),
      group({ targetIdx: 5, anchor: 'boundary' }),
      group({ targetIdx: 9, anchor: 'bar' }),
    ]
    const items = bandItemsOf(groups, { shownFrom: 0, shownTo: 3, leftPad: 0 })
    assert.deepEqual(items.map(i => [i.group.targetIdx, i.x, i.maxIcons]), [
      [0, -1, 3],
      [2, 39, 1],
      [3, 55, 1],
    ])
    assert.equal(items[0].align, 'start')
    assert.equal(items[1].align, undefined)
    const isolated = bandItemsOf([group({ targetIdx: 9, anchor: 'bar' })], { shownFrom: 0, shownTo: 10, leftPad: 0 })
    assert.equal(isolated[0].x, 151)
    assert.equal(isolated[0].maxIcons, 3)
  })

  test('a virtualized left pad keeps global positions while the window shrinks', () => {
    const items = bandItemsOf([
      group({ targetIdx: 2, anchor: 'boundary' }),
      group({ targetIdx: 3, anchor: 'bar' }),
    ], { shownFrom: 2, shownTo: 3, leftPad: 30 })
    assert.deepEqual(items.map(i => [i.group.targetIdx, i.x, i.maxIcons]), [[2, 31, 1], [3, 55, 1]])
  })

  test('merges a boundary event and a bar metric on the same step into one mast', () => {
    const items = bandItemsOf([
      group({ targetIdx: 1, anchor: 'boundary' }),
      group({
        targetIdx: 1,
        anchor: 'bar',
        leadKind: 'longest',
        entries: [{ kind: 'longest', value: 10 }],
      }),
    ], { shownFrom: 0, shownTo: 2, leftPad: 0 })
    assert.equal(items.length, 1)
    const merged = items[0].group
    assert.equal(items[0].x, 15)
    assert.equal(merged.anchor, 'boundary')
    assert.deepEqual(merged.entries.map(entry => entry.kind), ['compaction', 'longest'])
    assert.equal(merged.count, 2)
    assert.equal(merged.members?.length, 2)
  })

  test('packs adjacent steps whose heads would overlap', () => {
    const items = bandItemsOf([
      group({ targetIdx: 0, anchor: 'bar', leadKind: 'longest', entries: [{ kind: 'longest', value: 10 }] }),
      group({ targetIdx: 1, anchor: 'boundary' }),
    ], { shownFrom: 0, shownTo: 2, leftPad: 0 })
    assert.equal(items.length, 1)
    assert.equal(items[0].x, 15)
    assert.equal(items[0].group.targetIdx, 1)
    assert.equal(items[0].group.count, 2)
    assert.deepEqual(items[0].group.entries.map(entry => entry.kind), ['compaction', 'longest'])
  })

  test('packs a leading bar metric with a later boundary event', () => {
    const items = bandItemsOf([
      group({ targetIdx: 0, anchor: 'bar', leadKind: 'growth', entries: [{ kind: 'growth', value: 10 }] }),
      group({ targetIdx: 1, anchor: 'boundary', leadKind: 'model', entries: [{ kind: 'model', events: [ev({ kind: 'model' })] }] }),
    ], { shownFrom: 0, shownTo: 2, leftPad: 0 })
    assert.equal(items.length, 1)
    assert.equal(items[0].x, 7)
    assert.equal(items[0].align, 'start')
    assert.equal(items[0].group.targetIdx, 0)
    assert.deepEqual(items[0].group.entries.map(entry => entry.kind), ['growth', 'model'])
  })
})

describe('fitBandItemsOf', () => {
  test('maps fractions to pixels, clamps the edge, and returns nothing before the pane is measured', () => {
    assert.deepEqual(fitBandItemsOf([group({ targetIdx: 0, anchor: 'boundary' })], 0, 10), [])
    const items = fitBandItemsOf([
      group({ targetIdx: 10, anchor: 'bar', leadKind: 'longest', entries: [{ kind: 'longest', value: 1 }] }),
      group({ targetIdx: 0, anchor: 'boundary' }),
      group({ targetIdx: 5, anchor: 'bar', leadKind: 'growth', entries: [{ kind: 'growth', value: 1 }] }),
    ], 100, 10)
    assert.deepEqual(items.map(i => [i.group.targetIdx, i.x, i.maxIcons]), [
      [0, 0, 3],
      [5, 50, 3],
      [10, 100, 3],
    ])
    assert.deepEqual(items.map(i => i.align), ['start', undefined, 'end'])
  })

  test('clusters nearby groups, merges repeated kinds, and keeps the highest-priority representative', () => {
    const items = fitBandItemsOf([
      group({
        targetIdx: 2,
        anchor: 'boundary',
        leadKind: 'compaction',
        entries: [{ kind: 'compaction', events: [ev({ kind: 'compaction', tokens: 10 })] }],
        count: 1,
      }),
      group({
        targetIdx: 3,
        anchor: 'boundary',
        leadKind: 'prune',
        entries: [{ kind: 'prune', events: [ev({ kind: 'prune' })] }],
        count: 1,
      }),
      group({
        targetIdx: 5,
        anchor: 'boundary',
        leadKind: 'spawn',
        entries: [{ kind: 'spawn', events: [ev({ kind: 'agent', name: 'worker' })] }],
        count: 1,
      }),
    ], 100, 10)
    assert.equal(items.length, 2)
    const cluster = items[0].group
    assert.equal(items[0].x, 20)
    assert.equal(items[0].maxIcons, 1)
    assert.deepEqual(cluster.entries.map(entry => entry.kind), ['compaction', 'prune'])
    assert.equal(cluster.leadKind, 'compaction')
    assert.equal(cluster.targetSeq, 3)
    assert.equal(cluster.count, 2)
    assert.equal(cluster.anchor, 'boundary')
    assert.equal(cluster.members?.length, 2)
    assert.equal(items[1].group.targetIdx, 5)
    assert.equal(items[1].x, 45)
  })

  test('merges duplicate event rows, collapses duplicate metric rows, and carries the anchor shape', () => {
    const items = fitBandItemsOf([
      group({
        targetIdx: 1,
        anchor: 'boundary',
        leadKind: 'skill',
        entries: [{ kind: 'skill', events: [ev({ kind: 'inject', sub: 'skill', name: 'a' }), ev({ kind: 'inject', sub: 'skill', name: 'b' })] }],
        count: 2,
      }),
      group({
        targetIdx: 1,
        anchor: 'boundary',
        leadKind: 'skill',
        entries: [{ kind: 'skill', events: [ev({ kind: 'inject', sub: 'skill', name: 'c' })] }],
        count: 1,
      }),
      group({
        targetIdx: 1,
        anchor: 'bar',
        leadKind: 'longest',
        entries: [{ kind: 'longest', value: 20 }],
      }),
    ], 100, 10)
    assert.equal(items.length, 1)
    const cluster = items[0].group
    assert.deepEqual(cluster.entries.map(entry => entry.kind), ['longest', 'skill'])
    assert.equal(cluster.leadKind, 'longest')
    assert.equal(cluster.targetIdx, 1)
    assert.equal(cluster.count, 4)
    assert.equal(cluster.anchor, 'boundary')
    assert.ok(isMetricEntry(cluster.entries[0]))
    const skill = cluster.entries[1]
    assert.ok(!isMetricEntry(skill) && skill.events.length === 3)

    const metrics = fitBandItemsOf([
      group({ targetIdx: 1, anchor: 'bar', leadKind: 'longest', entries: [{ kind: 'longest', value: 20 }] }),
      group({ targetIdx: 1, anchor: 'bar', leadKind: 'longest', entries: [{ kind: 'longest', value: 10 }] }),
    ], 100, 10)
    assert.equal(metrics.length, 1)
    assert.equal(metrics[0].group.anchor, 'bar')
    assert.equal(metrics[0].group.entries.length, 1)
    assert.equal(metrics[0].group.count, 2)
  })

  test('spaces two clusters for two icons and a lone cluster for three', () => {
    const pairs = fitBandItemsOf([
      group({ targetIdx: 0, anchor: 'bar', leadKind: 'longest', entries: [{ kind: 'longest', value: 1 }] }),
      group({ targetIdx: 3, anchor: 'bar', leadKind: 'growth', entries: [{ kind: 'growth', value: 1 }] }),
    ], 100, 10)
    assert.deepEqual(pairs.map(item => item.maxIcons), [2, 2])
    const lone = fitBandItemsOf([
      group({ targetIdx: 3, anchor: 'bar', leadKind: 'growth', entries: [{ kind: 'growth', value: 1 }] }),
    ], 100, 10)
    assert.equal(lone[0].maxIcons, 3)
  })
})
