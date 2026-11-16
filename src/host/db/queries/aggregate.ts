import { sql, type SQL } from 'drizzle-orm'
import type { CostSource } from '../../cost'
import type { Db } from '../db'
import { requests, sessions, skillLoads, steps, surfaceNodes, systemPrompts, headerEpochs, headerTools, timingSpans, toolCalls } from '../schema'
import { billedParts } from '../../../shared/categories'
import { dayKeyOf } from '../../../shared/days'
import type {
  OverviewDay, OverviewPartTotal, OverviewSummary, OverviewTallyField, OverviewTallyStat,
  OverviewTimingWindow, TimingTotals,
} from '../../../shared/types'
import type { Coverage } from '../scheduler'
import type { QueryScope } from './common'
import { dayRangeClause, windowOfScope, type QueryWindow } from './common'
import { rootWhere } from './filters'
import { mergeUsageMap, usageByFamily } from './costUsage'

function rootsCte(scope: QueryScope): SQL {
  const window = windowOfScope(scope)
  return sql`roots as (select id, family_root from ${sessions} where ${rootWhere(scope, window)})`
}

function windowDay(window: QueryWindow, column: SQL): SQL {
  const clause = dayRangeClause(column, window)
  return clause ?? sql`1 = 1`
}

function cutPredicate(alias: SQL): SQL {
  return sql`(x.seed_cut_seq is null or ${alias} >= x.seed_cut_seq)`
}

function number(value: unknown): number {
  return Number(value)
}

interface TotalsRow {
  tokens: number
  calls: number
  turns: number
  cached_read: number
  input: number
  cache_write: number
  output: number
}

function totalsOf(db: Db, scope: QueryScope, window: QueryWindow): TotalsRow {
  const windowClause = windowDay(window, sql`r.day`)
  const row = db.get(sql`
    with ${rootsCte(scope)}
    select coalesce(sum(coalesce(r.input_tokens, 0) + coalesce(r.cache_read_tokens, 0)
        + coalesce(r.cache_write_tokens, 0) + coalesce(r.output_tokens, 0)), 0) as tokens,
      count(*) as calls,
      coalesce(sum(r.starts_turn), 0) as turns,
      coalesce(sum(coalesce(r.cache_read_tokens, 0)), 0) as cached_read,
      coalesce(sum(coalesce(r.input_tokens, 0)), 0) as input,
      coalesce(sum(coalesce(r.cache_write_tokens, 0)), 0) as cache_write,
      coalesce(sum(coalesce(r.output_tokens, 0)), 0) as output
    from ${requests} r
    join ${sessions} x on x.id = r.session_id
    join roots rt on rt.family_root = x.family_root
    where r.is_inherited = 0 and ${windowClause} and ${cutPredicate(sql`r.seq`)}
  `)
  return {
    tokens: number(row?.tokens),
    calls: number(row?.calls),
    turns: number(row?.turns),
    cached_read: number(row?.cached_read),
    input: number(row?.input),
    cache_write: number(row?.cache_write),
    output: number(row?.output),
  }
}

interface TimingRow {
  wall: number
  ttft: number
  gen: number
  idle: number
  busy: number
  toolCalls: number
  toolsMs: number
  calls: number
  reasoning: number
  text: number
  toolarg: number
  tools: number
  other: number
}

