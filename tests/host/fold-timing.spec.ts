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
      wallMs: 6_000, ttftMs: 600, genMs: 1_400, calls: 1, toolsMs: 0, toolBusyMs: 0, toolCalls: 0, tools: {},
    })
    assert.equal(state.stepStart, undefined, 'step/end consumes the pending slot')
  })

  test('steps accumulate; the pending slot prices assistant/message and step/end of the SAME step', () => {
    const { state } = driveTimeline([...step(1, 0, 1_000, { tokenMs: 200 }), ...step(4, 10_000, 3_000, { tokenMs: 1_500 })])
    assert.equal(state.timing?.wallMs, 12_000)
    assert.equal(state.timing?.ttftMs, 1_700)
    assert.equal(state.timing?.genMs, 2_300)
    assert.equal(state.timing?.calls, 2)
  })

  test('an unpaired step/end is uninteresting and leaves timing absent', () => {
    const def = timelineDef()
    const state = def.init()
    const applied = def.apply(state, stepEnd(1))
    assert.ok(applied === state && !Object.hasOwn(applied, 'timing'))
  })

  test('assistant/message without an open step still counts the call, no model time, no activeMs', () => {
    const { state } = driveTimeline([assistantMessage(1, {})])
    assert.deepEqual([state.timing?.calls, state.timing?.ttftMs, state.timing?.genMs, state.timing?.wallMs], [1, 0, 0, 0])
    assert.equal(state.requests.length, 1)
    assert.ok(!('activeMs' in state.requests[0]), 'no undefined-valued property (plain-JSON precondition)')
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
    assert.deepEqual([state.timing?.ttftMs, state.timing?.genMs, state.timing?.wallMs], [1_000, 1_000, 3_000])
  })

  test('non-finite or negative durations degrade to zero', () => {
    const { state } = driveTimeline([
      { type: 'step/start', seq: 1, time: Number.NaN },
      assistantMessage(3, { time: 5_000, stream: [chunkRec(5_000, { type: 'text-delta', text: 'x' })] }),
      { type: 'step/end', seq: 4, time: 6_000 },
    ])
    assert.deepEqual([state.timing?.ttftMs, state.timing?.genMs, state.timing?.wallMs, state.timing?.calls], [0, 0, 0, 1])
  })
})

