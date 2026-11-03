import assert from 'node:assert/strict'
import { createElement as h, useRef } from 'react'
import { act } from 'react'
import { describe, test, vi } from 'vitest'
import { ROW_WINDOW_OVERSCAN, rowWindowFor, useColumnWindow, useMeasuredWindow, useRowWindow, type MeasuredWindow } from '../../../src/client/components/useRowWindow'
import { mount, pinScroll, query, queryAll, until } from '../helpers/kit'

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

function Probe(props: { count: number; enabled: boolean; attachRef?: boolean; overscan?: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const range = useRowWindow(ref, props.count, 20, props.enabled, props.overscan)
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

function ColumnProbe(props: { count: number }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const range = useColumnWindow(ref, props.count, 20, true)
  return h('div', { ref, 'data-from': range.from, 'data-to': range.to })
}

describe('useRowWindow', () => {
  test('renders in full until the scroller is measured, then follows scroll', async () => {
    const m = await mount(h(Probe, { count: 50, enabled: true }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      assert.equal(el.dataset.from, '0')
      assert.equal(el.dataset.to, '49')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
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

  test('stays full when disabled, unmeasured, the ref is not attached, or the box stays unmeasurable as deps churn', async () => {
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

    const m = await mount(h(Probe, { count: 40, enabled: true }))
    try {
      await m.update(h(Probe, { count: 40, enabled: true, overscan: 4 }))
      const node = query<HTMLElement>(m.container, 'div')
      assert.equal(node.dataset.from, '0')
      assert.equal(node.dataset.to, '39')
      await m.update(h(Probe, { count: 40, enabled: true, attachRef: false, overscan: 5 }))
      assert.equal(node.dataset.from, '0')
      assert.equal(node.dataset.to, '39')
    } finally {
      await m.unmount()
    }
  })

  test('coalesces two scroll events into one frame, applies the latest offset, and leaves a no-move frame where it is', async () => {
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
      const moved = { from: el.dataset.from, to: el.dataset.to }
      await act(async () => {
        el.dispatchEvent(new Event('scroll'))
      })
      await act(async () => { frames[1](0) })
      assert.deepEqual({ from: el.dataset.from, to: el.dataset.to }, moved, 'the same row range is reused')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('observes pane resizes and cancels a pending animation frame on unmount', async () => {
    const disconnect = vi.fn()
    const cancel = vi.fn()
    class FakeObserver {
      constructor(private readonly cb: () => void) {}
      observe = (): void => { this.cb() }
      disconnect = disconnect
    }
    vi.stubGlobal('ResizeObserver', FakeObserver)
    vi.stubGlobal('requestAnimationFrame', () => 7)
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const m = await mount(h(Probe, { count: 20, enabled: true }))
      const el = query<HTMLElement>(m.container, 'div')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await m.update(h(Probe, { count: 21, enabled: true }))
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await m.unmount()
      assert.ok(disconnect.mock.calls.length > 0)
      assert.ok(cancel.mock.calls.length > 0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('tracks horizontal scroll windows with the same bounded ranges', async () => {
    const m = await mount(h(ColumnProbe, { count: 50 }))
    try {
      const el = query<HTMLElement>(m.container, 'div')
      Object.defineProperty(el, 'clientWidth', { configurable: true, value: 100 })
      await m.update(h(ColumnProbe, { count: 51 }))
      await until(() => query<HTMLElement>(m.container, 'div').dataset.to !== '50', 'column window measured')
      assert.equal(el.dataset.to, String(5 + ROW_WINDOW_OVERSCAN))
      el.scrollLeft = 200
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await until(() => query<HTMLElement>(m.container, 'div').dataset.from !== '0', 'column window follows scroll')
      assert.equal(el.dataset.from, String(10 - ROW_WINDOW_OVERSCAN))
    } finally {
      await m.unmount()
    }
  })
})

function MeasuredProbe(props: { keys: readonly string[]; estimate: () => number; onScope: (scope: MeasuredWindow) => void }) {
  const ref = useRef<HTMLDivElement | null>(null)
  const scope = useMeasuredWindow(ref, props.keys, props.estimate)
  props.onScope(scope)
  return h('div', { ref, 'data-from': scope.from, 'data-to': scope.to, 'data-top': scope.topPad, 'data-bottom': scope.bottomPad },
    props.keys.slice(scope.from, scope.to + 1).map(key => h('div', { key, 'data-row': key, ref: scope.measure(key) }, key)))
}

class ControlledResizeObserver {
  static all: ControlledResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(private readonly callback: ResizeObserverCallback) { ControlledResizeObserver.all.push(this) }
  static rowObserver(): ControlledResizeObserver {
    const found = ControlledResizeObserver.all.find(entry => entry.targets.some(target => (target as HTMLElement).dataset?.row !== undefined))
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
      [{ target, contentRect: { height } } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
  get watching(): boolean { return this.targets.length > 0 }
}


describe('useMeasuredWindow', () => {
  test('seeds a bounded window, follows the measured viewport, and scrolls to a distant key', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const keys = Array.from({ length: 80 }, (_, index) => `row-${index}`)
      let scope: MeasuredWindow | null = null
      const seeded: Array<{ from: number; to: number }> = []
      const m = await mount(h(MeasuredProbe, {
        keys,
        estimate: () => 40,
        onScope: (next) => {
          scope = next
          if (seeded.length === 0) seeded.push({ from: next.from, to: next.to })
        },
      }))
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      assert.deepEqual(seeded[0], { from: 0, to: 11 }, 'the first paint seeds a dozen rows')
      assert.equal(el.dataset.from, '0')
      assert.equal(el.dataset.to, '79', 'an unmeasured pane still renders everything')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 120 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const shown = scope as unknown as MeasuredWindow
      assert.ok(shown.to - shown.from + 1 < keys.length, 'the measured pane bounds the window')
      assert.ok(Number(el.dataset.bottom) > 0, 'the tail keeps its scroll height')
      await act(async () => { (scope as unknown as MeasuredWindow).scrollToKey('row-79') })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(query(m.container, '[data-row="row-79"]') !== null, 'the distant key renders after the jump')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('measured heights feed the offsets that place the next window', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const keys = Array.from({ length: 40 }, (_, index) => `row-${index}`)
      let scope: MeasuredWindow | null = null
      const m = await mount(h(MeasuredProbe, { keys, estimate: () => 40, onScope: (next) => { scope = next } }))
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const observer = ControlledResizeObserver.rowObserver()
      assert.ok(observer.targets.some(target => target.isConnected), 'rendered rows are observed')
      const firstRow = observer.targets.find(target => target.isConnected && (target as HTMLElement).dataset.row === 'row-0') as Element
      await act(async () => { observer.settle(220, firstRow) })
      await act(async () => { observer.settle(220, firstRow) })
      el.scrollTop = 800
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const after = query<HTMLElement>(m.container, 'div')
      assert.equal(after.dataset.top, '540', 'the measured first row shifts every later offset by its delta')
      const shown = { from: (scope as unknown as MeasuredWindow).from, to: (scope as unknown as MeasuredWindow).to }
      await m.update(h(MeasuredProbe, { keys: keys.slice(), estimate: () => 40, onScope: (next) => { scope = next } }))
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.deepEqual(
        { from: (scope as unknown as MeasuredWindow).from, to: (scope as unknown as MeasuredWindow).to },
        shown,
        'an equal re-measure keeps the same window object',
      )
      assert.ok((scope as unknown as MeasuredWindow).to < 39, 'the window stays bounded')
      await m.unmount()
      assert.equal(observer.watching, false, 'unmount releases the row observer')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('renders every key when the scroller is absent', async () => {
    const keys = Array.from({ length: 40 }, (_, index) => `key-${index}`)
    let scope: MeasuredWindow | null = null
    function Detached(): ReturnType<typeof h> {
      scope = useMeasuredWindow(useRef<HTMLDivElement | null>(null), keys, () => 20)
      return h('div')
    }
    const m = await mount(h(Detached))
    const shown = scope as unknown as MeasuredWindow
    assert.deepEqual({ from: shown.from, to: shown.to, top: shown.topPad, bottom: shown.bottomPad }, { from: 0, to: 39, top: 0, bottom: 0 })
    await m.unmount()
  })
})

describe('useMeasuredWindow — observer edges', () => {
  test('coalesces scroll events, ignores unknown observer targets, and cancels a queued frame on unmount', async () => {
    const frames: FrameRequestCallback[] = []
    const cancel = vi.fn()
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const keys = Array.from({ length: 40 }, (_, index) => `row-${index}`)
      const m = await mount(h(MeasuredProbe, { keys, estimate: () => 40, onScope: () => {} }))
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await act(async () => {
        el.dispatchEvent(new Event('scroll'))
        el.dispatchEvent(new Event('scroll'))
      })
      assert.equal(frames.length, 1, 'two scrolls share one queued frame')
      const observer = ControlledResizeObserver.rowObserver()
      await act(async () => { observer.settle(120, document.createElement('div')) })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      for (const frame of frames.splice(0)) frame(0)
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 0 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.equal(queryAll(m.container, '[data-row]').length, 40, 'a collapsed pane widens back to every row')
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await m.unmount()
      assert.ok(cancel.mock.calls.length > 0, 'unmount cancels the queued frame')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('useMeasuredWindow — key pruning', () => {
  test('releases observer targets and cached sizes for keys that leave the list', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const keys = Array.from({ length: 40 }, (_, index) => `row-${index}`)
      const m = await mount(h(MeasuredProbe, { keys, estimate: () => 40, onScope: () => {} }))
      const el = query<HTMLElement>(m.container, 'div')
      pinScroll(el)
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const observer = ControlledResizeObserver.rowObserver()
      el.scrollTop = 800
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const observed = observer.targets.length
      assert.ok(observed > 0)
      for (const target of [...observer.targets]) {
        const row = (target as HTMLElement).dataset.row
        const index = Number(row?.slice(4) ?? 0)
        await act(async () => { observer.settle(40 + index, target) })
      }
      await m.update(h(MeasuredProbe, { keys: keys.slice(0, 2), estimate: () => 40, onScope: () => {} }))
      assert.ok(observer.targets.length < observed, 'dropped keys stop being observed')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
