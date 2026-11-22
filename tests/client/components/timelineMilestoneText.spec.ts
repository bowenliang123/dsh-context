import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { makeKit } from '../helpers/kit'
import type { MilestoneEventEntry, MilestoneGroup } from '../../../src/client/components/timelineMilestones'
import { milestoneEntryRows, milestoneLabel, milestoneTipRows } from '../../../src/client/components/timelineMilestoneText'

const kit = makeKit()

function spawn(name: string, seq = 1): ContextEventRecord {
  return { seq, time: seq, kind: 'agent', form: 'spawn', name }
}

function req(): RequestRecord {
  return {
    seq: 1,
    time: 1,
    turn: 1,
    step: 2,
    system: 10,
    tools: 0,
    user: 0,
    inject: 0,
    assistant: 0,
    tool: 0,
    total: 100,
  }
}

function group(entries: MilestoneEventEntry[]): MilestoneGroup {
  return {
    key: 'b:1',
    targetIdx: 1,
    targetSeq: 2,
    targetTurn: 1,
    anchor: 'boundary',
    leadKind: entries[0].kind,
    entries,
  }
}

describe('milestone entry rows', () => {
  test('a multi-spawn row separates the count from the complete name list', () => {
    const entry: MilestoneEventEntry = {
      kind: 'spawn',
      events: ['fold-specialist', 'reviewer', 'explorer', 'worker', 'runner'].map((name, i) => spawn(name, i + 1)),
    }
    assert.deepEqual(milestoneEntryRows(kit, 'step', entry), [
      'Subagent created · ×5',
      'fold-specialist, reviewer, explorer, worker, runner',
    ])
  })

  test('a single spawn keeps its name on the label row', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', { kind: 'spawn', events: [spawn('explorer')] }),
      ['Subagent created · explorer'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', { kind: 'spawn', events: [spawn('a'), spawn('b')] }),
      ['Subagent created · ×2', 'a, b'],
    )
  })

  test('goal and team-task completion rows list every name after the count', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'goal-create',
        events: [
          { seq: 1, time: 1, kind: 'goal-create', name: 'Ship the redesign', count: 1 },
          { seq: 2, time: 2, kind: 'goal-create', name: 'Polish the docs', count: 1 },
        ],
      }),
      [kit.t('timeline.ms.goal-create') + ' · ×2', 'Ship the redesign, Polish the docs'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'team-task-complete',
        events: [{ seq: 1, time: 1, kind: 'team-task-complete', name: 'Build the parser', count: 1 }],
      }),
      [kit.t('timeline.ms.team-task-complete') + ' · Build the parser'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'goal-create',
        events: [
          { seq: 1, time: 1, kind: 'goal-create', count: 1 },
          { seq: 2, time: 2, kind: 'goal-create', count: 1 },
        ],
      }),
      [kit.t('timeline.ms.goal-create') + ' · ×2'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'goal-complete',
        events: [{ seq: 1, time: 1, kind: 'goal-complete', count: 1 }],
      }),
      [kit.t('timeline.ms.goal-complete')],
    )
  })

  test('todo-add and team-task-create rows show only their counts', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-add',
        events: [{ seq: 1, time: 1, kind: 'todo-add', count: 3 }],
      }),
      [kit.t('timeline.ms.todo-add') + ' · ×3'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-add',
        events: [{ seq: 1, time: 1, kind: 'todo-add', count: 1 }],
      }),
      [kit.t('timeline.ms.todo-add')],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-add',
        events: [
          { seq: 1, time: 1, kind: 'todo-add', count: 1 },
          { seq: 2, time: 2, kind: 'todo-add', count: 1 },
        ],
      }),
      [kit.t('timeline.ms.todo-add') + ' · ×2'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-add',
        events: [{ seq: 1, time: 1, kind: 'todo-add' }],
      }),
      [kit.t('timeline.ms.todo-add')],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'team-task-create',
        events: [{ seq: 1, time: 1, kind: 'team-task-create', count: 1 }],
      }),
      [kit.t('timeline.ms.team-task-create')],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'team-task-create',
        events: [
          { seq: 1, time: 1, kind: 'team-task-create', count: 1 },
          { seq: 2, time: 2, kind: 'team-task-create', count: 1 },
        ],
      }),
      [kit.t('timeline.ms.team-task-create') + ' · ×2'],
    )
  })

  test('todo-done and ask rows sum their counts and mark names beyond the stored list', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [{ seq: 1, time: 1, kind: 'todo-done', items: ['a'] }],
      }),
      [kit.t('timeline.ms.todo-done') + ' · a'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [{ seq: 1, time: 1, kind: 'todo-done', count: 1, items: [], name: 'only' }],
      }),
      [kit.t('timeline.ms.todo-done') + ' · only'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [
          { seq: 1, time: 1, kind: 'todo-done', count: 1, items: ['a'], name: 'a' },
          { seq: 2, time: 2, kind: 'todo-done', count: 1, items: ['b'], name: 'b' },
        ],
      }),
      [kit.t('timeline.ms.todo-done') + ' · ×2', 'a, b'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [{ seq: 1, time: 1, kind: 'todo-done', count: 2, items: [] }],
      }),
      [kit.t('timeline.ms.todo-done') + ' · ×2', '+2'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [{ seq: 1, time: 1, kind: 'todo-done', count: 5, items: ['a', 'b', 'c'], name: 'a' }],
      }),
      [kit.t('timeline.ms.todo-done') + ' · ×5', 'a, b, c +2'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'todo-done',
        events: [
          { seq: 1, time: 1, kind: 'todo-done', count: 1, items: ['a'], name: 'a' },
          { seq: 2, time: 2, kind: 'todo-done', count: 1, items: ['a'], name: 'a' },
        ],
      }),
      [kit.t('timeline.ms.todo-done') + ' · ×2', 'a +1'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'ask',
        events: [{ seq: 1, time: 1, kind: 'ask' }],
      }),
      [kit.t('timeline.ms.ask')],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'ask',
        events: [{ seq: 1, time: 1, kind: 'ask', count: 1 }],
      }),
      [kit.t('timeline.ms.ask')],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'ask',
        events: [{ seq: 1, time: 1, kind: 'ask', count: 2, items: ['Which one?', 'And when?'], name: 'Which one?' }],
      }),
      [kit.t('timeline.ms.ask') + ' · ×2', 'Which one?, And when?'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'ask',
        events: [{ seq: 1, time: 1, kind: 'ask', count: 1, items: ['Why?'], name: 'Why?' }],
      }),
      [kit.t('timeline.ms.ask') + ' · Why?'],
    )
  })

  test('agent and skill lists keep their own name fields; empty names fall back to the count row', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [
          { seq: 1, time: 1, kind: 'inject', agent: 'standards-review' },
          { seq: 2, time: 2, kind: 'inject', agent: 'spec-review' },
        ],
      }),
      [kit.t('timeline.ms.agent') + ' · ×2', 'standards-review, spec-review'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'skill',
        events: [
          { seq: 1, time: 1, kind: 'inject', sub: 'skill', name: 'code-review' },
          { seq: 2, time: 2, kind: 'inject', sub: 'skill', name: 'tdd' },
        ],
      }),
      ['Skill · ×2', 'code-review, tdd'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'spawn',
        events: [
          { seq: 1, time: 1, kind: 'agent', form: 'spawn' },
          { seq: 2, time: 2, kind: 'agent', form: 'spawn' },
        ],
      }),
      ['Subagent created · ×2'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', { kind: 'skill', events: [{ seq: 1, time: 1, kind: 'inject' }] }),
      ['Skill'],
    )
  })

  test('agent interactions name what happened: message, team message, settled, or reference', () => {
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [{ seq: 1, time: 1, kind: 'inject', name: 'agent-message', agent: 'explorer' }],
      }),
      [kit.t('timeline.ms.agentMessage') + ' · explorer'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [{ seq: 1, time: 1, kind: 'inject', name: 'team-message', agent: 'worker' }],
      }),
      [kit.t('timeline.ms.agentTeam') + ' · worker'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [{ seq: 1, time: 1, kind: 'inject', name: 'subagent-settled', agent: 'dataplane-specialist' }],
      }),
      [kit.t('timeline.ms.agentDone') + ' · dataplane-specialist'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [{ seq: 1, time: 1, kind: 'inject', name: 'session-reference', agent: 'Alpha' }],
      }),
      [kit.t('timeline.ms.agentRef') + ' · Alpha'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [
          { seq: 1, time: 1, kind: 'inject', name: 'agent-message', agent: 'a' },
          { seq: 2, time: 2, kind: 'inject', name: 'team-message', agent: 'b' },
        ],
      }),
      [kit.t('timeline.ms.agent') + ' · ×2', 'a, b'],
    )
    assert.deepEqual(
      milestoneEntryRows(kit, 'step', {
        kind: 'agent',
        events: [
          { seq: 1, time: 1, kind: 'inject', name: 'subagent-settled', agent: 'a' },
          { seq: 2, time: 2, kind: 'inject', name: 'subagent-settled', agent: 'b' },
        ],
      }),
      [kit.t('timeline.ms.agentDone') + ' · ×2', 'a, b'],
    )
  })
})

