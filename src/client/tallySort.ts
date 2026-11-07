export function tallyEntriesOf(tally: Record<string, number> | undefined): [string, number][] {
  if (tally === undefined) return []
  return Object.entries(tally).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}
