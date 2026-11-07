import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { click, fireScroll, makeKit, mount, query, queryAll, settle, text, until } from '../helpers/kit'
import { restoreLayout, stubClientSizes, stubResizeObserver, stubRowRects } from '../helpers/layout'

const kit = makeKit()
const FileCard = makeFileCard(kit, createContextSettings())

const PITCH = 41
const GAP = 2
const T0 = 1700000000000
let wrapRows = false

beforeAll(() => {
  stubResizeObserver()
  stubClientSizes({ 'lc-fa-list': { width: 500, height: 320 } })
  stubRowRects('lc-fa-item', index => (wrapRows && index % 7 === 0 ? PITCH + 20 : PITCH) - GAP, GAP)
})

afterAll(() => {
  vi.unstubAllGlobals()
  restoreLayout()
})

function rowIndexes(container: ParentNode): number[] {
  return queryAll(container, '.lc-fa-row').map(row => Number(/file-(\d+)/.exec(text(row))?.[1] ?? '-1'))
}

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

describe('FileCard row windowing', () => {
  test('renders a measured window with full-height pads and follows the scroll', async () => {
    const m = await mount(h(FileCard, props))
    const list = query<HTMLElement>(m.container, '.lc-fa-list')
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'the list windows after measuring')
    const rendered = queryAll(m.container, '.lc-fa-item').length
    assert.ok(rendered < 60 && rendered > 8)
    const pads = queryAll<HTMLElement>(m.container, '.lc-row-pad')
    assert.equal(pads.length, 1)
    assert.ok(Number.parseFloat(pads[0].style.height) > 0)
    assert.equal(list.clientHeight, 320)
    list.scrollTop = 900
    await settle(40)
    await fireScroll(list)
    await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
    const mid = rowIndexes(m.container)
    assert.ok(mid.length < 60 && mid.length >= 8)
    assert.ok(mid[0] * PITCH <= 900, 'the first rendered row reaches the viewport top')
    assert.ok(mid[mid.length - 1] * PITCH + PITCH >= 900 + 320, 'the last rendered row covers the viewport bottom')
    assert.equal(mid.length, mid[mid.length - 1] - mid[0] + 1, 'the rendered window is contiguous')
    const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
    assert.equal(topPad.style.height, `${mid[0] * PITCH - GAP}px`)
    assert.equal(bottomPad.style.height, `${(59 - mid[mid.length - 1]) * PITCH - GAP}px`)
    await m.unmount()
  })

  test('mixed wrapped row heights keep the full list so the scroll geometry stays truthful', async () => {
    wrapRows = true
    const m = await mount(h(FileCard, props))
    try {
      await until(() => queryAll(m.container, '.lc-fa-item').length === 60, 'the full list renders')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0, 'no spacers on a non-uniform list')
    } finally {
      wrapRows = false
      await m.unmount()
    }
  })

  test('an expanded row falls back to the full list, then windows again when closed', async () => {
    const m = await mount(h(FileCard, props))
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'windowed')
    const first = query<HTMLElement>(m.container, '.lc-fa-row')
    await click(first)
    await until(() => queryAll(m.container, '.lc-fa-item').length === 60, 'expanded row shows the full list')
    await click(first)
    await until(() => queryAll(m.container, '.lc-fa-item').length < 60, 'closing the row re-windows')
    await m.unmount()
  })
})
