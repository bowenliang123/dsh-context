import { asRecord } from './record'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { mountPostRoute, reply } from './postRoute'

export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

interface SessionQueryLike {
  listSessions(signal?: AbortSignal): Promise<unknown>
}

interface ProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, keys?: readonly string[]): unknown
  coldSnapshot(header: SessionHeader, inheritedEventCount: unknown, events: readonly SessionEvent[]): unknown
}

interface SlicedFoldFaces {
  restore(
    checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number, header: SessionHeader, inheritedEventCount: unknown,
  ): unknown
  hydrate(session: unknown, checkpoint: unknown, events: readonly SessionEvent[], baseSeq: number): unknown
  prepare(id: string, options: { seed: readonly SessionEvent[]; meta: unknown; inheritedEventCount: unknown; eventState: string }): unknown
  write(session: unknown): Promise<unknown>
}

interface ReadHandleLike {
  header: SessionHeader
  inheritedEventCount: unknown
  read(offset: number, limit?: undefined, options?: { signal?: AbortSignal }): Promise<{ events: readonly SessionEvent[] }>
  close(): Promise<void>
}

interface PersistenceLike {
  open(id: string, access: 'read', options?: { signal?: AbortSignal }): Promise<ReadHandleLike>
  stat?(id: string): Promise<unknown>
}

const MIN_REST_MS = 25

const SLICE_EVENTS = 2_000

const ROUND_WORK_BUDGET_MS = 8_000
const ROUND_PAUSE_MS = 2_000

export interface BackfillPacing {
  now: () => number
  sleep: (ms: number) => Promise<void>
  minRestMs: number
  workBudgetMs: number
  roundPauseMs: number
}

const DEFAULT_PACING: BackfillPacing = {
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
  minRestMs: MIN_REST_MS,
  workBudgetMs: ROUND_WORK_BUDGET_MS,
  roundPauseMs: ROUND_PAUSE_MS,
}

const UNSUPPORTED_FORMAT = 'SessionFormatUnsupported'

function headerOf(record: unknown): SessionHeader | null {
  const header = asRecord(asRecord(record)?.header)
  if (header === null) return null
  if (typeof header.id !== 'string' || header.id === '') return null
  return header as unknown as SessionHeader
}

const PROBE_KEYS = ['contextActivity', 'contextTimeline']

interface StatCapability {
  reportsEventCount?: boolean
}

async function durableEventCount(
  persistence: PersistenceLike,
  id: string,
  capability: StatCapability,
): Promise<number | undefined> {
  if (capability.reportsEventCount === false) return undefined
  if (typeof persistence.stat !== 'function') return undefined
  try {
    const snapshot = asRecord(await persistence.stat(id))
    const eventCount = snapshot?.eventCount
    if (typeof eventCount === 'number' && Number.isSafeInteger(eventCount) && eventCount >= 0) {
      capability.reportsEventCount = true
      return eventCount
    }
    if (snapshot !== null && !('eventCount' in snapshot)) capability.reportsEventCount = false
    return undefined
  } catch {
    return undefined
  }
}

async function servesRows(
  persistence: PersistenceLike,
  cache: ProjectionCacheLike,
  header: SessionHeader,
  capability: StatCapability,
): Promise<boolean> {
  let block: Record<string, unknown> | null
  try {
    block = asRecord(cache.cachedSnapshot(header, PROBE_KEYS))
  } catch {
    return false
  }
  const values = asRecord(block?.values)
  if (values === null || values.contextActivity === undefined || values.contextTimeline === undefined) return false
  const asOfSeq = block?.asOfSeq
  if (typeof asOfSeq !== 'number' || !Number.isSafeInteger(asOfSeq)) return false
  const eventCount = await durableEventCount(persistence, header.id, capability)
  if (eventCount === undefined) return true
  return asOfSeq + 1 === eventCount || asOfSeq === eventCount
}

