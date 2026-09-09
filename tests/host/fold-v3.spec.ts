// The V3 log generation (dsh 0.1.5-alpha.x+): `system/message` surface nodes,
// the embedded assistant stream that replaced `assistant/chunk`, the
// `startSeq`/`endSeq` replacement endpoints, `tool/ptc-dispatch`, and
// `assistant/attempt`. Each case is the generation seam the fold must read
// alongside the V0 shapes (tests/host/fold-surface.spec.ts and
// fold-timing.spec.ts pin those), plus the hostile shapes the durable log may
// carry. No mocks: the real fold runs.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { estimateSystemContent } from '../../src/shared/estimate'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantAttempt,
  assistantMessage,
  codeDispatch,
  header,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events'
import { assertStable, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

/** One raw stream record carrying a token delta at `time`. */
const token = (time: number, t = 'x') => ({ type: 'chunk', time, chunk: { type: 'text-delta', text: t } })

describe('V3 system/message — the system prompt as a surface node', () => {
  test('an appended system prompt prices into systemTokens and the request total', () => {
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
    assert.equal(state.requests[0].system, price, 'the request record snapshots the prompt in force')
    assert.deepEqual(view.systems, [{ seq: 2, time: 2000, tokens: price }], 'the wire carries the live prompt nodes')
    assert.equal(view.current.total, price + state.sums.user + state.sums.assistant, 'the prompt joins the composition total')
  })

  test('a system-less request header never clears log-sourced nodes (V3 headers carry no prompt)', () => {
    const prompt = 'prompt '.repeat(10)
    const { state } = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text(prompt) } }, surfaceOp: 'append' },
      header(2, { tools: [] }),
      header(3, { tools: [] }),
    ])
    assert.equal(state.systemTokens, estimateSystemContent(text(prompt)))
    assert.equal(state.systems?.length, 1)
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

  test('a replacement over the head swaps the node and reprices (V3 startSeq/endSeq)', () => {
    const first = 'first '.repeat(10)
    const second = 'second prompt text '.repeat(10)
    const { state, view } = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text(first) } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text(second) } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    ])
    assert.deepEqual(state.systems, [{ seq: 2, time: 2000, tokens: estimateSystemContent(text(second)) }])
    assert.equal(state.systemTokens, estimateSystemContent(text(second)))
    assert.deepEqual(view.systems, state.systems)
  })

  test('a replacement that also claims ordinary surface nodes removes them (hostile log)', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa'), { kind: 'user' }),
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text('p') } }, surfaceOp: 'append' },
      userMessage(3, text('bbbb'), { kind: 'user' }),
      userMessage(9, text('cccc'), { kind: 'user' }),
      { type: 'system/message', seq: 10, time: 3000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 } },
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [9], 'the claimed nodes left the surface, the later one stayed')
    assert.equal(state.sums.user, state.surface.reduce((sum, n) => sum + n.tokens, 0))
    assert.deepEqual(state.archived.map(n => [n.seq, n.gone]), [[1, 10], [3, 10]])
    assert.deepEqual(state.systems, [{ seq: 10, time: 3000, tokens: estimateSystemContent(text('q')) }])
  })

  test('a system replacement leaves system nodes outside its range intact', () => {
    const { state } = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: { message: { content: text('earlier') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: { content: text('p') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 5, time: 5000, data: { message: { content: text('later prompt') } }, surfaceOp: 'append' },
      { type: 'system/message', seq: 8, time: 8000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } },
    ])
    assert.deepEqual(state.systems?.map(n => n.seq), [1, 5, 8], 'only the claimed node left the list')
    assert.equal(state.systemTokens, estimateSystemContent(text('q')), 'the newest nonempty node is effective')
  })

  test('a system/message expires an armed shadow claim (the shadow-price protocol)', () => {
    // The claim is armed by the metering event and consumed by the NEXT surface
    // event: a system node settling in between must expire it, so a later
    // APPEND does not silently remove the seqs the claim named.
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

  test('a replacement arriving before any system node starts the list', () => {
    const { state } = driveTimeline([
      { type: 'system/message', seq: 4, time: 4000, data: { message: { content: text('q') } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } },
    ])
    assert.deepEqual(state.systems, [{ seq: 4, time: 4000, tokens: estimateSystemContent(text('q')) }])
    assert.equal(state.systemTokens, estimateSystemContent(text('q')))
  })

  test('a malformed payload prices 0 and a non-object message reads as empty', () => {
    const { state } = driveTimeline([
      { type: 'system/message', seq: 1, time: 1000, data: null as never, surfaceOp: 'append' },
      { type: 'system/message', seq: 2, time: 2000, data: { message: 'not-a-record' }, surfaceOp: 'append' },
      { type: 'system/message', seq: 3, time: 3000, data: { message: { content: text('real prompt') } }, surfaceOp: 'append' },
    ])
    assert.deepEqual(state.systems?.map(n => n.tokens), [0, 0, estimateSystemContent(text('real prompt'))])
    assert.equal(state.systemTokens, estimateSystemContent(text('real prompt')))
  })
})

