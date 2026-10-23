import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantAttempt,
  assistantMessage,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
} from './helpers/events'
import { assertPlainJson, assertStable, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

const chunkRec = (time: number, chunk: unknown): unknown => ({ type: 'chunk', time, chunk })

function step(seq: number, startMs: number, lmMs: number, opts: { tokenMs?: number; usage?: Record<string, number> } = {}): TimelineEvent[] {
  const events: TimelineEvent[] = [{ type: 'step/start', seq, time: startMs }]
  const stream = opts.tokenMs === undefined
    ? undefined
    : [chunkRec(startMs + opts.tokenMs, { type: 'text-delta', text: 'x' })]
  events.push(
    assistantMessage(seq + 1, { time: startMs + lmMs, usage: opts.usage as never, stream }),
    { type: 'step/end', seq: seq + 2, time: startMs + lmMs + 4000 },
  )
  return events
}

describe('timing — step lifecycle', () => {
  test('a step prices its TTFT, generation, and wall time, then disarms the slot', () => {
    const { state } = driveTimeline(step(1, 10_000, 2_000, { tokenMs: 600 }))
    assert.deepEqual(state.timing, {
      wallMs: 6_000, ttftMs: 600, genMs: 1_400, calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
    })
    assert.equal(state.stepStart, undefined, 'step/end consumes the pending slot')
  })

  test('the request record carries the step\'s active time (the trend overlay\'s activeMs)', () => {
    const drive = driveTimeline(step(1, 10_000, 2_000, { tokenMs: 600 }))
    assert.equal(drive.state.requests.length, 1)
    assert.equal(drive.state.requests[0].activeMs, 6_000, 'step start → step end')
    assert.ok(!('activeMs' in drive.states[2].requests[0]), 'no stamp before step/end')
  })

  test('a message folded without an open step slot carries no activeMs', () => {
    const { state } = driveTimeline([assistantMessage(1, {})])
    assert.equal(state.requests.length, 1)
    assert.ok(!('activeMs' in state.requests[0]), 'no undefined-valued property (plain-JSON precondition)')
  })

  test('steps accumulate; the pending slot prices assistant/message and step/end of the SAME step', () => {
    const { state } = driveTimeline([...step(1, 0, 1_000, { tokenMs: 200 }), ...step(4, 10_000, 3_000, { tokenMs: 1_500 })])
    assert.equal(state.timing?.wallMs, 12_000)
    assert.equal(state.timing?.ttftMs, 1_700)
    assert.equal(state.timing?.genMs, 2_300)
    assert.equal(state.timing?.calls, 2)
  })

  test('an unpaired step/end is uninteresting (same state reference)', () => {
    const { state, def } = driveTimeline([])
    assertStable(state, stepEnd(1))
    assert.equal(def.apply(state, stepEnd(1)), state)
  })

  test('a step/end without a start leaves timing absent', () => {
    const { state } = driveTimeline([stepEnd(1)])
    assert.equal(state.timing, undefined)
  })

  test('assistant/message without an open step still counts the call, no model time', () => {
    const { state } = driveTimeline([assistantMessage(1, {})])
    assert.equal(state.timing?.calls, 1)
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.wallMs, 0)
  })

  test('a second step/start supersedes the pending slot — stamp included', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantAttempt(2, { stream: [chunkRec(500, { type: 'text-delta', text: 'x' })] }),
      stepStart(3, { time: 10_000 }),
      assistantAttempt(4, { stream: [chunkRec(11_000, { type: 'text-delta', text: 'y' })] }),
      assistantMessage(5, { time: 12_000 }),
      stepEnd(6, { time: 13_000 }),
    ])
    assert.equal(state.timing?.ttftMs, 1_000)
    assert.equal(state.timing?.genMs, 1_000)
    assert.equal(state.timing?.wallMs, 3_000)
  })

  test('non-finite or negative durations degrade to zero', () => {
    const { state } = driveTimeline([
      { type: 'step/start', seq: 1, time: Number.NaN },
      assistantMessage(3, { time: 5_000, stream: [chunkRec(5_000, { type: 'text-delta', text: 'x' })] }),
      { type: 'step/end', seq: 4, time: 6_000 },
    ])
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.wallMs, 0)
    assert.equal(state.timing?.calls, 1)
  })

  test('timing-bearing states stay plain JSON — stamped slot included', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantAttempt(2, { stream: [chunkRec(300, { type: 'text-delta', text: 'x' })] }),
      assistantMessage(3, { time: 1_000 }),
      toolCall(4, { callId: 'c1', name: 'bash' }),
      toolResult(5, { callId: 'c1', content: text('ok') }),
      stepEnd(6, { time: 30_000 }),
    ])
    const copy = assertPlainJson(drive.state)
    assert.ok((copy.timing?.toolsMs ?? 0) > 0)
    const stamped = drive.states.find(s => s.stepStart?.firstToken !== undefined)
    assert.ok(stamped !== undefined)
    assertPlainJson(stamped)
  })
})