async function readColdLog(
  persistence: PersistenceLike,
  id: string,
  signal: AbortSignal,
): Promise<{ header: SessionHeader; inheritedEventCount: unknown; events: SessionEvent[] }> {
  const handle = await persistence.open(id, 'read', { signal })
  let events: readonly SessionEvent[]
  try {
    const raw: unknown = await handle.read(0, undefined, { signal })
    const result = asRecord(raw)?.events
    events = Array.isArray(result) ? result : []
  } catch (error: unknown) {
    try {
      await handle.close()
    } catch {}
    throw error
  }
  await handle.close()
  return {
    header: handle.header,
    inheritedEventCount: handle.inheritedEventCount,
    events: [...events],
  }
}

function isLive(sessions: Record<string, unknown> | null, id: string): boolean {
  if (sessions === null || typeof sessions.get !== 'function') return false
  try {
    return (sessions.get as (id: string) => unknown)(id) !== undefined
  } catch {
    return true
  }
}

interface SliceOutcome {
  outcome: 'done' | 'live' | 'aborted'
  workMs: number
}

async function coldSnapshotSliced(
  ctx: Context,
  faces: SlicedFoldFaces,
  sessions: Record<string, unknown> | null,
  log: { header: SessionHeader; inheritedEventCount: unknown; events: readonly SessionEvent[] },
  signal: AbortSignal,
  rest: (costMs: number) => Promise<void>,
  now: () => number,
): Promise<SliceOutcome> {
  const { header, inheritedEventCount, events } = log
  let rows: unknown = {}
  let workMs = 0
  for (let end = SLICE_EVENTS; ; end += SLICE_EVENTS) {
    const last = end >= events.length
    const started = now()
    const restored = asRecord(faces.restore(rows, last ? events : events.slice(0, end), 0, header, inheritedEventCount))
    rows = restored?.checkpoint ?? {}
    const sliceCost = now() - started
    workMs += sliceCost
    if (last) break
    await rest(sliceCost)
    if (signal.aborted) return { outcome: 'aborted', workMs }
  }
  let prepared: unknown
  try {
    prepared = faces.prepare(header.id, {
      seed: events,
      meta: structuredClone(header),
      inheritedEventCount,
      eventState: 'shared-frozen',
    })
  } catch (error: unknown) {
    if (isLive(sessions, header.id)) return { outcome: 'live', workMs }
    throw error
  }
  faces.hydrate(prepared, rows, events, 0)
  try {
    await faces.write(prepared)
  } catch (error: unknown) {
    ctx.logger.warn(`dsh-context: projection backfill write-back for "${header.id}" failed (cache stays stale): ${messageOf(error)}`)
  }
  return { outcome: 'done', workMs }
}

function isUnsupportedFormat(error: unknown): boolean {
  try {
    return String(asRecord(error)?.name).startsWith(UNSUPPORTED_FORMAT)
  } catch {
    return false
  }
}

function messageOf(error: unknown): string {
  try {
    return String(error)
  } catch {
    return 'unprintable error'
  }
}