function timingOf(db: Db, scope: QueryScope, window: QueryWindow, lifetime: boolean): TimingRow {
  const reqWindow = lifetime ? sql`1 = 1` : windowDay(window, sql`r.day`)
  const stepWindow = lifetime ? sql`1 = 1` : windowDay(window, sql`st.day`)
  const toolWindow = lifetime ? sql`1 = 1` : windowDay(window, sql`t.day`)
  const spanStart = lifetime ? 0 : window.start
  const spanEnd = lifetime ? null : window.end
  const spanWindow = sql`r.start_time >= ${spanStart} and (${spanEnd} is null or r.start_time <= ${spanEnd})`
  const row = db.get(sql`
    with ${rootsCte(scope)}
    select
      coalesce((select sum(st.wall_ms) from ${steps} st join ${sessions} x on x.id = st.session_id
        join roots rt on rt.family_root = x.family_root where ${stepWindow} and ${cutPredicate(sql`st.seq`)}), 0) as wall,
      coalesce((select sum(st.ttft_ms) from ${steps} st join ${sessions} x on x.id = st.session_id
        join roots rt on rt.family_root = x.family_root where ${stepWindow} and ${cutPredicate(sql`st.seq`)}), 0) as ttft,
      coalesce((select sum(r.gen_ms) from ${requests} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where ${reqWindow} and ${cutPredicate(sql`r.seq`)}), 0) as gen,
      coalesce((select sum(st.idle_ms) from ${steps} st join ${sessions} x on x.id = st.session_id
        join roots rt on rt.family_root = x.family_root where ${stepWindow} and ${cutPredicate(sql`st.seq`)}), 0) as idle,
      coalesce((select sum(st.tool_busy_ms) from ${steps} st join ${sessions} x on x.id = st.session_id
        join roots rt on rt.family_root = x.family_root where ${stepWindow} and ${cutPredicate(sql`st.seq`)}), 0) as busy,
      coalesce((select count(*) from ${toolCalls} t join ${sessions} x on x.id = t.session_id
        join roots rt on rt.family_root = x.family_root where t.result_seq is not null and t.transport = 0
        and ${toolWindow} and ${cutPredicate(sql`t.seq`)}), 0) as toolCalls,
      coalesce((select sum(t.duration_ms) from ${toolCalls} t join ${sessions} x on x.id = t.session_id
        join roots rt on rt.family_root = x.family_root where t.result_seq is not null and t.transport = 0
        and ${toolWindow} and ${cutPredicate(sql`t.seq`)}), 0) as toolsMs,
      coalesce((select count(*) from ${requests} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where ${reqWindow} and ${cutPredicate(sql`r.seq`)}), 0) as calls,
      coalesce((select sum(r.end_time - r.start_time) from ${timingSpans} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where r.kind = 'reasoning' and ${spanWindow} and ${cutPredicate(sql`r.seq`)}), 0) as reasoning,
      coalesce((select sum(r.end_time - r.start_time) from ${timingSpans} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where r.kind = 'text' and ${spanWindow} and ${cutPredicate(sql`r.seq`)}), 0) as text,
      coalesce((select sum(r.end_time - r.start_time) from ${timingSpans} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where r.kind = 'toolarg' and ${spanWindow} and ${cutPredicate(sql`r.seq`)}), 0) as toolarg,
      coalesce((select sum(r.end_time - r.start_time) from ${timingSpans} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where r.kind = 'tools' and ${spanWindow} and ${cutPredicate(sql`r.seq`)}), 0) as tools,
      coalesce((select sum(r.end_time - r.start_time) from ${timingSpans} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root where r.kind = 'other' and ${spanWindow} and ${cutPredicate(sql`r.seq`)}), 0) as other
  `)
  return {
    wall: number(row?.wall),
    ttft: number(row?.ttft),
    gen: number(row?.gen),
    idle: number(row?.idle),
    busy: number(row?.busy),
    toolCalls: number(row?.toolCalls),
    toolsMs: number(row?.toolsMs),
    calls: number(row?.calls),
    reasoning: number(row?.reasoning),
    text: number(row?.text),
    toolarg: number(row?.toolarg),
    tools: number(row?.tools),
    other: number(row?.other),
  }
}

function timingTotalsOf(row: TimingRow): TimingTotals {
  return {
    wallMs: row.wall,
    ttftMs: row.ttft,
    genMs: row.gen,
    ...(row.reasoning > 0 ? { reasoningMs: row.reasoning, reasoningBlocks: 0 } : {}),
    ...(row.text > 0 ? { textMs: row.text, textBlocks: 0 } : {}),
    ...(row.toolarg > 0 ? { toolArgMs: row.toolarg, toolArgBlocks: 0 } : {}),
    speedTokens: 0,
    speedMs: 0,
    calls: row.calls,
    toolsMs: row.toolsMs,
    toolBusyMs: row.busy,
    idleMs: row.idle,
    toolCalls: row.toolCalls,
    tools: {},
  }
}

interface CurrentSum {
  system: number
  tools: number
  user: number
  inject: number
  skill: number
  assistant: number
  tool: number
  reasoning: number
  answers: number
  calls: number
}

