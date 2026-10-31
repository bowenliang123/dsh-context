import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createTimelineState } from '../../src/host/fold'
import type { CostBucketTotals, SessionCostUsage, SurfaceNode } from '../../src/shared/types'
import { assistantMessage, header, planMode, requestContext, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

const bucket = (uncached: number, cacheRead: number, cacheWrite: number, output: number): CostBucketTotals =>
  ({ uncached, cacheRead, cacheWrite, output })

describe('the full fold view unknown-model shape', () => {
  test('optional scalars stay ABSENT keys until known, then ride their own keys (issue #29)', () => {
    const unknown = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      assistantMessage(2, { turn: 1, step: 1 }),
    ]).view
    assert.equal(unknown.ok, true)
    assert.ok(!('model' in unknown), 'no own `model` key')
    assert.ok(!('provider' in unknown), 'no own `provider` key')
    assert.ok(!('reasoningEffort' in unknown), 'no own `reasoningEffort` key')
    assert.ok(!('contextWindow' in unknown), 'no own `contextWindow` key')
    assert.ok(!('maxOutputTokens' in unknown), 'no own `maxOutputTokens` key')
    assertPlainJson(unknown)
    const known = driveTimeline([
      header(1, { config: { model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', maxTokens: 256000 } }),
      requestContext(2, { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 128000 }),
      userMessage(3, [{ type: 'text', text: 'hi' }]),
    ]).view
    assert.equal(known.ok, true)
    assert.equal(known.model, 'deepseek-v4-flash')
    assert.equal(known.provider, 'deepseek')
    assert.equal(known.reasoningEffort, 'max')
    assert.equal(known.contextWindow, 128000)
    assert.equal(known.maxOutputTokens, 256000)
    assertPlainJson(known)
  })

  test('the reasoning effort and output cap are LAST-WINS across headers; hostile values clear them', () => {
    const cleared = driveTimeline([
      header(1, { config: { model: 'm', reasoningEffort: 'max', maxTokens: 256000 } }),
      header(2, { config: { model: 'm' }, reason: 'change' }),
    ]).view
    assert.equal(cleared.reasoningEffort, undefined)
    assert.equal(cleared.maxOutputTokens, undefined, 'a cap-less header clears it (dsh reserves zero, not the old envelope)')
    for (const effort of ['', 42, null, false] as const) {
      const { view } = driveTimeline([header(1, { config: { model: 'm', reasoningEffort: effort } })])
      assert.equal(view.reasoningEffort, undefined, String(effort))
    }
    for (const maxTokens of ['256000', -1, 0, Number.NaN, Number.POSITIVE_INFINITY, null] as const) {
      const { view } = driveTimeline([header(1, { config: { model: 'm', provider: 'p', maxTokens } })])
      assert.equal(view.maxOutputTokens, undefined, String(maxTokens))
    }
    const kept = driveTimeline([
      header(1, { config: { model: 'm', provider: 'p', reasoningEffort: 'low', maxTokens: 8000 } }),
      header(2, { config: { model: 'm', provider: 'p', reasoningEffort: 'max', maxTokens: 256000 }, reason: 'change' }),
    ]).view
    assert.equal(kept.reasoningEffort, 'max')
    assert.equal(kept.maxOutputTokens, 256000)
  })
})

describe('the full fold view counters', () => {
  test('images and toolCalls sum live surface nodes, absent counts as zero', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
      userMessage(2, [{ type: 'text', text: 'no image here' }]),
      toolCall(3, { callId: 'c1', name: 'bash' }),
      toolResult(4, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.equal(view.images, 1)
    assert.equal(view.toolCalls, 1)
  })

  test('humanInputs tallies the user\'s own messages and answered questions, other tool results excluded', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      userMessage(2, [{ type: 'text', text: 'again' }]),
      userMessage(3, [{ type: 'text', text: 'AGENTS.md' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(4, [{ type: 'text', text: '/skill' }], { kind: 'skill-invocation', name: 's' }),
      userMessage(5, [{ type: 'image', attachment: { width: 8, height: 8 } }], { kind: 'user' }),
      toolCall(6, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(7, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["x"]}]}' }] }),
      toolCall(8, { callId: 'b1', name: 'bash' }),
      toolResult(9, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }),
      toolCall(10, { callId: 'q2', name: 'ask_user_question' }),
      toolResult(11, { callId: 'q2', content: [{ type: 'text', text: '{"answers":[{"id":"b","selected":["y"]}]}' }] }),
    ])
    assert.equal(view.humanInputs, 5)
    const standalone = driveTimeline([
      toolCall(1, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(2, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["y"]}]}' }] }),
    ]).view
    assert.equal(standalone.humanInputs, 1)
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

describe('the full fold view lastUser preview', () => {
  test('the newest own message rides the view, whitespace collapsed and bounded; injections and text-less inputs leave it alone', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: '  hello   world  ' }]),
      userMessage(2, [{ type: 'text', text: 'AGENTS.md' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(3, [{ type: 'text', text: '/skill' }], { kind: 'skill-invocation', name: 's' }),
      userMessage(4, [{ type: 'image', attachment: { width: 8, height: 8 } }]),
    ])
    assert.equal(view.lastUser, 'hello world')
    const newer = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'first' }]),
      userMessage(2, [{ type: 'text', text: 'second' }]),
    ])
    assert.equal(newer.state.lastUser, 'second')
    assert.equal(newer.view.lastUser, 'second')
    assertPlainJson(newer.state)
    const long = driveTimeline([userMessage(1, [{ type: 'text', text: 'x'.repeat(500) }])]).view
    assert.equal(long.lastUser?.length, 80)
  })

  test('stays ABSENT before any textual user message — never undefined-valued', () => {
    const { state, view } = driveTimeline([
      toolCall(1, { callId: 'b1', name: 'bash' }),
      userMessage(2, [{ type: 'image', attachment: { width: 8, height: 8 } }]),
    ])
    assert.ok(!('lastUser' in view), 'no own key on the view')
    assert.ok(!('lastUser' in state), 'no own key on the persisted state')
    assertPlainJson(view)
  })
})

