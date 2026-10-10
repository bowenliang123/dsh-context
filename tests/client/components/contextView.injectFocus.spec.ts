// ContextView — the events card's injection rows reveal their own item in the Context Browser.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import type { ContextTimeline } from '../../../src/shared/types'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text } from '../helpers/kit'
import { makeView, mountInScroller, projectionsFor, T0, timeline } from './contextViewHarness'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

/** Two logged steps, an injection before each of them, one injection past the log tail, and one whose item is
 * not served at all (the dropped-window arm). */
function injectTimeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return timeline({
    requests: [
      { seq: 4, turn: 1, step: 1, time: T0 + 1000, system: 10, tools: 20, user: 10, inject: 20, assistant: 0, tool: 0, total: 60 },
      { seq: 8, turn: 1, step: 2, time: T0 + 2000, system: 10, tools: 20, user: 10, inject: 20, assistant: 0, tool: 0, total: 60 },
    ],
    events: [
      { seq: 3, time: T0 + 500, kind: 'inject', form: 'notice', name: 'hook', tokens: 20, turn: 1, step: 1 },
      { seq: 5, time: T0 + 1500, kind: 'inject', form: 'context', name: 'dropped', tokens: 5 },
      { seq: 11, time: T0 + 3000, kind: 'inject', form: 'notice', name: 'late', tokens: 7 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 },
      { seq: 3, cat: 'inject', tokens: 20, time: T0 + 500, text: 'the injected note' },
      { seq: 11, cat: 'inject', tokens: 7, time: T0 + 3000, text: 'the late note' },
    ],
    ...over,
  })
}

/** The events card lists newest-first: pick the row whose label carries this injection's name. */
function injectLink(container: ParentNode, label: string): HTMLElement {
  const row = queryAll(container, '.lc-event').find(r => text(r).includes(label))
  assert.ok(row !== undefined, `no event row labelled ${label}`)
  return query(row, '.lc-event-jump')
}

function mountInject(sessionId: string, data: ContextTimeline) {
  const View = makeView(new TestClientCtx())
  return mount(h(View, { sessionId, useProjection: projectionsFor(data) }))
}

describe('ContextView — injection rows reveal their item', () => {
  test('a click opens the browser on the injection\'s own item at its entry step and scrolls the card in', async () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 800 })
    Object.defineProperty(scroller, 'clientHeight', { value: 300 })
    // jsdom lays out nothing: fixed viewport tops make the reveal's rect delta deterministic (450 − 100).
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.classList.contains('lc-col-browser') ? 450 : 0
      return { top } as DOMRect
    })
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, {
        sessionId: 'sv-injectfocus',
        useProjection: projectionsFor(injectTimeline()),
      }), scroller)
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0, 'nothing is open before the click')

      await click(injectLink(m.container, DICT_EN['form.notice'] + ' · hook'))

      assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4', 'the entry step is selected')
      const open = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes('the injected note'), 'the injection\'s own item is open')
      assert.ok(queryAll(m.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'), 'the Inject category is open')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('an injection past the last request reveals on the live surface', async () => {
    const m = await mountInject('sv-injectlive', injectTimeline())
    await click(injectLink(m.container, DICT_EN['form.notice'] + ' · late'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('the late note'))
    await m.unmount()
  })

  test('an injection whose item is no longer served moves to its step, opening the category only', async () => {
    const m = await mountInject('sv-injectdropped', injectTimeline())
    await click(injectLink(m.container, DICT_EN['form.context'] + ' · dropped'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '8')
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0, 'the item is not served, so no row can open')
    assert.ok(queryAll(m.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'))
    await m.unmount()
  })

  test('a compaction shadow reveals on the steps before its removal, and never after it', async () => {
    const archived = (gone: number) => injectTimeline({
      nodes: [{ seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 }],
      archive: [{ seq: 3, cat: 'inject', tokens: 20, time: T0 + 500, text: 'the removed note', gone }],
    })

    // Removed at seq 6: the step-4 surface still held it, so the row opens there.
    const m = await mountInject('sv-injectshadow', archived(6))
    await click(injectLink(m.container, DICT_EN['form.notice'] + ' · hook'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('the removed note'))
    await m.unmount()

    // Removed at seq 4 — before any step dispatched it: nothing is left to reveal.
    const gone = await mountInject('sv-injectgone', archived(4))
    await click(injectLink(gone.container, DICT_EN['form.notice'] + ' · hook'))
    assert.equal(query<HTMLSelectElement>(gone.container, 'select.lc-br-pick').value, 'live')
    assert.equal(queryAll(gone.container, '.lc-br-elem-on').length, 0)
    assert.ok(!queryAll(gone.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'))
    await gone.unmount()
  })
})
