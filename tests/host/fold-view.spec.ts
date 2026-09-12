// Wire-view tests for buildTimelineView (src/host/fold.ts): counters,
// non-aliasing copies, the cost buckets, the serving window (newest tail +
// pinned injects + coverage floors), event→request attribution, and view
// purity. Driven through the real projection unit (driveTimeline / def.wire.view).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createTimelineState } from '../../src/host/fold'
import type { CostBucketTotals, SessionCostUsage, SurfaceNode } from '../../src/shared/types'
import { assistantMessage, header, planMode, requestContext, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

const bucket = (uncached: number, cacheRead: number, cacheWrite: number, output: number): CostBucketTotals =>
  ({ uncached, cacheRead, cacheWrite, output })

describe('buildTimelineView unknown-model shape', () => {
  test('optional scalars stay ABSENT keys until known — never undefined-valued (issue #29)', () => {
    // A fold over events that name no model/provider/capacity: the served
    // view must not carry `undefined`-valued properties, which fail the
    // harness's lossless-JSON push pipeline whole.
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    assert.equal(view.model, undefined)
    assert.equal(view.provider, undefined)
    assert.equal(view.contextWindow, undefined)
    assert.ok(!('model' in view), 'no own `model` key')
    assert.ok(!('provider' in view), 'no own `provider` key')
    assert.ok(!('contextWindow' in view), 'no own `contextWindow` key')
    assertPlainJson(view)
  })

  test('known scalars ride their own keys once a request names them', () => {
    const { view } = driveTimeline([
      header(1, { system: 'sys', config: { model: 'deepseek-v4-flash', provider: 'deepseek' } }),
      requestContext(2, { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 128000 }),
      userMessage(3, [{ type: 'text', text: 'hi' }]),
    ])
    assert.equal(view.model, 'deepseek-v4-flash')
    assert.equal(view.provider, 'deepseek')
    assert.equal(view.contextWindow, 128000)
    assertPlainJson(view)
  })
})

describe('buildTimelineView counters', () => {
  test('images sums per-node image counts, absent counting as zero', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
      userMessage(2, [{ type: 'text', text: 'no image here' }]),
    ])
    assert.equal(view.images, 1)
  })

  test('toolCalls counts live tool-result nodes only', () => {
    const { view } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
      userMessage(3, [{ type: 'text', text: 'hi' }]),
    ])
    assert.equal(view.toolCalls, 1)
  })

  test('humanInputs tallies the user\'s own messages, injections excluded', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      userMessage(2, [{ type: 'text', text: 'again' }]),
      userMessage(3, [{ type: 'text', text: 'AGENTS.md' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(4, [{ type: 'text', text: '/skill' }], { kind: 'skill-invocation', name: 's' }),
      userMessage(5, [{ type: 'image', attachment: { width: 8, height: 8 } }], { kind: 'user' }),
    ])
    assert.equal(view.humanInputs, 3)
  })

  test('an answered ask_user_question result is a human input; other tool results are not', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'go' }], { kind: 'user' }),
      toolCall(2, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(3, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["x"]}]}' }] }),
      toolCall(4, { callId: 'b1', name: 'bash' }),
      toolResult(5, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }),
      toolCall(6, { callId: 'q2', name: 'ask_user_question' }),
      toolResult(7, { callId: 'q2', content: [{ type: 'text', text: '{"answers":[{"id":"b","selected":["y"]}]}' }] }),
    ])
    assert.equal(view.humanInputs, 3)
  })

  test('an unpaired or ask-user result without its call event counts nothing', () => {
    const { view } = driveTimeline([
      toolResult(1, { callId: 'ghost', content: [{ type: 'text', text: 'lost my call event' }] }),
      userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
    ])
    assert.equal(view.humanInputs, 1)
  })

  test('an answered question starts the tally without a preceding user message', () => {
    const { view } = driveTimeline([
      toolCall(1, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(2, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["y"]}]}' }] }),
    ])
    assert.equal(view.humanInputs, 1)
  })

  test('humanInputs stays ABSENT until the first human input — never undefined-valued', () => {
    const { state, view } = driveTimeline([
      toolCall(1, { callId: 'b1', name: 'bash' }),
      toolResult(2, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }),
      planMode(3, { active: true }),
    ])
    assert.equal(view.humanInputs, 0)
    assert.ok(!('humanInputs' in state), 'no own key on the persisted state')
    assertPlainJson(state)
  })
})

