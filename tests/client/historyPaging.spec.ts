// @vitest-environment node

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { historyRowKey, loadHistoryTailIndex, mergeHistoryRows, nextHistoryCursor } from '../../src/client/historyPaging'
import type { FileOpRecord, HistoryPage, HistoryPart } from '../../src/shared/types'

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

  test('reads older index pages until the tail reaches the known prefix', async () => {
    const old = [file(1)]
    const pages: HistoryPage[] = [
      page({ rows: [file(1_501), file(1_502)], first: 1_500, total: 1_502, beforeIndex: 1_500 }),
      page({ rows: Array.from({ length: 1_000 }, (_, index) => file(501 + index)), first: 500, total: 1_502, beforeIndex: 500 }),
      page({ rows: Array.from({ length: 500 }, (_, index) => file(1 + index)), first: 0, total: 1_502 }),
    ]
    const merged = await loadHistoryTailIndex(fake(pages), 'files', old)
    assert.ok(Array.isArray(merged))
    assert.equal(merged.length, 1_502)
    assert.equal(merged[0].seq, 1)
    assert.equal(merged.at(-1)?.seq, 1_502)
  })

  test('leaves an unchanged collection untouched and rejects a stalled cursor', async () => {
    const old = [file(1)]
    assert.equal(await loadHistoryTailIndex(fake([page({ rows: [file(1)], first: 0, total: 1 })]), 'files', old), old)
    const stalled = page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 })
    assert.equal(await loadHistoryTailIndex(fake([stalled, stalled]), 'files', old), 'reload')
  })

  test('reloads on shrink, a gap, or an inconsistent page union', async () => {
    assert.equal(await loadHistoryTailIndex(fake([page({ rows: [], first: 0, total: 0 })]), 'files', [file(1), file(2)]), 'reload')
    assert.equal(await loadHistoryTailIndex(fake([
      page({ rows: [file(3)], first: 2, total: 3 }),
    ]), 'files', [file(1)]), 'reload')
    assert.equal(await loadHistoryTailIndex(fake([
      page({ rows: [file(2), file(3)], first: 2, total: 5, beforeIndex: 2 }),
      page({ rows: [file(1), file(2)], first: 0, total: 5 }),
    ]), 'files', [file(1), file(2), file(3)]), 'reload')
  })

  test('returns a full page as the new collection and aborts on a missing page or start', async () => {
    assert.deepEqual(await loadHistoryTailIndex(fake([page({ rows: [file(1)], first: 0, total: 1 })]), 'files', []), [file(1)])
    assert.equal(await loadHistoryTailIndex(fake([null]), 'files', []), null)
    const blocked = [
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      null,
    ]
    assert.equal(await loadHistoryTailIndex(fake(blocked), 'files', [file(1)]), null)
    const reachedStart = [
      page({ rows: [file(3)], first: 2, total: 3, beforeIndex: 2 }),
      page({ rows: [file(1), file(2)], first: 0, total: 3 }),
    ]
    assert.deepEqual(await loadHistoryTailIndex(fake(reachedStart), 'files', [file(1)]), [file(1), file(2), file(3)])
  })

  test('derives the cursor for seq and index pages', () => {
    assert.deepEqual(nextHistoryCursor(page({ rows: [], first: 2, total: 3, beforeIndex: 2 })), { beforeIndex: 2 })
    assert.equal(nextHistoryCursor(page({ rows: [], first: 0, total: 0 })), undefined)
  })
})

function file(seq: number): FileOpRecord {
  return { seq, path: 'f' + String(seq), kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }
}

function page(over: { rows: FileOpRecord[]; first: number; total: number; beforeIndex?: number }): HistoryPage {
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
  }
}

function fake(pages: (HistoryPage | null)[]): (part: HistoryPart, cursor?: { beforeIndex?: number }) => Promise<HistoryPage | null> {
  let index = 0
  return async () => pages[Math.min(index++, pages.length - 1)]
}
