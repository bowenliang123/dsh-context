import assert from 'node:assert/strict'
import { createElement as h, useRef, type ReactElement } from 'react'
import { describe, test, vi } from 'vitest'
import { act } from 'react'
import { mount, query } from '../helpers/kit'
import { restoreLayout, stubClientSizes, stubListRect } from '../helpers/layout'
import { useElementSize, useScrollMetrics } from '../../../src/client/components/useElementMetrics'

function SizeProbe(props: { mode?: 'client' | 'content'; enabled?: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const size = useElementSize(ref, props.mode ?? 'client', props.enabled ?? true)
  return h('div', { ref, className: 'size-probe', 'data-w': size.width, 'data-h': size.height })
}

function ScrollProbe(props: { enabled?: boolean }): ReactElement {
  const ref = useRef<HTMLDivElement>(null)
  const metrics = useScrollMetrics(ref, props.enabled ?? true)
  return h('div', {
    ref,
    className: 'scroll-probe',
    'data-top': metrics.scrollTop,
    'data-h': metrics.height,
    'data-measured': String(metrics.measured),
  })
}

describe('useElementSize', () => {
  test('reports the client box, follows props, and resets while disabled', async () => {
    stubClientSizes({ 'size-probe': { width: 120, height: 40 } })
    try {
      const m = await mount(h(SizeProbe, {}))
      assert.equal(query(m.container, '.size-probe').getAttribute('data-w'), '120')
      assert.equal(query(m.container, '.size-probe').getAttribute('data-h'), '40')
      await m.update(h(SizeProbe, { enabled: false }))
      assert.equal(query(m.container, '.size-probe').getAttribute('data-w'), '0')
      await m.update(h(SizeProbe, { enabled: true }))
      assert.equal(query(m.container, '.size-probe').getAttribute('data-w'), '120')
      await m.unmount()
    } finally {
      restoreLayout()
    }
  })

  test('measures the content box minus the computed padding', async () => {
    stubListRect('size-probe', 200, 100)
    const observers: ResizeObserverCallback[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: ResizeObserverCallback) { observers.push(callback) }
      observe = (): void => {}
      disconnect = (): void => {}
    })
    try {
      const m = await mount(h(SizeProbe, { mode: 'content' }))
      const el = query<HTMLElement>(m.container, '.size-probe')
      assert.equal(el.getAttribute('data-w'), '200')
      el.style.padding = '5px 10px'
      await act(async () => { observers[0]([], {} as ResizeObserver) })
      assert.equal(query(m.container, '.size-probe').getAttribute('data-w'), '180')
      assert.equal(query(m.container, '.size-probe').getAttribute('data-h'), '90')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
      restoreLayout()
    }
  })
})

describe('useScrollMetrics', () => {
  test('measures the box, follows coalesced scroll frames, and resets while disabled', async () => {
    stubClientSizes({ 'scroll-probe': { width: 160, height: 200 } })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    try {
      const m = await mount(h(ScrollProbe, {}))
      const el = query<HTMLElement>(m.container, '.scroll-probe')
      assert.equal(el.getAttribute('data-h'), '200')
      assert.equal(el.getAttribute('data-measured'), 'true')
      Object.defineProperty(el, 'scrollTop', { configurable: true, value: 75 })
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.equal(el.getAttribute('data-top'), '75')
      await m.update(h(ScrollProbe, { enabled: false }))
      assert.equal(query(m.container, '.scroll-probe').getAttribute('data-top'), '0')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
      restoreLayout()
    }
  })

  test('a resize observer callback re-reads the box, and unmount cancels a queued frame', async () => {
    stubClientSizes({ 'scroll-probe': { width: 160, height: 200 } })
    const observers: ResizeObserverCallback[] = []
    const disconnects: number[] = []
    vi.stubGlobal('ResizeObserver', class {
      constructor(readonly callback: ResizeObserverCallback) { observers.push(callback) }
      observe = (): void => {}
      disconnect = (): void => { disconnects.push(1) }
    })
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    const cancels: number[] = []
    vi.stubGlobal('cancelAnimationFrame', () => { cancels.push(1) })
    try {
      const m = await mount(h(ScrollProbe, {}))
      const el = query<HTMLElement>(m.container, '.scroll-probe')
      Object.defineProperty(el, 'clientHeight', { configurable: true, value: 300 })
      await act(async () => { observers[0]([], {} as ResizeObserver) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.equal(el.getAttribute('data-h'), '300')
      await act(async () => { el.dispatchEvent(new Event('scroll')) })
      await m.unmount()
      assert.ok(cancels.length > 0, 'a queued frame is cancelled on unmount')
      assert.ok(disconnects.length > 0, 'the observer disconnects on unmount')
    } finally {
      vi.unstubAllGlobals()
      restoreLayout()
    }
  })
})