describe('timing — tool call durations', () => {
  test('a paired result prices its duration and the per-name tally; repeats accumulate', () => {
    const call = (seq: number, callId: string, time: number): TimelineEvent => ({
      type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
    })
    const drive = driveTimeline([
      call(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 4_500 }),
      call(4, 'c2', 5_000),
      toolResult(5, { callId: 'c2', content: text('ok'), time: 9_000 }),
    ])
    assert.deepEqual(drive.states[2].timing, {
      wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 3_500, toolBusyMs: 0, toolCalls: 1,
      tools: { bash: { calls: 1, ms: 3_500 } },
    })
    assert.equal(drive.state.timing?.toolsMs, 3_500 + 4_000)
    assert.deepEqual(drive.state.timing?.tools, { bash: { calls: 2, ms: 7_500 } })
  })

  test('the busy union accumulates per step: parallel runs price once, and a cross-step run prices no wall', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000 }),
      { type: 'tool/call', seq: 3, time: 2_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'tool/call', seq: 4, time: 2_000, data: { callId: 'c2', name: 'web_fetch', arguments: '{}' } },
      toolResult(5, { callId: 'c1', content: text('ok'), time: 8_000 }),
      toolResult(6, { callId: 'c2', content: text('ok'), time: 8_000 }),
      stepEnd(7, { time: 9_000 }),
      { type: 'tool/call', seq: 8, time: 10_000, data: { callId: 'c3', name: 'bash', arguments: '{}' } },
      toolResult(9, { callId: 'c3', content: text('ok'), time: 12_000 }),
    ])
    assert.equal(state.timing?.toolsMs, 6_000 + 6_000 + 2_000, 'the per-call sum keeps the harness parity')
    assert.equal(state.timing?.toolBusyMs, 6_000, 'the parallel runs share one painted window')
    assert.ok((state.timing?.toolBusyMs ?? 0) <= (state.timing?.wallMs ?? 0))
  })

  test('a pre-field timing row folded forward leaves the busy union absent, never partial', () => {
    const def = timelineDef()
    const legacy = {
      ...def.init(),
      timing: { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} },
      stepStart: { time: 0 },
    }
    let state = def.apply(legacy, { type: 'tool/call', seq: 1, time: 1_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } })
    state = def.apply(state, toolResult(2, { callId: 'c1', content: text('ok'), time: 2_000 }))
    state = def.apply(state, stepEnd(3, { time: 3_000 }))
    assert.equal(Object.hasOwn(state.timing ?? {}, 'toolBusyMs'), false, 'a partial total would undercount the card')
    assert.equal(state.timing?.toolsMs, 1_000)
  })

  test('an unpaired or out-of-order result prices nothing, with no `timing` slot at all', () => {
    const unpaired = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(unpaired.state.timing, undefined)
    assert.equal(Object.hasOwn(unpaired.state, 'timing'), false)
    const reversed = driveTimeline([
      toolResult(1, { callId: 'c1', content: text('ok'), time: 2_000 }),
      toolCall(2, { callId: 'c1', name: 'bash' }),
    ])
    assert.equal(reversed.state.timing, undefined)
  })

  test('the per-name tally stays bounded: the smallest ms evicts past 16 names', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    for (let i = 0; i < 17; i++) {
      events.push({ type: 'tool/call', seq: seq++, time: i * 1_000, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: i * 1_000 + (i === 0 ? 100 : 5_000) }))
    }
    const { state } = driveTimeline(events)
    assert.equal(Object.keys(state.timing?.tools ?? {}).length, 16)
    assert.equal(state.timing?.tools.t0, undefined, 'the cheapest tally left the ranking')
    assert.equal(state.timing?.tools.t16?.ms, 5_000, 'the newest name, costlier than the evicted minimum, survived')
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

  test('an unstamped call carries no split (its model time is unattributed wholesale)', () => {
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
    assert.deepEqual(
      [state.timing?.genMs, state.timing?.reasoningMs, state.timing?.textMs, state.timing?.reasoningBlocks, state.timing?.textBlocks],
      [0, undefined, undefined, undefined, undefined],
    )
  })

  test('a marker that opens nothing closes the open block — unknown kind, or a hostile time', () => {
    const unknown = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          chunkRec(500, { type: 'block-start', index: 0, blockType: 'image' }),
        ],
      }),
    ]).state
    assert.equal(unknown.timing?.reasoningMs, 400, 'the reasoning span ends at the unknown marker')
    assert.equal(unknown.timing?.textMs, undefined)
    assert.equal(unknown.timing?.toolArgMs, undefined)
    assert.equal(unknown.timing?.reasoningBlocks, 1, 'the unknown marker itself counted nothing')
    assert.equal(unknown.timing?.textBlocks, undefined)
    const hostile = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 900,
        stream: [
          chunkRec(100, { type: 'block-start', index: 0, blockType: 'reasoning' }),
          { type: 'reasoning-chunks', time0: 100, index: 0, dt: [], texts: ['x'] },
          chunkRec(Number.NaN, { type: 'block-start', index: 0, blockType: 'text' }),
        ],
      }),
    ]).state
    assert.equal(hostile.timing?.genMs, 800)
    assert.equal(hostile.timing?.reasoningMs, 800, 'the reasoning block runs to the message')
    assert.equal(hostile.timing?.textMs, undefined)
    assert.equal(hostile.timing?.reasoningBlocks, 1)
    assert.equal(hostile.timing?.textBlocks, undefined, 'the hostile marker counted no block')
  })

  test('a stream with no block marker contributes no split (the card keeps the un-split shape)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, {
        time: 1_000,
        stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['hi'] }],
      }),
    ])
    assert.deepEqual(
      [state.timing?.genMs, state.timing?.reasoningMs, state.timing?.textMs, state.timing?.toolArgMs, state.timing?.textBlocks],
      [900, undefined, undefined, undefined, undefined],
    )
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
    assert.deepEqual(
      [drive.state.timing?.reasoningMs, drive.state.timing?.textMs, drive.state.timing?.reasoningBlocks, drive.state.timing?.textBlocks],
      [500, 200, 2, 1],
    )
    assertPlainJson(drive.state)
  })
})

