import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineHead, createTimelineState, trimToLastTurns } from '../../src/host/fold'
import type { TimelineEvent } from '../../src/host/fold'
import type { TimelineState } from '../../src/host/foldState'
import type { RequestRecord } from '../../src/shared/types'
import { assistantMessage, compaction, planMode, toolCall, toolResult, userMessage } from './helpers/events'
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
  test('archived entries never persist head-side, so no floor is recorded for them', () => {
    const def = timelineDef({ maxArchiveNodes: 2 })
    const st = createTimelineState()
    st.requests.push(req(5, 1, 1))
    st.archived.push({ seq: 1, cat: 'user', tokens: 9 })
    const next = def.apply(st, planMode(10, { active: true }))
    assert.deepEqual(next.archived, [], 'detail collections are refold-only head-side')
    assert.equal(next.archiveFloor, undefined)
    const capped = timelineDef({ maxArchiveNodes: 1 })
    const restored = createTimelineState()
    restored.archived.push(
      { seq: 1, cat: 'user', tokens: 9 },
      { seq: 2, cat: 'user', tokens: 9 },
      { seq: 3, cat: 'user', tokens: 9 },
    )
    const trimmed = capped.apply(restored, planMode(10, { active: true }))
    assert.deepEqual(trimmed.archived, [])
    assert.equal('archiveFloor' in trimmed, false)
  })
})