describe('timing — tool call durations', () => {
  test('a paired result prices its duration and the per-name tally', () => {
    const { state } = driveTimeline([
      { type: 'tool/call', seq: 1, time: 1_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      toolResult(2, { callId: 'c1', content: text('ok'), time: 4_500 }),
    ])
    assert.deepEqual(state.timing, {
      wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 3_500, toolCalls: 1,
      tools: { bash: { calls: 1, ms: 3_500 } },
    })
  })

  test('repeated names accumulate into the per-name tally', () => {
    const call = (seq: number, callId: string, time: number): TimelineEvent => ({
      type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
    })
    const { state } = driveTimeline([
      call(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 3_000 }),
      call(4, 'c2', 5_000),
      toolResult(5, { callId: 'c2', content: text('ok'), time: 9_000 }),
    ])
    assert.equal(state.timing?.toolsMs, 2_000 + 4_000)
    assert.deepEqual(state.timing?.tools, { bash: { calls: 2, ms: 6_000 } })
  })

  test('an unpaired result carries no duration, no tally, and no `timing` slot at all', () => {
    const drive = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(drive.state.timing, undefined)
    assert.equal(Object.hasOwn(drive.state, 'timing'), false)
  })

  test('result before call (out-of-order log) prices nothing', () => {
    const { state } = driveTimeline([
      toolResult(1, { callId: 'c1', content: text('ok'), time: 2_000 }),
      toolCall(2, { callId: 'c1', name: 'bash' }),
    ])
    assert.equal(state.timing, undefined)
  })

  test('the per-name tally stays bounded: the smallest ms evicts past 16 names', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    // Tool 't0' is the cheapest (100ms); every later tool is costlier.
    for (let i = 0; i < 17; i++) {
      events.push({ type: 'tool/call', seq: seq++, time: i * 1_000, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: i * 1_000 + (i === 0 ? 100 : 5_000) }))
    }
    const { state } = driveTimeline(events)
    assert.equal(Object.keys(state.timing?.tools ?? {}).length, 16)
    assert.equal(state.timing?.tools.t0, undefined, 'the cheapest tally left the ranking')
  })

  test('a new name past the cap evicts the current minimum, not itself', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    for (let i = 0; i < 16; i++) {
      events.push({ type: 'tool/call', seq: seq++, time: 0, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: 5_000 }))
    }
    // One more: 6s, a new maximum — the eviction must drop one of the 5s rows.
    events.push({ type: 'tool/call', seq: seq++, time: 0, data: { callId: 'cx', name: 'tx', arguments: '{}' } })
    events.push(toolResult(seq++, { callId: 'cx', content: text('ok'), time: 6_000 }))
    const { state } = driveTimeline(events)
    const tools = state.timing?.tools ?? {}
    assert.equal(Object.keys(tools).length, 16)
    assert.equal(tools.tx?.ms, 6_000, 'the new name survived')
  })
})

