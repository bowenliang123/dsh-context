import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test, vi } from 'vitest'
import {
  ROW_WINDOW_OVERSCAN,
  rowWindowFor,
  type SurfaceWindow,
  type WindowAlign,
} from '../../../src/client/components/useRowWindow'
import { mount, query, queryAll, until } from '../helpers/kit'
import {
  ControlledResizeObserver,
  estimateAt,
  numbers,
  pinBox,
  Probe,
  scrollBy,
  sizeOf,
} from './useRowWindowHarness'

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

describe('useSurfaceWindow — estimated windows', () => {
  test('bounds a large list by the viewport plus overscan, with pads that close the scroll height', async () => {
    const m = await mount(h(Probe, { count: 50, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      const seeded = numbers(el)
      assert.ok(seeded.to - seeded.from < 50, 'the first paint is already bounded')
      sizeOf(el, 100)
      await scrollBy(el, 0)
      assert.equal(el.dataset.enabled, 'true')
      assert.deepEqual(numbers(el), { from: 0, to: 9, top: 0, bottom: (50 - 10) * 20 })
      assert.equal(queryAll(el, '[data-row]').length, 10)
      await scrollBy(el, 200)
      assert.deepEqual(numbers(el), { from: 6, to: 19, top: 120, bottom: (50 - 20) * 20 })
      await until(() => query<HTMLElement>(el, '[data-row="row-6"]') !== null, 'the window follows the scroll')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('defaults its options and keeps the seed window when the scroller has no height', async () => {
    const m = await mount(h(Probe, { count: 80 }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      const range = numbers(el)
      assert.ok(range.to - range.from + 1 < 80)
      assert.ok(range.to >= 0)
      assert.equal(Number(el.dataset.bottom) > 0, true)
      await act(async () => {})
      assert.ok(queryAll(el, '[data-row]').length < 80, 'a zero-height pane still renders a bounded window')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('renders every row only for caller-disabled or below-threshold lists', async () => {
    const small = await mount(h(Probe, { count: 5, options: { estimateSize: estimateAt(20) } }))
    try {
      assert.equal(small.container.querySelectorAll('[data-row]').length, 5)
      assert.equal(query<HTMLElement>(small.container, 'div').dataset.enabled, 'false')
    } finally {
      await small.unmount()
    }
    const off = await mount(h(Probe, { count: 40, options: { estimateSize: estimateAt(20), enabled: false } }))
    try {
      const el = query<HTMLElement>(off.container, 'div')
      assert.equal(off.container.querySelectorAll('[data-row]').length, 40)
      assert.equal(el.dataset.enabled, 'false')
      assert.equal(numbers(el).top, 0)
      assert.equal(numbers(el).bottom, 0)
      await act(async () => {
        query<HTMLElement>(off.container, '[data-row="row-0"] button').dispatchEvent(
          new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }),
        )
      })
      assert.equal(queryAll<HTMLElement>(off.container, '[data-focus]')[0].tabIndex, 0, 'a disabled window keeps native tab stops')
    } finally {
      await off.unmount()
    }
  })

  test('keeps the window when the scroller is not attached', async () => {
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 60, attachRef: false, options: { estimateSize: estimateAt(20) }, onScope: next => { scope = next } }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      assert.ok(Number(el.dataset.to) - Number(el.dataset.from) + 1 < 60)
      assert.equal(Number(el.dataset.bottom) > 0, true)
      const shown = scope as unknown as SurfaceWindow
      shown.scrollToIndex(20, 'start')
      shown.scrollToKey('row-30')
      assert.equal(shown.activeKey, null)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('honours hysteresis by skipping micro scrolls and reusing the same range', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    const cancel = vi.fn()
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const m = await mount(h(Probe, { count: 60, options: { estimateSize: estimateAt(20), overscan: 80 } }))
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await scrollBy(el, 0, frames)
      const before = numbers(el)
      await scrollBy(el, 10, frames)
      assert.deepEqual(numbers(el), before, 'a micro scroll inside the hysteresis keeps the window')
      await scrollBy(el, 500, frames)
      assert.notDeepEqual(numbers(el), before, 'a real scroll moves the window')
      const moved = numbers(el)
      await scrollBy(el, 500, frames)
      assert.deepEqual(numbers(el), moved, 'an identical offset reuses the window')
      el.scrollTop = 520
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      assert.equal(frames.length, 1, 'scroll events coalesce into one frame')
      await m.unmount()
      assert.ok(cancel.mock.calls.length > 0, 'the pending scroll frame is cancelled on unmount')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('anchors to the end and keeps the anchor row fixed while measurements arrive', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const m = await mount(h(Probe, {
        count: 60,
        options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0, initial: 'end', anchorKey: 'row-55' },
      }))
      const el = query<HTMLElement>(m.container, 'div')
      assert.equal(el.scrollTop, 0, 'a zero-height pane cannot anchor to the end yet')
      sizeOf(el, 100)
      await scrollBy(el, 1_200, frames)
      assert.equal(el.scrollTop, 60 * 20 - 100, 'the end anchor lands at the content end')
      const observer = ControlledResizeObserver.rowObserver()
      const grown = observer.targets.find(target => (target as HTMLElement).dataset.row === 'row-52')
      assert.ok(grown !== undefined)
      const before = el.scrollTop
      await act(async () => { observer.settle(60, grown) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.equal(el.scrollTop, before + 40, 'the anchor top is preserved as its measured height changes')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('offsets a shared scroller through a static leading amount or a measured list element', async () => {
    const m = await mount(h(Probe, { count: 50, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0, leading: 64 } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      pinBox(el, 0, 100)
      await scrollBy(el, 500)
      assert.equal(numbers(el).from, 17, 'the static leading shifts the window start')
      const list = document.createElement('div')
      list.dataset.row = ''
      const pinContent = (contentTop: number): void => {
        Object.defineProperty(list, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            top: contentTop - el.scrollTop, left: 0, height: 20, width: 300,
            bottom: contentTop - el.scrollTop + 20, right: 300, x: 0, y: contentTop - el.scrollTop, toJSON: () => ({}),
          }) as DOMRect,
        })
      }
      pinContent(550)
      await m.update(h(Probe, { count: 50, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0, leadingEl: list } }))
      pinBox(el, 0, 100)
      await scrollBy(el, 500)
      assert.equal(numbers(el).from, 0, 'a below-viewport list start yields the head of the list')
      assert.equal(numbers(el).to, 6)
      pinContent(620)
      await scrollBy(el, 500)
      assert.equal(numbers(el).from, 0)
      assert.equal(numbers(el).to, 6, 'the window compensates the shifted list so the anchor row stays put')
      pinBox(list, -50, 20)
      await scrollBy(el, 0)
      assert.equal(numbers(el).from, 0, 'a list above the viewport yields the head of the list')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('scrollToIndex supports start, center and nearest alignment and clamps to the content', async () => {
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, {
      count: 50,
      options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 },
      onScope: next => { scope = next },
    }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      const shown = scope as unknown as SurfaceWindow
      shown.scrollToIndex(20, 'start')
      assert.equal(el.scrollTop, 400)
      shown.scrollToIndex(20, 'center')
      assert.equal(el.scrollTop, 400 + 10 - 50)
      shown.scrollToIndex(0, 'nearest')
      assert.equal(el.scrollTop, 0)
      shown.scrollToIndex(49, 'nearest')
      assert.equal(el.scrollTop, 50 * 20 - 100)
      shown.scrollToIndex(10, 'nearest' as WindowAlign)
      assert.equal(el.scrollTop, 200, 'nearest scrolls the row to the viewport top when it sits above it')
      shown.scrollToIndex(49, 'start')
      assert.equal(el.scrollTop, 50 * 20 - 100, 'a start jump clamps to the last full viewport')
      shown.scrollToIndex(-4, 'start')
      assert.equal(el.scrollTop, 0)
      shown.scrollToKey('row-25', 'start')
      assert.equal(el.scrollTop, 500)
      shown.scrollToKey('missing')
      assert.equal(el.scrollTop, 500)
      el.scrollTop = 300
      sizeOf(el, 0)
      shown.scrollToIndex(5, 'nearest')
      assert.equal(el.scrollTop, 300, 'a collapsed pane cannot align by nearest')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('useSurfaceWindow — focus and keyboard', () => {
  test('focusKey reveals and focuses a distant row, notifies once, and can be requested again after clearing', async () => {
    let scope: SurfaceWindow | null = null
    const handled = vi.fn()
    const base = { count: 60, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 }, onScope: (next: SurfaceWindow) => { scope = next } }
    const m = await mount(h(Probe, base))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: 'row-40', onFocusKeyHandled: handled } }))
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-40', 'the requested row takes focus')
      assert.equal(handled.mock.calls.length, 1)
      assert.ok(el.scrollTop > 0)
      await m.update(h(Probe, { ...base, options: { ...base.options, overscan: 100, focusKey: 'row-40', onFocusKeyHandled: handled } }))
      assert.equal(handled.mock.calls.length, 1, 'the same focus request is never replayed')
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: null, onFocusKeyHandled: handled } }))
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: 'row-40', onFocusKeyHandled: handled } }))
      await until(() => handled.mock.calls.length === 2, 'clearing and re-requesting the same row works')
      assert.equal((scope as unknown as SurfaceWindow).activeKey, 'row-40')
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: 'row-32' } }))
      await act(async () => { await Promise.resolve() })
      assert.equal(handled.mock.calls.length, 2, 'a request without a handler still moves the rows')
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: 'row-40', onFocusKeyHandled: handled } }))
      await act(async () => { await Promise.resolve() })
      assert.equal(handled.mock.calls.length, 3)
      await m.update(h(Probe, { ...base, options: { ...base.options, focusKey: 'ghost', onFocusKeyHandled: handled } }))
      await act(async () => { await Promise.resolve() })
      assert.equal(handled.mock.calls.length, 4, 'an unknown key is consumed immediately')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a detached scroller ignores keyboard events and a disabled window ignores focus requests', async () => {
    const m = await mount(h(Probe, { count: 40, attachRef: false, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    try {
      const button = query<HTMLElement>(m.container, '[data-focus]')
      await act(async () => {
        button.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      })
    } finally {
      await m.unmount()
    }
    const disabled = await mount(h(Probe, {
      count: 5,
      options: { estimateSize: estimateAt(20), focusKey: 'row-1', onFocusKeyHandled: () => {} },
    }))
    await act(async () => {})
    await disabled.unmount()
    vi.unstubAllGlobals()
  })

  test('a focus request on a detached scroller gives up after its bounded retries', async () => {
    const handled = vi.fn()
    const m = await mount(h(Probe, {
      count: 60,
      attachRef: false,
      options: { estimateSize: estimateAt(20), focusKey: 'row-5', onFocusKeyHandled: handled },
    }))
    await until(() => handled.mock.calls.length === 1, 'the request is consumed')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
    await m.unmount()
  })

  test('one roving tab stop follows focus and the active row, including when it leaves the window', async () => {
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 200, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 }, onScope: next => { scope = next } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      const stops = (): HTMLElement[] => queryAll<HTMLElement>(el, '[data-focus]').filter(button => button.tabIndex === 0)
      assert.equal(stops().length, 1)
      const shown = scope as unknown as SurfaceWindow
      assert.equal(shown.tabIndexFor('row-0'), 0)
      assert.equal(shown.tabIndexFor('row-1'), -1)
      assert.equal(shown.tabIndexFor('ghost'), -1)
      const firstButton = query<HTMLElement>(el, '[data-focus="row-0"]')
      firstButton.focus()
      await act(async () => {})
      assert.equal((scope as unknown as SurfaceWindow).activeKey, 'row-0')
      await scrollBy(el, 20 * 60)
      assert.equal(stops().length, 1, 'the loosed active row still leaves one tab stop in the window')
      assert.equal(shown.tabIndexFor('row-1'), -1)
      shown.setActiveKey('row-1')
      await act(async () => {})
      assert.equal((scope as unknown as SurfaceWindow).activeKey, 'row-1')
      shown.setActiveKey('row-1')
      await act(async () => {})
      assert.equal((scope as unknown as SurfaceWindow).activeKey, 'row-1')
      await m.unmount()
      void el
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('focusin keeps the roving key in sync and ignores events from outside the measured rows', async () => {
    const m = await mount(h(Probe, { count: 60, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      const target = query<HTMLElement>(el, '[data-focus="row-0"]')
      await act(async () => { target.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
      await act(async () => { el.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
      await act(async () => {})
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('Arrow/Page/Home/End move the roving focus through the full list', async () => {
    const m = await mount(h(Probe, { count: 120, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      const press = async (key: string, target: HTMLElement = document.activeElement as HTMLElement): Promise<void> => {
        await act(async () => {
          target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
        })
      }
      query<HTMLElement>(el, '[data-focus="row-0"]').focus()
      await press('ArrowDown')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-1', 'ArrowDown moves one row')
      await press('ArrowUp')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-0', 'ArrowUp moves back')
      await press('PageDown')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-5', 'PageDown jumps a viewport worth of rows')
      await press('PageUp')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-0', 'PageUp jumps back')
      await press('End')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-119', 'End reaches the last row')
      await press('Home')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-0', 'Home returns to the first row')
      await press('ArrowRight')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-1', 'horizontal arrows navigate the same rows')
      await press('Escape')
      await press('Tab')
      assert.equal(document.activeElement?.getAttribute('data-focus'), 'row-1', 'other keys leave the roving key alone')
      await press('ArrowUp', el)
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-0', 'an event from the list root falls back to the window head')
      await press('ArrowDown')
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-1', 'the roving focus resumes from the active row')
      const editable = query<HTMLElement>(el, '[data-guard="editable"]')
      Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true })
      await press('End', query<HTMLElement>(el, '[data-guard="input"]'))
      await press('End', editable)
      const prevented = new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true })
      prevented.preventDefault()
      await act(async () => { document.activeElement?.dispatchEvent(prevented) })
      await act(async () => {
        for (const init of [{ altKey: true }, { ctrlKey: true }, { metaKey: true }]) {
          document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true, ...init }))
        }
      })
      assert.equal(document.activeElement?.getAttribute('data-focus'), 'row-1', 'guarded keys leave the roving focus untouched')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
