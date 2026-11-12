import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { act, createElement as h, useState } from 'react'
import { DICT_EN } from '../../../src/client/i18n'
import { type OverviewAutoSteps, type SurfaceNode } from '../../../src/shared/types'
import { TestClientCtx, TestLocale, asClientCtx } from '../helpers/harness'
import { click, flush, mount, pinRect, query, queryAll, text, until, silenceWindowErrors, makeKit } from '../helpers/kit'
import { buttonByText, makeView, mountRich, projectionsFor, settingsWith, T0, timeline, richTimeline } from './contextViewHarness'
import { createContextSettings } from '../../../src/client/settings'
import { type UseChatLike } from '../../../src/client/services'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { makeContextView, browserCapOf } from '../../../src/client/components/contextView'
import { pickValue } from './browserHarness'

describe('contextView.overview', () => {


function stepsTimeline(n: number) {
  return timeline({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    requests: Array.from({ length: n }, (_, i) => ({
      seq: (i + 1) * 2,
      turn: Math.floor(i / 2) + 1,
      step: (i % 2) + 1,
      time: T0 + i * 1000,
      system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0,
      total: 330,
    })),
  })
}

function viewWith(value: OverviewAutoSteps, sessionId: string, steps: number) {
  const View = makeView(new TestClientCtx(), settingsWith({ overviewAutoSteps: value }))
  return { View, props: { sessionId, useProjection: projectionsFor(stepsTimeline(steps)) } }
}

describe('ContextView — overview face', () => {
  test('the Overview chip rides right of Duration and clears DNA/Adaptive on activation', async () => {
    const m = await mountRich('sv-overview-chip')
    const mods = buttonByText(m.container, DICT_EN['trend.dna']).parentElement as HTMLElement
    const last = (mods.lastElementChild as HTMLElement).textContent
    assert.equal(last, DICT_EN['trend.overview'], 'Overview is the mods group\'s last chip')

    const overview = () => buttonByText(m.container, DICT_EN['trend.overview'])
    const dna = () => buttonByText(m.container, DICT_EN['trend.dna'])
    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    await click(dna())
    assert.ok(dna().className.includes('lc-gran-on'))
    await click(overview())
    assert.ok(overview().className.includes('lc-gran-on'))
    assert.equal(dna().className.includes('lc-gran-on'), false)
    await click(dna())
    assert.equal(overview().className.includes('lc-gran-on'), false)
    assert.ok(dna().className.includes('lc-gran-on'))
    await click(adaptive())
    assert.ok(dna().className.includes('lc-gran-on'))
    assert.ok(adaptive().className.includes('lc-gran-on'))
    await click(overview())
    assert.equal(dna().className.includes('lc-gran-on'), false)
    assert.equal(adaptive().className.includes('lc-gran-on'), false)
    assert.ok(overview().className.includes('lc-gran-on'))
    await click(overview())
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    await m.unmount()
  })

  test('the overview face swaps the bars for a full-width ribbon with the same detail flow', async () => {
    const m = await mountRich('sv-overview-ribbon')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.match(query(m.container, '.lc-chart-scroll').className, /lc-chart-fit/)
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 2 112')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '420')
    assert.deepEqual(queryAll(m.container, '.lc-trend-flag-label').map(f => f.textContent), ['2', '3'])
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['1', '0'])

    await click(query(m.container, '.lc-turn'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.match(query(m.container, '.lc-fit-cursor').className, /lc-fit-pin/)
    assert.ok(text(m.container).includes(DICT_EN['detail.turn'].replace('{t}', '1').replace('{n}', '2')))
    await m.unmount()
  })

  test('clicking a ribbon band opens that category in the browser and focuses the chart on it', async () => {
    const m = await mountRich('sv-overview-band-open')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    const surface = query(m.container, '.lc-chart')
    pinRect(surface, 400, 130)
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 60 }))
    })
    await flush()
    const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes(DICT_EN['cat.tools']), 'the tools category opens')
    const polys = queryAll(m.container, '.lc-fit-svg polygon')
    assert.equal(polys.length, 1)
    assert.equal(polys[0].getAttribute('data-cat'), 'tools')
    assert.equal(query(m.container, '.lc-fit-pin').style.left, '50%')
    assert.equal(pickValue(m), '4')
    await m.unmount()
  })

  test('the configured step count mounts on the ribbon face; crossing it switches once, and a manual toggle-off sticks', async () => {
    const atThreshold = viewWith('100', 'sv-overview-auto', 100)
    const direct = await mount(h(atThreshold.View, atThreshold.props))
    assert.equal(queryAll(direct.container, '.lc-bar').length, 0)
    assert.ok(query(direct.container, '.lc-fit-svg'))
    assert.ok(buttonByText(direct.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))
    await direct.unmount()

    const { View, props } = viewWith('100', 'sv-overview-auto-grow', 99)
    const m = await mount(h(View, props))
    assert.equal(queryAll(m.container, '.lc-bar').length, 99)
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    await m.update(h(View, { ...props, useProjection: projectionsFor(stepsTimeline(100)) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.ok(buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))
    assert.equal(buttonByText(m.container, DICT_EN['trend.dna']).className.includes('lc-gran-on'), false)
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.update(h(View, { ...props, useProjection: projectionsFor(stepsTimeline(101)) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 101)
    await m.unmount()
  })

  test('a higher threshold or the off choice keeps the bars', async () => {
    for (const [choice, steps] of [['300', 100], ['off', 300]] as const) {
      const { View, props } = viewWith(choice, `sv-overview-auto-${choice}`, steps)
      const m = await mount(h(View, props))
      assert.ok(queryAll(m.container, '.lc-bar').length > 0, `${choice} leaves the bars face on`)
      assert.equal(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-fit'), false)
      await m.unmount()
    }
  })

  test('a manual toggle-off survives a session round trip out of an auto-opened session', async () => {
    const { View, props } = viewWith('100', 'sv-overview-auto-sticky', 100)
    const m = await mount(h(View, props))
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.update(h(View, { ...props, sessionId: 'sv-overview-auto-other', useProjection: projectionsFor(stepsTimeline(3)) }))
    assert.ok(queryAll(m.container, '.lc-bar').length > 0)
    await m.update(h(View, props))
    assert.equal(queryAll(m.container, '.lc-bar').length, 100)
    await m.unmount()
  })
})
})

describe('contextView.projectionGuards', () => {

describe('ContextView — projection guards', () => {
  test('loading screen while useProjection is absent, empty, or the session id is missing; a served projection renders without one', async () => {
    const View = makeView(new TestClientCtx())

    for (const props of [
      { sessionId: 'sv-none' },
      { sessionId: '', useProjection: () => undefined },
      { useProjection: () => undefined },
    ]) {
      const m = await mount(h(View, props))
      assert.equal(queryAll(m.container, '.lc-empty').length, 0, 'no text mask covers the cold layout')
      assert.equal(queryAll(m.container, '.lc-deferred-skeleton').length, 0)
      assert.ok(queryAll(m.container, '.lc-loading-lane').length >= 2, 'the event and file lanes reserve their rows')
      assert.ok(query(m.container, '.lc-cols-main').children.length >= 2)
      for (const key of ['overview.title', 'stats.title', 'tokens.title', 'timing.title', 'trend.title', 'browser.title', 'events.title', 'files.title'] as const) {
        assert.ok(text(m.container).includes(DICT_EN[key]), `the ${key} card keeps its frame`)
      }
      await m.unmount()
    }

    const sidebar = await mount(h(View, { host: 'sidebar' }))
    try {
      assert.ok(!text(sidebar.container).includes(DICT_EN['stats.title']), 'the sidebar keeps its head-row omission')
      assert.ok(text(sidebar.container).includes(DICT_EN['tokens.title']))
      assert.ok(queryAll(sidebar.container, '.lc-loading-lane').length >= 2)
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
    assert.equal(queryAll(m.container, '.lc-loading-lane, .lc-skel-plot').length, 0, 'the failure notes replace the placeholders')
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
})

describe('contextView.agentNetwork', () => {

function selfOnly() {
  const snapshot = { byId: { 'sv-self': { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

const TIMING = { wallMs: 387_000, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }

describe('ContextView — the agent network card\'s own session', () => {
  test("the panel's active time and step count fill the current card's footer, or just the steps without timing", async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(text(self).includes('Main Agent'), true)
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    await m.unmount()

    const m2 = await mount(h(View, { sessionId: 'sv-self', host: 'sidebar', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(query(m2.container, '.lc-agent-self .lc-agent-meta-text').textContent, '3 steps')
    await m2.unmount()
  })

  test('the center Context tab hands the card to the Fleet tab; only the sidebar host keeps it inline', async () => {
    const View = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m = await mount(h(View, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline({ timing: TIMING })) }))

    assert.equal(queryAll(m.container, '.lc-agents').length, 0, 'no agent network on the Context tab')
    await m.unmount()
  })

  test("the stats board's Fleet section opens the Fleet tab, else the panel that keeps the card", async () => {
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
      await click(query(m.container, '.lc-ledger-team-head'))
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
    await click(query(m.container, '.lc-ledger-team-head'))
    assert.deepEqual(opened, ['dsh-context'], 'the sidebar panel whose Context tab holds the card')
    await m.unmount()

    const bare = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }))
    const m2 = await mount(h(bare, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    await click(query(m2.container, '.lc-ledger-team-head'))
    await m2.unmount()

    const settings = createContextSettings()
    settings.set('defaultPlacement', 'tab')
    settings.set('fleetTab', 'hide')
    const plainView = makeView(new TestClientCtx({ services: { sessions: selfOnly() } }), settings)
    const plain = await mount(h(plainView, { sessionId: 'sv-self', useProjection: projectionsFor(richTimeline()) }))
    const cell = query(plain.container, '.lc-ledger-team-head')
    assert.equal(cell.getAttribute('role'), null)
    assert.equal(cell.getAttribute('tabindex'), null)
    await plain.unmount()
  })
})
})

describe('contextView.settings', () => {

describe('ContextView — locale and settings', () => {
  const costed = timeline({
    cost: { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } } } },
    costRead: { usd: 0.45, ready: true },
  })

  test('cost prices in USD by default (no locale service), CNY under zh', async () => {
    const cases = [
      ['sv-usd', new TestClientCtx(), '$', '¥'],
      ['sv-cny', new TestClientCtx({ services: { locale: new TestLocale('zh') } }), '¥', '$'],
      ['sv-bare', new TestClientCtx({ services: { locale: {} } }), '$', '¥'],
    ] as const
    for (const [sessionId, ctx, shown, hidden] of cases) {
      const m = await mount(h(makeView(ctx), { sessionId, useProjection: projectionsFor(costed) }))
      await flush()
      assert.ok(text(m.container).includes(shown), `${sessionId}: ${shown}`)
      assert.ok(!text(m.container).includes(hidden), `${sessionId}: no ${hidden}`)
      await m.unmount()
    }
  })

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = settingsWith({ defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path', defaultDurationCurve: 'hide' })
    const View = makeView(new TestClientCtx(), settings)
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline({
        nodes: [
          ...richTimeline().nodes,
          { seq: 7, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 6000 },
          { seq: 8, cat: 'tool', tokens: 30, tool: 'read', text: 'a', time: T0 + 7000 },
          { seq: 9, cat: 'tool', tokens: 30, tool: 'read', text: 'z', time: T0 + 8000 },
        ],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] } })) as UseChatLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['trend.adaptive']).className.includes('lc-gran-on'), 'Adaptive follows the Delta default')
    assert.ok(!buttonByText(m.container, DICT_EN['trend.duration']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/a.ts', '/z.ts'])
    await m.unmount()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
      const real = createContextSettings()
      let fail = true
      const flaky = {
        ...real,
        defaultGranularity: (): 'step' | 'turn' => {
          if (fail) throw new Error('boom-settings')
          return real.defaultGranularity()
        },
      }
      const View = makeView(new TestClientCtx(), flaky)
      const m = await mount(h(View, {
        sessionId: 'sv-err',
        useProjection: projectionsFor(richTimeline()),
      }))
      assert.ok(text(m.container).includes(DICT_EN.error))
      assert.ok(text(m.container).includes('boom-settings'))

      fail = false
      await click(query(m.container, '.lc-error-retry'))
      assert.ok(text(m.container).includes(DICT_EN['overview.title']))
      assert.ok(!text(m.container).includes(DICT_EN.error))
      await m.unmount()
    } finally {
      silenceErrors()
    }
  })
})
})

describe('contextView.sidebarGate', () => {

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('ContextView — the right Sidebar gate', () => {
  test('a collapsed or inactive sidebar tab mounts no body; expanding it paints the same view', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    let expanded = false
    function useTabInfo(): { sidebar: { expanded: boolean }; tab: { visible: boolean } } {
      return { sidebar: { expanded }, tab: { visible: expanded } }
    }
    const props = { sessionId: 's-gate', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()), useTabInfo }
    const m = await mount(h(View, props))
    assert.equal(queryAll(m.container, '.lc-card').length, 0, 'nothing heavy renders while collapsed')
    assert.equal(m.container.childElementCount, 1, 'the stable root stays')
    expanded = true
    await m.update(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    assert.ok(text(m.container).includes(DICT_EN['tokens.title']))
    await m.unmount()
    ctx.dispose()
  })

  test('a floating pane stays mounted even while the sidebar track is collapsed', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const props = {
      sessionId: 's-float', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()),
      useTabInfo: () => ({ sidebar: { expanded: false }, tab: { visible: true } }),
    }
    const m = await mount(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0, 'the float is on screen; visibility wins over the track')
    await m.unmount()
    ctx.dispose()
  })

  test('without the host hook the body keeps the IntersectionObserver fallback', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const m = await mount(h(View, { sessionId: 's-gate2', host: 'sidebar', useProjection: projectionsFor(richTimeline()) }))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a tab-info seat that appears or disappears after mount keeps the gate rendering without shifting its hooks', async () => {
    const ctx = new TestClientCtx()
    const View = makeContextView(asClientCtx(ctx), kit, createContextSettings(), makeAgentHeads())
    const props = { sessionId: 's-flip', host: 'sidebar' as const, useProjection: projectionsFor(richTimeline()) }
    const m = await mount(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    function useTabInfo(): { tab: { visible: boolean } } {
      const [visible] = useState(true)
      return { tab: { visible } }
    }
    const seated = { ...props, useTabInfo }
    await m.update(h(View, seated))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.update(h(View, props))
    assert.ok(queryAll(m.container, '.lc-card').length > 0)
    await m.unmount()
    ctx.dispose()
  })
})
})

