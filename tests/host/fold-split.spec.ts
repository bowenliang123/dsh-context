import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineDetail, buildTimelineHead, skillNameOf } from '../../src/host/fold'
import type { TimelineEvent, TimelineState } from '../../src/host/fold'
import { createTimelineState } from '../../src/host/foldState'
import { resolveBounds } from '../../src/host/config'
import {
  assistantMessage,
  compaction,
  header,
  planMode,
  requestContext,
  stepEnd,
  stepStart,
  systemMessage,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

function canonicalLog(): TimelineEvent[] {
  return [
    header(1, {
      tools: [{ name: 'bash', description: 'run a command' }],
      config: { model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max' },
    }),
    systemMessage(2),
    requestContext(3, { contextWindow: 128000 }),
    stepStart(4),
    userMessage(5, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(6, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(7, { callId: 'c1', name: 'bash' }),
    toolResult(8, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(9),
    assistantMessage(10, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(11, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5] }),
    planMode(12, { active: true }),
  ]
}

describe('the detailRev ledger', () => {
  test('bumps exactly on detail-mutating folds — never on working-slot or envelope folds — and on a real model switch', () => {
    const { def, state } = driveTimeline(canonicalLog())
    assert.equal(state.detailRev, 7)
    const workingSlot: TimelineEvent[] = [
      requestContext(13, { contextWindow: 256000 }),
      header(14, { model: 'deepseek-v4-flash', provider: 'deepseek', reason: 'change' }),
      stepStart(15),
      toolCall(16, { callId: 'c2', name: 'bash' }),
    ]
    let st = state
    for (const ev of workingSlot) st = def.apply(st, ev)
    assert.equal(st.detailRev, 7, 'no detail mutation, no bump')
    assert.notEqual(st, state)
    const switched = def.apply(state, header(13, { model: 'deepseek-v4-pro', provider: 'deepseek', reason: 'change' }))
    assert.equal(switched.detailRev, 8, 'the events collection gained a model row')
  })
})

describe('buildTimelineHead', () => {
  test('serves the counters, the headline anchor, and the revision; a fresh state zeroes them', () => {
    const fresh = buildTimelineHead(timelineDef().init())
    assert.deepEqual(fresh.counts, { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
    assert.equal(fresh.humanInputs, 0, 'the tally defaults to zero on the wire')
    assert.equal(fresh.answers, 0, 'the answers tally defaults to zero on the wire too')
    assert.ok(!('lastUser' in fresh), 'no own key on the wire — no user message yet')
    assert.equal(fresh.last, undefined, 'no request yet — the anchor stays absent')
    assert.equal(fresh.detailRev, 0)
    assert.equal(fresh.current.total, 0)
    const { state } = driveTimeline(canonicalLog())
    const head = buildTimelineHead(state)
    assert.equal(head.ok, true)
    assert.deepEqual(
      [head.model, head.provider, head.reasoningEffort, head.contextWindow],
      ['deepseek-v4-flash', 'deepseek', 'max', 128000],
    )
    assert.ok(head.current.total > 0)
    assert.deepEqual(head.counts, { turns: 1, steps: 2, injects: 0, compactions: 1, prunes: 0, skills: 0 })
    assert.equal(head.humanInputs, 1)
    assert.equal(head.answers, 2)
    assert.equal(head.lastUser, 'hello there')
    const lastReq = state.requests.at(-1)!
    assert.deepEqual(head.last, { seq: lastReq.seq, total: lastReq.total, prompt: 20 })
    assert.equal(head.detailRev, 7)
    assert.deepEqual(head.requests, [])
    assert.deepEqual(head.events, [])
    assert.deepEqual(head.nodes, [])
    assert.equal(head.droppedNodes, 0)
    assert.deepEqual(head.archive, [])
    assertPlainJson(head)
  })

  test('the counters tally injects/prunes, a turn-less record folds as turn 0, and a usage-less anchor omits prompt', () => {
    const tallied = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      compaction(2, 'prune', { shadowedTokenCount: 3 }),
      assistantMessage(3, {}),
    ]).state
    assert.deepEqual(buildTimelineHead(tallied).counts, { turns: 1, steps: 1, injects: 1, compactions: 0, prunes: 1, skills: 0 })
    const anchorless = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    const head = buildTimelineHead(anchorless.state)
    assert.deepEqual(head.last, { seq: 2, total: anchorless.state.requests[0].total })
    assert.ok(head.last !== undefined && !('prompt' in head.last), 'no undefined-valued prompt key')
  })

  test('the skills counter tallies DISTINCT loaded-skill names — the catalog digest never counts', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', form: 'skill', name: 'grilling' }),
      toolCall(2, { callId: 'c1', name: 'skill' }),
      toolResult(3, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="grilling">instructions</skill_content>' }] }),
      userMessage(4, [{ type: 'text', text: 'catalog' }], { kind: 'skill-catalog', form: 'catalog' }),
      userMessage(5, [{ type: 'text', text: 'again' }], { kind: 'skill-invocation', form: 'skill', name: 'ponytail' }),
      userMessage(6, [{ type: 'text', text: 'once more' }], { kind: 'skill-invocation', form: 'skill', name: 'grilling' }),
    ])
    const head = buildTimelineHead(state)
    assert.deepEqual(head.counts, { turns: 0, steps: 0, injects: 5, compactions: 0, prunes: 0, skills: 2 })
    assertPlainJson(head)
  })

  test('skillNameOf narrows hostile messages to no name (the activity fold’s reuse)', () => {
    assert.equal(skillNameOf(null), '')
    assert.equal(skillNameOf('text'), '')
    assert.equal(skillNameOf(42), '')
    assert.equal(skillNameOf({}), '')
    assert.equal(skillNameOf({ content: [{ type: 'text', text: '<skill_content name="tdd">…' }] }), 'tdd')
  })
})

describe('buildTimelineDetail', () => {
  test('serves the revision and head, with collections detached from the fold state', () => {
    const { state, view } = driveTimeline(canonicalLog())
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.rev, 7)
    assert.ok(detail.head !== undefined)
    assert.deepEqual(detail.head.current, view.current)
    assertPlainJson(detail)
    assert.notEqual(detail.requests[0], state.requests[0])
    assert.notEqual(detail.archive, state.archived)
  })
})

describe('the split wire generation (head-only persisted state)', () => {
  test('the registered definition serves the head and compacts a legacy full state to the same head', () => {
    const full = driveTimeline(canonicalLog())
    const head = timelineDef({}, true)
    const headView = head.wire.view(full.state)
    assert.equal(head.wire.viewSchema.safeParse(headView).success, true, 'the slim head validates')
    assert.equal(typeof headView.detailRev, 'number', 'the split marker is present')
    assert.deepEqual(headView.counts, { turns: 1, steps: 2, injects: 0, compactions: 1, prunes: 0, skills: 0 })
    assert.deepEqual(headView.nodes, [], 'collections stay off the wire value')
    const compacted = head.stateSchema.parse(structuredClone(full.state)) as TimelineState
    assert.equal(compacted.compact, true)
    assert.deepEqual(compacted.requests.map(r => r.seq), [10])
    assert.deepEqual(compacted.events, [])
    assert.deepEqual(compacted.fileOps, [])
    assert.deepEqual(compacted.commands, [])
    assert.deepEqual(compacted.spans, [])
    assert.deepEqual(head.wire.view(compacted), headView, 'the compacted legacy state serves the identical head')
    assert.deepEqual(timelineDef({}, true).init(), head.init())
  })

  test('a legacy row without head counters derives them to the identical head', () => {
    const full = driveTimeline(canonicalLog()).state
    const legacy = structuredClone(full) as TimelineState
    delete (legacy as { head?: unknown }).head
    const parsed = timelineDef({}, true).stateSchema.parse(legacy) as TimelineState
    assert.deepEqual(parsed.head, full.head, 'the derived counters match the maintained ledger')
    assert.deepEqual(buildTimelineHead(parsed), buildTimelineHead(full))
  })

  test('a compact checkpoint without the optional arrays is normalized before serving', () => {
    const sparse = structuredClone(createTimelineState(false)) as unknown as Record<string, unknown>
    for (const key of ['requests', 'events', 'archived', 'fileOps', 'commands', 'spans']) delete sparse[key]
    const parsed = timelineDef({}, true).stateSchema.parse(sparse) as TimelineState
    assert.deepEqual(parsed.requests, [])
    assert.deepEqual(parsed.events, [])
    assert.deepEqual(parsed.fileOps, [])
    assert.deepEqual(parsed.spans, [])
    assert.doesNotThrow(() => buildTimelineHead(parsed))
  })

  test('a fresh detail carries revision zero', () => {
    assert.equal(buildTimelineDetail(createTimelineState(), resolveBounds({})).rev, 0)
  })
})