function currentSumOf(db: Db, scope: QueryScope): CurrentSum {
  const row = db.get(sql`
    with ${rootsCte(scope)}
    select coalesce(sum(
        (select p.tokens from ${systemPrompts} p where p.session_id = x.id and p.gone_seq is null order by p.seq desc limit 1)
      ), 0) as system,
      coalesce(sum(
        (select sum(h.tokens) from ${headerTools} h where h.session_id = x.id
          and h.epoch_seq = (select max(e.seq) from ${headerEpochs} e where e.session_id = x.id))
      ), 0) as tools,
      coalesce(sum((select sum(sn.tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null and sn.cat = 'user')), 0) as user,
      coalesce(sum((select sum(sn.tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null and sn.cat = 'inject')), 0) as inject,
      coalesce(sum((select sum(sn.tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null and sn.cat = 'skill')), 0) as skill,
      coalesce(sum((select sum(sn.tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null and sn.cat = 'assistant')), 0) as assistant,
      coalesce(sum((select sum(sn.tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null and sn.cat = 'tool')), 0) as tool,
      coalesce(sum((select sum(sn.reasoning_tokens) from ${surfaceNodes} sn where sn.session_id = x.id and sn.gone_seq is null)), 0) as reasoning,
      coalesce(sum((select sum(sn.answer_tokens) from ${surfaceNodes} sn where sn.session_id = x.id)), 0) as answers,
      coalesce(sum((select sum(sn.call_tokens) from ${surfaceNodes} sn where sn.session_id = x.id)), 0) as calls
    from ${sessions} x join roots rt on rt.family_root = x.family_root
  `)
  return {
    system: number(row?.system),
    tools: number(row?.tools),
    user: number(row?.user),
    inject: number(row?.inject),
    skill: number(row?.skill),
    assistant: number(row?.assistant),
    tool: number(row?.tool),
    reasoning: number(row?.reasoning),
    answers: number(row?.answers),
    calls: number(row?.calls),
  }
}

function cacheHitOf(input: number, cacheRead: number, cacheWrite: number): string | null {
  const billed = input + cacheRead + cacheWrite
  if (!(billed > 0)) return null
  const scaled = Math.trunc((cacheRead / billed) * 100 * 100 + 1e-9)
  return `${Math.floor(scaled / 100)}.${String(scaled % 100).padStart(2, '0')}`
}

export interface SummaryExtra {
  sessionsTotal: number
  coverage: Coverage
}

export function querySummary(db: Db, cost: CostSource, scope: QueryScope, extra: SummaryExtra): OverviewSummary {
  const window = windowOfScope(scope)
  const totals = totalsOf(db, scope, window)
  const timing = timingOf(db, scope, window, false)
  const lifetime = timingOf(db, scope, window, true)
  const current = currentSumOf(db, scope)
  const requestWindow = windowDay(window, sql`r.day`)
  const usageFamily = usageByFamily(db, [...new Set(db.all<{ root: string }>(sql`
    with ${rootsCte(scope)} select distinct family_root as root from roots
  `).map(row => row.root))], sql`${requestWindow} and (s.seed_cut_seq is null or r.seq >= s.seed_cut_seq)`)
  const parts = billedParts({
    system: current.system,
    tools: current.tools,
    user: current.user,
    inject: current.inject,
    skill: current.skill,
    assistant: current.assistant,
    assistantReasoning: current.reasoning,
    assistantAnswerTokens: current.answers,
    assistantCallTokens: current.calls,
    tool: current.tool,
    total: current.system + current.tools + current.user + current.inject + current.skill + current.assistant + current.tool,
  }, null, {
    uncachedInputTokens: totals.input,
    cacheReadTokens: totals.cached_read,
    cacheWriteTokens: totals.cache_write,
    outputTokens: totals.output,
  }, { reasoning: current.reasoning, answers: current.answers, calls: current.calls })
  const tokenParts: OverviewPartTotal[] = parts
    .filter(part => Number.isFinite(part.value) && part.value > 0)
    .map(part => ({ key: part.key, value: part.value }))
  const counts = db.get(sql`
    with ${rootsCte(scope)}
    select count(*) as sessions,
      coalesce(sum(case when x.archived = 1 then 1 else 0 end), 0) as archived
    from roots rt join ${sessions} x on x.id = rt.id
  `)
  let usageSessions = 0
  let costSessions = 0
  for (const usage of usageFamily.values()) {
    usageSessions++
    if (cost.complete(usage)) costSessions++
  }
  return {
    sessions: number(counts?.sessions),
    sessionsTotal: extra.sessionsTotal,
    sessionsArchived: number(counts?.archived),
    archivedScoped: number(counts?.archived),
    tokens: totals.tokens,
    turns: totals.turns,
    costUsd: cost.usd(mergeUsageMap(usageFamily)),
    costSessions,
    usageSessions,
    cacheHit: cacheHitOf(totals.input, totals.cached_read, totals.cache_write),
    tokenParts: tokenParts.length === 0 ? null : tokenParts,
    timing: lifetime.wall > 0 || lifetime.calls > 0 ? timingTotalsOf(lifetime) : null,
    windowTiming: timingWindowOf(timing),
    coverage: extra.coverage,
  }
}

