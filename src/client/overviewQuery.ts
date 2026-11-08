import { endOfDayKey, startOfDayKey } from '../shared/days'
import type { DefaultOverviewRange } from '../shared/types'

export type OverviewCoverage = 'all' | 'active' | 'archived'

export type OverviewRange = DefaultOverviewRange

export interface RangeWindow {
  start: number | null
  end: number | null
}

const OPEN_WINDOW: RangeWindow = Object.freeze({ start: null, end: null })

export interface DayRange {
  from: string
  to: string
}

export function orderedDayRange(a: string, b: string): DayRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

export function rangeWindowOf(range: OverviewRange, now: number): RangeWindow {
  if (range === 'all') return OPEN_WINDOW
  const start = rangeStartOf(range, now)
  return { start, end: null }
}

function rangeStartOf(range: Exclude<OverviewRange, 'all'>, now: number): number {
  if (range === 'today') {
    const midnight = new Date(now)
    midnight.setHours(0, 0, 0, 0)
    return midnight.getTime()
  }
  return now - (range === '7d' ? 7 : 30) * 86_400_000
}

export function dayRangeWindow(range: DayRange): RangeWindow | null {
  const ordered = orderedDayRange(range.from, range.to)
  const start = startOfDayKey(ordered.from)
  const end = endOfDayKey(ordered.to)
  if (start === null || end === null) return null
  return { start, end }
}

export type OverviewSort = 'recent' | 'tokens' | 'context'

export type TallyField = 'skills' | 'tools' | 'cmds'

export interface TallyStat {
  name: string
  n: number
  sessions: number
  last: number
}
