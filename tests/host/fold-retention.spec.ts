import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineHead, createTimelineState, trimToLastTurns, type TimelineEvent, buildTimelineDetail } from '../../src/host/fold'
import { type TimelineState } from '../../src/host/foldState'
import { type RequestRecord } from '../../src/shared/types'
import { assistantMessage, compaction, planMode, toolCall, toolResult, userMessage, stepEnd, stepStart, assistantAttempt, header } from './helpers/events'
import { assertStatesPlainJson, driveTimeline, timelineDef, assertPlainJson, assertStable, requestsOf } from './helpers/projection'
import { resolveBounds } from '../../src/host/config'
import { estimateSystemContent } from '../../src/shared/estimate'

describe('fold-retention', () => {

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
    assert.equal(drive.state.archiveFloor, 3, 'the fold names the newest dropped removal')
    const payload = buildTimelineDetail(drive.state, resolveBounds({ maxKeptTurns: 2 }))
    assert.deepEqual(payload.archive, [])
    assert.equal(payload.archiveFloor, 3, 'the payload keeps the fold floor')
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
    assert.deepEqual(drive.state.archived.map(n => n.seq), [1, 4, 7], 'the fold keeps every removal')
    const bounds = resolveBounds({ maxArchiveNodes: 1 })
    const first = buildTimelineDetail(drive.states[6], bounds)
    assert.equal(first.archiveFloor, 3, 'the first payload drop sets the floor')
    assert.deepEqual(first.archive.map(n => n.seq), [4], 'only the newest removal rides the payload')
    const last = buildTimelineDetail(drive.state, bounds)
    assert.deepEqual(last.archive.map(n => n.seq), [7], 'the newest removal still rides the payload')
    assert.equal(last.archiveFloor, 6, 'the payload floor names the newest dropped removal')
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
    assert.equal('archiveFloor' in next, false)
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
})