function timingWindowOf(row: TimingRow): OverviewTimingWindow {
  return { calls: row.calls, toolCalls: row.toolCalls, toolsMs: row.toolsMs, wallMs: row.wall }
}

export type DayValue = OverviewDay & {
  calls: number
  turns: number
  tool_calls: number
  tools_ms: number
  wall_ms: number
}

export function queryDays(db: Db, cost: CostSource, scope: QueryScope): DayValue[] {
  const window = windowOfScope(scope)
  const requestWindow = windowDay(window, sql`r.day`)
  const stepWindow = windowDay(window, sql`st.day`)
  const toolWindow = windowDay(window, sql`t.day`)
  const rows = db.all(sql`
    select r.day as key,
      sum(coalesce(r.input_tokens, 0) + coalesce(r.cache_read_tokens, 0) + coalesce(r.cache_write_tokens, 0) + coalesce(r.output_tokens, 0)) as tokens,
      count(*) as calls,
      sum(r.starts_turn) as turns,
      count(distinct x.family_root) as sessions
    from ${requests} r join ${sessions} x on x.id = r.session_id
    where r.is_inherited = 0 and ${requestWindow} and ${cutPredicate(sql`r.seq`)}
      ${scope.coverage === 'active' ? sql`and x.archived = 0` : scope.coverage === 'archived' ? sql`and x.archived = 1` : sql``}
    group by r.day order by r.day
  `)
  const stepRows = db.all(sql`
    select st.day as key, sum(st.wall_ms) as wall
    from ${steps} st join ${sessions} x on x.id = st.session_id
    where ${stepWindow} and ${cutPredicate(sql`st.seq`)}
      ${scope.coverage === 'active' ? sql`and x.archived = 0` : scope.coverage === 'archived' ? sql`and x.archived = 1` : sql``}
    group by st.day
  `)
  const toolRows = db.all(sql`
    select t.day as key, count(*) as calls, coalesce(sum(t.duration_ms), 0) as ms
    from ${toolCalls} t join ${sessions} x on x.id = t.session_id
    where t.result_seq is not null and t.transport = 0 and ${toolWindow} and ${cutPredicate(sql`t.seq`)}
      ${scope.coverage === 'active' ? sql`and x.archived = 0` : scope.coverage === 'archived' ? sql`and x.archived = 1` : sql``}
    group by t.day
  `)
  const costRows = db.all(sql`
    select r.day as key, r.provider, r.model, r.period,
      sum(coalesce(r.input_tokens, 0)) as input, sum(coalesce(r.cache_read_tokens, 0)) as cache_read,
      sum(coalesce(r.cache_write_tokens, 0)) as cache_write, sum(coalesce(r.output_tokens, 0)) as output
    from ${requests} r join ${sessions} x on x.id = r.session_id
    where r.is_inherited = 0 and ${requestWindow} and ${cutPredicate(sql`r.seq`)}
      ${scope.coverage === 'active' ? sql`and x.archived = 0` : scope.coverage === 'archived' ? sql`and x.archived = 1` : sql``}
    group by r.day, r.provider, r.model, r.period
  `)
  const wall = new Map(stepRows.map(row => [String(row.key), number(row.wall)]))
  const tools = new Map(toolRows.map(row => [String(row.key), { calls: number(row.calls), ms: number(row.ms) }]))
  const usage = new Map<string, import('../../../shared/types').SessionCostUsage>()
  for (const row of costRows) {
    const day = String(row.key)
    const usageMap = usage.get(day) ?? {}
    const provider = typeof row.provider === 'string' ? row.provider : ''
    const model = typeof row.model === 'string' ? row.model : ''
    const models = usageMap[provider] ?? {}
    const buckets = models[model] ?? {}
    const key = row.period === 'peak' ? 'peak' : 'off'
    buckets[key] = {
      uncached: number(row.input),
      cacheRead: number(row.cache_read),
      cacheWrite: number(row.cache_write),
      output: number(row.output),
    }
    models[model] = buckets
    usageMap[provider] = models
    usage.set(day, usageMap)
  }
  return rows
    .filter(row => number(row.tokens) > 0 || number(row.calls) > 0)
    .map((row) => {
      const key = String(row.key)
      const tool = tools.get(key)
      return {
        key,
        tokens: number(row.tokens),
        sessions: number(row.sessions),
        costUsd: cost.usd(usage.get(key)),
        calls: number(row.calls),
        turns: number(row.turns),
        tool_calls: tool?.calls ?? 0,
        tools_ms: tool?.ms ?? 0,
        wall_ms: wall.get(key) ?? 0,
      }
    })
}

