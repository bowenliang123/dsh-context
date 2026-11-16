import type { Context } from '@deepseek-ai/cordis'
import { statSync } from 'node:fs'
import { sql } from 'drizzle-orm'
import { asRecord } from '../record'
import { failure, mountPostRoute, readBody, reply } from '../postRoute'
import type { CostSource } from '../cost'
import type { Db } from './db'
import { metaSnapshot } from './db'
import type { BackfillScheduler } from './scheduler'
import { countRows, foldStatusDistribution, queryCost, queryFamily } from './queries/family'
import { queryDays, querySummary, queryTally } from './queries/aggregate'
import { querySessions } from './queries/sessions'
import {
  queryContext, queryDelta, queryEvents, queryFileOps, queryRequests, querySkillLoads,
  querySpans, querySteps, queryTimeline, queryToolCalls, sessionState,
} from './queries/detail'
import type { SnapshotValue, TimelineValue } from './queries/detail'
import { limitOf, offsetOf, scopeOf } from './queries/common'
import type { QueryScope } from './queries/common'
import { SCHEMA_VERSION, sessions } from './schema'

export interface RouteHost {
  ctx: Context
  db: Db
  cost: CostSource
  scheduler: BackfillScheduler
  path: string
  harnessSupported: boolean
  attribution?: (name: string) => string | undefined
  mode: 'file' | 'memory' | 'degraded'
}

type Handler = (body: Record<string, unknown>) => unknown

function pricingVersionOf(host: RouteHost, metaPricing: number): number {
  return host.cost.version?.() ?? metaPricing
}

function revisionOf(generation: number, pricingVersion: number): string {
  return `${generation}:${pricingVersion}`
}

function mount(host: RouteHost, route: string, handler: Handler, options: { unchanged?: boolean; session?: boolean } = {}): void {
  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: `/api/dsh-context/${route}`,
    label: `dsh-context: ${route} route`,
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const meta = metaSnapshot(host.db)
      const pricingVersion = pricingVersionOf(host, meta.pricingVersion)
      if (options.unchanged === true
        && typeof body.generation === 'number' && body.generation === meta.generation
        && typeof body.pricing_version === 'number' && body.pricing_version === pricingVersion) {
        return reply({
          ok: true,
          unchanged: true,
          revision: revisionOf(meta.generation, pricingVersion),
          generation: meta.generation,
          pricing_version: pricingVersion,
          pricing_ready: host.cost.ready(),
        })
      }
      if (options.session === true && typeof body.sessionId === 'string') {
        const state = sessionState(host.db, body.sessionId)
        if (state !== undefined
          && typeof body.detail_rev === 'number' && body.detail_rev === state.detailRev
          && typeof body.db_epoch === 'string' && body.db_epoch === meta.epoch
          && typeof body.pricing_version === 'number' && body.pricing_version === pricingVersion) {
          return reply({
            ok: true,
            unchanged: true,
            detail_rev: state.detailRev,
            db_epoch: meta.epoch,
            pricing_version: pricingVersion,
          })
        }
      }
      try {
        const value = handler(body)
        return reply({
          ok: true,
          value,
          revision: revisionOf(meta.generation, pricingVersion),
          generation: meta.generation,
          pricing_version: pricingVersion,
          pricing_ready: host.cost.ready(),
          db_epoch: meta.epoch,
        })
      } catch (error: unknown) {
        return failure('gateway/internal', error instanceof Error ? error.message : String(error))
      }
    },
  })
}

function sessionIdOf(body: Record<string, unknown>): string | null {
  return typeof body.sessionId === 'string' && body.sessionId !== '' ? body.sessionId : null
}

function scopeOrUndefined(value: unknown): QueryScope | undefined {
  return asRecord(value) === null ? undefined : scopeOf(value)
}