describe('milestone tip rows', () => {
  test('the tip flattens entry rows between the step head and the hint', () => {
    const entries: MilestoneEventEntry[] = [
      { kind: 'spawn', events: ['a', 'b', 'c', 'd', 'e'].map((name, i) => spawn(name, i + 1)) },
      { kind: 'compaction', events: [{ seq: 6, time: 6, kind: 'compaction', count: 2, tokens: 120 }] },
    ]
    const rows = milestoneTipRows(kit, { granularity: 'step', stepsOf: () => 5 }, group(entries), req())
    assert.deepEqual(rows, [
      kit.t('tip.step', { t: 1, s: 2, n: 5 }),
      'Subagent created · ×5',
      'a, b, c, d, e',
      'Compacted · −' + kit.fmt(120),
      kit.t('timeline.ms.open'),
    ])
    assert.equal(milestoneLabel(kit, { granularity: 'step', stepsOf: () => 5 }, group(entries), req()), rows.join('. '))
  })

  test('a cluster across targets says so under the head', () => {
    const entries: MilestoneEventEntry[] = [
      { kind: 'compaction', events: [{ seq: 6, time: 6, kind: 'compaction', count: 2, tokens: 120 }] },
    ]
    const clustered = {
      ...group(entries),
      targetIdx: 3,
      targetSeq: 4,
      members: [group(entries), { ...group(entries), targetIdx: 3, targetSeq: 4 }],
    }
    assert.deepEqual(milestoneTipRows(kit, { granularity: 'step', stepsOf: () => 5 }, clustered, req()), [
      kit.t('tip.step', { t: 1, s: 2, n: 5 }),
      kit.t('timeline.ms.cluster'),
      'Compacted · −' + kit.fmt(120),
      kit.t('timeline.ms.open'),
    ])
  })

  test('a long merged name list is capped with a remainder', () => {
    const names = Array.from({ length: 26 }, (_, i) => 'agent-' + String(i))
    const rows = milestoneEntryRows(kit, 'step', {
      kind: 'spawn',
      events: names.map((name, i) => spawn(name, i + 1)),
    })
    assert.equal(rows[0], 'Subagent created · ×26')
    assert.equal(rows[1], names.slice(0, 24).join(', ') + ' +2')
  })
})
