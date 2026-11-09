import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { useHoverTip } from '../../../src/client/components/hoverTip'
import { flush, mount, query, type Mounted } from '../helpers/kit'

function Zone(): ReactElement {
  const { zoneProps, bubble } = useHoverTip()
  return h(
    'div',
    zoneProps,
    h('button', { id: 'a', 'data-lc-tip': 'tip A' }, h('span', { id: 'a-child' }, 'A')),
    h('button', { id: 'b', 'data-lc-tip': 'tip B', 'data-lc-tip-side': 'bottom' }, 'B'),
    h('span', { id: 'plain' }, 'plain'),
    h('span', { id: 'empty', 'data-lc-tip': '' }, 'empty'),
    bubble,
  )
}

const bubble = (): HTMLElement | null => document.body.querySelector('#lc-hovertip-bubble')

async function mouseover(target: Element): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}

async function mouseout(target: Element, relatedTarget: EventTarget | null): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget })) })
}

async function focusIn(target: Element): Promise<void> {
  await act(async () => { target.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
}

async function blurOut(target: Element, relatedTarget: EventTarget | null): Promise<void> {
  await act(async () => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget })) })
}

function pinRect(anchor: Element, rect: { left: number; top: number; width: number; height: number }): void {
  const { left, top, width, height } = rect
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, bottom: top + height, right: left + width }),
  })
}

function CountingZone(props: { onRender: () => void }): ReactElement {
  props.onRender()
  const { zoneProps, bubble } = useHoverTip()
  return h('div', zoneProps, h('button', { id: 'a', 'data-lc-tip': 'tip A' }, 'A'), bubble)
}

afterEach(() => {
  bubble()?.remove()
})

