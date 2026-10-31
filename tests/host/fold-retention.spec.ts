import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createTimelineState, trimToLastTurns } from '../../src/host/fold'
import type { RequestRecord } from '../../src/shared/types'
import { assistantMessage, compaction, planMode, userMessage } from './helpers/events'
import { assertStatesPlainJson, driveTimeline, timelineDef } from './helpers/projection'

function req(seq: number, turn?: number, step?: number): RequestRecord {
  const r: RequestRecord = { seq, time: seq * 1000, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 }
  if (turn !== undefined) r.turn = turn
  if (step !== undefined) r.step = step
  return r
}

describe('trimToLastTurns', () => {
  test('keeps the newest whole turn runs at and under the cap, turn-less runs always, preserving record identity', () => {
    const cases: { requests: RequestRecord[]; maxTurns: number; kept: number[] }[] = [
      { requests: [req(1), req(2), req(3)], maxTurns: 1, kept: [1, 2, 3] },
      { requests: [req(1), req(2), req(3, 1)], maxTurns: 1, kept: [3] },
      { requests: [req(1, 1), req(2, 1), req(3, 2)], maxTurns: 2, kept: [1, 2, 3] },
      { requests: [req(1, 1), req(2, 1), req(3, 2), req(4, 2), req(5, 3), req(6, 3)], maxTurns: 2, kept: [3, 4, 5, 6] },
    ]
    for (const { requests, maxTurns, kept } of cases) {
      assert.deepEqual(trimToLastTurns(requests, maxTurns).map(r => r.seq), kept, `cap ${maxTurns} over ${requests.length} records`)
    }
    assert.deepEqual(trimToLastTurns([], 2), [])
    const straddling = [req(1, 1), req(2, 2), req(3, 2), req(4, 2), req(5, 3)]
    const kept = trimToLastTurns(straddling, 2)
    assert.deepEqual(kept.map(r => r.seq), [2, 3, 4, 5])
    assert.equal(kept[0], straddling[1], 'a slice keeps record identity')
  })
})

describe('trimState request/event bounds', () => {
  test('the turn-run trim fires when the run count crosses the cap, under the step cap', () => {
    const drive = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      assistantMessage(2, { turn: 2, step: 1 }),
      assistantMessage(3, { turn: 3, step: 1 }),
    ], { maxKeptTurns: 2, maxRequestSteps: 10 })
    assert.deepEqual(drive.state.requests.map(r => r.seq), [2, 3])
    assertStatesPlainJson(drive)
  })

  test('maxRequestSteps is the hard backstop for a pathological many-step turn', () => {
    const drive = driveTimeline(
      [1, 2, 3, 4, 5].map(i => assistantMessage(i, { turn: 1, step: i })),
      { maxKeptTurns: 10, maxRequestSteps: 3 },
    )
    assert.deepEqual(drive.state.requests.map(r => r.seq), [3, 4, 5])
  })

  test('the head turn window follows the retained steps when maxRequestSteps cuts across turns', () => {
    const turns = driveTimeline(
      [1, 2, 3, 4, 5].map(i => assistantMessage(i, { turn: i, step: 1 })),
      { maxKeptTurns: 10, maxRequestSteps: 3 },
    )
    assert.equal(turns.state.head.turns, 3, 'only the turns represented by the retained steps count')
    assert.equal(turns.state.head.steps, 3)
    const straddling = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      assistantMessage(2, { turn: 1, step: 2 }),
      assistantMessage(3, { turn: 2, step: 1 }),
      assistantMessage(4, { turn: 2, step: 2 }),
    ], { maxKeptTurns: 10, maxRequestSteps: 3 })
    assert.equal(straddling.state.head.turns, 2, 'a partially retained turn still counts once')
    assert.equal(straddling.state.head.steps, 3)
  })

  test('maxEvents keeps the newest tail', () => {
    const drive = driveTimeline([
      planMode(1, { active: true }),
      planMode(2, { active: false }),
      planMode(3, { active: true }),
      planMode(4, { active: false }),
      planMode(5, { active: true }),
    ], { maxEvents: 3 })
    assert.deepEqual(drive.state.events.map(e => e.seq), [3, 4, 5])
  })

  test('the head event window evicts kind tallies and distinct skill names with the ring', () => {
    const skills = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }], { kind: 'skill-invocation', form: 'skill', name: 'a' }),
      userMessage(2, [{ type: 'text', text: 'b' }], { kind: 'skill-invocation', form: 'skill', name: 'b' }),
    ], { maxEvents: 1 })
    assert.deepEqual(skills.state.head.skills, { b: 1 })
    assert.equal(skills.state.head.injects, 1)
    const repeated = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }], { kind: 'skill-invocation', form: 'skill', name: 'a' }),
      userMessage(2, [{ type: 'text', text: 'a' }], { kind: 'skill-invocation', form: 'skill', name: 'a' }),
      userMessage(3, [{ type: 'text', text: 'b' }], { kind: 'skill-invocation', form: 'skill', name: 'b' }),
    ], { maxEvents: 2 })
    assert.deepEqual(repeated.state.head.skills, { a: 1, b: 1 }, 'an evicted duplicate decrements its ref without dropping the name')
    const prunes = driveTimeline([
      compaction(1, 'prune', { shadowedTokenCount: 1 }),
      planMode(2, { active: false }),
    ], { maxEvents: 1 })
    assert.equal(prunes.state.head.prunes, 0)
    const compactions = driveTimeline([
      compaction(1, 'summary', { shadowedSeqs: [] }),
      planMode(2, { active: false }),
    ], { maxEvents: 1 })
    assert.equal(compactions.state.head.compactions, 0)
  })
})

