import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import type { ContextHeaders } from '../../../src/shared/types'
import { act } from 'react'
import { mount, query, queryAll, surfaceNode, until } from '../helpers/kit'
import { restoreLayout, stubClientSizes, stubResizeObserver, stubRowRects } from '../helpers/layout'
import { Browser, props, tl } from './browserHarness'

beforeAll(() => {
  stubResizeObserver()
  stubClientSizes({ 'lc-br-scroll': { width: 500, height: 400 } })
  stubRowRects('lc-br-elem', () => 28, 2)
})

afterAll(() => {
  vi.unstubAllGlobals()
  restoreLayout()
})

const NODES = Array.from({ length: 200 }, (_, i) => surfaceNode({
  seq: i + 1, tokens: 10, time: 1_000 + i, cat: 'tool', tool: 'bash',
}))

const HEADERS: ContextHeaders = {
  headers: [{ seq: 0, time: 0, systemTokens: 100, tools: [{ name: 'bash', tokens: 50 }] }],
}

function data() {
  return tl({
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 2_000, total: 2_000 },
    requests: [],
    nodes: NODES,
  })
}

describe('ContextBrowser DNA feed windowing', () => {
  test('renders only the measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: HEADERS, dna: true, onDnaChange: () => {} })))
    try {
      const rows = queryAll(m.container, '.lc-br-flat > .lc-br-elem')
      assert.ok(rows.length < 200, `windowed rows (${rows.length})`)
      assert.ok(rows.length > 10, 'a window wide enough to scroll through')
      const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(pads.length, 1)
      assert.ok(Number.parseFloat(pads[0].style.height) > 0)
      assert.ok(queryAll(m.container, '.lc-stacked-seg').length >= 200, 'composition bar keeps every item')
      const scroller = query<HTMLElement>(m.container, '.lc-br-scroll')
      scroller.scrollTop = 600
      await new Promise(resolve => setTimeout(resolve, 30))
      scroller.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      const shifted = queryAll<HTMLElement>(m.container, '.lc-br-flat > .lc-br-elem').length
      assert.ok(shifted < 200)
      const children = [...query<HTMLElement>(m.container, '.lc-br-flat').children] as HTMLElement[]
      const lastPad = children.map((el, i) => el.classList.contains('lc-row-pad') ? i : -1).filter(i => i >= 0).at(-1)
      const tail = children.at(-1)
      assert.ok(lastPad !== undefined && tail !== undefined
        && tail.classList.contains('lc-br-elem') && children.length - 1 > lastPad, 'tail rows follow the bottom pad')
    } finally {
      await m.unmount()
    }
  })
  test('hovering a composition band scrolls the window to its off-screen row', async () => {
    const m = await mount(h(Browser, props({ data: data(), headers: null, dna: true, onDnaChange: () => {} })))
    try {
      await until(() => queryAll(m.container, '.lc-br-flat > .lc-br-elem').length < 200, 'feed windowed')
      const segs = queryAll<HTMLElement>(m.container, '.lc-br-bar .lc-stacked-seg')
      assert.ok(segs.length > 0)
      await act(async () => { segs[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
      await until(() => queryAll(m.container, '[data-lc-key="n1"]').length === 1, 'off-window echoed row mounted')
      assert.ok(query<HTMLElement>(m.container, '.lc-br-scroll').scrollTop > 0)
    } finally {
      await m.unmount()
    }
  })

})
