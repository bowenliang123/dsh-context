/** The Insights page's data layer over the root-scope `useSessions` snapshot: each row already carries
 * the host's projections and folds its whole descendant subtree (subagent-origin rows never list). */

import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { dayKeyOf, endOfDayKey, startOfDayKey } from '../shared/days'
import { BACKFILL_ROUTE } from './apiRoutes'
import { billedParts } from './categories'
import { cacheHitPercent } from './format'
import { estimateSessionCost, mergeCostUsage, BOOK_PREFS } from './cost'
import type { CostCurrency, CostPrefs, ModelBook } from './cost'
import { agentRowOf, familyChildrenOf, type AgentRow } from './agentTree'
import { activityOf, asRecord, timelineOf, type ClientCtx, type SessionsFace } from './services'
import type { ActivityDay, ContextActivity, ContextTimeline, DefaultOverviewRange, SessionCostUsage, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export interface OverviewRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  current: boolean
  archived: boolean
  timeline: ContextTimeline | null
  /** The TEAM's merged daily ledger: this session's own plus every descendant subagent's. */
  activity: ContextActivity | null
  /** Every subtree member's sanitized head, self first; each part split proportions its own composition. */
  family: (ContextTimeline | null)[]
  /** Every subtree member's daily ledger, self first and aligned with {@link family}. */
  familyActivity?: (ContextActivity | null)[]
  familyCost: SessionCostUsage | null
}

/** Hook-order safe: the seat runs unconditionally at the top of the panel; the identity selector keeps
 * the snapshot reference-stable for useMemo. */
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

/** Session id → claiming workspace title; an unclaimed session has no group ("Ungrouped" is not a name to print). */
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

/** The card's project name: the workspace browser's own basename derivation (both separators). */
export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

/** The group-filter chip key of the ungrouped bucket; a title can never collide (the registry dedupes names). */
export const UNGROUPED_KEY = '__ungrouped__'

export interface GroupCount {
  key: string
  count: number
}

/** The group chips' counts, in registry order with the ungrouped bucket last, over the already-scoped rows; a group with no scoped row
 * drops out. */
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

/** Fail open: an unreadable registry tags nothing, so every row keeps its pane scope. */
function archivedSetOf(workspaces: unknown): Set<string> {
  try {
    const value = asRecord(workspaces)?.archivedSessionIds
    if (!Array.isArray(value)) return new Set()
    return new Set(value.filter((id): id is string => typeof id === 'string'))
  } catch {
    return new Set()
  }
}

/** Null = an unusable snapshot (distinct from a real empty list); blank rows drop out; one throwing row costs just itself. */
export function rowsOfSnapshot(snapshot: unknown, workspaces?: unknown): OverviewRow[] | null {
  const state = asRecord(snapshot)
  if (state === null) return null
  if (!Array.isArray(state.ids)) return null
  const ids: string[] = state.ids.filter((id): id is string => typeof id === 'string')
  const archived = archivedSetOf(workspaces)
  const byId = asRecord(state.byId) ?? {}
  const current = typeof state.current === 'string' ? state.current : undefined
  const rows: OverviewRow[] = []
  for (const id of ids) {
    try {
      const row = asRecord(byId[id])
      if (row === null) continue
      if (row.blank === true) continue
      // Subagent-origin sessions cannot be addressed by a plain open() (the host demands the parent address), so they never list.
      if (row.origin === 'subagent') continue
      const displayTitle = typeof row.displayTitle === 'string' && row.displayTitle !== '' ? row.displayTitle : undefined
      const title = typeof row.title === 'string' && row.title !== '' ? row.title : undefined
      const cwd = typeof row.cwd === 'string' && row.cwd !== '' ? row.cwd : undefined
      const values = asRecord(row.projectionValues)
      rows.push({
        id,
        title: displayTitle ?? title ?? id,
        ...(cwd !== undefined ? { cwd } : {}),
        updatedAt: typeof row.updatedAt === 'number' && Number.isFinite(row.updatedAt) ? row.updatedAt : 0,
        running: row.running === true,
        current: id === current,
        archived: archived.has(id),
        timeline: timelineOf(values?.contextTimeline),
        activity: activityOf(values?.contextActivity),
        family: [],
        familyCost: null,
      })
    } catch {
      // A hostile row (throwing accessor) drops whole; the list keeps working.
    }
  }
  // The Context tab's own family edges (agentTree familyChildrenOf): a fork seed's source lineage stays out of its family.
  const sessionRows = new Map<string, AgentRow>()
  for (const id of Object.keys(byId)) {
    try {
      const row = agentRowOf(byId[id])
      if (row !== null && !row.blank) sessionRows.set(id, row)
    } catch { /* the hostile row links nobody */ }
  }
  const childrenOf = familyChildrenOf(sessionRows)
  for (const row of rows) {
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
  }
  return rows
}

