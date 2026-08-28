// ContextView (src/client/components/contextView.tsx) — the Context tab root
// rendered for real: stats, composition, trend chart, events, file activity
// and the composed Context browser, driven by real projection values and real
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
import { click, flush, hover, makeKit, mount, query, queryAll, silenceWindowErrors, text, unhover } from '../helpers/kit'

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

  test('renders the full tab without a session id (the agent card anchors nothing)', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { useProjection: projectionsFor(timeline()) }))
    assert.ok(text(m.container).includes(DICT_EN['overview.title']))
    assert.ok(text(m.container).includes(DICT_EN.footer))
    await m.unmount()
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
    assert.ok(text(m.container).includes(DICT_EN['files.empty']))
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
      useSession: (sel => sel({ nodes: [] })) as UseSessionLike,
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
    assert.ok(text(m.container).includes(DICT_EN['files.title']))
    assert.ok(text(m.container).includes(DICT_EN['files.scopeLatest']))
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

  test('composition legend hover lights the linked browser category', async () => {
    const m = await mountRich('sv-link')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)

    const chip = query(comp, '.lc-legend .lc-chip')
    await hover(chip)
    assert.ok(query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await unhover(chip)
    assert.ok(!query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await m.unmount()
  })

  test('browser category hover lights the trend chart segments and the detail composition bar', async () => {
    const m = await mountRich('sv-link-trend')
    // Category rows render in CATS order; hover "tools" (second row).
    const toolsRow = queryAll(m.container, '.lc-br-cat-row')[1]
    await hover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    // The detail's composition bar mirrors the same key with its tip off (covered in requestDetail.spec).
    const detailBar = query(m.container, '.lc-detail .lc-stacked')
    assert.ok(detailBar.className.includes('lc-stacked-dim'))
    assert.ok(queryAll(detailBar, '.lc-stacked-seg-on').length === 1)
    assert.ok(queryAll(m.container, '.lc-detail-row-on').length === 1, 'the matching detail row lights too')

    await unhover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))

    // The overview's 'free' track hover names no category — the trend card stays neutral (same filter as the browser link).
    await hover(query(m.container, '.lc-stacked-free'))
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))
    await unhover(query(m.container, '.lc-stacked-free'))
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

