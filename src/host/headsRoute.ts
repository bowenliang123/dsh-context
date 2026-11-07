import type { Context } from '@deepseek-ai/cordis'
import type { CachedSnapshotFace, ListRecordLike, SessionQueryFace, SnapshotProjectionsFace } from './faces'
import { asRecord } from './record'
import { failure, mountPostRoute, readBody, reply } from './postRoute'

export const HEADS_ROUTE = '/api/dsh-context/heads'

const MAX_HEAD_IDS = 64

const HEAD_KEYS = new Set<string>(['contextTimeline'])


function wantedIdsOf(body: unknown): string[] {
  const data = asRecord(body)
  if (data === null || !Array.isArray(data.ids)) return []
  const ids: string[] = []
  const seen = new Set<string>()
  for (const entry of data.ids) {
    if (typeof entry !== 'string' || entry === '' || seen.has(entry)) continue
    seen.add(entry)
    ids.push(entry)
    if (ids.length >= MAX_HEAD_IDS) break
  }
  return ids
}

export function watchHeadsChannel(ctx: Context): void {
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'],
    path: HEADS_ROUTE,
    label: 'dsh-context: heads route',
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
        const ids = wantedIdsOf(read.body)
        if (ids.length === 0) return failure('dsh-context/bad-request', 'missing ids')
        try {
          const records = await listSessions()
          if (!Array.isArray(records)) return reply({ ok: true, value: {} })
          const headers = new Map<string, unknown>()
          for (const record of records as (ListRecordLike | null)[]) {
            const header = asRecord(record?.header)
            if (typeof header?.id === 'string') headers.set(header.id, header)
          }
          const values: Record<string, { head: unknown; asOfSeq?: number }> = {}
          for (const id of ids) {
            const header = headers.get(id)
            let block: ReturnType<CachedSnapshotFace['cachedSnapshot']>
            try {
              const session = getSession(id)
              block = session !== undefined
                ? snapshotOf(session, HEAD_KEYS)
                : header === undefined ? undefined : cachedOf(header, HEAD_KEYS)
            } catch {
              continue
            }
            const served = asRecord(block?.values)
            const head = served?.contextTimeline
            if (head === undefined) continue
            const asOfSeq = typeof block?.asOfSeq === 'number' && Number.isSafeInteger(block.asOfSeq) ? block.asOfSeq : undefined
            values[id] = { head, ...(asOfSeq === undefined ? {} : { asOfSeq }) }
          }
          return reply({ ok: true, value: values })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
