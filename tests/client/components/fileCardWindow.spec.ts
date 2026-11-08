import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { click, fireScroll, makeKit, mount, query, queryAll, settle, text, until } from '../helpers/kit'
import { restoreLayout, stubClientSizes } from '../helpers/layout'

const kit = makeKit()
const FileCard = makeFileCard(kit, createContextSettings())

const LIST_HEIGHT = 320
const MEASURED = 43
const T0 = 1700000000000

class ControlledResizeObserver {
  static all: ControlledResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { ControlledResizeObserver.all.push(this) }
  static reset(): void { ControlledResizeObserver.all = [] }
  static rowObserver(): ControlledResizeObserver {
    const found = ControlledResizeObserver.all.find(entry => entry.targets.some(target => target.classList.contains('lc-fa-slot')))
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
      [{
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: 400 }],
        contentRect: { height },
      } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

beforeAll(() => {
  stubClientSizes({ 'lc-fa-list': { width: 500, height: LIST_HEIGHT } })
})

afterAll(() => {
  vi.unstubAllGlobals()
  restoreLayout()
})

function entry(index: number): FileEntry {
  const op: FileOp = { seq: index, kind: 'read', tool: 'read', time: T0 + index, err: false, added: 0, removed: 0, path: '' }
  return { path: `/src/file-${String(index).padStart(3, '0')}.ts`, form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0, ops: [op] }
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

const props = { activity: activityOf(60), state: 'ready' as const, onRetry: undefined }

async function measureRows(height = MEASURED): Promise<void> {
  const observer = ControlledResizeObserver.rowObserver()
  for (const target of [...observer.targets]) {
    await act(async () => { observer.settle(height, target) })
  }
}

function activeRowTitle(): string | null {
  const active = document.activeElement
  if (!(active instanceof Element)) return null
  return active.closest<HTMLElement>('.lc-fa-row')?.getAttribute('title') ?? null
}

describe('FileCard row windowing', () => {
  test('never mounts the full list: the measured window keeps viewport-bound rows and full-height pads', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    try {
      const m = await mount(h(FileCard, props))
      const list = query<HTMLElement>(m.container, '.lc-fa-list')
      assert.equal(list.clientHeight, LIST_HEIGHT)
      const initial = queryAll(m.container, '.lc-fa-slot').length
      assert.ok(initial < 60, `bounded first paint (${initial})`)
      assert.ok(initial >= 8, 'a window wide enough to scroll through')
      await measureRows()
      const afterMeasure = queryAll(m.container, '.lc-fa-slot').length
      assert.ok(afterMeasure < 60, `bounded after measuring (${afterMeasure})`)
      const headPads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(headPads.length, 1, 'the first window keeps only a bottom pad')
      assert.ok(Number.parseFloat(headPads[0].style.height) > 0)
      list.scrollTop = 900
      await act(async () => { list.dispatchEvent(new Event('scroll')) })
      await settle(20)
      const titles = queryAll<HTMLElement>(m.container, '.lc-fa-row').map(row => row.title)
      assert.ok(titles.length < 60, 'scrolled window stays bounded')
      assert.equal(titles[0], '/src/file-015.ts', 'the measured window starts at the row reaching the viewport top')
      assert.equal(titles.at(-1), '/src/file-040.ts', 'the window ends at the row covering the viewport bottom plus overscan')
      assert.equal(titles.length, new Set(titles).size)
      assert.equal(titles.length, 26)
      const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(topPad.style.height, '645px')
      assert.equal(bottomPad.style.height, '570px')
      await fireScroll(list)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('mixed wrapped heights keep the window and its pads truthful instead of falling back to the full list', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    try {
      const m = await mount(h(FileCard, props))
      const observer = ControlledResizeObserver.rowObserver()
      for (const target of [...observer.targets]) {
        const slots = queryAll(m.container, '.lc-fa-slot')
        const index = slots.indexOf(target as HTMLElement)
        await act(async () => { observer.settle(MEASURED + (index % 3 === 0 ? 40 : 0), target) })
      }
      assert.ok(queryAll(m.container, '.lc-fa-slot').length < 60, 'mixed heights stay windowed')
      assert.ok(queryAll(m.container, '.lc-row-pad').length <= 2)
      const heights = queryAll<HTMLElement>(m.container, '.lc-row-pad').map(pad => pad.style.height)
      assert.ok(heights.every(height => Number.parseFloat(height) > 0))
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('an expanded row is measured in place while the rest of the list stays windowed', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    try {
      const m = await mount(h(FileCard, props))
      await measureRows()
      const toggle = query<HTMLElement>(m.container, '.lc-fa-toggle')
      assert.equal(toggle.getAttribute('aria-expanded'), 'false')
      assert.ok((toggle.getAttribute('aria-label') ?? '').length > 0)
      await act(async () => { toggle.click() })
      assert.ok(query(m.container, '.lc-fa-ops') !== null, 'the row expands')
      assert.equal(query<HTMLElement>(m.container, '.lc-fa-toggle').getAttribute('aria-expanded'), 'true')
      assert.ok(queryAll(m.container, '.lc-fa-slot').length < 60, 'the expanded row keeps the list windowed')
      const observer = ControlledResizeObserver.rowObserver()
      const expanded = observer.targets.find(target => (target as HTMLElement).querySelector('.lc-fa-ops') !== null)
      assert.ok(expanded !== undefined, 'the expanded slot is observed')
      await act(async () => { observer.settle(240, expanded) })
      assert.ok(queryAll(m.container, '.lc-fa-slot').length < 60, 'a tall expanded row does not expand the window')
      await act(async () => { query<HTMLElement>(m.container, '.lc-fa-toggle').click() })
      assert.ok(queryAll(m.container, '.lc-fa-slot').length < 60, 'closing keeps the window')
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('entries without operations still sort and window without a pitch source', async () => {
    const bare: FileActivity = {
      entries: [
        { path: '/src/a.ts', form: 'text', reads: 0, writes: 0, searches: 0, added: 0, removed: 0, ops: [] },
        { path: '/src/b.ts', form: 'text', reads: 0, writes: 0, searches: 0, added: 0, removed: 0, ops: [] },
        {
          path: '/src/c.ts', form: 'text', reads: 1, writes: 0, searches: 0, added: 0, removed: 0,
          ops: [{ seq: 5, kind: 'read', tool: 'read', time: T0, err: false, added: 0, removed: 0, path: '' }],
        },
      ],
      totals: {
        read: { files: 0, ops: 0 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 },
        added: 0, removed: 0,
      },
    }
    const m = await mount(h(FileCard, { activity: bare, state: 'ready' as const }))
    try {
      const latest = queryAll<HTMLElement>(m.container, '.lc-fa-sort .lc-gran-btn')
        .find(button => text(button) === kit.t('files.sort.latest'))
      assert.ok(latest !== undefined)
      await click(latest)
      assert.equal(queryAll(m.container, '.lc-fa-slot').length, 3)
      assert.ok(text(query(m.container, '.lc-fa-meta')).includes('3 files'))
    } finally {
      await m.unmount()
    }
  })

  test('a narrow pane and a filtered model keep the DOM bounded while counts still come from the full model', async () => {
    stubClientSizes({ 'lc-fa-list': { width: 300, height: LIST_HEIGHT } })
    try {
      const m = await mount(h(FileCard, { activity: activityOf(200), state: 'ready' as const }))
      const rendered = queryAll(m.container, '.lc-fa-slot').length
      assert.ok(rendered < 200, `narrow pane bounded (${rendered})`)
      assert.ok(text(query(m.container, '.lc-fa-meta')).includes('200 files'), 'the header counts the full model')
      await m.unmount()
    } finally {
      stubClientSizes({ 'lc-fa-list': { width: 500, height: LIST_HEIGHT } })
    }
  })

  test('Arrow/Home/End traverse the whole list with one roving tab stop and real buttons for actions', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    const previewed: string[] = []
    try {
      const m = await mount(h(FileCard, { ...props, onPreview: (e) => { previewed.push(e.path); return true } }))
      await measureRows()
      const roving = queryAll<HTMLElement>(m.container, '.lc-fa-toggle').filter(toggle => toggle.tabIndex === 0)
      assert.equal(roving.length, 1, 'one tab stop for the row enumeration')
      roving[0].focus()
      roving[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await until(() => activeRowTitle() === '/src/file-059.ts', 'End reaches and focuses the oldest row')
      const tabStops = queryAll<HTMLElement>(m.container, '.lc-fa-toggle').filter(toggle => toggle.tabIndex === 0)
      assert.equal(tabStops.length, 1, 'a single tab stop follows the active row')
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await until(() => activeRowTitle() === '/src/file-000.ts', 'Home returns focus to the first row')
      await settle(10)
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await until(() => activeRowTitle() === '/src/file-001.ts', 'ArrowDown moves one row')
      const action = query<HTMLElement>(m.container, '.lc-fa-file')
      assert.equal(action.tagName, 'BUTTON')
      assert.ok((action.getAttribute('aria-label') ?? '').length > 0, 'the file action has a label')
      await act(async () => { action.click() })
      assert.deepEqual(previewed, ['/src/file-000.ts'])
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