describe('the full-session head counters', () => {
  test('turns stay full-session past the kept-turn cap', () => {
    const drive = driveTimeline([1, 2, 3, 4, 5].map(i => assistantMessage(i, { turn: i, step: 0 })), { maxKeptTurns: 2 })
    assert.deepEqual(drive.state.requests.map(r => r.turn), [4, 5])
    assert.equal(buildTimelineHead(drive.state).counts?.turns, 5)
  })

  test('steps stay full-session past the request-step cap', () => {
    const drive = driveTimeline([1, 2, 3, 4, 5].map(i => assistantMessage(i, { turn: 1, step: i })), { maxKeptTurns: 10, maxRequestSteps: 3 })
    assert.equal(drive.state.requests.length, 3)
    const counts = buildTimelineHead(drive.state).counts
    assert.equal(counts?.steps, 5)
    assert.equal(counts?.turns, 1)
  })

  test('injection and compaction counters stay full-session past the event cap', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'p' }),
      userMessage(2, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'p' }),
      compaction(3, 'summary', { shadowedTokenCount: 1 }),
      compaction(4, 'prune', { shadowedTokenCount: 1 }),
      compaction(5, 'prune', { shadowedTokenCount: 1 }),
      planMode(6, { active: true }),
    ], { maxEvents: 3 })
    assert.equal(drive.state.events.length, 3)
    const counts = buildTimelineHead(drive.state).counts
    assert.deepEqual([counts?.injects, counts?.compactions, counts?.prunes], [2, 1, 2])
  })

  test('distinct skill names stay full-session and the name ledger is bounded', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: 'alpha' }),
      userMessage(2, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: 'beta' }),
      userMessage(3, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: 'alpha' }),
    ], { maxEvents: 1 })
    assert.equal(buildTimelineHead(drive.state).counts?.skills, 2)
    const many: TimelineEvent[] = []
    for (let i = 0; i < 501; i++) {
      many.push(userMessage(i + 1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: `skill-${i}` }))
    }
    const bounded = driveTimeline(many, { maxEvents: 5 })
    assert.equal(buildTimelineHead(bounded.state).counts?.skills, 500)
  })

  test('empty, unknown, and reserved skill names prove before joining the ledger', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: '' }),
      userMessage(2, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation' }),
      toolCall(3, { callId: 'c1', name: 'skill' }),
      toolResult(4, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="__proto__">x</skill_content>' }] }),
    ])
    assert.deepEqual(Object.keys(drive.state.totals?.skills ?? {}), ['?'])
    assert.equal(buildTimelineHead(drive.state).counts?.skills, 1)
    assert.equal(Object.getPrototypeOf(drive.state.totals?.skills), Object.prototype)
  })

  test('counter updates copy the totals object instead of mutating the previous state', () => {
    const def = timelineDef()
    const before = def.apply(def.apply(createTimelineState(), assistantMessage(1, { turn: 1, step: 1 })), assistantMessage(2, { turn: 1, step: 2 }))
    const totals = before.totals as NonNullable<TimelineState['totals']>
    const after = def.apply(before, assistantMessage(3, { turn: 2, step: 1 }))
    assert.equal(after.totals === totals, false, 'the new state owns a fresh totals object')
    assert.deepEqual(totals, before.totals, 'the previous state totals stay untouched')
    assert.equal(after.totals?.turns, 2)
    assert.equal(before.totals?.turns, 1)
  })

  test('turn-less and non-finite labels count as one zero turn', () => {
    const drive = driveTimeline([
      assistantMessage(1, {}),
      assistantMessage(2, {}),
      assistantMessage(3, { turn: Number.NaN }),
      assistantMessage(4, {}),
      assistantMessage(5, { turn: 2, step: 1 }),
    ])
    const counts = buildTimelineHead(drive.state).counts
    assert.deepEqual([counts?.turns, counts?.steps], [2, 5])
  })

  test('an explicit turn 0 after a turn-less record stays one turn', () => {
    const drive = driveTimeline([
      assistantMessage(1, {}),
      assistantMessage(2, { turn: 0, step: 1 }),
      assistantMessage(3, {}),
      assistantMessage(4, { turn: 1, step: 1 }),
    ])
    assert.equal(buildTimelineHead(drive.state).counts?.turns, 2)
  })

  test('a state without the cumulative counters falls back to the retained-window derivation', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'p' }),
      assistantMessage(2, { turn: 1, step: 1 }),
      compaction(3, 'prune', { shadowedTokenCount: 1 }),
    ])
    const legacy = structuredClone(drive.state) as TimelineState
    delete legacy.totals
    assert.deepEqual(buildTimelineHead(legacy).counts, buildTimelineHead(drive.state).counts)
  })

  test('the retained-window derivation counts every retained event kind and derives skills from events', () => {
    const state = createTimelineState() as TimelineState & Record<string, unknown>
    state.requests = [
      { time: 1, seq: 1, total: 1, turn: 2 },
      { time: 2, seq: 2, total: 1, turn: 2 },
      { time: 3, seq: 3, total: 1 },
    ] as RequestRecord[]
    state.events = [
      { seq: 3, time: 3, kind: 'inject', sub: 'skill', name: 'tdd' },
      { seq: 4, time: 4, kind: 'compaction' },
      { seq: 5, time: 5, kind: 'prune' },
      { seq: 6, time: 6, kind: 'inject', form: 'context' },
      { seq: 7, time: 7, kind: 'mode' },
    ] as TimelineState['events']
    delete state.totals
    assert.deepEqual(buildTimelineHead(state).counts, { turns: 2, steps: 3, injects: 2, compactions: 1, prunes: 1, skills: 1 })
  })

  test('a counter-less state continuing forward restarts its counters at its own cut', () => {
    const def = timelineDef()
    const legacy = structuredClone(createTimelineState()) as TimelineState
    delete legacy.totals
    let state = def.apply(legacy, userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: 'tdd' }))
    state = def.apply(state, assistantMessage(2, { turn: 1, step: 1 }))
    state = def.apply(state, toolCall(3, { callId: 'c1', name: 'skill' }))
    state = def.apply(state, toolResult(4, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="pdf">x</skill_content>' }] }))
    state = def.apply(state, compaction(5, 'summary', { shadowedTokenCount: 1 }))
    state = def.apply(state, compaction(6, 'prune', { shadowedTokenCount: 1 }))
    assert.deepEqual(buildTimelineHead(state).counts, { turns: 1, steps: 1, injects: 2, compactions: 1, prunes: 1, skills: 2 })
    const skillResult = def.apply(
      def.apply(legacy, toolCall(1, { callId: 'c9', name: 'skill' })),
      toolResult(2, { callId: 'c9', content: [{ type: 'text', text: '<skill_content name="pdf">x</skill_content>' }] }),
    )
    assert.deepEqual(buildTimelineHead(skillResult).counts, { turns: 0, steps: 0, injects: 1, compactions: 0, prunes: 0, skills: 1 })
  })

  test('the state schema round-trips every field including the counters', () => {
    const drive = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', name: 'tdd' }),
      compaction(2, 'summary', { shadowedTokenCount: 4 }),
      assistantMessage(3, { turn: 1, step: 1 }),
    ])
    const parsed = drive.def.stateSchema.parse(structuredClone(drive.state))
    assert.deepEqual(parsed, structuredClone(drive.state))
    assert.equal((parsed as TimelineState).totals?.turns, 1)
  })
})
