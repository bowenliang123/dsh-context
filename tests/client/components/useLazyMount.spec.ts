import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { act } from 'react'
import { describe, test, vi } from 'vitest'
import { useLazyMount } from '../../../src/client/components/useLazyMount'
import { mount, query } from '../helpers/kit'

function Probe(props: { attachRef?: boolean; wrap?: boolean; force?: boolean }) {
  const [ref, mounted] = useLazyMount(props.force === true)
  const body = mounted ? h('span', { 'data-mounted': 'yes' }) : h('span', { 'data-mounted': 'no' })
  const inner = h('div', { ...(props.attachRef === false ? {} : { ref }), 'data-probe': '' }, body)
  return props.wrap === true
    ? h('div', { 'data-conversation-scroll': '' }, inner)
    : inner
}

interface ObserverRecord { callback: IntersectionObserverCallback; disconnected: number }

function stubObserver(): { records: ObserverRecord[]; restore: () => void } {
  const records: ObserverRecord[] = []
  class FakeObserver {
    private readonly record: ObserverRecord
    constructor(callback: IntersectionObserverCallback) {
      this.record = { callback, disconnected: 0 }
      records.push(this.record)
    }
    observe = (): void => {}
    disconnect = (): void => { this.record.disconnected++ }
  }
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  return { records, restore: () => { vi.unstubAllGlobals() } }
}

describe('useLazyMount', () => {
  test('mounts immediately when IntersectionObserver is unavailable', async () => {
    const m = await mount(h(Probe, {}))
    assert.equal(query(m.container, '[data-mounted]')?.getAttribute('data-mounted'), 'yes')
    await m.unmount()
  })

  test('re-observes a reattached placeholder (a hidden sidebar copy comes back)', async () => {
    const observer = stubObserver()
    vi.stubGlobal('requestIdleCallback', undefined)
    try {
      const m = await mount(h(Probe, { attachRef: false }))
      assert.equal(observer.records.length, 0)
      await m.update(h(Probe, { attachRef: true }))
      assert.equal(observer.records.length, 1, 'the first attach observes')
      await m.update(h(Probe, { attachRef: false }))
      await m.update(h(Probe, { attachRef: true }))
      assert.equal(observer.records.length, 2, 'a reattach observes again')
      await m.unmount()
    } finally {
      observer.restore()
      vi.unstubAllGlobals()
    }
  })

  test('force mounts without waiting for the observer (a pending jump)', async () => {
    const observer = stubObserver()
    try {
      const m = await mount(h(Probe, { force: true }))
      assert.equal(query(m.container, '[data-mounted]')?.getAttribute('data-mounted'), 'yes')
      await m.unmount()
      assert.equal(observer.records.length, 0)
    } finally {
      observer.restore()
      vi.unstubAllGlobals()
    }
  })

  test('keeps the skeleton until the block nears the viewport, then mounts in an idle slice', async () => {
    const observer = stubObserver()
    const idle: (() => void)[] = []
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => { idle.push(callback); return 7 })
    const cancel = vi.fn()
    vi.stubGlobal('cancelIdleCallback', cancel)
    try {
      const m = await mount(h(Probe, {}))
      assert.equal(query(m.container, '[data-mounted]')?.getAttribute('data-mounted'), 'no')
      assert.equal(observer.records.length, 1)
      const entry = { isIntersecting: false } as IntersectionObserverEntry
      await act(async () => { observer.records[0].callback([entry], {} as IntersectionObserver) })
      assert.equal(query(m.container, '[data-mounted]')?.getAttribute('data-mounted'), 'no')
      await act(async () => {
        observer.records[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
      assert.equal(idle.length, 1)
      await act(async () => { idle[0]() })
      assert.equal(query(m.container, '[data-mounted]')?.getAttribute('data-mounted'), 'yes')
      // A second intersection after mounting must not schedule another mount.
      await act(async () => {
        observer.records[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
      await m.unmount()
    } finally {
      observer.restore()
      vi.unstubAllGlobals()
    }
  })

  test('falls back to a timeout without requestIdleCallback and cancels it on unmount', async () => {
    const observer = stubObserver()
    vi.stubGlobal('requestIdleCallback', undefined)
    try {
      const m = await mount(h(Probe, {}))
      await act(async () => {
        observer.records[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver)
      })
      // Unmount before the timeout fires: the cleanup clears it (no state update on an unmounted tree).
      await m.unmount()
      assert.ok(observer.records[0].disconnected > 0)
    } finally {
      observer.restore()
      vi.unstubAllGlobals()
    }
  })

  test('resolves a conversation scroll parent as the observer root and tolerates a missing ref', async () => {
    const observer = stubObserver()
    try {
      const m = await mount(h(Probe, { wrap: true }))
      assert.equal(observer.records.length, 1)
      await m.unmount()
      const missing = await mount(h(Probe, { attachRef: false }))
      assert.equal(query(missing.container, '[data-mounted]')?.getAttribute('data-mounted'), 'no')
      await missing.unmount()
    } finally {
      observer.restore()
      vi.unstubAllGlobals()
    }
  })
})
