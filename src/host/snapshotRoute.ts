import type { Context } from '@deepseek-ai/cordis'
import { asRecord } from './record'
import { type ConnectionHostFace, registerPostRoute } from './connection'

export const SNAPSHOT_ROUTE = '/api/dsh-context/snapshot'

const SNAPSHOT_KEYS = new Set<string>(['contextTimeline', 'contextActivity'])

interface ListRecordLike {
  header?: unknown
}

interface QueryFaceLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

interface SnapshotBlockLike {
  values?: unknown
}

interface ProjectionsFaceLike {
  snapshot(session: unknown, keys?: ReadonlySet<string>): SnapshotBlockLike | undefined
}

interface CacheFaceLike {
  cachedSnapshot(header: unknown, keys?: ReadonlySet<string>): SnapshotBlockLike | undefined
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
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

export function watchSnapshotRoute(ctx: Context): () => void {
  const fiber = ctx.inject(['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'], (c) => {
    const query = c.get('sessionQuery') as QueryFaceLike
    const cache = c.get('sessionProjectionCache') as CacheFaceLike
    const projections = c.get('sessionProjections') as ProjectionsFaceLike
    const sessions = c.get('sessions') as { get(id: string): unknown }
    const listSessions = query.listSessions.bind(query)
    const snapshotOf = projections.snapshot.bind(projections)
    const cachedOf = cache.cachedSnapshot.bind(cache)
    const getSession = sessions.get.bind(sessions)

    const handler = async (request: Request): Promise<Response> => {
      let wanted: Set<string> | undefined
      try {
        const body = (await request.json()) as unknown
        wanted = body !== null && typeof body === 'object' ? wantedIdsOf(body as Record<string, unknown>) : undefined
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      try {
        const records = await listSessions()
        if (!Array.isArray(records)) return reply({ ok: true, value: {} })
        const values: Record<string, Record<string, unknown>> = {}
        for (const record of records as (ListRecordLike | null)[]) {
          const header = asRecord(record?.header)
          const id = typeof header?.id === 'string' ? header.id : undefined
          if (id === undefined || (wanted !== undefined && !wanted.has(id))) continue
          let block: SnapshotBlockLike | undefined
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
          for (const key of SNAPSHOT_KEYS) {
            if (served[key] !== undefined) picked[key] = served[key]
          }
          if (Object.keys(picked).length > 0) values[id] = picked
        }
        return reply({ ok: true, value: values })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }

    if (!registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, SNAPSHOT_ROUTE, handler, 'dsh-context: snapshot route')) return
    /* v8 ignore next 1 -- the fiber's unmount cleanup, driven by cordis only */
    return () => {}
  })
  const handle = fiber as { dispose?: () => unknown } | undefined
  return () => { void handle?.dispose?.() }
}
