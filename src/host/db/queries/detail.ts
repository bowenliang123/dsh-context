import { sql, type SQL } from 'drizzle-orm'
import type { CostSource } from '../../cost'
import type { Db } from '../db'
import {
  events, fileOps, headerEpochs, headerTools, requests, sessions, skillLoads, steps,
  surfaceNodes, systemPrompts, timingSpans, toolCalls,
} from '../schema'
import type {
  ContextEventRecord, FileOpRecord, HeaderRecord, RequestRecord, Snapshot,
  SurfaceNode, TimingSpan, TimingTotals, CommandRecord, CommandStats,
} from '../../../shared/types'
import { contextDeltaOf, type ContextDelta } from '../../../shared/delta'
import { incrementOf } from '../../../shared/increment'
import type { Assembled } from '../../../shared/assemble'
import type { QueryScope } from './common'
import { limitOf, offsetOf, windowOfScope } from './common'
import { rootWhere } from './filters'
import { usageBySession } from './costUsage'

function number(value: unknown): number {
  return Number(value)
}

function rootIdSet(scope: QueryScope): SQL {
  const window = windowOfScope(scope)
  return sql`(select x.id from ${sessions} x
    join (select distinct family_root from ${sessions} where ${rootWhere(scope, window)}) rt
      on rt.family_root = x.family_root)`
}

export interface SessionState {
  id: string
  title: string
  cwd: string | null
  familyRoot: string
  seedCutSeq: number | null
  foldStatus: string
  foldError: string | null
  detailRev: number
  isSeeded: number
  model: string | null
  provider: string | null
  reasoningEffort: string | null
  contextWindow: number | null
  maxOutputTokens: number | null
  lastUser: string | null
  lastSeq: number
  updatedAt: number
}

export function sessionState(db: Db, id: string): SessionState | undefined {
  return db.select({
    id: sessions.id,
    title: sessions.title,
    cwd: sessions.cwd,
    familyRoot: sessions.familyRoot,
    seedCutSeq: sessions.seedCutSeq,
    foldStatus: sessions.foldStatus,
    foldError: sessions.foldError,
    detailRev: sessions.detailRev,
    isSeeded: sessions.isSeeded,
    model: sessions.model,
    provider: sessions.provider,
    reasoningEffort: sessions.reasoningEffort,
    contextWindow: sessions.contextWindow,
    maxOutputTokens: sessions.maxOutputTokens,
    lastUser: sessions.lastUser,
    lastSeq: sessions.lastSeq,
    updatedAt: sessions.updatedAt,
  }).from(sessions).where(sql`${sessions.id} = ${id}`).get()
}

export interface NotReady {
  ok: false
  fold_status: string
  fold_error?: string
  detail_rev: number
}

function notReady(state: SessionState): NotReady {
  return {
    ok: false,
    fold_status: state.foldStatus,
    ...(state.foldError === null ? {} : { fold_error: state.foldError }),
    detail_rev: state.detailRev,
  }
}

