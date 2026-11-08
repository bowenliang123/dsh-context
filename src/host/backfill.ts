import { asRecord } from './record'
import { performance } from 'node:perf_hooks'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session'
import type { BackfillCoverage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { revisionOf } from './overviewCorpus'
import { mountPostRoute, reply } from './postRoute'

export const BACKFILL_ROUTE = '/api/dsh-context/backfill'

export interface FoldedSessions {
  version: number
  ids: string[] | null
}

export interface BackfillHandle {
  (): void
  coverage(): BackfillCoverage
  version(): number
  foldedSince(marker: number): FoldedSessions
}

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

const FOLDED_IDS_MAX = 4096

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
): BackfillHandle {
  let requested = false
  let running = false
  let disposed = false
  let launch: (() => void) | null = null
  let version = 0
  let foldedVersion = 0
  let foldedOverflow = false
  const foldedIds = new Set<string>()
  let lastSignature: string | null = null
  const coverage: BackfillCoverage = {
    complete: false,
    remaining: 0,
    failed: 0,
    running: false,
    total: 0,
    covered: 0,
    unsupported: 0,
  }
  const startIfIdle = (): void => {
    if (disposed || running || !requested || launch === null) return
    requested = false
    running = true
    coverage.running = true
    launch()
  }
  const requestPass = (): void => {
    requested = true
    startIfIdle()
  }
  const noteFolded = (id: string): void => {
    foldedVersion++
    if (foldedOverflow) return
    foldedIds.add(id)
    if (foldedIds.size > FOLDED_IDS_MAX) {
      foldedIds.clear()
      foldedOverflow = true
    }
  }
  const routeFiber = mountPostRoute({
    ctx,
    deps: ['connection'],
    path: BACKFILL_ROUTE,
    label: 'dsh-context: backfill route',
    handler: () => () => {
      requestPass()
      return reply({ ok: true, coverage: { ...coverage } })
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
    const signatureOf = (records: readonly unknown[]): string => {
      const parts: string[] = []
      for (const record of records) {
        const header = headerOf(record)
        if (header === null) continue
        const live = isLive(sessions, header.id) ? 'L' : 'C'
        parts.push(`${header.id}\u0000${String(header.createdAt)}\u0000${header.cwd ?? ''}\u0000${live}`)
      }
      parts.sort()
      return revisionOf(parts)
    }

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
      const pass: BackfillCoverage = {
        complete: false,
        remaining: 0,
        failed: 0,
        running: false,
        total: 0,
        covered: 0,
        unsupported: 0,
      }
      let listed = false
      let folded = 0
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
      const statCapability: StatCapability = {}
      try {
        const listedRecords = await (query as unknown as SessionQueryLike).listSessions(abort.signal)
        if (!Array.isArray(listedRecords)) return
        listed = true
        for (const record of listedRecords) {
          const header = headerOf(record)
          if (header !== null && typeof header.cwd === 'string') pass.total++
        }
        const signature = signatureOf(listedRecords)
        if (coverage.complete && signature === lastSignature) {
          pass.covered = pass.total
          lastSignature = signature
          return
        }
        lastSignature = signature
        for (const record of listedRecords) {
          if (abort.signal.aborted) return
          const header = headerOf(record)
          if (header === null || typeof header.cwd !== 'string') continue
          if (isLive(sessions, header.id)) {
            pass.covered++
            continue
          }
          const warm = await servesRows(
            persistence as unknown as PersistenceLike,
            cache as unknown as ProjectionCacheLike,
            header,
            statCapability,
          )
          if (warm) {
            pass.covered++
            continue
          }
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
            if (admitted === 'done') {
              folded++
              noteFolded(header.id)
            }
            pass.covered++
          } catch (error: unknown) {
            if (isUnsupportedFormat(error)) {
              pass.unsupported++
              ctx.logger.debug(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
            } else {
              pass.failed++
              ctx.logger.warn(`dsh-context: projection backfill skipped "${header.id}" (${messageOf(error)})`)
            }
          }
          await rest(Math.max(0, pacing.now() - started - slicedWorkMs))
        }
      } finally {
        if (listed && !disposed) {
          const remaining = Math.max(0, pass.total - pass.covered - pass.failed - pass.unsupported)
          const complete = !paused && remaining === 0 && pass.failed === 0
          const changed = complete !== coverage.complete
            || remaining !== coverage.remaining
            || pass.failed !== coverage.failed
            || pass.total !== coverage.total
            || pass.covered !== coverage.covered
            || pass.unsupported !== coverage.unsupported
          coverage.complete = complete
          coverage.remaining = remaining
          coverage.failed = pass.failed
          coverage.total = pass.total
          coverage.covered = pass.covered
          coverage.unsupported = pass.unsupported
          if (folded > 0 || changed) version++
        }
      }
      if (folded > 0) ctx.logger.info(`dsh-context: projection rows backfilled for ${folded} session(s)`)
      if (paused) {
        ctx.logger.info('dsh-context: projection backfill stopped early under heap pressure (remaining sessions refold on their next live activity)')
      }
      if (pass.unsupported > 0) {
        ctx.logger.info(`dsh-context: projection backfill skipped ${pass.unsupported} session(s) (legacy log format is not migratable; sources left unchanged)`)
      }
    }
    launch = () => {
      void run().catch((error: unknown) => {
        if (!abort.signal.aborted) ctx.logger.warn(`dsh-context: projection backfill stopped early (${messageOf(error)})`)
      }).finally(() => {
        running = false
        coverage.running = false
        startIfIdle()
      })
    }
    startIfIdle()
    return () => {
      disposed = true
      abort.abort()
    }
  })

  function disposeAll(): void {
    disposed = true
    for (const fiber of [routeFiber, runnerFiber]) {
      const target = fiber as { dispose?: () => unknown } | undefined
      void target?.dispose?.()
    }
  }
  return Object.assign(disposeAll, {
    coverage: (): BackfillCoverage => ({ ...coverage }),
    version: (): number => version,
    foldedSince: (marker: number): FoldedSessions => {
      if (marker === foldedVersion) return { version: foldedVersion, ids: [] }
      const ids = foldedOverflow ? null : [...foldedIds]
      foldedIds.clear()
      foldedOverflow = false
      return { version: foldedVersion, ids }
    },
  })
}