describe('buildTimelineView copies', () => {
  test('requests, events, and archive entries are copies, never state aliases', () => {
    const { state, view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 1, step: 1 }),
    ])
    assert.notEqual(view.requests[0], state.requests[0])
    assert.deepEqual(view.requests[0], state.requests[0])
    // Event copies are stamped with request attribution, so they differ by
    // value — what matters is that they never alias the persisted records.
    assert.notEqual(view.events[0], state.events[0])
    // Mutating the served view must not leak into the persisted state.
    view.requests[0].total = -1
    view.events[0].name = 'mutated'
    assert.notEqual(state.requests[0].total, -1)
    assert.notEqual(state.events[0].name, 'mutated')
  })

  test('archive entries are copies too', () => {
    const { state, view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      userMessage(2, [{ type: 'text', text: 'b' }], undefined, { surfaceOp: { op: 'replace', start: 1, end: 1 } }),
    ])
    assert.equal(view.archive.length, 1)
    assert.notEqual(view.archive[0], state.archived[0])
    assert.deepEqual(view.archive[0], state.archived[0])
  })
})

describe('buildTimelineView cost copy', () => {
  test('a folded cost rides the wire as a detached copy', () => {
    // Mon 2024-01-01 02:00 UTC — a DeepSeek peak window.
    const { state, view } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek-official' }),
      assistantMessage(2, {
        turn: 1,
        step: 1,
        usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 10 },
        time: Date.UTC(2024, 0, 1, 2, 0, 0),
      }),
    ])
    assert.deepEqual<SessionCostUsage>(view.cost, {
      'deepseek-official': { 'deepseek-v4-flash': { peak: bucket(100, 20, 5, 10) } },
    })
    assert.notEqual(view.cost, state.cost)
    assert.notEqual(
      view.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak,
      state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak,
    )
    assert.equal(view.cost?.['kimi-coding'], undefined, 'an absent provider stays absent')
  })

  test('every provider, model, and period branch copies through', () => {
    const st = createTimelineState()
    st.cost = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(1, 0, 0, 2) },
        'deepseek-v4-pro': { peak: bucket(3, 0, 0, 4), off: bucket(5, 0, 6, 0) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(7, 8, 0, 9) } },
      '': { 'mystery-model': { peak: bucket(8, 0, 9, 10) } },
    }
    const view = timelineDef({}).wire.view(st)
    assert.deepEqual<SessionCostUsage | undefined>(view.cost, st.cost)
    assert.notEqual(view.cost?.['deepseek-official'], st.cost['deepseek-official'])
    assert.notEqual(view.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak, st.cost['deepseek-official']['deepseek-v4-flash'].peak)
    assert.notEqual(view.cost?.['deepseek-official']?.['deepseek-v4-pro']?.off, st.cost['deepseek-official']['deepseek-v4-pro'].off)
    assert.notEqual(view.cost?.['kimi-coding']?.['kimi-k2.7-code']?.peak, st.cost['kimi-coding']['kimi-k2.7-code'].peak)
    assert.notEqual(view.cost?.['']?.['mystery-model']?.peak, st.cost['']['mystery-model'].peak)
  })

  test('no cost in state omits the wire field entirely', () => {
    const view = timelineDef({}).wire.view(createTimelineState())
    assert.equal('cost' in view, false)
  })
})

describe('buildTimelineView serving window', () => {
  test('overflow drops the oldest non-inject nodes and floors the newest dropped seq', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'injected' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(2, [{ type: 'text', text: 'x1' }]),
      userMessage(3, [{ type: 'text', text: 'x2' }]),
      userMessage(4, [{ type: 'text', text: 'x3' }]),
      userMessage(5, [{ type: 'text', text: 'x4' }]),
    ], { maxNodes: 2 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 4, 5], 'the out-of-window inject is pinned ahead of the tail')
    assert.equal(view.droppedNodes, 2, 'pinned injects are not counted as dropped')
    assert.equal(view.surfaceFloor, 3, 'the floor is the newest unserved non-inject seq')
  })

  test('without overflow the served nodes are a plain tail copy', () => {
    const { state, view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }]),
      userMessage(2, [{ type: 'text', text: 'b' }]),
    ], { maxNodes: 4 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 2])
    assert.notEqual(view.nodes, state.surface, 'the served slice never aliases the surface')
    assert.equal(view.droppedNodes, 0)
    assert.equal('surfaceFloor' in view, false)
    assert.equal('archiveFloor' in view, false)
  })

  test('an overflow made only of injects drops nothing and sets no floor', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'i1' }], { kind: 'plugin', form: 'context', plugin: 'p1' }),
      userMessage(2, [{ type: 'text', text: 'i2' }], { kind: 'goal' }),
    ], { maxNodes: 1 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 2], 'every inject is pinned')
    assert.equal(view.droppedNodes, 0)
    assert.equal('surfaceFloor' in view, false)
  })

  test('archiveFloor rides through when the state carries one', () => {
    const st = createTimelineState()
    st.archiveFloor = 7
    assert.equal(timelineDef({}).wire.view(st).archiveFloor, 7)
  })
})

