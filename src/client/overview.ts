import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { dayKeyOf, endOfDayKey, startOfDayKey } from '../shared/days'
import { BACKFILL_ROUTE } from './apiRoutes'
import { billedParts, RING_ORDER } from './categories'
import { cacheHitPercent } from './format'
import { estimateSessionCost, mergeCostUsage } from './cost'
import type { CostCurrency, ModelBook } from './cost'
import { agentRowOf, familyChildrenOf, type AgentRow } from './agentTree'
import { activityOf, asRecord, costFullyQuantified, numOf, timelineOf, type ClientCtx, type SessionsFace } from './services'
import type { ActivityDay, ActivityTally, ContextActivity, ContextTimeline, DefaultOverviewRange, SessionCostUsage, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export interface OverviewRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  current: boolean
  archived: boolean
  timeline: ContextTimeline | null
  activity: ContextActivity | null
  family: (ContextTimeline | null)[]
  familyActivity?: (ContextActivity | null)[]
  familyCost: SessionCostUsage | null
}

function standardSnapshotOf(seat: unknown): unknown {
  if (typeof seat !== 'function') return null
  try {
    return (seat as <T>(selector: (snapshot: unknown) => T) => T)(snapshot => snapshot)
  } catch {
    return null
  }
}

export function sessionsSnapshotOf(props: { useSessions?: unknown }): unknown {
  return standardSnapshotOf(props.useSessions)
}

export function workspacesSnapshotOf(props: { useWorkspaces?: unknown }): unknown {
  return standardSnapshotOf(props.useWorkspaces)
}

export function sessionGroupsOf(snapshot: unknown): Record<string, string> | null {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return null
  const groups: Record<string, string> = {}
  const claimed: Record<string, string | undefined> = groups
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && claimed[id] === undefined) groups[id] = title
    }
  }
  return groups
}

export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

export const UNGROUPED_KEY = '__ungrouped__'

export interface GroupCount {
  key: string
  count: number
}

export function groupCountsOf(rows: readonly OverviewRow[], snapshot: unknown): GroupCount[] {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return []
  const claimed = new Map<string, string>()
  const titles: string[] = []
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = typeof workspace.title === 'string' && workspace.title !== '' ? workspace.title : undefined
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    titles.push(title)
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && !claimed.has(id)) claimed.set(id, title)
    }
  }
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    const title = claimed.get(row.id)
    if (title === undefined) ungrouped++
    else counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const groups: GroupCount[] = []
  for (const title of titles) {
    const count = counts.get(title) ?? 0
    if (count > 0) groups.push({ key: title, count })
  }
  if (ungrouped > 0) groups.push({ key: UNGROUPED_KEY, count: ungrouped })
  return groups
}

export function inGroup(row: OverviewRow, group: string, groups: Record<string, string> | null): boolean {
  const byId: Record<string, string | undefined> = groups ?? {}
  const title = byId[row.id]
  return group === UNGROUPED_KEY ? title === undefined : title === group
}