describe('timing — served wire view', () => {
  test('the full fold view serves deep copies; absent timing stays absent', () => {
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') })])
    assert.ok(drive.state.timing !== undefined)
    assert.ok(drive.view.timing !== undefined)
    assert.notEqual(drive.view.timing, drive.state.timing)
    assert.notEqual(drive.view.timing.tools, drive.state.timing.tools)
    assert.notEqual(drive.view.timing.tools.bash, drive.state.timing.tools.bash)
    assert.deepEqual(drive.view.timing, drive.state.timing)
    assert.equal(driveTimeline([]).view.timing, undefined)
  })

  test('a hostile __proto__ tool name books no row and keeps the served view schema-valid', () => {
    const def = timelineDef({})
    const drive = driveTimeline([
      toolCall(5, { callId: 'c1', name: '__proto__' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
    ])
    const tools = drive.state.timing?.tools ?? {}
    assert.equal(Object.getPrototypeOf(tools), Object.prototype, 'the tally keeps a plain prototype')
    assert.deepEqual(Object.keys(tools), [], 'the reserved name books no row')
    assert.deepEqual(drive.view.timing?.tools, {}, 'nothing inherited rides the wire')
    const wire = def as unknown as { wire: { viewSchema: { parse(v: unknown): unknown } } }
    assert.doesNotThrow(() => wire.wire.viewSchema.parse(drive.view))
  })

  test('a hostile __proto__ callId arms no pairing row and keeps the state schema-valid', () => {
    const def = timelineDef({})
    const drive = driveTimeline([
      toolCall(5, { callId: '__proto__', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
    ])
    const names = drive.state.callNames ?? {}
    assert.equal(Object.getPrototypeOf(names), Object.prototype, 'the pairing map keeps a plain prototype')
    assert.deepEqual(Object.keys(names), [], 'the reserved id arms no row')
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    assert.doesNotThrow(() => c.stateSchema.parse(structuredClone(drive.state)))
  })

  test('a tool/result citing the reserved id pairs no tool and leaves no undefined property', () => {
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
      stepStart(8, { time: 40_000 }),
      assistantAttempt(9, { stream: [chunkRec(40_100, { type: 'text-delta', text: 'x' })] })])
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    for (const state of drive.states) {
      c.stateSchema.parse(structuredClone(state))
      assertPlainJson(state)
    }
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

  test('the request record stamps activeMs at step/end; its tool runs price active (the whole window counts)', () => {
    const modelOnly = driveTimeline(step(1, 10_000, 2_000, { tokenMs: 600 }))
    assert.equal(modelOnly.state.requests[0].activeMs, 6_000, 'step start → step end')
    assert.ok(!('activeMs' in modelOnly.states[2].requests[0]), 'no stamp before step/end')
    const withTool = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000 }),
      { type: 'tool/call', seq: 3, time: 3_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      toolResult(4, { callId: 'c1', content: text('ok'), time: 8_000 }),
      stepEnd(5, { time: 9_000 }),
    ]).state
    assert.equal(withTool.requests[0].activeMs, 9_000, 'the model call plus its tool run, start → end')
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
    assert.deepEqual([state.requests[0].activeMs, state.timing?.wallMs], [5_000, 7_000], 'the 7s window minus the 2s decision wait; the timing card keeps the wall figure')
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

  test('a step that committed no request stamps nothing; an earlier step\'s record keeps its own stamp', () => {
    const bare = driveTimeline([
      stepStart(1, { time: 0 }),
      asked(2, 1_000, 'a1'),
      stepEnd(3, { time: 5_000 }),
    ]).state
    assert.equal(bare.requests.length, 0)
    assert.equal(bare.timing?.wallMs, 5_000)
    const { state } = driveTimeline([
      ...step(1, 0, 1_000, { tokenMs: 200 }),
      stepStart(4, { time: 10_000 }),
      stepEnd(5, { time: 12_000 }),
    ])
    assert.equal(state.requests.length, 1)
    assert.equal(state.requests[0].activeMs, 5_000, 'the first step\'s own window (0→5000)')
  })

  test('approval events outside a step, without ids, or naming no armed ask are uninteresting', () => {
    const { state } = driveTimeline([])
    assertStable(state, asked(1, 0, 'a1'))
    assertStable(state, decided(2, 1_000, 'a1'))
    const inside = driveTimeline([stepStart(1, { time: 0 })]).state
    assertStable(inside, { type: 'approval/asked', seq: 2, time: 100, data: {} })
    const armed = driveTimeline([stepStart(1, { time: 0 }), asked(2, 100, 'a1')]).state
    assertStable(armed, decided(3, 200, 'ghost'))
    assertStable(armed, { type: 'approval/decided', seq: 4, time: 300, data: {} })
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
    assert.deepEqual([state.timing?.speedMs, state.timing?.speedTokens], [2_900, 1_200])
  })

  test('usage alone pairs nothing — no token stamp, or no readable output bucket', () => {
    const unstamped = driveTimeline([
      { type: 'step/start', seq: 1, time: 0 },
      assistantMessage(2, { time: 1_000, usage: { outputTokens: 500 } }),
      { type: 'step/end', seq: 3, time: 2_000 },
    ]).state
    assert.deepEqual([unstamped.timing?.speedMs, unstamped.timing?.speedTokens], [undefined, undefined])
    const outputless = driveTimeline([
      ...step(1, 10_000, 2_000, { tokenMs: 600, usage: { inputTokens: 5 } }),
    ]).state
    assert.deepEqual([outputless.timing?.speedMs, outputless.timing?.speedTokens, outputless.timing?.genMs], [undefined, undefined, 1_400])
  })
})

describe('timing — the idle carve (eventless stretches price out of the active figure)', () => {
  const chunkAt = (time: number): unknown => chunkRec(time, { type: 'text-delta', text: 'x' })

  test('a post-response eventless stretch leaves no span and books idleMs against the wall', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkAt(100)] }),
      stepEnd(3, { time: 300_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs], [300_000, 299_000])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 1_000 },
    ])
    assert.equal(state.requests[0].activeMs, 300_000, 'the request record keeps its own wait-based figure')
    assert.equal(Object.hasOwn(state, 'stepBeats'), false, 'the heartbeats are step-transient')
  })

  test('the quiet wait before the model response stays active — a sent request is active', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 300_000 }),
      stepEnd(3, { time: 301_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs], [301_000, undefined])
    assert.deepEqual(state.spans, [{ kind: 'other', start: 0, end: 301_000 }])
  })

  test('a quiet long-running tool stays busy — a running tool is active by the same rule as a sent request', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkAt(100)] }),
      { type: 'tool/call', seq: 3, time: 2_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      toolResult(4, { callId: 'c1', content: text('ok'), time: 602_000 }),
      stepEnd(5, { time: 603_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs, state.timing?.toolBusyMs], [603_000, undefined, 600_000])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 2_000 },
      { kind: 'tools', start: 2_000, end: 602_000 },
      { kind: 'other', start: 602_000, end: 603_000 },
    ])
  })

  test('an approval wait carves the busy window: idle total up, busy union down, activeMs unchanged', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream: [chunkAt(200)] }),
      { type: 'tool/call', seq: 3, time: 3_000, data: { callId: 'c1', name: 'bash', arguments: '{}' } },
      { type: 'approval/asked', seq: 4, time: 3_500, data: { id: 'a1', toolName: 'bash' } },
      { type: 'approval/decided', seq: 5, time: 183_500, data: { id: 'a1', outcome: 'allowed-once' } },
      toolResult(6, { callId: 'c1', content: text('ok'), time: 184_000 }),
      stepEnd(7, { time: 185_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs, state.timing?.toolBusyMs, state.timing?.toolsMs], [185_000, 180_000, 1_000, 181_000])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 200 },
      { kind: 'other', start: 200, end: 3_000 },
      { kind: 'tools', start: 3_000, end: 3_500 },
      { kind: 'tools', start: 183_500, end: 184_000 },
      { kind: 'other', start: 184_000, end: 185_000 },
    ])
    assert.equal(state.requests[0].activeMs, 5_000, 'the wait prices out of the request record as before')
  })

  test('an ask_user answer wait prices as idle; the per-call tool sum keeps the parity figure', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream: [chunkAt(200)] }),
      { type: 'tool/call', seq: 3, time: 3_000, data: { callId: 'q1', name: 'ask_user_question', arguments: '{}' } },
      toolResult(4, { callId: 'q1', content: text('answer'), time: 200_000 }),
      stepEnd(5, { time: 201_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs, state.timing?.toolBusyMs], [201_000, 197_000, 0])
    assert.deepEqual(state.timing?.tools, { ask_user_question: { calls: 1, ms: 197_000 } })
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 200 },
      { kind: 'other', start: 200, end: 3_000 },
      { kind: 'other', start: 200_000, end: 201_000 },
    ])
  })

  test('sub-threshold quiet stays overhead and books no idle total', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkAt(100)] }),
      stepEnd(3, { time: 120_000 }),
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs], [120_000, undefined])
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'other', start: 100, end: 120_000 },
    ])
  })

  test('a hostile step instant closes the step with no beats, no carve, and no span', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      { type: 'step/end', seq: 2, time: Number.NaN },
    ])
    assert.deepEqual([state.timing?.wallMs, state.timing?.idleMs], [0, undefined])
    assert.deepEqual(state.spans, [])
    assert.equal(Object.hasOwn(state, 'stepBeats'), false)
  })

  test('a heartbeat flood skips the carve and keeps the wall figure whole', () => {
    const events: TimelineEvent[] = [stepStart(1, { time: 0 })]
    for (let i = 0; i < 1_030; i++) {
      events.push(toolCall(i + 2, { callId: 'c' + i, name: 'bash', time: 1_000 + i }))
    }
    events.push(stepEnd(1_100, { time: 800_000 }))
    const { state } = driveTimeline(events)
    assert.equal(state.stepBeatsFull, undefined, 'the flood flag is step-transient too')
    assert.equal(state.timing?.idleMs, undefined, 'no detection ran, so no idle books')
    assert.equal(state.timing?.wallMs, 800_000)
  })

  test('idle carves accumulate across steps and stay plain JSON', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 1_000, stream: [chunkAt(100)] }),
      stepEnd(3, { time: 300_000 }),
      stepStart(4, { time: 400_000 }),
      assistantMessage(5, { time: 400_500, stream: [chunkAt(400_100)] }),
      stepEnd(6, { time: 400_600 }),
    ])
    assert.deepEqual([drive.state.timing?.wallMs, drive.state.timing?.idleMs], [300_600, 299_000])
    assertPlainJson(drive.state)
    const def = timelineDef({})
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    for (const mid of drive.states) c.stateSchema.parse(structuredClone(mid))
  })
})
