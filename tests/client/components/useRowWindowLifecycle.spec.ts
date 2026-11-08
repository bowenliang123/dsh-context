import assert from 'node:assert/strict'
import { act, createElement as h, useRef } from 'react'
import { describe, test, vi } from 'vitest'
import {
  rowGeometryOf,
  useColumnWindow,
  useMeasuredWindow,
  useRowGeometry,
  useRowWindow,
  useWindowedRows,
  type MeasuredWindow,
  type RowGeometry,
  type SurfaceWindow,
  type WindowedRows,
} from '../../../src/client/components/useRowWindow'
import { mount, pinScroll, query, queryAll, settle, until } from '../helpers/kit'
import { restoreLayout, stubRowRects } from '../helpers/layout'
import {
  ControlledResizeObserver,
  estimateAt,
  keysOf,
  numbers,
  pinBox,
  pinScrollX,
  Probe,
  scrollBy,
  sizeOf,
} from './useRowWindowHarness'

describe('useSurfaceWindow — measurement lifecycle', () => {
  test('observed height changes reflow the window while duplicate and unknown measurements are ignored', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const m = await mount(h(Probe, { count: 60, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await scrollBy(el, 0, frames)
      const observer = ControlledResizeObserver.rowObserver()
      const target = observer.targets.find(entry => (entry as HTMLElement).dataset.row === 'row-0')
      assert.ok(target !== undefined)
      await act(async () => { observer.settle(20, target, false) })
      const before = numbers(el)
      await act(async () => { observer.settle(120, target) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.notDeepEqual(numbers(el), before, 'a measured height shift moves the window')
      const settled = numbers(el)
      await act(async () => { observer.settle(120, target) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.deepEqual(numbers(el), settled, 'an unchanged measurement is a no-op')
      const foreign = document.createElement('div')
      document.body.appendChild(foreign)
      await act(async () => { observer.settle(500, foreign) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.deepEqual(numbers(el), settled, 'unknown targets are ignored')
      foreign.remove()
      await m.unmount()
      assert.equal(observer.targets.length, 0, 'unmount releases every observed row')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('rejects invalid measured and estimated sizes and prunes heights for keys that leave the list', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const keys = keysOf(60)
      const estimate = (index: number): number => (index === 1 ? Number.NaN : index === 2 ? 0 : 20)
      const m = await mount(h(Probe, { count: 60, keys, options: { estimateSize: estimate, overscan: 80, hysteresis: 0 } }))
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await scrollBy(el, 0, frames)
      const observer = ControlledResizeObserver.rowObserver()
      const target = observer.targets.find(entry => (entry as HTMLElement).dataset.row === 'row-0')
      assert.ok(target !== undefined)
      await act(async () => { observer.settle(Number.NaN, target) })
      await act(async () => { observer.settle(0, target) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await scrollBy(el, 0, frames)
      assert.ok(queryAll(el, '[data-row]').length > 0)
      const observed = observer.targets.length
      await m.update(h(Probe, { count: 3, keys: keys.slice(0, 3), options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
      assert.ok(observer.targets.length < observed, 'removed keys stop being observed')
      assert.ok(queryAll(el, '[data-row]').length === 3)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('detaching a measured row unobserves its element', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 40, onScope: next => { scope = next }, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    try {
      const observer = ControlledResizeObserver.rowObserver()
      const first = query<HTMLElement>(m.container, '[data-row="row-0"]')
      assert.ok(observer.targets.includes(first))
      await act(async () => { (scope as unknown as SurfaceWindow).measure('row-0')(null) })
      assert.ok(!observer.targets.includes(first), 'the detached row stops being observed')
    } finally {
      await m.unmount()
      vi.unstubAllGlobals()
    }
  })

  test('pruning a measured key releases its observer target', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const m = await mount(h(Probe, { count: 40, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    try {
      const observer = ControlledResizeObserver.rowObserver()
      for (const target of [...observer.targets]) await act(async () => { observer.settle(20, target) })
      const first = query<HTMLElement>(m.container, '[data-row="row-0"]')
      assert.ok(observer.targets.includes(first))
      await m.update(h(Probe, {
        count: 40,
        keys: keysOf(40).slice(1),
        options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 },
      }))
      await act(async () => {})
      assert.ok(!observer.targets.includes(first), 'a pruned measured row stops being observed')
    } finally {
      await m.unmount()
      vi.unstubAllGlobals()
    }
  })

  test('detaching a measured row and dropping the active key clean up their state', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 60, onScope: next => { scope = next }, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 } }))
    const el = query<HTMLElement>(m.container, 'div')
    sizeOf(el, 100)
    await act(async () => {})
    const shown = scope as unknown as SurfaceWindow
    await act(async () => { shown.setActiveKey('row-0') })
    await act(async () => { shown.measure('missing')(null) })
    const observer = ControlledResizeObserver.rowObserver()
    for (const target of [...observer.targets]) await act(async () => { observer.settle(20, target) })
    await act(async () => { shown.measure('row-0')(null) })
    await act(async () => { shown.measure('row-1')(null) })
    await m.update(h(Probe, {
      count: 60,
      keys: keysOf(60).slice(1),
      onScope: next => { scope = next },
      options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 },
    }))
    await act(async () => {})
    assert.equal((scope as unknown as SurfaceWindow).activeKey, null, 'a removed active key resets the roving stop')
    await m.unmount()
    vi.unstubAllGlobals()
  })

  test('cancels a queued focus frame on unmount', async () => {
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', () => 7)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    const m = await mount(h(Probe, {
      count: 60,
      attachRef: false,
      options: { estimateSize: estimateAt(20), focusKey: 'row-9', onFocusKeyHandled: () => {} },
    }))
    await m.unmount()
    assert.ok(cancel.mock.calls.length > 0, 'the pending focus frame is cancelled')
    vi.unstubAllGlobals()
  })
})

describe('rowGeometryOf and the legacy row helpers', () => {
  function row(height: number, top: number): HTMLElement {
    const el = document.createElement('div')
    el.getBoundingClientRect = () => ({ top, height, bottom: top + height, left: 0, right: 100, width: 100, x: 0, y: top, toJSON: () => ({}) }) as DOMRect
    return el
  }

  test('reads a uniform pitch and gap, and rejects a lone, tiny, tight, or mixed row set', () => {
    assert.deepEqual(rowGeometryOf([row(28, 0), row(28, 30), row(28, 60)]), { pitch: 30, gap: 2 })
    assert.equal(rowGeometryOf([row(28, 0)]), null)
    assert.equal(rowGeometryOf([row(0, 0), row(0, 0)]), null)
    assert.equal(rowGeometryOf([row(30, 0), row(30, 10)]), null)
    assert.equal(rowGeometryOf([row(20, 0), row(28, 30), row(28, 60)]), null)
    assert.equal(rowGeometryOf([row(28, 0), row(28, 40), row(28, 60)]), null)
  })

  function GeometryProbe(props: { count: number; signature: string; onScope: (rows: WindowedRows, geometry: RowGeometry | null) => void }) {
    const ref = useRef<HTMLDivElement | null>(null)
    const keys = keysOf(props.count)
    const geometry = useRowGeometry(ref, props.count, '.g-row', props.signature)
    const rows = useWindowedRows(ref, props.count, geometry, true)
    props.onScope(rows, geometry)
    return h('div', { ref },
      Array.from({ length: props.count }, (_, index) => h('div', { key: keys[index], className: 'g-row' }, keys[index]))
        .slice(rows.from, rows.to + 1))
  }

  test('measures row geometry and windows through it with derived pads', async () => {
    let last: WindowedRows | null = null
    let geometry: RowGeometry | null = null
    const m = await mount(h(GeometryProbe, { count: 60, signature: 'a', onScope: (rows, next) => { last = rows; geometry = next } }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      sizeOf(el, 100)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      const rows = last as unknown as WindowedRows
      assert.equal(geometry, null, 'rows without a stubbed rect measure no pitch')
      assert.ok(rows.pitch >= 0)
      await m.update(h(GeometryProbe, { count: 60, signature: 'b', onScope: (next) => { last = next } }))
      await act(async () => {})
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('legacy fixed row and column windows stay bounded and follow the scroll', async () => {
    function RowProbe(props: { count: number; enabled?: boolean }) {
      const ref = useRef<HTMLDivElement | null>(null)
      const range = useRowWindow(ref, props.count, 20, props.enabled ?? true)
      return h('div', { ref, 'data-from': range.from, 'data-to': range.to })
    }
    function ColumnProbe(props: { count: number }) {
      const ref = useRef<HTMLDivElement | null>(null)
      const range = useColumnWindow(ref, props.count, 20, true)
      return h('div', { ref, 'data-from': range.from, 'data-to': range.to })
    }
    const m = await mount(h(RowProbe, { count: 50 }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      assert.ok(Number(el.dataset.to) - Number(el.dataset.from) + 1 < 50)
      el.scrollTop = 200
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await until(() => Number(query<HTMLElement>(m.container, 'div').dataset.from) > 0, 'the fixed window follows the scroll')
      await m.update(h(RowProbe, { count: 50, enabled: false }))
      assert.equal(query<HTMLElement>(m.container, 'div').dataset.to, '49', 'a disabled window renders the list')
    } finally {
      await m.unmount()
    }
    const column = await mount(h(ColumnProbe, { count: 50 }))
    try {
      const el = query<HTMLElement>(column.container, 'div')
      sizeOf(el, 0, 100)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      assert.ok(Number(el.dataset.to) < 49)
      el.scrollLeft = 200
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await until(() => Number(query<HTMLElement>(column.container, 'div').dataset.from) > 0, 'the column window follows horizontal scroll')
    } finally {
      await column.unmount()
      vi.unstubAllGlobals()
    }
  })

  test('legacy measured windows are bounded, prune dropped keys and scroll to a distant key', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    function MeasuredProbe(props: { keys: readonly string[]; rowCount?: number; onScope: (scope: MeasuredWindow) => void }) {
      const ref = useRef<HTMLDivElement | null>(null)
      const scope = props.rowCount === undefined
        ? useMeasuredWindow(ref, props.keys, estimateAt(40))
        : useMeasuredWindow(ref, props.keys, estimateAt(40), props.rowCount)
      props.onScope(scope)
      return h('div', { ref, 'data-from': scope.from, 'data-to': scope.to, 'data-top': scope.topPad, 'data-bottom': scope.bottomPad },
        props.keys.slice(scope.from, scope.to + 1).map(key => h('div', { key, 'data-row': key, ref: scope.measure(key) }, key)))
    }
    const keys = keysOf(80)
    let scope: MeasuredWindow | null = null
    const m = await mount(h(MeasuredProbe, { keys, onScope: next => { scope = next } }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      sizeOf(el, 120)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const rows = scope as unknown as MeasuredWindow
      assert.ok(rows.to - rows.from + 1 < 80, 'the measured window is bounded')
      const observer = ControlledResizeObserver.rowObserver()
      for (const target of [...observer.targets]) await act(async () => { observer.settle(40, target) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await act(async () => { (scope as unknown as MeasuredWindow).scrollToKey('row-70') })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(query(m.container, '[data-row="row-70"]') !== null, 'the distant key renders after the jump')
      await m.update(h(MeasuredProbe, { keys: keys.slice(0, 2), onScope: next => { scope = next } }))
      await act(async () => {})
      assert.ok(queryAll(m.container, '[data-row]').length <= 2)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
    const excluded = await mount(h(MeasuredProbe, { keys: keysOf(20), rowCount: 12, onScope: () => {} }))
    try {
      const el = query<HTMLElement>(excluded.container, 'div')
      assert.equal(el.dataset.enabled, undefined)
      assert.equal(queryAll(excluded.container, '[data-row]').length, 20, 'a below-threshold row count renders the list')
    } finally {
      await excluded.unmount()
      vi.unstubAllGlobals()
    }
    const detached = await mount(h(MeasuredProbe, { keys: keysOf(40), rowCount: 40, onScope: () => {} }))
    try {
      assert.ok(queryAll(detached.container, '[data-row]').length < 40, 'a detached scroller still renders a bounded window')
    } finally {
      await detached.unmount()
      vi.unstubAllGlobals()
    }
  })
})

describe('useSurfaceWindow — hostile inputs and geometry helpers', () => {
  test('clamps zero-count lists, oversized indexes, negative centers and horizontal scrollers', async () => {
    let emptyScope: SurfaceWindow | null = null
    const empty = await mount(h(Probe, { count: 0, onScope: next => { emptyScope = next } }))
    try {
      const scope = emptyScope as unknown as SurfaceWindow
      scope.scrollToIndex(0, 'start')
      scope.setActiveKey('ghost')
      assert.equal(scope.from, 0)
      assert.equal(scope.tabIndexFor('ghost'), 0, 'a disabled window keeps native tab stops')
    } finally {
      await empty.unmount()
    }
    let columnScope: SurfaceWindow | null = null
    const m = await mount(h(Probe, {
      count: 50,
      options: { axis: 'column', estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 },
      onScope: next => { columnScope = next },
    }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      pinScrollX(el)
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 100 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      const shown = columnScope as unknown as SurfaceWindow
      shown.scrollToIndex(0, 'center')
      assert.equal(el.scrollLeft, 0, 'a negative center clamps to the content start')
      shown.scrollToIndex(999, 'start')
      assert.equal(el.scrollLeft, 50 * 20 - 100, 'an oversized index clamps to the content end')
      shown.scrollToIndex(-5, 'start')
      assert.equal(el.scrollLeft, 0)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('handles non-element keyboard targets, collapsed panes and a repeated End press', async () => {
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 80, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 }, onScope: next => { scope = next } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      sizeOf(el, 100)
      await scrollBy(el, 0)
      const shown = scope as unknown as SurfaceWindow
      const preventDefault = vi.fn()
      await act(async () => {
        shown.onKeyDown({
          key: 'End', defaultPrevented: false, altKey: false, ctrlKey: false, metaKey: false,
          preventDefault, target: null,
        } as unknown as Parameters<SurfaceWindow['onKeyDown']>[0])
      })
      assert.equal(preventDefault.mock.calls.length, 1)
      await until(() => document.activeElement?.getAttribute('data-focus') === 'row-79', 'End reaches the last row')
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      })
      await act(async () => {})
      sizeOf(el, 0)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      query<HTMLElement>(el, '[data-focus="row-79"]').focus()
      await act(async () => {
        document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true }))
      })
      await act(async () => {})
      assert.equal(document.activeElement?.getAttribute('data-focus'), 'row-79', 'paging on a collapsed pane still lands in range')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('saturates invalid viewport and scroll metrics to zero', async () => {
    let scope: SurfaceWindow | null = null
    const m = await mount(h(Probe, { count: 80, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 }, onScope: next => { scope = next } }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => Number.NaN })
      Object.defineProperty(el, 'scrollTop', { configurable: true, get: () => Number.NaN })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await settle(30)
      const shown = scope as unknown as SurfaceWindow
      assert.ok(shown.from >= 0 && shown.to >= shown.from)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('shrinking a measured row above the anchor raises the scroll position and clamps at the top', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const m = await mount(h(Probe, {
        count: 40,
        options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0, anchorKey: 'row-2' },
      }))
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await scrollBy(el, 0, frames)
      const observer = ControlledResizeObserver.rowObserver()
      const grown = observer.targets.find(target => (target as HTMLElement).dataset.row === 'row-1')
      assert.ok(grown !== undefined)
      await act(async () => { observer.settle(1_200, grown) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await act(async () => { observer.settle(2, grown) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(el.scrollTop >= 0, 'a negative compensation clamps at the top')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('an explicit small seed renders the full small list while still enabled', async () => {
    const m = await mount(h(Probe, { count: 20, options: { estimateSize: estimateAt(20), minCount: 0, seed: 50 } }))
    try {
      assert.equal(query<HTMLElement>(m.container, 'div').dataset.enabled, 'true')
      assert.ok(queryAll(m.container, '[data-row]').length <= 20)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a leading list element measured on the column axis contributes its left offset', async () => {
    let scope: SurfaceWindow | null = null
    const list = document.createElement('div')
    const m = await mount(h(Probe, {
      count: 60,
      options: { axis: 'column', estimateSize: estimateAt(20), overscan: 80, hysteresis: 0, leadingEl: list },
      onScope: next => { scope = next },
    }))
    const el = query<HTMLElement>(m.container, 'div')
    try {
      pinScrollX(el)
      sizeOf(el, 0, 100)
      pinBox(el, 0, 20, 0, 100)
      pinBox(list, 0, 20, 40)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await settle(30)
      assert.equal(numbers(el).from, 0)
      assert.ok((scope as unknown as SurfaceWindow).from === 0)
      pinBox(list, 0, 20, 0)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await settle(30)
      assert.equal(numbers(el).top, 0)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('focus requests cancel a pending frame, retry an unmounted row and honour a focusable row element', async () => {
    const frames: FrameRequestCallback[] = []
    const cancel = vi.fn()
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      let scope: SurfaceWindow | null = null
      const base = { count: 60, options: { estimateSize: estimateAt(20), overscan: 80, hysteresis: 0 }, onScope: (next: SurfaceWindow) => { scope = next } }
      const m = await mount(h(Probe, {
        ...base,
        rows: (keys, current) => keys.slice(current.from, current.to + 1).map(key => h('div', {
          key, 'data-row': key, ref: current.measure(key), tabIndex: 0,
        }, key)),
      }))
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await m.update(h(Probe, {
        ...base,
        rows: (keys, current) => keys.slice(current.from, current.to + 1).map(key => h('div', {
          key, 'data-row': key, ref: current.measure(key), tabIndex: 0,
        }, key)),
        options: { ...base.options, focusKey: 'row-30', onFocusKeyHandled: () => {} },
      }))
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.equal((scope as unknown as SurfaceWindow).activeKey, 'row-30')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('a focus request for a row outside the mounted seed retries and then gives up', async () => {
    const handled = vi.fn()
    const m = await mount(h(Probe, {
      count: 60,
      attachRef: false,
      options: { estimateSize: estimateAt(20), focusKey: 'row-59', onFocusKeyHandled: handled },
    }))
    await until(() => handled.mock.calls.length === 1, 'the request is consumed')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)) })
    await m.unmount()
  })
})

describe('legacy geometry windows', () => {
  function GeometryProbe(props: {
    count: number
    signature: string
    enabled?: boolean
    windowEnabled?: boolean
    onScope: (rows: WindowedRows, geometry: RowGeometry | null) => void
  }) {
    const ref = useRef<HTMLDivElement | null>(null)
    const keys = keysOf(props.count)
    const geometry = useRowGeometry(ref, props.count, '.g-row', props.signature, props.enabled)
    const rows = useWindowedRows(ref, props.count, geometry, props.windowEnabled ?? false)
    props.onScope(rows, geometry)
    return h('div', { ref },
      keys.slice(rows.from, rows.to + 1).map(key => h('div', { key, className: 'g-row', 'data-row': key }, key)))
  }

  test('measures uniform row geometry and windows the list with derived pads', async () => {
    stubRowRects('g-row', () => 30, 2)
    try {
      let rows: WindowedRows | null = null
      let geometry: RowGeometry | null = null
      const m = await mount(h(GeometryProbe, {
        count: 60,
        signature: 'a',
        onScope: (next, measured) => { rows = next; geometry = measured },
      }))
      try {
        assert.deepEqual(geometry, { pitch: 32, gap: 2 })
        assert.equal((rows as unknown as WindowedRows).from, 0)
        await m.update(h(GeometryProbe, { count: 60, signature: 'b', onScope: (next, measured) => { rows = next; geometry = measured } }))
        assert.deepEqual(geometry, { pitch: 32, gap: 2 }, 'a new signature remeasures the same pitch')
      } finally {
        await m.unmount()
      }
    } finally {
      restoreLayout()
    }
    stubRowRects('g-row', () => 30, 2)
    try {
      let rows: WindowedRows | null = null
      const m = await mount(h(GeometryProbe, {
        count: 2,
        signature: 'tiny',
        onScope: next => { rows = next },
      }))
      try {
        assert.equal((rows as unknown as WindowedRows).from, 0)
      } finally {
        await m.unmount()
      }
      const off = await mount(h(GeometryProbe, {
        count: 40,
        signature: 'off',
        enabled: false,
        onScope: (next, measured) => { rows = next; assert.equal(measured, null) },
      }))
      try {
        assert.equal((rows as unknown as WindowedRows).to, 39)
      } finally {
        await off.unmount()
      }
    } finally {
      restoreLayout()
    }
  })

  test('windows through a supplied geometry and pads from its pitch, or falls back to unit rows', async () => {
    function HandcraftedProbe(props: { count: number; geometry: RowGeometry | null; enabled: boolean; onScope: (rows: WindowedRows) => void }) {
      const ref = useRef<HTMLDivElement | null>(null)
      const rows = useWindowedRows(ref, props.count, props.geometry, props.enabled)
      props.onScope(rows)
      return h('div', {
        ref,
        'data-from': rows.from,
        'data-to': rows.to,
        'data-top': rows.topPad,
        'data-bottom': rows.bottomPad,
        'data-pitch': rows.pitch,
      })
    }
    let rows: WindowedRows | null = null
    const m = await mount(h(HandcraftedProbe, {
      count: 60,
      geometry: { pitch: 32, gap: 2 },
      enabled: true,
      onScope: next => { rows = next },
    }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      sizeOf(el, 100)
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => {})
      assert.equal(el.dataset.pitch, '32')
      el.scrollTop = 900
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await settle(30)
      assert.ok(Number(el.dataset.top) > 0, 'a top pad appears mid-list')
      assert.ok(Number(el.dataset.bottom) > 0, 'a bottom pad closes the list')
      await m.update(h(HandcraftedProbe, {
        count: 60,
        geometry: null,
        enabled: true,
        onScope: next => { rows = next },
      }))
      assert.equal(el.dataset.pitch, '1')
      const unit = rows as unknown as WindowedRows
      assert.equal(unit.topPad, unit.from)
      assert.equal(unit.bottomPad, 60 - 1 - unit.to)
    } finally {
      await m.unmount()
      vi.unstubAllGlobals()
    }
    const disabled = await mount(h(HandcraftedProbe, {
      count: 5,
      geometry: { pitch: 20, gap: 0 },
      enabled: false,
      onScope: () => {},
    }))
    try {
      assert.equal(query<HTMLElement>(disabled.container, 'div').dataset.to, '4')
    } finally {
      await disabled.unmount()
      vi.unstubAllGlobals()
    }
  })

  test('legacy row and column options tolerate a zero size', async () => {
    function ZeroRowProbe() {
      const ref = useRef<HTMLDivElement | null>(null)
      const range = useRowWindow(ref, 40, 0, true)
      return h('div', { ref, 'data-from': range.from, 'data-to': range.to })
    }
    function ZeroColumnProbe() {
      const ref = useRef<HTMLDivElement | null>(null)
      const range = useColumnWindow(ref, 40, 0, true)
      return h('div', { ref, 'data-from': range.from, 'data-to': range.to })
    }
    const m = await mount(h(ZeroRowProbe))
    try {
      assert.ok(queryAll(m.container, 'div').length === 1)
    } finally {
      await m.unmount()
    }
    const column = await mount(h(ZeroColumnProbe))
    try {
      assert.ok(queryAll(column.container, 'div').length === 1)
    } finally {
      await column.unmount()
      vi.unstubAllGlobals()
    }
  })
})