describe('timing — the generation split (reasoning / text / tool args)', () => {
  test('the embedded stream tiles the generation window into the three buckets', () => {
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
    ])
    assert.equal(state.timing?.ttftMs, 200)
    assert.equal(state.timing?.genMs, 1_800)
    assert.equal(state.timing?.reasoningMs, 500, 'reasoning owns 200→700')
    assert.equal(state.timing?.textMs, 500, 'text owns 700→1200')
    assert.equal(state.timing?.toolArgMs, 800, 'tool args own 1200→message')
    assert.equal(
      (state.timing?.reasoningMs ?? 0) + (state.timing?.textMs ?? 0) + (state.timing?.toolArgMs ?? 0),
      state.timing?.genMs,
    )
    assert.equal(state.timing?.reasoningBlocks, 1)
    assert.equal(state.timing?.textBlocks, 1)
    assert.equal(state.timing?.toolArgBlocks, 1)
  })

  test('the buckets tile the marker span (they account for the generation window)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          chunkRec(400, { type: 'block-start', index: 0, blockType: 'text' }),
          { type: 'text-chunks', time0: 400, index: 1, dt: [], texts: ['y'] },
        ],
      }),
    ])
    const t = state.timing
    assert.equal((t?.reasoningMs ?? 0) + (t?.textMs ?? 0) + (t?.toolArgMs ?? 0), t?.genMs)
    assert.equal(t?.genMs, 800)
  })

  test('an unstamped call carries no split (its model time is unattributed wholesale)', () => {
    // Block markers but no token: the call prices no generation time, so its spans must not reappear as generation.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          chunkRec(400, { type: 'block-start', index: 0, blockType: 'text' }),
        ],
      }),
    ])
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.reasoningMs, undefined)
    assert.equal(state.timing?.textMs, undefined)
    assert.equal(state.timing?.reasoningBlocks, undefined)
    assert.equal(state.timing?.textBlocks, undefined)
  })

  test('an unknown block marker closes the open block but opens nothing', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          chunkRec(500, { type: 'block-start', index: 0, blockType: 'image' }),
        ],
      }),
    ])
    assert.equal(state.timing?.reasoningMs, 400, 'the reasoning span ends at the unknown marker')
    assert.equal(state.timing?.textMs, undefined)
    assert.equal(state.timing?.toolArgMs, undefined)
    assert.equal(state.timing?.reasoningBlocks, 1, 'the unknown marker itself counted nothing')
    assert.equal(state.timing?.textBlocks, undefined)
  })

  test('a marker with a hostile time anchors no span (the open block runs to the message)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          // The text marker's unusable time anchors no span and counts nothing — the open reasoning block tiles on.
          chunkRec(Number.NaN, { type: 'block-start', index: 0, blockType: 'text' }),
        ],
      }),
    ])
    assert.equal(state.timing?.genMs, 800)
    assert.equal(state.timing?.reasoningMs, 800, 'the reasoning block runs to the message')
    assert.equal(state.timing?.textMs, undefined)
    assert.equal(state.timing?.reasoningBlocks, 1)
    assert.equal(state.timing?.textBlocks, undefined, 'the hostile marker counted no block')
  })

  test('a stream with no block marker contributes no split (the card keeps the un-split shape)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_000,
        stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['hi'] }],
      }),
    ])
    assert.equal(state.timing?.genMs, 900)
    assert.equal(state.timing?.reasoningMs, undefined)
    assert.equal(state.timing?.textMs, undefined)
    assert.equal(state.timing?.toolArgMs, undefined)
    assert.equal(state.timing?.textBlocks, undefined)
  })

  test('split totals accumulate across steps and stay plain JSON', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 500,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          chunkRec(300, { type: 'block-start', index: 0, blockType: 'text' }),
          { type: 'text-chunks', time0: 300, index: 1, dt: [], texts: ['y'] },
        ],
      }),
      stepEnd(3, { time: 600 }),
      stepStart(4, { time: 10_000 }),
      assistantMessage(5, {
        time: 10_400,
        stream: [
          chunkRec(10_100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 10_100, index: 0, dt: [], texts: ['z'] },
        ],
      }),
      stepEnd(6, { time: 10_500 }),
    ])
    assert.equal(drive.state.timing?.reasoningMs, 200 + 300)
    assert.equal(drive.state.timing?.textMs, 200)
    assert.equal(drive.state.timing?.reasoningBlocks, 2)
    assert.equal(drive.state.timing?.textBlocks, 1)
    assertPlainJson(drive.state)
  })

  test('the generation split rides the wire view as plain values', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 400,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
        ],
      }),
    ])
    assert.equal(drive.view.timing?.reasoningMs, 300)
    assert.equal(drive.view.timing?.reasoningBlocks, 1)
  })
})

