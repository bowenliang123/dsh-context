import assert from 'node:assert/strict'
import { createElement as h, useRef } from 'react'
import { act } from 'react'
import { describe, test, vi } from 'vitest'
import { ROW_WINDOW_OVERSCAN, rowWindowFor, useRowWindow } from '../../../src/client/components/useRowWindow'
import { mount, query, until } from '../helpers/kit'

describe('rowWindowFor', () => {
  test('covers the viewport with an overscan on both sides', () => {
    assert.deepEqual(rowWindowFor(0, 100, 20, 50), { from: 0, to: 5 + ROW_WINDOW_OVERSCAN })
    assert.deepEqual(rowWindowFor(200, 100, 20, 50), { from: 10 - ROW_WINDOW_OVERSCAN, to: 15 + ROW_WINDOW_OVERSCAN })
    assert.deepEqual(rowWindowFor(10_000, 100, 20, 50), { from: 49, to: 49 })
  })

  test('falls back to the whole list when unmeasured or empty', () => {
    assert.deepEqual(rowWindowFor(0, 0, 20, 30), { from: 0, to: 29 })
    assert.deepEqual(rowWindowFor(0, 100, 0, 30), { from: 0, to: 29 })
    assert.deepEqual(rowWindowFor(0, 100, 20, 0), { from: 0, to: 0 })
  })
})

function Probe(props: { count: number; enabled: boolean; attachRef?: boolean }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const range = useRowWindow(ref, props.count, 20, props.enabled)
  return h('div', {
    ...(props.attachRef === false ? {} : { ref }),
    'data-from': range.from,
    'data-to': range.to,
  })
}

function NoRefProbe(props: { count: number }) {
  const range = useRowWindow(useRef<HTMLDivElement | null>(null), props.count, 20, true)
  return h('div', { 'data-from': range.from, 'data-to': range.to })
}

describe('useRowWindow', () => {
  test('renders in full until the scroller is measured, then follows scroll', async () => {
    const m = await mount(h(Probe, { count: 50, enabled: true }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      assert.equal(el.dataset.from, '0')
      assert.equal(el.dataset.to, '49')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      // The effect re-reads the box when the list changes.
      await m.update(h(Probe, { count: 51, enabled: true }))
      await until(() => query<HTMLElement>(m.container, 'div').dataset.to !== '50', 'window measures the viewport')
      assert.equal(el.dataset.from, '0')
      assert.equal(el.dataset.to, String(5 + ROW_WINDOW_OVERSCAN))
      el.scrollTop = 200
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await until(() => query<HTMLElement>(m.container, 'div').dataset.from !== '0', 'window follows the scroll')
      assert.equal(el.dataset.from, String(10 - ROW_WINDOW_OVERSCAN))
    } finally {
      await m.unmount()
    }
  })

  test('stays full when disabled, unmeasured, or the ref is not attached', async () => {
    const cases = [
      h(Probe, { count: 40, enabled: false }),
      h(Probe, { count: 40, enabled: true, attachRef: false }),
      h(NoRefProbe, { count: 40 }),
    ]
    for (const el of cases) {
      const m = await mount(el)
      const node = query<HTMLElement>(m.container, 'div')
      assert.equal(node.dataset.from, '0')
      assert.equal(node.dataset.to, '39')
      await m.unmount()
    }
  })

  test('coalesces two scroll events into one frame and applies the latest offset', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return 1 })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    try {
      const m = await mount(h(Probe, { count: 50, enabled: true }))
      const el = query<HTMLElement>(m.container, 'div')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await m.update(h(Probe, { count: 51, enabled: true }))
      await until(() => query<HTMLElement>(m.container, 'div').dataset.to !== '50', 'window measured')
      await act(async () => {
        el.scrollTop = 100
        el.dispatchEvent(new Event('scroll'))
        el.scrollTop = 200
        el.dispatchEvent(new Event('scroll'))
      })
      assert.equal(frames.length, 1, 'one frame serves both scroll events')
      await act(async () => { frames[0](0) })
      await until(() => query<HTMLElement>(m.container, 'div').dataset.from !== '0', 'latest offset applied')
      assert.equal(el.dataset.from, String(10 - ROW_WINDOW_OVERSCAN))
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('observes pane resizes when ResizeObserver exists', async () => {
    const disconnect = vi.fn()
    class FakeObserver {
      constructor(private readonly cb: () => void) {}
      observe = (): void => { this.cb() }
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', FakeObserver)
    try {
      const m = await mount(h(Probe, { count: 20, enabled: true }))
      const el = query<HTMLElement>(m.container, 'div')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await m.update(h(Probe, { count: 21, enabled: true }))
      await m.unmount()
      assert.ok(disconnect.mock.calls.length > 0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('cancels a pending animation frame on unmount', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', () => 7)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const m = await mount(h(Probe, { count: 50, enabled: true }))
      const el = query<HTMLElement>(m.container, 'div')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await m.update(h(Probe, { count: 51, enabled: true }))
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await m.unmount()
      assert.ok(cancel.mock.calls.length > 0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

})
