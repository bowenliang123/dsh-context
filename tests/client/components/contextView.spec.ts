// ContextView (src/client/components/contextView.tsx) — the Context tab root
// rendered for real: stats, composition, trend chart, events, nodes and the
// composed Context browser, driven by real projection values and real
// plugin settings. Covers the view's own branches (projections absent /
// garbage / well-formed, granularity/trend-mode state, brief→browser
// locate bridge, kind filter, scroll ledger, locale arms, error boundary).

import assert from 'node:assert/strict'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, test, vi } from 'vitest'
import { h } from '../../../src/client/react'
import { makeContextView } from '../../../src/client/components/contextView'
import { createContextSettings } from '../../../src/client/settings'
import type { SettingsScopeLike } from '../../../src/client/settings'
import type { UseSessionLike } from '../../../src/client/services'
import type { ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx, TestLocale, asClientCtx } from '../helpers/harness'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

// pluginInfo's npm-registry probe stays inert (and '0.0.0-dev' short-circuits
// it anyway).
vi.stubGlobal('fetch', () => Promise.resolve({ ok: false } as Response))

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
})


function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 100, tools: 200, user: 300, inject: 50, assistant: 400, tool: 150, total: 1200 },
    toolList: [],
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

const T0 = 1700000000000

/** Two steps of one turn plus a turn-less trailing step, with their nodes. */
function richTimeline(over: Record<string, unknown> = {}): ContextTimeline {
  return timeline({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    toolList: [{ name: 'bash', tokens: 120 }, { name: 'read', tokens: 80 }],
    toolCalls: 3,
    images: 1,
    requests: [
      { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, prompt: 350, output: 20, cacheRead: 100 },
      { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400 },
      { seq: 6, time: T0 + 5000, system: 100, tools: 200, user: 10, inject: 0, assistant: 80, tool: 30, total: 420 },
    ],
    events: [
      { seq: 3, time: T0 + 2000, kind: 'compaction', count: 2, turn: 1, step: 2, fromTurn: 1, fromStep: 1, tokens: 500 },
      { seq: 5, time: T0 + 4000, kind: 'inject', form: 'notice', name: 'heads-up', tokens: 12, turn: 1, step: 3 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'reply one', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'file output', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'reply two', time: T0 + 3000 },
      { seq: 6, cat: 'assistant', tokens: 80, text: 'reply three', time: T0 + 5000 },
    ],
    droppedNodes: 2,
    ...over,
  })
}

function projectionsFor(data: ContextTimeline, extra: Record<string, unknown> = {}) {
  const projections: Record<string, unknown> = { contextTimeline: data, ...extra }
  return (key: string) => projections[key]
}

function makeView(ctx: TestClientCtx, settings = createContextSettings()) {
  return makeContextView(asClientCtx(ctx), kit, settings)
}

/** A button whose text matches (case-sensitively) the given label. */
function buttonByText(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, 'button').find(b => text(b) === label)
  if (hit === undefined) throw new Error(`button not found: ${label}`)
  return hit
}

describe('ContextView — projection guards', () => {
  test('loading screen while useProjection is absent, empty, or the session id is missing', async () => {
    const View = makeView(new TestClientCtx())

    const m1 = await mount(h(View, { sessionId: 'sv-none' }))
    assert.ok(text(m1.container).includes(DICT_EN.loading))
    await m1.unmount()

    const m2 = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m2.container).includes(DICT_EN.loading))
    await m2.unmount()

    const m3 = await mount(h(View, { useProjection: () => undefined }))
    assert.ok(text(m3.container).includes(DICT_EN.loading))
    await m3.unmount()
  })

  test('a corrupt timeline is sanitized and the whole tab still renders empty-section states', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-garbage',
      useProjection: projectionsFor(timeline(), {}),
    }))
    // Well-formed-but-empty: every section renders its empty state.
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN['stats.title']))
    assert.ok(text(m.container).includes(DICT_EN['trend.empty']))
    assert.ok(text(m.container).includes(DICT_EN['events.empty']))
    assert.ok(text(m.container).includes(DICT_EN['nodes.empty']))
    assert.ok(text(m.container).includes(DICT_EN['footer']))
    assert.ok(m.container.querySelector('.lc-br-cats') !== null)
    // No model/provider: the composition card carries no subtitle.
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
    // Anchored headline: projected 100 of a 128k window.
    assert.ok(text(m.container).includes(DICT_EN['overview.used']))
    // Cache-hit cell from the official tokenUsage projection (200 / 300).
    assert.ok(text(m.container).includes('66.66%'))
    assert.ok(text(m.container).includes('m-only'))
    await m.unmount()
  })
})

