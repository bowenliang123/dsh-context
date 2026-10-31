import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineHead } from '../../src/host/fold'
import type { TimelineEvent } from '../../src/host/fold'
import { compactSurfaceNode, createTimelineState } from '../../src/host/foldState'
import { assistantMessage, codeDispatch, codeDispatchStart, compaction, header, jobRegistered, jobSettled, planMode, toolCall, toolResult, userMessage } from './helpers/events'
import { driveTimeline, timelineDef } from './helpers/projection'

function headDrive(events: TimelineEvent[]) {
  const def = timelineDef({}, true)
  let state = def.init()
  for (const ev of events) state = def.apply(state, ev)
  return state
}

function headDriveStates(events: TimelineEvent[]) {
  const def = timelineDef({}, true)
  let state = def.init()
  const states = [state]
  for (const ev of events) {
    state = def.apply(state, ev)
    states.push(state)
  }
  return states
}

describe('the head-only fold', () => {
  test('detail-only events keep the head compact but still bump the refetch revision', () => {
    const def = timelineDef({}, true)
    let state = def.apply(def.init(), toolCall(1, { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }))
    assert.equal(state.commands.length, 0)
    const called = state.detailRev ?? 0
    state = def.apply(state, jobRegistered(3, { callId: 'c1', startedAt: 1 }))
    assert.equal(state.detailRev, called + 1, 'a registered job signals the open command panel')
    state = def.apply(state, jobSettled(4, { callId: 'c1', finishedAt: 2, status: 'completed' }))
    assert.equal(state.detailRev, called + 2, 'a settled job signals it too')
    const beforeDispatch = state.detailRev
    state = def.apply(state, codeDispatchStart(5, { rootCallId: 'rc', subCallId: 'sub', name: 'bash', arguments: { command: 'ls' } }))
    state = def.apply(state, codeDispatch(6, { rootCallId: 'rc', subCallId: 'sub', name: 'bash', arguments: { command: 'ls' } }))
    assert.equal(state.detailRev, beforeDispatch, 'pending dispatch work waits for the flush signal')
    assert.equal(def.apply(state, jobRegistered(7, { startedAt: 1 })), state, 'a malformed job event stays inert')
    assert.equal(def.apply(state, jobSettled(8, { callId: 'c1', finishedAt: 'later', status: 'completed' })), state, 'a malformed finish stays inert')
    assert.equal(def.apply(state, jobSettled(9, { callId: 'c1', finishedAt: 1, status: 'other' })), state, 'an unknown status stays inert')
    const plain = def.apply(state, toolCall(10, { callId: 'c2', name: 'read', arguments: '{}' }))
    assert.equal(plain.detailRev, state.detailRev, 'a non-command call never refetches the command panel')
    const malformed = def.apply(plain, toolCall(11, { callId: 'c3', name: 'bash', arguments: '{}' }))
    assert.equal(malformed.commands.length, 0)
    state = def.apply(malformed, userMessage(12, [{ type: 'text', text: 'hi' }], { kind: 'user' }))
    assert.deepEqual(state.fileOps, [])
    assert.deepEqual(state.commands, [])
    assert.deepEqual(state.events, [])
    assert.deepEqual(state.spans, [])
    assert.deepEqual(state.requests.map(r => r.seq), [])
  })

  test('the head and full folds bump the detail revision on exactly the same events', () => {
    const log: TimelineEvent[] = [
      toolCall(1, { callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }),
      jobRegistered(2, { callId: 'c1', startedAt: 1 }),
      jobRegistered(3, { callId: 'ghost', startedAt: 1 }),
      jobSettled(4, { callId: 'ghost', finishedAt: 2, status: 'completed' }),
      toolCall(5, { callId: 'c2', name: 'read', arguments: '{}' }),
      codeDispatchStart(6, { rootCallId: 'rc', subCallId: 'sub', name: 'bash', arguments: { command: 'x' } }),
      codeDispatch(7, { rootCallId: 'rc', subCallId: 'sub', name: 'bash', arguments: { command: 'x' } }),
      toolResult(8, { callId: 'c2', content: [{ type: 'text', text: 'ok' }] }),
      userMessage(9, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(10, { turn: 1, step: 1 }),
      compaction(11, 'summary', { shadowedSeqs: [9] }),
      planMode(12, { active: true }),
      header(13, { model: 'deepseek-v4-pro', reason: 'change' }),
    ]
    const full = driveTimeline(log).states.map(state => state.detailRev ?? 0)
    const head = headDriveStates(log).map(state => state.detailRev ?? 0)
    assert.deepEqual(head, full)
  })

  test('a hostile skill name never pollutes the tally object', () => {
    const state = headDrive([
      userMessage(1, [{ type: 'text', text: 'x' }], { kind: 'skill-invocation', form: 'skill', name: '__proto__' }),
    ])
    assert.deepEqual(state.head.skills, {})
    assert.equal(Object.getPrototypeOf(state.head.skills), Object.prototype)
    assert.equal(state.head.injects, 1)
  })

  test('inherited Object property names keep numeric own-property counts', () => {
    const state = headDrive([
      userMessage(1, [{ type: 'text', text: 'a' }], { kind: 'skill-invocation', form: 'skill', name: 'constructor' }),
      userMessage(2, [{ type: 'text', text: 'b' }], { kind: 'skill-invocation', form: 'skill', name: 'constructor' }),
      userMessage(3, [{ type: 'text', text: 'c' }], { kind: 'skill-invocation', form: 'skill', name: 'toString' }),
    ])
    assert.deepEqual(state.head.skills, { constructor: 2, toString: 1 })
    assert.equal(buildTimelineHead(state).counts?.skills, 2)
    const evicted = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }], { kind: 'skill-invocation', form: 'skill', name: 'constructor' }),
      userMessage(2, [{ type: 'text', text: 'b' }], { kind: 'skill-invocation', form: 'skill', name: 'toString' }),
    ], { maxEvents: 1 }).state
    assert.deepEqual(evicted.head.skills, { toString: 1 }, 'evicting the own count removes the name')
  })

  test('a head fold with a shadowed surface removes nodes without archiving', () => {
    const state = headDrive([
      userMessage(1, [{ type: 'text', text: 'gone' }], { kind: 'user' }),
      compaction(2, 'prune', { shadowedSeqs: [1], shadowedTokenCount: 5 }),
      userMessage(3, [{ type: 'text', text: 'kept' }], { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [3])
    assert.deepEqual(state.archived, [])
  })

  test('compactSurfaceNode keeps only the head-relevant node fields', () => {
    const node = {
      seq: 1,
      cat: 'assistant' as const,
      tokens: 2,
      reasoning: 3,
      answerTokens: 4,
      callTokens: 5,
      imgs: 1,
      tool: 'bash',
      text: 'long',
      time: 10,
      form: 'x',
      name: 'n',
      skill: 's',
      calls: ['a'],
      err: true,
    }
    assert.deepEqual(compactSurfaceNode(node), {
      seq: 1,
      cat: 'assistant',
      tokens: 2,
      reasoning: 3,
      answerTokens: 4,
      callTokens: 5,
      imgs: 1,
      tool: 'bash',
    })
  })

  test('the head fold still tallies model switches, injections, and skill loads without their detail rows', () => {
    const state = headDrive([
      header(1, { model: 'deepseek-v4-flash' }),
      userMessage(2, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'notice', plugin: 'dsh-test', summary: 'note' }),
      header(3, { model: 'deepseek-v4-pro', reason: 'change' }),
      toolCall(4, { callId: 'c1', name: 'skill' }),
      toolResult(5, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="tdd">instructions</skill_content>' }] }),
    ])
    assert.equal(state.head.injects, 2)
    assert.deepEqual(state.head.skills, { tdd: 1 })
    assert.equal(state.head.events.length, 3)
    assert.ok((state.detailRev ?? 0) > 0)
  })

  test('a legacy row derives head counters for prune and skill events, and tolerates absent request/event arrays', () => {
    const full = driveTimeline([
      compaction(1, 'prune', { shadowedTokenCount: 1 }),
      userMessage(2, [{ type: 'text', text: 'skill' }], { kind: 'skill-invocation', form: 'skill', name: 'load' }),
      assistantMessage(3, { turn: 1, step: 1 }),
    ]).state
    const legacy = structuredClone(full) as unknown as Record<string, unknown>
    delete legacy.head
    const parsed = timelineDef({}, true).stateSchema.parse(legacy) as ReturnType<typeof createTimelineState>
    assert.deepEqual(buildTimelineHead(parsed).counts, { turns: 1, steps: 1, injects: 1, compactions: 0, prunes: 1, skills: 1 })
    const empty = structuredClone(full) as unknown as Record<string, unknown>
    delete empty.head
    delete empty.requests
    delete empty.events
    const bare = timelineDef({}, true).stateSchema.parse(empty) as ReturnType<typeof createTimelineState>
    assert.equal(buildTimelineHead(bare).counts?.steps, 0)
    assert.equal(buildTimelineHead(bare).counts?.prunes, 0)
  })
})
