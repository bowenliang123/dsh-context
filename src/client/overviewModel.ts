import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { BACKFILL_ROUTE, SNAPSHOT_ROUTE } from './apiRoutes'
import { agentRowOf, familyChildrenOf, type AgentRow } from './agentTree'
import { mergeCostUsage } from './cost'
import type { ClientCtx, SessionsFace } from './dshFaces'
import { postRoute } from './route'
import { seatOf } from './seats'
import { activityOf, asRecord, costFullyQuantified, timelineOf } from './wire'
import { stringOf } from '../shared/decode'
import type { ActivityTally, ContextActivity, ContextTimeline, SessionCostUsage } from '../shared/types'

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

type SnapshotSeat = (selector: (snapshot: unknown) => unknown) => unknown

const NO_SNAPSHOT: SnapshotSeat = () => null

function standardSnapshotOf(useSeat: unknown): unknown {
  const read = seatOf(useSeat, NO_SNAPSHOT)
  try {
    return read(snapshot => snapshot)
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

interface WorkspaceClaims {
  titles: string[]
  bySession: Map<string, string>
}

function workspaceClaimsOf(snapshot: unknown): WorkspaceClaims | null {
  const state = asRecord(snapshot)
  if (state === null || !Array.isArray(state.items)) return null
  const claims: WorkspaceClaims = { titles: [], bySession: new Map() }
  for (const item of state.items) {
    const workspace = asRecord(item)
    if (workspace === null) continue
    const title = stringOf(workspace.title)
    if (title === undefined || !Array.isArray(workspace.sessionIds)) continue
    claims.titles.push(title)
    for (const id of workspace.sessionIds) {
      if (typeof id === 'string' && !claims.bySession.has(id)) claims.bySession.set(id, title)
    }
  }
  return claims
}

export function sessionGroupsOf(snapshot: unknown): Record<string, string> | null {
  const claims = workspaceClaimsOf(snapshot)
  return claims === null ? null : Object.fromEntries(claims.bySession)
}

export function projectOf(cwd: string | undefined): string | undefined {
  if (cwd === undefined || cwd === '') return undefined
  const title = workspaceTitleOf(cwd)
  return title === '' ? undefined : title
}

export const UNGROUPED_KEY = '__ungrouped__'

interface GroupCount {
  key: string
  count: number
}

export function groupCountsOf(rows: readonly OverviewRow[], snapshot: unknown): GroupCount[] {
  const claims = workspaceClaimsOf(snapshot)
  if (claims === null) return []
  const counts = new Map<string, number>()
  let ungrouped = 0
  for (const row of rows) {
    const title = claims.bySession.get(row.id)
    if (title === undefined) ungrouped++
    else counts.set(title, (counts.get(title) ?? 0) + 1)
  }
  const groups: GroupCount[] = []
  for (const title of claims.titles) {
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

interface BaseCacheEntry {
  row: BaseRow
  batch: unknown
}

const baseCache = new WeakMap<object, BaseCacheEntry>()

export type OverviewBatch = ReadonlyMap<string, { contextTimeline?: unknown; contextActivity?: unknown }>

const BATCH_KEYS = ['contextTimeline', 'contextActivity'] as const

function valuesWithBatch(
  values: Record<string, unknown> | null | undefined,
  id: string,
  batched: OverviewBatch | undefined,
): Record<string, unknown> | undefined {
  const fill = batched?.get(id)
  if (fill === undefined) return values ?? undefined
  const merged: Record<string, unknown> = { ...values }
  for (const key of BATCH_KEYS) {
    if (merged[key] === undefined && fill[key] !== undefined) merged[key] = fill[key]
  }
  return merged
}

function baseRowOf(rec: Record<string, unknown>, id: string, batched: OverviewBatch | undefined): BaseRow {
  const cached = baseCache.get(rec)
  if (cached !== undefined && cached.batch === batched && cached.row.id === id) return cached.row
  const displayTitle = typeof rec.displayTitle === 'string' && rec.displayTitle !== '' ? rec.displayTitle : undefined
  const title = typeof rec.title === 'string' && rec.title !== '' ? rec.title : undefined
  const cwd = typeof rec.cwd === 'string' && rec.cwd !== '' ? rec.cwd : undefined
  const values = valuesWithBatch(asRecord(rec.projectionValues), id, batched)
  const row: BaseRow = {
    id,
    title: displayTitle ?? title ?? id,
    ...(cwd !== undefined ? { cwd } : {}),
    updatedAt: typeof rec.updatedAt === 'number' && Number.isFinite(rec.updatedAt) ? rec.updatedAt : 0,
    running: rec.running === true,
    timeline: timelineOf(values?.contextTimeline),
    activity: activityOf(values?.contextActivity),
  }
  baseCache.set(rec, { row, batch: batched })
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

export function rowsOfSnapshot(
  snapshot: unknown,
  workspaces?: unknown,
  batched?: OverviewBatch,
): OverviewRow[] | null {
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
      bases.push(baseRowOf(row, id, batched))
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
        const values = valuesWithBatch(kid.row.projections, kid.id, batched)
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

function overviewBatchOf(value: unknown): OverviewBatch | null {
  if (Array.isArray(value)) return null
  const data = asRecord(value)
  const batch: [string, { contextTimeline?: unknown; contextActivity?: unknown }][] = []
  for (const id of Object.keys(data ?? {})) {
    const entry = asRecord(data?.[id])
    if (entry !== null && Object.keys(entry).length > 0) batch.push([id, entry])
  }
  return new Map(batch)
}

export async function fetchOverviewBatch(): Promise<OverviewBatch> {
  const batch = await postRoute(SNAPSHOT_ROUTE, {}, overviewBatchOf, { label: 'snapshot' })
  return batch ?? new Map()
}
