// The Agent network card's two Context-view hosts: the right Sidebar keeps it inline (its column has no room
// for a tab of its own), while the center Context tab hands it to the Fleet tab. The card's OWN session stats
// come from the view's projections — a list row carries no subagent-timing projection (the harness writes that
// one on subagent sessions alone), so its duration and step count have to arrive from here.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { createContextSettings } from '../../../src/client/settings'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text } from '../helpers/kit'
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
  test("the panel's active time and step count fill the current card's footer", async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(text(self).includes('Main Agent'), true)
    // richTimeline carries three steps; the duration is the timing card's active time.
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    await m.unmount()
  })

  test('without timing totals the card drops the duration instead of claiming 0s', async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline()) }))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '3 steps')
    await m.unmount()
  })

  test('the center Context tab hands the card to the Fleet tab; only the sidebar host keeps it inline', async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    assert.equal(queryAll(m.container, '.lc-agents').length, 0, 'no agent network on the Context tab')
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 0)
    // The rest of the tab still paints — the split moved the card, not the page.
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.unmount()
  })

  test("the stats board's family cell opens the Fleet tab, else the panel that keeps the card", async () => {
    // The tab bar the harness renders: the Fleet tab activates on click, like the real one.
    const bar = document.createElement('div')
    const tab = (label: string): HTMLButtonElement => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', 'false')
      b.textContent = label
      bar.appendChild(b)
      return b
    }
    const fleet = tab('Fleet')
    let fleetClicks = 0
    fleet.addEventListener('click', () => { fleetClicks++ })
    document.body.appendChild(bar)
    try {
      const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
      const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
      await click(query(m.container, '.lc-flow-team'))
      assert.equal(fleetClicks, 1, 'the served Fleet tab is activated')
      await m.unmount()
      fleet.remove()
    } finally {
      bar.remove()
    }
  })

  test('a hidden Fleet tab falls back to the right Sidebar panel, and to nothing when that is gone too', async () => {
    const opened: string[] = []
    const sidebar = { openTab: (kind: string): void => { opened.push(kind) } }
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly(), sidebarRight: sidebar } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    // No Fleet tab in the tab bar (the fleetTab preference is off): the panel that keeps the card inline opens.
    await click(query(m.container, '.lc-flow-team'))
    assert.deepEqual(opened, ['dsh-context'], 'the sidebar panel whose Context tab holds the card')
    await m.unmount()

    // A deployment serving neither: the click stays a quiet no-op.
    const bare = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m2 = await mount(h(bare, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    await click(query(m2.container, '.lc-flow-team'))
    await m2.unmount()
  })

  test('with neither view served the family cell is a plain figure, never a dead button', async () => {
    // The tab off and a placement that serves no Sidebar: nothing can open, so the cell drops its button role.
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'tab')
    settings.set('fleetTab', 'hide')
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }), settings)
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))

    const cell = query(m.container, '.lc-flow-team')
    assert.equal(cell.getAttribute('role'), null)
    assert.equal(cell.getAttribute('tabindex'), null)
    await click(cell)
    await m.unmount()
  })
})