describe('useHoverTip', () => {
  test('hovering an anchor shows its portaled tip and described-by; leaving hides both', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    await mouseover(a)
    const el = bubble()
    assert.ok(el !== null, 'the bubble portaled to <body>')
    assert.equal(el.getAttribute('role'), 'tooltip')
    assert.equal(el.textContent, 'tip A')
    assert.ok(el.className.includes('lc-tip') && el.className.includes('lc-hovertip'))
    assert.equal(el.style.opacity, '1', 'the measured pass revealed the bubble')
    assert.equal(el.style.left, '8px')
    assert.equal(el.style.top, '8px')
    assert.equal(a.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await mouseout(a, m.container)
    assert.equal(bubble(), null, 'leaving to a non-anchor hides the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null, 'the described-by goes with it')
    await m.unmount()
  })

  test('moving across the anchor subtree keeps the tip, switching anchors re-anchors, and focus/blur mirror hover', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    const b = query(m.container, '#b')
    await mouseover(a)
    const shown = bubble()?.style.cssText

    await mouseover(query(m.container, '#a-child'))
    assert.equal(bubble()?.style.cssText, shown, 'same anchor keeps the measured spot')
    assert.equal(a.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await mouseout(a, b)
    assert.ok(bubble() !== null, 'anchor-to-anchor movement never hides')
    await mouseover(b)
    assert.equal(bubble()?.textContent, 'tip B')
    assert.equal(a.getAttribute('aria-describedby'), null, 'the old anchor released')
    assert.equal(b.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await focusIn(a)
    assert.equal(bubble()?.textContent, 'tip A')
    await blurOut(a, b)
    assert.ok(bubble() !== null, 'focus moving anchor-to-anchor never hides')
    await focusIn(b)
    assert.equal(bubble()?.textContent, 'tip B')
    await blurOut(b, null)
    assert.equal(bubble(), null, 'focus leaving the zone hides')
    await m.unmount()
  })

  test('a zone scroll or a viewport resize retracts the tip; non-anchors and empty labels never show one', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    await mouseover(query(m.container, '#plain'))
    assert.equal(bubble(), null, 'a non-anchor target shows nothing')
    await mouseover(query(m.container, '#empty'))
    assert.equal(bubble(), null, 'an empty data-lc-tip shows nothing')

    await mouseover(a)
    assert.ok(bubble() !== null)
    await act(async () => {
      query(m.container, '#plain').dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    assert.equal(bubble(), null, 'any zone scroll retracts the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null)

    await mouseover(a)
    assert.ok(bubble() !== null)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(bubble(), null, 'the resize retracted the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(bubble(), null)
    await m.unmount()
  })

  test('the measure pass centers on the anchor, clamps horizontally, and flips a bottom tip that overflows', async () => {
    const m = await mount(h(Zone))
    const b = query(m.container, '#b')
    pinRect(b, { left: 100, top: 100, width: 20, height: 20 })
    await mouseover(b)
    assert.equal(bubble()?.style.left, '110px')
    assert.equal(bubble()?.style.top, '126px', 'anchor bottom + gap')

    pinRect(b, { left: 2000, top: 740, width: 20, height: 20 })
    await mouseout(b, m.container)
    await mouseover(b)
    assert.equal(bubble()?.style.left, '1016px', 'clamped to innerWidth - margin (width 0)')
    assert.equal(bubble()?.style.top, '734px', 'flipped above the anchor')
    await m.unmount()
  })

  test('hovering repaints only the bubble, and a re-shown tip reuses its measurement', async () => {
    let renders = 0
    const m = await mount(h(CountingZone, { onRender: () => { renders += 1 } }))
    const a = query(m.container, '#a')
    pinRect(a, { left: 100, top: 100, width: 40, height: 20 })

    renders = 0
    await mouseover(a)
    assert.equal(bubble()?.style.left, '120px')
    assert.equal(renders, 0, 'the zone never repaints for a hover')

    renders = 0
    await mouseout(a, m.container)
    assert.equal(bubble(), null)
    assert.equal(renders, 0, 'hiding the bubble leaves the zone untouched')

    await mouseover(a)
    assert.equal(bubble()?.textContent, 'tip A')
    assert.equal(bubble()?.style.left, '120px', 'the measured spot is reused')

    pinRect(a, { left: 300, top: 100, width: 40, height: 20 })
    await mouseout(a, m.container)
    await mouseover(a)
    assert.equal(bubble()?.style.left, '320px')

    a.setAttribute('data-lc-tip', 'tip A, longer')
    await mouseout(a, m.container)
    await mouseover(a)
    assert.equal(bubble()?.textContent, 'tip A, longer')
    assert.equal(bubble()?.style.left, '320px')

    await m.unmount()
  })

  test('a relabelled tip and a changed viewport both re-measure the bubble', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    pinRect(a, { left: 600, top: 100, width: 40, height: 20 })
    let widths = 0
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => { widths += 1; return 10 },
    })
    try {
      await mouseover(a)
      assert.equal(bubble()?.style.left, '615px')
      widths = 0
      await mouseout(a, m.container)
      await mouseover(a)
      assert.equal(widths, 0, 'an unchanged tip reuses its measurement')
      a.setAttribute('data-lc-tip', 'tip A, longer')
      await mouseout(a, m.container)
      await mouseover(a)
      assert.equal(widths, 1, 'a relabelled tip re-measures')
      const width = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width - 400 })
      try {
        await mouseout(a, m.container)
        await mouseover(a)
        assert.equal(widths, 2, 'a changed viewport re-measures')
        assert.equal(bubble()?.style.left, '606px', 'the narrowed viewport re-clamps')
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      }
    } finally {
      if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor)
    }
    await m.unmount()
  })

  test('unmounting the zone removes the portaled bubble', async () => {
    const m: Mounted = await mount(h(Zone))
    await mouseover(query(m.container, '#a'))
    assert.ok(bubble() !== null)
    await m.unmount()
    await flush()
    assert.equal(bubble(), null, 'the portal goes down with the zone')
  })
})