describe('ContextView — file activity card', () => {
  /** Six steps with two file ops: a live read (seq 3) and an edit (seq 5) compacted away before seq 6 dispatched. */
  function fileTimeline(): ContextTimeline {
    const req = (seq: number, time: number, extra: Record<string, unknown> = {}) =>
      ({ seq, time, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70, ...extra })
    return timeline({
      requests: [
        req(2, T0 + 1000, { turn: 1, step: 1 }),
        req(4, T0 + 3000, { turn: 1, step: 2 }),
        req(6, T0 + 5000), // two turn-less mid-session steps form their own aggregate
        req(7, T0 + 6000),
        req(8, T0 + 7000, { turn: 2, step: 1 }), // a single-step turn, not the last bar
        req(9, T0 + 8000, { turn: 3, step: 1 }),
      ],
      nodes: [
        { seq: 1, cat: 'user', tokens: 10, text: 'hi', time: T0 + 500 },
        { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
        { seq: 3, cat: 'tool', tokens: 30, tool: 'read', time: T0 + 2000 },
        { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
        { seq: 6, cat: 'assistant', tokens: 80, text: 'r3', time: T0 + 5000 },
        { seq: 7, cat: 'assistant', tokens: 80, text: 'r3b', time: T0 + 6000 },
        { seq: 8, cat: 'assistant', tokens: 80, text: 'r4', time: T0 + 7000 },
        { seq: 9, cat: 'assistant', tokens: 80, text: 'r5', time: T0 + 8000 },
      ],
      archive: [
        { seq: 5, cat: 'tool', tokens: 30, tool: 'edit', gone: 6, time: T0 + 4000 },
      ],
    })
  }

  const fileConv = [
    { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/src/a.ts' }) } },
    { kind: 'tool', seq: 5, call: { name: 'edit', argsRaw: JSON.stringify({ file_path: '/src/a.ts', old_string: 'a\nb', new_string: 'a' }) } },
  ]

  async function mountFiles(sessionId: string) {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId,
      useProjection: projectionsFor(fileTimeline()),
      useSession: (sel => sel({ nodes: fileConv })) as UseSessionLike,
    }))
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    return { m, card }
  }

  test('follows the chart pick: the scope label and the exclusive next-step bound', async () => {
    const { m, card } = await mountFiles('sv-files-scope')
    // Default (latest bar): everything served, edit delta included.
    assert.ok(text(card).includes(DICT_EN['files.scopeLatest']))
    assert.ok(text(card).includes('+1') && text(card).includes('−2'))

    // Hovering the FIRST bar bounds the fold at the second request: the edit drops out.
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    assert.ok(text(card).includes('Turn 1 · Step 1'))
    assert.equal(queryAll(card, '.lc-fa-meta-delta').length, 0)
    assert.equal(queryAll(card, '.lc-fa-row').length, 1)
    assert.ok(!text(card).includes('+1'))

    // The turn-less mid step falls back to zero labels and still bounds at the next request.
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    assert.ok(text(card).includes('Turn 0 · Step 0'))
    assert.ok(text(card).includes('+1'))

    await unhover(query(m.container, '.lc-chart'))
    assert.ok(text(card).includes(DICT_EN['files.scopeLatest']))
    await m.unmount()
  })

  test('turn aggregates label the scope; op clicks reveal the result in the browser', async () => {
    const { m, card } = await mountFiles('sv-files-locate')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    // Turn 1's aggregate (two steps) labels the scope as a turn.
    await hover(query(m.container, '.lc-bar[data-seq="4"]'))
    assert.ok(text(card).includes(DICT_EN['detail.turn'].replace('{t}', '1').replace('{n}', '2')))
    // The turn-less pair aggregates too: a turn label with zeroed turn.
    await hover(query(m.container, '.lc-bar[data-seq="7"]'))
    assert.ok(text(card).includes(DICT_EN['detail.turn'].replace('{t}', '0').replace('{n}', '2')))
    // A single-step turn aggregate labels as a plain step.
    await hover(query(m.container, '.lc-bar[data-seq="8"]'))
    assert.ok(text(card).includes('Turn 2 · Step 1'))
    await unhover(query(m.container, '.lc-chart'))

    // Expand the file row: the compacted edit (seq 5) has no viewing step and
    // its click is a no-op; the read (seq 3) reveals in step 4's surface.
    await click(query(card, '.lc-fa-row'))
    const ops = queryAll(card, '.lc-fa-op')
    assert.equal(ops.length, 2)
    await click(ops[0]) // edit, gone = 6: unlocatable
    assert.equal(pick.value, 'live')
    await click(ops[1]) // read at seq 3
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('/src/a.ts'))
    await m.unmount()
  })

  test('a nested PTC op reveals on its parent run_code result, not on its dispatch seq', async () => {
    const ptcTimeline = timeline({
      requests: [
        { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70 },
        { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70 },
      ],
      nodes: [
        { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
        { seq: 3, cat: 'tool', tokens: 30, tool: 'run_code', time: T0 + 2000 },
        { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
      ],
    })
    const ptcConv = [
      {
        kind: 'tool-result',
        seq: 3,
        call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'await tools.edit(…)', description: 'Fix the failing test' }) },
        subCalls: [
          {
            kind: 'tool-result',
            seq: 2,
            time: T0 + 1500,
            call: { name: 'edit', argsRaw: JSON.stringify({ file_path: '/src/a.ts', old_string: 'a\nb', new_string: 'a' }) },
            isError: false,
            subCalls: [],
          },
        ],
      },
    ]
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-ptc-locate',
      useProjection: projectionsFor(ptcTimeline),
      useSession: (sel => sel({ nodes: ptcConv })) as UseSessionLike,
    }))
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    await click(query(card, '.lc-fa-row'))
    // The op is attributed to the nested tool, and says why (its program).
    assert.ok(text(card).includes('edit'))
    assert.ok(text(card).includes('Fix the failing test'))
    // The click lands on the parent run_code node (seq 3 → step 4's surface).
    await click(query(card, '.lc-fa-op'))
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('Fix the failing test'))
    await m.unmount()
  })

  test('the session workspace relativizes row paths; the host opener opens the resolved file', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'sv-files-open': { cwd: '/repo' } } }) } },
        connection: {
          hostDescription: { getSnapshot: () => ({ canOpenPath: true }) },
          api: { host: { openPath: (r: { path: string }) => { opened.push(r.path); return Promise.resolve({ opened: true }) } } },
        },
      },
    })
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/repo/src/a.ts' }) } },
    ]
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-files-open',
      useProjection: projectionsFor(fileTimeline()),
      useSession: (sel => sel({ nodes: conv })) as UseSessionLike,
    }))
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    // The read inside the session cwd displays './'-relative…
    const row = query(card, '.lc-fa-row')
    assert.ok(row.querySelector('.lc-fa-path em')?.textContent === './src/')
    // …and its name opens on the system through the host RPC.
    const name = query(row, '.lc-fa-file')
    assert.equal(name.getAttribute('title'), DICT_EN['files.open'])
    await click(name)
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    await m.unmount()
  })

  test('a ctx without service access degrades the card wiring, not the view', async () => {
    const View = makeView({} as unknown as TestClientCtx)
    // No session id: the view stays on its loading screen; the workspace and
    // opener wiring (both read ctx before the early return) resolve to nothing.
    const m = await mount(h(View, { sessionId: '' }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
  })
})