interface PartsRow {
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

function partsOf(db: Db, id: string): PartsRow {
  const row = db.get(sql`
    select
      coalesce((select p.tokens from ${systemPrompts} p where p.session_id = ${id} and p.gone_seq is null order by p.seq desc limit 1), 0) as system,
      coalesce((select sum(h.tokens) from ${headerTools} h where h.session_id = ${id}
        and h.epoch_seq = (select max(e.seq) from ${headerEpochs} e where e.session_id = ${id})), 0) as tools,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null and n.cat = 'user'), 0) as user,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null and n.cat = 'inject'), 0) as inject,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null and n.cat = 'skill'), 0) as skill,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null and n.cat = 'assistant'), 0) as assistant,
      coalesce((select sum(n.tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null and n.cat = 'tool'), 0) as tool,
      coalesce((select sum(n.reasoning_tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null), 0) as reasoning,
      coalesce((select sum(n.answer_tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null), 0) as answer,
      coalesce((select sum(n.call_tokens) from ${surfaceNodes} n where n.session_id = ${id} and n.gone_seq is null), 0) as call
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
    answer: number(row?.answer),
    call: number(row?.call),
  }
}

function contextCounts(db: Db, id: string): NonNullable<Snapshot['counts']> {
  const row = db.get(sql`
    select
      (select count(distinct coalesce(turn, 0)) from ${requests} where session_id = ${id}) as turns,
      (select count(*) from ${steps} where session_id = ${id} and end_time is not null) as steps,
      (select count(*) from ${events} where session_id = ${id} and kind = 'inject') as injects,
      (select count(*) from ${events} where session_id = ${id} and kind = 'compaction') as compactions,
      (select count(*) from ${events} where session_id = ${id} and kind = 'prune') as prunes,
      (select count(distinct name) from ${skillLoads} where session_id = ${id}) as skills
  `)
  return {
    turns: number(row?.turns),
    steps: number(row?.steps),
    injects: number(row?.injects),
    compactions: number(row?.compactions),
    prunes: number(row?.prunes),
    skills: number(row?.skills),
  }
}

function commandStatsOf(db: Db, id: string): CommandStats | undefined {
  const row = db.get(sql`
    select count(*) as commands,
      count(case when status is not null and status <> 'running' then 1 end) as runs,
      coalesce(sum(case when status in ('failed', 'killed') then 1 else 0 end), 0) as failed,
      coalesce(sum(case when status is not null and status <> 'running'
        then max(0, coalesce(end_time, start_time) - start_time) else 0 end), 0) as ms,
      coalesce(sum(background), 0) as bg
    from ${toolCalls} where session_id = ${id} and cmd is not null
  `) as Record<string, unknown>
  if (number(row.commands) === 0) return undefined
  return { runs: number(row.runs), failed: number(row.failed), ms: number(row.ms), bg: number(row.bg) }
}

function contextTiming(db: Db, id: string): TimingTotals | undefined {
  const row = db.get(sql`
    select
      coalesce((select sum(wall_ms) from ${steps} where session_id = ${id}), 0) as wall,
      coalesce(nullif((select sum(end_time - start_time) from ${timingSpans} where session_id = ${id} and kind = 'ttft'), 0),
        (select sum(ttft_ms) from ${steps} where session_id = ${id}), 0) as ttft,
      coalesce((select sum(gen_ms) from ${requests} where session_id = ${id}), 0) as gen,
      coalesce((select sum(idle_ms) from ${steps} where session_id = ${id}), 0) as idle,
      coalesce((select sum(tool_busy_ms) from ${steps} where session_id = ${id}), 0) as busy,
      (select count(*) from ${requests} where session_id = ${id}) as calls,
      coalesce((select sum(duration_ms) from ${toolCalls} where session_id = ${id} and result_seq is not null and transport = 0), 0) as tools_ms,
      (select count(*) from ${toolCalls} where session_id = ${id} and result_seq is not null and transport = 0) as tool_calls,
      coalesce((select sum(output_tokens) from ${requests} where session_id = ${id} and gen_ms is not null), 0) as speed_tokens,
      coalesce((select sum(gen_ms) from ${requests} where session_id = ${id} and gen_ms is not null), 0) as speed_ms,
      coalesce((select sum(end_time - start_time) from ${timingSpans} where session_id = ${id} and kind = 'reasoning'), 0) as reasoning,
      coalesce((select sum(end_time - start_time) from ${timingSpans} where session_id = ${id} and kind = 'text'), 0) as text,
      coalesce((select sum(end_time - start_time) from ${timingSpans} where session_id = ${id} and kind = 'toolarg'), 0) as toolarg
  `) as Record<string, unknown>
  if (number(row.wall) === 0 && number(row.ttft) === 0 && number(row.gen) === 0
    && number(row.calls) === 0 && number(row.tools_ms) === 0 && number(row.tool_calls) === 0
    && number(row.reasoning) === 0 && number(row.text) === 0 && number(row.toolarg) === 0) return undefined
  const tools = db.all<{ name: string; calls: number; ms: number }>(sql`
    select name, count(*) as calls, coalesce(sum(duration_ms), 0) as ms
    from ${toolCalls} where session_id = ${id} and result_seq is not null and transport = 0
    group by name
  `)
  const toolMap: Record<string, { calls: number; ms: number }> = {}
  for (const tool of tools) toolMap[tool.name] = { calls: number(tool.calls), ms: number(tool.ms) }
  return {
    wallMs: number(row.wall),
    ttftMs: number(row.ttft),
    genMs: number(row.gen),
    ...(number(row.reasoning) > 0 ? { reasoningMs: number(row.reasoning), reasoningBlocks: 0 } : {}),
    ...(number(row.text) > 0 ? { textMs: number(row.text), textBlocks: 0 } : {}),
    ...(number(row.toolarg) > 0 ? { toolArgMs: number(row.toolarg), toolArgBlocks: 0 } : {}),
    speedTokens: number(row.speed_tokens),
    speedMs: number(row.speed_ms),
    calls: number(row.calls),
    toolsMs: number(row.tools_ms),
    toolBusyMs: number(row.busy),
    idleMs: number(row.idle),
    toolCalls: number(row.tool_calls),
    tools: toolMap,
  }
}

function tapOf(db: Db, id: string): {
  humanInputs: number
  answers: number
  images: number
  toolCalls: number
  toolTally: Record<string, number>
  programTally: Record<string, number>
  generated: { reasoning: number; answers: number; calls: number }
} {
  const row = db.get(sql`
    select
      (select count(*) from ${surfaceNodes} where session_id = ${id} and cat = 'user' and gone_seq is null) as humans,
      (select count(*) from ${surfaceNodes} where session_id = ${id} and cat = 'assistant' and preview is not null and preview <> '') as answers,
      coalesce((select sum(imgs) from ${surfaceNodes} where session_id = ${id} and gone_seq is null), 0) as images,
      (select count(*) from ${surfaceNodes} where session_id = ${id} and gone_seq is null and (cat = 'tool' or (cat = 'skill' and tool is not null))) as tools,
      coalesce((select sum(reasoning_tokens) from ${surfaceNodes} where session_id = ${id} and cat = 'assistant'), 0) as reasoning,
      coalesce((select sum(answer_tokens) from ${surfaceNodes} where session_id = ${id} and cat = 'assistant'), 0) as generated_answers,
      coalesce((select sum(call_tokens) from ${surfaceNodes} where session_id = ${id} and cat = 'assistant'), 0) as generated_calls
  `)
  const toolTally: Record<string, number> = {}
  for (const tool of db.all<{ name: string; n: number }>(sql`
    select name, count(*) as n from ${toolCalls}
    where session_id = ${id} and result_seq is not null and transport = 0 group by name
  `)) toolTally[tool.name] = number(tool.n)
  const programTally: Record<string, number> = {}
  for (const program of db.all<{ program: string; n: number }>(sql`
    select program, count(*) as n from ${toolCalls}
    where session_id = ${id} and program is not null group by program
  `)) programTally[program.program] = number(program.n)
  return {
    humanInputs: number(row?.humans),
    answers: number(row?.answers),
    images: number(row?.images),
    toolCalls: number(row?.tools),
    toolTally,
    programTally,
    generated: {
      reasoning: number(row?.reasoning), answers: number(row?.generated_answers), calls: number(row?.generated_calls),
    },
  }
}

export type SnapshotValue = Snapshot & { detailRev: number }

export function queryContext(db: Db, cost: CostSource, id: string): SnapshotValue | NotReady {
  const state = sessionState(db, id)
  if (state === undefined) return { ok: false, fold_status: 'missing', detail_rev: 0 }
  if (state.foldStatus !== 'ok') return notReady(state)
  const parts = partsOf(db, id)
  const counts = contextCounts(db, id)
  const commandStats = commandStatsOf(db, id)
  const timing = contextTiming(db, id)
  const tap = tapOf(db, id)
  const last = db.select({
    seq: requests.seq,
    total: requests.totalTokens,
    prompt: requests.promptTokens,
  }).from(requests).where(sql`${requests.sessionId} = ${id}`).orderBy(sql`${requests.seq} desc`).limit(1).get()
  const systems = db.select({ seq: systemPrompts.seq, time: systemPrompts.time, tokens: systemPrompts.tokens })
    .from(systemPrompts).where(sql`${systemPrompts.sessionId} = ${id} and ${systemPrompts.goneSeq} is null`)
    .orderBy(sql`${systemPrompts.seq} desc`).limit(8).all().reverse()
  const usage = usageBySession(db, [id], false).get(id) ?? null
  const snapshot: SnapshotValue = {
    ok: true,
    ...(state.model === null ? {} : { model: state.model }),
    ...(state.provider === null ? {} : { provider: state.provider }),
    ...(state.reasoningEffort === null ? {} : { reasoningEffort: state.reasoningEffort }),
    ...(state.contextWindow === null ? {} : { contextWindow: state.contextWindow }),
    ...(state.maxOutputTokens === null ? {} : { maxOutputTokens: state.maxOutputTokens }),
    current: {
      system: parts.system,
      tools: parts.tools,
      user: parts.user,
      inject: parts.inject,
      skill: parts.skill,
      assistant: parts.assistant,
      assistantReasoning: parts.reasoning,
      assistantAnswerTokens: parts.answer,
      assistantCallTokens: parts.call,
      tool: parts.tool,
      total: parts.system + parts.tools + parts.user + parts.inject + parts.skill + parts.assistant + parts.tool,
    },
    images: tap.images,
    toolCalls: tap.toolCalls,
    toolTally: tap.toolTally,
    programTally: tap.programTally,
    humanInputs: tap.humanInputs,
    answers: tap.answers,
    ...(state.lastUser === null ? {} : { lastUser: state.lastUser }),
    generatedReasoning: tap.generated.reasoning,
    generatedAnswerTokens: tap.generated.answers,
    generatedCallTokens: tap.generated.calls,
    counts,
    ...(usage === null ? {} : { cost: usage }),
    ...(commandStats === undefined ? {} : { commandStats }),
    ...(last === undefined ? {} : { last: { seq: last.seq, total: last.total, ...(last.prompt === null ? {} : { prompt: last.prompt }) } }),
    detailRev: state.detailRev,
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...(timing === undefined ? {} : { timing }),
    ...(systems.length === 0 ? {} : { systems }),
  }
  const read = cost.read(usage)
  if (read !== undefined) snapshot.costRead = read
  return snapshot
}

function nodeOf(row: typeof surfaceNodes.$inferSelect): SurfaceNode {
  const node: SurfaceNode = {
    seq: row.seq,
    cat: row.cat,
    tokens: row.tokens,
  }
  if (row.time !== null) node.time = row.time
  if (row.reasoningTokens !== null) node.reasoning = row.reasoningTokens
  if (row.answerTokens !== null) node.answerTokens = row.answerTokens
  if (row.callTokens !== null) node.callTokens = row.callTokens
  if (row.imgs !== null) node.imgs = row.imgs
  if (row.form !== null) node.form = row.form
  if (row.name !== null) node.name = row.name
  if (row.agent !== null) node.agent = row.agent
  if (row.tool !== null) node.tool = row.tool
  if (row.skill !== null) node.skill = row.skill
  if (row.isError === 1) node.err = true
  if (row.calls !== null) {
    try {
      const calls: unknown = JSON.parse(row.calls)
      if (Array.isArray(calls)) node.calls = calls.filter((call): call is string => typeof call === 'string')
    } catch {}
  }
  if (row.preview !== null) node.text = row.preview
  if (row.goneSeq !== null) node.gone = row.goneSeq
  return node
}

export interface TimelineValue {
  live: boolean
  nodes: SurfaceNode[]
  droppedNodes: number
  archive: SurfaceNode[]
  surfaceFloor?: number
  archiveFloor?: number
  droppedTotal: number
  system: { seq: number; time: number; tokens: number } | null
  header: HeaderRecord | null
  missing_live: number
  approximate: boolean
  fold_status: string
  detail_rev: number
}

export function queryTimeline(
  db: Db,
  id: string,
  seq: number | null,
  options: { limit?: number; archiveLimit?: number } = {},
): TimelineValue | NotReady {
  const state = sessionState(db, id)
  if (state === undefined) return { ok: false, fold_status: 'missing', detail_rev: 0 }
  if (state.foldStatus !== 'ok') return notReady(state)
  const limit = Math.max(1, Math.min(5_000, options.limit ?? 2_000))
  const archiveLimit = Math.max(1, Math.min(2_000, options.archiveLimit ?? 400))
  const visible = seq === null
    ? sql`${surfaceNodes.goneSeq} is null`
    : sql`${surfaceNodes.seq} < ${seq} and (${surfaceNodes.goneSeq} is null or ${surfaceNodes.goneSeq} > ${seq})`
  const total = number(db.get(sql`
    select count(*) as n from ${surfaceNodes} where session_id = ${id} and ${visible}
  `)?.n)
  const tail = db.select().from(surfaceNodes)
    .where(sql`${surfaceNodes.sessionId} = ${id} and ${visible}`)
    .orderBy(sql`${surfaceNodes.seq} desc`).limit(limit).all()
  const tailSeqs = new Set(tail.map(row => row.seq))
  const minTail = tail.length === 0 ? null : tail[tail.length - 1].seq
  const pinned = minTail === null ? [] : db.select().from(surfaceNodes)
    .where(sql`${surfaceNodes.sessionId} = ${id} and ${visible} and ${surfaceNodes.seq} < ${minTail}
      and ${surfaceNodes.cat} in ('inject', 'skill')`)
    .orderBy(sql`${surfaceNodes.seq} asc`).all()
  const pinnedSeqs = new Set(pinned.map(row => row.seq))
  const nodes = [...pinned, ...tail.slice().reverse()].filter(row => tailSeqs.has(row.seq) || pinnedSeqs.has(row.seq)).map(nodeOf)
  const dropped = Math.max(0, total - nodes.length)
  const floorRow = dropped === 0 ? undefined : db.get(sql`
    select max(${surfaceNodes.seq}) as floor from ${surfaceNodes}
    where session_id = ${id} and ${visible} and ${surfaceNodes.cat} not in ('inject', 'skill')
      and ${surfaceNodes.seq} not in (${sql.join([...tailSeqs, -1].map(value => sql`${value}`), sql`, `)})
  `)
  const archiveWhere = seq === null
    ? sql`${surfaceNodes.goneSeq} is not null`
    : sql`${surfaceNodes.seq} < ${seq} and ${surfaceNodes.goneSeq} > ${seq}`
  const archiveTotal = number(db.get(sql`
    select count(*) as n from ${surfaceNodes} where session_id = ${id} and ${archiveWhere}
  `)?.n)
  const archiveRows = db.select().from(surfaceNodes)
    .where(sql`${surfaceNodes.sessionId} = ${id} and ${archiveWhere}`)
    .orderBy(sql`${surfaceNodes.goneSeq} desc, ${surfaceNodes.seq} desc`).limit(archiveLimit).all()
  const archive = archiveRows.slice().reverse().map(nodeOf)
  const droppedTotal = total - nodes.length
  const archiveDropped = Math.max(0, archiveTotal - archive.length)
  const archiveFloor = archiveDropped === 0
    ? undefined
    : Number(archiveRows[archiveRows.length - 1]?.goneSeq)
  const systemWhere = seq === null
    ? sql`${systemPrompts.sessionId} = ${id} and ${systemPrompts.goneSeq} is null`
    : sql`${systemPrompts.sessionId} = ${id} and ${systemPrompts.seq} < ${seq}
        and (${systemPrompts.goneSeq} is null or ${systemPrompts.goneSeq} > ${seq})`
  const systemRow = db.select().from(systemPrompts).where(systemWhere)
    .orderBy(sql`${systemPrompts.seq} desc`).limit(1).get()
  const system = systemRow === undefined ? null : { seq: systemRow.seq, time: systemRow.time, tokens: systemRow.tokens }
  const headerWhere = seq === null
    ? sql`${headerEpochs.sessionId} = ${id}`
    : sql`${headerEpochs.sessionId} = ${id} and ${headerEpochs.seq} < ${seq}`
  const epoch = db.select().from(headerEpochs).where(headerWhere)
    .orderBy(sql`${headerEpochs.seq} desc`).limit(1).get()
  const header: HeaderRecord | null = epoch === undefined ? null : {
    seq: epoch.seq,
    time: epoch.time,
    tools: db.select({ name: headerTools.name, tokens: headerTools.tokens }).from(headerTools)
      .where(sql`${headerTools.sessionId} = ${id} and ${headerTools.epochSeq} = ${epoch.seq}`)
      .orderBy(sql`${headerTools.ordinal} asc`).all(),
  }
  return {
    live: seq === null,
    nodes,
    droppedNodes: dropped,
    archive,
    ...(dropped > 0 && floorRow?.floor !== null && floorRow?.floor !== undefined ? { surfaceFloor: number(floorRow.floor) } : {}),
    ...(archiveFloor === undefined ? {} : { archiveFloor }),
    droppedTotal,
    system,
    header,
    missing_live: dropped,
    approximate: archiveDropped > 0 && seq !== null && (archiveFloor === undefined || seq < archiveFloor),
    fold_status: state.foldStatus,
    detail_rev: state.detailRev,
  }
}

function requestRecord(row: typeof requests.$inferSelect): RequestRecord {
  return {
    seq: row.seq,
    time: row.time,
    total: row.totalTokens,
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.step === null ? {} : { step: row.step }),
    ...(row.promptTokens === null ? {} : { prompt: row.promptTokens }),
    system: row.systemTokens,
    tools: row.toolsTokens,
    user: row.userTokens,
    inject: row.injectTokens,
    skill: row.skillTokens,
    assistant: row.assistantTokens,
    tool: row.toolTokens,
    ...(row.cacheReadTokens === null ? {} : { cacheRead: row.cacheReadTokens }),
    ...(row.outputTokens === null ? {} : { output: row.outputTokens }),
    ...(row.activeMs === null ? {} : { activeMs: row.activeMs }),
  }
}

export interface RequestsQuery {
  sessionId?: string
  scope?: QueryScope
  turn?: number
  day?: string
  model?: string
  after?: number
  limit?: number
  offsetFromEnd?: number
}

export function queryRequests(db: Db, query: RequestsQuery): RequestRecord[] {
  const conditions: SQL[] = []
  if (query.sessionId !== undefined) conditions.push(sql`${requests.sessionId} = ${query.sessionId}`)
  else if (query.scope !== undefined) {
    conditions.push(sql`${requests.isInherited} = 0`)
    conditions.push(sql`${requests.sessionId} in ${rootIdSet(query.scope)}`)
  } else {
    return []
  }
  if (query.turn !== undefined) conditions.push(sql`${requests.turn} = ${query.turn}`)
  if (query.day !== undefined) conditions.push(sql`${requests.day} = ${query.day}`)
  if (query.model !== undefined) conditions.push(sql`${requests.model} = ${query.model}`)
  if (query.after !== undefined) conditions.push(sql`${requests.seq} > ${query.after}`)
  const limit = limitOf(query.limit, 500)
  if (query.offsetFromEnd !== undefined && query.offsetFromEnd > 0) {
    const rows = db.select().from(requests)
      .where(sql.join(conditions, sql` and `))
      .orderBy(sql`${requests.seq} desc`).limit(limit)
      .offset(Math.max(0, offsetOf(query.offsetFromEnd) - 1)).all()
    return rows.reverse().map(requestRecord)
  }
  if (query.after === undefined) {
    const rows = db.select().from(requests)
      .where(sql.join(conditions, sql` and `))
      .orderBy(sql`${requests.seq} desc`).limit(limit).all()
    return rows.reverse().map(requestRecord)
  }
  return db.select().from(requests).where(sql.join(conditions, sql` and `))
    .orderBy(sql`${requests.seq} asc`).limit(limit).all().map(requestRecord)
}

export interface StepRow {
  seq: number
  turn?: number
  step?: number
  start_time: number
  end_time?: number
  day: string
  request_seq?: number
  wall_ms: number
  active_ms: number
  wait_ms: number
  idle_ms: number
  tool_busy_ms: number
  ttft_ms?: number
  beats_full: boolean
}

export function querySteps(db: Db, id: string, after: number | undefined, limit: number): StepRow[] {
  const rows = after === undefined
    ? db.select().from(steps)
      .where(sql`${steps.sessionId} = ${id}`)
      .orderBy(sql`${steps.seq} desc`).limit(limitOf(limit, 500)).all().reverse()
    : db.select().from(steps)
      .where(sql`${steps.sessionId} = ${id} and ${steps.seq} > ${after}`)
      .orderBy(sql`${steps.seq} asc`).limit(limitOf(limit, 500)).all()
  return rows.map(row => ({
    seq: row.seq,
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.step === null ? {} : { step: row.step }),
    start_time: row.startTime,
    ...(row.endTime === null ? {} : { end_time: row.endTime }),
    day: row.day,
    ...(row.requestSeq === null ? {} : { request_seq: row.requestSeq }),
    wall_ms: row.wallMs,
    active_ms: row.activeMs,
    wait_ms: row.waitMs,
    idle_ms: row.idleMs,
    tool_busy_ms: row.toolBusyMs,
    ...(row.ttftMs === null ? {} : { ttft_ms: row.ttftMs }),
    beats_full: row.beatsFull === 1,
  }))
}

export interface ToolCallQuery {
  sessionId?: string
  scope?: QueryScope
  status?: 'failed' | 'slow' | 'background'
  slowMs?: number
  program?: string
  query?: string
  commandsOnly?: boolean
  beforeSeq?: number
  sort?: 'latest' | 'slowest'
  cursor?: { time?: number; duration?: number; seq: number }
  limit?: number
}

function commandOf(
  row: typeof toolCalls.$inferSelect,
  attribution?: (name: string) => string | undefined,
): CommandRecord & Record<string, unknown> {
  const status = row.status ?? (row.resultSeq === null ? 'running' : 'completed')
  const start = row.commandStartTime ?? row.startTime
  const end = row.commandEndTime ?? row.endTime
  const duration = row.commandDurationMs ?? row.durationMs
  return {
    seq: row.seq,
    ...(row.resultSeq === null ? {} : { resultSeq: row.resultSeq }),
    time: start,
    tool: row.name,
    ...(row.cmd === null ? {} : { cmd: row.cmd }),
    ...(row.cmdTruncated === 1 ? { cmdTruncated: true as const } : {}),
    ...(row.cmdDescription === null ? {} : { description: row.cmdDescription }),
    ...(row.cmdCwd === null ? {} : { cwd: row.cmdCwd }),
    ...(row.timeoutMs === null ? {} : { timeoutMs: row.timeoutMs }),
    ...(row.background === 1 ? { background: true as const } : {}),
    ...(row.sandbox === null ? {} : { sandbox: row.sandbox }),
    ...(row.codeMode === 1 ? { codeMode: true as const } : {}),
    ...(row.parentSeq === null ? {} : { parent: row.parentSeq }),
    ...(row.turn === null ? {} : { turn: row.turn }),
    ...(row.step === null ? {} : { step: row.step }),
    start,
    ...(end === null ? {} : { end }),
    status: status as CommandRecord['status'],
    ...(row.exitCode === null ? {} : { exit: row.exitCode }),
    ...(row.exitInferred === 1 ? { exitInferred: true as const } : {}),
    ...(row.signal === null ? {} : { signal: row.signal }),
    ...(row.timedOut === 1 ? { timedOut: true as const } : {}),
    ...(row.stopped === 1 ? { stopped: true as const } : {}),
    ...(row.denied === 1 ? { denied: true as const } : {}),
    err: row.isError === 1,
    ...(row.outChars === null ? {} : { outChars: row.outChars }),
    ...(row.outTruncated === 1 ? { outTruncated: true as const } : {}),
    ...(row.stderr === 1 ? { stderr: true as const } : {}),
    ...(row.derived === 1 ? { derived: true as const } : {}),
    call_id: row.callId,
    name: row.name,
    plugin: row.plugin ?? attribution?.(row.name) ?? null,
    transport: row.transport === 1,
    code_mode: row.codeMode === 1,
    parent_seq: row.parentSeq,
    day: row.day,
    duration_ms: duration,
    is_error: row.isError === 1,
    program: row.program,
  }
}

export function queryToolCalls(
  db: Db,
  query: ToolCallQuery,
  attribution?: (name: string) => string | undefined,
): { items: (CommandRecord & Record<string, unknown>)[]; total: number } {
  const conditions: SQL[] = []
  if (query.sessionId !== undefined) conditions.push(sql`${toolCalls.sessionId} = ${query.sessionId}`)
  else if (query.scope !== undefined) {
    conditions.push(sql`${toolCalls.sessionId} in ${rootIdSet(query.scope)}`)
    conditions.push(sql`exists(select 1 from ${sessions} x where x.id = ${toolCalls.sessionId}
      and (x.seed_cut_seq is null or ${toolCalls.seq} >= x.seed_cut_seq))`)
  } else return { items: [], total: 0 }
  if (query.status === 'failed') conditions.push(sql`${toolCalls.isError} = 1`)
  else if (query.status === 'background') conditions.push(sql`${toolCalls.background} = 1`)
  else if (query.status === 'slow') conditions.push(sql`${toolCalls.durationMs} >= ${query.slowMs ?? 1_000}`)
  if (query.program !== undefined) conditions.push(sql`${toolCalls.program} = ${query.program}`)
  if (query.commandsOnly === true) conditions.push(sql`${toolCalls.cmd} is not null`)
  if (query.beforeSeq !== undefined) conditions.push(sql`${toolCalls.seq} < ${query.beforeSeq}`)
  if (query.query !== undefined && query.query !== '') {
    conditions.push(sql`(${toolCalls.cmd} like ${`%${query.query}%`} or ${toolCalls.cmdDescription} like ${`%${query.query}%`})`)
  }
  const where = sql.join(conditions, sql` and `)
  const total = number(db.get(sql`select count(*) as n from ${toolCalls} where ${where}`)?.n)
  const slowest = query.sort === 'slowest'
  if (query.cursor !== undefined) {
    if (slowest) {
      conditions.push(sql`(${toolCalls.durationMs} < ${query.cursor.duration ?? 0}
        or (${toolCalls.durationMs} = ${query.cursor.duration ?? 0} and ${toolCalls.seq} < ${query.cursor.seq}))`)
    } else {
      conditions.push(sql`(${toolCalls.startTime} < ${query.cursor.time ?? 0}
        or (${toolCalls.startTime} = ${query.cursor.time ?? 0} and ${toolCalls.seq} < ${query.cursor.seq}))`)
    }
  }
  const rows = db.select().from(toolCalls)
    .where(sql.join(conditions, sql` and `))
    .orderBy(slowest
      ? sql`${toolCalls.durationMs} desc, ${toolCalls.seq} desc`
      : sql`${toolCalls.startTime} desc, ${toolCalls.seq} desc`)
    .limit(limitOf(query.limit, 200)).all()
  return { items: rows.map(row => commandOf(row, attribution)), total }
}

export interface FileOpPath {
  path: string
  count: number
  added: number
  removed: number
  last: number
  errors: number
  hits: number
}

export function queryFileOps(
  db: Db,
  id: string,
  mode: 'list',
  options: { kind?: string; after?: number; limit?: number },
): { items: FileOpRecord[]; total: number }
export function queryFileOps(
  db: Db,
  id: string,
  mode: 'paths',
  options: { kind?: string; after?: number; limit?: number },
): { paths: FileOpPath[]; total: number }
export function queryFileOps(
  db: Db,
  id: string,
  mode: 'list' | 'paths',
  options: { kind?: string; after?: number; limit?: number },
): { items: FileOpRecord[]; total: number } | { paths: FileOpPath[]; total: number }
export function queryFileOps(
  db: Db,
  id: string,
  mode: 'list' | 'paths',
  options: { kind?: string; after?: number; limit?: number },
): { items: FileOpRecord[]; total: number } | { paths: FileOpPath[]; total: number } {
  const conditions: SQL[] = [sql`${fileOps.sessionId} = ${id}`]
  if (options.kind !== undefined) conditions.push(sql`${fileOps.kind} = ${options.kind}`)
  if (options.after !== undefined) conditions.push(sql`${fileOps.seq} > ${options.after}`)
  const where = sql.join(conditions, sql` and `)
  if (mode === 'paths') {
    const paths = db.all(sql`
      select path, count(*) as count, coalesce(sum(lines_added), 0) as added,
        coalesce(sum(lines_removed), 0) as removed, coalesce(max(time), 0) as last,
        coalesce(sum(case when is_error = 1 then 1 else 0 end), 0) as errors,
        coalesce(sum(hits), 0) as hits
      from ${fileOps} where ${where} group by path order by count desc, path
    `)
    return {
      paths: paths.map(row => ({
        path: String(row.path),
        count: number(row.count),
        added: number(row.added),
        removed: number(row.removed),
        last: number(row.last),
        errors: number(row.errors),
        hits: number(row.hits),
      })),
      total: paths.length,
    }
  }
  const rows = options.after === undefined
    ? db.select().from(fileOps).where(where)
      .orderBy(sql`${fileOps.time} desc, ${fileOps.seq} desc, ${fileOps.ordinal} desc`)
      .limit(limitOf(options.limit, 500)).all().reverse()
    : db.select().from(fileOps).where(where)
      .orderBy(sql`${fileOps.time} asc, ${fileOps.seq} asc, ${fileOps.ordinal} asc`)
      .limit(limitOf(options.limit, 500)).all()
  const total = number(db.get(sql`select count(*) as n from ${fileOps} where ${where}`)?.n)
  return {
    items: rows.map(row => ({
      seq: row.seq,
      path: row.path,
      kind: row.kind,
      tool: row.tool,
      ...(row.time === null ? {} : { time: row.time }),
      err: row.isError === 1,
      added: row.linesAdded,
      removed: row.linesRemoved,
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.hits === null ? {} : { hits: row.hits }),
      ...(row.readStart === null || row.readCount === null
        ? {}
        : row.readEst === 1
          ? { read: { count: row.readCount, est: true as const } }
          : { read: { start: row.readStart, count: row.readCount } }),
      ...(row.parentSeq === null ? {} : { parent: row.parentSeq }),
      ...(row.program === null ? {} : { program: row.program }),
      ...(row.isPattern === 1 ? { pattern: true as const } : {}),
    })),
    total,
  }
}

export function queryEvents(
  db: Db,
  id: string,
  options: { kinds?: string[]; after?: number; limit?: number },
): ContextEventRecord[] {
  const conditions: SQL[] = [sql`${events.sessionId} = ${id}`]
  if (options.kinds !== undefined && options.kinds.length > 0) {
    conditions.push(sql`${events.kind} in (${sql.join(options.kinds.map(kind => sql`${kind}`), sql`, `)})`)
  }
  if (options.after !== undefined) conditions.push(sql`${events.seq} > ${options.after}`)
  const rows = options.after === undefined
    ? db.select().from(events).where(sql.join(conditions, sql` and `))
      .orderBy(sql`${events.seq} desc`).limit(limitOf(options.limit, 500)).all().reverse()
    : db.select().from(events).where(sql.join(conditions, sql` and `))
      .orderBy(sql`${events.seq} asc`).limit(limitOf(options.limit, 500)).all()
  return rows.map((row) => {
    const next = db.get(sql`
      select turn, step from ${requests} where session_id = ${id} and seq > ${row.seq} order by seq asc limit 1
    `)
    const prev = db.get(sql`
      select turn, step from ${requests} where session_id = ${id} and seq < ${row.seq} order by seq desc limit 1
    `)
    return {
      seq: row.seq,
      time: row.time,
      kind: row.kind,
      ...(row.form === null ? {} : { form: row.form }),
      ...(row.tokens === null ? {} : { tokens: row.tokens }),
      ...(row.grossTokens === null ? {} : { grossTokens: row.grossTokens }),
      ...(row.nodeCount === null ? {} : { count: row.nodeCount }),
      ...(row.sub === null ? {} : { sub: row.sub }),
      ...(row.name === null ? {} : { name: row.name }),
      ...(row.agent === null ? {} : { agent: row.agent }),
      ...(row.detail === null ? {} : { detail: row.detail }),
      ...(row.modelFrom === null ? {} : { from: row.modelFrom }),
      ...(row.modelTo === null ? {} : { to: row.modelTo }),
      ...(prev === undefined ? {} : {
        ...(typeof prev.turn === 'number' ? { fromTurn: prev.turn } : {}),
        ...(typeof prev.step === 'number' ? { fromStep: prev.step } : {}),
      }),
      ...(next === undefined ? {} : {
        ...(typeof next.turn === 'number' ? { turn: next.turn } : {}),
        ...(typeof next.step === 'number' ? { step: next.step } : {}),
      }),
    }
  })
}

export function querySpans(db: Db, id: string, options: { before?: number; limit?: number }): (TimingSpan & { seq: number })[] {
  const rows = db.select().from(timingSpans)
    .where(sql`${timingSpans.sessionId} = ${id}${options.before === undefined ? sql`` : sql` and ${timingSpans.startTime} < ${options.before}`}`)
    .orderBy(sql`${timingSpans.startTime} desc, ${timingSpans.spanSeq} desc`)
    .limit(limitOf(options.limit, 2_000)).all().reverse()
  return rows.map(row => ({ kind: row.kind, start: row.startTime, end: row.endTime, seq: row.seq }))
}

export function querySkillLoads(
  db: Db,
  query: { sessionId?: string; scope?: QueryScope; name?: string; day?: string; after?: number; limit?: number },
): { seq: number; time: number; day: string; name: string; source: string }[] {
  const conditions: SQL[] = []
  if (query.sessionId !== undefined) conditions.push(sql`${skillLoads.sessionId} = ${query.sessionId}`)
  else if (query.scope !== undefined) {
    conditions.push(sql`${skillLoads.sessionId} in ${rootIdSet(query.scope)}`)
    conditions.push(sql`exists(select 1 from ${sessions} x where x.id = ${skillLoads.sessionId}
      and (x.seed_cut_seq is null or ${skillLoads.seq} >= x.seed_cut_seq))`)
  } else return []
  if (query.name !== undefined) conditions.push(sql`${skillLoads.name} = ${query.name}`)
  if (query.day !== undefined) conditions.push(sql`${skillLoads.day} = ${query.day}`)
  if (query.after !== undefined) conditions.push(sql`${skillLoads.seq} > ${query.after}`)
  const rows = query.after === undefined
    ? db.select().from(skillLoads).where(sql.join(conditions, sql` and `))
      .orderBy(sql`${skillLoads.time} desc, ${skillLoads.seq} desc`).limit(limitOf(query.limit, 500)).all().reverse()
    : db.select().from(skillLoads).where(sql.join(conditions, sql` and `))
      .orderBy(sql`${skillLoads.time} asc, ${skillLoads.seq} asc`).limit(limitOf(query.limit, 500)).all()
  return rows.map(row => ({ seq: row.seq, time: row.time, day: row.day, name: row.name, source: row.source }))
}

export function queryDelta(db: Db, id: string, seq: number | null, baseSeq: number | null): ContextDelta | null {
  const now = queryTimeline(db, id, seq)
  if ('ok' in now) return null
  const base = baseSeq === null ? null : queryTimeline(db, id, baseSeq) as TimelineValue
  const nowView: Assembled = {
    live: now.live,
    header: now.header,
    system: now.system,
    nodes: now.nodes,
    missingLive: now.missing_live,
    approximate: now.approximate,
  }
  const baseView: Assembled | null = base === null ? null : {
    live: base.live,
    header: base.header,
    system: base.system,
    nodes: base.nodes,
    missingLive: base.missing_live,
    approximate: base.approximate,
  }
  const inc = incrementOf(nowView, baseView)
  const delta = contextDeltaOf(inc, nowView)
  if (seq === null) delta.viewNodes = []
  return delta
}