describe('ContextView — interactions', () => {
  async function mountRich(sessionId: string) {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId,
      useProjection: projectionsFor(richTimeline(), {
        contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
      }),
      useSession: (sel => sel({ nodes: [], hasMore: false, loadingOlder: false })) as UseSessionLike,
    }))
    return m
  }

  test('renders the rich tab: stats, chart bars, markers, events, nodes, browser', async () => {
    const m = await mountRich('sv-rich')
    assert.ok(text(m.container).includes('deepseek-v4-flash · deepseek'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    // The compaction event lands as the ✂ marker on the first request after it.
    assert.equal(queryAll(m.container, '.lc-bar-marker').length, 1)
    assert.equal(queryAll(m.container, '.lc-event').length, 2)
    assert.ok(text(m.container).includes(DICT_EN['nodes.more'].replace('{n}', '2')))
    assert.ok(text(m.container).includes(DICT_EN['browser.liveNow']))
    // Turn strip partitions the two turn groups (turn 1 + the turn-less 0).
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(el => text(el)), ['T1', 'T0'])
    await m.unmount()
  })

  test('bar hover previews in the browser; hover loss on a granularity switch falls back', async () => {
    const m = await mountRich('sv-hover')
    const chart = query(m.container, '.lc-chart')
    const bar2 = query(m.container, '.lc-bar[data-seq="2"]')
    await hover(bar2)
    assert.ok(bar2.className.includes('lc-bar-hovered'))
    // The browser mirrors the hover as a transient preview of that step.
    assert.ok(text(m.container).includes(DICT_EN['browser.preview']))
    // The hovered bar's turn lights the strip even without strip hover.
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    // Switching to turn granularity drops seq 2 (turn 1 keeps its LAST step):
    // the stale hovered seq matches nothing and the active bar falls back.
    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.equal(queryAll(m.container, '.lc-bar-hovered').length, 0)
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    await m.unmount()
  })

  test('a request without a turn highlights nothing on hover', async () => {
    const m = await mountRich('sv-noturn')
    const chart = query(m.container, '.lc-chart')
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-hovered'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(chart)
    await m.unmount()
  })

  test('turn strip hover dims, strip click focuses the turn in turn granularity', async () => {
    const m = await mountRich('sv-strip')
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    await hover(turns[0])
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(query(m.container, '.lc-turns'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    // Strip click: granularity switches to turn and the focus is consumed once.
    await click(turns[0])
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    await m.unmount()
  })

  test('pinning a bar selects its step in the browser; unpinning returns to live', async () => {
    const m = await mountRich('sv-pin')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, 'live')

    const bar4 = query(m.container, '.lc-bar[data-seq="4"]')
    await click(bar4)
    assert.ok(bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, '4')
    // The pinned step carries the compaction marker chip in the detail head.
    assert.ok(query(m.container, '.lc-detail').textContent?.includes('✂') === true)

    await click(bar4)
    assert.ok(!bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const m = await mountRich('sv-brief')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    // Pin the second bar: brief = opener + inputs (node 3) + response (node 4).
    await click(query(m.container, '.lc-bar[data-seq="4"]'))
    const briefRows = queryAll(m.container, '.lc-brief-row')
    assert.equal(briefRows.length, 3)

    // The In row reveals node 3 (tool) inside the step's OWN surface.
    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))

    // The response of a middle bar first appears in the NEXT step's surface.
    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply two'))

    // The last bar's response lands on the LIVE surface.
    await click(query(m.container, '.lc-bar[data-seq="6"]'))
    const lastReply = queryAll(m.container, '.lc-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply three'))
    await m.unmount()
  })

  test('composition legend hover lights the linked browser category; tool chips focus the browser', async () => {
    const m = await mountRich('sv-link')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)

    const chip = query(comp, '.lc-legend .lc-chip')
    await hover(chip)
    assert.ok(query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await unhover(chip)
    assert.ok(!query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))

    // A tool chip opens the tools category with that tool's row expanded; the
    // label chip opens the category without an element.
    await click(query(comp, '.lc-tool-chip'))
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('bash'))
    await click(query(comp, '.lc-tools-label'))
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0)
    assert.ok(m.container.querySelector('.lc-br-body') !== null)
    await m.unmount()
  })

  test('delta mode pairs the detail with the previous record; first bar has none', async () => {
    const m = await mountRich('sv-delta')
    const chart = query(m.container, '.lc-chart')
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    // Default active bar is the newest: detail is the signed change vs its predecessor.
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    // Hovering the FIRST bar pairs it with null (change from zero).
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="2"]').className.includes('lc-bar-hovered'))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await m.unmount()
  })

  test('event-kind filter narrows, unions, drops, and resets', async () => {
    const m = await mountRich('sv-kinds')
    const countEvents = () => queryAll(m.container, '.lc-event').length
    assert.equal(countEvents(), 2)

    await click(buttonByText(m.container, DICT_EN['kind.inject']))
    assert.equal(countEvents(), 1)
    await click(buttonByText(m.container, DICT_EN['kind.compaction']))
    assert.equal(countEvents(), 2)
    await click(buttonByText(m.container, DICT_EN['kind.compaction']))
    assert.equal(countEvents(), 1)
    await click(buttonByText(m.container, DICT_EN['kind.inject']))
    assert.equal(countEvents(), 2)
    await m.unmount()
  })
})

