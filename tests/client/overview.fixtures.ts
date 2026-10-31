import { rangeWindowOf, type OverviewRange, type OverviewRow, type TallyStat } from '../../src/client/overview'
import type { SessionCostUsage } from '../../src/shared/types'

export const win = (range: OverviewRange, now: number) => rangeWindowOf(range, now)

export function statOf(name: string, n: number, last: number, sessions = 1): TallyStat {
  return { name, n, sessions, last }
}

export const COST: SessionCostUsage = {
  deepseek: { 'deepseek-v4': { peak: { uncached: 100, cacheRead: 50, cacheWrite: 10, output: 40 } } },
}

export function rowOf(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: 's1',
    title: 'session one',
    updatedAt: 100,
    running: false,
    current: false,
    archived: false,
    timeline: null,
    activity: null,
    family: [over.timeline ?? null],
    familyCost: null,
    ...over,
  }
}
