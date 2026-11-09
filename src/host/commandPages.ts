import type { Context } from '@deepseek-ai/cordis'
import type { CommandPage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply, revisionOf } from './postRoute'
import { makeFoldCache, type FoldCache } from './foldCache'
import type { FoldBounds } from './config'
import { applyTimeline } from './fold'
import { createTimelineState } from './foldState'
import type { CommandStateRecord, TimelineState } from './foldState'
import { serveCommand } from './foldWire'
import { serviceIdentityOf } from './serviceIdentity'

export const COMMANDS_ROUTE = '/api/dsh-context/commands'

const PAGE_LIMIT = 400
const PAGE_LIMIT_MAX = 1_000

const FOLD_YIELD_EVENTS = 1_000

const STATE_CACHE_MAX = 2

interface CommandObservation {
  source?: unknown
  revision?: unknown
  cursor?: unknown
  events?: unknown
  [Symbol.dispose]?: unknown
}

interface CachedState {
  live: boolean
  persistence?: unknown
  revision?: string
  cursor: number
  state: TimelineState
}

function cursorOf(observation: CommandObservation): number {
  const cursor = observation.cursor
  return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : -1
}

function reusable(
  entry: CachedState,
  live: boolean,
  revision: string | undefined,
  cursor: number,
  persistence: unknown,
): boolean {
  if (entry.live !== live || entry.cursor > cursor) return false
  return live || (entry.revision === revision && entry.persistence === persistence)
}

function pageOf(state: TimelineState, beforeSeq: number | undefined, limit: number): CommandPage {
  const older: CommandStateRecord[] = []
  for (const rec of state.commands) if (beforeSeq === undefined || rec.seq < beforeSeq) older.push(rec)
  older.sort((a, b) => a.seq - b.seq)
  const page = older.length > limit ? older.slice(older.length - limit) : older
  return {
    commands: page.map(serveCommand),
    atStart: older.length <= limit,
    total: state.commands.length,
  }
}

async function readPage(
  observation: CommandObservation,
  beforeSeq: number | undefined,
  limit: number,
  bounds: FoldBounds,
  cache: FoldCache<CachedState>,
  sessionId: string,
  persistence: unknown,
): Promise<CommandPage | null> {
  const live = observation.source === 'live'
  const revision = live ? undefined : revisionOf(observation)
  const cursor = cursorOf(observation)
  const keyed = live || revision !== undefined
  const cached = keyed ? cache.get(sessionId, entry => reusable(entry, live, revision, cursor, persistence)) : undefined
  let state = cached?.state ?? createTimelineState()
  let cut = cached?.cursor ?? -1
  if (cut < cursor) {
    if (!Array.isArray(observation.events)) return null
    const fullBounds: FoldBounds = { ...bounds, maxCommands: Number.MAX_SAFE_INTEGER }
    let folded = 0
    for (let i = cut + 1; i < observation.events.length && i <= cursor; i++) {
      state = applyTimeline(state, observation.events[i] as never, fullBounds)
      cut = i
      if (++folded % FOLD_YIELD_EVENTS === 0) await new Promise(resolve => setTimeout(resolve, 0))
    }
  }
  if (keyed) {
    cache.set(sessionId, { live, persistence, ...(revision !== undefined ? { revision } : {}), cursor: cut, state })
  }
  return pageOf(state, beforeSeq, limit)
}

export function watchCommandPageChannel(
  ctx: Context,
  bounds: FoldBounds,
  coldReads: ColdReadGate = makeColdReadGate(),
  options: { idleSweepMs?: number } = {},
): void {
  const cache = makeFoldCache<CachedState>(ctx, {
    maxEntries: STATE_CACHE_MAX,
    idleMs: options.idleSweepMs,
  })
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery'],
    path: COMMANDS_ROUTE,
    label: 'dsh-context: command page route',
    handler: (c) => {
      const observe = observeOf(c)
      if (observe === undefined) return undefined
      return async (request: Request): Promise<Response> => {
        cache.touch()
        const read = await readBody(request)
        if (!read.ok) return read.response
        const body = read.body
        const sessionId = body !== null && typeof body === 'object' ? (body as { sessionId?: unknown }).sessionId : undefined
        const beforeSeq = body !== null && typeof body === 'object' ? (body as { beforeSeq?: unknown }).beforeSeq : undefined
        const limit = body !== null && typeof body === 'object' ? (body as { limit?: unknown }).limit : undefined
        if (typeof sessionId !== 'string' || sessionId === '') {
          return failure('dsh-context/bad-request', 'missing sessionId')
        }
        if (beforeSeq !== undefined && (typeof beforeSeq !== 'number' || !Number.isFinite(beforeSeq) || beforeSeq < 0)) {
          return failure('dsh-context/bad-request', 'beforeSeq must be a non-negative number')
        }
        const pageSize = typeof limit === 'number' && Number.isFinite(limit)
          ? Math.min(PAGE_LIMIT_MAX, Math.max(1, Math.floor(limit)))
          : PAGE_LIMIT
        try {
          const persistence = serviceIdentityOf(c.get('sessionPersistence'))
          const value = await coldReads.admit(async () => {
            const observation = await observe(sessionId, { projectionMode: 'none' }) as CommandObservation | null
            if (observation === null || typeof observation !== 'object') return null
            const release = leaseOf(observation)
            try {
              return await readPage(observation, beforeSeq, pageSize, bounds, cache, sessionId, persistence)
            } finally {
              release()
            }
          })
          return reply({ ok: true, value: value ?? null })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