describe('fold-spans', () => {

const text = (t: string) => [{ type: 'text', text: t }]

const chunkRec = (time: number, chunk: unknown): unknown => ({ type: 'chunk', time, chunk })

const toolCallAt = (seq: number, callId: string, time: number): TimelineEvent => ({
  type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
})

describe('spans — the step flush', () => {
  test('a full step tiles gapless: TTFT, the decode blocks in stream order, the tool window, residue fills the holes', () => {
    const stream = [
      chunkRec(200, { type: 'block-start', index: 0, blockType: 'reasoning' }),
      { type: 'reasoning-chunks', time0: 210, index: 0, dt: [], texts: ['think'] },
      chunkRec(700, { type: 'block-start', index: 0, blockType: 'text' }),
      { type: 'text-chunks', time0: 710, index: 1, dt: [], texts: ['answer'] },
      chunkRec(1_200, { type: 'block-start', index: 0, blockType: 'tool-call' }),
      { type: 'tool-call-chunks', time0: 1_210, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ]
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream }),
      toolCallAt(3, 'c1', 2_500),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 3_000 }),
      stepEnd(5, { time: 4_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 210 },
      { kind: 'reasoning', start: 210, end: 700 },
      { kind: 'text', start: 700, end: 1_200 },
      { kind: 'toolarg', start: 1_200, end: 2_000 },
      { kind: 'other', start: 2_000, end: 2_500 },
      { kind: 'tools', start: 2_500, end: 3_000 },
      { kind: 'other', start: 3_000, end: 4_000 },
    ])
    assert.equal(Object.hasOwn(state, 'stepStart'), false, 'step/end consumed the pending slot')
    assert.equal(Object.hasOwn(state, 'stepSpans'), false, '…and the span accumulator (never undefined-valued)')
  })

  test('the wait ends at the first token; an earlier marker stays inside the wait', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 110, index: 0, dt: [], texts: ['x'] },
        ],
      }),
      stepEnd(3, { time: 1_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 110 },
      { kind: 'reasoning', start: 110, end: 900 },
      { kind: 'other', start: 900, end: 1_000 },
    ])
    assert.deepEqual([state.timing?.ttftMs, state.timing?.genMs, state.timing?.reasoningMs], [110, 790, 790])
  })

  test('a redacted reasoning block moves to the wait; only the surviving decode block splits', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_063,
        stream: [
          chunkRec(364, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          chunkRec(952, { type: 'block-start', index: 1, blockType: 'tool-call' }),
          { type: 'tool-call-chunks', time0: 952, index: 1, dt: [0], id: 'c1', args: ['{', '}'] },
        ],
      }),
      toolCallAt(3, 'c1', 1_064),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 1_095 }),
      stepEnd(5, { time: 1_095 }),
    ])
    assert.deepEqual(
      [state.timing?.ttftMs, state.timing?.genMs, state.timing?.reasoningMs, state.timing?.toolArgMs],
      [952, 111, undefined, 111],
      'the marker lead stays in the wait; the surviving block splits the generation window',
    )
    assert.equal(state.timing?.reasoningBlocks, undefined, 'the redacted block left the split with its span')
    assert.equal(state.timing?.toolArgBlocks, 1)
    assert.equal(
      (state.timing?.reasoningMs ?? 0) + (state.timing?.textMs ?? 0) + (state.timing?.toolArgMs ?? 0),
      state.timing?.genMs,
      'the decode buckets partition the generation window exactly — no double count',
    )
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 952 },
      { kind: 'toolarg', start: 952, end: 1_063 },
      { kind: 'other', start: 1_063, end: 1_064 },
      { kind: 'tools', start: 1_064, end: 1_095 },
    ])
  })

  test('a backwards marker cannot make the decode buckets overlap the generation window', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 3_000,
        stream: [
          chunkRec(900, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          chunkRec(2_000, { type: 'block-start', index: 1, blockType: 'text' }),
          chunkRec(1_000, { type: 'block-start', index: 2, blockType: 'tool-call' }),
          chunkRec(1_500, { type: 'block-start', index: 3, blockType: 'text' }),
          { type: 'tool-call-chunks', time0: 1_100, index: 2, dt: [], id: 'c1', args: ['{}'] },
        ],
      }),
      stepEnd(3, { time: 3_000 }),
    ])
    assert.deepEqual(
      [state.timing?.ttftMs, state.timing?.genMs, state.timing?.reasoningMs, state.timing?.textMs, state.timing?.toolArgMs],
      [1_100, 1_900, 900, 1_000, undefined],
    )
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 1_100 },
      { kind: 'reasoning', start: 1_100, end: 2_000 },
      { kind: 'text', start: 2_000, end: 3_000 },
    ])
  })

  test('blocks stamped wholly past the message instant drop out of the tile', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 300,
        stream: [
          chunkRec(100, { type: 'text-delta', text: 'x' }),
          chunkRec(400, { type: 'block-start', index: 0, blockType: 'text' }),
          chunkRec(500, { type: 'block-start', index: 1, blockType: 'reasoning' }),
        ],
      }),
      stepEnd(3, { time: 600 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 600 },
    ])
  })

  test('without model slices the generation window falls to the residue fill', () => {
    const marked = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_000,
        stream: [chunkRec(100, { type: 'text-delta', text: 'x' })],
      }),
      stepEnd(3, { time: 1_400 }),
    ]).state
    assert.deepEqual(marked.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 1_400 },
    ])
    const unstamped = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000 }),
      stepEnd(3, { time: 1_400 }),
    ]).state
    assert.deepEqual(unstamped.spans, [{ kind: 'other', start: 0, end: 1_400 }])
  })

  test('idle time BETWEEN steps carries no span', () => {
    const step = (seq: number, start: number): TimelineEvent[] => [
      stepStart(seq, { time: start }),
      assistantMessage(seq + 1, { time: start + 1_000, stream: [chunkRec(start + 100, { type: 'text-delta', text: 'x' })] }),
      stepEnd(seq + 2, { time: start + 1_400 }),
    ]
    const { state } = driveTimeline([...step(1, 0), ...step(4, 10_000)])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 1_400 },
      { kind: 'ttft', start: 10_000, end: 10_100 },
      { kind: 'other', start: 10_100, end: 11_400 },
    ])
  })

  test('parallel tool runs paint their UNION, never double wall time — same-instant and shadowed windows included', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000 }),
      toolCallAt(3, 'c1', 2_000),
      toolCallAt(4, 'c2', 2_000),
      toolCallAt(5, 'c3', 2_000),
      toolResult(6, { callId: 'c1', content: text('ok'), time: 3_000 }),
      toolResult(7, { callId: 'c2', content: text('ok'), time: 3_000 }),
      toolResult(8, { callId: 'c3', content: text('ok'), time: 3_500 }),
      stepEnd(9, { time: 4_000 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'other', start: 0, end: 2_000 },
      { kind: 'tools', start: 2_000, end: 3_000 },
      { kind: 'tools', start: 3_000, end: 3_500 },
      { kind: 'other', start: 3_500, end: 4_000 },
    ])
    assert.equal(state.timing?.toolsMs, 1_000 + 1_000 + 1_500)
    assert.equal(state.timing?.toolBusyMs, 1_500, 'the busy union, never the per-call sum')
    assert.equal(state.timing?.toolCalls, 3)
  })

  test('spans clamp into the step window; a window wholly outside drops', () => {
    const past = driveTimeline([
      stepStart(1, { time: 0 }),
      toolCallAt(2, 'c1', 3_000),
      toolResult(3, { callId: 'c1', content: text('ok'), time: 5_000 }),
      stepEnd(4, { time: 4_000 }),
    ])
    assert.deepEqual(past.state.spans, [
      { kind: 'other', start: 0, end: 3_000 },
      { kind: 'tools', start: 3_000, end: 4_000 },
    ])
    assert.equal(past.state.timing?.toolBusyMs, 1_000, 'clip the busy union into the step window')
    assert.equal(past.state.timing?.toolsMs, 2_000, 'the per-call sum still prices the whole run')
    const before = driveTimeline([
      stepStart(1, { time: 3_000 }),
      toolCallAt(2, 'c1', 100),
      toolResult(3, { callId: 'c1', content: text('ok'), time: 200 }),
      stepEnd(4, { time: 4_000 }),
    ])
    assert.deepEqual(before.state.spans, [{ kind: 'other', start: 3_000, end: 4_000 }])
    assert.equal(before.state.timing?.toolBusyMs, 0, 'no painted window, no busy time')
  })

  test('a zero-width step flushes nothing but bumps the detail revision', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 5_000 }),
      stepEnd(2, { time: 5_000 }),
    ])
    assert.deepEqual(state.spans, [])
    assert.equal(state.detailRev, 1, 'open tabs refetch the strip')
  })

  test('a tool result folded without an open step prices the totals but paints no span', () => {
    const { state } = driveTimeline([
      toolCallAt(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 2_000 }),
    ])
    assert.equal(state.timing?.toolsMs, 1_000)
    assert.deepEqual(state.spans, [])
  })

  test('a second step/start supersedes the open accumulator — its un-flushed spans die with it', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      stepStart(3, { time: 10_000 }),
      assistantMessage(4, { time: 11_000, stream: [chunkRec(10_100, { type: 'text-delta', text: 'y' })] }),
      stepEnd(5, { time: 11_400 }),
    ])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 10_000, end: 10_100 },
      { kind: 'other', start: 10_100, end: 11_400 },
    ])
  })
})

