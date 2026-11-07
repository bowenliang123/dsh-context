import { dayKeyOf, endOfDayKey, startOfDayKey } from '../shared/days'
import { mergeCostUsage } from './cost'
import type { OverviewRow } from './overviewModel'
import type { ActivityDay, ContextActivity, ContextTimeline, DefaultOverviewRange, SessionCostUsage } from '../shared/types'

export type OverviewCoverage = 'all' | 'active' | 'archived'

export function coveredRowsOf(rows: readonly OverviewRow[], coverage: OverviewCoverage): readonly OverviewRow[] {
  return coverage === 'all' ? rows : rows.filter(row => row.archived === (coverage === 'archived'))
}

export type OverviewRange = DefaultOverviewRange

export interface RangeWindow {
  start: number | null
  end: number | null
}

export const OPEN_WINDOW: RangeWindow = Object.freeze({ start: null, end: null })

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

function dayInScope(key: string, scope: RangeWindow): boolean {
  const floor = scope.start === null ? null : dayKeyOf(scope.start)
  const ceiling = scope.end === null ? null : dayKeyOf(scope.end)
  return (floor === null || key >= floor) && (ceiling === null || key <= ceiling)
}

function hasActivity(entry: ActivityDay): boolean {
  return entry.tokens > 0 || entry.requests > 0 || (entry.turns ?? 0) > 0
    || (entry.toolCalls ?? 0) > 0 || (entry.wallMs ?? 0) > 0 || entry.skills !== undefined
}

export type OverviewSort = 'recent' | 'tokens' | 'context'

export function billedOf(row: OverviewRow): number | null {
  const totals = usageTotalsOf(row.familyCost)
  return totals?.total ?? null
}

export function turnsOf(timeline: ContextTimeline | null): number {
  if (timeline === null) return 0
  return timeline.counts?.turns ?? timeline.requests.length
}

export function createdDayOf(activity: ContextActivity | null): string | undefined {
  const days = activity?.days
  if (days === undefined) return undefined
  let first: string | undefined
  for (const key of Object.keys(days)) {
    if (first === undefined || key < first) first = key
  }
  return first
}

export function filterRows(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; query: string },
): OverviewRow[] {
  const query = opts.query.trim().toLowerCase()
  const bounded = opts.scope.start !== null || opts.scope.end !== null
  return rows.filter((row) => {
    if (bounded) {
      let inScope = (opts.scope.start === null || row.updatedAt >= opts.scope.start)
        && (opts.scope.end === null || row.updatedAt <= opts.scope.end)
      if (!inScope) {
        const days = row.activity?.days
        if (days !== undefined) {
          for (const key of Object.keys(days)) {
            if (dayInScope(key, opts.scope) && hasActivity(days[key])) {
              inScope = true
              break
            }
          }
        }
      }
      if (!inScope) return false
    }
    if (opts.day !== null) {
      const entry = row.activity?.days[opts.day]
      if (entry === undefined || (entry.tokens <= 0 && entry.requests <= 0)) return false
    }
    if (query !== '') {
      const inTitle = row.title.toLowerCase().includes(query)
      const inCwd = row.cwd !== undefined && row.cwd.toLowerCase().includes(query)
      const lastUser = row.timeline?.lastUser
      const inLastUser = typeof lastUser === 'string' && lastUser.toLowerCase().includes(query)
      if (!inTitle && !inCwd && !inLastUser) return false
    }
    return true
  })
}

export function sortRows(rows: readonly OverviewRow[], sort: OverviewSort): OverviewRow[] {
  const copy = [...rows]
  if (sort === 'tokens') copy.sort((a, b) => (billedOf(b) ?? -1) - (billedOf(a) ?? -1))
  else if (sort === 'context') copy.sort((a, b) => (b.timeline?.current.total ?? -1) - (a.timeline?.current.total ?? -1))
  else copy.sort((a, b) => b.updatedAt - a.updatedAt)
  return copy
}

const OVERVIEW_PAGE_SIZE = 12