export function mountQueryRoutes(host: RouteHost): void {
  mount(host, 'query/sessions', (body) => {
    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string').slice(0, 256) : undefined
    return querySessions(host.db, host.cost, {
      scope: scopeOf(body.scope),
      sort: body.sort === 'tokens' || body.sort === 'context' ? body.sort : 'recent',
      page: offsetOf(body.page),
      pageSize: limitOf(body.pageSize, 12, 100),
      ...(ids === undefined ? {} : { ids }),
    }, host.scheduler.coverage())
  }, { unchanged: true })

  mount(host, 'query/summary', body => querySummary(host.db, host.cost, scopeOf(body.scope), {
    sessionsTotal: countRoots(host.db),
    coverage: host.scheduler.coverage(),
  }), { unchanged: true })

  mount(host, 'query/days', body => queryDays(host.db, host.cost, scopeOf(body.scope)), { unchanged: true })

  mount(host, 'query/tally', (body) => {
    const field = body.field === 'tools' || body.field === 'cmds' || body.field === 'models' || body.field === 'providers'
      ? body.field
      : 'skills'
    const cursor = typeof body.cursor === 'string' ? Number(body.cursor) : body.cursor
    return queryTally(
      host.db,
      scopeOf(body.scope),
      field,
      limitOf(body.limit, 100, 500),
      offsetOf(cursor),
      body.sort === 'last' ? 'last' : 'n',
    )
  }, { unchanged: true })

  mount(host, 'query/context', (body) => {
    if (Array.isArray(body.ids)) {
      const ids = body.ids.filter((id): id is string => typeof id === 'string').slice(0, 256)
      const out: Record<string, unknown> = {}
      for (const id of ids) out[id] = queryContext(host.db, host.cost, id)
      return out
    }
    const id = sessionIdOf(body)
    return id === null ? null : queryContext(host.db, host.cost, id)
  }, { session: true })

  mount(host, 'query/timeline', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return null
    const archive = asRecord(body.archive)
    const seq = typeof body.seq === 'number' && Number.isFinite(body.seq) ? body.seq : null
    return queryTimeline(host.db, id, seq, {
      limit: limitOf(body.limit, 2_000, 5_000),
      ...(archive === null || typeof archive.limit !== 'number' ? {} : { archiveLimit: limitOf(archive.limit, 400, 2_000) }),
    })
  }, { session: true })

  mount(host, 'query/requests', (body) => {
    const id = sessionIdOf(body)
    const scope = scopeOrUndefined(body.scope)
    return queryRequests(host.db, {
      ...(id === null ? {} : { sessionId: id }),
      ...(scope === undefined ? {} : { scope }),
      ...(typeof body.turn === 'number' ? { turn: body.turn } : {}),
      ...(typeof body.day === 'string' ? { day: body.day } : {}),
      ...(typeof body.model === 'string' ? { model: body.model } : {}),
      ...(typeof body.after === 'number' ? { after: body.after } : {}),
      ...(typeof body.offsetFromEnd === 'number' ? { offsetFromEnd: body.offsetFromEnd } : {}),
      limit: limitOf(body.limit, 500),
    })
  })

  mount(host, 'query/steps', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return []
    return querySteps(host.db, id, typeof body.after === 'number' ? body.after : undefined, limitOf(body.limit, 500))
  })

  mount(host, 'query/tool-calls', (body) => {
    const id = sessionIdOf(body)
    const scope = scopeOrUndefined(body.scope)
    const cursor = asRecord(body.cursor)
    return queryToolCalls(host.db, {
      ...(id === null ? {} : { sessionId: id }),
      ...(scope === undefined ? {} : { scope }),
      ...(body.status === 'failed' || body.status === 'slow' || body.status === 'background' ? { status: body.status } : {}),
      ...(typeof body.slow_ms === 'number' ? { slowMs: body.slow_ms } : {}),
      ...(typeof body.program === 'string' ? { program: body.program } : {}),
      ...(typeof body.query === 'string' ? { query: body.query } : {}),
      ...(body.commands_only === true ? { commandsOnly: true } : {}),
      ...(typeof body.beforeSeq === 'number' ? { beforeSeq: body.beforeSeq } : {}),
      sort: body.sort === 'slowest' ? 'slowest' : 'latest',
      ...(cursor === null || typeof cursor.seq !== 'number'
        ? {}
        : {
          cursor: {
            seq: cursor.seq,
            ...(typeof cursor.time === 'number' ? { time: cursor.time } : {}),
            ...(typeof cursor.duration === 'number' ? { duration: cursor.duration } : {}),
          },
        }),
      limit: limitOf(body.limit, 200),
    }, host.attribution)
  })

  mount(host, 'query/file-ops', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return { items: [], total: 0 }
    return queryFileOps(host.db, id, body.mode === 'paths' ? 'paths' : 'list', {
      ...(typeof body.kind === 'string' ? { kind: body.kind } : {}),
      ...(typeof body.after === 'number' ? { after: body.after } : {}),
      limit: limitOf(body.limit, 500),
    })
  })

  mount(host, 'query/events', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return []
    return queryEvents(host.db, id, {
      ...(Array.isArray(body.kinds) ? { kinds: body.kinds.filter((kind): kind is string => typeof kind === 'string') } : {}),
      ...(typeof body.after === 'number' ? { after: body.after } : {}),
      limit: limitOf(body.limit, 500),
    })
  })

  mount(host, 'query/spans', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return []
    return querySpans(host.db, id, {
      ...(typeof body.before === 'number' ? { before: body.before } : {}),
      limit: limitOf(body.limit, 2_000, 5_000),
    })
  })

  mount(host, 'query/skill-loads', (body) => {
    const id = sessionIdOf(body)
    const scope = scopeOrUndefined(body.scope)
    return querySkillLoads(host.db, {
      ...(id === null ? {} : { sessionId: id }),
      ...(scope === undefined ? {} : { scope }),
      ...(typeof body.name === 'string' ? { name: body.name } : {}),
      ...(typeof body.day === 'string' ? { day: body.day } : {}),
      ...(typeof body.after === 'number' ? { after: body.after } : {}),
      limit: limitOf(body.limit, 500),
    })
  })

  mount(host, 'query/family', (body) => {
    const id = typeof body.rootId === 'string' ? body.rootId : sessionIdOf(body)
    return id === null ? null : queryFamily(host.db, host.cost, id)
  })

  mount(host, 'query/cost', (body) => {
    const scope = scopeOrUndefined(body.scope)
    const id = sessionIdOf(body)
    return queryCost(host.db, host.cost, {
      ...(scope === undefined ? {} : { scope }),
      ...(id === null ? {} : { sessionId: id }),
      ...(body.family === true ? { family: true } : {}),
    })
  })

  mount(host, 'query/status', () => statusOf(host))

  mount(host, 'delta', (body) => {
    const id = sessionIdOf(body)
    if (id === null) return null
    const seq = typeof body.seq === 'number' ? body.seq : null
    const baseSeq = typeof body.baseSeq === 'number' ? body.baseSeq : null
    return queryDelta(host.db, id, seq, baseSeq)
  })

  mount(host, 'backfill', () => {
    host.scheduler.request()
    return { coverage: host.scheduler.coverage() }
  })

  mountCompat(host)
}

