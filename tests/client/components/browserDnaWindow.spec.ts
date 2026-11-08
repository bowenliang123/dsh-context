import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import type { ContextHeaders } from '../../../src/shared/types'
import { mount, query, queryAll, settle, surfaceNode, text, until } from '../helpers/kit'
import { restoreLayout, stubClientSizes, stubResizeObserver } from '../helpers/layout'
import { Browser, catRow, kit, props, tl } from './browserHarness'

const ESTIMATE = 30

class ControlledResizeObserver {
  static all: ControlledResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { ControlledResizeObserver.all.push(this) }
  static reset(): void { ControlledResizeObserver.all = [] }
  static rowObserver(): ControlledResizeObserver {
    const found = ControlledResizeObserver.all.find(entry => entry.targets.some(target => target.classList.contains('lc-br-elem')))
    if (found === undefined) throw new Error('no row observer')
    return found
  }
  observe(target: Element): void { this.targets.push(target) }
  unobserve(target: Element): void {
    const at = this.targets.indexOf(target)
    if (at >= 0) this.targets.splice(at, 1)
  }
  disconnect(): void { this.targets.length = 0 }
  settle(height: number, target: Element | undefined = this.targets[0]): void {
    this.callback(
      [{
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: 500 }],
        contentRect: { height },
      } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

beforeAll(() => {
  stubResizeObserver()
  stubClientSizes({ 'lc-br-scroll': { width: 500, height: 400 } })
})

afterAll(() => {
  vi.unstubAllGlobals()
  restoreLayout()
})

const NODES = Array.from({ length: 2_000 }, (_, i) => surfaceNode({
  seq: i + 1, tokens: 10, time: 1_000 + i, cat: 'tool', tool: 'bash',
}))

const HEADERS: ContextHeaders = {
  headers: [{ seq: 0, time: 0, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }] }],
}

function data() {
  return tl({
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 20_000, total: 20_000 },
    requests: [],
    nodes: NODES,
  })
}

function toolHeaders(count: number): ContextHeaders {
  return {
    headers: [{
      seq: 0,
      time: 0,
      systemTokens: 0,
      tools: Array.from({ length: count }, (_, i) => ({ name: `tool-${String(i).padStart(3, '0')}`, tokens: 10 })),
    }],
  }
}

function dnaRows(m: Awaited<ReturnType<typeof mount>>): HTMLElement[] {
  return queryAll<HTMLElement>(m.container, '.lc-br-flat > [data-lc-key]')
}

function focusedKey(): string | null {
  const active = document.activeElement
  if (!(active instanceof Element)) return null
  return active.closest<HTMLElement>('[data-lc-key]')?.dataset.lcKey ?? null
}

