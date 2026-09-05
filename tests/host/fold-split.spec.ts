// The split wire generation (src/host/fold.ts buildTimelineHead /
// buildTimelineDetail + the detailRev ledger): the slim head carries the
// counters and the headline anchor while the detail payload serves the heavy
// collections, and the revision bumps exactly on detail-mutating folds.
// Also pins the equivalence: inline view = head + detail, so the two
// generations can never drift apart.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { buildTimelineDetail, buildTimelineHead } from '../../src/host/fold'
import type { TimelineEvent } from '../../src/host/fold'
import { resolveBounds } from '../../src/host/config'
import {
  assistantChunk,
  assistantMessage,
  compaction,
  header,
  planMode,
  requestContext,
  stepEnd,
  stepStart,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

/** A session log touching every envelope family the fold serves (mirrors the compat driver's canonical log). */
function canonicalLog(): TimelineEvent[] {
  return [
    header(1, {
      system: 'You are an agent.',
      tools: [{ name: 'bash', description: 'run a command' }],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    }),
    requestContext(2, { contextWindow: 128000 }),
    stepStart(3),
    userMessage(4, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(5, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(6, { callId: 'c1', name: 'bash' }),
    toolResult(7, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(8),
    assistantMessage(9, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(10, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [4] }),
    planMode(11, { active: true }),
  ]
}

describe('the detailRev ledger', () => {
  test('bumps exactly on the detail-mutating folds of the canonical log', () => {
    // Mutations: userMessage(4), assistantMessage(5), toolResult(7),
    // assistantMessage(9), compaction(10), planMode(11) — six in total.
    const { state } = driveTimeline(canonicalLog())
    assert.equal(state.detailRev, 6)
  })

  test('the working-slot and envelope folds do NOT bump (nothing to refetch)', () => {
    const { def, state } = driveTimeline(canonicalLog())
    // step/start (arms the step slot), tool/call (arms the call ledger), the
    // first-token chunk stamp, request/context (capacity metadata), and a
    // header with an UNCHANGED model all leave the detail collections as-is.
    const follow: TimelineEvent[] = [
      requestContext(12, { contextWindow: 256000 }),
      header(13, { model: 'deepseek-v4-flash', provider: 'deepseek', reason: 'change' }),
      stepStart(14),
      toolCall(15, { callId: 'c2', name: 'bash' }),
      assistantChunk(16, { type: 'text-delta', text: 'tok' }),
    ]
    let st = state
    for (const ev of follow) st = def.apply(st, ev)
    assert.equal(st.detailRev, 6, 'no detail mutation, no bump')
    // The chunk stamp and the step lifecycle DID fold (state changed) — only the rev stayed.
    assert.notEqual(st, state)
  })

  test('a real model switch bumps (the events collection gains a row)', () => {
    const { def, state } = driveTimeline(canonicalLog())
    const switched = def.apply(state, header(12, { model: 'deepseek-v4-pro', provider: 'deepseek', reason: 'change' }))
    assert.equal(switched.detailRev, 7)
  })

  test('the rev is plain JSON and survives the state gate', () => {
    const { states } = driveTimeline(canonicalLog())
    for (const state of states) assertPlainJson(state)
  })
})

describe('buildTimelineHead', () => {
  test('serves the counters, the headline anchor, and the revision — with empty collections', () => {
    const { state } = driveTimeline(canonicalLog())
    const head = buildTimelineHead(state)
    assert.equal(head.ok, true)
    assert.equal(head.model, 'deepseek-v4-flash')
    assert.equal(head.provider, 'deepseek')
    assert.equal(head.contextWindow, 128000)
    assert.ok(head.current.total > 0)
    // The retained records tally: one turn, two steps, the compaction event.
    assert.deepEqual(head.counts, { turns: 1, steps: 2, injects: 0, compactions: 1, prunes: 0 })
    // The headline anchor is the newest retained request's billing summary.
    const lastReq = state.requests.at(-1)!
    assert.deepEqual(head.last, { seq: lastReq.seq, total: lastReq.total, prompt: 20 })
    assert.equal(head.detailRev, 6)
    // The collections stay empty on the head — the detail channel serves them.
    assert.deepEqual(head.requests, [])
    assert.deepEqual(head.events, [])
    assert.deepEqual(head.nodes, [])
    assert.equal(head.droppedNodes, 0)
    assert.deepEqual(head.archive, [])
    assertPlainJson(head)
  })

  test('the counters tally injects/prunes, and a turn-less record folds as turn 0', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      compaction(2, 'prune', { shadowedTokenCount: 3 }),
      assistantMessage(3, {}), // no turn: the replay shape folds as turn 0
    ])
    const head = buildTimelineHead(state)
    assert.deepEqual(head.counts, { turns: 1, steps: 1, injects: 1, compactions: 0, prunes: 1 })
  })

  test('a fresh state serves zeroed counters and no last/detailRev payload keys beyond the marker', () => {
    const head = buildTimelineHead(timelineDef().init())
    assert.deepEqual(head.counts, { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
    assert.equal(head.last, undefined, 'no request yet — the anchor stays absent')
    assert.equal(head.detailRev, 0)
    assert.equal(head.current.total, 0)
  })

  test('the newest request without a usage sample anchors without prompt', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    const head = buildTimelineHead(state)
    assert.deepEqual(head.last, { seq: 2, total: state.requests[0].total })
    assert.ok(head.last !== undefined && !('prompt' in head.last), 'no undefined-valued prompt key')
  })
})

describe('buildTimelineDetail', () => {
  test('serves the same collections the inline view serves, plus the revision', () => {
    const { state, view } = driveTimeline(canonicalLog())
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.rev, 6)
    assert.deepEqual(detail.requests, view.requests)
    assert.deepEqual(detail.events, view.events)
    assert.deepEqual(detail.nodes, view.nodes)
    assert.equal(detail.droppedNodes, view.droppedNodes)
    assert.deepEqual(detail.archive, view.archive)
    assert.equal(detail.surfaceFloor, view.surfaceFloor)
    assert.equal(detail.archiveFloor, view.archiveFloor)
    assertPlainJson(detail)
    // The detail never aliases the persisted state.
    assert.notEqual(detail.requests[0], state.requests[0])
    assert.notEqual(detail.archive, state.archived)
  })

  test('the served window and floors follow the retention bounds (same rule as the inline view)', () => {
    const events: TimelineEvent[] = [
      userMessage(1, [{ type: 'text', text: 'injected' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(2, [{ type: 'text', text: 'x1' }]),
      userMessage(3, [{ type: 'text', text: 'x2' }]),
      userMessage(4, [{ type: 'text', text: 'x3' }]),
      userMessage(5, [{ type: 'text', text: 'x4' }]),
    ]
    const { state } = driveTimeline(events)
    const detail = buildTimelineDetail(state, resolveBounds({ maxNodes: 2 }))
    assert.deepEqual(detail.nodes.map(n => n.seq), [1, 4, 5], 'the out-of-window inject is pinned ahead of the tail')
    assert.equal(detail.droppedNodes, 2)
    assert.equal(detail.surfaceFloor, 3)
    assert.equal(detail.rev, 5)
  })
})

describe('the split wire generation (definition slim flag)', () => {
  test('the slim view validates against the wire schema and carries the marker', () => {
    const slim = timelineDef({}, true)
    const { state } = driveTimeline(canonicalLog())
    const view = slim.wire.view(state)
    assert.equal(slim.wire.viewSchema.safeParse(view).success, true, 'the slim head validates')
    assert.equal(typeof view.detailRev, 'number', 'the split marker is present')
    assert.ok(view.counts !== undefined)
    assert.deepEqual(view.nodes, [], 'collections stay off the wire value')
  })

  test('the inline view carries the collections and NO split markers', () => {
    const inline = timelineDef({}, false)
    const { state } = driveTimeline(canonicalLog())
    const view = inline.wire.view(state)
    assert.equal(inline.wire.viewSchema.safeParse(view).success, true, 'the inline value validates on the same schema')
    assert.equal(view.detailRev, undefined)
    assert.equal(view.counts, undefined)
    assert.ok(view.nodes.length > 0)
    assert.ok(view.requests.length > 0)
  })

  test('equivalence: the inline view is exactly the head plus the detail (minus the markers)', () => {
    const { state } = driveTimeline(canonicalLog())
    const head = buildTimelineHead(state)
    const detail = buildTimelineDetail(state, resolveBounds({}))
    const inline = timelineDef({}, false).wire.view(state)
    const { counts: _counts, last: _last, detailRev: _rev, ...headScalars } = head
    const { rev: _detailRev, ...collections } = detail
    assert.deepEqual(inline, { ...headScalars, ...collections })
  })
})
