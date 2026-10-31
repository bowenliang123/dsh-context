import type { Context } from '@deepseek-ai/cordis'
import { deriveHeadState } from './foldState'
import { asRecord } from './record'
import { TIMELINE_STATE_VERSION } from './timeline'

const ROW_KEY = 'contextTimeline'

const LEGACY_VERSION = 36

interface RowLike {
  ver?: unknown
  seq?: unknown
  val?: unknown
}

interface RecordLike {
  rows?: Record<string, RowLike>
}

interface TableLike {
  entries(): IterableIterator<[string, RecordLike]>
  update(id: string, fn: (current: RecordLike) => RecordLike): Promise<unknown>
}

function tableOf(ctx: Context): TableLike | undefined {
  const facility = asRecord(ctx.get('storageDomain'))
  if (facility === null || typeof facility.get !== 'function') return undefined
  const domain = asRecord((facility.get as (name: string) => unknown)('session_projcache'))
  if (domain === null || typeof domain.table !== 'function') return undefined
  const table = asRecord((domain.table as (name: string) => unknown)('sessions'))
  if (table === null || typeof table.entries !== 'function' || typeof table.update !== 'function') return undefined
  return table as unknown as TableLike
}

export function watchTimelineRowSweep(ctx: Context): void {
  ctx.inject(['sessionProjectionCache', 'storageDomain'], (c) => {
    const table = tableOf(c)
    if (table === undefined) return
    void sweep(ctx, table).catch((error: unknown) => {
      ctx.logger.warn(`dsh-context: timeline row sweep stopped early (${String(error)})`)
    })
  })
}

async function sweep(ctx: Context, table: TableLike): Promise<void> {
  let migrated = 0
  let stalled = 0
  for (const [id, record] of table.entries()) {
    const row = record.rows?.[ROW_KEY]
    if (row === undefined || row.ver !== LEGACY_VERSION) continue
    const slim = deriveHeadState(row.val)
    if (slim === undefined) continue
    try {
      await table.update(id, (current) => {
        const currentRow = current.rows?.[ROW_KEY]
        if (currentRow === undefined || currentRow.ver !== LEGACY_VERSION) return current
        return {
          ...current,
          rows: {
            ...current.rows,
            [ROW_KEY]: { ver: TIMELINE_STATE_VERSION, seq: currentRow.seq, val: slim },
          },
        }
      })
      migrated++
    } catch {
      stalled++
    }
  }
  if (migrated > 0) {
    ctx.logger.info(`dsh-context: compacted ${migrated} persisted contextTimeline row(s) to the head-only shape`)
  }
  if (stalled > 0) {
    ctx.logger.warn(`dsh-context: ${stalled} legacy contextTimeline row(s) stayed behind (their sessions refold on the next read)`)
  }
}