describe('spans — retention, wire, and schema faces', () => {
  test('the collection keeps the newest tail past the 2_000-span cap', () => {
    const events: TimelineEvent[] = []
    for (let i = 0; i < 41; i++) {
      const start = i * 10_000
      const stream: unknown[] = [chunkRec(start + 100, { type: 'text-delta', text: 'x' })]
      for (let m = 0; m < 48; m++) {
        stream.push(chunkRec(start + 100 + m * 10, { type: 'block-start', index: 0, blockType: m % 2 === 0 ? 'text' : 'reasoning' }))
      }
      events.push(
        stepStart(i * 3 + 1, { time: start }),
        assistantMessage(i * 3 + 2, { time: start + 1_000, stream }),
        stepEnd(i * 3 + 3, { time: start + 1_400 }),
      )
    }
    const { state } = driveTimeline(events)
    assert.equal(state.spans.length, 2_000)
    assert.deepEqual(state.spans[0], { kind: 'ttft', start: 10_000, end: 10_100 }, 'the oldest step left the window')
    assert.deepEqual(state.spans.at(-1), { kind: 'other', start: 401_000, end: 401_400 })
  })

  test('the inline wire view serves COPIES; the slim head omits the collection whole', () => {
    const events: TimelineEvent[] = [
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      stepEnd(3, { time: 1_400 }),
    ]
    const drive = driveTimeline(events)
    assert.deepEqual(drive.view.spans, drive.state.spans)
    assert.notEqual(drive.view.spans, drive.state.spans, 'the served array never aliases the state')
    assert.notEqual(drive.view.spans?.[0], drive.state.spans[0], '…nor its items')
    const detail = buildTimelineDetail(drive.state, resolveBounds({}))
    assert.deepEqual(detail.spans, drive.state.spans)
    assert.notEqual(detail.spans[0], drive.state.spans[0])
    const slimDef = timelineDef({}, true)
    let slimState = slimDef.init()
    for (const ev of events) slimState = slimDef.apply(slimState, ev)
    assert.equal(Object.hasOwn(slimDef.wire.view(slimState), 'spans'), false)
  })

  test('every intermediate state stays plain JSON and validates against the state schema; a spans-less state fails it (the v23 gate)', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkRec(100, { type: 'text-delta', text: 'x' })] }),
      toolCallAt(3, 'c1', 1_100),
      toolResult(4, { callId: 'c1', content: text('ok'), time: 1_200 }),
      stepEnd(5, { time: 1_400 }),
      stepStart(6, { time: 2_000 }),
      assistantMessage(7, { time: 3_000, stream: [chunkRec(2_100, { type: 'text-delta', text: 'y' })] }),
    ])
    for (const state of drive.states) {
      assertPlainJson(state)
      drive.def.stateSchema.parse(structuredClone(state))
    }
    const stale = structuredClone(drive.state) as unknown as Record<string, unknown>
    delete stale.spans
    assert.throws(() => drive.def.stateSchema.parse(stale))
  })
})
})

