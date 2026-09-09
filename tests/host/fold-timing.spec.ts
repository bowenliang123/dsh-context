// The timing fold (src/host/fold.ts): whole-session durations priced from the
// durable step lifecycle (step/start → assistant/chunk → assistant/message →
// step/end) and the per-call tool durations (tool/call → tool/result via
// callId), plus the bounded per-name tally. No mocks: the real fold runs.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantChunk,
  assistantMessage,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
} from './helpers/events'
import { assertPlainJson, assertStable, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

/** One full step lifecycle at explicit times: start, [first token], message, end. */
function step(seq: number, startMs: number, lmMs: number, opts: { tokenMs?: number; usage?: Record<string, number> } = {}): TimelineEvent[] {
  const events: TimelineEvent[] = [{ type: 'step/start', seq, time: startMs }]
  if (opts.tokenMs !== undefined) {
    events.push(assistantChunk(++seq, { type: 'text-delta', text: 'x' }, { time: startMs + opts.tokenMs }))
  }
  events.push(
    assistantMessage(seq + 1, { time: startMs + lmMs, usage: opts.usage as never }),
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
    // The first step's token stamp dies with the slot: the second start opens a
    // fresh one, and the token that follows re-stamps IT.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'text-delta', text: 'x' }, { time: 500 }),
      stepStart(3, { time: 10_000 }),
      assistantChunk(4, { type: 'text-delta', text: 'y' }, { time: 11_000 }),
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
      assistantChunk(2, { type: 'text-delta', text: 'x' }, { time: 5_000 }),
      assistantMessage(3, { time: 5_000 }),
      { type: 'step/end', seq: 4, time: 6_000 },
    ])
    assert.equal(state.timing?.ttftMs, 0)
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.wallMs, 0)
    assert.equal(state.timing?.calls, 1)
  })

  test('timing-bearing states stay plain JSON — stamped slot included', () => {
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
      stepEnd(7, { time: 30_000 })])
    const copy = assertPlainJson(drive.state)
    assert.ok((copy.timing?.toolsMs ?? 0) > 0)
    // The intermediate stamped-slot state rode through too.
    const stamped = drive.states.find(s => s.stepStart?.firstToken !== undefined)
    assert.ok(stamped !== undefined)
    assertPlainJson(stamped)
  })
})

