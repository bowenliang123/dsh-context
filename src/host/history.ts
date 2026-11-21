import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { historyBounds, type FoldBounds } from './config'
import { makeColdReadGate, type ColdReadGate } from './coldRead'
import { foldLog } from './detailShadow'
import { makeFoldCache } from './foldCache'
import { eventsOf, requestRowsOf } from './foldWire'
import { stateBytesOf, type TimelineState } from './foldState'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply, revisionOf } from './postRoute'
import { asRecord } from './record'
import { serviceIdentityOf } from './serviceIdentity'
import type { SessionsFace } from './faces'
import { milestoneKindOf } from '../shared/milestones'
import { HISTORY_PARTS, type HistoryPage, type HistoryPart, type HistoryRow } from '../shared/types'

export const HISTORY_ROUTE = '/api/dsh-context/history'

const PART_SET = new Set<HistoryPart>(HISTORY_PARTS)
const PAGE_LIMIT_MAX = 1_000
const PAGE_LIMIT: Record<HistoryPart, number> = {
  requests: 400,
  events: 400,
  milestones: 400,
  nodes: 200,
  archive: 200,
  files: 200,
  spans: 1_000,
}
const SEQ_PARTS = new Set<HistoryPart>(['requests', 'events', 'milestones'])
const STATE_CACHE_MAX = 2
const STATE_CACHE_BYTES = 64 * 1024 * 1024
const COLD_FRESH_MS = 5_000

interface HistoryRead {
  sessionId: string
  part: HistoryPart
  beforeSeq?: number
  beforeIndex?: number
  limit: number
}

interface ColdState {
  persistence: unknown
  revision: string
  statRevision?: string
  state: TimelineState
  rows?: { part: HistoryPart; rows: HistoryRow[] }
  checkedAt: number
}

const liveRows = new WeakMap<TimelineState, { part: HistoryPart; rows: HistoryRow[] }>()

function requestOf(body: unknown): HistoryRead | null {
  const data = asRecord(body)
  if (data === null) return null
  const sessionId = data.sessionId
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const part = data.part
  if (typeof part !== 'string' || !PART_SET.has(part as HistoryPart)) return null
  const beforeSeq = data.beforeSeq
  const beforeIndex = data.beforeIndex
  const limit = data.limit
  const historyPart = part as HistoryPart
  return {
    sessionId,
    part: historyPart,
    ...(typeof beforeSeq === 'number' && Number.isSafeInteger(beforeSeq) && beforeSeq >= 0 ? { beforeSeq } : {}),
    ...(typeof beforeIndex === 'number' && Number.isSafeInteger(beforeIndex) && beforeIndex >= 0 ? { beforeIndex } : {}),
    limit: typeof limit === 'number' && Number.isFinite(limit)
      ? Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.floor(limit)))
      : PAGE_LIMIT[historyPart],
  }
}

function stateBytesOfEntry(entry: ColdState): number {
  return stateBytesOf(entry.state) + (entry.rows?.rows.length ?? 0) * 128
}

function lowerBound(rows: readonly { seq: number }[], seq: number): number {
  let low = 0
  let high = rows.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (rows[mid].seq < seq) low = mid + 1
    else high = mid
  }
  return low
}

type PageSlice = Omit<HistoryPage, 'rev' | 'live' | 'part'>

type SeqHistoryRow = Extract<HistoryRow, { seq: number }>

function pageBySeq(rows: readonly SeqHistoryRow[], beforeSeq: number | undefined, limit: number): PageSlice {
  const end = beforeSeq === undefined ? rows.length : lowerBound(rows, beforeSeq)
  let start = Math.max(0, end - limit)
  while (start > 0 && rows[start - 1].seq === rows[start].seq) start--
  return {
    rows: rows.slice(start, end),
    first: start,
    last: end - 1,
    total: rows.length,
    atStart: start === 0,
    atEnd: end === rows.length,
    ...(start > 0 ? { beforeSeq: rows[start].seq } : {}),
  }
}