describe('timing — served wire view', () => {
  test('buildTimelineView serves deep copies (no aliasing of persisted state)', () => {
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') })])
    assert.ok(drive.state.timing !== undefined)
    assert.ok(drive.view.timing !== undefined)
    assert.notEqual(drive.view.timing, drive.state.timing)
    assert.notEqual(drive.view.timing.tools, drive.state.timing.tools)
    assert.notEqual(drive.view.timing.tools.bash, drive.state.timing.tools.bash)
    assert.deepEqual(drive.view.timing, drive.state.timing)
  })

  test('absent timing stays absent on the wire', () => {
    const { view } = driveTimeline([])
    assert.equal(view.timing, undefined)
  })

  test('a hostile __proto__ tool name books no row and keeps the served view schema-valid', () => {
    const def = timelineDef({})
    // One hostile tool only: a later tool-run event re-clones the tally through a spread, laundering the damage.
    const drive = driveTimeline([
      toolCall(5, { callId: 'c1', name: '__proto__' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
    ])
    const tools = drive.state.timing?.tools ?? {}
    assert.equal(Object.getPrototypeOf(tools), Object.prototype, 'the tally keeps a plain prototype')
    assert.deepEqual(Object.keys(tools), [], 'the reserved name books no row')
    assert.deepEqual(drive.view.timing?.tools, {}, 'nothing inherited rides the wire')
    // The consequence this guards: assigning that name sets the prototype instead of a row, so foldWire's
    // `for...in` copies the inherited `calls`/`ms` as `{}` — which the strict tool-timing schema rejects, and the
    // registry's drive has no error boundary, so the throw would stall this unit's push feed for good.
    const wire = def as unknown as { wire: { viewSchema: { parse(v: unknown): unknown } } }
    assert.doesNotThrow(() => wire.wire.viewSchema.parse(drive.view))
  })

  test('a hostile __proto__ callId arms no pairing row and keeps the state schema-valid', () => {
    const def = timelineDef({})
    const drive = driveTimeline([
      toolCall(5, { callId: '__proto__', name: 'bash' }),
      // Any later result runs the pairing-map rebuild: an inherited entry would land as own scalar props.
      toolResult(6, { callId: 'c1', content: text('ok') }),
    ])
    const names = drive.state.callNames ?? {}
    assert.equal(Object.getPrototypeOf(names), Object.prototype, 'the pairing map keeps a plain prototype')
    assert.deepEqual(Object.keys(names), [], 'the reserved id arms no row')
    // The consequence this guards: assigning that id installs the entry as the map's prototype instead of a row,
    // so the rebuild's `for...in` copies its name/start as own scalars — which the record-of-objects state schema
    // rejects on every restore, forcing the session off its checkpoint channel.
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    assert.doesNotThrow(() => c.stateSchema.parse(structuredClone(drive.state)))
  })

  test('a tool/result citing the reserved id pairs no tool and leaves no undefined property', () => {
    // driveTimeline's assertNoAbsentMembers fails on any own undefined property, so reaching the assertions below
    // already proves no `node.tool = undefined` materialized from the prototype lookup.
    const drive = driveTimeline([toolResult(5, { callId: '__proto__', content: text('ok') })])
    const node = drive.state.surface.at(-1)
    assert.ok(node !== undefined && !('tool' in node), 'no own tool property materializes from the prototype')
    assert.equal(drive.state.timing?.toolCalls ?? 0, 0, 'a phantom pairing books no tool time')
  })

  test('the persisted-state schema accepts the timing shape (stamped slot included)', () => {
    const def = timelineDef({})
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
      stepEnd(7, { time: 30_000 }),
      // A step left OPEN with a stamped slot: the final state carries stepStart.{time,firstToken} for the gate.
      stepStart(8, { time: 40_000 }),
      assistantAttempt(9, { stream: [chunkRec(40_100, { type: 'text-delta', text: 'x' })] })])
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    for (const state of drive.states) c.stateSchema.parse(structuredClone(state)) // throws on drift
    assert.ok(drive.state.stepStart?.firstToken !== undefined, 'the open slot carried the stamp')
  })
})

