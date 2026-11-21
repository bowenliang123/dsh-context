// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { CANCELLED, historyRowKey, loadAllHistory, loadHistoryTailIndex, loadTailHistory, mergeHistoryRows, nextHistoryCursor } from '../../src/client/historyPaging'
import type { FileOpRecord, HistoryPage, HistoryPart } from '../../src/shared/types'

const OPTIONS = { rev: 1, cancelled: () => false }

describe('history merge', () => {
  test('appends a newer tail without rebuilding the old rows', () => {
    const old = [{ seq: 1 }, { seq: 2 }]
    const merged = mergeHistoryRows(old, [{ seq: 3 }])
    assert.deepEqual(merged.map(row => row.seq), [1, 2, 3])
    assert.notEqual(merged, old)
    assert.equal(mergeHistoryRows(old, []), old)
  })

  test('deduplicates by ordinal and orders same-seq rows across rows without one', () => {
    const merged = mergeHistoryRows(
      [{ seq: 9 }, { seq: 10 }],
      [{ seq: 9, ord: 0 }, { seq: 9, ord: 1 }],
    )
    assert.deepEqual(merged.map(historyRowKey), ['9:', '9:0', '9:1', '10:'])
  })

  test('replaces overlap rows in place and splices add rows around the region', () => {
    const old = Array.from({ length: 10 }, (_, index) => ({ seq: index + 1, tag: 'old' }))
    const add = [
      { seq: 8, tag: 'new' },
      { seq: 9, tag: 'new' },
      { seq: 10, tag: 'new' },
      { seq: 11, tag: 'new' },
    ]
    const merged = mergeHistoryRows(old, add)
    assert.deepEqual(merged.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
    assert.deepEqual(merged.slice(0, 7).map(row => row.tag), Array.from({ length: 7 }, () => 'old'))
    assert.deepEqual(merged.slice(7).map(row => row.tag), ['new', 'new', 'new', 'new'])
  })

  test('merges add rows that precede the old head', () => {
    const old = [{ seq: 5, tag: 'old' }, { seq: 6, tag: 'old' }]
    const merged = mergeHistoryRows(old, [{ seq: 3, tag: 'new' }, { seq: 5, tag: 'new' }, { seq: 7, tag: 'new' }])
    assert.deepEqual(merged.map(row => row.seq), [3, 5, 6, 7])
    assert.deepEqual(merged.map(row => row.tag), ['new', 'new', 'old', 'new'])
  })

  test('a same-total refresh replaces the content of retained rows', async () => {
    const old = [file(1), file(2)]
    const merged = await loadTailHistory(fake([page({ rows: [file(1), { ...file(2), added: 9 }], first: 0, total: 2 })]), 'files', old, OPTIONS)
    assert.ok(Array.isArray(merged))
    assert.equal(merged.length, 2)
    assert.equal(merged[1].added, 9)
    assert.notEqual(merged[0], old[0])
  })

  test('walks sequence pages across a multi-page gap and merges in order', async () => {
    const pages = [
      page({ rows: [file(7), file(8)], first: 6, total: 8, beforeSeq: 7 }),
      page({ rows: [file(3), file(4), file(5), file(6)], first: 2, total: 8 }),
    ]
    const merged = await loadTailHistory(fake(pages), 'requests', [file(1), file(2)], OPTIONS)
    assert.ok(Array.isArray(merged))
    assert.deepEqual(merged.map(row => row.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  })

  test('assembles a full multi-page walk oldest-first', async () => {
    const pages = [
      page({ rows: [file(4), file(5)], first: 3, total: 5, beforeSeq: 4 }),
      page({ rows: [file(1), file(2), file(3)], first: 0, total: 5 }),
    ]
    const rows = await loadAllHistory<FileOpRecord>(fake(pages), 'requests', OPTIONS)
    assert.ok(Array.isArray(rows))
    assert.deepEqual(rows.map(row => row.seq), [1, 2, 3, 4, 5])
  })

  test('stops the walk when a page omits its cursor', async () => {
    const merged = await loadTailHistory(fake([page({ rows: [file(3)], first: 2, total: 9 })]), 'requests', [file(1), file(2)], OPTIONS)
    assert.ok(Array.isArray(merged))
    assert.deepEqual(merged.map(row => row.seq), [1, 2, 3])
  })

  test('stops the walk on an empty cursor-bearing page', async () => {
    const merged = await loadTailHistory(fake([page({ rows: [], first: 2, total: 9, beforeSeq: 3 })]), 'requests', [file(1), file(2)], OPTIONS)
    assert.ok(Array.isArray(merged))
    assert.deepEqual(merged.map(row => row.seq), [1, 2])
  })

  test('rejects a stalled sequence cursor', async () => {
    const stalled = page({ rows: [file(3)], first: 2, total: 9, beforeSeq: 2 })
    assert.equal(await loadTailHistory(fake([stalled, stalled]), 'requests', [file(1)], OPTIONS), null)
  })

  test('reads older index pages until the tail reaches the known prefix', async () => {
    const old = [file(1)]
    const pages: HistoryPage[] = [
      page({ rows: [file(1_501), file(1_502)], first: 1_500, total: 1_502, beforeIndex: 1_500 }),
      page({ rows: Array.from({ length: 1_000 }, (_, index) => file(501 + index)), first: 500, total: 1_502, beforeIndex: 500 }),
      page({ rows: Array.from({ length: 500 }, (_, index) => file(1 + index)), first: 0, total: 1_502 }),
    ]
    const merged = await loadHistoryTailIndex(fake(pages), 'files', old, OPTIONS)
    assert.ok(Array.isArray(merged))
    assert.equal(merged.length, 1_502)
    assert.equal(merged[0].seq, 1)
    assert.equal(merged.at(-1)?.seq, 1_502)
  })

  test('leaves an unchanged collection untouched and rejects a stalled cursor', async () => {
    const old = [file(1)]
    assert.equal(await loadHistoryTailIndex(fake([page({ rows: [file(1)], first: 0, total: 1 })]), 'files', old, OPTIONS), old)
    const stalled = page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 })
    assert.equal(await loadHistoryTailIndex(fake([stalled, stalled]), 'files', old, OPTIONS), 'reload')
  })

  test('reloads on shrink, a gap, or an inconsistent page union', async () => {
    assert.equal(await loadHistoryTailIndex(fake([page({ rows: [], first: 0, total: 0 })]), 'files', [file(1), file(2)], OPTIONS), 'reload')
    assert.equal(await loadHistoryTailIndex(fake([
      page({ rows: [file(3)], first: 2, total: 3 }),
    ]), 'files', [file(1)], OPTIONS), 'reload')
    assert.equal(await loadHistoryTailIndex(fake([
      page({ rows: [file(2), file(3)], first: 2, total: 5, beforeIndex: 2 }),
      page({ rows: [file(1), file(2)], first: 0, total: 5 }),
    ]), 'files', [file(1), file(2), file(3)], OPTIONS), 'reload')
  })

  test('returns a full page as the new collection and aborts on a missing page or start', async () => {
    assert.deepEqual(await loadHistoryTailIndex(fake([page({ rows: [file(1)], first: 0, total: 1 })]), 'files', [], OPTIONS), [file(1)])
    assert.equal(await loadHistoryTailIndex(fake([null]), 'files', [], OPTIONS), null)
    const blocked = [
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      null,
    ]
    assert.equal(await loadHistoryTailIndex(fake(blocked), 'files', [file(1)], OPTIONS), null)
    const reachedStart = [
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      page({ rows: [file(1), file(2)], first: 0, total: 3 }),
    ]
    assert.deepEqual(await loadHistoryTailIndex(fake(reachedStart), 'files', [file(1)], OPTIONS), [file(1), file(2), file(3)])
  })

  test('rejects mixed revisions in full, sequence-tail and index-tail walks', async () => {
    const first = page({ rows: [file(4), file(5)], first: 3, total: 5, beforeSeq: 4 })
    const older = { ...page({ rows: [file(1), file(2), file(3)], first: 0, total: 5 }), rev: 2 }
    assert.equal(await loadAllHistory(fake([first, older]), 'requests', OPTIONS), null)
    assert.equal(await loadTailHistory(fake([first, older]), 'requests', [file(1), file(2)], OPTIONS), null)
    const indexed = { ...page({ rows: [file(1), file(2)], first: 0, total: 3 }), rev: 2 }
    assert.equal(await loadHistoryTailIndex(fake([
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      indexed,
    ]), 'files', [file(1)], OPTIONS), null)
  })

  test('cancels before requesting another page', async () => {
    let calls = 0
    const pages = fake([
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      page({ rows: [file(1), file(2)], first: 0, total: 3 }),
    ])
    const result = await loadHistoryTailIndex(async (part, cursor, limit) => {
      calls++
      return pages(part, cursor, limit)
    }, 'files', [file(1)], { rev: 1, cancelled: () => calls > 0 })
    assert.equal(result, CANCELLED)
    assert.equal(calls, 1)
  })

  test('does not fetch when the walk is already cancelled', async () => {
    let called = false
    const result = await loadAllHistory(async () => {
      called = true
      return null
    }, 'requests', { rev: 1, cancelled: () => true })
    assert.equal(result, CANCELLED)
    assert.equal(called, false)
  })

  test('derives the cursor for seq and index pages', () => {
    assert.deepEqual(nextHistoryCursor(page({ rows: [], first: 2, total: 3, beforeIndex: 2 })), { beforeIndex: 2 })
    assert.equal(nextHistoryCursor(page({ rows: [], first: 0, total: 0 })), undefined)
  })
})

function file(seq: number): FileOpRecord {
  return { seq, path: 'f' + String(seq), kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }
}

function page(over: { rows: FileOpRecord[]; first: number; total: number; beforeIndex?: number; beforeSeq?: number }): HistoryPage {
  return {
    rev: 1,
    live: true,
    part: 'files',
    rows: over.rows,
    first: over.first,
    last: over.first + over.rows.length - 1,
    total: over.total,
    atStart: over.first === 0,
    atEnd: over.first + over.rows.length === over.total,
    ...(over.beforeIndex === undefined ? {} : { beforeIndex: over.beforeIndex }),
    ...(over.beforeSeq === undefined ? {} : { beforeSeq: over.beforeSeq }),
  }
}

function fake(pages: (HistoryPage | null)[]): (part: HistoryPart, cursor?: { beforeIndex?: number; beforeSeq?: number }, limit?: number) => Promise<HistoryPage | null> {
  let index = 0
  return async () => pages[Math.min(index++, pages.length - 1)]
}