describe('timing — the first-token stamp', () => {
  test('only the FIRST token delta stamps the slot', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'text-delta', text: 'x' }, { time: 600 }),
      assistantChunk(3, { type: 'reasoning-delta', text: 'y' }, { time: 1_000 }),
      assistantMessage(4, { time: 2_000 }),
    ])
    assert.equal(state.timing?.ttftMs, 600)
    assert.equal(state.timing?.genMs, 1_400)
  })

  test('a stamped chunk changes the state; later chunks are uninteresting', () => {
    const { state, def } = driveTimeline([stepStart(1, { time: 0 })])
    const stamped = def.apply(state, assistantChunk(2, { type: 'text-delta', text: 'x' }, { time: 100 }))
    assert.notEqual(stamped, state)
    assert.equal(stamped.stepStart?.firstToken, 100)
    assertStable(stamped, assistantChunk(3, { type: 'text-delta', text: 'more' }, { time: 200 }), def)
  })

  test('chunks outside an open step are uninteresting', () => {
    const { state } = driveTimeline([])
    assertStable(state, assistantChunk(1, { type: 'text-delta', text: 'x' }))
  })

  test('marking deltas: non-empty text, reasoning, and tool-call shapes stamp', () => {
    for (const chunk of [
      { type: 'text-delta', text: 'x' },
      { type: 'reasoning-delta', text: '…' },
      { type: 'tool-call-delta', argumentsDelta: '{' },
      { type: 'tool-call-delta', argumentsDelta: '', name: 'bash' },
    ]) {
      const { state } = driveTimeline([
        stepStart(1, { time: 0 }),
        assistantChunk(2, chunk, { time: 400 }),
        assistantMessage(3, { time: 900 }),
      ])
      assert.equal(state.timing?.ttftMs, 400, JSON.stringify(chunk))
      assert.equal(state.timing?.genMs, 500, JSON.stringify(chunk))
    }
  })

  test('non-token chunks never stamp (the call stays unattributed)', () => {
    for (const chunk of [
      null,
      'text-delta',
      5,
      {},
      { type: 'text-delta' },
      { type: 'text-delta', text: '' },
      { type: 'text-delta', text: 7 },
      { type: 'reasoning-delta', text: '' },
      { type: 'tool-call-delta', argumentsDelta: '' },
      { type: 'tool-call-delta', argumentsDelta: 3 },
      { type: 'usage' },
    ]) {
      const { state, def } = driveTimeline([stepStart(1, { time: 0 })])
      assertStable(state, assistantChunk(2, chunk, { time: 400 }), def)
      def.apply(state, assistantChunk(2, chunk, { time: 400 }))
      const done = driveTimeline([
        stepStart(1, { time: 0 }),
        assistantChunk(2, chunk, { time: 400 }),
        assistantMessage(3, { time: 900 }),
      ])
      assert.equal(done.state.timing?.ttftMs, 0, JSON.stringify(chunk))
      assert.equal(done.state.timing?.genMs, 0, JSON.stringify(chunk))
      assert.equal(done.state.timing?.calls, 1)
    }
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

  test('repeated names accumulate; the block-id fallback prices too', () => {
    const call = (seq: number, callId: string, time: number): TimelineEvent => ({
      type: 'tool/call', seq, time, data: { callId, name: 'bash', arguments: '{}' },
    })
    const blockResult: TimelineEvent = {
      type: 'tool/result', seq: 5, time: 9_000,
      data: {
        callId: 'x',
        message: {
          source: { kind: 'tool', callId: 'x' },
          content: [{ type: 'tool-result', toolCallId: 'c2', content: text('ok') }],
        },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([
      call(1, 'c1', 1_000),
      toolResult(2, { callId: 'c1', content: text('ok'), time: 3_000 }),
      call(4, 'c2', 5_000),
      blockResult,
    ])
    assert.equal(state.timing?.toolsMs, 2_000 + 4_000)
    assert.deepEqual(state.timing?.tools, { bash: { calls: 2, ms: 6_000 } })
  })

  test('an unpaired result carries no duration and no tally', () => {
    const { state } = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(state.timing, undefined)
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
    for (let i = 0; i < 17; i++) {
      // Tool 't0' is the cheapest (100ms); every later tool is costlier, so
      // the cap eviction must repeatedly drop 't0'… until it returns with a
      // heavier call — model a unique heavy tool per round instead.
      events.push({ type: 'tool/call', seq: seq++, time: i * 1_000, data: { callId: 'c' + i, name: 't' + i, arguments: '{}' } })
      events.push(toolResult(seq++, { callId: 'c' + i, content: text('ok'), time: i * 1_000 + (i === 0 ? 100 : 5_000) }))
    }
    // Feed the cheapest call LAST so the eviction path must drop it.
    const { state } = driveTimeline(events)
    assert.equal(Object.keys(state.timing?.tools ?? {}).length, 16)
    assert.equal(state.timing?.tools.t0, undefined, 'the cheapest tally left the ranking')
  })

  test('a new name past the cap evicts the current minimum, not itself', () => {
    const events: TimelineEvent[] = []
    let seq = 1
    // 16 established tools at 5s each.
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
  /** A block-start marker for the V0 `assistant/chunk` flood. */
  const blockStart = (seq: number, blockType: string, time: number): TimelineEvent =>
    assistantChunk(seq, { type: 'block-start', index: 0, blockType }, { time })

  test('V0: block markers tile the generation window into the three buckets', () => {
    // step start 0, first token 200, blocks reasoning→text→tool-call, message at 2000.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'reasoning-delta', text: 'x' }, { time: 200 }),
      blockStart(3, 'reasoning', 200),
      blockStart(4, 'text', 700),
      blockStart(5, 'tool-call', 1_200),
      assistantMessage(6, { time: 2_000 }),
    ])
    assert.equal(state.timing?.ttftMs, 200)
    assert.equal(state.timing?.genMs, 1_800)
    assert.equal(state.timing?.reasoningMs, 500, 'reasoning owns 200→700')
    assert.equal(state.timing?.textMs, 500, 'text owns 700→1200')
    assert.equal(state.timing?.toolArgMs, 800, 'tool args own 1200→message')
  })

  test('V0: the buckets tile the marker span (they account for the generation window)', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'reasoning-delta', text: 'x' }, { time: 100 }),
      blockStart(3, 'reasoning', 100),
      blockStart(4, 'text', 400),
      assistantMessage(5, { time: 900 }),
    ])
    const t = state.timing
    // The first marker opens at the first token here, so the tile is exact.
    assert.equal((t?.reasoningMs ?? 0) + (t?.textMs ?? 0) + (t?.toolArgMs ?? 0), t?.genMs)
    assert.equal(t?.genMs, 800)
  })

  test('an unstamped call carries no split (its model time is unattributed wholesale)', () => {
    // Block markers but no token delta: the call prices no generation time,
    // so its spans must not reappear as generation the caller never charged.
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      blockStart(2, 'reasoning', 100),
      blockStart(3, 'text', 400),
      assistantMessage(4, { time: 900 }),
    ])
    assert.equal(state.timing?.genMs, 0)
    assert.equal(state.timing?.reasoningMs, undefined)
    assert.equal(state.timing?.textMs, undefined)
  })

  test('V0: an unknown block marker closes the open block but opens nothing', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'reasoning-delta', text: 'x' }, { time: 100 }),
      blockStart(3, 'reasoning', 100),
      blockStart(4, 'image', 500),
      assistantMessage(5, { time: 900 }),
    ])
    assert.equal(state.timing?.reasoningMs, 400, 'the reasoning span ends at the unknown marker')
    assert.equal(state.timing?.textMs, undefined)
    assert.equal(state.timing?.toolArgMs, undefined)
  })

  test('V0: a marker before any open block starts a span; hostile times clamp', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      // An unknown marker with nothing open is entirely uninteresting.
      blockStart(2, 'image', 100),
      blockStart(3, 'reasoning', 200),
      // A non-finite marker time poisons only its OWN span: the reasoning
      // block closes to a zero span and the text block it opens can never be
      // priced — both stay absent rather than reporting a bogus duration.
      assistantChunk(4, { type: 'block-start', index: 0, blockType: 'text' }, { time: Number.NaN }),
      assistantMessage(5, { time: 900 }),
    ])
    assert.equal(state.timing?.reasoningMs, undefined)
    assert.equal(state.timing?.textMs, undefined)
  })

  test('a chunk with no open step stays uninteresting for the split too', () => {
    const { state, def } = driveTimeline([])
    assertStable(state, assistantChunk(1, { type: 'block-start', blockType: 'text' }))
    assert.equal(def.apply(state, assistantChunk(1, { type: 'block-start', blockType: 'text' })), state)
  })

  test('V2+: the embedded stream supplies the spans (no chunk events)', () => {
    const stream = [
      { type: 'chunk', time: 200, chunk: { type: 'block-start', blockType: 'reasoning' } },
      { type: 'reasoning-chunks', time0: 210, index: 0, dt: [], texts: ['think'] },
      { type: 'chunk', time: 700, chunk: { type: 'block-start', blockType: 'text' } },
      { type: 'text-chunks', time0: 710, index: 1, dt: [], texts: ['answer'] },
      { type: 'chunk', time: 1_200, chunk: { type: 'block-start', blockType: 'tool-call' } },
      { type: 'tool-call-chunks', time0: 1_210, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ]
    const { state } = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantMessage(2, { time: 2_000, stream }),
    ])
    // TTFT reads the first TOKEN (the reasoning run at 210), while the spans
    // tile from the block-start markers (200 onward).
    assert.equal(state.timing?.ttftMs, 210)
    assert.equal(state.timing?.genMs, 1_790)
    assert.equal(state.timing?.reasoningMs, 500)
    assert.equal(state.timing?.textMs, 500)
    assert.equal(state.timing?.toolArgMs, 800)
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
  })

  test('split totals accumulate across steps and stay plain JSON', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'reasoning-delta', text: 'x' }, { time: 100 }),
      assistantChunk(3, { type: 'block-start', blockType: 'reasoning' }, { time: 100 }),
      assistantChunk(4, { type: 'block-start', blockType: 'text' }, { time: 300 }),
      assistantMessage(5, { time: 500 }),
      stepEnd(6, { time: 600 }),
      stepStart(7, { time: 10_000 }),
      assistantChunk(8, { type: 'reasoning-delta', text: 'y' }, { time: 10_100 }),
      assistantChunk(9, { type: 'block-start', blockType: 'reasoning' }, { time: 10_100 }),
      assistantMessage(10, { time: 10_400 }),
      stepEnd(11, { time: 10_500 }),
    ])
    assert.equal(drive.state.timing?.reasoningMs, 200 + 300)
    assert.equal(drive.state.timing?.textMs, 200)
    assertPlainJson(drive.state)
  })

  test('the generation split rides the wire view as plain values', () => {
    const drive = driveTimeline([
      stepStart(1, { time: 0 }),
      assistantChunk(2, { type: 'reasoning-delta', text: 'x' }, { time: 100 }),
      assistantChunk(3, { type: 'block-start', blockType: 'reasoning' }, { time: 100 }),
      assistantMessage(4, { time: 400 }),
    ])
    assert.equal(drive.view.timing?.reasoningMs, 300)
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

  test('the persisted-state schema accepts the timing shape (stamped slot included)', () => {
    const def = timelineDef({})
    const drive = driveTimeline([...step(1, 0, 1_000, { tokenMs: 300 }),
      toolCall(5, { callId: 'c1', name: 'bash' }),
      toolResult(6, { callId: 'c1', content: text('ok') }),
      stepEnd(7, { time: 30_000 })])
    // The 0.1.1+ contract validates persisted state through stateSchema.
    const c = def as unknown as { stateSchema: { parse(s: unknown): unknown } }
    for (const state of drive.states) c.stateSchema.parse(structuredClone(state)) // throws on drift
  })
})