describe('timing — the step\'s active time (user waits priced out)', () => {
  const asked = (seq: number, time: number, id: unknown): TimelineEvent => ({
    type: 'approval/asked', seq, time, data: { id, toolName: 'bash' },
  })
  const decided = (seq: number, time: number, id: unknown): TimelineEvent => ({
    type: 'approval/decided', seq, time, data: { id, outcome: 'allowed-once' },
  })
  const askCall = (seq: number, time: number, callId = 'q1'): TimelineEvent => ({
    type: 'tool/call', seq, time, data: { callId, name: 'ask_user_question', arguments: '{}' },
  })

  test('the step\'s tool runs price active (the whole window counts)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      { type: 'tool/call', seq: 3, time: 3_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      toolResult(4, { callId: 'c1', content: text('ok'), time: 8_000 }),
      stepEnd(5, { time: 9_000 }),
    ])
    assert.equal(state.requests[0].activeMs, 9_000, 'the model call plus its tool run, start → end')
  })

  test('an approval decision wait prices out of the step', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      { type: 'tool/call', seq: 3, time: 3_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      asked(4, 3_500, 'a1'),
      decided(5, 5_500, 'a1'),
      toolResult(6, { callId: 'c1', content: text('ok'), time: 6_000 }),
      stepEnd(7, { time: 7_000 }),
    ])
    assert.equal(state.requests[0].activeMs, 5_000, 'the 7s window minus the 2s decision wait')
    assert.equal(state.timing?.wallMs, 7_000, 'the timing card keeps the wall figure')
  })

  test('an ask_user_question window prices out as the user\'s answer wait', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      askCall(3, 3_000),
      toolResult(4, { callId: 'q1', content: text('answer'), time: 8_000 }),
      stepEnd(5, { time: 9_000 }),
    ])
    assert.equal(state.requests[0].activeMs, 4_000, 'the 9s window minus the 5s answer wait')
  })

  test('an approval nested inside the answer wait prices once (the union, not the sum)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      askCall(3, 3_000),
      asked(4, 3_500, 'a1'),
      decided(5, 4_000, 'a1'),
      toolResult(6, { callId: 'q1', content: text('answer'), time: 8_000 }),
      stepEnd(7, { time: 9_000 }),
    ])
    assert.equal(state.requests[0].activeMs, 4_000, 'the nested 500ms decision rides inside the 5s wait')
  })

  test('concurrent decisions close independently; equal starts tie-break by end', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      asked(3, 3_000, 'a1'),
      asked(4, 3_000, 'a2'),
      decided(5, 5_000, 'a1'),
      decided(6, 6_000, 'a2'),
      stepEnd(7, { time: 9_000 }),
    ])
    assert.equal(drive.state.requests[0].activeMs, 6_000, 'the overlapping waits price their union (3000→6000)')
    const mid = drive.states[5]
    assert.deepEqual(mid.stepApprovals, { a2: 3_000 })
    assert.deepEqual(mid.stepWaits, [{ start: 3_000, end: 5_000 }])
  })

  test('a decision wait left dangling (a crash tail) closes at step/end', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      asked(3, 3_000, 'a1'),
      stepEnd(4, { time: 7_000 }),
    ])
    assert.equal(state.requests[0].activeMs, 3_000, 'the unanswered wait runs to the step\'s end')
  })

  test('a step that committed no request stamps nothing (the wall figure still prices)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      asked(2, 1_000, 'a1'),
      stepEnd(3, { time: 5_000 }),
    ])
    assert.equal(state.requests.length, 0)
    assert.equal(state.timing?.wallMs, 5_000)
  })

  test('a requestless step after a real one stamps nothing onto its record', () => {
    // The seq guard: the open step armed no back-pointer, so the earlier step's record keeps its own stamp untouched.
    const { state } = driveTimeline([
      ...step(1, 0, 1_000, { tokenMs: 200 }),
      stepStart(4, { time: 10_000 }),
      stepEnd(5, { time: 12_000 }),
    ])
    assert.equal(state.requests.length, 1)
    assert.equal(state.requests[0].activeMs, 5_000, 'the first step\'s own window (0→5000)')
  })

  test('approval events outside an open step are uninteresting (same state reference)', () => {
    const { state } = driveTimeline([])
    assertStable(state, asked(1, 0, 'a1'))
    assertStable(state, decided(2, 1_000, 'a1'))
  })

  test('an asked without a usable id arms nothing, even inside a step', () => {
    const { state } = driveTimeline([stepStart(1, { time: 0 })])
    assertStable(state, { type: 'approval/asked', seq: 2, time: 100, data: {} })
  })

  test('a decided that names no armed asked prices nothing', () => {
    const { state } = driveTimeline([stepStart(1, { time: 0 }), asked(2, 100, 'a1')])
    assertStable(state, decided(3, 200, 'ghost'))
    assertStable(state, { type: 'approval/decided', seq: 4, time: 300, data: {} })
  })
})

