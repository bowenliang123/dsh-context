// FileCard (src/client/components/fileCard.tsx) rendered with real React:
// purpose/form filter chips, path search, per-file rows with count badges
// and line deltas, expandable operation logs, and the op-level locate hook.

import assert from 'node:assert/strict'
import { act } from 'react'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { makeKit, mount, query, queryAll, text, click } from '../helpers/kit'

const kit = makeKit()
const FileCard = makeFileCard(kit)

const T0 = 1700000000000

function fileOp(seq: number, kind: FileOp['kind'], tool: string, over: Partial<FileOp> = {}): FileOp {
  return { seq, kind, tool, time: T0 + seq, err: false, added: 0, removed: 0, ...over }
}

function entry(path: string, over: Partial<FileEntry>): FileEntry {
  return { path, form: 'text', reads: 0, writes: 0, searches: 0, added: 0, removed: 0, errs: 0, ops: [], ...over }
}

/** Five files exercising every row anatomy: split paths, all badges, deltas both ways, failures, a directory, an image. */
function richActivity(over: Partial<FileActivity> = {}): FileActivity {
  return {
    entries: [
      entry('/src/a.ts', {
        reads: 2,
        writes: 2,
        added: 2,
        removed: 3,
        errs: 1,
        ops: [
          fileOp(7, 'read', 'read'),
          fileOp(5, 'write', 'edit', { added: 2, removed: 1 }),
          fileOp(4, 'write', 'edit', { removed: 2, err: true }),
          fileOp(3, 'read', 'read', { time: undefined }),
        ],
      }),
      entry('/shots/ui.png', { form: 'image', reads: 1, ops: [fileOp(9, 'read', 'read_image')] }),
      entry('/src/', { form: 'dir', searches: 1, ops: [fileOp(6, 'search', 'grep', { detail: 'needle' })] }),
      entry('solo.md', { writes: 1, added: 5, ops: [fileOp(8, 'write', 'write', { added: 5, time: undefined })] }),
      entry('/var/many.log', {
        reads: 9,
        ops: Array.from({ length: 9 }, (_, i) => fileOp(20 + i, 'read', 'read')),
      }),
    ],
    totals: {
      read: { files: 3, ops: 12 },
      write: { files: 2, ops: 3 },
      search: { files: 1, ops: 1 },
      image: { files: 1, ops: 1 },
      added: 7,
      removed: 3,
    },
    unresolved: 0,
    ...over,
  }
}

function chipByLabel(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, '.lc-fa-ctl .lc-gran-btn').find(b => text(b).startsWith(label))
  if (hit === undefined) throw new Error(`chip not found: ${label}`)
  return hit
}

async function typeSearch(container: ParentNode, value: string): Promise<void> {
  const input = query<HTMLInputElement>(container, 'input.lc-fa-search')
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

describe('FileCard — empty and unresolved states', () => {
  test('no file ops renders the empty state without controls', async () => {
    const m = await mount(h(FileCard, {
      activity: richActivity({ entries: [], unresolved: 0 }),
      scope: 'Turn 1 · Step 1',
    }))
    assert.ok(text(m.container).includes('No file reads, writes, or searches'))
    assert.ok(text(m.container).includes('Turn 1 · Step 1'))
    assert.equal(queryAll(m.container, '.lc-fa-ctl').length, 0)
    assert.equal(queryAll(m.container, '.lc-fa-note').length, 0)
    await m.unmount()
  })

  test('ops whose paths aged out show only the unresolved note', async () => {
    const m = await mount(h(FileCard, {
      activity: richActivity({ entries: [], unresolved: 2 }),
      scope: 'live',
    }))
    assert.ok(text(m.container).includes('2 more file ops have paths outside the retained window'))
    await m.unmount()
  })
})

describe('FileCard — header, rows, and filters', () => {
  test('renders chips with op counts, the meta strip, and fully-dressed rows', async () => {
    const m = await mount(h(FileCard, { activity: richActivity({ unresolved: 1 }), scope: 'Up to latest' }))
    // Chip op counts: all = 12 + 3 + 1.
    assert.ok(text(chipByLabel(m.container, 'All')).includes('16'))
    assert.ok(text(chipByLabel(m.container, 'Read')).includes('12'))
    assert.ok(text(chipByLabel(m.container, 'Images')).includes('1'))
    // Meta strip: file count + aggregate delta (+7 −3).
    const meta = query(m.container, '.lc-fa-meta')
    assert.ok(text(meta).includes('5 files'))
    assert.ok(text(meta).includes('+7'))
    assert.ok(text(meta).includes('−3'))
    assert.ok(query(meta, '.lc-fa-meta-tip').textContent?.includes('estimated') === true)

    const rows = queryAll(m.container, '.lc-fa-row')
    assert.equal(rows.length, 5)
    const first = text(rows[0])
    // Path split: muted dir + bold base; every badge and the row delta.
    assert.ok(rows[0].querySelector('.lc-fa-path em')?.textContent === '/src/')
    assert.ok(rows[0].querySelector('.lc-fa-path b')?.textContent === 'a.ts')
    assert.ok(first.includes('2')) // read ×2 badge
    assert.equal(queryAll(rows[0], '.lc-fa-badge').length, 2) // read + write
    assert.ok(first.includes('+2') && first.includes('−3'))
    assert.ok(rows[0].querySelector('.lc-br-err-dot') !== null)
    assert.ok(rows[0].querySelector('.lc-fa-time') !== null)
    assert.equal(rows[0].title, '/src/a.ts')
    // The directory row trims its trailing slash for display.
    const dirRow = rows.find(r => r.title === '/src/')
    assert.ok(dirRow !== undefined)
    assert.ok(dirRow.querySelector('.lc-fa-path b')?.textContent === 'src')
    // The extension-less row carries no dir span and no badges beyond its own kind.
    const solo = rows.find(r => r.title === 'solo.md')
    assert.ok(solo !== undefined)
    assert.equal(solo.querySelector('.lc-fa-path em'), null)
    assert.ok(text(solo).includes('+5') && !text(solo).includes('−'))
    // solo.md's only op is timeless: the row drops its time cell.
    assert.ok(solo.querySelector('.lc-fa-time') === null)
    // The unresolved footnote rides below the list.
    assert.ok(text(m.container).includes('1 more file op'))
    await m.unmount()
  })

  test('purpose and form chips isolate rows; re-clicking restores all', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    const paths = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)

    await click(chipByLabel(m.container, 'Written'))
    assert.deepEqual(paths(), ['/src/a.ts', 'solo.md'])
    await click(chipByLabel(m.container, 'Searched'))
    assert.deepEqual(paths(), ['/src/'])
    await click(chipByLabel(m.container, 'Images'))
    assert.deepEqual(paths(), ['/shots/ui.png'])
    await click(chipByLabel(m.container, 'Read'))
    assert.deepEqual(paths(), ['/src/a.ts', '/shots/ui.png', '/var/many.log'])
    await click(chipByLabel(m.container, 'Read'))
    assert.equal(paths().length, 5)
    await m.unmount()
  })

  test('path search narrows rows and reports no matches', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    await typeSearch(m.container, 'A.TS')
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/src/a.ts'])
    await typeSearch(m.container, 'zzz')
    assert.equal(queryAll(m.container, '.lc-fa-row').length, 0)
    assert.ok(text(m.container).includes('No files match the current filters'))
    await typeSearch(m.container, '')
    assert.equal(queryAll(m.container, '.lc-fa-row').length, 5)
    await m.unmount()
  })
})