describe('contextViewBrowserCap', () => {

describe('browserCapOf — the Context browser column\'s height ceiling', () => {
  test('the card span rounded UP, and no usable measurement leaves the column uncapped', () => {
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609 }]), 509)
    assert.equal(browserCapOf([{ top: 100, bottom: 280.4 }, { top: 287.4, bottom: 609.4 }]), 510)
    assert.equal(browserCapOf([]), null, 'the loading frame measures nothing')
    assert.equal(browserCapOf([{ top: 0, bottom: 0 }]), null, 'a degenerate span')
    assert.equal(browserCapOf([{ top: 10, bottom: 5 }]), null)
    assert.equal(browserCapOf([{ top: Number.NaN, bottom: 10 }]), null, 'a layout-less stub never yields NaN')
    assert.equal(browserCapOf([{ top: 0, bottom: undefined as unknown as number }]), null)
  })
})
})

describe('contextViewLazyDna', () => {

const kit = makeKit()

function makeViewNoAutoOverview() {
  return makeView(new TestClientCtx(), settingsWith({ overviewAutoSteps: 'off' }))
}

function bigTimeline() {
  const requests = Array.from({ length: 600 }, (_, i) => ({
    time: T0 + i * 1_000,
    seq: i + 1,
    turn: 1 + Math.floor(i / 100),
    step: i % 100,
    system: 10,
    tools: 20,
    user: 5,
    inject: 0,
    assistant: 15,
    tool: 5,
    total: 55,
    activeMs: 1_000 + i,
  }))
  const nodes: SurfaceNode[] = Array.from({ length: 200 }, (_, i) => ({
    seq: i + 1, cat: 'assistant', tokens: 10, text: `reply ${i}`,
  })) as SurfaceNode[]
  return timeline({ requests, nodes })
}

function mountBig(sessionId: string) {
  const View = makeViewNoAutoOverview()
  return mount(h(View, {
    sessionId,
    useProjection: projectionsFor(bigTimeline()),
    useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
  }))
}

describe('ContextView lazy DNA bands', () => {
  test('a long log assembles DNA bands only for the rendered window, in total and delta mode', async () => {
    const m = await mountBig('sv-lazy-dna')
    try {
      await act(async () => { buttonByText(m.container, kit.t('trend.dna')).click() })
      await flush()
      const dnaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(dnaBars.length > 0, 'DNA bars render from the lazy accessor')
      assert.ok(dnaBars.length < 600, `only the window is assembled (${dnaBars.length})`)
      assert.equal(queryAll(m.container, '.lc-cat-seg').length, 0)

      await act(async () => { buttonByText(m.container, kit.t('gran.delta')).click() })
      await flush()
      const deltaBars = queryAll(m.container, '.lc-bar-dna')
      assert.ok(deltaBars.length > 0)
      assert.ok(deltaBars.length < 600, `only the window paints a band (${deltaBars.length})`)
    } finally {
      await m.unmount()
    }
  })
})
})

