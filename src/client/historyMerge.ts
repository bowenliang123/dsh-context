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
