import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { applyTimeline } from '../../src/host/fold'
import { createTimelineState } from '../../src/host/foldState'
import { resolveBounds } from '../../src/host/config'
import {
  assistantMessage, codeDispatch, codeDispatchStart, compaction, endSeed, header, stepEnd, stepStart,
  toolCall, toolResult, userMessage,
} from './helpers/events'
import { driveTimeline, noopSink } from './helpers/projection'

const text = (value: string) => [{ type: 'text', text: value }]

const MARKERS = 'body\n[output truncated; 3 lines]\n[stderr]\nwarning'

describe('fold sink coverage', () => {
  test('header rows accept an absent reason, hostile tools, missing names and empty plugins', () => {
    const event = {
      type: 'request/header',
      seq: 1,
      time: 1,
      data: {
        header: {
          config: { model: 'm' },
          tools: [null, 7, { name: 42 }, { name: 'plain' }, { name: 'empty', plugin: '' }, { name: 'named', plugin: 'plug' }],
        },
      },
    } as unknown as TimelineEvent
    const { state } = driveTimeline([event])
    assert.equal(state.toolsTokens > 0, true)
  })

  test('a prune shadow updates its own event without gross tokens', () => {
    const { state } = driveTimeline([
      userMessage(1, text('first')),
      compaction(2, 'prune', { shadowedTokenCount: 1, shadowedSeqs: [1] }),
      userMessage(3, text('second'), null, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.equal(state.events[0].kind, 'prune')
    assert.equal(state.events[0].grossTokens, undefined)
  })

  test('truncation and stderr markers reach both result paths', () => {
    driveTimeline([
      toolCall(1, { callId: 'read-1', name: 'read', arguments: '{}' }),
      toolResult(2, { callId: 'read-1', content: text(MARKERS) }),
    ])
    driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'read', arguments: {} }),
      codeDispatch(3, {
        rootCallId: 'rc1', subCallId: 'rc1:ptc:0', name: 'read', arguments: {}, content: text(MARKERS),
      }),
      toolResult(4, { callId: 'rc1', content: text(MARKERS) }),
    ])
  })

  test('a dispatch without a name still consumes the start', () => {
    driveTimeline([
      toolCall(1, { callId: 'rc1', name: 'run_code', arguments: JSON.stringify({ code: 'x' }) }),
      codeDispatchStart(2, { rootCallId: 'rc1', subCallId: 'rc1:ptc:0' }),
    ])
  })

  test('step rows carry an optional turn and step', () => {
    const { state } = driveTimeline([
      { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 0 } } as unknown as TimelineEvent,
    ])
    assert.equal(state.stepSeq, 1)
  })

  test('a span flush without a sink falls back to the stored sequence', () => {
    const events: TimelineEvent[] = [
      header(1, { model: 'm' }),
      stepStart(2, { time: 1_000 }),
      assistantMessage(3, {
        turn: 1,
        step: 0,
        time: 2_000,
        stream: [
          { type: 'chunk', time: 1_100, chunk: { type: 'block-start', blockType: 'reasoning' } },
          { type: 'chunk', time: 1_500, chunk: { type: 'block-start', blockType: 'text' } },
        ],
      }),
      stepEnd(4, { time: 3_000 }),
    ]
    const bounds = resolveBounds({})
    let state = createTimelineState()
    for (const event of events) state = applyTimeline(state, event, bounds)
    assert.equal((state.spans?.length ?? 0) > 0, true)
  })

  test('an inherited request does not add to billed tokens', () => {
    const { state } = driveTimeline([
      header(1, { model: 'm' }),
      assistantMessage(2, { usage: { inputTokens: 10, outputTokens: 5 } }),
      endSeed(3, { inherited: true }),
      assistantMessage(4, { usage: { inputTokens: 7, outputTokens: 3 } }),
    ])
    assert.equal(state.billedTokens, 10)
  })

  test('a legacy state without counters starts both from zero', () => {
    let state = createTimelineState()
    delete (state as { nextSpanSeq?: number }).nextSpanSeq
    delete (state as { billedTokens?: number }).billedTokens
    const events: TimelineEvent[] = [
      header(1, { model: 'm' }),
      stepStart(2, { time: 1_000 }),
      assistantMessage(3, {
        usage: { inputTokens: 10, outputTokens: 5 },
        time: 2_000,
        stream: [
          { type: 'chunk', time: 1_100, chunk: { type: 'block-start', blockType: 'reasoning' } },
          { type: 'chunk', time: 1_500, chunk: { type: 'block-start', blockType: 'text' } },
        ],
      }),
      stepEnd(4, { time: 3_000 }),
    ]
    const bounds = resolveBounds({})
    for (const event of events) state = applyTimeline(state, event, bounds, noopSink)
    assert.equal(state.billedTokens, 15)
    assert.equal((state.spans?.length ?? 0) > 0, true)
  })
})
