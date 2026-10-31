import type { Context } from '@deepseek-ai/cordis'
import type { FoldBounds } from './config'
import { compactTimelineCheckpoint, TIMELINE_STATE_VERSION } from './timeline'

const DOMAIN = 'session_projcache'
const TABLE = 'sessions'
const DEFAULT_DELAY_MS = 1_000
const DEFAULT_YIELD_EVERY = 25

export interface CacheCompactionPacing {
  delayMs: number
  yieldEvery: number
}

interface KvTableLike {
  entries(): IterableIterator<[string, unknown]>
  update(key: string, fn: (current: unknown) => unknown): Promise<unknown>
}

interface DomainLike {
  table(name: string): KvTableLike
}

interface StorageDomainLike {
  get(name: string): DomainLike | undefined
}

interface CheckpointRowLike {
  ver?: unknown
  val?: unknown
  [key: string]: unknown
}

interface CheckpointRecordLike {
  rows?: Record<string, CheckpointRowLike>
  [key: string]: unknown
}

export function compactCacheRecord(record: unknown, bounds: FoldBounds): unknown {
  const current = record as CheckpointRecordLike | null
  const row = current?.rows?.contextTimeline
  if (row === undefined || row.ver !== TIMELINE_STATE_VERSION) return record
  const raw = row.val as { compact?: unknown; head?: unknown } | null
  if (raw?.compact === true && raw.head !== undefined) return record
  const val = compactTimelineCheckpoint(row.val, bounds)
  if (val === null) return record
  const owner = current as CheckpointRecordLike
  return { ...owner, rows: { ...(owner.rows as Record<string, CheckpointRowLike>), contextTimeline: { ...row, val } } }
}

async function migrate(table: KvTableLike, bounds: FoldBounds, pacing: CacheCompactionPacing): Promise<number> {
  let compacted = 0
  let visited = 0
  for (const [key, record] of table.entries()) {
    const compactedRecord = compactCacheRecord(record, bounds)
    if (compactedRecord !== record) {
      const outcome = { changed: false }
      try {
        await table.update(key, (current) => {
          const next = current === record ? compactedRecord : compactCacheRecord(current, bounds)
          outcome.changed = next !== current
          return next
        })
        if (outcome.changed) compacted++
      } catch {}
    }
    if (++visited % pacing.yieldEvery === 0) await new Promise(resolve => setTimeout(resolve, 0))
  }
  return compacted
}

export function watchCacheCompaction(
  ctx: Context,
  bounds: FoldBounds,
  pacing: CacheCompactionPacing = { delayMs: DEFAULT_DELAY_MS, yieldEvery: DEFAULT_YIELD_EVERY },
): void {
  ctx.inject(['storageDomain', 'sessionProjectionCache'], (c) => {
    const storage = (c as unknown as { get(name: string): unknown }).get('storageDomain') as StorageDomainLike | undefined
    if (typeof storage?.get !== 'function') return
    const run = async (): Promise<void> => {
      let domain: DomainLike | undefined
      try {
        domain = storage.get(DOMAIN)
      } catch {
        return
      }
      if (domain === undefined) return
      let table: KvTableLike
      try {
        table = domain.table(TABLE)
      } catch {
        return
      }
      if (typeof table.entries !== 'function' || typeof table.update !== 'function') return
      try {
        const compacted = await migrate(table, bounds, pacing)
        if (compacted > 0) ctx.logger.info(`dsh-context: compacted ${compacted} legacy projection cache record(s)`)
      } catch (error: unknown) {
        ctx.logger.warn(`dsh-context: projection cache compaction stopped (${String(error)})`)
      }
    }
    const timer = setTimeout(() => {
      void run()
    }, pacing.delayMs)
    return () => {
      clearTimeout(timer)
    }
  })
}