describe('fold-dialect', () => {

const text = (t: string) => [{ type: 'text', text: t }]

const token = (time: number, t = 'x') => ({ type: 'chunk', time, chunk: { type: 'text-delta', text: t } })

describe('system/message — the system prompt as a surface node', () => {
  test('an appended system prompt prices into systemTokens and the request total; a later header never clears it', () => {
    const prompt = 'You are an agent. '.repeat(20)
    const { state, view } = driveTimeline([
      header(1, { tools: [] }),
      { type: 'system/message', seq: 2, time: 2000, data: { turn: 1, step: 1, message: { content: text(prompt) } }, surfaceOp: 'append' },
      userMessage(3, text('hi'), { kind: 'user' }),
      assistantMessage(4, { turn: 1, step: 1 }),
    ])
    const price = estimateSystemContent(text(prompt))
    assert.equal(state.systemTokens, price)
    assert.deepEqual(state.systems, [{ seq: 2, time: 2000, tokens: price }])
    assert.equal(requestsOf(state)[0].system, price, 'the request record snapshots the prompt in force')
    assert.deepEqual(view.systems, [{ seq: 2, time: 2000, tokens: price }], 'the wire carries the live prompt nodes')
    assert.equal(view.current.total, price + state.sums.user + state.sums.assistant, 'the prompt joins the composition total')
    const headerOnly = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text(prompt) } }, surfaceOp: 'append' },
      header(2, { tools: [] }),
      header(3, { tools: [] }),
    ]).state
    assert.equal(headerOnly.systemTokens, price, 'headers carry no prompt, so they never clear log-sourced nodes')
    assert.equal(headerOnly.systems?.length, 1)
    const malformed = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: null as never, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: 'not-a-record' }, surfaceOp: 'append' },
      { type: 'system/message', seq: 3, time: 3000, data: { message: { content: text('real prompt') } }, surfaceOp: 'append' },
    ]).state
    assert.deepEqual(malformed.systems?.map(n => n.tokens), [0, 0, estimateSystemContent(text('real prompt'))])
    assert.equal(malformed.systemTokens, estimateSystemContent(text('real prompt')))
  })

  test('an empty node is dormant: it keeps its position without clearing a live prompt', () => {
    const prompt = 'prompt '.repeat(10)
    const { state } = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text(prompt) } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: [] } }, surfaceOp: 'append' },
    ])
    assert.equal(state.systemTokens, estimateSystemContent(text(prompt)), 'the last NONEMPTY node stays effective')
    assert.equal(state.systems?.length, 2)
    assert.equal(state.systems?.[1].tokens, 0)
  })

  test('a replacement swaps or starts the node list and reprices (startSeq/endSeq)', () => {
    const first = 'first '.repeat(10)
    const second = 'second prompt text '.repeat(10)
    const existing = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text(first) } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text(second) } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    ])
    assert.deepEqual(existing.state.systems, [{ seq: 2, time: 2000, tokens: estimateSystemContent(text(second)) }])
    assert.equal(existing.state.systemTokens, estimateSystemContent(text(second)))
    assert.deepEqual(existing.view.systems, existing.state.systems)
    const fresh = driveTimeline([
      { type: 'system/message', seq: 4, time: 4000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    ])
    assert.deepEqual(fresh.state.systems, [{ seq: 4, time: 4000, tokens: estimateSystemContent(text('q')) }])
    assert.equal(fresh.state.systemTokens, estimateSystemContent(text('q')))
  })

  test('a system replacement removes only the claimed nodes — ordinary surface nodes included (hostile log)', () => {
    const claimed = driveTimeline([
      userMessage(1, text('aaaa'), { kind: 'user' }),
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text('p') } }, surfaceOp: 'append' },
      userMessage(3, text('bbbb'), { kind: 'user' }),
      userMessage(9, text('cccc'), { kind: 'user' }),
      { type: 'system/message', seq: 10, time: 3000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 } },
    ]).state
    assert.deepEqual(claimed.surface.map(n => n.seq), [9], 'the claimed nodes left the surface, the later one stayed')
    assert.equal(claimed.sums.user, claimed.surface.reduce((sum, n) => sum + n.tokens, 0))
    assert.deepEqual(claimed.archived.map(n => [n.seq, n.gone]), [[1, 10], [3, 10]])
    assert.deepEqual(claimed.systems, [{ seq: 10, time: 3000, tokens: estimateSystemContent(text('q')) }])
    const outside = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text('earlier') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text('p') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 5, time: 5000, data: { message: { content: text('later prompt') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 8, time: 8000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } },
    ]).state
    assert.deepEqual(outside.systems?.map(n => n.seq), [1, 5, 8], 'only the claimed node left the list')
    assert.equal(outside.systemTokens, estimateSystemContent(text('q')), 'the newest nonempty node is effective')
  })

  test('a system/message expires an armed shadow claim (the shadow-price protocol)', () => {
    const { state } = driveTimeline([
      userMessage(1, text('a'), { kind: 'user' }),
      { type: 'compaction/summary', seq: 2, time: 2000, data: { shadowedSeqs: [1], shadowedTokenCount: 9 } },
      { type: 'system/message', seq: 3, time: 3000, data: { message: { content: text('p') } }, surfaceOp: 'append' },
      userMessage(4, text('b'), { kind: 'user' }),
    ])
    assert.equal(state.pendingShadowedSeqs, undefined)
    assert.deepEqual(state.surface.map(n => n.seq), [1, 4], 'the stale claim no longer removes node 1')
  })

  test('the live node list is bounded (a hostile log cannot grow the state)', () => {
    const events: TimelineEvent[] = []
    for (let i = 1; i <= 12; i++) {
      events.push({ type: 'system/message', seq: i, time: i * 1000, data: { message: { content: text('p' + String(i)) } }, surfaceOp: 'append' })
    }
    const { state } = driveTimeline(events)
    assert.equal(state.systems?.length, 8)
    assert.deepEqual(state.systems?.map(n => n.seq), [5, 6, 7, 8, 9, 10, 11, 12])
    assert.equal(state.systemTokens, estimateSystemContent(text('p12')))
  })
})

