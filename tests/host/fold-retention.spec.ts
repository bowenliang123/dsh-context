// Retention tests for the timeline fold (src/host/fold.ts): trimToLastTurns
// unit behavior plus trimState's turn-run / step / event / archive bounds,
// driven through the real projection unit with tiny config bounds. The
// restored-state defenses (a projection-cache restore can carry archived
// entries without `gone` — the state schema leaves it optional) are exercised
// by feeding hand-crafted states through def.apply, exactly what a cache
// restore seeds.

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
  test('an empty list stays empty', () => {
    assert.deepEqual(trimToLastTurns([], 2), [])
  })

  test('turn-less records form one run and survive any cap', () => {
    const requests = [req(1), req(2), req(3)]
    assert.deepEqual(trimToLastTurns(requests, 1), requests)
  })

  test('a leading turn-less run is cut before the newest turns', () => {
    const requests = [req(1), req(2), req(3, 1)]
    assert.deepEqual(trimToLastTurns(requests, 1).map(r => r.seq), [3])
  })

  test('exactly at the cap keeps everything', () => {
    const requests = [req(1, 1), req(2, 1), req(3, 2)]
    assert.deepEqual(trimToLastTurns(requests, 2), requests)
  })

  test('over the cap trims whole turns from the front', () => {
    const requests = [req(1, 1), req(2, 1), req(3, 2), req(4, 2), req(5, 3), req(6, 3)]
    assert.deepEqual(trimToLastTurns(requests, 2).map(r => r.seq), [3, 4, 5, 6])
  })

  test('a turn straddling the cut is kept whole', () => {
    const requests = [req(1, 1), req(2, 2), req(3, 2), req(4, 2), req(5, 3)]
    const kept = trimToLastTurns(requests, 2)
    assert.deepEqual(kept.map(r => r.seq), [2, 3, 4, 5])
    assert.equal(kept[0], requests[1], 'a slice keeps record identity')
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

  test('a small log under every bound is kept whole', () => {
    const drive = driveTimeline([
      planMode(1, { active: true }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ], { maxKeptTurns: 2, maxRequestSteps: 5, maxEvents: 3 })
    assert.deepEqual(drive.state.requests.map(r => r.seq), [2])
    assert.deepEqual(drive.state.events.map(e => e.seq), [1])
    assert.equal(drive.state.archived.length, 0)
  })

  test('maxRequestSteps is the hard backstop for a pathological many-step turn', () => {
    const drive = driveTimeline(
      [1, 2, 3, 4, 5].map(i => assistantMessage(i, { turn: 1, step: i })),
      { maxKeptTurns: 10, maxRequestSteps: 3 },
    )
    // One turn-run: the turn trim cannot cut mid-turn, so the step backstop
    // slices the newest tail.
    assert.deepEqual(drive.state.requests.map(r => r.seq), [3, 4, 5])
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
})

describe('trimState archive pruning', () => {
  test('removals at or before the oldest retained request are dropped, recording archiveFloor', () => {
    const drive = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      compaction(2, 'prune', { shadowedSeqs: [1], shadowedTokenCount: 9 }),
      assistantMessage(3, { turn: 1, step: 2, surfaceOp: { op: 'replace', start: 1, end: 1 } }),
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
      userMessage(3, [{ type: 'text', text: 'b' }], undefined, { surfaceOp: { op: 'replace', start: 1, end: 1 } }),
      userMessage(4, [{ type: 'text', text: 'cccc' }]),
      compaction(5, 'prune', { shadowedSeqs: [4], shadowedTokenCount: 9 }),
      userMessage(6, [{ type: 'text', text: 'd' }], undefined, { surfaceOp: { op: 'replace', start: 4, end: 4 } }),
      userMessage(7, [{ type: 'text', text: 'eeee' }]),
      compaction(8, 'prune', { shadowedSeqs: [7], shadowedTokenCount: 9 }),
      userMessage(9, [{ type: 'text', text: 'f' }], undefined, { surfaceOp: { op: 'replace', start: 7, end: 7 } }),
    ], { maxArchiveNodes: 1 })
    assert.equal(drive.states[6].archiveFloor, 3, 'the first drop sets the floor (no existing one)')
    assert.deepEqual(drive.state.archived.map(n => n.seq), [7], 'only the newest removal survives')
    assert.equal(drive.state.archiveFloor, 6, 'the second drop takes the max with the existing floor')
    assertStatesPlainJson(drive)
  })
})

describe('trimState restored-state defenses', () => {
  test('an archived entry without `gone` is never dropped by the request window', () => {
    const def = timelineDef({ maxArchiveNodes: 2 })
    const st = createTimelineState()
    st.requests.push(req(5, 1, 1))
    // A restored/legacy row without `gone`: `gone ?? Infinity` keeps it above
    // any oldest retained request.
    st.archived.push({ seq: 1, cat: 'user', tokens: 9 })
    const next = def.apply(st, planMode(10, { active: true }))
    assert.deepEqual(next.archived.map(n => n.seq), [1])
    assert.equal(next.archiveFloor, undefined)
  })

  test('gone-less archived entries capped by count drop without touching archiveFloor', () => {
    const def = timelineDef({ maxArchiveNodes: 1 })
    const st = createTimelineState()
    st.archived.push(
      { seq: 1, cat: 'user', tokens: 9 },
      { seq: 2, cat: 'user', tokens: 9 },
      { seq: 3, cat: 'user', tokens: 9 },
    )
    const next = def.apply(st, planMode(10, { active: true }))
    assert.deepEqual(next.archived.map(n => n.seq), [3], 'maxArchiveNodes keeps the newest removal')
    assert.equal('archiveFloor' in next, false, 'the last dropped entry has no `gone`: no floor to record')
  })
})