export type OverviewCoverage = 'all' | 'active' | 'archived'

/** One shared coverage pass so the cards can never disagree with the grid on which sessions count. */
export function coveredRowsOf(rows: readonly OverviewRow[], coverage: OverviewCoverage): readonly OverviewRow[] {
  return coverage === 'all' ? rows : rows.filter(row => row.archived === (coverage === 'archived'))
}

/** Sum a pair of additive-optional day figures; both absent stays absent. */
function addDayField(a: number | undefined, b: number | undefined): number | undefined {
  return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0)
}

/** Per day the counters and timing totals sum, the pricing records merge, and the skill tables merge name by name. */
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
          /* v8 ignore next 1 -- a merge with a defined input never comes back empty. */
          prev.cost = mergeCostUsage(prev.cost, entry.cost) ?? entry.cost
        }
        if (entry.skills !== undefined) prev.skills = mergeSkillTallies(prev.skills, entry.skills)
      }
    }
  }
  return any ? { days } : null
}

function mergeSkillTallies(a: ActivityDay['skills'], b: NonNullable<ActivityDay['skills']>): NonNullable<ActivityDay['skills']> {
  const out: Record<string, { n: number; last: number } | undefined> = { ...a }
  for (const name of Object.keys(b)) {
    const tally = b[name]
    const prev = out[name]
    out[name] = prev === undefined ? tally : { n: prev.n + tally.n, last: Math.max(prev.last, tally.last) }
  }
  return out as NonNullable<ActivityDay['skills']>
}

export type OverviewRange = DefaultOverviewRange

/** A resolved scope window: inclusive epoch-ms bounds; null = an open end (the presets pin only the start). */
export interface RangeWindow {
  start: number | null
  end: number | null
}

/** The open window (the "all" preset), frozen because it is handed to every scope reader. */
export const OPEN_WINDOW: RangeWindow = Object.freeze({ start: null, end: null })

/** A calendar-picked range: two inclusive local day keys, always ordered, so no reader can see a reversed range. */
export interface DayRange {
  from: string
  to: string
}

export function orderedDayRange(a: string, b: string): DayRange {
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

/** The preset's window in epoch ms; "today" opens on local midnight (date-field arithmetic keeps DST days exact). */
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

/** Day-granular on purpose: a preset's rolling floor admits its whole local day, because the ledger cannot split one. */
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

/** The ledger's earliest key stands in for a creation date (list rows carry none). */
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
    // A bounded scope admits on either signal: a ledger day in the window, or a last prompt in it; the KPI
    // then sums only the ledger days.
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

export interface SkillLoadStat {
  name: string
  loads: number
  sessions: number
  last: number
}

export type SkillSort = 'loads' | 'recent'

function skillDayPredicate(opts: { scope: RangeWindow; day: string | null }): (key: string) => boolean {
  if (opts.day !== null) return key => key === opts.day
  return key => dayInScope(key, opts.scope)
}

/** The skill card's data: every scoped row's family ledger folded name by name over the admitted days. */
export function skillLoadsOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null; sort?: SkillSort },
): SkillLoadStat[] {
  const admit = skillDayPredicate(opts)
  const stats = new Map<string, SkillLoadStat>()
  for (const row of rows) {
    const days = row.activity?.days
    if (days === undefined) continue
    // A row counts once per name toward the loader tally, however many of its admitted days carry the name.
    const rowLoaded = new Set<string>()
    for (const key of Object.keys(days)) {
      if (!admit(key)) continue
      const skills = days[key].skills
      if (skills === undefined) continue
      for (const name of Object.keys(skills)) {
        const tally = skills[name]
        const prev = stats.get(name)
        if (prev === undefined) stats.set(name, { name, loads: tally.n, sessions: 1, last: tally.last })
        else {
          prev.loads += tally.n
          prev.last = Math.max(prev.last, tally.last)
          if (!rowLoaded.has(name)) prev.sessions += 1
        }
        rowLoaded.add(name)
      }
    }
  }
  // Names are map keys, so the name tiebreak never ties.
  const byName = (a: SkillLoadStat, b: SkillLoadStat): number => (a.name < b.name ? -1 : 1)
  const out = [...stats.values()]
  switch (opts.sort ?? 'loads') {
    case 'recent': return out.sort((a, b) => (b.last - a.last) || (b.loads - a.loads) || byName(a, b))
    default: return out.sort((a, b) => (b.loads - a.loads) || (b.last - a.last) || byName(a, b))
  }
}

