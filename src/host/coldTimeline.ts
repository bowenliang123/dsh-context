import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { HeaderRecord } from '../shared/types'
import type { FoldBounds } from './config'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { foldLog } from './detailShadow'
import { stateBytesOf, type TimelineState } from './foldState'
import { makeFoldCache } from './foldCache'
import { createContextHeadersDefinition, headerRecordsOf } from './headers'
import { asRecord } from './record'
import { leaseOf, observeOf, revisionOf } from './postRoute'
import { serviceIdentityOf } from './serviceIdentity'

export interface ColdTimelineStateEntry {
  state: TimelineState
  headers: HeaderRecord[]
  header: Record<string, unknown> | undefined
}

export interface ColdTimelineStatesOptions {
  coldReads?: ColdReadGate
  idleSweepMs?: number
  resolve?: (name: string) => string | undefined
}

export interface ColdTimelineStates {
  touch(): void
  stateOf(sessionId: string, options?: { trustedOnly?: boolean }): Promise<ColdTimelineStateEntry | null>
}

interface CachedEntry {
  persistence: unknown
  revision: string
  trusted: boolean
  state: TimelineState
  headers: HeaderRecord[]
}

const STATE_CACHE_MAX = 4

const STATE_CACHE_BYTES = 64 * 1024 * 1024

function coldCursorOf(events: readonly unknown[]): string {
  for (let index = events.length - 1; index >= 0; index--) {
    const seq = asRecord(events[index])?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) return 'cold-seq:' + String(seq)
  }
  return 'cold-seq:-1'
}

function headersOfEvents(events: readonly unknown[], resolve?: (name: string) => string | undefined): HeaderRecord[] {
  const definition = createContextHeadersDefinition(resolve)
  let state = definition.init()
  for (const event of events) {
    if (event !== null && typeof event === 'object' && typeof (event as { type?: unknown }).type === 'string') {
      state = definition.apply(state, event as never)
    }
  }
  return headerRecordsOf(state, resolve)
}

export function createColdTimelineStates(ctx: Context, bounds: FoldBounds, options: ColdTimelineStatesOptions = {}): ColdTimelineStates {
  const coldReads = options.coldReads ?? makeColdReadGate()
  const cache = makeFoldCache<CachedEntry>(ctx, {
    maxEntries: STATE_CACHE_MAX,
    maxBytes: STATE_CACHE_BYTES,
    bytesOf: entry => stateBytesOf(entry.state),
    idleMs: options.idleSweepMs,
  })
  return {
    touch(): void {
      cache.touch()
    },
    async stateOf(sessionId, { trustedOnly = false } = {}): Promise<ColdTimelineStateEntry | null> {
      cache.touch()
      const observe = observeOf(ctx)
      if (observe === undefined) return null
      const read = async (): Promise<ColdTimelineStateEntry | null> => {
        const observation = await observe(sessionId, { projectionMode: 'none' })
        const release = leaseOf(observation)
        try {
          const persistence = serviceIdentityOf(ctx.get('sessionPersistence'))
          const events = asRecord(observation)?.events
          if (!Array.isArray(events)) return null
          const observedRevision = revisionOf(observation)
          const revision = observedRevision ?? coldCursorOf(events)
          const header = asRecord(asRecord(observation)?.header) ?? undefined
          const cached = cache.get(sessionId, entry => entry.revision === revision
            && entry.persistence === persistence
            && (!trustedOnly || entry.trusted))
          if (cached !== undefined) return { state: cached.state, headers: cached.headers, header }
          const state = (await foldLog(events as SessionEvent[], bounds)).state
          const headers = headersOfEvents(events, options.resolve)
          cache.set(sessionId, { persistence, revision, trusted: observedRevision !== undefined, state, headers })
          return { state, headers, header }
        } finally {
          release()
        }
      }
      return await coldReads.admit(read) ?? null
    },
  }
}
