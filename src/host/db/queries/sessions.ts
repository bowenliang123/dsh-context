import type { CostSource } from '../../cost'
import type { Db } from '../db'
import { sessions } from '../schema'
import { sql } from 'drizzle-orm'
import type { Coverage } from '../scheduler'
import { contextParts, familyAggregates, rootRows, selfAggregates, type FamilyAggregate, type RootRow } from './filters'
import { usageByFamily, usageBySession } from './costUsage'
import type { QueryScope } from './common'

export interface SessionRow {
  id: string
  title: string
  cwd: string | null
  archived: boolean
  running: boolean
  workspace_title: string | null
  updated_at: number
  created_at: number
  billed_tokens: number
  family_billed_tokens: number
  family_partial: boolean
  cur_total: number
  cur_parts: { key: string; value: number }[]
  cost_usd: number | null
  family_cost_usd: number | null
  turns: number
  steps: number
  created_day: string | null
  model: string | null
  context_window: number | null
  max_output_tokens: number | null
  last_user: string | null
  parent_session: string | null
  origin: string | null
  family_root: string
  fold_status: string
}

export interface GroupCount {
  key: string
  count: number
}

export interface SessionsValue {
  items: SessionRow[]
  total: number
  scope_total: number
  groups: GroupCount[]
  coverage: Coverage
}

export interface SessionsQuery {
  scope: QueryScope
  sort: 'recent' | 'tokens' | 'context'
  page: number
  pageSize: number
  ids?: string[]
}

const PAGE_SIZE = 12

function rowOf(
  root: RootRow,
  family: { tokens: number; createdDay: string | null; partial: number } | undefined,
  self: { turns: number; steps: number } | undefined,
  parts: ReturnType<typeof contextParts> extends Map<string, infer T> ? T | undefined : never,
  costUsd: number | null,
  familyCostUsd: number | null,
): SessionRow {
  const current = parts as NonNullable<typeof parts>
  const curTotal = current.system + current.tools + current.user + current.inject
    + current.skill + current.assistant + current.tool
  return {
    id: root.id,
    title: root.title,
    cwd: root.cwd,
    archived: root.archived === 1,
    running: root.running === 1,
    workspace_title: root.workspaceTitle,
    updated_at: root.updatedAt,
    created_at: root.createdAt,
    billed_tokens: root.billedTokens,
    family_billed_tokens: family?.tokens ?? root.billedTokens,
    family_partial: (family?.partial ?? 0) > 0 || root.foldStatus !== 'ok',
    cur_total: curTotal,
    cur_parts: [
      { key: 'system', value: current.system },
      { key: 'tools', value: current.tools },
      { key: 'user', value: current.user },
      { key: 'inject', value: current.inject },
      { key: 'skill', value: current.skill },
      { key: 'assistant', value: current.assistant },
      { key: 'tool', value: current.tool },
    ].filter(part => part.value > 0),
    cost_usd: costUsd,
    family_cost_usd: familyCostUsd,
    turns: (self as NonNullable<typeof self>).turns,
    steps: (self as NonNullable<typeof self>).steps,
    created_day: family?.createdDay ?? root.createdDay,
    model: root.model,
    context_window: root.contextWindow,
    max_output_tokens: root.maxOutputTokens,
    last_user: root.lastUser,
    parent_session: root.parentSession,
    origin: root.origin,
    family_root: root.familyRoot,
    fold_status: root.foldStatus,
  }
}

function sortRows(rows: SessionRow[], sort: SessionsQuery['sort']): SessionRow[] {
  const copy = [...rows]
  if (sort === 'tokens') copy.sort((left, right) => right.family_billed_tokens - left.family_billed_tokens)
  else if (sort === 'context') copy.sort((left, right) => right.cur_total - left.cur_total)
  else copy.sort((left, right) => right.updated_at - left.updated_at)
  return copy
}

function groupsOf(db: Db, scope: QueryScope): GroupCount[] {
  const rows = rootRows(db, { ...scope, group: undefined, pick: undefined })
  const counts = new Map<string, number>()
  for (const row of rows) {
    const key = row.workspaceTitle ?? '__ungrouped__'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => ({ key, count }))
}

export function querySessions(db: Db, cost: CostSource, query: SessionsQuery, coverage: Coverage): SessionsValue {
  if (query.ids !== undefined) {
    const ids = query.ids.slice(0, 256)
    if (ids.length === 0) return { items: [], total: 0, scope_total: 0, groups: [], coverage }
    const placeholders = sql.join(ids.map(id => sql`${id}`), sql`, `)
    const roots = db.all<RootRow>(sql`
      select id, family_root as familyRoot, created_at as createdAt, updated_at as updatedAt,
        created_day as createdDay, title, cwd, archived, running, workspace_title as workspaceTitle,
        billed_tokens as billedTokens, cur_total as curTotal, model, context_window as contextWindow,
        max_output_tokens as maxOutputTokens, last_user as lastUser, parent_session as parentSession,
        origin, fold_status as foldStatus, blank
      from ${sessions} where id in (${placeholders})
    `)
    const byId = new Map(roots.map(row => [row.id, row]))
    const ordered = ids.map(id => byId.get(id)).filter((row): row is RootRow => row !== undefined)
    return { items: buildRows(db, cost, ordered, false), total: ordered.length, scope_total: ordered.length, groups: [], coverage }
  }
  const scopeTotal = rootRows(db, { ...query.scope, group: undefined, pick: undefined }).length
  const groups = groupsOf(db, query.scope)
  const roots = rootRows(db, query.scope)
  const rows = sortRows(buildRows(db, cost, roots, true), query.sort)
  const count = Math.max(1, Math.ceil(rows.length / query.pageSize))
  const index = Math.min(Math.max(0, query.page), count - 1)
  const start = index * query.pageSize
  return {
    items: rows.slice(start, start + query.pageSize),
    total: rows.length,
    scope_total: scopeTotal,
    groups,
    coverage,
  }
}

function buildRows(db: Db, cost: CostSource, roots: readonly RootRow[], familyValues: boolean): SessionRow[] {
  const ids = roots.map(row => row.id)
  const families = [...new Set(roots.map(row => row.familyRoot))]
  const self = selfAggregates(db, ids)
  const family = familyValues ? familyAggregates(db, families) : new Map<string, FamilyAggregate>()
  const parts = contextParts(db, ids)
  const ownUsage = usageBySession(db, ids)
  const familyUsage = familyValues ? usageByFamily(db, families) : new Map<string, import('../../../shared/types').SessionCostUsage>()
  return roots.map(root => rowOf(
    root,
    family.get(root.familyRoot),
    self.get(root.id),
    parts.get(root.id) as never,
    cost.usd(ownUsage.get(root.id) ?? null),
    cost.usd(familyUsage.get(root.familyRoot) ?? null),
  ))
}

export { PAGE_SIZE }
