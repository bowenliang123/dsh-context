import { sql } from 'drizzle-orm'
import type { CostSource } from '../../cost'
import type { Db } from '../db'
import { events, requests, sessions, steps, surfaceNodes, timingSpans, toolCalls } from '../schema'
import type { SessionCostUsage } from '../../../shared/types'
import { mergeUsageMap, usageByFamily, usageBySession } from './costUsage'
import type { QueryScope } from './common'
import { dayRangeClause, windowOfScope } from './common'
import { rootWhere } from './filters'

export interface FamilyMember {
  id: string
  title: string
  origin: string | null
  running: boolean
  depth: number
  order: number
  billed_tokens: number
  subtree_billed_tokens: number
  calls: number
  subtree_calls: number
  cost_usd: number | null
  subtree_cost_usd: number | null
  fold_status: string
}

export interface FamilyValue {
  root_id: string
  partial: boolean
  members: FamilyMember[]
  billed_tokens: number
  calls: number
  cost_usd: number | null
}

interface FamilyRow {
  id: string
  parent_session: string | null
  title: string
  origin: string | null
  running: number
  depth: number
  billed_tokens: number
  fold_status: string
  created_at: number
}

export function queryFamily(db: Db, cost: CostSource, rootId: string): FamilyValue {
  const rows = db.all<FamilyRow>(sql`
    with recursive fam(id, depth, path) as (
      select id, 0, id from ${sessions} where id = ${rootId}
      union all
      select s.id, fam.depth + 1, fam.path || '/' || s.id
      from ${sessions} s join fam on s.parent_session = fam.id
      where s.origin = 'subagent' and fam.depth < 32 and instr(fam.path, s.id) = 0
    )
    select s.id as id, s.parent_session as parent_session, s.title as title, s.origin as origin,
      s.running as running, fam.depth as depth, s.billed_tokens as billed_tokens,
      s.fold_status as fold_status, s.created_at as created_at
    from fam join ${sessions} s on s.id = fam.id
    order by fam.depth asc, s.created_at asc, s.id asc
  `)
  if (rows.length === 0) {
    return { root_id: rootId, partial: false, members: [], billed_tokens: 0, calls: 0, cost_usd: null }
  }
  const ids = rows.map(row => row.id)
  const cutCalls = new Map<string, number>()
  for (const row of db.all<{ id: string; calls: number }>(sql`
    select r.session_id as id, count(*) as calls
    from ${requests} r join ${sessions} s on s.id = r.session_id
    where r.session_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
      and (s.seed_cut_seq is null or r.seq >= s.seed_cut_seq)
    group by r.session_id
  `)) cutCalls.set(row.id, row.calls)
  const usage = usageBySession(db, ids, false)
  const order = new Map(ids.map((id, index) => [id, index]))
  const members = rows.map((row): FamilyMember & { parent: string | null } => ({
    id: row.id,
    title: row.title,
    origin: row.origin,
    running: row.running === 1,
    depth: row.depth,
    order: order.get(row.id) as number,
    billed_tokens: row.billed_tokens,
    subtree_billed_tokens: row.billed_tokens,
    calls: cutCalls.get(row.id) as number,
    subtree_calls: cutCalls.get(row.id) as number,
    cost_usd: cost.usd(usage.get(row.id)),
    subtree_cost_usd: cost.usd(usage.get(row.id)),
    fold_status: row.fold_status,
    parent: row.parent_session,
  }))
  const byId = new Map(members.map(member => [member.id, member]))
  for (let index = members.length - 1; index >= 0; index--) {
    const member = members[index]
    if (member.id === rootId || member.parent === null) continue
    const parent = byId.get(member.parent) as FamilyMember
    parent.subtree_billed_tokens += member.subtree_billed_tokens
    parent.subtree_calls += member.subtree_calls
    if (parent.subtree_cost_usd !== null || member.subtree_cost_usd !== null) {
      parent.subtree_cost_usd = (parent.subtree_cost_usd ?? 0) + (member.subtree_cost_usd ?? 0)
    }
  }
  const root = byId.get(rootId)
  const partial = members.some(member => member.fold_status !== 'ok')
  return {
    root_id: rootId,
    partial,
    members: members.map(({ parent: _parent, ...member }) => member),
    billed_tokens: (root as FamilyMember).subtree_billed_tokens,
    calls: (root as FamilyMember).subtree_calls,
    cost_usd: (root as FamilyMember).subtree_cost_usd,
  }
}

export interface CostValue {
  usd: number | null
  ready: boolean
  faces?: unknown
  misses?: unknown
}

export function queryCost(
  db: Db,
  cost: CostSource,
  query: { scope?: QueryScope | null; sessionId?: string; family?: boolean },
): CostValue {
  let usage: SessionCostUsage | null = null
  if (typeof query.sessionId === 'string' && query.sessionId !== '') {
    const id = query.sessionId
    if (query.family === true) {
      const row = db.get<{ root: string }>(sql`select family_root as root from ${sessions} where id = ${id}`)
      if (row !== undefined) usage = usageByFamily(db, [row.root]).get(row.root) ?? null
    } else {
      usage = usageBySession(db, [id], false).get(id) ?? null
    }
  } else if (query.scope !== undefined && query.scope !== null) {
    const window = windowOfScope(query.scope)
    const roots = db.all<{ root: string }>(sql`
      select distinct family_root as root from ${sessions} where ${rootWhere(query.scope, window)}
    `).map(row => row.root)
    usage = mergeUsageMap(usageByFamily(db, roots, dayRangeClause(sql`r.day`, window) ?? sql`1 = 1`))
  }
  const read = cost.read(usage)
  if (read === undefined) return { usd: null, ready: cost.ready() }
  return {
    usd: read.usd,
    ready: read.ready,
    ...(read.faces === undefined ? {} : { faces: read.faces }),
    ...(read.misses === undefined ? {} : { misses: read.misses }),
  }
}

export function countRows(db: Db): Record<string, number> {
  const row = db.get(sql`
    select
      (select count(*) from ${sessions}) as sessions,
      (select count(*) from ${requests}) as requests,
      (select count(*) from ${steps}) as steps,
      (select count(*) from ${toolCalls}) as tool_calls,
      (select count(*) from ${surfaceNodes}) as surface_nodes,
      (select count(*) from ${events}) as events,
      (select count(*) from ${timingSpans}) as timing_spans
  `)
  const counts: Record<string, number> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) counts[key] = Number(value)
  return counts
}

export function foldStatusDistribution(db: Db): Record<string, number> {
  const rows = db.all<{ status: string; n: number }>(sql`
    select fold_status as status, count(*) as n from ${sessions} group by fold_status
  `)
  return Object.fromEntries(rows.map(row => [row.status, row.n]))
}
