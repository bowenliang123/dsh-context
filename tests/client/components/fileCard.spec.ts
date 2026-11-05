import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeFileCard } from '../../../src/client/components/fileCard'
import type { FileFilter } from '../../../src/client/components/fileCard'
import type { FileActivity, FileEntry, FileOp } from '../../../src/client/fileActivity'
import { createContextSettings } from '../../../src/client/settings'
import { makeKit, mount, query, queryAll, text, click } from '../helpers/kit'

const kit = makeKit()
const settings = createContextSettings()
const FileCard = makeFileCard(kit, settings)

const T0 = 1700000000000

function fileOp(seq: number, kind: FileOp['kind'], tool: string, over: Partial<FileOp> = {}): FileOp {
  return { seq, kind, tool, time: T0 + seq, err: false, added: 0, removed: 0, path: '', ...over }
}

function entry(path: string, over: Partial<FileEntry>): FileEntry {
  return { path, form: 'text', reads: 0, writes: 0, searches: 0, added: 0, removed: 0, ops: [], ...over }
}

function richActivity(over: Partial<FileActivity> = {}): FileActivity {
  return {
    entries: [
      entry('/src/a.ts', {
        reads: 2,
        writes: 2,
        added: 2,
        removed: 3,
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
    ...over,
  }
}

function chipByLabel(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, '.lc-fa-chips .lc-gran-btn').find(b => text(b).startsWith(label))
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

describe('FileCard — empty state', () => {
  test('no file ops keeps the controls so the card measures the same as a populated one', async () => {
    const m = await mount(h(FileCard, { activity: richActivity({ entries: [] }), }))
    assert.ok(text(m.container).includes('No file reads, writes, or searches'))
    assert.equal(queryAll(m.container, '.lc-card-title .lc-fa-chips').length, 1)
    assert.equal(queryAll(m.container, '.lc-fa-ctl').length, 1)
    assert.equal(queryAll(m.container, '.lc-fa-meta').length, 1)
    assert.equal(queryAll(m.container, '.lc-lane').length, 1)
    assert.equal(queryAll(m.container, '.lc-fa-list').length, 0)
    await m.unmount()
  })
})

describe('FileCard — header, rows, and filters', () => {
  test('renders chips with op counts, the meta strip, and fully-dressed rows', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    assert.ok(text(chipByLabel(m.container, 'All')).includes('16'))
    assert.ok(text(chipByLabel(m.container, 'Read')).includes('12'))
    assert.ok(text(chipByLabel(m.container, 'Images')).includes('1'))
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    assert.equal(queryAll(m.container, '.lc-card-title .lc-fa-meta').length, 1)
    assert.equal(queryAll(m.container, '.lc-card-title .lc-fa-chips .lc-gran-btn').length, 5)
    assert.ok(query(m.container, '.lc-fa-ctl input.lc-fa-search') !== null)
    assert.equal(queryAll(m.container, '.lc-fa-ctl .lc-fa-sort .lc-gran-btn').length, 5)
    assert.equal(queryAll(m.container, '.lc-fa-meta .lc-fa-sort').length, 0)
    const meta = query(m.container, '.lc-fa-meta')
    assert.ok(text(meta).includes('5 files'))
    assert.ok(text(meta).includes('+7'))
    assert.ok(text(meta).includes('−3'))
    assert.ok(query(meta, '.lc-fa-meta-tip').textContent?.includes('estimated') === true)

    const rows = queryAll(m.container, '.lc-fa-row')
    assert.equal(rows.length, 5)
    assert.deepEqual(rows.map(r => r.title), ['/src/a.ts', 'solo.md', '/shots/ui.png', '/src/', '/var/many.log'])
    const logRow = rowByTitle(m.container, '/var/many.log')
    assert.ok(logRow.querySelector('.lc-fa-path em')?.textContent === '/var/')
    assert.ok(logRow.querySelector('.lc-fa-path b')?.textContent === 'many.log')
    assert.ok(text(logRow).includes('9'))
    assert.equal(queryAll(logRow, '.lc-fa-badge').length, 1)
    assert.ok(logRow.querySelector('.lc-fa-time') !== null)
    const aRow = rowByTitle(m.container, '/src/a.ts')
    assert.ok(aRow.querySelector('.lc-fa-path em')?.textContent === '/src/')
    assert.ok(aRow.querySelector('.lc-fa-path b')?.textContent === 'a.ts')
    assert.equal(queryAll(aRow, '.lc-fa-badge').length, 2)
    assert.ok(text(aRow).includes('+2') && text(aRow).includes('−3'))
    assert.equal(queryAll(aRow, '.lc-br-err-dot').length, 0)
    assert.ok(aRow.title === '/src/a.ts')
    const dirRow = rows.find(r => r.title === '/src/')
    assert.ok(dirRow !== undefined)
    assert.ok(dirRow.querySelector('.lc-fa-path b')?.textContent === 'src')
    const solo = rows.find(r => r.title === 'solo.md')
    assert.ok(solo !== undefined)
    assert.ok(solo.querySelector('.lc-fa-path em')?.textContent === './')
    assert.ok(solo.querySelector('.lc-fa-path b')?.textContent === 'solo.md')
    assert.ok(text(solo).includes('+5') && !text(solo).includes('−'))
    assert.ok(solo.querySelector('.lc-fa-time') === null)
    await m.unmount()

    const langs = await mount(h(FileCard, {
      activity: richActivity({
        entries: [
          entry('/src/main.ts', { reads: 1, ops: [fileOp(9, 'read', 'read')] }),
          entry('/notes.md', { reads: 1, ops: [fileOp(8, 'read', 'read')] }),
        ],
        totals: { read: { files: 2, ops: 2 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
      }),
    }))
    const tsRow = rowByTitle(langs.container, '/src/main.ts')
    const badge = query(tsRow, '.lc-fa-lang')
    assert.equal(badge.textContent, 'TS')
    assert.equal(query(tsRow, '.lc-fa-form').getAttribute('title'), 'TypeScript')
    const style = badge.getAttribute('style') ?? ''
    assert.ok(style.includes('background: rgb(49, 120, 198)'), style)
    const mdRow = rowByTitle(langs.container, '/notes.md')
    assert.equal(queryAll(mdRow, '.lc-fa-lang').length, 0)
    assert.ok(text(mdRow).includes('📝'), 'an emoji file keeps its glyph')
    assert.equal(query(mdRow, '.lc-fa-form').getAttribute('title'), 'Markup document')
    await langs.unmount()
  })

  test('purpose and form chips isolate rows; re-clicking restores all', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    const paths = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)

    assert.ok(chipByLabel(m.container, 'Read').className.includes('lc-fa-chip-read'))
    assert.ok(chipByLabel(m.container, 'Written').className.includes('lc-fa-chip-write'))
    assert.ok(chipByLabel(m.container, 'Searched').className.includes('lc-fa-chip-search'))
    assert.ok(chipByLabel(m.container, 'All').className.includes('lc-fa-chip-all'))
    assert.ok(!chipByLabel(m.container, 'Images').className.includes('lc-fa-chip-'))

    await click(chipByLabel(m.container, 'Written'))
    assert.ok(chipByLabel(m.container, 'Written').className.includes('lc-gran-on'))
    assert.deepEqual(paths(), ['/src/a.ts', 'solo.md'])
    await click(chipByLabel(m.container, 'Searched'))
    assert.deepEqual(paths(), ['/src/'])
    await click(chipByLabel(m.container, 'Images'))
    assert.deepEqual(paths(), ['/shots/ui.png'])
    await click(chipByLabel(m.container, 'Read'))
    assert.deepEqual(paths(), ['/src/a.ts', '/shots/ui.png', '/var/many.log'])
    await click(chipByLabel(m.container, 'Read'))
    assert.equal(paths().length, 5)
    await typeSearch(m.container, 'A.TS')
    assert.deepEqual(paths(), ['/src/a.ts'], 'the path search narrows the list, case-insensitively')
    await typeSearch(m.container, 'zzz')
    assert.equal(paths().length, 0)
    assert.ok(text(m.container).includes('No files match the current filters'))
    await typeSearch(m.container, '')
    assert.equal(paths().length, 5)
    await m.unmount()
  })

  test('the title tallies follow both lenses while the chip counts follow the path lens', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    const meta = (): string => text(query(m.container, '.lc-fa-meta'))
    const count = (label: string): string | null => query(chipByLabel(m.container, label), '.lc-fa-n').textContent

    await typeSearch(m.container, 'a.ts')
    assert.match(meta(), /\b1 file\b/, 'the singular label carries the matched count')
    assert.ok(meta().includes('+2') && meta().includes('−3'), 'the delta sums the matched file only')
    assert.equal(count('All'), '4')
    assert.equal(count('Read'), '2')
    assert.equal(count('Written'), '2')
    assert.equal(count('Searched'), '0')
    assert.equal(count('Images'), '0')

    await typeSearch(m.container, 'zzz')
    assert.match(meta(), /\b0 files\b/)
    assert.equal(queryAll(m.container, '.lc-fa-meta-delta').length, 0)
    assert.deepEqual(
      ['All', 'Read', 'Written', 'Searched', 'Images'].map(count),
      ['0', '0', '0', '0', '0'],
    )

    await typeSearch(m.container, '')
    assert.match(meta(), /\b5 files\b/)
    assert.equal(count('All'), '16')
    await click(chipByLabel(m.container, 'Searched'))
    assert.match(meta(), /\b1 file\b/, 'the kind chip narrows the title tally too')
    assert.equal(queryAll(m.container, '.lc-fa-meta-delta').length, 0)
    assert.equal(count('All'), '16', 'the chips keep tallying the path lens, not their own kind')
    await m.unmount()
  })

  test('the count sort keys on the selected kind once a kind chip is active', async () => {
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
    }
    const m = await mount(h(FileCard, { activity }))
    await click(queryAll(m.container, '.lc-fa-sort .lc-gran-btn')[0])
    const titles = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)
    assert.deepEqual(titles(), ['/logs/x.log', '/src/idx.md', '/code/y.ts', '/src/pat.txt'])
    await click(chipByLabel(m.container, 'Read'))
    assert.deepEqual(titles(), ['/code/y.ts', '/logs/x.log'])
    await click(chipByLabel(m.container, 'Written'))
    assert.deepEqual(titles(), ['/logs/x.log'])
    await click(chipByLabel(m.container, 'Searched'))
    assert.deepEqual(titles(), ['/src/idx.md', '/src/pat.txt'])
    await m.unmount()
  })

  test('the sort toggle defaults to line changes and switches to most-active, latest, path, and name', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    const titles = () => queryAll(m.container, '.lc-fa-row').map(r => r.title)
    const sortBtns = queryAll(m.container, '.lc-fa-sort .lc-gran-btn')
    assert.equal(sortBtns.length, 5)
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/src/a.ts', 'solo.md', '/shots/ui.png', '/src/', '/var/many.log'])
    await click(sortBtns[0])
    assert.ok(sortBtns[0].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    await click(sortBtns[2])
    assert.ok(sortBtns[2].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/var/many.log', '/shots/ui.png', 'solo.md', '/src/a.ts', '/src/'])
    await click(sortBtns[3])
    assert.ok(sortBtns[3].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/shots/ui.png', '/src/', '/src/a.ts', '/var/many.log', 'solo.md'])
    await click(sortBtns[4])
    assert.ok(sortBtns[4].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/src/a.ts', '/var/many.log', 'solo.md', '/src/', '/shots/ui.png'])
    await click(sortBtns[1])
    assert.ok(sortBtns[1].className.includes('lc-gran-on'))
    assert.deepEqual(titles(), ['/src/a.ts', 'solo.md', '/shots/ui.png', '/src/', '/var/many.log'])
    await m.unmount()

    const readOne = (seq: number, path: string): FileEntry => entry(path, { reads: 1, ops: [fileOp(seq, 'read', 'read')] })
    const names = await mount(h(FileCard, {
      activity: {
        entries: [readOne(4, '/b/x.ts'), readOne(3, '/d/x.ts'), readOne(2, '/a/x.ts'), readOne(1, '/a/z.ts'), readOne(5, 'C:\\repo\\x.ts')],
        totals: { read: { files: 5, ops: 5 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
      },
    }))
    await click(queryAll(names.container, '.lc-fa-sort .lc-gran-btn')[4])
    assert.deepEqual(queryAll(names.container, '.lc-fa-row').map(r => r.title),
      ['/a/x.ts', '/b/x.ts', '/d/x.ts', 'C:\\repo\\x.ts', '/a/z.ts'], 'the last segment leads, ties break on the full path')
    await names.unmount()

    const churn = await mount(h(FileCard, {
      activity: {
        entries: [
          entry('/x/z.ts', { writes: 1, added: 2, ops: [fileOp(2, 'write', 'edit')] }),
          entry('/w/a.ts', { writes: 1, added: 2, ops: [fileOp(1, 'write', 'edit')] }),
        ],
        totals: { read: { files: 0, ops: 0 }, write: { files: 2, ops: 2 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 4, removed: 0 },
      },
      workspace: '/w',
    }))
    assert.deepEqual(queryAll(churn.container, '.lc-fa-row').map(r => r.title), ['/w/a.ts', '/x/z.ts'])
    await churn.unmount()
  })

  test('the mount-time default sort comes from the plugin settings', async () => {
    const titles = (container: ParentNode) => queryAll(container, '.lc-fa-row').map(r => r.title)
    const sortBtns = (container: ParentNode) => queryAll(container, '.lc-fa-sort .lc-gran-btn')
    for (const [sort, active, order] of [
      ['latest', 2, ['/var/many.log', '/shots/ui.png', 'solo.md', '/src/a.ts', '/src/']],
      ['path', 3, ['/shots/ui.png', '/src/', '/src/a.ts', '/var/many.log', 'solo.md']],
      ['name', 4, ['/src/a.ts', '/var/many.log', 'solo.md', '/src/', '/shots/ui.png']],
    ] as const) {
      settings.set('defaultFileSort', sort)
      const m = await mount(h(FileCard, { activity: richActivity() }))
      assert.ok(sortBtns(m.container)[active].className.includes('lc-gran-on'), `${sort} is the default sort`)
      assert.deepEqual(titles(m.container), order)
      await m.unmount()
    }

    settings.set('defaultFileSort', 'count')
    const m = await mount(h(FileCard, { activity: richActivity() }))
    assert.ok(sortBtns(m.container)[0].className.includes('lc-gran-on'))
    assert.deepEqual(titles(m.container), ['/var/many.log', '/src/a.ts', '/shots/ui.png', 'solo.md', '/src/'])
    await click(sortBtns(m.container)[1])
    assert.deepEqual(settings.store.getSnapshot().fileSort, 'count')
    await m.unmount()
  })
})

describe('FileCard — expansion and locate', () => {
  test('a row click expands its op log; an op click locates it; re-click collapses; stamps ride the right edge', async () => {
    const located: number[] = []
    const m = await mount(h(FileCard, { activity: richActivity(), onLocate: op => { located.push(op.seq) }, }))
    const row = rowByTitle(m.container, '/src/a.ts')
    await click(row)
    const ops = queryAll(m.container, '.lc-fa-op')
    assert.equal(ops.length, 4)
    assert.ok(text(ops[0]).includes('read'))
    assert.ok(ops[0].className.includes('lc-fa-op-link'))
    assert.ok(text(ops[1]).includes('+2') && text(ops[1]).includes('−1'))
    assert.ok(text(ops[2]).includes('−2') && !text(ops[2]).includes('+'))
    assert.ok(ops[2].querySelector('.lc-br-err-dot') !== null)
    assert.ok(text(ops[3]).includes('—'))
    await click(ops[1])
    assert.deepEqual(located, [5])
    assert.ok(query(m.container, '.lc-fa-ops') !== null)
    await click(rowByTitle(m.container, '/src/a.ts'))
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 0)
    await m.unmount()

    const stamped = await mount(h(FileCard, { activity: richActivity(), stampOf: seq => (seq === 7 ? { turn: 2, step: 1 } : seq === 3 ? { turn: 3, step: 4 } : null), }))
    await click(rowByTitle(stamped.container, '/src/a.ts'))
    const stampedOps = queryAll(stamped.container, '.lc-fa-op')
    for (const op of stampedOps) assert.equal(op.lastElementChild, query(op, '.lc-fa-op-meta'), 'values and stamp ride the right edge')
    assert.ok(text(stampedOps[0]!).includes('T2 S1'))
    assert.ok(text(stampedOps[0]!).includes(':'), 'the stamp prefixes, never replaces, the time')
    assert.equal(query(stampedOps[0]!, '.lc-fa-op-time').getAttribute('title'), 'First carried by the Turn 2 · Step 1 request')
    assert.equal(query(stampedOps[3]!, '.lc-fa-op-time').textContent, 'T3 S4')
    const unstamped = stampedOps[1]!
    assert.ok(!text(unstamped).includes('T2 S1'))
    assert.equal(query(unstamped, '.lc-fa-op-time').getAttribute('title'), null)
    assert.ok(query(unstamped, '.lc-fa-op-meta .lc-fa-delta') !== null)
    await stamped.unmount()
  })

  test('a search op shows its pattern detail; the expanded log lists every op', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    await click(rowByTitle(m.container, '/src/'))
    assert.ok(text(query(m.container, '.lc-fa-ops')).includes('needle'))
    await click(rowByTitle(m.container, '/var/many.log'))
    const many = query(m.container, '.lc-fa-ops')
    assert.equal(queryAll(many, '.lc-fa-op').length, 9)
    await m.unmount()

    const detailed = await mount(h(FileCard, {
      activity: richActivity({
        entries: [
          entry('/src/a.ts', {
            reads: 2,
            ops: [
              fileOp(9, 'read', 'read', { parent: 30, program: 'Read failing test and its fixture' }),
              fileOp(7, 'read', 'read'),
            ],
          }),
          entry('/src/b.ts', { searches: 1, ops: [fileOp(10, 'search', 'grep', { detail: 'needle', hits: 3 })] }),
        ],
        totals: { read: { files: 1, ops: 2 }, write: { files: 0, ops: 0 }, search: { files: 1, ops: 1 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
      }),
    }))
    await click(rowByTitle(detailed.container, '/src/a.ts'))
    assert.ok(text(query(detailed.container, '.lc-fa-ops')).includes('Read failing test and its fixture'), 'a nested PTC op tells why (its program)')
    await click(rowByTitle(detailed.container, '/src/a.ts'))
    await click(rowByTitle(detailed.container, '/src/b.ts'))
    const detail = text(query(detailed.container, '.lc-fa-ops'))
    assert.ok(detail.includes('needle'))
    assert.ok(detail.includes('3 hits'), 'a meta search op shows its hit count')
    await detailed.unmount()
  })

  test('a read op shows its line footprint — exact window or estimate; the time rides the right edge', async () => {
    const m = await mount(h(FileCard, {
      activity: richActivity({
        entries: [entry('/src/a.ts', {
          reads: 2,
          ops: [fileOp(7, 'read', 'read', { read: { start: 41, count: 30 } }), fileOp(6, 'read', 'read', { read: { count: 80, est: true } })],
        })],
        totals: { read: { files: 1, ops: 2 }, write: { files: 0, ops: 0 }, search: { files: 0, ops: 0 }, image: { files: 0, ops: 0 }, added: 0, removed: 0 },
      }),
    }))
    await click(rowByTitle(m.container, '/src/a.ts'))
    const ops = queryAll(m.container, '.lc-fa-op')
    const exact = queryAll(ops[0], '.lc-fa-op-meta .lc-fa-read')
    assert.equal(exact.length, 1)
    assert.equal(exact[0].textContent, '>>30')
    assert.equal(exact[0].getAttribute('title'), 'Read lines 41–70')
    const est = queryAll(ops[1], '.lc-fa-op-meta .lc-fa-read')
    assert.equal(est.length, 1)
    assert.equal(est[0].textContent, '≈80')
    assert.equal(est[0].getAttribute('title'), 'Lines read, estimated from the limit argument')
    const time = query(ops[1], '.lc-fa-op-meta .lc-fa-op-time')
    assert.notEqual(time.textContent, '—')
    assert.ok((time.textContent ?? '').includes(':'))
    await m.unmount()
  })

  test('without a locate hook the op lines render inert', async () => {
    const m = await mount(h(FileCard, { activity: richActivity() }))
    await click(queryAll(m.container, '.lc-fa-row')[0])
    assert.equal(queryAll(m.container, 'button.lc-fa-op').length, 0)
    assert.ok(queryAll(m.container, 'div.lc-fa-op').length > 0)
    await m.unmount()
  })

})

describe('FileCard — workspace display and system open', () => {
  function workspaceActivity(): FileActivity {
    return {
      entries: [
        entry('/repo/src/a.ts', { reads: 1, ops: [fileOp(5, 'read', 'read')] }),
        entry('/etc/hosts', { reads: 1, ops: [fileOp(4, 'read', 'read')] }),
        entry('rel/b.md', { writes: 1, ops: [fileOp(3, 'write', 'write')] }),
        entry('needle', { searches: 1, pattern: true, ops: [fileOp(2, 'search', 'grep', { detail: 'needle' })] }),
        entry('\\bfoo\\b', { searches: 1, pattern: true, ops: [fileOp(0, 'search', 'grep', { detail: '\\bfoo\\b' })] }),
        entry('./dot/c.ts', { reads: 1, ops: [fileOp(1, 'read', 'read')] }),
      ],
      totals: {
        read: { files: 3, ops: 3 },
        write: { files: 1, ops: 1 },
        search: { files: 1, ops: 1 },
        image: { files: 0, ops: 0 },
        added: 0,
        removed: 0,
      },
    }
  }

  function rowOf(container: ParentNode, title: string): HTMLElement {
    const hit = queryAll(container, '.lc-fa-row').find(r => r.title === title)
    if (hit === undefined) throw new Error(`row not found: ${title}`)
    return hit
  }

  const baseOf = (row: HTMLElement): HTMLElement => query(row, '.lc-fa-path b')

  test('workspace and relative paths display dot-relative and the file name opens on the system; pattern and unresolvable rows stay inert', async () => {
    const opened: string[] = []
    const m = await mount(h(FileCard, { activity: workspaceActivity(), workspace: '/repo', onOpen: p => { opened.push(p) } }))
    const a = rowOf(m.container, '/repo/src/a.ts')
    assert.ok(a.querySelector('.lc-fa-path em')?.textContent === './src/')
    assert.ok(baseOf(a).textContent === 'a.ts')
    const hosts = rowOf(m.container, '/etc/hosts')
    assert.ok(hosts.querySelector('.lc-fa-path em')?.textContent === '/etc/')
    const rel = rowOf(m.container, 'rel/b.md')
    assert.ok(rel.querySelector('.lc-fa-path em')?.textContent === './rel/')
    const pat = rowOf(m.container, 'needle')
    assert.equal(pat.querySelector('.lc-fa-path em'), null)
    assert.ok(baseOf(pat).textContent === 'needle')
    const escaped = rowOf(m.container, '\\bfoo\\b')
    assert.equal(escaped.querySelector('.lc-fa-path em'), null)
    assert.ok(baseOf(escaped).textContent === '\\bfoo\\b')
    const dot = rowOf(m.container, './dot/c.ts')
    assert.ok(dot.querySelector('.lc-fa-path em')?.textContent === './dot/')
    assert.equal(queryAll(m.container, '.lc-fa-meta-delta').length, 0, 'no line activity drops the aggregate delta pill')
    const aName = baseOf(rowOf(m.container, '/repo/src/a.ts'))
    assert.ok(aName.className.includes('lc-fa-file'))
    assert.equal(aName.getAttribute('title'), 'Open on your system')
    await click(aName)
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 0)
    await click(baseOf(rowOf(m.container, '/etc/hosts')))
    assert.deepEqual(opened, ['/repo/src/a.ts', '/etc/hosts'])
    assert.equal(baseOf(rowOf(m.container, 'needle')).className.includes('lc-fa-file'), false)
    assert.equal(baseOf(rowOf(m.container, './dot/c.ts')).className.includes('lc-fa-file'), false, 'an unresolvable row renders inert')
    await m.unmount()
  })

  test('Windows workspace paths split at the backslash leaf and abbreviate the root to dot', async () => {
    const m = await mount(h(FileCard, {
      activity: {
        entries: [
          entry('C:\\repo\\src\\client\\fleet.css', { reads: 1, ops: [fileOp(4, 'read', 'read')] }),
          entry('C:\\repo', { form: 'dir', searches: 1, ops: [fileOp(3, 'search', 'grep')] }),
          entry('C:\\repo-sibling\\x.ts', { reads: 1, ops: [fileOp(2, 'read', 'read')] }),
          entry('src\\client\\pulse.css', { writes: 1, ops: [fileOp(1, 'write', 'write')] }),
        ],
        totals: {
          read: { files: 2, ops: 2 },
          write: { files: 1, ops: 1 },
          search: { files: 1, ops: 1 },
          image: { files: 0, ops: 0 },
          added: 0,
          removed: 0,
        },
      },
      workspace: 'C:\\repo',
    }))
    const inside = rowOf(m.container, 'C:\\repo\\src\\client\\fleet.css')
    assert.equal(inside.querySelector('.lc-fa-path em')?.textContent, '.\\src\\client\\')
    assert.equal(baseOf(inside).textContent, 'fleet.css')
    const root = rowOf(m.container, 'C:\\repo')
    assert.equal(root.querySelector('.lc-fa-path em'), null)
    assert.equal(baseOf(root).textContent, '.')
    const sibling = rowOf(m.container, 'C:\\repo-sibling\\x.ts')
    assert.equal(sibling.querySelector('.lc-fa-path em')?.textContent, 'C:\\repo-sibling\\')
    assert.equal(baseOf(sibling).textContent, 'x.ts')
    const relative = rowOf(m.container, 'src\\client\\pulse.css')
    assert.equal(relative.querySelector('.lc-fa-path em')?.textContent, '.\\src\\client\\')
    assert.equal(baseOf(relative).textContent, 'pulse.css')
    await m.unmount()
  })

  test('POSIX names containing backslashes split only at forward slashes', async () => {
    const m = await mount(h(FileCard, {
      activity: {
        entries: [
          entry('/repo/src/a\\b/c.ts', { reads: 1, ops: [fileOp(2, 'read', 'read')] }),
          entry('/repo/src/a\\b/', { form: 'dir', searches: 1, ops: [fileOp(1, 'search', 'grep')] }),
        ],
        totals: {
          read: { files: 1, ops: 1 },
          write: { files: 0, ops: 0 },
          search: { files: 1, ops: 1 },
          image: { files: 0, ops: 0 },
          added: 0,
          removed: 0,
        },
      },
      workspace: '/repo',
    }))
    const file = rowOf(m.container, '/repo/src/a\\b/c.ts')
    assert.equal(file.querySelector('.lc-fa-path em')?.textContent, './src/a\\b/')
    assert.equal(baseOf(file).textContent, 'c.ts')
    const dir = rowOf(m.container, '/repo/src/a\\b/')
    assert.equal(dir.querySelector('.lc-fa-path em')?.textContent, './src/')
    assert.equal(baseOf(dir).textContent, 'a\\b')
    await m.unmount()
  })

  test('the same file reached by a relative and an absolute spelling folds into one row', async () => {
    const m = await mount(h(FileCard, {
      activity: {
        entries: [
          entry('src/a.ts', { reads: 2, ops: [fileOp(5, 'read', 'read'), fileOp(4, 'read', 'read')] }),
          entry('/repo/src/a.ts', { writes: 1, ops: [fileOp(6, 'write', 'write')] }),
          entry('/repo/src/b.ts', { reads: 1, ops: [fileOp(7, 'read', 'read')] }),
          entry('src/b.ts', { reads: 1, ops: [fileOp(8, 'read', 'read')] }),
        ],
        totals: {
          read: { files: 2, ops: 4 },
          write: { files: 1, ops: 1 },
          search: { files: 0, ops: 0 },
          image: { files: 0, ops: 0 },
          added: 0,
          removed: 0,
        },
      },
      workspace: '/repo',
    }))
    const rows = queryAll(m.container, '.lc-fa-row')
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(r => r.title), ['/repo/src/a.ts', '/repo/src/b.ts'])
    const a = rowOf(m.container, '/repo/src/a.ts')
    assert.equal(a.querySelector('.lc-fa-path em')?.textContent, './src/')
    assert.equal(baseOf(a).textContent, 'a.ts')
    assert.equal(query(a, '.lc-fa-b-read').textContent, '2')
    assert.equal(query(a, '.lc-fa-b-write').textContent, '1')
    assert.equal(query(rowOf(m.container, '/repo/src/b.ts'), '.lc-fa-b-read').textContent, '2')
    assert.ok(text(query(m.container, '.lc-fa-meta')).includes('2 files'))
    await click(a)
    assert.equal(queryAll(m.container, '.lc-fa-op').length, 3)
    await m.unmount()
  })

  test('without an opener (or without the workspace) the file names render inert', async () => {
    const m1 = await mount(h(FileCard, { activity: workspaceActivity(), workspace: '/repo' }))
    assert.equal(queryAll(m1.container, '.lc-fa-file').length, 0)
    await m1.unmount()
    const opened: string[] = []
    const m2 = await mount(h(FileCard, { activity: workspaceActivity(), onOpen: p => { opened.push(p) }, }))
    assert.equal(queryAll(m2.container, '.lc-fa-file').length, 2)
    await click(baseOf(rowOf(m2.container, 'rel/b.md')))
    assert.deepEqual(opened, [])
    await m2.unmount()

    const previewOnlyActivity = workspaceActivity()
    previewOnlyActivity.entries.push(entry('/repo/src/', { form: 'dir', searches: 1, ops: [fileOp(0, 'search', 'grep')] }))
    const previewOnly = await mount(h(FileCard, { activity: previewOnlyActivity, onPreview: () => false }))
    const name = baseOf(rowOf(previewOnly.container, 'rel/b.md'))
    assert.equal(name.getAttribute('title'), 'Preview in the sidebar')
    await click(name)
    assert.equal(baseOf(rowOf(previewOnly.container, '/repo/src/')).className.includes('lc-fa-file'), false, 'a directory never claims the preview')
    await previewOnly.unmount()
  })

  test('the Sidebar preview handles the name — never pattern or directory rows — and a refusal falls through to the system opener', async () => {
    const previewed: FileEntry[] = []
    const opened: string[] = []
    const dirActivity = workspaceActivity()
    dirActivity.entries.push(entry('/repo/src/', { form: 'dir', searches: 1, ops: [fileOp(0, 'search', 'grep')] }))
    const m = await mount(h(FileCard, { activity: dirActivity, workspace: '/repo', onPreview: e => { previewed.push(e); return true }, onOpen: p => { opened.push(p) }, }))
    assert.equal(baseOf(rowOf(m.container, 'needle')).className.includes('lc-fa-file'), false)
    const a = baseOf(rowOf(m.container, '/repo/src/a.ts'))
    assert.equal(a.getAttribute('title'), 'Preview in the sidebar')
    await click(a)
    assert.deepEqual(previewed.map(e => e.path), ['/repo/src/a.ts'])
    assert.equal(opened.length, 0)
    await m.unmount()
    const m2 = await mount(h(FileCard, { activity: workspaceActivity(), workspace: '/repo', onPreview: () => false, onOpen: p => { opened.push(p) }, }))
    await click(baseOf(rowOf(m2.container, '/repo/src/a.ts')))
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    await m2.unmount()
  })

})

describe('FileCard — the split generation detail states', () => {
  test('a pending detail read shows the loading note; a failed one arms its retry, or keeps the plain empty claim without one', async () => {
    const m = await mount(h(FileCard, { activity: richActivity({ entries: [] }), state: 'loading', onRetry: () => {}, }))
    assert.ok(text(m.container).includes('Loading history'))
    assert.ok(!text(m.container).includes('No file reads'))
    await m.unmount()

    let retries = 0
    const failed = await mount(h(FileCard, { activity: richActivity({ entries: [] }), state: 'failed', onRetry: () => { retries++ }, }))
    await click(query(failed.container, '.lc-br-retry'))
    assert.equal(retries, 1)
    await failed.unmount()

    const inert = await mount(h(FileCard, { activity: richActivity({ entries: [] }), state: 'failed' }))
    assert.ok(text(inert.container).includes('No file reads'), 'no retry wired — the plain empty state')
    await inert.unmount()
  })
})

describe('FileCard — the stats board\'s kind focus', () => {
  test('a one-shot filter focus picks the kind chip, drops the card\'s own lens, and hands itself back', async () => {
    const handled: number[] = []
    const props = (filterFocus: FileFilter) => ({
      activity: richActivity(),
      filterFocus,
      onFilterFocusHandled: () => { handled.push(handled.length + 1) },
    })
    const m = await mount(h(FileCard, props('read')))
    assert.equal(handled.length, 1, 'the request is consumed once')
    assert.ok(chipByLabel(m.container, 'Read').className.includes('lc-gran-on'))
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/var/many.log', '/src/a.ts', '/shots/ui.png'])

    await typeSearch(m.container, 'a.ts')
    await click(rowByTitle(m.container, '/src/a.ts'))
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 1)
    await m.update(h(FileCard, props('image')))
    assert.equal(handled.length, 2)
    assert.ok(chipByLabel(m.container, 'Images').className.includes('lc-gran-on'))
    assert.ok(!chipByLabel(m.container, 'Read').className.includes('lc-gran-on'))
    assert.deepEqual(queryAll(m.container, '.lc-fa-row').map(r => r.title), ['/shots/ui.png'])
    assert.equal(query<HTMLInputElement>(m.container, 'input.lc-fa-search').value, '', 'the text lens is dropped')
    assert.equal(queryAll(m.container, '.lc-fa-ops').length, 0, 'no row stays open across the jump')

    await m.update(h(FileCard, { activity: richActivity(), filterFocus: null, onFilterFocusHandled: () => { handled.push(handled.length + 1) } }))
    assert.equal(handled.length, 2, 'the cleared request never fires')
    await click(chipByLabel(m.container, 'All'))
    assert.ok(chipByLabel(m.container, 'All').className.includes('lc-gran-on'))
    await m.update(h(FileCard, props('read')))
    assert.equal(handled.length, 3)
    assert.ok(chipByLabel(m.container, 'Read').className.includes('lc-gran-on'))
    await m.unmount()

    const solo = await mount(h(FileCard, { activity: richActivity(), filterFocus: 'search' }))
    assert.ok(chipByLabel(solo.container, 'Searched').className.includes('lc-gran-on'), 'a hand-back-free jump still lands')
    await click(chipByLabel(solo.container, 'Written'))
    assert.deepEqual(queryAll(solo.container, '.lc-fa-row').map(r => r.title), ['/src/a.ts', 'solo.md'], 'the count sort keys on the written tally')
    await solo.unmount()
  })
})
