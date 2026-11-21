import type { HistoryPage, HistoryPart, HistoryRow } from '../shared/types'
import type { HistoryCursor, HistoryFetcher } from './timelineWire'

export const HISTORY_PAGE_MAX = 1_000

const HISTORY_PAGES_MAX = 10_000

export type HistoryTailRows<T> = T[] | 'reload' | null

export function nextHistoryCursor(page: HistoryPage): HistoryCursor | undefined {
  if (page.beforeSeq !== undefined) return { beforeSeq: page.beforeSeq }
  if (page.beforeIndex !== undefined) return { beforeIndex: page.beforeIndex }
  return undefined
}

export async function loadHistoryTailIndex<T extends HistoryRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  old: T[],
  limit: number = HISTORY_PAGE_MAX,
): Promise<HistoryTailRows<T>> {
  let page = await history(part, undefined, limit)
  if (page === null) return null
  if (page.total < old.length) return 'reload'
  if (page.total === old.length) return old
  if (page.atStart) return page.rows as T[]
  let add = page.rows as T[]
  let first = page.first
  let cursor = nextHistoryCursor(page)
  let pages = 1
  while (first > old.length && cursor !== undefined) {
    /* v8 ignore next 1 */
    if (++pages > HISTORY_PAGES_MAX) return 'reload'
    page = await history(part, cursor, limit)
    if (page === null) return null
    add = [...page.rows as T[], ...add]
    first = page.first
    if (page.atStart) break
    const next = nextHistoryCursor(page)
    if (next?.beforeIndex === cursor.beforeIndex && next?.beforeSeq === cursor.beforeSeq) return 'reload'
    cursor = next
  }
  if (first > old.length) return 'reload'
  const merged = [...old.slice(0, first), ...add]
  return merged.length === page.total ? merged : 'reload'
}

export type HistorySeqRow = { seq: number; ord?: number }

export function historyRowKey(row: HistorySeqRow): string {
  return String(row.seq) + ':' + String(row.ord ?? '')
}

function compareRows(a: HistorySeqRow, b: HistorySeqRow): number {
  const bySeq = a.seq - b.seq
  return bySeq !== 0 ? bySeq : (a.ord ?? 0) - (b.ord ?? 0)
}

export function mergeHistoryRows<T extends HistorySeqRow>(old: T[], add: T[]): T[] {
  if (add.length === 0) return old
  const last = old.at(-1)
  if (last === undefined || compareRows(add[0], last) > 0) return [...old, ...add]
  const merged = new Map<string, T>()
  for (const row of old) merged.set(historyRowKey(row), row)
  for (const row of add) merged.set(historyRowKey(row), row)
  return [...merged.values()].sort(compareRows)
}
