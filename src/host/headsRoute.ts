import type { Context } from '@deepseek-ai/cordis'
import type { CachedSnapshotFace, ListRecordLike, SessionQueryFace, SnapshotProjectionsFace } from './faces'
import type { FoldBounds } from './config'
import { resolveBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { foldLog } from './detailShadow'
import { buildTimelineHead } from './foldWire'
import { withCost, type CostSource } from './cost'
import { failure, leaseOf, mountPostRoute, observeOf, readBody, reply } from './postRoute'
import { asRecord } from './record'

export const HEADS_ROUTE = '/api/dsh-context/heads'

const MAX_HEAD_IDS = 64

const HEAD_KEYS = new Set<string>(['contextTimeline'])

interface PersistenceStatFace {
  stat?(id: string): Promise<unknown>
}

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

function blockOf(
  block: ReturnType<CachedSnapshotFace['cachedSnapshot']>,
): { head: unknown; asOfSeq?: number } | null {
  const served = asRecord(block?.values)
  const head = served?.contextTimeline
  if (head === undefined) return null
  const asOfSeq = typeof block?.asOfSeq === 'number' && Number.isSafeInteger(block.asOfSeq) ? block.asOfSeq : undefined
  return { head, ...(asOfSeq === undefined ? {} : { asOfSeq }) }
}

async function storedHeaderOf(stat: NonNullable<PersistenceStatFace['stat']>, id: string): Promise<unknown> {
  try {
    const snapshot = asRecord(await stat(id))
    return asRecord(snapshot?.header) ?? undefined
  } catch {
    return undefined
  }
}

export interface HeadsRouteOptions {
  bounds?: FoldBounds
  coldReads?: ColdReadGate
  cost?: CostSource
}

async function coldHeadOf(
  observe: ((id: string, options: unknown) => Promise<unknown>) | undefined,
  coldReads: ColdReadGate,
  bounds: FoldBounds,
  cost: CostSource | undefined,
  id: string,
): Promise<{ head: unknown; asOfSeq?: number } | null> {
  const read = observe
  if (read === undefined) return null
  return await coldReads.admit(async () => {
    const observation = await read(id, { projectionMode: 'none' })
    const release = leaseOf(observation)
    try {
      const events = asRecord(observation)?.events
      if (!Array.isArray(events)) return null
      const folded = await foldLog(events, bounds)
      const head = withCost(cost, buildTimelineHead(folded.state))
      return { head, ...(folded.lastSeq >= 0 ? { asOfSeq: folded.lastSeq } : {}) }
    } finally {
      release()
    }
  }) ?? null
}

export function watchHeadsChannel(ctx: Context, options: HeadsRouteOptions = {}): void {
  const bounds = options.bounds ?? resolveBounds(undefined)
  const coldReads = options.coldReads ?? makeColdReadGate()
  const cost = options.cost
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'],
    path: HEADS_ROUTE,
    label: 'dsh-context: heads route',
    handler: (c) => {
      const observe = observeOf(c)
      const query = c.get('sessionQuery') as SessionQueryFace
      const cache = c.get('sessionProjectionCache') as CachedSnapshotFace
      const projections = c.get('sessionProjections') as SnapshotProjectionsFace
      const sessions = c.get('sessions') as { get(id: string): unknown }
      const persistence = asRecord(c.get('sessionPersistence')) as PersistenceStatFace | null
      const stat = persistence !== null && typeof persistence.stat === 'function'
        ? persistence.stat.bind(persistence)
        : undefined
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
          let headers: Map<string, unknown> | undefined
          const headerOf = async (id: string): Promise<unknown> => {
            if (stat !== undefined) return await storedHeaderOf(stat, id)
            if (headers === undefined) {
              headers = new Map<string, unknown>()
              const records = await listSessions()
              for (const record of (Array.isArray(records) ? records : []) as (ListRecordLike | null)[]) {
                const header = asRecord(record?.header)
                if (typeof header?.id === 'string') headers.set(header.id, header)
              }
            }
            return headers.get(id)
          }
          const values: Record<string, { head: unknown; asOfSeq?: number }> = {}
          for (const id of ids) {
            let picked: { head: unknown; asOfSeq?: number } | null = null
            let session: unknown
            try {
              session = getSession(id)
            } catch {
              session = undefined
            }
            if (session !== undefined) {
              try {
                picked = blockOf(snapshotOf(session, HEAD_KEYS))
              } catch {
                picked = null
              }
            }
            if (picked === null) {
              const header = await headerOf(id)
              if (header !== undefined) {
                try {
                  picked = blockOf(cachedOf(header, HEAD_KEYS))
                } catch {
                  picked = null
                }
              }
            }
            if (picked === null) {
              try {
                picked = await coldHeadOf(observe, coldReads, bounds, cost, id)
              } catch {
                picked = null
              }
            }
            if (picked !== null) values[id] = picked
          }
          return reply({ ok: true, value: values })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
}