function mountCompat(host: RouteHost): void {
  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: '/api/dsh-context/detail',
    label: 'dsh-context: detail compatibility route',
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const id = sessionIdOf(body)
      if (id === null) return reply({ ok: true, value: null })
      const head = queryContext(host.db, host.cost, id)
      if ('ok' in head && ! head.ok) return reply({ ok: true, value: null })
      if (body.head === true) return reply({ ok: true, value: { head } })
      const value = detailValue(host, id, head)
      return reply({ ok: true, value })
    },
  })

  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: '/api/dsh-context/facts',
    label: 'dsh-context: facts compatibility route',
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const id = sessionIdOf(body)
      if (id === null) return reply({ ok: true, value: null })
      const value = factsValue(host, id, body)
      return reply({ ok: true, value })
    },
  })

  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: '/api/dsh-context/heads',
    label: 'dsh-context: heads compatibility route',
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === 'string') : []
      const out: Record<string, { head: unknown }> = {}
      for (const id of ids) {
        const head = queryContext(host.db, host.cost, id)
        if ('ok' in head && ! head.ok) continue
        out[id] = { head }
      }
      return reply({ ok: true, value: out })
    },
  })

  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: '/api/dsh-context/commands',
    label: 'dsh-context: commands compatibility route',
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const id = sessionIdOf(body)
      if (id === null) return reply({ ok: true, value: null })
      const limit = limitOf(body.limit, 400, 1_000)
      const result = queryToolCalls(host.db, {
        sessionId: id,
        commandsOnly: true,
        sort: 'latest',
        limit,
        ...(typeof body.beforeSeq === 'number' ? { beforeSeq: body.beforeSeq } : {}),
      }, host.attribution)
      return reply({
        ok: true,
        value: { commands: result.items, atStart: result.items.length < limit, total: result.total },
      })
    },
  })

  mountPostRoute({
    ctx: host.ctx,
    deps: ['connection'],
    path: '/api/dsh-context/overview',
    label: 'dsh-context: overview compatibility route',
    handler: () => async (request: Request): Promise<Response> => {
      host.scheduler.noteRoute()
      const read = await readBody(request)
      if (!read.ok) return read.response
      const body = asRecord(read.body) ?? {}
      const meta = metaSnapshot(host.db)
      const pricingVersion = pricingVersionOf(host, meta.pricingVersion)
      const revision = revisionOf(meta.generation, pricingVersion)
      if (typeof body.revision === 'string' && body.revision === revision) {
        return reply({ ok: true, value: { revision, unchanged: true } })
      }
      const value = overviewValue(host, body, revision)
      return reply({ ok: true, value })
    },
  })
}

