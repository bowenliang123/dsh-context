// @vitest-environment jsdom
import assert from 'node:assert/strict'
import * as React from 'react'
import { describe, test } from 'vitest'
import { createContextScene, type SceneTab } from '../../src/tui/scene'
import type { ContextSource } from '../../src/tui/source'
import type { SurfaceHost, SurfaceUi } from '../../src/tui/hostTypes'
import {
  baseUi, fakeHost, headersFixture, kitProps, pressScene, render, sceneUi, staticSource, textOf, timelineFixture,
  type InputHolder,
} from './helpers'

const snapshot = { sessionId: 's1', cwd: '/w', lang: 'en', usage: { cost: { currency: 'USD', amount: 0.25 } } }

function scene(source: ContextSource, opts: { host?: SurfaceHost; columns?: number; rows?: number; ui?: SurfaceUi; tab?: SceneTab } = {}) {
  const input: InputHolder = {}
  const closed: number[] = []
  const Scene = createContextScene({
    source,
    defaults: () => ({ granularity: 'step', fileSort: 'count' }),
    opening: () => ({ serial: 1, ...(opts.tab !== undefined ? { tab: opts.tab } : {}) }),
  })
  const el = React.createElement(Scene, {
    React,
    ui: sceneUi(input, { columns: opts.columns ?? 100, rows: opts.rows ?? 30 }, opts.ui),
    close: () => { closed.push(1) },
    ...(opts.host !== undefined ? { host: opts.host } : {}),
  })
  return { el, input, closed }
}

const full = () => staticSource({ timeline: timelineFixture(), headers: headersFixture() })