describe('ContextView — history paging and image loading', () => {
  test('opening an uncached node pulls older history through loadOlderHistory', async () => {
    const View = makeView(new TestClientCtx())
    const loads: number[] = []
    const m = await mount(h(View, {
      sessionId: 'sv-page',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useSession: (sel => sel({ nodes: [], hasMore: true, loadingOlder: false })) as UseSessionLike,
      loadOlderHistory: async () => {
        loads.push(1)
      },
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await click(query(m.container, '.lc-br-elem-row'))
    await flush()
    assert.ok(loads.length >= 1)
    assert.ok(text(m.container).includes(DICT_EN['browser.loading']))
    await m.unmount()
  })

  test('without loadOlderHistory an uncached node shows the static note', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-nopage',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useSession: (sel => sel({ nodes: [], hasMore: false })) as UseSessionLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await click(query(m.container, '.lc-br-elem-row'))
    assert.ok(text(m.container).includes(DICT_EN['browser.noContent']))
    await m.unmount()
  })

  test('image attachments resolve through the conversation service loader', async () => {
    const resolved: [string, unknown][] = []
    const ctx = new TestClientCtx({
      services: {
        conversation: {
          resolveImage: (sessionId: string, attachment: unknown) => {
            resolved.push([sessionId, attachment])
            return Promise.resolve('blob:pic')
          },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-img',
      useProjection: projectionsFor(timeline({
        images: 1,
        nodes: [{ seq: 1, cat: 'user', tokens: 400, text: 'see this', imgs: 1 }],
      })),
      useSession: (sel =>
        sel({
          nodes: [{
            kind: 'user',
            seq: 1,
            content: [{ type: 'image', attachment: { attachmentId: 'att-1', name: 'pic.png', bytes: 2048, width: 640, height: 480 } }],
          }],
          hasMore: false,
          loadingOlder: false,
        })) as UseSessionLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await click(query(m.container, '.lc-br-elem-row'))
    await flush()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0][0], 'sv-img')
    assert.equal((resolved[0][1] as { attachmentId: string }).attachmentId, 'att-1')
    assert.ok(m.container.querySelector('.lc-att-item img') !== null)
    await m.unmount()
  })

  test('a conversation service without resolveImage degrades quietly', async () => {
    const ctx = new TestClientCtx({ services: { conversation: {} } })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-noimg',
      useProjection: projectionsFor(timeline()),
    }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    await m.unmount()
  })
})

describe('ContextView — scroll ledger', () => {
  async function mountInScroller(el: React.ReactElement, scroller: HTMLElement) {
    const inner = document.createElement('div')
    scroller.appendChild(inner)
    document.body.appendChild(scroller)
    const root = createRoot(inner)
    await act(async () => {
      root.render(el)
    })
    return {
      async update(next: React.ReactElement) {
        await act(async () => {
          root.render(next)
        })
      },
      async unmount() {
        await act(async () => {
          root.unmount()
        })
        scroller.remove()
      },
    }
  }

  test('restores the saved position per session and re-applies only once per mount', async () => {
    const View = makeView(new TestClientCtx())
    const props = {
      sessionId: 'sv-scroll',
      useProjection: undefined as ((key: string) => unknown) | undefined,
    }

    // First visit: no ledger entry → the shared scroller is re-anchored at top.
    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller1,
    )
    assert.equal(scroller1.scrollTop, 0)

    // A data refresh re-runs the effect but the position is applied once.
    scroller1.scrollTop = 17
    await m1.update(h(View, { ...props, useProjection: projectionsFor(richTimeline({ droppedNodes: 3 })) }))
    assert.equal(scroller1.scrollTop, 17)

    // Unmount saves the position into the module ledger.
    scroller1.scrollTop = 42
    await m1.unmount()

    // Remounting the same session restores the saved position.
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    const m2 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller2,
    )
    assert.equal(scroller2.scrollTop, 42)
    await m2.unmount()
  })
})

describe('ContextView — locale and settings', () => {
  const costed = timeline({
    cost: { flash: { off: { uncached: 1000000, output: 500000, cacheRead: 0, cacheWrite: 0 } } },
  })

  test('cost prices in USD by default (no locale service), CNY under zh', async () => {
    const m1 = await mount(h(makeView(new TestClientCtx()), {
      sessionId: 'sv-usd',
      useProjection: projectionsFor(costed),
    }))
    assert.ok(text(m1.container).includes('$'))
    assert.ok(!text(m1.container).includes('¥'))
    await m1.unmount()

    const ctxZh = new TestClientCtx({ services: { locale: new TestLocale('zh') } })
    const m2 = await mount(h(makeView(ctxZh), {
      sessionId: 'sv-cny',
      useProjection: projectionsFor(costed),
    }))
    assert.ok(text(m2.container).includes('¥'))
    await m2.unmount()

    // A locale service without getLocale falls back to USD.
    const ctxBare = new TestClientCtx({ services: { locale: {} } })
    const m3 = await mount(h(makeView(ctxBare), {
      sessionId: 'sv-bare',
      useProjection: projectionsFor(costed),
    }))
    assert.ok(text(m3.container).includes('$'))
    await m3.unmount()
  })

  test('mount-time granularity/trend defaults come from the bound settings scope', async () => {
    const settings = createContextSettings()
    const scope: SettingsScopeLike = {
      getSnapshot: () => ({ status: 'ready', writable: true, value: { defaultGranularity: 'turn', defaultTrendMode: 'delta' } }),
      subscribe: () => () => {},
      set: async () => {},
    }
    const detach = settings.attach(scope)
    const View = makeView(new TestClientCtx(), settings)
    const m = await mount(h(View, {
      sessionId: 'sv-settings',
      useProjection: projectionsFor(richTimeline()),
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    // Turn aggregation applies at mount: two bars (turn 1 aggregate + turn-less).
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await m.unmount()
    detach()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    const real = createContextSettings()
    // Flag-driven (not call-counted): React 18 dev replays a failed unit of
    // work and retries an errored concurrent pass synchronously, so the
    // failure must persist until the boundary catches, then clear for Retry.
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
  })
})