function detailValue(host: RouteHost, id: string, head: SnapshotValue): Record<string, unknown> {
  const timeline = queryTimeline(host.db, id, null, { limit: 2_000, archiveLimit: 400 }) as TimelineValue
  const requests = queryRequests(host.db, { sessionId: id, limit: 1_500 })
  const events = queryEvents(host.db, id, { limit: 500 })
  const files = queryFileOps(host.db, id, 'list', { limit: 500 })
  const commands = queryToolCalls(host.db, { sessionId: id, commandsOnly: true, limit: 400 }, host.attribution)
  const spans = querySpans(host.db, id, { limit: 2_000 })
  return {
    rev: head.detailRev,
    head,
    requests,
    events,
    nodes: timeline.nodes,
    droppedNodes: timeline.droppedNodes,
    archive: timeline.archive,
    ...(timeline.surfaceFloor === undefined ? {} : { surfaceFloor: timeline.surfaceFloor }),
    ...(timeline.archiveFloor === undefined ? {} : { archiveFloor: timeline.archiveFloor }),
    fileOps: files.items,
    commands: commands.items,
    spans,
  }
}

function factsValue(host: RouteHost, id: string, body: Record<string, unknown>): Record<string, unknown> | null {
  const head = queryContext(host.db, host.cost, id)
  if ('ok' in head && ! head.ok) return null
  const parts = Array.isArray(body.parts) ? body.parts.filter((part): part is string => typeof part === 'string') : []
  const window = asRecord(body.window) ?? {}
  const out: Record<string, unknown> = {}
  for (const part of parts) {
    if (part === 'head') out.head = head
    else if (part === 'series') out.series = queryRequests(host.db, { sessionId: id, limit: limitOf(window.requestsTail, 500) })
    else if (part === 'requests') out.requests = queryRequests(host.db, { sessionId: id, limit: limitOf(window.requestsTail, 500) })
    else if (part === 'events') out.events = queryEvents(host.db, id, { limit: limitOf(window.eventsTail, 500) })
    else if (part === 'nodes') {
      const timeline = queryTimeline(host.db, id, null, {
        limit: limitOf(window.nodesTail, 2_000, 5_000),
        archiveLimit: limitOf(window.nodesTail, 400, 2_000),
      }) as TimelineValue
      out.nodes = {
        nodes: timeline.nodes,
        archive: timeline.archive,
        droppedNodes: timeline.droppedNodes,
        ...(timeline.surfaceFloor === undefined ? {} : { surfaceFloor: timeline.surfaceFloor }),
        ...(timeline.archiveFloor === undefined ? {} : { archiveFloor: timeline.archiveFloor }),
      }
    } else if (part === 'files') {
      const files = queryFileOps(host.db, id, 'list', { limit: limitOf(window.filesTail, 500) })
      out.files = { fileOps: (files as { items: unknown[] }).items }
    } else if (part === 'commands') {
      const commands = queryToolCalls(host.db, {
        sessionId: id,
        commandsOnly: true,
        limit: limitOf(window.commandsTail, 400),
      }, host.attribution)
      out.commands = {
        commands: commands.items,
        ...(head.commandStats === undefined ? {} : { commandStats: head.commandStats }),
      }
    } else if (part === 'spans') out.spans = querySpans(host.db, id, { limit: limitOf(window.spansTail, 2_000, 5_000) })
  }
  return { rev: head.detailRev, live: true, parts: out }
}