describe('FileCard — expansion and locate', () => {
  test('a row click expands its op log; an op click locates it; re-click collapses', async () => {
    const located: number[] = []
    const m = await mount(h(FileCard, {
      activity: richActivity(),
      scope: 'live',
      onLocate: op => { located.push(op.seq) },
    }))
    const row = queryAll(m.container, '.lc-fa-row')[0]
    await click(row)
    const ops = queryAll(m.container, '.lc-fa-op')
    assert.equal(ops.length, 4)
    // Op anatomy: time, tool chip, per-op delta, failure dot, and the timeless op's dash.
    assert.ok(text(ops[0]).includes('read'))
    assert.ok(ops[0].className.includes('lc-fa-op-link'))
    assert.ok(text(ops[1]).includes('+2') && text(ops[1]).includes('−1'))
    assert.ok(text(ops[2]).includes('−2') && !text(ops[2]).includes('+'))
    assert.ok(ops[2].querySelector('.lc-br-err-dot') !== null)
    assert.ok(text(ops[3]).includes('—'))
    // The op click jumps — and does not collapse the row (no bubbling).
    await click(ops[1])
    assert.deepEqual(located, [5])
    assert.ok(query(m.container, '.lc-fa-ops') !== null)
    await click(queryAll(m.container, '.lc-fa-row')[0])
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 0)
    await m.unmount()
  })

  test('a search op shows its pattern detail; the log caps at eight with an overflow line', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    // The directory row: one grep op with its searched pattern.
    await click(queryAll(m.container, '.lc-fa-row')[2])
    assert.ok(text(query(m.container, '.lc-fa-ops')).includes('needle'))
    // The nine-read log renders eight rows plus the "+1 earlier ops" line
    // (one expanded file at a time: this click collapsed the directory row).
    await click(queryAll(m.container, '.lc-fa-row')[4])
    const many = query(m.container, '.lc-fa-ops')
    assert.equal(queryAll(many, '.lc-fa-op').length, 8)
    assert.ok(text(many).includes('+1 earlier ops'))
    await m.unmount()
  })

  test('without a locate hook the op lines render inert', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    await click(queryAll(m.container, '.lc-fa-row')[0])
    assert.equal(queryAll(m.container, 'button.lc-fa-op').length, 0)
    assert.ok(queryAll(m.container, 'div.lc-fa-op').length > 0)
    await m.unmount()
  })

  test('no line activity anywhere drops the aggregate delta pill', async () => {
    const m = await mount(h(FileCard, {
      activity: richActivity({
        entries: [entry('/a.ts', { reads: 1, ops: [fileOp(1, 'read', 'read')] })],
        totals: { read: { files: 1, ops: 1 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
      }),
      scope: 'live',
    }))
    assert.equal(queryAll(m.container, '.lc-fa-meta-delta').length, 0)
    await m.unmount()
  })
})