describe('timing — the throughput seat', () => {
  test('a call with usage pairs its decode window and output tokens; a usage-less call stays out', () => {
    const { state } = driveTimeline([
      ...step(1, 10_000, 2_000, { tokenMs: 600, usage: { outputTokens: 500 } }),
      ...step(4, 20_000, 3_000, { tokenMs: 1_500 }),
    ])
    assert.equal(state.timing?.speedMs, 1_400, 'only the usage-carrying call pairs')
    assert.equal(state.timing?.speedTokens, 500)
    assert.equal(state.timing?.genMs, 2_900, 'genMs still counts every stamped call')
  })

  test('multiple paired calls sum both sides', () => {
    const { state } = driveTimeline([
      ...step(1, 10_000, 2_000, { tokenMs: 600, usage: { outputTokens: 500 } }),
      ...step(4, 20_000, 3_000, { tokenMs: 1_500, usage: { outputTokens: 700 } }),
    ])
    assert.equal(state.timing?.speedMs, 2_900)
    assert.equal(state.timing?.speedTokens, 1_200)
  })

  test('usage without a token stamp prices nothing (the harness pairing)', () => {
    const { state } = driveTimeline([
      { type: 'step/start', seq: 1, time: 0 },
      assistantMessage(2, { time: 1_000, usage: { outputTokens: 500 } }),
      { type: 'step/end', seq: 3, time: 2_000 },
    ])
    assert.equal(state.timing?.speedMs, undefined)
    assert.equal(state.timing?.speedTokens, undefined)
  })

  test('usage without a readable output bucket pairs nothing', () => {
    const { state } = driveTimeline([
      ...step(1, 10_000, 2_000, { tokenMs: 600, usage: { inputTokens: 5 } }),
    ])
    assert.equal(state.timing?.speedMs, undefined)
    assert.equal(state.timing?.speedTokens, undefined)
    assert.equal(state.timing?.genMs, 1_400)
  })
})