function overviewValue(host: RouteHost, body: Record<string, unknown>, revision: string): Record<string, unknown> {
  const part = body.part
  const scope = scopeOf(body.scope)
  const pricingReady = host.cost.ready()
  if (part === 'summary') {
    const total = countRoots(host.db)
    return {
      revision,
      pricingReady,
      summary: querySummary(host.db, host.cost, scope, { sessionsTotal: total, coverage: host.scheduler.coverage() }),
    }
  }
  if (part === 'days') return { revision, pricingReady, days: queryDays(host.db, host.cost, scope) }
  if (part === 'tally') {
    const field = body.tally === 'tools' || body.tally === 'cmds' ? body.tally : 'skills'
    const tally = queryTally(host.db, scope, field, 500, 0, 'n')
    return { revision, pricingReady, tally: { field, stats: tally.stats } }
  }
  const sort = body.sort === 'tokens' || body.sort === 'context' ? body.sort : 'recent'
  const page = offsetOf(body.page)
  const pick = asRecord(body.pick)
  const pageScope = pick === null
    ? scope
    : { ...scope, pick: { field: pick.field as 'skills' | 'tools' | 'cmds', name: String(pick.name) } }
  const result = querySessions(host.db, host.cost, {
    scope: pageScope,
    sort,
    page,
    pageSize: 12,
  }, host.scheduler.coverage())
  return {
    revision,
    pricingReady,
    page: {
      items: result.items.map(row => ({
        id: row.id,
        title: row.title,
        ...(row.cwd === null ? {} : { cwd: row.cwd }),
        updatedAt: row.updated_at,
        running: row.running,
        archived: row.archived,
        ...(row.workspace_title === null ? {} : { group: row.workspace_title }),
        tokens: row.family_billed_tokens,
        turns: row.turns,
        steps: row.steps,
        parts: row.cur_parts,
        total: row.cur_total,
        ...(row.context_window === null ? {} : { contextWindow: row.context_window }),
        ...(row.max_output_tokens === null ? {} : { maxOutputTokens: row.max_output_tokens }),
        ...(row.model === null ? {} : { model: row.model }),
        ...(row.last_user === null ? {} : { lastUser: row.last_user }),
        costUsd: row.family_cost_usd,
        ...(row.created_day === null ? {} : { createdDay: row.created_day }),
      })),
      index: page,
      count: Math.max(1, Math.ceil(result.total / 12)),
      total: result.total,
      scopeTotal: result.scope_total,
      groups: result.groups,
    },
  }
}

function countRoots(db: Db): number {
  const row = db.get<{ n: number }>(sqlCountRoots())
  return (row as { n: number }).n
}

function sqlCountRoots() {
  return sql`select count(*) as n from ${sessions} where ${sessions.origin} is null and ${sessions.blank} = 0`
}

function dbBytesOf(path: string): number {
  let total = 0
  for (const candidate of [path, `${path}-wal`]) {
    try {
      total += statSync(candidate).size
    } catch {}
  }
  return total
}

export function statusOf(host: RouteHost): Record<string, unknown> {
  const meta = metaSnapshot(host.db)
  const coverage = host.scheduler.coverage()
  const pricingVersion = pricingVersionOf(host, meta.pricingVersion)
  return {
    schema_version: SCHEMA_VERSION,
    generation: meta.generation,
    db_epoch: meta.epoch,
    pricing_version: pricingVersion,
    pricing_ready: host.cost.ready(),
    ready: host.scheduler.startupPhase() === 'ready' && host.scheduler.integrityState() !== 'failed',
    startup_phase: host.scheduler.startupPhase(),
    hydrating: host.scheduler.isHydrating(),
    integrity_check: host.scheduler.integrityState(),
    mode: host.mode,
    db_bytes: dbBytesOf(host.path),
    coverage,
    counts: countRows(host.db),
    fold_status: foldStatusDistribution(host.db),
    reaper: host.scheduler.reaperStats(),
    harness_supported: host.harnessSupported,
  }
}

export { SCHEMA_VERSION }