describe('ContextView — targeted content fetch and image loading', () => {
  test('opening an un-joined node reads one seq-anchored history page through the connection api', async () => {
    const calls: { sessionId: string; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({
      services: {
        connection: {
          api: {
            sessions: {
              history: (request: { sessionId: string; beforeSeq: number }) => {
                calls.push(request)
                return Promise.resolve({
                  result: {
                    ok: true,
                    value: {
                      events: [
                        { event: { type: 'user/message', seq: request.beforeSeq - 1, data: { content: [{ type: 'text', text: 'OLD FULL BODY' }] } } },
                      ],
                    },
                  },
                })
              },
            },
          },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-page',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useSession: (sel => sel({ nodes: [] })) as UseSessionLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await click(query(m.container, '.lc-br-elem-row'))
    await flush()
    assert.deepEqual(calls, [{ sessionId: 'sv-page', beforeSeq: 2 }], 'one read anchored just past the seq')
    assert.ok(text(m.container).includes('OLD FULL BODY'), 'mapped page content renders')
    await m.unmount()
  })

  test('without a connection face an uncached node shows the static note', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-nopage',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useSession: (sel => sel({ nodes: [] })) as UseSessionLike,
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

  test('mount-time granularity/trend/file-sort defaults come from the bound settings scope', async () => {
    const settings = createContextSettings()
    const scope: SettingsScopeLike = {
      getSnapshot: () => ({
        status: 'ready',
        writable: true,
        value: { defaultGranularity: 'turn', defaultTrendMode: 'delta', defaultFileSort: 'path' },
      }),
      subscribe: () => () => {},
      set: async () => {},
    }
    const detach = settings.attach(scope)
    const View = makeView(new TestClientCtx(), settings)
    // Two file reads (the 2-op path sorts AFTER the 1-op one under 'count' but BEFORE it under 'path').
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
      useSession: (sel => sel({ nodes: [
        { kind: 'tool', seq: 7, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
        { kind: 'tool', seq: 8, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/a.ts' }) } },
        { kind: 'tool', seq: 9, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/z.ts' }) } },
      ] })) as UseSessionLike,
    }))
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.ok(buttonByText(m.container, DICT_EN['gran.delta']).className.includes('lc-gran-on'))
    // Turn aggregation applies at mount: two bars (turn 1 aggregate + turn-less).
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    // The File Activity card opens sorted by the 'path' preference, not by op count.
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/a.ts', '/z.ts'])
    await m.unmount()
    detach()
  })
})

describe('ContextView — error boundary', () => {
  test('a render failure degrades to the error card and Retry recovers', async () => {
    // React 18 dev replays the failed render through a fake DOM event (loud
    // stderr via jsdom/vitest) and logs the boundary message to console —
    // both silenced so the deliberate throw stays inside this test.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const silenceErrors = silenceWindowErrors()
    try {
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
    } finally {
      silenceErrors()
    }
  })
})