describe('buildTimelineView event attribution', () => {
  test('an event before the first request takes the next side only', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'notice', plugin: 'p', summary: 'hi' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    const ev = view.events[0]
    assert.equal(ev.kind, 'inject')
    assert.equal(ev.turn, 1)
    assert.equal(ev.step, 1)
    assert.equal(ev.fromTurn, undefined)
    assert.equal(ev.fromStep, undefined)
  })

  test('an event between two requests of one turn takes both sides', () => {
    const { view } = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 1, step: 2 }),
    ])
    const ev = view.events[0]
    assert.equal(ev.turn, 1)
    assert.equal(ev.step, 2)
    assert.equal(ev.fromTurn, 1)
    assert.equal(ev.fromStep, 1)
  })

  test('an event between requests of different turns names the turn boundary', () => {
    const { view } = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 2, step: 1 }),
    ])
    const ev = view.events[0]
    assert.equal(ev.fromTurn, 1)
    assert.equal(ev.turn, 2)
    assert.notEqual(ev.fromTurn, ev.turn)
  })

  test('an event after the last request takes the previous side only', () => {
    const { view } = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      planMode(2, { active: false }),
    ])
    const ev = view.events[0]
    assert.equal(ev.turn, undefined)
    assert.equal(ev.step, undefined)
    assert.equal(ev.fromTurn, 1)
    assert.equal(ev.fromStep, 1)
  })

  test('an event with no requests at all takes neither side', () => {
    const { view } = driveTimeline([planMode(1, { active: true })])
    const ev = view.events[0]
    assert.equal(ev.turn, undefined)
    assert.equal(ev.fromTurn, undefined)
  })

  test('a turn-less next request (replay shape) stamps no turn/step', () => {
    const { view } = driveTimeline([
      planMode(1, { active: true }),
      assistantMessage(2, {}), // no turn/step: a replayed log row
    ])
    const ev = view.events[0]
    assert.equal(ev.turn, undefined)
    assert.equal(ev.step, undefined)
  })

  test('a next request with a turn but no step stamps no turn/step', () => {
    const { view } = driveTimeline([
      planMode(1, { active: true }),
      assistantMessage(2, { turn: 3 }),
    ])
    assert.equal(view.events[0].turn, undefined)
  })

  test('a turn-less previous request stamps no from-side', () => {
    const { view } = driveTimeline([
      assistantMessage(1, {}), // no turn/step: a replayed log row
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 1, step: 1 }),
    ])
    const ev = view.events[0]
    assert.equal(ev.fromTurn, undefined)
    assert.equal(ev.fromStep, undefined)
    assert.equal(ev.turn, 1)
    assert.equal(ev.step, 1)
  })

  test('a previous request with a turn but no step stamps no from-side', () => {
    const { view } = driveTimeline([
      assistantMessage(1, { turn: 7 }),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 8, step: 1 }),
    ])
    const ev = view.events[0]
    assert.equal(ev.fromTurn, undefined)
    assert.equal(ev.turn, 8)
  })
})

describe('buildTimelineView purity', () => {
  test('repeated views are deep-equal but distinct, and the state is untouched', () => {
    const { def, state } = driveTimeline([
      header(1, { model: 'm', provider: 'p' }),
      userMessage(2, [{ type: 'text', text: 'a' }]),
      assistantMessage(3, { turn: 1, step: 1, usage: { inputTokens: 5, outputTokens: 2 } }),
    ])
    const before = assertPlainJson(state)
    const v1 = def.wire.view(state)
    const v2 = def.wire.view(state)
    assert.notEqual(v1, v2)
    assert.notEqual(v1.nodes, v2.nodes)
    assert.notEqual(v1.requests, v2.requests)
    assert.deepEqual(v1, v2)
    assert.deepEqual(assertPlainJson(state), before, 'view() must not mutate the persisted state')
  })
})

describe('buildTimelineView envelope', () => {
  test('ok/model/provider/contextWindow pass through when known', () => {
    const { view } = driveTimeline([
      header(1, { model: 'deepseek-v4', provider: 'deepseek' }),
      requestContext(2, { contextWindow: 128000 }),
    ])
    assert.equal(view.ok, true)
    assert.equal(view.model, 'deepseek-v4')
    assert.equal(view.provider, 'deepseek')
    assert.equal(view.contextWindow, 128000)
  })

  test('unknown route fields read as undefined', () => {
    const { view } = driveTimeline([planMode(1, { active: true })])
    assert.equal(view.ok, true)
    assert.equal(view.model, undefined)
    assert.equal(view.provider, undefined)
    assert.equal(view.contextWindow, undefined)
  })
})
