import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystemContent } from '../../src/shared/estimate'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantAttempt,
  assistantMessage,
  header,
  stepEnd,
  stepStart,
  userMessage,
} from './helpers/events'
import { assertStable, driveTimeline, requestsOf, timelineDef } from './helpers/projection'

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
