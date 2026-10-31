import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import { buildTimelineDetail, buildTimelineHead } from './foldWire'
import { disposeObservation, revisionOf } from './observation'
import type { ContextTimelineDetail, Snapshot } from '../shared/types'
import type { TimelineState } from './foldState'

export const DETAIL_ROUTE = '/api/dsh-context/detail'

const FOLD_YIELD_EVENTS = 1_000

const ENTRY_CACHE_MAX = 4

interface DetailEntry {
  source: string
  header: unknown
  revision: string | undefined
  persistence: unknown
  events: number
  full: boolean
  state: TimelineState
  value: ContextTimelineDetail | undefined
}

interface ObservationFace {
  header: unknown
  events: readonly unknown[]
  source?: unknown
  revision?: unknown
  [Symbol.dispose]?: unknown
}

function headPayloadOf(state: TimelineState): { rev: number; head: Snapshot } {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state) }
}

interface SessionsHostFace {
  get?(id: string): unknown
}

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

async function foldEvents(state: TimelineState, events: readonly unknown[], from: number, bounds: FoldBounds): Promise<TimelineState> {
  for (let index = from; index < events.length; index++) {
    state = applyTimeline(state, events[index] as never, bounds)
    if ((index - from + 1) % FOLD_YIELD_EVENTS === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return state
}

function reusable(
  entry: DetailEntry | undefined,
  source: string,
  header: unknown,
  eventCount: number,
  full: boolean,
): boolean {
  if (entry === undefined) return false
  if (full && !entry.full) return false
  return source === 'live' && entry.source === 'live' && entry.header === header && eventCount >= entry.events
}

function touch(entries: Map<string, DetailEntry>, id: string, entry: DetailEntry): void {
  entries.delete(id)
  entries.set(id, entry)
  for (const oldest of entries.keys()) {
    if (entries.size <= ENTRY_CACHE_MAX) break
    entries.delete(oldest)
  }
}

export function watchDetailChannel(ctx: Context, bounds: FoldBounds, coldReads: ColdReadGate = makeColdReadGate()): void {
  const entries = new Map<string, DetailEntry>()
  ctx.inject(['connection', 'sessions'], (c) => {
    const sessions = c.get('sessions') as SessionsHostFace | undefined
    const getSession = typeof sessions?.get === 'function' ? sessions.get.bind(sessions) : undefined
    if (getSession === undefined) return
    const projections = ctx.sessionProjections

    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let headOnly = false
      try {
        const body: unknown = await request.json()
        sessionId = body !== null && typeof body === 'object'
          ? (body as { sessionId?: unknown }).sessionId
          : undefined
        headOnly = body !== null && typeof body === 'object' && (body as { head?: unknown }).head === true
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        const session = getSession(sessionId)
        if (headOnly && session !== undefined && session !== null) {
          try {
            const snapshot = projections.snapshot(session as never, ['contextTimeline'])
            const head = snapshot.values.contextTimeline
            if (head !== undefined) return reply({ ok: true, value: { rev: head.detailRev ?? 0, head } })
          } catch {}
        }
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        const persistence: unknown = ctx.get('sessionPersistence')
        const live = session !== undefined && session !== null
        const read = async (): Promise<unknown> => {
          if (observe === undefined) return null
          const observation = await observe(sessionId, { projectionMode: 'none' }) as ObservationFace | null
          try {
            const revision = revisionOf(observation)
            const source = typeof observation?.source === 'string' ? observation.source : ''
            const header = observation?.header
            const hit = entries.get(sessionId)
            if (source !== 'live' && revision !== undefined && hit !== undefined
              && hit.source === source && hit.revision === revision && hit.persistence === persistence
              && (headOnly || hit.full)) {
              touch(entries, sessionId, hit)
              if (headOnly) return headPayloadOf(hit.state)
              return hit.value
            }
            const events = observation?.events
            if (!Array.isArray(events)) return null
            const reuse = reusable(hit, source, header, events.length, !headOnly)
            const entry = reuse
              ? hit as DetailEntry
              : {
                source,
                header,
                revision,
                persistence,
                events: 0,
                full: !headOnly,
                state: createTimelineState(!headOnly),
                value: undefined,
              }
            const before = entry.events
            entry.state = await foldEvents(entry.state, events, entry.events, bounds)
            entry.events = events.length
            if (before !== events.length) entry.value = undefined
            if (headOnly) {
              touch(entries, sessionId, entry)
              return headPayloadOf(entry.state)
            }
            if (entry.value === undefined) entry.value = buildTimelineDetail(entry.state, bounds)
            touch(entries, sessionId, entry)
            return entry.value
          } finally {
            disposeObservation(observation)
          }
        }
        const value = live ? await read() : await coldReads.admit(read)
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, DETAIL_ROUTE, handler, 'dsh-context: detail route')
  })
}
