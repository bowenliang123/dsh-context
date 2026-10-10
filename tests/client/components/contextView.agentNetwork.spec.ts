// ContextView → Agent network: the tab's OWN projections are the only source of the
// current agent's live stats. Its list row carries no subagent-timing projection (the
// harness writes that one on subagent sessions alone), so the card's duration and step
// count have to arrive from here.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { TestClientCtx } from '../helpers/harness'
import { mount, query, text } from '../helpers/kit'
import { makeView, projectionsFor, richTimeline } from './contextViewHarness'

/** The outward sessions face the card reads: one row, the current session, no subagent.
 * getSnapshot hands back the SAME object every call — the card reads it through
 * useSyncExternalStore, which loops on a fresh snapshot per read. */
function selfOnly() {
  const snapshot = { byId: { 'sv-self': { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }

describe('ContextView — the agent network card\'s own session', () => {
  test("the tab's active time and step count fill the current card's footer", async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(text(self).includes('Main Agent'), true)
    // richTimeline carries three steps; the duration is the timing card's active time.
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    await m.unmount()
  })

  test('without timing totals the card drops the duration instead of claiming 0s', async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '3 steps')
    await m.unmount()
  })
})