export function rowLoadedSkill(
  row: OverviewRow,
  name: string,
  opts: { scope: RangeWindow; day: string | null },
): boolean {
  const admit = skillDayPredicate(opts)
  const days = row.activity?.days
  if (days === undefined) return false
  for (const key of Object.keys(days)) {
    if (admit(key) && days[key].skills?.[name] !== undefined) return true
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

/** Null (not zero) when no side carried a bucket record, so the caller's cells keep their dash rather than a fabricated zero. */
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
  requests: number
  turns: number
  toolCalls: number
  toolsMs: number
  wallMs: number
  usage: SessionCostUsage | null
}

export function windowTotalsOf(activity: ContextActivity | null, scope: RangeWindow): WindowTotals {
  let requests = 0
  let turns = 0
  let toolCalls = 0
  let toolsMs = 0
  let wallMs = 0
  let usage: SessionCostUsage | null = null
  if (activity !== null) {
    for (const [key, day] of Object.entries(activity.days)) {
      if (!dayInScope(key, scope)) continue
      requests += day.requests
      turns += day.turns ?? 0
      toolCalls += day.toolCalls ?? 0
      toolsMs += day.toolsMs ?? 0
      wallMs += day.wallMs ?? 0
      if (day.cost !== undefined) usage = mergeCostUsage(usage, day.cost)
    }
  }
  return { requests, turns, toolCalls, toolsMs, wallMs, usage }
}

export function timingSumOf(rows: readonly OverviewRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  for (const row of rows) {
    const t = row.timeline?.timing
    if (t === undefined) continue
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
    addOptionalOf(out, t, 'speedTokens')
    addOptionalOf(out, t, 'speedMs')
    for (const name of Object.keys(t.tools)) {
      const tool = t.tools[name]
      const outTools: Record<string, ToolTimingTotals | undefined> = out.tools
      const prev = outTools[name]
      out.tools[name] = prev === undefined ? { ...tool } : { calls: prev.calls + tool.calls, ms: prev.ms + tool.ms }
    }
  }
  return out
}

/** One additive-optional timing field's in-place merge; absent on both sides stays absent, never a materialized undefined. */
function addOptionalOf(target: TimingTotals, source: TimingTotals, key: OptionalTimingKey): void {
  const a = target[key]
  const b = source[key]
  if (a !== undefined || b !== undefined) target[key] = (a ?? 0) + (b ?? 0)
}

type OptionalTimingKey = 'reasoningMs' | 'reasoningBlocks' | 'textMs' | 'textBlocks'
  | 'toolArgMs' | 'toolArgBlocks' | 'speedTokens' | 'speedMs'

export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

/** Each member's parts total its own billed figure, so the aggregate stays the exact merged volume;
 * with a scope usage comes from the ledger's admitted days, else the lifetime head. */
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
      for (const part of billedParts(member.current, null, usage)) {
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
  return { parts: [...sums.values()], total }
}

export interface OverviewKpis {
  sessions: number
  tokens: number
  turns: number
  cost: number | null
  costSessions: number
  cacheHit: string | null
  usageSessions: number
  toolCalls: number
  toolsMs: number
  calls: number
  wallMs: number
  tokenParts: { parts: TokenPartTotal[]; total: number } | null
  timing: TimingTotals | null
  /** The merged billed usage behind `cost` (the breakdown disclosure's source). */
  usage: SessionCostUsage | null
}

export function kpisOf(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  scope?: RangeWindow,
  prefs: CostPrefs = BOOK_PREFS,
): OverviewKpis {
  // Every figure folds the SAME daily ledger over the window; the lifetime heads serve only no-scope (or no-ledger) callers.
  let usage: SessionCostUsage | null = null
  let turns = 0
  let toolCalls = 0
  let toolsMs = 0
  let calls = 0
  let wallMs = 0
  let costSessions = 0
  let usageSessions = 0
  const open = scope === undefined || (scope.start === null && scope.end === null)
  for (const row of rows) {
    const windowTotals = scope !== undefined && row.activity !== null ? windowTotalsOf(row.activity, scope) : null
    const rowUsage = windowTotals !== null ? windowTotals.usage : open ? row.familyCost : null
    usage = mergeCostUsage(usage, rowUsage)
    if (windowTotals !== null) {
      turns += windowTotals.turns
      toolCalls += windowTotals.toolCalls
      toolsMs += windowTotals.toolsMs
      calls += windowTotals.requests
      wallMs += windowTotals.wallMs
    } else if (open) {
      const timing = row.timeline?.timing
      turns += turnsOf(row.timeline)
      toolCalls += timing?.toolCalls ?? 0
      toolsMs += timing?.toolsMs ?? 0
      calls += timing?.calls ?? 0
      wallMs += timing?.wallMs ?? 0
    }
    // Each sub-line counts the sessions its own figure covers: a session with usage but no book rates feeds the cache-hit rate.
    if (estimateSessionCost(rowUsage, book, currency, prefs) !== null) costSessions++
    if (usageTotalsOf(rowUsage) !== null) usageSessions++
  }
  const totals = usageTotalsOf(usage)
  return {
    sessions: rows.length,
    tokens: totals?.total ?? 0,
    turns,
    cost: estimateSessionCost(usage, book, currency, prefs),
    usage,
    costSessions,
    cacheHit: totals === null ? null : cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    usageSessions,
    toolCalls,
    toolsMs,
    calls,
    wallMs,
    tokenParts: tokenPartsOf(rows, scope),
    timing: timingSumOf(rows),
  }
}

export interface DayTotals {
  tokens: number
  requests: number
  sessions: number
  /** The day's estimated spend; null when nothing priced — no pricing record, no book, or no priced model. */
  cost: number | null
}

/** A day counts only when the family entry carries activity (mirrors the day filter); prices off the KPI band's book. */
export function aggregateDays(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  prefs: CostPrefs = BOOK_PREFS,
): Record<string, DayTotals> {
  const merged: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] }> = {}
  const byKey: Record<string, { tokens: number; requests: number; sessions: number; fees: SessionCostUsage[] } | undefined> = merged
  for (const row of rows) {
    if (row.activity === null) continue
    for (const key of Object.keys(row.activity.days)) {
      const entry = row.activity.days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      const prev = byKey[key]
      if (prev === undefined) {
        merged[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          sessions: 1,
          fees: entry.cost !== undefined ? [entry.cost] : [],
        }
      } else {
        prev.tokens += entry.tokens
        prev.requests += entry.requests
        prev.sessions++
        if (entry.cost !== undefined) prev.fees.push(entry.cost)
      }
    }
  }
  const days: Record<string, DayTotals> = {}
  for (const [key, day] of Object.entries(merged)) {
    days[key] = {
      tokens: day.tokens,
      requests: day.requests,
      sessions: day.sessions,
      cost: estimateSessionCost(mergeCostUsage(...day.fees), book, currency, prefs),
    }
  }
  return days
}