describe('V0/V2 envelope system prompt (regression: the header path stays intact)', () => {
  test('a header carrying a prompt seeds the list; a later system-less header clears it', () => {
    const { state, states } = driveTimeline([
      header(1, { system: 'You are an agent.', tools: [] }),
      header(2, { tools: [] }),
    ])
    assert.equal(states[1].systems?.length, 1, 'the envelope seeded the list')
    assert.deepEqual(state.systems, [], 'the system-less header cleared it (the V0 envelope meaning)')
    assert.equal(state.systemTokens, 0)
  })

  test('a system-less header before any prompt leaves the state untouched', () => {
    const { state } = driveTimeline([header(1, { tools: [] })])
    assert.equal(state.systems, undefined)
    assert.equal(state.systemTokens, 0)
  })

  test('the envelope prompt keeps its price and rides the wire', () => {
    const { state, view } = driveTimeline([header(1, { system: 'You are an agent.', tools: [] })])
    const price = estimateSystemContent(text('You are an agent.'))
    assert.equal(state.systemTokens, price)
    assert.deepEqual(view.systems, [{ seq: 1, time: state.systems?.[0].time, tokens: price }])
  })
})

describe('V2+ embedded assistant stream — the first-token source that replaced assistant/chunk', () => {
  test('a raw chunk record prices TTFT and generation', () => {
    const { state } = driveTimeline([
      stepStart(1, { time: 1000 }),
      assistantMessage(2, { turn: 1, step: 1, stream: [token(1400), token(1500)], usage: { outputTokens: 3 }, time: 3000 }),
      stepEnd(3, { time: 3100 }),
    ])
    assert.equal(state.timing?.ttftMs, 400)
    assert.equal(state.timing?.genMs, 1600)
    assert.equal(state.timing?.wallMs, 2100)
  })

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
    // No slot armed.
    assertStable(def.init(), assistantAttempt(1, { turn: 1, step: 1, stream: [token(100)] }), def)
    // Slot armed but the stream carries no token.
    const armed = def.apply(def.init(), stepStart(1, { time: 1000 }))
    assertStable(armed, assistantAttempt(2, { turn: 1, step: 1, stream: [{ type: 'chunk', time: 1, chunk: { type: 'finish' } }] }), def)
    // Slot already stamped (a V0 chunk got there first).
    const stamped = def.apply(armed, { type: 'assistant/chunk', seq: 2, time: 1200, data: { chunk: { type: 'text-delta', text: 'x' } } })
    assertStable(stamped, assistantAttempt(3, { turn: 1, step: 1, stream: [token(1100)] }), def)
  })
})

describe('V3 vocabulary seams', () => {
  test('tool/ptc-dispatch books nested file ops exactly like tool/code-dispatch', () => {
    const nested = codeDispatch(1, {
      rootCallId: 'c1',
      name: 'read',
      arguments: JSON.stringify({ path: 'src/a.ts' }),
      type: 'tool/ptc-dispatch',
    })
    const { state } = driveTimeline([
      toolCall(0, { callId: 'c1', name: 'run_code', arguments: JSON.stringify({ description: 'inspect' }) }),
      nested,
      toolResult(2, { callId: 'c1', content: text('done') }),
    ])
    assert.deepEqual(state.fileOps.map(op => [op.path, op.kind, op.parent]), [['src/a.ts', 'read', 2]])
    assert.equal(state.fileOps[0].program, 'inspect')
  })

  test('a V3 range replacement (startSeq/endSeq) splices in place', () => {
    const { state } = driveTimeline([
      userMessage(1, text('a'), { kind: 'user' }),
      userMessage(2, text('bbbb'), { kind: 'user' }),
      userMessage(3, text('cc'), { kind: 'user' }),
      userMessage(4, text('summary'), { kind: 'user' }, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [4, 3], 'the replacement takes the span\'s position')
    assert.equal(state.sums.user, state.surface.reduce((sum, n) => sum + n.tokens, 0))
    assert.deepEqual(state.archived.map(n => n.seq), [1, 2])
  })
})
