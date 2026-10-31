import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import type { SurfaceNode } from '../../src/shared/types'
import { driveTimeline } from './helpers/projection'
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
import type { TimelineEvent } from '../../src/host/fold'

function realLog(): TimelineEvent[] {
  return [
    header(1, {
      tools: [{ name: 'bash', description: 'run a command' }],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
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

describe('createContextTimelineDefinition', () => {
  test('carries the pinned projection contract; the wire and state schemas accept a real fold', () => {
    const def = createContextTimelineDefinition({}, () => false)
    assert.equal(def.key, 'contextTimeline')
    assert.equal(def.stateVersion, 37, 'pinned: the head-only retention shape cannot backfill from later events (issue #217)')
    const drive = driveTimeline(realLog(), {}, true)
    assert.equal(def.wire.viewSchema.safeParse(drive.view).success, true, 'a real folded view validates')
    const view = drive.view
    assert.equal(view.ok, true)
    assert.equal(view.model, 'deepseek-v4-flash')
    assert.equal(view.provider, 'deepseek')
    assert.equal(view.contextWindow, 128000)
    assert.equal(view.humanInputs, 1, 'the canonical log\'s one user message')
    assert.equal(view.nodes.length, 4, 'the fallback wire serves the slim surface index')
    assert.ok(view.nodes.every(node => !('text' in node)), 'the fallback surface carries no detail text')
    assert.equal(view.requests.length, 0, 'slim request records stay off the fallback wire')
    assert.ok(view.events.length > 0, 'the events window rides the fallback wire')
    for (const state of drive.states) {
      def.stateSchema.parse(structuredClone(state))
    }
    assert.equal(def.wire.viewSchema.safeParse(def.wire.view(drive.state)).success, true)
  })

  test('the wire schema rejects drift', () => {
    const def = createContextTimelineDefinition({}, () => false)
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
})
