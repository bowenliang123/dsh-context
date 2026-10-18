import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { makeKit, mount, query, queryAll, until } from '../helpers/kit'

const kit = makeKit()
const FileCard = makeFileCard(kit, createContextSettings())

const PITCH = 41
const GAP = 2
const T0 = 1700000000000
let originals: [string, PropertyDescriptor | undefined][] = []

/** jsdom lays nothing out: give the list a 500×320 box and the rows a fixed 41px pitch so the card's own
 *  windowing path (wide + unexpanded) runs for real: measure → window → scroll. */
beforeAll(() => {
  // A no-op observer covers the card's ResizeObserver path; the list is measured on mount anyway.
  vi.stubGlobal('ResizeObserver', class {
    observe = (): void => {}
    disconnect = (): void => {}
  })
  originals = (['clientWidth', 'clientHeight', 'getBoundingClientRect'] as const)
    .map(name => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)] as [string, PropertyDescriptor | undefined])
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-fa-list')) return 500
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement): number {
      if (this.classList.contains('lc-fa-list')) return 320
      const own = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')?.get
      return own === undefined ? 0 : own.call(this)
    },
  })
  const rect = Object.getOwnPropertyDescriptor(Element.prototype, 'getBoundingClientRect')!.value as () => DOMRect
  Object.defineProperty(HTMLElement.prototype, 'getBoundingClientRect', {
    configurable: true,
    value(this: HTMLElement): DOMRect {
      if (this.classList.contains('lc-fa-list')) {
        return { left: 0, top: 0, width: 500, height: 320, right: 500, bottom: 320, x: 0, y: 0, toJSON: () => ({}) } as DOMRect
      }
      if (this.classList.contains('lc-fa-item')) {
        const items = [...(this.parentElement?.querySelectorAll('.lc-fa-item') ?? [])]
        const i = items.indexOf(this)
        return {
          left: 0, top: i * PITCH, width: 500, height: PITCH - GAP,
          right: 500, bottom: i * PITCH + PITCH - GAP, x: 0, y: i * PITCH, toJSON: () => ({}),
        } as DOMRect
      }
      return rect.call(this) as DOMRect
    },
  })
})

afterAll(() => {
  vi.unstubAllGlobals()
  for (const [name, desc] of originals) {
    if (desc === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, desc)
  }
})

function entry(index: number): FileEntry {
  const op: FileOp = { seq: index, kind: 'read', tool: 'read', time: T0 + index, err: false, added: 0, removed: 0, path: '' }
  return { path: `/src/file-${String(index).padStart(3, '0')}.ts`, form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [op] }
}

function activityOf(count: number): FileActivity {
  return {
    entries: Array.from({ length: count }, (_, i) => entry(i)),
    totals: {
      read: { files: count, ops: count }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 },
      added: 0, removed: 0,
    },
  }
}

const props = { activity: activityOf(60), scope: 'scope', state: 'ready' as const, onRetry: undefined }

describe('FileCard row windowing', () => {
  test('renders a measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(FileCard, props))
    try {
      const list = query<HTMLElement>(m.container, '.lc-fa-list')
      await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'the list windows after measuring')
      const rendered = queryAll(m.container, '.lc-fa-item').length
      assert.ok(rendered < 60 && rendered > 8)
      const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(pads.length, 1)
      assert.ok(Number.parseFloat(pads[0].style.height) > 0)
      assert.equal(list.clientHeight, 320) // the list keeps its box; the full height lives in the pads
      list.scrollTop = 900
      await new Promise(resolve => setTimeout(resolve, 40))
      list.dispatchEvent(new Event('scroll'))
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      const afterScroll = queryAll(m.container, '.lc-fa-item').length
      assert.ok(afterScroll < 60 && afterScroll >= 8)
      // Pads reproduce the skipped rows' pitch, letting the flex gap supply one slot between pad and row.
      const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(topPad.style.height, `${13 * PITCH - GAP}px`)
      assert.equal(bottomPad.style.height, `${21 * PITCH - GAP}px`)
    } finally {
      await m.unmount()
    }
  })

  test('an expanded row falls back to the full list, then windows again when closed', async () => {
    const m = await mount(h(FileCard, props))
    try {
      await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'windowed')
      const first = query<HTMLElement>(m.container, '.lc-fa-row')
      first.click()
      await until(() => queryAll(m.container, '.lc-fa-item').length === 60, 'expanded row shows the full list')
      first.click()
      await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'closing the row re-windows')
    } finally {
      await m.unmount()
    }
  })
})