describe('the full fold view copies', () => {
  test('the view is detached from state; repeated views are deep-equal but distinct, and state is untouched', () => {
    const { def, state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 1, step: 1 }),
      userMessage(4, [{ type: 'text', text: 'b' }], undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    const before = assertPlainJson(state)
    const v1 = def.wire.view(state)
    const v2 = def.wire.view(state)
    assert.ok(v1 !== v2 && v1.nodes !== v2.nodes && v1.requests !== v2.requests)
    assert.deepEqual(v1, v2)
    assert.notEqual(v1.requests[0], state.requests[0])
    assert.deepEqual(v1.requests[0], state.requests[0])
    assert.notEqual(v1.events[0], state.events[0])
    assert.equal(v1.archive.length, 1)
    assert.notEqual(v1.archive[0], state.archived[0])
    assert.deepEqual(v1.archive[0], state.archived[0])
    v1.requests[0].total = -1
    v1.events[0].name = 'mutated'
    v1.archive[0].tokens = -1
    assert.notEqual(state.requests[0].total, -1)
    assert.notEqual(state.events[0].name, 'mutated')
    assert.notEqual(state.archived[0].tokens, -1)
    assert.deepEqual(assertPlainJson(state), before, 'view() must not mutate the persisted state')
  })
})

describe('the full fold view cost copy', () => {
  test('every provider, model, and period branch copies through; no cost omits the field', () => {
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
    assert.equal('cost' in timelineDef({}).wire.view(createTimelineState()), false)
  })
})

describe('the full fold view serving window', () => {
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

  test('without overflow the served nodes are a plain tail copy; no floors ride, and an existing archiveFloor passes through', () => {
    const { state, view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }]),
      userMessage(2, [{ type: 'text', text: 'b' }]),
    ], { maxNodes: 4 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 2])
    assert.notEqual(view.nodes, state.surface, 'the served slice never aliases the surface')
    assert.equal(view.droppedNodes, 0)
    assert.equal('surfaceFloor' in view, false)
    assert.equal('archiveFloor' in view, false)
    const archived = createTimelineState()
    archived.archiveFloor = 7
    assert.equal(timelineDef({}).wire.view(archived).archiveFloor, 7)
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

  test('skill nodes pin like injects when the window overflows (issue #66)', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: '<available_skills>' }], { kind: 'skill-catalog', form: 'catalog' }),
      userMessage(2, [{ type: 'text', text: 'x1' }]),
      userMessage(3, [{ type: 'text', text: 'x2' }]),
      toolCall(4, { callId: 'c1', name: 'skill' }),
      toolResult(5, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="pdf">body</skill_content>' }] }),
    ], { maxNodes: 2 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 3, 5])
    assert.equal(view.droppedNodes, 1)
    assert.equal(view.surfaceFloor, 2, 'the floor is the newest unserved non-skill seq')
  })
})

describe('the full fold view event attribution', () => {
  test('an event before the first or after the last request takes only the available side; between two requests, both', () => {
    const before = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'notice', plugin: 'p', summary: 'hi' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ]).view.events[0]
    assert.equal(before.kind, 'inject')
    assert.equal(before.turn, 1)
    assert.equal(before.step, 1)
    assert.equal(before.fromTurn, undefined)
    assert.equal(before.fromStep, undefined)
    const after = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      planMode(2, { active: false }),
    ]).view.events[0]
    assert.equal(after.turn, undefined)
    assert.equal(after.step, undefined)
    assert.equal(after.fromTurn, 1)
    assert.equal(after.fromStep, 1)
    for (const [nextTurn, nextStep, fromTurn, fromStep] of [
      [1, 2, 1, 1],
      [2, 1, 1, 1],
    ] as const) {
      const { view } = driveTimeline([
        assistantMessage(1, { turn: 1, step: 1 }),
        planMode(2, { active: true }),
        assistantMessage(3, { turn: nextTurn, step: nextStep }),
      ])
      const ev = view.events[0]
      assert.equal(ev.turn, nextTurn, `next turn ${nextTurn}`)
      assert.equal(ev.step, nextStep)
      assert.equal(ev.fromTurn, fromTurn)
      assert.equal(ev.fromStep, fromStep)
    }
  })

  test('an event with no requests, or an incomplete next request, takes no side', () => {
    const { view } = driveTimeline([planMode(1, { active: true })])
    const ev = view.events[0]
    assert.equal(ev.turn, undefined)
    assert.equal(ev.fromTurn, undefined)
    for (const next of [{}, { turn: 3 }]) {
      const none = driveTimeline([planMode(1, { active: true }), assistantMessage(2, next)]).view.events[0]
      assert.equal(none.turn, undefined, JSON.stringify(next))
      assert.equal(none.step, undefined)
    }
  })

  test('a previous request without a complete turn/step pair stamps no from-side', () => {
    for (const previous of [{}, { turn: 7 }]) {
      const { view } = driveTimeline([
        assistantMessage(1, previous),
        planMode(2, { active: true }),
        assistantMessage(3, { turn: 8, step: 1 }),
      ])
      const ev = view.events[0]
      assert.equal(ev.fromTurn, undefined, JSON.stringify(previous))
      assert.equal(ev.fromStep, undefined)
      assert.equal(ev.turn, 8)
      assert.equal(ev.step, 1)
    }
  })
})