function pageByIndex(rows: readonly HistoryRow[], beforeIndex: number | undefined, limit: number): PageSlice {
  const end = beforeIndex === undefined ? rows.length : Math.min(beforeIndex, rows.length)
  const start = Math.max(0, end - limit)
  return {
    rows: rows.slice(start, end),
    first: start,
    last: end - 1,
    total: rows.length,
    atStart: start === 0,
    atEnd: end === rows.length,
    ...(start > 0 ? { beforeIndex: start } : {}),
  }
}

function rowsOf(state: TimelineState, part: HistoryPart, cold?: ColdState): HistoryRow[] {
  if (cold?.rows?.part === part) return cold.rows.rows
  const cached = cold === undefined ? liveRows.get(state) : undefined
  if (cached?.part === part) return cached.rows
  let rows: HistoryRow[]
  switch (part) {
    case 'requests':
      rows = requestRowsOf(state)
      break
    case 'nodes':
      rows = state.surface
      break
    case 'archive':
      rows = state.archived
      break
    case 'files':
      rows = state.fileOps
      break
    case 'spans':
      rows = state.spans
      break
    default: {
      const events = eventsOf(state, state.requests)
      for (let ord = 0; ord < events.length; ord++) events[ord].ord = ord
      rows = part === 'events' ? events : events.filter(event => milestoneKindOf(event) !== null)
    }
  }
  if (cold !== undefined) cold.rows = { part, rows }
  else liveRows.set(state, { part, rows })
  return rows
}

function pageValue(state: TimelineState, live: boolean, read: HistoryRead, cold?: ColdState): HistoryPage {
  const rows = rowsOf(state, read.part, cold)
  const page = SEQ_PARTS.has(read.part)
    ? pageBySeq(rows as SeqHistoryRow[], read.beforeSeq, read.limit)
    : pageByIndex(rows, read.beforeIndex, read.limit)
  return { rev: state.detailRev ?? 0, live, part: read.part, ...page }
}

function coldCursorOf(events: readonly unknown[]): string {
  const last = events[events.length - 1]
  const seq = asRecord(last)?.seq
  return 'cold-seq:' + (typeof seq === 'number' ? String(seq) : '-1')
}

function compactHistoryState(state: TimelineState): TimelineState {
  return {
    ...state,
    systems: undefined,
    timing: undefined,
    stepWaits: undefined,
    stepApprovals: undefined,
    stepBeats: undefined,
    stepSpans: undefined,
    callNames: {},
    pendingShadowedSeqs: undefined,
    pendingShadowEventSeq: undefined,
    fileOpsFloor: undefined,
    commandsFloor: undefined,
    commandStats: undefined,
    toolTally: undefined,
    programTally: undefined,
    commandCalls: undefined,
    commandCallsOverflow: undefined,
    agents: undefined,
    todoItems: undefined,
    teamTasks: undefined,
    pendingCodeCmds: undefined,
    pendingCodeOps: undefined,
    pendingCodeStarts: undefined,
  }
}

interface ReadHandleLike {
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open?(id: string, access: 'read'): Promise<ReadHandleLike>
  stat?(id: string): Promise<unknown>
}

async function statRevisionOf(persistence: PersistenceLike | undefined, sessionId: string): Promise<string | undefined> {
  if (persistence === undefined || typeof persistence.stat !== 'function') return undefined
  try {
    const revision = asRecord(await persistence.stat(sessionId))?.revision
    return typeof revision === 'string' && revision !== '' ? 'stat:' + revision : undefined
  } catch {
    return undefined
  }
}

async function readDurableEvents(persistence: PersistenceLike | undefined, sessionId: string): Promise<SessionEvent[] | null> {
  if (persistence === undefined || typeof persistence.open !== 'function') return null
  const handle = await persistence.open(sessionId, 'read')
  try {
    const raw: unknown = await handle.read(0)
    const events = asRecord(raw)?.events
    return Array.isArray(events) ? events as SessionEvent[] : null
  } finally {
    await handle.close()
  }
}

