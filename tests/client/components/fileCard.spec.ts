// FileCard (src/client/components/fileCard.tsx) rendered with real React:
// purpose/form filter chips, path search, per-file rows with count badges
// and line deltas, expandable operation logs, and the op-level locate hook.

import assert from 'node:assert/strict'
import { act } from 'react'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { makeKit, mount, query, queryAll, text, click } from '../helpers/kit'

const kit = makeKit()
const settings = createContextSettings()
const FileCard = makeFileCard(kit, settings)

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
        ops: Array.from({ length: 9 }, (_, i) => fileOp(28 - i, 'read', 'read')),
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

function rowByTitle(container: ParentNode, title: string): HTMLElement {
  const hit = queryAll(container, '.lc-fa-row').find(r => r.title === title)
  if (hit === undefined) throw new Error(`row not found: ${title}`)
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
    // Default order is most-active first: many.log (9 ops) → a.ts (4) → the one-op files by recency.
    assert.deepEqual(rows.map(r => r.title), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    // Path split: muted dir + bold base; every badge and the row delta.
    const first = rows[0]
    assert.ok(first.querySelector('.lc-fa-path em')?.textContent === '/var/')
    assert.ok(first.querySelector('.lc-fa-path b')?.textContent === 'many.log')
    assert.ok(text(first).includes('9')) // read ×9 badge
    assert.equal(queryAll(first, '.lc-fa-badge').length, 1) // read only
    assert.ok(first.querySelector('.lc-fa-time') !== null)
    const aRow = rowByTitle(m.container, '/src/a.ts')
    assert.ok(aRow.querySelector('.lc-fa-path em')?.textContent === '/src/')
    assert.ok(aRow.querySelector('.lc-fa-path b')?.textContent === 'a.ts')
    assert.equal(queryAll(aRow, '.lc-fa-badge').length, 2) // read + write
    assert.ok(text(aRow).includes('+2') && text(aRow).includes('−3'))
    assert.ok(aRow.querySelector('.lc-br-err-dot') !== null)
    assert.ok(aRow.title === '/src/a.ts')
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

    // Kind chips always carry their badge-color class; the neutral chips don't.
    assert.ok(chipByLabel(m.container, 'Read').className.includes('lc-fa-chip-read'))
    assert.ok(chipByLabel(m.container, 'Written').className.includes('lc-fa-chip-write'))
    assert.ok(chipByLabel(m.container, 'Searched').className.includes('lc-fa-chip-search'))
    assert.ok(!chipByLabel(m.container, 'All').className.includes('lc-fa-chip-'))
    assert.ok(!chipByLabel(m.container, 'Images').className.includes('lc-fa-chip-'))

    await click(chipByLabel(m.container, 'Written'))
    assert.ok(chipByLabel(m.container, 'Written').className.includes('lc-gran-on'))
    assert.deepEqual(paths(), ['/src/a.ts', 'solo.md'])
    await click(chipByLabel(m.container, 'Searched'))
    assert.deepEqual(paths(), ['/src/'])
    await click(chipByLabel(m.container, 'Images'))
    assert.deepEqual(paths(), ['/shots/ui.png'])
    await click(chipByLabel(m.container, 'Read'))
    assert.deepEqual(paths(), ['/var/many.log', '/src/a.ts', '/shots/ui.png'])
    await click(chipByLabel(m.container, 'Read'))
    assert.equal(paths().length, 5)
    await m.unmount()
  })

  test('the count sort keys on the selected kind once a kind chip is active', async () => {
    // x.log is op-heavy overall (6 ops) but read-light (1); y.ts is read-heavy (2 of 2 ops);
    // idx.md and pat.txt split the search counts 3 vs 1.
    const activity: FileActivity = {
      entries: [
        entry('/logs/x.log', {
          reads: 1,
          writes: 5,
          ops: [
            fileOp(6, 'write', 'edit'),
            fileOp(5, 'write', 'edit'),
            fileOp(4, 'write', 'edit'),
            fileOp(3, 'write', 'edit'),
            fileOp(2, 'write', 'edit'),
            fileOp(1, 'read', 'read'),
          ],
        }),
        entry('/code/y.ts', { reads: 2, ops: [fileOp(8, 'read', 'read'), fileOp(7, 'read', 'read')] }),
        entry('/src/idx.md', {
          searches: 3,
          ops: [fileOp(11, 'search', 'glob'), fileOp(10, 'search', 'grep'), fileOp(9, 'search', 'grep')],
        }),
        entry('/src/pat.txt', { searches: 1, ops: [fileOp(12, 'search', 'grep')] }),
      ],
      totals: {
        read: { files: 2, ops: 3 },
        write: { files: 1, ops: 5 },
        search: { files: 2, ops: 4 },
        image: { files: 0, ops: 0 },
        added: 0,
        removed: 0,
      },
      unresolved: 0,
    }
    const m = await mount(h(FileCard, { activity, scope: 'live' }))
    const titles = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)
    // 'count' over everything: total ops lead.
    assert.deepEqual(titles(), ['/logs/x.log', '/src/idx.md', '/code/y.ts', '/src/pat.txt'])
    // The read chip narrows AND the count sort re-keys on reads: 2 reads beat 1.
    await click(chipByLabel(m.container, 'Read'))
    assert.deepEqual(titles(), ['/code/y.ts', '/logs/x.log'])
    // The write chip leaves the one write-heavy file, still write-keyed.
    await click(chipByLabel(m.container, 'Written'))
    assert.deepEqual(titles(), ['/logs/x.log'])
    // The search chip re-keys on searches: 3 beat 1.
    await click(chipByLabel(m.container, 'Searched'))
    assert.deepEqual(titles(), ['/src/idx.md', '/src/pat.txt'])
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

  test('the sort toggle defaults to most-active and switches to latest and path', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    const titles = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)
    const sortBtns = queryAll(m.container, '.lc-fa-sort .lc-gran-btn')
    assert.equal(sortBtns.length, 3)
    // Count order by default: 9 ops → 4 ops → one-op files by recency.
    assert.ok(sortBtns[0].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    // Latest order: many.log (seq 28) → ui.png (9) → solo.md (8) → a.ts (7) → /src/ (6).
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/var/many.log', '/shots/ui.png', 'solo.md', '/src/a.ts', '/src/'])
    // Path order: ascending over full paths (the dir row precedes its children).
    await click(sortBtns[2])
    assert.ok(sortBtns[2].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/shots/ui.png', '/src/', '/src/a.ts', '/var/many.log', 'solo.md'])
    await click(sortBtns[0])
    assert.ok(sortBtns[0].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    await m.unmount()
  })

  test('the mount-time default sort comes from the plugin settings', async () => {
    const titles = (container: ParentNode) => queryAll(container, '.lc-fa-row').map(r => r.title)
    const sortBtns = (container: ParentNode) => queryAll(container, '.lc-fa-sort .lc-gran-btn')

    settings.set('defaultFileSort', 'latest')
    let m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    assert.ok(sortBtns(m.container)[1].className.includes('lc-gran-on'))
    assert.deepEqual(titles(m.container), ['/var/many.log', '/shots/ui.png', 'solo.md', '/src/a.ts', '/src/'])
    await m.unmount()

    settings.set('defaultFileSort', 'path')
    m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    assert.ok(sortBtns(m.container)[2].className.includes('lc-gran-on'))
    assert.deepEqual(titles(m.container), ['/shots/ui.png', '/src/', '/src/a.ts', '/var/many.log', 'solo.md'])
    await m.unmount()

    // The stored preference resets the default; in-card toggling never writes back.
    settings.set('defaultFileSort', 'count')
    m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    assert.ok(sortBtns(m.container)[0].className.includes('lc-gran-on'))
    assert.deepEqual(titles(m.container), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    await click(sortBtns(m.container)[1])
    assert.deepEqual(settings.store.getSnapshot().fileSort, 'count')
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
    const row = rowByTitle(m.container, '/src/a.ts')
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
    await click(rowByTitle(m.container, '/src/a.ts'))
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 0)
    await m.unmount()
  })

  test('a search op shows its pattern detail; the log caps at eight with an overflow line', async () => {
    const m = await mount(h(FileCard, { activity: richActivity(), scope: 'live' }))
    // The directory row: one grep op with its searched pattern.
    await click(rowByTitle(m.container, '/src/'))
    assert.ok(text(query(m.container, '.lc-fa-ops')).includes('needle'))
    // The nine-read log renders eight rows plus the "+1 earlier ops" line
    // (one expanded file at a time: this click collapsed the directory row).
    await click(rowByTitle(m.container, '/var/many.log'))
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