export function watchActivityBackfill(
  ctx: Context,
  coldReads: ColdReadGate = makeColdReadGate(),
  pacing: BackfillPacing = DEFAULT_PACING,
): () => void {
  let requested = false
  let started = false
  let launch: (() => void) | null = null
  const tryLaunch = (): void => {
    if (!requested || started || launch === null) return
    started = true
    launch()
  }

  const routeFiber = mountPostRoute({
    ctx,
    deps: ['connection'],
    path: BACKFILL_ROUTE,
    label: 'dsh-context: backfill route',
    handler: () => () => {
      requested = true
      tryLaunch()
      return reply({ ok: true })
    },
  })

  const runnerFiber = ctx.inject(['sessionQuery', 'sessionProjectionCache', 'sessionPersistence', 'sessions'], (raw) => {
    const injected = raw as unknown as {
      sessionQuery?: unknown
      sessionProjectionCache?: unknown
      sessionPersistence?: unknown
      sessions?: unknown
    }
    const query = asRecord(injected.sessionQuery)
    const cache = asRecord(injected.sessionProjectionCache)
    const persistence = asRecord(injected.sessionPersistence)
    if (query === null || typeof query.listSessions !== 'function') return
    if (cache === null
      || typeof cache.cachedSnapshot !== 'function'
      || typeof cache.coldSnapshot !== 'function') return
    if (persistence === null || typeof persistence.open !== 'function') return
    const sessions = asRecord(injected.sessions)

    const registry = asRecord((ctx as unknown as Record<string, unknown>).sessionProjections)
    const sliceFaces: SlicedFoldFaces | null = registry !== null
      && typeof registry.restore === 'function'
      && typeof registry.hydrate === 'function'
      && sessions !== null
      && typeof sessions.prepare === 'function'
      && typeof cache.write === 'function'
      ? {
        restore: (registry.restore as SlicedFoldFaces['restore']).bind(registry),
        hydrate: (registry.hydrate as SlicedFoldFaces['hydrate']).bind(registry),
        prepare: (sessions.prepare as SlicedFoldFaces['prepare']).bind(sessions),
        write: (cache.write as SlicedFoldFaces['write']).bind(cache),
      }
      : null

    const abort = new AbortController()
    const run = async (): Promise<void> => {
      const listed = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
      if (!Array.isArray(listed)) return
      const statCapability: StatCapability = {}
      let folded = 0
      let refused = 0
      let paused = false
      let roundWork = 0
      const sleep = async (ms: number): Promise<void> => {
        if (abort.signal.aborted) return
        let onAbort!: () => void
        try {
          await Promise.race([
            pacing.sleep(ms),
            new Promise<void>((resolve) => {
              onAbort = () => { resolve() }
              abort.signal.addEventListener('abort', onAbort, { once: true })
            }),
          ])
        } finally {
          abort.signal.removeEventListener('abort', onAbort)
        }
      }
      const rest = async (costMs: number): Promise<void> => {
        roundWork += costMs
        if (roundWork >= pacing.workBudgetMs) {
          roundWork = 0
          ctx.logger.info(`dsh-context: projection backfill pausing after ${Math.round(pacing.workBudgetMs / 1000)}s of fold work; resuming in ${Math.round(pacing.roundPauseMs / 1000)}s`)
          await sleep(pacing.roundPauseMs)
          return
        }
        await sleep(Math.max(pacing.minRestMs, costMs))
      }
      for (const record of listed) {
        if (abort.signal.aborted) return
        const header = headerOf(record)
        if (header === null || typeof header.cwd !== 'string') continue
        if (isLive(sessions, header.id)) continue
        const warm = await servesRows(
          persistence as unknown as PersistenceLike,
          cache as unknown as ProjectionCacheLike,
          header,
          statCapability,
        )
        if (warm) continue
        const started = pacing.now()
        let slicedWorkMs = 0
        try {
          const admitted = await coldReads.admit(async () => {
            const log = await readColdLog(persistence as unknown as PersistenceLike, header.id, abort.signal)
            if (sliceFaces !== null && log.events.length > SLICE_EVENTS) {
              const sliced = await coldSnapshotSliced(ctx, sliceFaces, sessions, log, abort.signal, rest, pacing.now)
              slicedWorkMs = sliced.workMs
              return sliced.outcome
            }
            ;(cache as unknown as ProjectionCacheLike).coldSnapshot(log.header, log.inheritedEventCount, log.events)
            return 'done' as const
          })
          if (admitted === undefined) {
            paused = true
            break
          }
          if (admitted === 'aborted') return
          if (admitted === 'done') folded++
        } catch (error: unknown) {
          if (isUnsupportedFormat(error)) {
            refused++
            ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          } else {
            ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
          }
        }
        await rest(Math.max(0, pacing.now() - started - slicedWorkMs))
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (paused) {
        ctx.logger.info('dsh-context: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)')
      }
      if (refused > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${refused} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
      })
    }
    tryLaunch()
    return () => { abort.abort() }
  })

  return () => {
    for (const fiber of [routeFiber, runnerFiber]) {
      const handle = fiber as { dispose?: () => unknown } | undefined
      void handle?.dispose?.()
    }
  }
}