describe('embedded assistant stream — the first-token source', () => {
  test('a packed text run prices TTFT from its base time plus gaps', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 1000 }),
      assistantMessage(2, {
        turn: 1,
        step: 1,
        stream: [{ type: 'text-chunks', time0: 1200, index: 0, dt: [30], texts: ['', 'hello'] }],
        time: 2000,
      }),
    ])
    assert.equal(state.timing?.ttftMs, 230, 'the first NON-EMPTY fragment carries the stamp')
    assert.equal(state.timing?.genMs, 770)
  })

  test('a streamless message leaves the call unattributed (the residue bucket)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 1000 }),
      assistantMessage(2, { turn: 1, step: 1, time: 2000 }),
    ])
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.calls, 1)
  })

  test('assistant/attempt stamps the open step; the message then reuses it', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 1000 }),
      assistantAttempt(2, { turn: 1, step: 1, stream: [token(1300)], time: 1500 }),
      assistantMessage(3, { turn: 1, step: 1, stream: [token(9000)], time: 2000 }),
      stepEnd(4, { time: 2100 }),
    ])
    assert.equal(state.timing?.ttftMs, 300, 'the attempt\'s first token wins over the later message stream')
    assert.equal(state.timing?.genMs, 700)
  })

  test('an attempt without a token, without a slot, or over a stamped slot is uninteresting', () => {
    const def = timelineDef()
    assertStable(def.init(), assistantAttempt(1, { turn: 1, step: 1, stream: [token(100)] }), def)
    const armed = def.apply(def.init(), stepStart(1, { time: 1000 }))
    assertStable(armed, assistantAttempt(2, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish' } }] }), def)
    const stamped = def.apply(armed, assistantAttempt(2, { turn: 1, step: 1, stream: [token(1200)] }))
    assertStable(stamped, assistantAttempt(3, { turn: 1, step: 1, stream: [token(1100)] }), def)
  })
})
})