export interface HistoryChannelDeps {
  coldReads?: ColdReadGate
  detailState?: (id: string) => Promise<TimelineState | null>
  idleSweepMs?: number
}

export function watchHistoryChannel(ctx: Context, bounds: FoldBounds, deps: HistoryChannelDeps = {}): void {
  const coldReads = deps.coldReads ?? makeColdReadGate()
  const stateCache = makeFoldCache<ColdState>(ctx, {
    maxEntries: STATE_CACHE_MAX,
    maxBytes: STATE_CACHE_BYTES,
    bytesOf: stateBytesOfEntry,
    idleMs: deps.idleSweepMs,
  })
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: HISTORY_ROUTE,
    label: 'dsh-context: history route',
    handler: (c) => {
      const live = async (sessionId: string): Promise<TimelineState | null> => {
        if (deps.detailState === undefined) return null
        try {
          return await deps.detailState(sessionId)
        } catch {
          return null
        }
      }
      const getSession = ((): ((id: string) => unknown) | undefined => {
        const sessions = c.get('sessions') as SessionsFace | undefined
        return typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
      })()
      const observe = observeOf(c)
      return async (request: Request): Promise<Response> => {
        stateCache.touch()
        const read = await readBody(request)
        if (!read.ok) return read.response
        const wanted = requestOf(read.body)
        if (wanted === null) return failure('dsh-context/bad-request', 'invalid history request')
        try {
          const session = getSession?.(wanted.sessionId)
          if (session !== undefined && session !== null) {
            const state = await live(wanted.sessionId)
            if (state !== null) return reply({ ok: true, value: pageValue(state, true, wanted) })
          }
          const persistence = c.get('sessionPersistence') as PersistenceLike | undefined
          const identity = serviceIdentityOf(persistence)
          const statRevision = await statRevisionOf(persistence, wanted.sessionId)
          if (statRevision === undefined) {
            const fresh = stateCache.get(wanted.sessionId, entry => entry.persistence === identity)
            if (fresh !== undefined && Date.now() - fresh.checkedAt < COLD_FRESH_MS) {
              return reply({ ok: true, value: pageValue(fresh.state, false, wanted, fresh) })
            }
          } else {
            const hit = stateCache.get(wanted.sessionId, entry => entry.persistence === identity && entry.statRevision === statRevision)
            if (hit !== undefined) {
              hit.checkedAt = Date.now()
              return reply({ ok: true, value: pageValue(hit.state, false, wanted, hit) })
            }
          }
          const value = await coldReads.admit(async () => {
            const durable = await readDurableEvents(persistence, wanted.sessionId)
            let events: SessionEvent[]
            let revision: string
            if (durable !== null) {
              events = durable
              revision = statRevision ?? coldCursorOf(durable)
            } else {
              if (observe === undefined) return null
              const observation = await observe(wanted.sessionId, { projectionMode: 'none' })
              const release = leaseOf(observation)
              try {
                const observed = asRecord(observation)?.events
                if (!Array.isArray(observed)) return null
                events = observed as SessionEvent[]
                revision = statRevision ?? revisionOf(observation) ?? coldCursorOf(events)
              } finally {
                release()
              }
            }
            const cached = stateCache.get(wanted.sessionId, entry => entry.persistence === identity
              && (statRevision === undefined ? entry.revision === revision : entry.statRevision === statRevision))
            if (cached !== undefined) {
              cached.checkedAt = Date.now()
              return pageValue(cached.state, false, wanted, cached)
            }
            const state = compactHistoryState((await foldLog(events, historyBounds(bounds))).state)
            const entry: ColdState = {
              persistence: identity,
              revision,
              ...(statRevision === undefined ? {} : { statRevision }),
              state,
              checkedAt: Date.now(),
            }
            stateCache.set(wanted.sessionId, entry)
            return pageValue(state, false, wanted, entry)
          })
          return reply({ ok: true, value: value ?? null })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
