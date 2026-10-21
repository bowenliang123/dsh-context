import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { Browser, props, tl } from './browserHarness'
import { mount, query } from '../helpers/kit'
import { wheelToPage } from '../../../src/client/wheelPass'

/** Pin the boxes jsdom never lays out, so the card and the page can be measured. */
function pinBoxes(el: Element, scrollHeight: number, clientHeight: number): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: scrollHeight })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: clientHeight })
}

/** A page scrollport that records its own scrollTop (jsdom implements no scrolling). */
function pinPageTop(el: Element): { top(): number } {
  let top = 0
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (v: number) => { top = v },
  })
  return { top: () => top }
}

function wheelOn(el: Element, deltaY: number, deltaMode = 0, ctrlKey = false): boolean {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, deltaMode, ctrlKey })
  el.dispatchEvent(event)
  return event.defaultPrevented
}

describe('ContextBrowser — the rows region hands a wheel it cannot use to the page', () => {
  test('no rows to scroll: the wheel moves the page instead of dying in the card', async () => {
    const page = h('div', { style: { overflowY: 'auto' } }, h(Browser, props({ data: tl({}) })))
    const m = await mount(page)
    const wrapper = m.container.firstElementChild as HTMLElement
    pinBoxes(wrapper, 400, 100)
    const top = pinPageTop(wrapper)
    const region = query<HTMLElement>(m.container, '.lc-br-scroll')
    pinBoxes(region, 100, 100)

    assert.equal(wheelOn(region, 300), true)
    assert.equal(top.top(), 300)
    await m.unmount()
  })

  test('ctrl+wheel stays the page-zoom gesture: never cancelled, never scrolled', async () => {
    const page = h('div', { style: { overflowY: 'auto' } }, h(Browser, props({ data: tl({}) })))
    const m = await mount(page)
    const wrapper = m.container.firstElementChild as HTMLElement
    pinBoxes(wrapper, 400, 100)
    const top = pinPageTop(wrapper)
    const region = query<HTMLElement>(m.container, '.lc-br-scroll')
    pinBoxes(region, 100, 100)

    assert.equal(wheelOn(region, 300, 0, true), false)
    assert.equal(top.top(), 0)
    await m.unmount()
  })

  test('rows to scroll: the region keeps the wheel, the page stays put', async () => {
    const page = h('div', { style: { overflowY: 'auto' } }, h(Browser, props({ data: tl({}) })))
    const m = await mount(page)
    const wrapper = m.container.firstElementChild as HTMLElement
    pinBoxes(wrapper, 400, 100)
    const top = pinPageTop(wrapper)
    const region = query<HTMLElement>(m.container, '.lc-br-scroll')
    pinBoxes(region, 300, 100)

    assert.equal(wheelOn(region, 300), false)
    assert.equal(top.top(), 0)
    await m.unmount()
  })

  test('no page scroller above the card: the wheel is left to the browser', async () => {
    const m = await mount(h(Browser, props({ data: tl({}) })))
    const region = query<HTMLElement>(m.container, '.lc-br-scroll')
    pinBoxes(region, 100, 100)

    assert.equal(wheelOn(region, 300), false)
    await m.unmount()
  })

  test('line and page deltas are converted to pixels before the page takes them', async () => {
    const page = h('div', { style: { overflowY: 'auto' } }, h(Browser, props({ data: tl({}) })))
    const m = await mount(page)
    const wrapper = m.container.firstElementChild as HTMLElement
    pinBoxes(wrapper, 400, 100)
    const top = pinPageTop(wrapper)
    const region = query<HTMLElement>(m.container, '.lc-br-scroll')
    pinBoxes(region, 100, 100)

    assert.equal(wheelOn(region, 3, 1), true)
    assert.equal(top.top(), 48)
    assert.equal(wheelOn(region, 2, 2), true)
    assert.equal(top.top(), 248)
    await m.unmount()
  })
})

describe('wheelToPage', () => {
  test('a region with its own overflow never moves the page', () => {
    const page = document.createElement('div')
    page.style.overflowY = 'auto'
    document.body.appendChild(page)
    pinBoxes(page, 400, 100)
    const top = pinPageTop(page)
    const region = document.createElement('div')
    page.appendChild(region)
    pinBoxes(region, 300, 100)

    assert.equal(wheelToPage(region, 120), false)
    assert.equal(top.top(), 0)
    page.remove()
  })

  test('an overflow-styled box that never scrolls is skipped for the one that does', () => {
    const page = document.createElement('div')
    page.style.overflowY = 'scroll'
    document.body.appendChild(page)
    pinBoxes(page, 400, 100)
    const top = pinPageTop(page)
    const passive = document.createElement('div')
    page.appendChild(passive)
    pinBoxes(passive, 100, 100)
    const region = document.createElement('div')
    passive.appendChild(region)
    pinBoxes(region, 100, 100)

    assert.equal(wheelToPage(region, 120), true)
    assert.equal(top.top(), 120)
    page.remove()
  })

  test('a detached region finds no scrollport and mutes nothing', () => {
    const region = document.createElement('div')
    pinBoxes(region, 100, 100)
    assert.equal(wheelToPage(region, 120), false)
  })

  test('a hostile host degrades to no scroll instead of a throw', () => {
    const region = document.createElement('div')
    pinBoxes(region, 100, 100)
    const parent = document.createElement('div')
    parent.appendChild(region)
    const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => { throw new Error('hostile') })
    try {
      assert.equal(wheelToPage(region, 120), false)
    } finally {
      spy.mockRestore()
    }
  })
})
