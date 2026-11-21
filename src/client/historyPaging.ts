import type { HistoryPage, HistoryPart, HistoryRow } from '../shared/types'
import type { HistoryCursor, HistoryFetcher } from './timelineWire'

export const HISTORY_PAGE_MAX = 1_000

const HISTORY_PAGES_MAX = 10_000

export const CANCELLED = 'cancelled'

export type HistoryRows<T> = T[] | typeof CANCELLED | null

export type HistoryTailRows<T> = T[] | 'reload' | typeof CANCELLED | null

export interface HistoryPagingOptions {
  rev: number
  cancelled: () => boolean
}

export function nextHistoryCursor(page: HistoryPage): HistoryCursor | undefined {
  if (page.beforeSeq !== undefined) return { beforeSeq: page.beforeSeq }
  if (page.beforeIndex !== undefined) return { beforeIndex: page.beforeIndex }
  return undefined
}

export async function readHistoryPage(
  history: HistoryFetcher,
  part: HistoryPart,
  cursor: HistoryCursor | undefined,
  limit: number,
  options: HistoryPagingOptions,
): Promise<HistoryPage | typeof CANCELLED | null> {
  if (options.cancelled()) return CANCELLED
  const page = await history(part, cursor, limit)
  if (options.cancelled()) return CANCELLED
  return page === null || page.rev !== options.rev ? null : page
}

export async function loadAllHistory<T extends HistoryRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  options: HistoryPagingOptions,
): Promise<HistoryRows<T>> {
  let cursor: HistoryCursor | undefined
  const rows: T[] = []
  for (let pages = 0; ; pages++) {
    /* v8 ignore next 1 */
    if (pages >= HISTORY_PAGES_MAX) return null
    const page = await readHistoryPage(history, part, cursor, HISTORY_PAGE_MAX, options)
    if (page === CANCELLED || page === null) return page
    rows.unshift(...page.rows as T[])
    const next = nextHistoryCursor(page)
    if (next === undefined || page.rows.length === 0) break
    if (next.beforeSeq === cursor?.beforeSeq && next.beforeIndex === cursor?.beforeIndex) return null
    cursor = next
  }
  return rows
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

export async function loadTailHistory<T extends HistorySeqRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  old: T[],
  options: HistoryPagingOptions,
): Promise<HistoryRows<T>> {
  const known = new Set(old.map(historyRowKey))
  const add: T[] = []
  let unseen = 0
  let cursor: number | undefined
  for (let pages = 0; ; pages++) {
    /* v8 ignore next 1 */
    if (pages >= HISTORY_PAGES_MAX) return null
    const page = await readHistoryPage(
      history,
      part,
      cursor === undefined ? undefined : { beforeSeq: cursor },
      HISTORY_PAGE_MAX,
      options,
    )
    if (page === CANCELLED || page === null) return page
    for (const row of page.rows as unknown as T[]) {
      const key = historyRowKey(row)
      if (known.has(key)) continue
      known.add(key)
      unseen++
    }
    add.unshift(...page.rows as unknown as T[])
    if (unseen >= Math.max(0, page.total - old.length)
      || page.atStart || page.beforeSeq === undefined || page.rows.length === 0) break
    if (page.beforeSeq === cursor) return null
    cursor = page.beforeSeq
  }
  return mergeHistoryRows(old, add)
}

export async function loadHistoryTailIndex<T extends HistoryRow>(
  history: HistoryFetcher,
  part: HistoryPart,
  old: T[],
  options: HistoryPagingOptions,
  limit: number = HISTORY_PAGE_MAX,
): Promise<HistoryTailRows<T>> {
  let page = await readHistoryPage(history, part, undefined, limit, options)
  if (page === CANCELLED || page === null) return page
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
    page = await readHistoryPage(history, part, cursor, limit, options)
    if (page === CANCELLED || page === null) return page
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