describe('context scene', () => {
  test('opens on the overview: tab strip, headline, bars with the trigger note, and the stat sections', async () => {
    const { el } = scene(full(), { host: fakeHost(snapshot) })
    const view = await render(el)
    const text = textOf(view.container)
    assert.ok(text.startsWith(' 1 Overview  2 Trend  3 Browser  4 Events  5 Files Context 2.1% · 4.1k/200.0k'), text)
    assert.ok(text.includes('Auto-compaction is expected to fire at 63% of the window'))
    assert.ok(text.endsWith('Tab/1-5 switch · Esc close'))
    const tables = kitProps<{ rows: { label: string; value: string }[]; width: number }>(view.container, 'Table')
    assert.equal(tables.length, 3)
    assert.equal(tables[0].width, 32, 'three sections and their gaps fill 100 columns exactly')
    assert.ok(tables[1].rows.some(r => r.label === 'Cost' && r.value === '$0.25'))
    assert.equal(view.container.querySelector('[data-bold="1"][data-inverse="1"]')?.textContent, ' 1 Overview ')
    await view.unmount()
  })

  test('the overview folds its stat sections to the width; a window without a reserve has no trigger note', async () => {
    const wide = await render(scene(full(), { columns: 130 }).el)
    assert.deepEqual(kitProps<{ width: number }>(wide.container, 'Table').map(t => t.width), [42, 42, 42])
    await wide.unmount()
    const narrow = await render(scene(staticSource({ timeline: timelineFixture({ contextWindow: 60_000 }) }), { columns: 60 }).el)
    assert.deepEqual(kitProps<{ width: number }>(narrow.container, 'Table').map(t => t.width), [29, 29, 29])
    assert.ok(textOf(narrow.container).startsWith(' 1 Overview  2  3  4  5 '), 'narrow terminals keep only the active tab name')
    assert.ok(!textOf(narrow.container).includes('Auto-compaction'))
    await narrow.unmount()
  })

  test('trend: stacked columns with the selection, its caption and the step brief; ←, t and narrow layouts', async () => {
    const { el, input } = scene(full(), { host: fakeHost(snapshot), columns: 170, tab: 'trend' })
    const view = await render(el)
    let chart = kitProps<{ columns: unknown[]; selected: number; columnWidth: number; gap: number; max: number; height: number }>(view.container, 'ColumnChart')[0]
    assert.deepEqual([chart.columns.length, chart.selected, chart.columnWidth, chart.gap, chart.max, chart.height], [3, 2, 4, 1, 4140, 12])
    let text = textOf(view.container)
    assert.ok(text.includes('Context Trend · Step · ✂ Compact/Prune'))
    assert.ok(text.includes('Turn 2 · Step 1 of 1 · 4.1k · 90s'))
    assert.ok(text.includes('User: and the tests'))
    await pressScene(input, '', { leftArrow: true })
    text = textOf(view.container)
    assert.ok(text.includes('Turn 1 · Step 2 of 2 · 3.7k'))
    assert.ok(text.includes('In: → read · read: export const a = 1'))
    await pressScene(input, 't')
    chart = kitProps<typeof chart>(view.container, 'ColumnChart')[0]
    assert.equal(chart.columns.length, 2)
    assert.ok(textOf(view.container).includes('Turn 2 · 1 steps'))
    await view.unmount()
    const quiet = scene(staticSource({ timeline: timelineFixture({ events: [] }) }), { columns: 60, rows: 10, tab: 'trend' })
    const narrow = await render(quiet.el)
    chart = kitProps<typeof chart>(narrow.container, 'ColumnChart')[0]
    assert.deepEqual([chart.columnWidth, chart.height], [4, 4])
    assert.ok(!textOf(narrow.container).includes('✂'))
    await narrow.unmount()
    const empty = await render(scene(staticSource({ timeline: timelineFixture({ requests: [] }) }), { tab: 'trend' }).el)
    assert.ok(textOf(empty.container).includes('Send a message and each model request’s context makeup shows up here'))
    await empty.unmount()
  })

  test('browser: live tree, expand a category and an item, the content block, then the selected step', async () => {
    const { el, input } = scene(full(), { host: fakeHost(snapshot), tab: 'browser' })
    const view = await render(el)
    let text = textOf(view.container)
    assert.ok(text.includes('Context Browser · Live · Next Request'))
    assert.ok(text.includes('▸ System Prompt (0) 1.0k 24.0%'))
    assert.ok(text.includes('▸ Skill Injections (1) 20 0.5% vs prev +20'), text)
    for (let i = 0; i < 6; i++) await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    text = textOf(view.container)
    assert.ok(text.includes('▾ Tool Results (2)'))
    assert.ok(text.includes('✗ bash'))
    await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    assert.equal(textOf(view.container).split('export const a = 1').length, 3, 'the item label, then its preview line')
    await pressScene(input, '1')
    await pressScene(input, '2')
    await pressScene(input, '', { leftArrow: true })
    await pressScene(input, '3')
    text = textOf(view.container)
    assert.ok(text.includes('Context Browser · T1 S2'))
    assert.ok(text.includes('▸ Assistant Messages (1) 40 1.1% vs prev +40'), text)
    await pressScene(input, 'l')
    assert.ok(textOf(view.container).includes('Live · Next Request'))
    await view.unmount()
  })

  test('the dropped and approximate notes show under the tree', async () => {
    const source = staticSource({ timeline: timelineFixture({ droppedNodes: 2, archiveFloor: 100, surfaceFloor: 0 }), headers: null })
    const notes = scene(source, { tab: 'browser' })
    const notesView = await render(notes.el)
    assert.ok(textOf(notesView.container).includes('… 2 earlier messages are also part of the context'))
    await pressScene(notes.input, '2')
    await pressScene(notes.input, '', { home: true })
    await pressScene(notes.input, '3')
    assert.ok(textOf(notesView.container).includes('Some removed messages of this step exceed retention'))
    await notesView.unmount()
    const unstamped = timelineFixture()
    const odd = scene(staticSource({ timeline: { ...unstamped, requests: [{ ...unstamped.requests[0], turn: undefined, step: undefined }] } }), { tab: 'trend' })
    const oddView = await render(odd.el)
    await pressScene(odd.input, '', { home: true })
    await pressScene(odd.input, '3')
    assert.ok(textOf(oddView.container).includes('Context Browser · T0 S0'))
    await oddView.unmount()
  })

  test('edge data: no opener with a response, an all-zero context, a shrinking context, tool sources, an untimed op', async () => {
    const base = timelineFixture()
    const source = staticSource({
      timeline: {
        ...base,
        nodes: [...base.nodes.filter(n => n.cat !== 'user'), { seq: 10, cat: 'assistant', tokens: 9, text: 'all green' }],
        current: { ...base.current, tool: 100 },
        fileOps: [{ seq: 4, path: '/w/README.md', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
      },
      headers: headersFixture(),
    })
    const { el, input } = scene(source, { tab: 'trend' })
    const view = await render(el)
    let text = textOf(view.container)
    assert.ok(text.includes('Response: all green'))
    assert.ok(!text.includes('User:'))
    await pressScene(input, '3')
    assert.ok(textOf(view.container).includes('▸ Tool Results (2) 100 2.8% vs prev −600'))
    await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    text = textOf(view.container)
    assert.ok(text.includes('read @deepseek-ai/dsh-tool-fs 800'))
    const chip = [...view.container.querySelectorAll('[data-color]')].find(el => el.textContent === ' @deepseek-ai/dsh-tool-fs')
    assert.equal(chip?.getAttribute('data-color'), `chart${('@deepseek-ai/dsh-tool-fs'.length % 8) + 1}`)
    await pressScene(input, '5')
    assert.equal(kitProps<{ rows: { t: string }[] }>(view.container, 'Table')[0].rows[0].t, '')
    await pressScene(input, '2')
    await pressScene(input, '', { leftArrow: true })
    await React.act(async () => { source.set({ timeline: { ...base, requests: [], current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 } } }) })
    await pressScene(input, '3')
    text = textOf(view.container)
    assert.ok(text.includes('Live · Next Request'), 'the selected step is gone')
    assert.ok(text.includes('▸ System Prompt (0) 0▾'), 'no share of an empty context, no step to compare with')
    await view.unmount()
  })

  test('events: the full list newest first, the kind filter, and the empty filter', async () => {
    const { el, input } = scene(full(), { tab: 'events' })
    const view = await render(el)
    assert.ok(textOf(view.container).includes('Context Events · Filter: All'))
    assert.equal(view.container.querySelectorAll('[data-inverse="1"]')[1]?.textContent, '⇆ ')
    await pressScene(input, '', { downArrow: true })
    assert.equal(view.container.querySelectorAll('[data-inverse="1"]')[1]?.textContent, '✂ ')
    await pressScene(input, 'f')
    assert.ok(textOf(view.container).includes('Filter: Inject'))
    await pressScene(input, 'f')
    await pressScene(input, 'f')
    assert.ok(textOf(view.container).includes('No context events yet'))
    await view.unmount()
  })

  test('files: the table, Enter opens through the host (or toasts), s re-sorts; an empty log says so', async () => {
    const host = fakeHost(snapshot)
    const { el, input } = scene(full(), { host, tab: 'files' })
    const view = await render(el)
    assert.ok(textOf(view.container).includes('File Activity · 3 files · Sort: Most active'))
    let table = kitProps<{ rows: { path: string; t: string }[]; selected: number; columns: { key: string }[] }>(view.container, 'Table')[0]
    assert.deepEqual(table.rows.map(r => r.path), ['src/b.ts', 'TODO', 'src/a.ts'], 'most active first, ties newest first')
    assert.deepEqual(table.columns.map(c => c.key), ['path', 'r', 'w', 's', 'd', 't'])
    assert.equal(table.rows[0].t, '92s')
    await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    assert.deepEqual(host.toasts, ['Cannot open TODO'])
    await pressScene(input, '', { downArrow: true })
    await pressScene(input, '', { return: true })
    assert.deepEqual(host.opened, [{ path: '/w/src/a.ts', options: { line: 10 } }])
    await pressScene(input, 's')
    table = kitProps<typeof table>(view.container, 'Table')[0]
    assert.equal(table.selected, 0)
    assert.ok(textOf(view.container).includes('Sort: By lines'))
    await view.unmount()
    const none = await render(scene(staticSource({ timeline: timelineFixture({ fileOps: [] }) }), { tab: 'files' }).el)
    assert.ok(textOf(none.container).includes('No file reads, writes, or searches in this range'))
    await none.unmount()
    const blind = scene(full(), { tab: 'files' })
    const blindView = await render(blind.el)
    await pressScene(blind.input, '', { return: true })
    await blindView.unmount()
  })

  test('a host remount (a closed file preview) restores the scene; a fresh opening starts over', async () => {
    let opening: { tab?: SceneTab; serial: number } = { serial: 1 }
    const input: InputHolder = {}
    const Scene = createContextScene({ source: full(), defaults: () => ({}), opening: () => opening })
    const el = React.createElement(Scene, { React, ui: sceneUi(input, { columns: 100, rows: 30 }), close: () => {} })
    const first = await render(el)
    await pressScene(input, '5')
    await pressScene(input, '', { downArrow: true })
    await first.unmount()
    const remount = await render(el)
    assert.ok(textOf(remount.container).includes('File Activity'))
    assert.equal(kitProps<{ selected: number }>(remount.container, 'Table')[0].selected, 1)
    await remount.unmount()
    opening = { serial: 2, tab: 'events' }
    const fresh = await render(el)
    assert.ok(textOf(fresh.container).includes('Context Events · Filter: All'))
    await fresh.unmount()
  })

  test('Esc closes; host params pick the tab ahead of the requested one', async () => {
    const closing = scene(full())
    const view = await render(closing.el)
    await pressScene(closing.input, '', { escape: true })
    assert.deepEqual(closing.closed, [1])
    await pressScene(closing.input, 'z')
    await view.unmount()
    const host: SurfaceHost = { ...fakeHost(snapshot), useParams: () => ({ tab: 'events' }) }
    const params = await render(scene(full(), { host, tab: 'files' }).el)
    assert.ok(textOf(params.container).includes('Context Events · Filter: All'))
    await params.unmount()
  })

  test('notices: no kit, a below-baseline harness, and nothing yet; a Chinese host gets Chinese', async () => {
    const noKit = await render(scene(full(), { ui: baseUi }).el)
    assert.equal(textOf(noKit.container), 'Needs a dsh-TUI with the plugin UI kit')
    const old = await render(scene(staticSource({ timeline: timelineFixture({ unsupported: { current: '0.1.7-rc.2', minimum: '0.2.0-rc.2' } }) })).el)
    assert.ok(textOf(old.container).includes('dsh 0.1.7-rc.2 is below the supported 0.2.0-rc.2'))
    const waiting = await render(scene(staticSource({}), { host: fakeHost({ lang: 'zh-CN' }) }).el)
    assert.ok(textOf(waiting.container).includes(' 1 概览 '))
    assert.ok(textOf(waiting.container).includes('上下文等待第一次模型请求…'))
    const partial = await render(scene(staticSource({ timeline: timelineFixture(), partial: true })).el)
    assert.ok(textOf(partial.container).includes('showing the totals only'))
    for (const v of [noKit, old, waiting, partial]) await v.unmount()
  })
})
