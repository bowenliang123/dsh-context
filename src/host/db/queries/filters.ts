import { and, sql, type SQL } from 'drizzle-orm'
import { headerEpochs, headerTools, requests, sessions, skillLoads, steps, surfaceNodes, systemPrompts, toolCalls } from '../schema'
import type { Db } from '../db'
import { dayRangeClause, likePattern, timeRangeClause, windowOfScope, type QueryScope, type QueryWindow } from './common'

export function rootWhere(scope: QueryScope, window: QueryWindow): SQL {
  const conditions: SQL[] = [sql`${sessions.origin} is null`, sql`${sessions.blank} = 0`]
  if (scope.coverage === 'active') conditions.push(sql`${sessions.archived} = 0`)
  else if (scope.coverage === 'archived') conditions.push(sql`${sessions.archived} = 1`)
  if (scope.group === '__ungrouped__') conditions.push(sql`${sessions.workspaceTitle} is null`)
  else if (scope.group !== undefined) conditions.push(sql`${sessions.workspaceTitle} = ${scope.group}`)
  if (scope.query !== undefined && scope.query !== '') {
    conditions.push(sql`${sessions.searchText} like ${likePattern(scope.query)} escape '\\'`)
  }
  if (scope.model !== undefined) conditions.push(sql`${sessions.model} = ${scope.model}`)
  if (scope.running !== undefined) conditions.push(sql`${sessions.running} = ${scope.running ? 1 : 0}`)
  const dayClause = window.all ? undefined : dayRangeClause(sql`r.day`, window)
  const timeClause = timeRangeClause(sql`${sessions.updatedAt}`, window)
  if (scope.day !== undefined) {
    conditions.push(sql`
      exists(select 1 from ${requests} r join ${sessions} x on x.id = r.session_id
        where x.family_root = ${sessions.familyRoot} and r.day = ${scope.day}
          and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq))
    `)
  } else if (!window.all) {
    const facts: SQL[] = [
      sql`exists(select 1 from ${requests} r join ${sessions} x on x.id = r.session_id
        where x.family_root = ${sessions.familyRoot} and ${dayClause}
          and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq))`,
      sql`exists(select 1 from ${steps} r join ${sessions} x on x.id = r.session_id
        where x.family_root = ${sessions.familyRoot} and ${dayClause}
          and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq))`,
      sql`exists(select 1 from ${toolCalls} r join ${sessions} x on x.id = r.session_id
        where x.family_root = ${sessions.familyRoot} and ${dayClause}
          and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq))`,
      sql`exists(select 1 from ${skillLoads} r join ${sessions} x on x.id = r.session_id
        where x.family_root = ${sessions.familyRoot} and ${dayClause}
          and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq))`,
    ]
    conditions.push(sql`(${timeClause as SQL} or ${sql.join(facts, sql` or `)})`)
  }
  if (scope.pick !== undefined) {
    conditions.push(pickClause(scope.pick.field, scope.pick.name, window))
  }
  return and(...conditions) as SQL
}

function pickClause(field: 'skills' | 'tools' | 'cmds' | 'models' | 'providers', name: string, window: QueryWindow): SQL {
  const day = window.all ? undefined : dayRangeClause(sql`r.day`, window)
  if (field === 'skills') {
    return sql`exists(select 1 from ${skillLoads} r join ${sessions} x on x.id = r.session_id
      where x.family_root = ${sessions.familyRoot} and r.name = ${name}
        and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq) ${day === undefined ? sql`` : sql`and ${day}`})`
  }
  if (field === 'models' || field === 'providers') {
    const column = field === 'models' ? sql`r.model` : sql`r.provider`
    return sql`exists(select 1 from ${requests} r join ${sessions} x on x.id = r.session_id
      where x.family_root = ${sessions.familyRoot} and ${column} = ${name}
        and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq) ${day === undefined ? sql`` : sql`and ${day}`})`
  }
  const settled = field === 'tools' ? sql`and r.result_seq is not null` : sql``
  const column = field === 'tools' ? sql`r.name` : sql`r.program`
  return sql`exists(select 1 from ${toolCalls} r join ${sessions} x on x.id = r.session_id
    where x.family_root = ${sessions.familyRoot} and ${column} = ${name} ${settled}
      and (x.seed_cut_seq is null or r.seq >= x.seed_cut_seq) ${day === undefined ? sql`` : sql`and ${day}`})`
}

