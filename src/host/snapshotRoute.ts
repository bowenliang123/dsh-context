import type { Context } from '@deepseek-ai/cordis'
import type { CachedSnapshotFace, ListRecordLike, SessionQueryFace, SnapshotProjectionsFace } from './faces'
import { asRecord } from './record'
import { failure, mountPostRoute, readBody, reply } from './postRoute'

export const SNAPSHOT_ROUTE = '/api/dsh-context/snapshot'

const SNAPSHOT_KEYS = new Set<string>(['contextTimeline', 'contextActivity'])

function compactCountsOf(value: unknown): Record<string, number> | undefined {
  const counts = asRecord(value)
  if (counts === null) return undefined
  const compact: Record<string, number> = {}
  for (const field of ['turns', 'steps'] as const) {
    const count = counts[field]
    if (typeof count === 'number' && Number.isFinite(count) && count >= 0) compact[field] = count
  }
  return Object.keys(compact).length > 0 ? compact : undefined
}

const COMPACT_TIMING_FIELDS = [
  'wallMs', 'ttftMs', 'genMs', 'calls', 'toolsMs', 'toolCalls',
  'reasoningMs', 'reasoningBlocks', 'textMs', 'textBlocks', 'toolArgMs', 'toolArgBlocks',
  'toolBusyMs', 'idleMs', 'speedTokens', 'speedMs',
] as const

function compactTimingOf(value: unknown): Record<string, unknown> | undefined {
  const timing = asRecord(value)
  if (timing === null) return undefined
  const compact: Record<string, unknown> = {}
  for (const field of COMPACT_TIMING_FIELDS) {
    const figure = timing[field]
    if (typeof figure === 'number' && Number.isFinite(figure)) compact[field] = figure
  }
  if (Object.keys(compact).length === 0) return undefined
  compact.tools = {}
  return compact
}

function compactTimelineOf(value: unknown): Record<string, unknown> | undefined {
  const view = asRecord(value)
  if (view === null) return undefined
  const compact: Record<string, unknown> = { ok: view.ok === undefined ? true : view.ok }
  const current = asRecord(view.current)
  if (current !== null) compact.current = current
  if (typeof view.contextWindow === 'number' && Number.isFinite(view.contextWindow)) compact.contextWindow = view.contextWindow
  const counts = compactCountsOf(view.counts)
  if (counts !== undefined) compact.counts = counts
  const cost = asRecord(view.cost)
  if (cost !== null) compact.cost = cost
  const timing = compactTimingOf(view.timing)
  if (timing !== undefined) compact.timing = timing
  if (typeof view.lastUser === 'string' && view.lastUser !== '') compact.lastUser = view.lastUser
  return compact
}


function wantedIdsOf(body: Record<string, unknown>): Set<string> | undefined {
  const ids = body.ids
  if (!Array.isArray(ids)) return undefined
  const wanted = new Set<string>()
  for (const id of ids) {
    if (typeof id === 'string' && id !== '') wanted.add(id)
  }
  return wanted.size > 0 ? wanted : undefined
}

export function watchSnapshotRoute(ctx: Context): void {
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'],
    path: SNAPSHOT_ROUTE,
    label: 'dsh-context: snapshot route',
    handler: (c) => {
      const query = c.get('sessionQuery') as SessionQueryFace
      const cache = c.get('sessionProjectionCache') as CachedSnapshotFace
      const projections = c.get('sessionProjections') as SnapshotProjectionsFace
      const sessions = c.get('sessions') as { get(id: string): unknown }
      const listSessions = query.listSessions.bind(query)
      const snapshotOf = projections.snapshot.bind(projections)
      const cachedOf = cache.cachedSnapshot.bind(cache)
      const getSession = sessions.get.bind(sessions)

      return async (request: Request): Promise<Response> => {
        const read = await readBody(request)
        if (!read.ok) return read.response
        const wanted = read.body !== null && typeof read.body === 'object'
          ? wantedIdsOf(read.body as Record<string, unknown>)
          : undefined
        try {
          const records = await listSessions()
          if (!Array.isArray(records)) return reply({ ok: true, value: {} })
          const values: Record<string, Record<string, unknown>> = {}
          for (const record of records as (ListRecordLike | null)[]) {
            const header = asRecord(record?.header)
            const id = typeof header?.id === 'string' ? header.id : undefined
            if (id === undefined || (wanted !== undefined && !wanted.has(id))) continue
            let block: ReturnType<CachedSnapshotFace['cachedSnapshot']>
            try {
              const session = getSession(id)
              block = session !== undefined
                ? snapshotOf(session, SNAPSHOT_KEYS)
                : cachedOf(header, SNAPSHOT_KEYS)
            } catch {
              continue
            }
            const served = asRecord(block?.values)
            if (served === null) continue
            const picked: Record<string, unknown> = {}
            const compact = compactTimelineOf(served.contextTimeline)
            if (compact !== undefined) picked.contextTimeline = compact
            if (served.contextActivity !== undefined) picked.contextActivity = served.contextActivity
            if (Object.keys(picked).length > 0) values[id] = picked
          }
          return reply({ ok: true, value: values })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