/** Re-pull the session-list baseline so host-side projection backfills (host/backfill.ts) reach a long-connected browser. */
export function refreshSessions(ctx: ClientCtx): void {
  try {
    const sessions = ctx.get('sessions') as SessionsFace | undefined
    if (sessions === undefined || typeof sessions.refresh !== 'function') return
    void Promise.resolve(sessions.refresh()).catch(() => { /* a failed re-pull keeps the stale rows */ })
  } catch { /* hostile service — no refresh */ }
}

/** The rows' only reader, so the host defers its corpus-wide cold reads (host/backfill.ts) until this page first opens. */
export function requestActivityBackfill(): void {
  try {
    void fetch(BACKFILL_ROUTE, { method: 'POST' }).catch(() => { /* the rows arrive on a later open */ })
  } catch { /* hostile transport — the panel keeps its rows */ }
}

/** A future or invalid timestamp reads as "just now" (clock skew is not an error worth a dash). */
export function relativeTime(t: (key: string, params?: Record<string, string | number>) => string, updatedAt: number, now: number): string {
  const diff = now - updatedAt
  if (!Number.isFinite(diff) || diff < 60_000) return t('ov.time.now')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('ov.time.m', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('ov.time.h', { n: hours })
  return t('ov.time.d', { n: Math.floor(hours / 24) })
}