export function pageOf<T>(rows: readonly T[], page: number): { items: T[]; index: number; count: number } {
  const count = Math.max(1, Math.ceil(rows.length / OVERVIEW_PAGE_SIZE))
  const index = Math.min(Math.max(0, page), count - 1)
  return { items: rows.slice(index * OVERVIEW_PAGE_SIZE, (index + 1) * OVERVIEW_PAGE_SIZE), index, count }
}

export type TallyField = 'skills' | 'tools' | 'cmds'

export interface TallyStat {
  name: string
  n: number
  sessions: number
  last: number
}

function dayPredicate(opts: { scope: RangeWindow; day: string | null }): (key: string) => boolean {
  if (opts.day !== null) return key => key === opts.day
  return key => dayInScope(key, opts.scope)
}

export function tallyStatsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; field: TallyField },
): TallyStat[] {
  const admit = dayPredicate(opts)
  const stats = new Map<string, TallyStat>()
  for (const row of rows) {
    const days = row.activity?.days
    if (days === undefined) continue
    const rowHas = new Set<string>()
    for (const key of Object.keys(days)) {
      if (!admit(key)) continue
      const table = days[key][opts.field]
      if (table === undefined) continue
      for (const name of Object.keys(table)) {
        const tally = table[name]
        const prev = stats.get(name)
        if (prev === undefined) stats.set(name, { name, n: tally.n, sessions: 1, last: tally.last })
        else {
          prev.n += tally.n
          prev.last = Math.max(prev.last, tally.last)
          if (!rowHas.has(name)) prev.sessions += 1
        }
        rowHas.add(name)
      }
    }
  }
  const byName = (a: TallyStat, b: TallyStat): number => (a.name < b.name ? -1 : 1)
  return [...stats.values()].sort((a, b) => (b.n - a.n) || (b.last - a.last) || byName(a, b))
}

export function skillLoadsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null },
): TallyStat[] {
  return tallyStatsOf(rows, { ...opts, field: 'skills' })
}

export function rowHasTally(
  row: OverviewRow,
  field: TallyField,
  name: string,
  opts: { scope: RangeWindow; day: string | null },
): boolean {
  const admit = dayPredicate(opts)
  const days = row.activity?.days
  if (days === undefined) return false
  for (const key of Object.keys(days)) {
    if (admit(key) && days[key][field]?.[name] !== undefined) return true
  }
  return false
}

interface UsageTotals {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
}

export function usageTotalsOf(usage: SessionCostUsage | null | undefined): UsageTotals | null {
  if (usage === null || usage === undefined) return null
  const totals: UsageTotals = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0 }
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = usage[provider]
    for (const model of Object.keys(models)) {
      const periods = models[model]
      for (const period of ['peak', 'off'] as const) {
        const bucket = periods[period]
        if (bucket === undefined) continue
        totals.input += bucket.uncached
        totals.cacheRead += bucket.cacheRead
        totals.cacheWrite += bucket.cacheWrite
        totals.output += bucket.output
        any = true
      }
    }
  }
  if (!any) return null
  totals.total = totals.input + totals.cacheRead + totals.cacheWrite + totals.output
  return totals
}

interface WindowTotals {
  turns: number
  usage: SessionCostUsage | null
}

const windowTotals = new WeakMap<ContextActivity, Map<string, WindowTotals>>()

export function windowTotalsOf(activity: ContextActivity | null, scope: RangeWindow): WindowTotals {
  if (activity === null) return { turns: 0, usage: null }
  const key = `${scope.start === null ? 'open' : dayKeyOf(scope.start)}:${scope.end === null ? 'open' : dayKeyOf(scope.end)}`
  let byScope = windowTotals.get(activity)
  if (byScope === undefined) {
    byScope = new Map()
    windowTotals.set(activity, byScope)
  }
  const hit = byScope.get(key)
  if (hit !== undefined) return hit
  let turns = 0
  let usage: SessionCostUsage | null = null
  for (const [dayKey, day] of Object.entries(activity.days)) {
    if (!dayInScope(dayKey, scope)) continue
    turns += day.turns ?? 0
    if (day.cost !== undefined) usage = mergeCostUsage(usage, day.cost)
  }
  const totals = { turns, usage }
  byScope.set(key, totals)
  return totals
}
