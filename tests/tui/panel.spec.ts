// @vitest-environment jsdom
import assert from 'node:assert/strict'
import * as React from 'react'
import { describe, test } from 'vitest'
import { createContextCompact, createContextPanel } from '../../src/tui/panel'
import type { SceneTab } from '../../src/tui/scene'
import type { ContextSource } from '../../src/tui/source'
import type { SurfaceUi } from '../../src/tui/hostTypes'
import { baseUi, fakeHost, fakeKit, kitProps, panelUi, pressPanel, render, staticSource, textOf, timelineFixture, type FakeHost } from './helpers'

const snapshot = {
  sessionId: 's1',
  cwd: '/w',
  lang: 'en',
  usage: { occupancy: { usedTokens: 81_400, contextWindow: 131_072, source: 'projection' }, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
}

function panel(source: ContextSource, host: FakeHost, opts: { ui?: SurfaceUi; width?: number; height?: number; opened?: (SceneTab | undefined)[] } = {}) {
  const opened = opts.opened ?? []
  const Panel = createContextPanel({ source, openScene: (tab) => { opened.push(tab); return true } })
  return React.createElement(Panel, { React, ui: opts.ui ?? panelUi, host, width: opts.width ?? 50, height: opts.height ?? 30, focused: true })
}

describe('context panel', () => {
  test('headline from the host usage, the window bars, the legend, recent events and the file table', async () => {
    const view = await render(panel(staticSource({ timeline: timelineFixture() }), fakeHost(snapshot)))
    const text = textOf(view.container)
    assert.ok(text.startsWith('Context 62.1% · 81.4k/131.1k'), text)
    const bars = kitProps<{ width: number; capacity?: number; segments: unknown[] }>(view.container, 'StackedBar')
    assert.equal(bars.length, 2, 'used span + hatched reserve tail')
    assert.equal(bars[0].width + bars[1].width, 50)
    const legend = kitProps<{ maxRows: number; items: { label: string }[] }>(view.container, 'Legend')
    assert.equal(legend[0].maxRows, 2)
    assert.ok(legend[0].items.some(i => i.label === 'Tool Results'))
    assert.ok(text.includes('Context Events'))
    assert.ok(text.includes('✂ Compact · Context compact −400 T1 S2 → T2 S1 92s'), 'the label is cut to fit, the figures stay whole')
    assert.ok(text.includes('−400 T1 S2 → T2 S1 92s'))
    const table = kitProps<{ rows: { path: string; r: number | string; d: string }[]; selected?: number }>(view.container, 'Table')
    assert.deepEqual(table[0].rows.map(r => r.path), ['TODO', 'src/b.ts', 'src/a.ts'])
    assert.equal(table[0].rows[1].d, '+5 −2')
    assert.equal(table[0].selected, undefined)
    await view.unmount()
  })

  test('narrow panels drop the step range from event rows and the extra file columns', async () => {
    const view = await render(panel(staticSource({ timeline: timelineFixture() }), fakeHost(snapshot), { width: 30, height: 12 }))
    assert.ok(!textOf(view.container).includes('T1 S2 → T2 S1'))
    const table = kitProps<{ columns: { key: string }[] }>(view.container, 'Table')
    assert.deepEqual(table[0].columns.map(c => c.key), ['path', 'r', 'w'])
    await view.unmount()
    const short = await render(panel(staticSource({ timeline: timelineFixture() }), fakeHost(snapshot), { height: 4 }))
    assert.equal(kitProps(short.container, 'Legend').length, 0, 'no room for the legend')
    await short.unmount()
  })

  test('an event without figures (no tokens, a host with no relative time) spends the whole row on its label', async () => {
    const ui = { ...panelUi, format: { ...fakeKit.format, relativeTime: () => '' } }
    const view = await render(panel(staticSource({ timeline: timelineFixture({ fileOps: [] }) }), fakeHost(snapshot), { ui, width: 40 }))
    const row = [...view.container.querySelectorAll('[data-box]')].find(el => el.textContent?.startsWith('⇆'))
    assert.equal(row?.textContent, '⇆ Switch · Model switched: a → b' + ' '.repeat(8), 'exactly the 40-cell row')
    await view.unmount()
  })

  test('notices: no kit, a below-baseline harness, nothing yet, and a partial detail', async () => {
    const noKit = await render(panel(staticSource({ timeline: timelineFixture() }), fakeHost(snapshot), { ui: baseUi }))
    assert.equal(textOf(noKit.container), 'Needs a dsh-TUI with the plugin UI kit')
    const old = await render(panel(staticSource({ timeline: timelineFixture({ unsupported: { current: '0.1.7-rc.2', minimum: '0.2.0-rc.2' } }) }), fakeHost(snapshot)))
    assert.equal(textOf(old.container), 'dsh 0.1.7-rc.2 is below the supported 0.2.0-rc.2; upgrade dsh to see the context')
    const empty = await render(panel(staticSource({}), fakeHost({ lang: 'zh' })))
    assert.equal(textOf(empty.container), '等待第一次模型请求…')
    const partial = await render(panel(staticSource({ timeline: timelineFixture({ events: [], fileOps: undefined }), partial: true }), fakeHost(snapshot)))
    assert.ok(textOf(partial.container).includes('showing the totals only'))
    for (const view of [noKit, old, empty, partial]) await view.unmount()
  })

  test('keys while focused: ↑↓ select across events then files, o opens the file, Enter opens the scene tab', async () => {
    const host = fakeHost(snapshot)
    const opened: (SceneTab | undefined)[] = []
    const view = await render(panel(staticSource({ timeline: timelineFixture() }), host, { opened }))
    assert.equal(await pressPanel(host, '', { return_: true }), true)
    assert.deepEqual(opened, [undefined])
    assert.equal(await pressPanel(host, '', { upArrow: true }), true)
    await pressPanel(host, '', { downArrow: true })
    assert.equal(view.container.querySelector('[data-inverse="1"]')?.textContent, '⇆ ')
    assert.equal(await pressPanel(host, 'o'), false, 'o on an event is not ours')
    await pressPanel(host, '', { return_: true })
    assert.deepEqual(opened, [undefined, 'events'])
    for (let i = 0; i < 4; i++) await pressPanel(host, '', { downArrow: true })
    assert.equal(kitProps<{ selected?: number }>(view.container, 'Table')[0].selected, 1)
    assert.equal(await pressPanel(host, 'o'), true)
    assert.deepEqual(host.opened, [{ path: '/w/src/b.ts' }])
    await pressPanel(host, '', { downArrow: true })
    await pressPanel(host, '', { downArrow: true })
    await pressPanel(host, 'o')
    assert.deepEqual(host.opened[1], { path: '/w/src/a.ts', options: { line: 10 } })
    await pressPanel(host, '', { return_: true })
    assert.deepEqual(opened.at(-1), 'files')
    assert.equal(await pressPanel(host, 'x'), false)
    await view.unmount()
    assert.equal(host.keys.size, 0, 'the key listener leaves with the panel')
  })

  test('a file the host cannot open (or a pattern) toasts instead', async () => {
    const host = fakeHost(snapshot, false)
    const view = await render(panel(staticSource({ timeline: timelineFixture() }), host))
    for (let i = 0; i < 4; i++) await pressPanel(host, '', { downArrow: true })
    await pressPanel(host, 'o')
    assert.deepEqual(host.toasts, ['Cannot open TODO'])
    await pressPanel(host, '', { downArrow: true })
    await pressPanel(host, 'o')
    assert.deepEqual(host.toasts.at(-1), 'Cannot open src/b.ts')
    await view.unmount()
    const bare = fakeHost(snapshot)
    delete bare.openFile
    delete bare.toast
    delete bare.onKey
    const quiet = await render(panel(staticSource({ timeline: timelineFixture() }), bare))
    await quiet.unmount()
  })
})

describe('compact row', () => {
  test('draws the same window bars with the row kit when the host hands one over', async () => {
    const Compact = createContextCompact(staticSource({ timeline: timelineFixture() }))
    const view = await render(React.createElement(Compact, { React, ui: { ...baseUi, StackedBar: fakeKit.StackedBar }, width: 30 }))
    assert.equal(textOf(view.container), 'ctx 2% ')
    assert.deepEqual(kitProps<{ width: number }>(view.container, 'StackedBar').map(b => b.width), [15, 8])
    await view.unmount()
  })

  test('reads the host snapshot when the compact row gets one, so it matches the footer; usage alone draws one span', async () => {
    const source = staticSource({ timeline: timelineFixture() })
    const Compact = createContextCompact(source)
    const ui = { ...baseUi, StackedBar: fakeKit.StackedBar }
    const view = await render(React.createElement(Compact, { React, ui, width: 30, snapshot: () => snapshot }))
    assert.equal(textOf(view.container), 'ctx 62% ', 'the host occupancy, not the fold anchor (2%)')
    await React.act(async () => { source.set({ timeline: null }) })
    const bars = kitProps<{ segments: { value: number; color: unknown }[] }>(view.container, 'StackedBar')
    assert.deepEqual(bars[0].segments, [{ value: 81_400, color: 'accent' }])
    await view.unmount()
  })

  test('a host whose compact row has no StackedBar gets the label alone', async () => {
    const source = staticSource({ timeline: timelineFixture({ contextWindow: 10_000 }) })
    const Compact = createContextCompact(source)
    const view = await render(React.createElement(Compact, { React, ui: baseUi, width: 20 }))
    assert.equal(textOf(view.container), 'ctx 41% ')
    await React.act(async () => { source.set({ timeline: null }) })
    assert.equal(textOf(view.container), 'ctx — ')
    await view.unmount()
  })
})
