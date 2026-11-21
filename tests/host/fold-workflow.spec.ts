import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { applyWorkflowEvent } from '../../src/host/foldWorkflow'
import { at, header, toolCall } from './helpers/events'
import { assertStable, driveTimeline, timelineDef } from './helpers/projection'

const event = (type: string, seq: number, data?: Record<string, unknown>): TimelineEvent =>
  ({ type, seq, time: at(), ...(data === undefined ? {} : { data }) })

const goal = (seq: number, operation: unknown, objective?: unknown, extra: Record<string, unknown> = {}): TimelineEvent =>
  event('goal/change', seq, { operation, goal: { objective, ...extra } })

const todos = (seq: number, items: unknown): TimelineEvent =>
  event('todo/write', seq, { todos: items })

const task = (seq: number, value: Record<string, unknown>): TimelineEvent =>
  event('team/task', seq, { task: value })

describe('workflow context events', () => {
  test('unknown workflow events have no application', () => {
    assert.equal(applyWorkflowEvent(driveTimeline([]).state, event('session/end', 1)), undefined)
  })

  test('goal create and complete emit one milestone with the objective', () => {
    const drive = driveTimeline([
      goal(1, 'create', '  Ship the redesign  ', { phase: 'active' }),
      goal(2, 'complete', 'Ship the redesign', { phase: 'complete' }),
    ]).state
    assert.deepEqual(drive.events, [
      { seq: 1, time: drive.events[0].time, kind: 'goal-create', name: 'Ship the redesign', count: 1 },
      { seq: 2, time: drive.events[1].time, kind: 'goal-complete', name: 'Ship the redesign', count: 1 },
    ])
    assert.equal(drive.totals?.events, 2)
  })

  test('goal changes outside create and complete, or without an objective, are stable', () => {
    const state = driveTimeline([]).state
    for (const ev of [
      goal(1, 'clear', 'x'),
      goal(1, 'pause', 'x'),
      goal(1, 'create'),
      goal(1, 'create', '   '),
      goal(1, 'create', 7),
      event('goal/change', 1),
      event('goal/change', 1, { operation: 'create', goal: null }),
    ]) assertStable(state, ev)
  })

  test('goal objectives are bounded', () => {
    const state = driveTimeline([goal(1, 'create', 'a'.repeat(200))]).state
    assert.equal(state.events[0].name?.length, 120)
    assert.ok(state.events[0].name?.endsWith('…'))
  })

  test('the first todo snapshot adds every item once', () => {
    const state = driveTimeline([
      todos(1, [
        { content: 'first', status: 'pending' },
        { content: 'second', status: 'in_progress' },
        { content: 'third', status: 'completed' },
      ]),
    ]).state
    assert.deepEqual(state.todoItems, { first: 'pending', second: 'in_progress', third: 'completed' })
    assert.deepEqual(state.events.map(ev => ev.kind), ['todo-add'])
    assert.equal(state.events[0].count, 3)
    assert.ok(!('items' in state.events[0]))
    assert.ok(!('name' in state.events[0]))
  })

  test('an unchanged todo snapshot returns the same state', () => {
    const def = timelineDef()
    const state = driveTimeline([
      todos(1, [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
    ]).state
    assertStable(state, todos(2, [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]), def)
    const reordered = driveTimeline([
      todos(1, [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
      todos(2, [{ content: 'b', status: 'pending' }, { content: 'a', status: 'pending' }]),
    ]).state
    assert.equal(reordered.events.length, 1)
    assert.equal(reordered.totals?.events, 1)
  })

  test('todo transitions add before done and keep unrelated status shifts quiet', () => {
    const state = driveTimeline([
      todos(1, [
        { content: 'a', status: 'pending' },
        { content: 'b', status: 'pending' },
        { content: 'c', status: 'completed' },
      ]),
      todos(2, [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'pending' },
      ]),
      todos(3, [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'completed' },
        { content: 'd', status: 'completed' },
      ]),
    ]).state
    assert.deepEqual(state.events.slice(1).map(ev => [ev.kind, ev.count]), [
      ['todo-add', 1],
      ['todo-done', 1],
      ['todo-done', 1],
    ])
    assert.deepEqual(state.events[2].items, ['b'])
    assert.deepEqual(state.events[3].items, ['d'])
    assert.deepEqual(state.todoItems, { a: 'in_progress', b: 'completed', c: 'completed', d: 'completed' })
  })

  test('removing todos updates the map without a milestone', () => {
    const state = driveTimeline([
      todos(1, [{ content: 'a', status: 'pending' }, { content: 'b', status: 'pending' }]),
      todos(2, [{ content: 'a', status: 'pending' }]),
      todos(3, []),
    ]).state
    assert.deepEqual(state.events.map(ev => ev.kind), ['todo-add'])
    assert.deepEqual(state.todoItems, {})
    assert.equal(state.totals?.events, 1)
  })

  test('a pure status shift updates the map without a milestone', () => {
    const state = driveTimeline([
      todos(1, [{ content: 'a', status: 'pending' }]),
      todos(2, [{ content: 'a', status: 'in_progress' }]),
    ]).state
    assert.deepEqual(state.events.map(ev => ev.kind), ['todo-add'])
    assert.deepEqual(state.todoItems, { a: 'in_progress' })
    assert.equal(state.totals?.events, 1)
  })

  test('malformed todo entries are skipped and large batches are bounded', () => {
    const malformed = driveTimeline([
      todos(1, [
        null,
        'x',
        { content: '', status: 'pending' },
        { content: 'a', status: 'done' },
        { content: 'b', status: 'pending' },
      ]),
    ]).state
    assert.deepEqual(malformed.todoItems, { b: 'pending' })
    const many = Array.from({ length: 130 }, (_, i) => ({ content: 'item-' + String(i), status: 'pending' }))
    const capped = driveTimeline([todos(1, many)]).state
    assert.equal(Object.keys(capped.todoItems ?? {}).length, 128)
    assert.equal(capped.events[0].count, 128)
    assert.ok(!('items' in capped.events[0]))
    const nine = Array.from({ length: 9 }, (_, i) => ({ content: 'n-' + String(i), status: 'pending' }))
    const batch = driveTimeline([todos(1, nine)]).state
    assert.equal(batch.events[0].count, 9)
    assert.ok(!('items' in batch.events[0]))
    const state = driveTimeline([]).state
    for (const ev of [
      todos(1, undefined),
      todos(1, {}),
      todos(1, []),
      event('todo/write', 1),
    ]) assertStable(state, ev)
  })

  test('team tasks emit create then complete exactly once', () => {
    const drive = driveTimeline([
      task(1, { id: 't1', subject: '  Build the parser  ', status: 'pending' }),
      task(2, { id: 't1', subject: 'Build the parser', status: 'pending' }),
      task(3, { id: 't1', subject: 'Build the parser', status: 'in_progress' }),
      task(4, { id: 't1', subject: 'Build the parser', status: 'completed' }),
      task(5, { id: 't1', subject: 'Build the parser', status: 'completed' }),
    ]).state
    assert.deepEqual(drive.events.map(ev => [ev.kind, ev.name]), [
      ['team-task-create', undefined],
      ['team-task-complete', 'Build the parser'],
    ])
    assert.deepEqual(drive.teamTasks, { t1: 'completed' })
    const def = timelineDef()
    assertStable(drive, task(6, { id: 't1', subject: 'Build the parser', status: 'completed' }), def)
  })

  test('deleted tasks stay silent and rejoining creates anew', () => {
    const drive = driveTimeline([
      task(1, { id: 't1', subject: 'one', status: 'pending' }),
      task(2, { id: 't1', subject: 'one', status: 'deleted' }),
      task(3, { id: 't1', subject: 'one', status: 'pending' }),
      task(4, { id: 'ghost', subject: 'gone', status: 'deleted' }),
    ]).state
    assert.deepEqual(drive.events.map(ev => ev.kind), ['team-task-create', 'team-task-create'])
    assert.deepEqual(drive.teamTasks, { t1: 'pending' })
    const state = driveTimeline([]).state
    for (const ev of [
      task(1, { id: '', subject: 'x', status: 'pending' }),
      task(1, { id: '__proto__', subject: 'x', status: 'pending' }),
      task(1, { id: 't', subject: '   ', status: 'pending' }),
      task(1, { id: 't', subject: 'x', status: 'done' }),
      task(1, { id: 't', subject: 'x' }),
      event('team/task', 1),
      event('team/task', 1, { task: null }),
    ]) assertStable(state, ev)
  })

  test('team task ids and names are bounded, and the board is capped', () => {
    const long = 'x'.repeat(200)
    const clipped = driveTimeline([
      task(1, { id: long, subject: long, status: 'pending' }),
      task(2, { id: long, subject: long, status: 'completed' }),
    ]).state
    assert.equal(clipped.events[1].name?.length, 120)
    assert.equal(Object.keys(clipped.teamTasks ?? {})[0].length, 120)
    const events: TimelineEvent[] = []
    for (let i = 0; i < 258; i++) {
      events.push(task(i + 1, { id: 't-' + String(i), subject: 's', status: 'pending' }))
    }
    const capped = driveTimeline(events).state
    assert.equal(Object.keys(capped.teamTasks ?? {}).length, 256)
    assert.equal(capped.teamTasks?.['t-0'], undefined)
    assert.equal(capped.teamTasks?.['t-257'], 'pending')
    assert.ok(timelineDef().stateSchema.safeParse(capped).success)
  })

  test('ask_user_question calls record the question texts', () => {
    const questions = Array.from({ length: 10 }, (_, i) => ({ id: 'q' + String(i), question: 'Question ' + String(i) }))
    const state = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'ask_user_question', arguments: JSON.stringify({ questions }) }),
    ]).state
    assert.deepEqual(state.events.map(ev => ev.kind), ['ask'])
    assert.equal(state.events[0].count, 10)
    assert.equal(state.events[0].items?.length, 8)
    assert.equal(state.events[0].name, 'Question 0')
  })

  test('ask events accept object arguments and skip unusable calls', () => {
    const objectArgs = driveTimeline([
      event('tool/call', 1, {
        callId: 'c1', name: 'ask_user_question',
        arguments: { questions: [{ question: 'Pick one' }, { question: '' }, null] },
      }),
    ]).state
    assert.deepEqual(objectArgs.events[0].items, ['Pick one'])
    assert.equal(objectArgs.events[0].count, 1)
    const state = driveTimeline([]).state
    for (const ev of [
      toolCall(1, { callId: 'c1', name: 'ask_user_question', arguments: '{bad' }),
      toolCall(1, { callId: 'c1', name: 'ask_user_question', arguments: '{"questions":[]}' }),
      toolCall(1, { callId: 'c1', name: 'ask_user_question', arguments: '{"questions":[null]}' }),
      toolCall(1, { callId: 'c1', name: 'other', arguments: '{"questions":[{"question":"x"}]}' }),
      event('tool/call', 1, { callId: 'c1', name: 'ask_user_question' }),
    ]) {
      assert.equal(timelineDef().apply(state, ev).events.length, 0)
    }
    assertStable(state, event('tool/call', 1, { name: 'ask_user_question', arguments: '{"questions":[{"question":"x"}]}' }))
  })

  test('head-only folds keep the transition maps and cumulative count', () => {
    const head = driveTimeline([
      todos(1, [{ content: 'a', status: 'pending' }]),
      task(2, { id: 't1', subject: 'one', status: 'pending' }),
      toolCall(3, { callId: 'c1', name: 'ask_user_question', arguments: '{"questions":[{"question":"q"}]}' }),
      header(4, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
    ], undefined, true).state
    assert.equal(head.events.length, 0)
    assert.equal(head.totals?.events, 3)
    assert.deepEqual(head.todoItems, { a: 'pending' })
    assert.deepEqual(head.teamTasks, { t1: 'pending' })
    assert.ok(timelineDef().stateSchema.safeParse(head).success)
  })
})
