import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, mount, query, queryAll, text, until } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

describe('ContextView — projection guards', () => {
  test('loading screen while useProjection is absent, empty, or the session id is missing; a served projection renders without one', async () => {
    const View = makeView(new TestClientCtx())

    for (const props of [
      { sessionId: 'sv-none' },
      { sessionId: '', useProjection: () => undefined },
      { useProjection: () => undefined },
    ]) {
      const m = await mount(h(View, props))
      assert.ok(text(m.container).includes(DICT_EN.loading))
      assert.ok(queryAll(m.container, '.lc-deferred-skeleton').length >= 5, 'the cold load paints the final card skeleton')
      assert.ok(query(m.container, '.lc-cols-main').children.length >= 2)
      await m.unmount()
    }

    const sidebar = await mount(h(View, { host: 'sidebar' }))
    try {
      assert.ok(queryAll(sidebar.container, '.lc-deferred-skeleton').length >= 4, 'the sidebar skeleton skips the head row')
      assert.equal(queryAll(sidebar.container, '.lc-deferred-skeleton .lc-empty').length, 0)
    } finally {
      await sidebar.unmount()
    }

    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN.footer))
    await m.unmount()
  })

  test('a cold read that settles without data surfaces the retryable failure, not a stall', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, status: 500, json: async () => null } as Response))
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-cold-fail', useProjection: () => undefined }))
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure note never surfaced')
    assert.ok(!text(m.container).includes(DICT_EN.loading), 'no spinner remains once failed')
    await act(async () => {
      buttonByText(m.container, DICT_EN['detail.loadFailed']).click()
    })
    await m.unmount()
  })

  test('a corrupt timeline is sanitized and the whole tab still renders empty-section states', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-garbage',
      useProjection: projectionsFor(timeline(), {}),
    }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    assert.ok(text(m.container).includes(DICT_EN['files.empty']))
    assert.ok(text(m.container).includes(DICT_EN['footer']))
    assert.ok(m.container.querySelector('.lc-br-cats') !== null)
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined && comp.querySelector('.lc-card-sub') === null)
    await m.unmount()
  })

  test('companion projections feed the headline, stats, and browser headers', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-proj',
      useProjection: projectionsFor(timeline({ model: 'm-only' }), {
        contextPressure: { projectedTokens: 100, contextWindow: 128000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 },
        contextBreakdown: { systemTokens: 100, toolsTokens: 200, messageTokens: 900 },
        contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12 }] }] },
      }),
    }))
    assert.ok(text(m.container).includes(DICT_EN['overview.used']))
    const tokensCard = queryAll(m.container, '.lc-head > .lc-col-donut')[0]
    assert.equal(query(tokensCard, '.lc-donut-center b').textContent, '350')
    assert.equal(query(tokensCard, '.lc-card-rate').textContent, 'Cache Hit 66.66%')
    assert.ok(text(m.container).includes('m-only'))
    await m.unmount()
  })
})

describe('ContextView — the sidebar host', () => {
  test('the panel drops the context-stats and plugin-info head cards, keeping the two donut cards', async () => {
    const View = makeView(new TestClientCtx())
    const projections = projectionsFor(richTimeline())

    const tab = await mount(h(View, { useProjection: projections }))
    assert.equal(queryAll(tab.container, '.lc-stats').length, 1, 'the tab keeps the context stats')
    assert.equal(queryAll(tab.container, '.lc-pi-grid').length, 1, 'the tab keeps the plugin info')
    assert.equal(queryAll(tab.container, '.lc-recom').length, 1, 'the tab keeps the recom card')
    await tab.unmount()

    const panel = await mount(h(View, { host: 'sidebar', useProjection: projections }))
    assert.equal(queryAll(panel.container, '.lc-stats').length, 0, 'the panel drops the context stats')
    assert.equal(queryAll(panel.container, '.lc-pi-grid').length, 0, 'the panel drops the plugin info')
    assert.equal(queryAll(panel.container, '.lc-recom').length, 0, 'the panel drops the recom card')
    assert.equal(queryAll(panel.container, '.lc-head > .lc-card').length, 2, 'the head row keeps its two donut cards')
    assert.equal(queryAll(panel.container, '.lc-head > .lc-col-donut').length, 2, 'token usage and timing')
    await panel.unmount()
  })
})

describe('ContextView — baseline gate', () => {
  test('a gated host renders the zeroed cards under the upgrade modal', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-gated',
      useProjection: projectionsFor(timeline({ unsupported: { current: '0.1.1-rc.2', minimum: '0.2.0-rc.2' } })),
    }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    const card = query(m.container, '.lc-gate-card')
    assert.ok(text(card).includes(DICT_EN['gate.title']))
    assert.ok(text(card).includes('v0.1.1-rc.2'))
    assert.ok(text(card).includes('v0.2.0-rc.2'))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    await click(buttonByText(m.container, DICT_EN['gate.ok']))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    await m.unmount()

    const junk = await mount(h(View, {
      sessionId: 'sv-gate-junk',
      useProjection: projectionsFor(timeline({ unsupported: { current: 7 } })),
    }))
    assert.equal(junk.container.querySelector('.lc-modal-backdrop'), null)
    assert.ok(text(junk.container).includes(DICT_EN['overview.title']))
    await junk.unmount()
  })
})