describe('contextViewLazyMount', () => {

type ObserverCallback = IntersectionObserverCallback

function stubIntersection(): { callbacks: ObserverCallback[] } {
  const callbacks: ObserverCallback[] = []
  class FakeObserver {
    constructor(callback: ObserverCallback) { callbacks.push(callback) }
    observe = (): void => {}
    disconnect = (): void => {}
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  return { callbacks }
}

describe('ContextView below-fold lazy mount', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('keeps the skeletons until the rows near the viewport, then mounts every card', async () => {
    const observer = stubIntersection()
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return 1 })
    vi.stubGlobal('cancelIdleCallback', () => {})
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-lazy',
      useProjection: projectionsFor(timeline({
        events: [{ seq: 1, time: 1, kind: 'inject', tokens: 1 }],
        fileOps: [{ seq: 2, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      })),
      useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      assert.equal(queryAll(m.container, '.lc-loading-lane').length, 3, 'the three cards reserve their bodies')
      assert.equal(queryAll(m.container, '.lc-events').length, 0)
      assert.equal(queryAll(m.container, '.lc-fa-list').length, 0)
      await act(async () => {
        for (const callback of observer.callbacks) callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
      assert.equal(idle.length, 3)
      await act(async () => { for (const run of idle) run() })
      await flush()
      assert.equal(queryAll(m.container, '.lc-loading-lane').length, 0)
      assert.equal(queryAll(m.container, '.lc-events').length, 1)
      assert.equal(queryAll(m.container, '.lc-fa-list').length, 1)
      assert.equal(queryAll(m.container, '.lc-cmd-card').length, 1)

      await m.unmount()
      const second = await mount(h(View, {
        sessionId: 'sv-lazy-jump',
        useProjection: projectionsFor(timeline({
          fileOps: [{ seq: 2, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
        })),
        useChat: (selector => selector({ legacy: { nodes: [] } })) as UseChatLike,
      }))
      const pill = queryAll(second.container, '.lc-ledger-in-chips .lc-ledger-chip').find(el => text(el).startsWith(DICT_EN['files.kind.read']))
      assert.ok(pill !== undefined)
      assert.equal(queryAll(second.container, '.lc-fa-list').length, 0, 'the card body waits for the mount')
      await click(pill)
      await flush()
      assert.equal(queryAll(second.container, '.lc-fa-list').length, 1, 'the jump mounts the lazy card')
      await second.unmount()
    } finally {
      await m.unmount()
    }
  })
})
})