function archivedSetOf(workspaces: unknown): Set<string> {
  try {
    const value = asRecord(workspaces)?.archivedSessionIds
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

interface BaseRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  timeline: ContextTimeline | null
  activity: ContextActivity | null
}

const baseCache = new WeakMap<object, BaseRow>()

function baseRowOf(rec: Record<string, unknown>, id: string): BaseRow {
  const cached = baseCache.get(rec)
  if (cached !== undefined && cached.id === id) return cached
  const displayTitle = typeof rec.displayTitle === 'string' && rec.displayTitle !== '' ? rec.displayTitle : undefined
  const title = typeof rec.title === 'string' && rec.title !== '' ? rec.title : undefined
  const cwd = typeof rec.cwd === 'string' && rec.cwd !== '' ? rec.cwd : undefined
  const values = asRecord(rec.projectionValues)
  const row: BaseRow = {
    id,
    title: displayTitle ?? title ?? id,
    ...(cwd !== undefined ? { cwd } : {}),
    updatedAt: typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
    running: rec.running === true,
    timeline: timelineOf(values?.contextTimeline),
    activity: activityOf(values?.contextActivity),
  }
  baseCache.set(rec, row)
  return row
}

const variantCache = new WeakMap<BaseRow, Map<number, OverviewRow>>()

function childlessRowOf(base: BaseRow, current: boolean, archived: boolean): OverviewRow {
  const flags = (current ? 1 : 0) | (archived ? 2 : 0)
  let variants = variantCache.get(base)
  if (variants === undefined) {
    variants = new Map()
    variantCache.set(base, variants)
  }
  const hit = variants.get(flags)
  if (hit !== undefined) return hit
  const cost = base.timeline?.cost
  const row: OverviewRow = {
    ...base,
    current,
    archived,
    family: [base.timeline],
    familyActivity: [base.activity],
    familyCost: cost !== undefined && costFullyQuantified(cost) ? cost : mergeCostUsage(cost),
  }
  variants.set(flags, row)
  return row
}

export function rowsOfSnapshot(snapshot: unknown, workspaces?: unknown): OverviewRow[] | null {
  const state = asRecord(snapshot)
  if (state === null) return null
  if (!Array.isArray(state.ids)) return null
  const ids: string[] = state.ids.filter((id): id is string => typeof id === 'string')
  const archived = archivedSetOf(workspaces)
  const byId = asRecord(state.byId) ?? {}
  const current = typeof state.current === 'string' ? state.current : undefined
  const bases: BaseRow[] = []
  for (const id of ids) {
    try {
      const row = asRecord(byId[id])
      if (row === null) continue
      if (row.blank === true) continue
      if (row.origin === 'subagent') continue
      bases.push(baseRowOf(row, id))
    } catch {
    }
  }
  const sessionRows = new Map<string, AgentRow>()
  for (const id of Object.keys(byId)) {
    try {
      const row = agentRowOf(byId[id])
      if (row !== null && !row.blank) sessionRows.set(id, row)
    } catch {}
  }
  const childrenOf = familyChildrenOf(sessionRows)
  const rows: OverviewRow[] = []
  for (const base of bases) {
    const kids = childrenOf.get(base.id) ?? []
    if (kids.length === 0) {
      rows.push(childlessRowOf(base, base.id === current, archived.has(base.id)))
      continue
    }
    const row: OverviewRow = {
      ...base,
      current: base.id === current,
      archived: archived.has(base.id),
      family: [],
      familyCost: null,
    }
    const timelines: (ContextTimeline | null)[] = [row.timeline]
    const activities: (ContextActivity | null)[] = [row.activity]
    const queue = [row.id]
    for (let i = 0; i < queue.length; i++) {
      for (const kid of childrenOf.get(queue[i]) ?? []) {
        const values = kid.row.projections
        timelines.push(timelineOf(values?.contextTimeline))
        activities.push(activityOf(values?.contextActivity))
        queue.push(kid.id)
      }
    }
    row.family = timelines
    row.familyActivity = activities
    row.familyCost = mergeCostUsage(...timelines.map(t => t?.cost))
    row.activity = mergeActivity(activities)
    rows.push(row)
  }
  return rows
}

export type OverviewCoverage = 'all' | 'active' | 'archived'

export function coveredRowsOf(rows: readonly OverviewRow[], coverage: OverviewCoverage): readonly OverviewRow[] {
  return coverage === 'all' ? rows : rows.filter(row => row.archived === (coverage === 'archived'))
}

function addDayField(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

function mergeActivity(members: (ContextActivity | null)[]): ContextActivity | null {
  const days: ContextActivity['days'] = {}
  const byKey: Record<string, ContextActivity['days'][string] | undefined> = days
  let any = false
  for (const activity of members) {
    if (activity === null) continue
    any = true
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      const prev = byKey[key]
      if (prev === undefined) {
        days[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          ...(entry.cost !== undefined ? { cost: entry.cost } : {}),
          ...(entry.turns !== undefined ? { turns: entry.turns } : {}),
          ...(entry.toolCalls !== undefined ? { toolCalls: entry.toolCalls } : {}),
          ...(entry.toolsMs !== undefined ? { toolsMs: entry.toolsMs } : {}),
          ...(entry.wallMs !== undefined ? { wallMs: entry.wallMs } : {}),
          ...(entry.skills !== undefined ? { skills: entry.skills } : {}),
          ...(entry.tools !== undefined ? { tools: entry.tools } : {}),
          ...(entry.cmds !== undefined ? { cmds: entry.cmds } : {}),
        }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        const turns = addDayField(prev.turns, entry.turns)
        const toolCalls = addDayField(prev.toolCalls, entry.toolCalls)
        const toolsMs = addDayField(prev.toolsMs, entry.toolsMs)
        const wallMs = addDayField(prev.wallMs, entry.wallMs)
        if (turns !== undefined) prev.turns = turns
        if (toolCalls !== undefined) prev.toolCalls = toolCalls
        if (toolsMs !== undefined) prev.toolsMs = toolsMs
        if (wallMs !== undefined) prev.wallMs = wallMs
        if (entry.cost !== undefined) {
          /* v8 ignore next 1 */
          prev.cost = mergeCostUsage(prev.cost, entry.cost) ?? entry.cost
        }
        if (entry.skills !== undefined) prev.skills = mergeTallies(prev.skills, entry.skills)
        if (entry.tools !== undefined) prev.tools = mergeTallies(prev.tools, entry.tools)
        if (entry.cmds !== undefined) prev.cmds = mergeTallies(prev.cmds, entry.cmds)
      }
    }
  }
  return any ? { days } : null
}

function mergeTallies(a: Record<string, ActivityTally> | undefined, b: Record<string, ActivityTally>): Record<string, ActivityTally> {
  const out: Record<string, ActivityTally | undefined> = { ...a }
  for (const name of Object.keys(b)) {
    const tally = b[name]
    const prev = out[name]
    out[name] = prev === undefined ? tally : { n: prev.n + tally.n, last: Math.max(prev.last, tally.last) }
  }
  return out as Record<string, ActivityTally>
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

export function dayInScope(key: string, scope: RangeWindow): boolean {
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

export const OVERVIEW_PAGE_SIZE = 12

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

export type SkillSort = 'loads' | 'recent'

export type TallySort = 'count' | 'recent'

function dayPredicate(opts: { scope: RangeWindow; day: string | null }): (key: string) => boolean {
  if (opts.day !== null) return key => key === opts.day
  return key => dayInScope(key, opts.scope)
}

export function tallyStatsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; field: TallyField; sort?: TallySort },
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
  const out = [...stats.values()]
  return opts.sort === 'recent'
    ? out.sort((a, b) => (b.last - a.last) || (b.n - a.n) || byName(a, b))
    : out.sort((a, b) => (b.n - a.n) || (b.last - a.last) || byName(a, b))
}

export function skillLoadsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; sort?: SkillSort },
): TallyStat[] {
  return tallyStatsOf(rows, { ...opts, field: 'skills', sort: opts.sort === 'recent' ? 'recent' : 'count' })
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

export interface UsageTotals {
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

export interface WindowTotals {
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

export function timingSumOf(rows: readonly OverviewRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  let toolBusyComplete = true
  for (const row of rows) {
    for (const member of row.family) {
      const t = member?.timing
      if (t === undefined) continue
      if (t.toolBusyMs === undefined) toolBusyComplete = false
      if (out === null) {
        out = { ...t, tools: { ...t.tools } }
        continue
      }
      out.wallMs += t.wallMs
      out.ttftMs += t.ttftMs
      out.genMs += t.genMs
      out.calls += t.calls
      out.toolsMs += t.toolsMs
      out.toolCalls += t.toolCalls
      addOptionalOf(out, t, 'reasoningMs')
      addOptionalOf(out, t, 'reasoningBlocks')
      addOptionalOf(out, t, 'textMs')
      addOptionalOf(out, t, 'textBlocks')
      addOptionalOf(out, t, 'toolArgMs')
      addOptionalOf(out, t, 'toolArgBlocks')
      addOptionalOf(out, t, 'toolBusyMs')
      addOptionalOf(out, t, 'idleMs')
      addOptionalOf(out, t, 'speedTokens')
      addOptionalOf(out, t, 'speedMs')
      for (const name of Object.keys(t.tools)) {
        const tool = t.tools[name]
        const outTools: Record<string, ToolTimingTotals | undefined> = out.tools
        const prev = outTools[name]
        out.tools[name] = prev === undefined ? { ...tool } : { calls: prev.calls + tool.calls, ms: prev.ms + tool.ms }
      }
    }
  }
  if (out !== null && !toolBusyComplete) delete out.toolBusyMs
  return out
}

function addOptionalOf(target: TimingTotals, source: TimingTotals, key: OptionalTimingKey): void {
  const a = target[key]
  const b = source[key]
  if (a !== undefined || b !== undefined) target[key] = (a ?? 0) + (b ?? 0)
}

type OptionalTimingKey = 'reasoningMs' | 'reasoningBlocks' | 'textMs' | 'textBlocks'
  | 'toolArgMs' | 'toolArgBlocks' | 'toolBusyMs' | 'idleMs' | 'speedTokens' | 'speedMs'

export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

export function tokenPartsOf(
  rows: readonly OverviewRow[],
  scope?: RangeWindow,
): { parts: TokenPartTotal[]; total: number } | null {
  const sums = new Map<string, TokenPartTotal>()
  let total = 0
  let any = false
  for (const row of rows) {
    for (let index = 0; index < row.family.length; index++) {
      const member = row.family[index]
      if (member === null) continue
      const memberUsage = scope === undefined
        ? member.cost
        : row.familyActivity === undefined
          ? null
          : windowTotalsOf(row.familyActivity[index] ?? null, scope).usage
      const totals = usageTotalsOf(memberUsage)
      if (totals === null) continue
      any = true
      const usage: TokenUsage = {
        uncachedInputTokens: totals.input,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        outputTokens: totals.output,
      }
      for (const part of billedParts(member.current, null, usage, {
        reasoning: member.generatedReasoning,
        answers: member.generatedAnswerTokens,
        calls: member.generatedCallTokens,
      })) {
        if (!Number.isFinite(part.value) || part.value <= 0) continue
        total += part.value
        const sumsGet: Map<string, TokenPartTotal | undefined> = sums
        const prev = sumsGet.get(part.key)
        sums.set(part.key, prev === undefined
          ? { key: part.key, color: part.color, value: part.value }
          : { ...prev, value: prev.value + part.value })
      }
    }
  }
  if (!any) return null
  return { parts: [...sums.values()].sort((a, b) => RING_ORDER.indexOf(a.key) - RING_ORDER.indexOf(b.key)), total }
}

export interface OverviewKpis {
  sessions: number
  tokens: number
  turns: number
  cost: number | null
  costSessions: number
  cacheHit: string | null
  usageSessions: number
  tokenParts: { parts: TokenPartTotal[]; total: number } | null
  timing: TimingTotals | null
}

export function kpisOf(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  scope?: RangeWindow,
): OverviewKpis {
  let usage: SessionCostUsage | null = null
  let turns = 0
  let costSessions = 0
  let usageSessions = 0
  const open = scope === undefined || (scope.start === null && scope.end === null)
  for (const row of rows) {
    const windowTotals = scope !== undefined && row.activity !== null ? windowTotalsOf(row.activity, scope) : null
    const rowUsage = windowTotals !== null ? windowTotals.usage : open ? row.familyCost : null
    usage = mergeCostUsage(usage, rowUsage)
    if (windowTotals !== null && !open) turns += windowTotals.turns
    else if (open) {
      for (const member of row.family) turns += turnsOf(member)
    }
    if (estimateSessionCost(rowUsage, book, currency) !== null) costSessions++
    if (usageTotalsOf(rowUsage) !== null) usageSessions++
  }
  const totals = usageTotalsOf(usage)
  return {
    sessions: rows.length,
    tokens: totals?.total ?? 0,
    turns,
    cost: estimateSessionCost(usage, book, currency),
    costSessions,
    cacheHit: totals === null ? null : cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    usageSessions,
    tokenParts: tokenPartsOf(rows, scope),
    timing: timingSumOf(rows),
  }
}

export interface DayTotals {
  tokens: number
  requests: number
  sessions: number
  cost: number | null
}

export function aggregateDays(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): Record<string, DayTotals> {
  return new DayAggregator().aggregate(rows, book, currency)
}

interface MutableDay {
  tokens: number
  requests: number
  sessions: number
  cost: SessionCostUsage
}

function emptyCost(): SessionCostUsage {
  return {}
}

function addCost(target: SessionCostUsage, source: SessionCostUsage, sign: 1 | -1): void {
  for (const provider of Object.keys(source)) {
    const models = asRecord(source[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = target[provider] ?? (target[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const targetPeriods = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = targetPeriods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        const next = {
          uncached: prev.uncached + sign * numOf(bucket.uncached),
          cacheRead: prev.cacheRead + sign * numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + sign * numOf(bucket.cacheWrite),
          output: prev.output + sign * numOf(bucket.output),
        }
        const carried = numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output) > 0
        if (sign < 0 && carried && next.uncached === 0 && next.cacheRead === 0 && next.cacheWrite === 0 && next.output === 0) {
          Reflect.deleteProperty(targetPeriods, period)
          if (Object.keys(targetPeriods).length === 0) Reflect.deleteProperty(branch, model)
          if (Object.keys(branch).length === 0) Reflect.deleteProperty(target, provider)
        } else {
          targetPeriods[period] = next
        }
      }
    }
  }
}

export class DayAggregator {
  private readonly rows = new Map<OverviewRow, ContextActivity | null>()
  private readonly days = new Map<string, MutableDay>()
  private readonly values = new Map<string, DayTotals>()
  private lastRows: readonly OverviewRow[] | null = null
  private lastBook: ModelBook | null | undefined
  private lastCurrency: CostCurrency | undefined
  private last: Record<string, DayTotals> | null = null

  aggregate(
    rows: readonly OverviewRow[],
    book: ModelBook | null | undefined,
    currency: CostCurrency,
  ): Record<string, DayTotals> {
    if (rows === this.lastRows && book === this.lastBook && currency === this.lastCurrency && this.last !== null) {
      return this.last
    }
    const seen = new Set<OverviewRow>()
    let changed = false
    for (const row of rows) {
      seen.add(row)
      const prev = this.rows.get(row)
      if (prev === row.activity) continue
      if (prev !== undefined) this.addActivity(prev, -1)
      this.addActivity(row.activity, 1)
      this.rows.set(row, row.activity)
      changed = true
    }
    for (const [row, activity] of this.rows) {
      if (seen.has(row)) continue
      this.rows.delete(row)
      this.addActivity(activity, -1)
      changed = true
    }
    if (book !== this.lastBook || currency !== this.lastCurrency) {
      this.values.clear()
      this.lastBook = book
      this.lastCurrency = currency
      changed = true
    }
    if (!changed && this.last !== null) {
      this.lastRows = rows
      return this.last
    }
    const out: Record<string, DayTotals> = {}
    for (const [key, day] of this.days) {
      if (day.tokens <= 0 && day.requests <= 0) {
        this.days.delete(key)
        this.values.delete(key)
        continue
      }
      let value = this.values.get(key)
      if (value === undefined) {
        value = {
          tokens: day.tokens,
          requests: day.requests,
          sessions: day.sessions,
          cost: estimateSessionCost(day.cost, book, currency),
        }
        this.values.set(key, value)
      }
      out[key] = value
    }
    this.lastRows = rows
    this.last = out
    return out
  }

  private addActivity(activity: ContextActivity | null, sign: 1 | -1): void {
    if (activity === null) return
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      let day = this.days.get(key)
      if (day === undefined) {
        /* v8 ignore next 1 */
        if (sign < 0) continue
        day = { tokens: 0, requests: 0, sessions: 0, cost: emptyCost() }
        this.days.set(key, day)
      }
      day.tokens += sign * entry.tokens
      day.requests += sign * entry.requests
      day.sessions += sign
      if (entry.cost !== undefined) addCost(day.cost, entry.cost, sign)
      this.values.delete(key)
    }
  }
}

export function refreshSessions(ctx: ClientCtx): void {
  try {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.refresh !== 'function') return
    void Promise.resolve(sessions.refresh()).catch(() => {})
  } catch {}
}

export function requestActivityBackfill(): void {
  try {
    void fetch(BACKFILL_ROUTE, { method: 'POST' }).catch(() => {})
  } catch {}
}

export function relativeTime(t: (key: string, params?: Record<string, string | number>) => string, updatedAt: number, now: number): string {
  const diff = now - updatedAt
  if (!Number.isFinite(diff) || diff < 60_000) return t('ov.time.now')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('ov.time.m', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ov.time.h', { n: hours })
  return t('ov.time.d', { n: Math.floor(hours / 24) })
}
