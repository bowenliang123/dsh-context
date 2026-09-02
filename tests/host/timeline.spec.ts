// Unit tests for the contextTimeline projection unit (src/host/timeline.ts) —
// the projection-definition contract surface (stateSchema + required wire),
// its wire/state schemas, and the config-resolved retention bounds. Fold
// semantics themselves live in fold.ts; here we pin the definition's contract
// over a real folded log built with the shared envelope builders.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import type { ContextTimeline, SurfaceNode } from '../../src/shared/types'
import { driveTimeline } from './helpers/projection'
import {
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
import type { TimelineEvent } from '../../src/host/fold'

/** A realistic session log touching every envelope family the fold serves. */
function realLog(): TimelineEvent[] {
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

describe('createContextTimelineDefinition', () => {
  test('carries the supported projection contract on one unit', () => {
    const def = createContextTimelineDefinition({})
    assert.equal(def.key, 'contextTimeline')
    assert.equal(def.stateVersion, 12)
    assert.equal(typeof def.init, 'function')
    assert.equal(typeof def.apply, 'function')
    // The supported registry contract: stateSchema + a REQUIRED wire block.
    assert.equal(typeof def.stateSchema.parse, 'function')
    assert.equal(typeof def.wire.viewSchema.safeParse, 'function')
    assert.equal(typeof def.wire.view, 'function')
  })

  test('the wire schema accepts a real folded view; the state schema accepts every intermediate state', () => {
    const def = createContextTimelineDefinition({})
    const drive = driveTimeline(realLog())
    const parsed = def.wire.viewSchema.safeParse(drive.view)
    assert.equal(parsed.success, true, 'a real folded view validates')

    const view = drive.view
    assert.equal(view.ok, true)
    assert.equal(view.model, 'deepseek-v4-flash')
    assert.equal(view.provider, 'deepseek')
    assert.equal(view.contextWindow, 128000)
    assert.ok(view.nodes.length > 0)
    assert.ok(view.requests.length > 0)
    assert.ok(view.events.length > 0)

    for (const [index, state] of drive.states.entries()) {
      def.stateSchema.parse(structuredClone(state)) // throws on drift
      assert.ok(true, `state ${index} validates`)
    }
    assert.equal(def.wire.viewSchema.safeParse(def.wire.view(drive.state)).success, true)
  })

  test('the wire schema rejects drift', () => {
    const def = createContextTimelineDefinition({})
    const drive = driveTimeline(realLog())

    const extra = structuredClone(drive.view) as unknown as Record<string, unknown>
    extra.bogus = 1
    assert.equal(def.wire.viewSchema.safeParse(extra).success, false, 'strict: unknown keys rejected')

    const badCat = structuredClone(drive.view)
    ;(badCat.nodes[0] as SurfaceNode).cat = 'weird' as SurfaceNode['cat']
    assert.equal(def.wire.viewSchema.safeParse(badCat).success, false, 'the cat enum rejects unknown categories')

    const badTokens = structuredClone(drive.view)
    badTokens.nodes[0].tokens = -1
    assert.equal(def.wire.viewSchema.safeParse(badTokens).success, false, 'negative token counts rejected')
  })

  test('maxNodes bounds the served surface nodes', () => {
    const events: TimelineEvent[] = [
      header(1, { system: 's', model: 'm', provider: 'p' }),
      userMessage(2, [{ type: 'text', text: 'one' }], { kind: 'user' }),
      userMessage(3, [{ type: 'text', text: 'two' }], { kind: 'user' }),
      userMessage(4, [{ type: 'text', text: 'three' }], { kind: 'user' }),
      userMessage(5, [{ type: 'text', text: 'four' }], { kind: 'user' }),
    ]
    const bounded = driveTimeline(events, { maxNodes: 2 })
    assert.equal(bounded.view.nodes.length, 2, 'only the newest tail is served')
    assert.deepEqual(bounded.view.nodes.map(n => n.seq), [4, 5])
    assert.equal(bounded.view.droppedNodes, 2)
    assert.equal(bounded.view.surfaceFloor, 3, 'the newest unserved live seq')

    const unbounded: ContextTimeline = driveTimeline(events).view
    assert.equal(unbounded.nodes.length, 4, 'default bounds serve every live node')
    assert.equal(unbounded.droppedNodes, 0)
  })
})