describe('ContextBrowser windowing', () => {
  test('the DNA feed stays DOM-bounded in wide and closed states and follows the scroll', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: HEADERS, dna: true, onDnaChange: () => {} })))
    try {
      const rows = queryAll(m.container, '.lc-br-elem')
      assert.ok(rows.length < 2_000, `windowed rows (${rows.length})`)
      assert.ok(rows.length > 10, 'a window wide enough to scroll through')
      assert.ok(dnaRows(m).length < 2_000)
      const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(pads.length, 1, 'only the tail spacer is present at the head')
      assert.ok(Number.parseFloat(pads[0].style.height) > 0)
      assert.ok(queryAll(m.container, '.lc-stacked-seg').length >= 2_000, 'the composition bar keeps every item')
      const scroller = query<HTMLElement>(m.container, '.lc-br-scroll')
      scroller.scrollTop = 6_000
      await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 2_000, 'scrolled window stays bounded')
      assert.ok(!dnaRows(m).some(row => row.dataset.lcKey === 'n2000'), 'the newest rows leave the window')
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('the DNA feed keeps windowing on a narrow pane and with rows of mixed measured heights', async () => {
    stubClientSizes({ 'lc-br-scroll': { width: 300, height: 400 } })
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    try {
      const m = await mount(h(Browser, props({ data: data(), headers: HEADERS, dna: true, onDnaChange: () => {} })))
      const observer = ControlledResizeObserver.rowObserver()
      for (const target of [...observer.targets]) {
        const index = dnaRows(m).findIndex(row => row === target)
        await act(async () => { observer.settle(ESTIMATE + (index % 4 === 0 ? 60 : 0), target) })
      }
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 2_000, 'mixed heights stay windowed')
      assert.ok(queryAll<HTMLElement>(m.container, '.lc-row-pad').length <= 2)
      const first = query<HTMLElement>(m.container, '.lc-br-elem-row')
      await act(async () => { first.click() })
      assert.ok(queryAll(m.container, '.lc-br-content').length === 1, 'the row expands')
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 2_000, 'an expanded row keeps the window')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
      stubClientSizes({ 'lc-br-scroll': { width: 500, height: 400 } })
    }
  })

  test('hovering a composition band scrolls the window to its off-screen row', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: null, dna: true, onDnaChange: () => {} })))
    try {
      await until(() => queryAll(m.container, '.lc-br-flat > [data-lc-key]').length < 2_000, 'feed windowed')
      const segs = queryAll<HTMLElement>(m.container, '.lc-br-bar .lc-stacked-seg')
      assert.ok(segs.length > 0)
      await act(async () => { segs[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await until(() => queryAll(m.container, '[data-lc-key="n1"]').length === 1, 'off-window echoed row mounted')
      assert.ok(query<HTMLElement>(m.container, '.lc-br-scroll').scrollTop > 0)
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('a non-DNA category list is windowed and its header counts the full model', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: HEADERS })))
    try {
      const categories = queryAll<HTMLElement>(m.container, '.lc-br-cat-row')
      assert.equal(categories[6].getAttribute('aria-expanded'), 'false')
      await act(async () => { categories[6].click() })
      assert.equal(categories[6].getAttribute('aria-expanded'), 'true')
      assert.ok((categories[6].getAttribute('aria-controls') ?? '').length > 0)
      assert.ok(text(m.container).includes(kit.fmt(2_000)), 'the category header keeps the full count')
      const rows = queryAll(m.container, '.lc-br-elem')
      assert.ok(rows.length < 2_000, `category rows are windowed (${rows.length})`)
      assert.ok(rows.length > 8)
      assert.ok(queryAll<HTMLElement>(m.container, '.lc-row-pad').length >= 1)
      const firstRow = query<HTMLElement>(m.container, '.lc-br-elem-row')
      assert.equal(firstRow.getAttribute('aria-expanded'), 'false')
      await act(async () => { firstRow.click() })
      assert.equal(query<HTMLElement>(m.container, '.lc-br-elem-row').getAttribute('aria-expanded'), 'true')
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 2_000, 'opening a row keeps the window')
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('a node focus request reveals its flat row', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: null, dna: true, onDnaChange: () => {} })))
    try {
      await m.update(h(Browser, props({
        data: data(),
        headers: null,
        dna: true,
        onDnaChange: () => {},
        nodeFocus: { step: 'live', key: 'n1', cat: 'tool' },
        onNodeFocusHandled: () => {},
      })))
      await until(() => queryAll(m.container, '[data-lc-key="n1"]').length === 1, 'the focused row mounts')
      await settle(80)
      assert.ok(query<HTMLElement>(m.container, '.lc-br-scroll').scrollTop > 0)
    } finally {
      await m.unmount()
    }
  })

  test('an absent node focus request settles without revealing a row', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: null, dna: true, onDnaChange: () => {} })))
    try {
      await m.update(h(Browser, props({
        data: data(),
        headers: null,
        dna: true,
        onDnaChange: () => {},
        nodeFocus: { step: 'live', key: 'n999999', cat: 'tool' },
        onNodeFocusHandled: () => {},
      })))
      await settle(200)
      assert.ok(queryAll(m.container, '.lc-br-flat > [data-lc-key]').length < 2_000)
    } finally {
      await m.unmount()
    }
  })

  test('a long tool list is windowed, measured, and keyboard-reachable from first to last row', async () => {
    const m = await mount(h(Browser, props({ data: tl({}), headers: toolHeaders(500) })))
    try {
      await act(async () => { catRow(m, 'tools').click() })
      await until(() => queryAll(m.container, '.lc-br-elem-row').length > 8, 'the tool list renders')
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 500, 'tool rows are windowed')
      const first = query<HTMLElement>(m.container, '.lc-br-elem-row')
      first.focus()
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await until(() => focusedKey() === 'tool:tool-499', 'End reaches and focuses the last tool')
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await until(() => focusedKey() === 'tool:tool-000', 'Home returns focus to the first tool')
      assert.ok(queryAll(m.container, '.lc-br-elem').length < 500)
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('DNA rows keep one roving tab stop and End/Home reach the last and first message', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: null, dna: true, onDnaChange: () => {} })))
    try {
      await until(() => queryAll(m.container, '.lc-br-flat > [data-lc-key]').length < 2_000, 'feed windowed')
      const stops = queryAll<HTMLElement>(m.container, '.lc-br-elem-row').filter(row => row.tabIndex === 0)
      assert.equal(stops.length, 1, 'one tab stop for the flat feed')
      stops[0].focus()
      stops[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await until(() => focusedKey() === 'n1', 'End reaches and focuses the oldest message')
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await until(() => focusedKey() === 'n2000', 'Home returns focus to the newest message')
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })
})