export interface TallyValue {
  field: OverviewTallyField | 'models' | 'providers'
  stats: OverviewTallyStat[]
  total: number
}

export function queryTally(
  db: Db,
  scope: QueryScope,
  field: OverviewTallyField | 'models' | 'providers',
  limit: number,
  offset: number,
  sort: 'n' | 'last',
): TallyValue {
  const window = windowOfScope(scope)
  const day = dayRangeClause(sql`r.day`, window)
  const base = field === 'skills'
    ? sql`select r.name as name, count(*) as n, count(distinct x.family_root) as sessions, max(r.time) as last
        from ${skillLoads} r join ${sessions} x on x.id = r.session_id
        join roots rt on rt.family_root = x.family_root
        where ${cutPredicate(sql`r.seq`)} ${day === undefined ? sql`` : sql`and ${day}`}`
    : field === 'tools'
      ? sql`select r.name as name, count(*) as n, count(distinct x.family_root) as sessions, max(r.start_time) as last
          from ${toolCalls} r join ${sessions} x on x.id = r.session_id
          join roots rt on rt.family_root = x.family_root
          where r.result_seq is not null and ${cutPredicate(sql`r.seq`)} ${day === undefined ? sql`` : sql`and ${day}`}`
      : field === 'cmds'
        ? sql`select r.program as name, count(*) as n, count(distinct x.family_root) as sessions, max(r.start_time) as last
            from ${toolCalls} r join ${sessions} x on x.id = r.session_id
            join roots rt on rt.family_root = x.family_root
            where r.program is not null and ${cutPredicate(sql`r.seq`)} ${day === undefined ? sql`` : sql`and ${day}`}`
        : sql`select ${field === 'models' ? sql`r.model` : sql`r.provider`} as name, count(*) as n,
            count(distinct x.family_root) as sessions, max(r.time) as last
            from ${requests} r join ${sessions} x on x.id = r.session_id
            join roots rt on rt.family_root = x.family_root
            where ${cutPredicate(sql`r.seq`)} ${day === undefined ? sql`` : sql`and ${day}`}`
  const rows = db.all(sql`
    with ${rootsCte(scope)}, agg as (${base} group by 1)
    select name, n, sessions, last from agg where name is not null
    order by ${sort === 'last' ? sql`last desc, n desc` : sql`n desc, last desc`}, name
    limit ${limit} offset ${offset}
  `)
  const totalRow = db.get(sql`
    with ${rootsCte(scope)}, agg as (${base} group by 1)
    select count(*) as total from agg where name is not null
  `) as Record<string, unknown>
  return {
    field,
    stats: rows.map(row => ({
      name: String(row.name),
      n: number(row.n),
      sessions: number(row.sessions),
      last: number(row.last),
    })),
    total: number(totalRow.total),
  }
}

export function dayOfNow(now: number = Date.now()): string | null {
  return dayKeyOf(now)
}
