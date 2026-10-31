import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { buildTimelineDetail } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import { assistantMessage, stepEnd, stepStart, toolResult } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

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
      { kind: 'ttft', start: 0, end: 200 },
      { kind: 'reasoning', start: 200, end: 700 },
      { kind: 'text', start: 700, end: 1_200 },
      { kind: 'toolarg', start: 1_200, end: 2_000 },
      { kind: 'other', start: 2_000, end: 2_500 },
      { kind: 'tools', start: 2_500, end: 3_000 },
      { kind: 'other', start: 3_000, end: 4_000 },
    ])
    assert.equal(Object.hasOwn(state, 'stepStart'), false, 'step/end consumed the pending slot')
    assert.equal(Object.hasOwn(state, 'stepSpans'), false, '…and the span accumulator (never undefined-valued)')
  })

  test('the decode window opens at the first marker when it beats the token; the wait covers only the silent prefix', () => {
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
      { kind: 'ttft', start: 0, end: 100 },
      { kind: 'reasoning', start: 100, end: 900 },
      { kind: 'other', start: 900, end: 1_000 },
    ])
  })

  test('a redacted reasoning block still paints: the marker tiles its window even though no chunk stamps a token', () => {
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
      [state.timing?.ttftMs, state.timing?.genMs, state.timing?.reasoningMs],
      [364, 699, 588],
      'the wait and generation open at the first marker; the tally tiles that window regardless',
    )
    assert.equal(
      (state.timing?.reasoningMs ?? 0) + (state.timing?.textMs ?? 0) + (state.timing?.toolArgMs ?? 0),
      state.timing?.genMs,
      'the decode buckets partition the generation window exactly — no double count',
    )
    assert.deepEqual(state.spans, [
      { kind: 'ttft', start: 0, end: 364 },
      { kind: 'reasoning', start: 364, end: 952 },
      { kind: 'toolarg', start: 952, end: 1_063 },
      { kind: 'other', start: 1_063, end: 1_064 },
      { kind: 'tools', start: 1_064, end: 1_095 },
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

  test('every intermediate state stays plain JSON and validates; the head state parses without its detail arrays', () => {
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
    const head = structuredClone(drive.state) as unknown as Record<string, unknown>
    delete head.spans
    delete head.fileOps
    delete head.events
    assert.doesNotThrow(() => drive.def.stateSchema.parse(head), 'a persisted head omits the detail collections')
    const broken = structuredClone(drive.state) as unknown as Record<string, unknown>
    delete broken.surface
    assert.throws(() => drive.def.stateSchema.parse(broken))
  })
})
