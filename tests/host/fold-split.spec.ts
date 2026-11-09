import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineDetail, buildTimelineHead, skillNameOf } from '../../src/host/fold'
import type { TimelineEvent } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import { canonicalLog, assistantMessage, compaction, header, requestContext, stepStart, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

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

describe('the split wire generation (definition slim flag)', () => {
  test('each generation validates on the one schema, and the inline value is exactly the head plus the detail', () => {
    const { state } = driveTimeline(canonicalLog())
    const slim = timelineDef({}, true)
    const slimView = slim.wire.view(state)
    assert.equal(slim.wire.viewSchema.safeParse(slimView).success, true, 'the slim head validates')
    assert.equal(typeof slimView.detailRev, 'number', 'the split marker is present')
    assert.ok(slimView.counts !== undefined)
    assert.deepEqual(slimView.nodes, [], 'collections stay off the wire value')
    const inline = timelineDef({}, false)
    const inlineView = inline.wire.view(state)
    assert.equal(inline.wire.viewSchema.safeParse(inlineView).success, true, 'the inline value validates on the same schema')
    assert.equal(inlineView.detailRev, undefined)
    assert.ok(inlineView.nodes.length > 0)
    assert.ok(inlineView.requests.length > 0)
    const head = buildTimelineHead(state)
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.deepEqual(inlineView.counts, head.counts, 'the inline value carries the full-session counters')
    const { last: _last, detailRev: _rev, ...headScalars } = head
    const { rev: _detailRev, head: _detailHead, ...collections } = detail
    assert.deepEqual(inlineView, { ...headScalars, ...collections })
  })
})