describe('the incremental turnRuns ledger', () => {
  test('counts turn runs exactly like a full scan, including a turn-less first record', () => {
    const drive = driveTimeline([
      assistantMessage(1, {}),
      assistantMessage(2, { turn: 1, step: 1 }),
      assistantMessage(3, { turn: 1, step: 2 }),
      assistantMessage(4, { turn: 2, step: 1 }),
      assistantMessage(5, { turn: 2, step: 2 }),
    ])
    assert.equal(drive.state.turnRuns, 2)
    assertStatesPlainJson(drive)
  })

  test('a restored row folded before the field existed recomputes its base once', () => {
    const def = timelineDef()
    let state = def.apply(def.init(), assistantMessage(1, { turn: 1, step: 1 }))
    state = def.apply(state, assistantMessage(2, { turn: 1, step: 2 }))
    delete (state as { turnRuns?: unknown }).turnRuns
    const pushed = def.apply(state, assistantMessage(3, { turn: 2, step: 1 }))
    assert.equal(pushed.turnRuns, 2)
    const trimmed = def.apply(state, planMode(4, { active: true }))
    assert.equal(trimmed.turnRuns, 1)
  })
})

describe('trimState archive pruning', () => {
  test('removals at or before the oldest retained request are dropped, recording archiveFloor', () => {
    const drive = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      compaction(2, 'prune', { shadowedSeqs: [1], shadowedTokenCount: 9 }),
      assistantMessage(3, { turn: 1, step: 2, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
      assistantMessage(4, { turn: 2, step: 1 }),
      assistantMessage(5, { turn: 3, step: 1 }),
    ], { maxKeptTurns: 2 })
    assert.equal(drive.states[4].archived.length, 1, 'the removal postdates the oldest retained request: kept')
    assert.deepEqual(drive.state.requests.map(r => r.seq), [4, 5], 'the request trim opens the pruning window')
    assert.equal(drive.state.archived.length, 0, 'gone 3 <= oldest retained request seq 4')
    assert.equal(drive.state.archiveFloor, 3, 'the floor names the newest dropped removal')
    assertStatesPlainJson(drive)
  })

  test('maxArchiveNodes keeps the newest removals; repeat drops max the floor with the existing one', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      compaction(2, 'prune', { shadowedSeqs: [1], shadowedTokenCount: 9 }),
      userMessage(3, [{ type: 'text', text: 'b' }], undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
      userMessage(4, [{ type: 'text', text: 'cccc' }]),
      compaction(5, 'prune', { shadowedSeqs: [4], shadowedTokenCount: 9 }),
      userMessage(6, [{ type: 'text', text: 'd' }], undefined, { surfaceOp: { op: 'replace', startSeq: 4, endSeq: 4 } }),
      userMessage(7, [{ type: 'text', text: 'eeee' }]),
      compaction(8, 'prune', { shadowedSeqs: [7], shadowedTokenCount: 9 }),
      userMessage(9, [{ type: 'text', text: 'f' }], undefined, { surfaceOp: { op: 'replace', startSeq: 7, endSeq: 7 } }),
    ], { maxArchiveNodes: 1 })
    assert.equal(drive.states[6].archiveFloor, 3, 'the first drop sets the floor (no existing one)')
    assert.deepEqual(drive.state.archived.map(n => n.seq), [7], 'only the newest removal survives')
    assert.equal(drive.state.archiveFloor, 6, 'the second drop takes the max with the existing floor')
    assertStatesPlainJson(drive)
  })
})

describe('trimState restored-state defenses', () => {
  test('archived entries without `gone` survive the request window, then cap away without touching archiveFloor', () => {
    const def = timelineDef({ maxArchiveNodes: 2 })
    const st = createTimelineState()
    st.requests.push(req(5, 1, 1))
    st.archived.push({ seq: 1, cat: 'user', tokens: 9 })
    const next = def.apply(st, planMode(10, { active: true }))
    assert.deepEqual(next.archived.map(n => n.seq), [1])
    assert.equal(next.archiveFloor, undefined)
    const capped = timelineDef({ maxArchiveNodes: 1 })
    const restored = createTimelineState()
    restored.archived.push(
      { seq: 1, cat: 'user', tokens: 9 },
      { seq: 2, cat: 'user', tokens: 9 },
      { seq: 3, cat: 'user', tokens: 9 },
    )
    const trimmed = capped.apply(restored, planMode(10, { active: true }))
    assert.deepEqual(trimmed.archived.map(n => n.seq), [3], 'maxArchiveNodes keeps the newest removal')
    assert.equal('archiveFloor' in trimmed, false, 'the last dropped entry has no `gone`: no floor to record')
  })
})