export interface RootRow {
  id: string
  familyRoot: string
  createdAt: number
  updatedAt: number
  createdDay: string | null
  title: string
  cwd: string | null
  archived: number
  running: number
  workspaceTitle: string | null
  billedTokens: number
  curTotal: number
  model: string | null
  contextWindow: number | null
  maxOutputTokens: number | null
  lastUser: string | null
  parentSession: string | null
  origin: string | null
  foldStatus: string
  blank: number
}

export function rootRows(db: Db, scope: QueryScope): RootRow[] {
  const window = windowOfScope(scope)
  return db.all<RootRow>(sql`
    select id, family_root as familyRoot, created_at as createdAt, updated_at as updatedAt,
      created_day as createdDay, title, cwd, archived, running, workspace_title as workspaceTitle,
      billed_tokens as billedTokens, cur_total as curTotal, model, context_window as contextWindow,
      max_output_tokens as maxOutputTokens, last_user as lastUser, parent_session as parentSession,
      origin, fold_status as foldStatus, blank
    from ${sessions}
    where ${rootWhere(scope, window)}
    order by updated_at desc
  `)
}

export interface FamilyAggregate {
  tokens: number
  createdDay: string | null
  partial: number
  members: number
}

export function familyAggregates(db: Db, roots: readonly string[]): Map<string, FamilyAggregate> {
  const out = new Map<string, FamilyAggregate>()
  if (roots.length === 0) return out
  const rows = db.all(sql`
    select family_root as root, sum(billed_tokens) as tokens, min(created_day) as createdDay,
      sum(case when fold_status <> 'ok' then 1 else 0 end) as partial, count(*) as members
    from ${sessions}
    where family_root in (${sql.join(roots.map(id => sql`${id}`), sql`, `)})
    group by family_root
  `)
  for (const row of rows) {
    out.set(String(row.root), {
      tokens: Number(row.tokens),
      createdDay: typeof row.createdDay === 'string' ? row.createdDay : null,
      partial: Number(row.partial),
      members: Number(row.members),
    })
  }
  return out
}

export interface SelfAggregate {
  turns: number
  steps: number
  calls: number
}

export function selfAggregates(db: Db, ids: readonly string[]): Map<string, SelfAggregate> {
  const out = new Map<string, SelfAggregate>()
  if (ids.length === 0) return out
  const rows = db.all(sql`
    select s.id as id,
      (select count(*) from ${requests} r where r.session_id = s.id) as calls,
      (select coalesce(sum(r.starts_turn), 0) from ${requests} r where r.session_id = s.id) as turns,
      (select count(*) from ${steps} st where st.session_id = s.id and st.end_time is not null) as steps
    from ${sessions} s
    where s.id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
  `)
  for (const row of rows) {
    out.set(String(row.id), {
      turns: Number(row.turns),
      steps: Number(row.steps),
      calls: Number(row.calls),
    })
  }
  return out
}

export interface ContextParts {
  system: number
  tools: number
  user: number
  inject: number
  skill: number
  assistant: number
  tool: number
  reasoning: number
  answer: number
  call: number
}

export function contextParts(db: Db, ids: readonly string[]): Map<string, ContextParts> {
  const out = new Map<string, ContextParts>()
  if (ids.length === 0) return out
  const rows = db.all(sql`
    select s.id as id,
      coalesce((select p.tokens from ${systemPrompts} p where p.session_id = s.id and p.gone_seq is null order by p.seq desc limit 1), 0) as system,
      coalesce((select sum(h.tokens) from ${headerTools} h where h.session_id = s.id
        and h.epoch_seq = (select max(e.seq) from ${headerEpochs} e where e.session_id = s.id)), 0) as tools,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null and n.cat = 'user'), 0) as user,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null and n.cat = 'inject'), 0) as inject,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null and n.cat = 'skill'), 0) as skill,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null and n.cat = 'assistant'), 0) as assistant,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null and n.cat = 'tool'), 0) as tool,
      coalesce((select sum(n.reasoning_tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null), 0) as reasoning,
      coalesce((select sum(n.answer_tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null), 0) as answer,
      coalesce((select sum(n.call_tokens) from ${surfaceNodes} n where n.session_id = s.id and n.gone_seq is null), 0) as call
    from ${sessions} s
    where s.id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
  `)
  for (const row of rows) {
    out.set(String(row.id), {
      system: Number(row.system),
      tools: Number(row.tools),
      user: Number(row.user),
      inject: Number(row.inject),
      skill: Number(row.skill),
      assistant: Number(row.assistant),
      tool: Number(row.tool),
      reasoning: Number(row.reasoning),
      answer: Number(row.answer),
      call: Number(row.call),
    })
  }
  return out
}
