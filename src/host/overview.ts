import type { Context } from '@deepseek-ai/cordis'
import { dayKeyOf } from '../shared/days'
import type {
  BackfillCoverage,
  OverviewCoverage,
  OverviewPage,
  OverviewPart,
  OverviewPick,
  OverviewRange,
  OverviewScope,
  OverviewSort,
  OverviewTallyField,
  OverviewValue,
} from '../shared/types'
import type { BackfillHandle } from './backfill'
import { optionalNumOf } from './overviewDecode'
import type { CostSource } from './cost'
import type { CachedSnapshotFace, SessionQueryFace, SnapshotProjectionsFace } from './faces'
import { createOverviewCache, identityKey, type CachedSession, type DurableIdentity, type OverviewCache } from './overviewCache'
import {
  buildRows,
  revisionOf,
  scanEntriesOf,
  signaturesOf,
  workspaceOf,
  type HostRow,
  type HostSession,
  type RowFeed,
  type WorkspaceState,
} from './overviewCorpus'
import {
  daysOf,
  groupCountsOf,
  matches,
  pageOf,
  pageRowOf,
  sortOf,
  summaryOf,
  tallyStatsOf,
  windowOf,
  type Filters,
} from './overviewAggregate'
import { makeScanWindow, type ScanResult } from './overviewScan'
import { asRecord } from './record'
import { failure, mountPostRoute, readBody, reply } from './postRoute'

export const OVERVIEW_ROUTE = '/api/dsh-context/overview'

const MAX_QUERY_CHARS = 500

const MAX_REVISION_CHARS = 200

const SCAN_TTL_MS = 5_000

const IDLE_MS = 20_000

const INLINE_CAPTURE_MAX = 128

const CAPTURE_DELAY_MS = 500

const CAPTURE_BACKFILL_POLL_MS = 1_000

const CAPTURE_MAX_WAIT_MS = 60_000

const SERVED_KEYS_MAX = 128

const PARTS = new Set<OverviewPart>(['summary', 'days', 'page', 'tally'])

const COVERAGES = new Set<OverviewCoverage>(['all', 'active', 'archived'])

const SORTS = new Set<OverviewSort>(['recent', 'tokens', 'context'])

const TALLY_FIELDS = new Set<OverviewTallyField>(['skills', 'tools', 'cmds'])

const RANGES = new Set<string>(['all', 'today', '7d', '30d'])

interface FeedState extends RowFeed {
  served: Map<string, string>
  rowsRevision: string
}

function rangeOf(value: unknown): OverviewRange {
  if (typeof value === 'string' && RANGES.has(value)) return value as OverviewRange
  const data = asRecord(value)
  if (data !== null) {
    const start = optionalNumOf(data.start)
    const end = optionalNumOf(data.end)
    if (start !== undefined && end !== undefined) return { start, end }
  }
  return 'all'
}

function scopeOf(value: unknown): OverviewScope {
  const data = asRecord(value)
  if (data === null) return {}
  const coverage = typeof data.coverage === 'string' && COVERAGES.has(data.coverage as OverviewCoverage)
    ? data.coverage as OverviewCoverage
    : undefined
  const day = typeof data.day === 'string' && data.day !== '' ? data.day : undefined
  const group = typeof data.group === 'string' && data.group !== '' ? data.group : undefined
  const query = typeof data.query === 'string' && data.query !== '' ? data.query.slice(0, MAX_QUERY_CHARS) : undefined
  return {
    range: rangeOf(data.range),
    ...(coverage === undefined ? {} : { coverage }),
    ...(day === undefined ? {} : { day }),
    ...(group === undefined ? {} : { group }),
    ...(query === undefined ? {} : { query }),
  }
}

function pickOf(value: unknown): OverviewPick | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.field !== 'string' || !TALLY_FIELDS.has(data.field as OverviewTallyField)) return null
  if (typeof data.name !== 'string' || data.name === '') return null
  return { field: data.field as OverviewTallyField, name: data.name }
}

interface ParsedRequest {
  part: OverviewPart
  revision?: string
  scope: OverviewScope
  sort: OverviewSort
  page: number
  tally: OverviewTallyField
  pick: OverviewPick | null
}

function requestOf(body: unknown): ParsedRequest | null {
  const data = asRecord(body)
  if (data === null) return null
  if (typeof data.part !== 'string' || !PARTS.has(data.part as OverviewPart)) return null
  const revision = typeof data.revision === 'string' && data.revision !== '' && data.revision.length <= MAX_REVISION_CHARS
    ? data.revision
    : undefined
  const sort = typeof data.sort === 'string' && SORTS.has(data.sort as OverviewSort) ? data.sort as OverviewSort : 'recent'
  const pageValue = optionalNumOf(data.page)
  const tally = typeof data.tally === 'string' && TALLY_FIELDS.has(data.tally as OverviewTallyField)
    ? data.tally as OverviewTallyField
    : 'skills'
  return {
    part: data.part as OverviewPart,
    ...(revision === undefined ? {} : { revision }),
    scope: scopeOf(data.scope),
    sort,
    page: pageValue === undefined ? 0 : Math.max(0, Math.floor(pageValue)),
    tally,
    pick: pickOf(data.pick),
  }
}

function filtersOf(parsed: ParsedRequest, now: number): Filters {
  const scope = parsed.scope
  const day = scope.day ?? null
  return {
    window: windowOf(scope.range, day, now),
    day,
    coverage: scope.coverage ?? 'all',
    group: scope.group ?? null,
    query: (scope.query ?? '').trim().toLowerCase(),
    pick: parsed.pick,
  }
}

interface FeedView {
  allRows: HostRow[]
  rows: HostRow[]
  scoped: HostRow[]
  workspace: WorkspaceState
  coverage: BackfillCoverage
  filters: Filters
  open: boolean
}

function valueOf(parsed: ParsedRequest, revision: string, cost: CostSource, data: FeedView): OverviewValue {
  const pricingReady = cost.ready()
  if (parsed.part === 'summary') {
    return {
      revision,
      pricingReady,
      summary: summaryOf(data.allRows, data.rows, data.filters, cost, data.coverage, data.open),
    }
  }
  if (parsed.part === 'days') {
    return { revision, pricingReady, days: daysOf(data.allRows, data.filters.coverage, cost) }
  }
  if (parsed.part === 'tally') {
    return { revision, pricingReady, tally: { field: parsed.tally, stats: tallyStatsOf(data.rows, data.filters, parsed.tally) } }
  }
  const sorted = sortOf(data.rows, parsed.sort)
  const paged = pageOf(sorted, parsed.page)
  const page: OverviewPage = {
    items: paged.items.map(row => pageRowOf(row, cost)),
    index: paged.index,
    count: paged.count,
    total: sorted.length,
    scopeTotal: data.scoped.length,
    groups: groupCountsOf(data.scoped, data.workspace),
  }
  return { revision, pricingReady, page }
}

export interface OverviewRouteOptions {
  scanTtlMs?: number
  servedKeysMax?: number
  idleMs?: number
  yieldEvery?: number
  yieldTo?: () => Promise<void>
  cache?: OverviewCache
  cachePath?: string
}

export function watchOverviewRoute(
  ctx: Context,
  cost: CostSource,
  backfill: BackfillHandle,
  options: OverviewRouteOptions = {},
): () => void {
  const scanTtlMs = options.scanTtlMs ?? SCAN_TTL_MS
  const servedKeysMax = options.servedKeysMax ?? SERVED_KEYS_MAX
  const idleMs = options.idleMs ?? IDLE_MS
  const feed: FeedState = { revision: '', sessions: new Map(), rows: null, served: new Map(), rowsRevision: '' }
  const scanWindow = makeScanWindow(scanTtlMs)
  let materializeTail: Promise<void> = Promise.resolve()
  let identities = new Map<string, DurableIdentity | null>()
  let identitiesReady = false
  let sessionsReady = false
  let warm: Map<string, HostSession> | null = null
  let foldEpoch = 0
  let foldMarker = 0
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false
  let cache: OverviewCache | null = options.cache ?? null
  const cacheOf = (): OverviewCache => {
    cache ??= createOverviewCache(options.cachePath === undefined ? {} : { path: options.cachePath })
    return cache
  }
  const releaseFeed = (): void => {
    if (cache !== null) void cache.flush()
    feed.sessions = new Map()
    feed.rows = null
    feed.rowsRevision = ''
    warm = null
    sessionsReady = false
    scanWindow.reset()
  }
  const resetIdle = (): void => {
    if (idleTimer !== null) clearTimeout(idleTimer)
    idleTimer = null
    if (disposed || idleMs <= 0) return
    idleTimer = setTimeout(() => {
      idleTimer = null
      releaseFeed()
    }, idleMs)
    ;(idleTimer as { unref?: () => void }).unref?.()
  }
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (idleTimer !== null) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
    if (cache !== null) {
      void cache.flush()
      cache.dispose()
    }
  }
  const withMaterializeLock = <T>(task: () => Promise<T>): Promise<T> => {
    const run = materializeTail.then(task, task)
    materializeTail = run.then(() => undefined, () => undefined)
    return run
  }
  ctx.effect(() => dispose)
  mountPostRoute({
    ctx,
    deps: ['connection', 'sessionQuery', 'sessions', 'sessionProjectionCache', 'sessionProjections'],
    path: OVERVIEW_ROUTE,
    label: 'dsh-context: overview route',
    handler: (c) => {
      const query = c.get('sessionQuery') as SessionQueryFace
      const cacheFace = c.get('sessionProjectionCache') as CachedSnapshotFace
      const projections = c.get('sessionProjections') as SnapshotProjectionsFace
      const sessions = c.get('sessions') as { get?(id: string): unknown }
      const listSessions = query.listSessions.bind(query)
      const getSession = typeof sessions.get === 'function' ? sessions.get.bind(sessions) : undefined
      const statOf = (): ((id: string) => Promise<unknown>) | undefined => {
        const persistence = asRecord(c.get('sessionPersistence'))
        if (persistence === null || typeof persistence.stat !== 'function') return undefined
        return (persistence.stat as (id: string) => Promise<unknown>).bind(persistence)
      }
      const awaitScan = (): Promise<ScanResult> => scanWindow.read(async () => {
        const listed: unknown = await listSessions()
        const entries = scanEntriesOf(listed, getSession)
        const coldIds = new Set<string>()
        for (const entry of entries) {
          if (!entry.live) coldIds.add(entry.id)
        }
        return { entries, coldIds, identitiesSynced: false }
      }, () => backfill.version())

      const syncIdentities = async (
        coldIds: ReadonlySet<string>,
        refresh: boolean,
        persistentStat: (id: string) => Promise<unknown>,
      ): Promise<Set<string>> => {
        const dirty = new Set<string>()
        if (!identitiesReady) {
          const loaded = await cacheOf().load(coldIds)
          identities = loaded.identities
          identitiesReady = true
          warm = loaded.sessions
          for (const id of loaded.rebuild) dirty.add(id)
        } else if (refresh) {
          const refreshed = await cacheOf().refresh(coldIds, identities)
          const next = new Map<string, DurableIdentity | null>()
          for (const id of coldIds) {
            const known = refreshed.identities.get(id)
            if (known !== undefined) next.set(id, known)
            else if (identities.has(id)) next.set(id, identities.get(id) ?? null)
          }
          identities = next
          for (const id of refreshed.changed) dirty.add(id)
        }
        const missing: string[] = []
        for (const id of coldIds) {
          if (!identities.has(id)) missing.push(id)
        }
        if (missing.length > 0) {
          if (missing.length <= INLINE_CAPTURE_MAX) {
            const captured = await cacheOf().capture(missing, { stat: persistentStat })
            for (const id of missing) {
              identities.set(id, captured.get(id) ?? null)
              dirty.add(id)
            }
          } else {
            for (const id of missing) {
              identities.set(id, null)
              dirty.add(id)
            }
            captureInBackground(missing, coldIds, persistentStat)
          }
        }
        return dirty
      }

      const loadColdSessions = async (coldIds: ReadonlySet<string>): Promise<Map<string, HostSession>> => {
        if (warm !== null) {
          const pending = warm
          warm = null
          return pending
        }
        if (!identitiesReady) return new Map()
        const loaded = await cacheOf().load(coldIds, identities)
        return loaded.sessions
      }

      const saveCache = (coldIds: ReadonlySet<string>): void => {
        const records: CachedSession[] = []
        for (const id of coldIds) {
          const session = feed.sessions.get(id)
          if (session === undefined) continue
          records.push({ session, identity: identities.get(id) ?? null })
        }
        if (records.length === 0) return
        cacheOf().save(records)
      }

      let captureInflight = false
      const captureInBackground = (
        ids: readonly string[],
        coldIds: ReadonlySet<string>,
        persistentStat: (id: string) => Promise<unknown>,
      ): void => {
        /* v8 ignore next 1 */
        if (captureInflight) return
        captureInflight = true
        const runCapture = (): void => {
          void (async () => {
            try {
              const captured = await cacheOf().capture(ids, { stat: persistentStat })
              for (const id of ids) identities.set(id, captured.get(id) ?? null)
              saveCache(coldIds)
            } catch {
            } finally {
              captureInflight = false
            }
          })()
        }
        const startedAt = Date.now()
        const waitForBackfill = (): void => {
          const coverage = backfill.coverage()
          if (disposed) return
          if (coverage.running || !coverage.complete) {
            /* v8 ignore next 1 */
            if (Date.now() - startedAt < CAPTURE_MAX_WAIT_MS) {
              const timer = setTimeout(waitForBackfill, CAPTURE_BACKFILL_POLL_MS)
              ;(timer as { unref?: () => void }).unref?.()
              return
            }
          }
          runCapture()
        }
        setTimeout(waitForBackfill, CAPTURE_DELAY_MS)
      }

      const materialize = async (parsed: ParsedRequest, scanned: ScanResult): Promise<OverviewValue> => {
        const entries = scanned.entries
        const coldIds = scanned.coldIds
        const workspace = workspaceOf(c)
        const persistentStat = statOf()
        const identityMode = persistentStat !== undefined
        const dirty = identityMode
          ? await syncIdentities(coldIds, !scanned.identitiesSynced, persistentStat)
          : new Set<string>()
        if (identityMode) scanned.identitiesSynced = true
        const workerFolded: string[] = []
        if (identityMode && typeof backfill.foldedSince === 'function') {
          const folded = backfill.foldedSince(foldMarker)
          foldMarker = folded.version
          if (folded.ids === null) {
            for (const id of coldIds) dirty.add(id)
          } else {
            for (const id of folded.ids) {
              if (coldIds.has(id)) dirty.add(id)
            }
          }
          if (folded.workerIds !== null) workerFolded.push(...folded.workerIds)
        }
        if (dirty.size > 0) foldEpoch++
        const backfillVersion = backfill.version()
        const corpusRevision = signaturesOf(entries, entry => (identityMode
          ? `C${identityKey(identities.get(entry.id))}`
          : `C${backfillVersion}`))
        const coverage = backfill.coverage()
        const coverageKey = `${coverage.complete ? 'c' : 'i'}:${coverage.remaining}:${coverage.failed}:${coverage.unsupported}:${coverage.total}:${coverage.covered}`
        const pricingKey = cost.ready() ? `ready${cost.version?.() ?? 0}` : 'cold'
        const revision = revisionOf([corpusRevision, workspace.signature, coverageKey, pricingKey, `f${foldEpoch}`])
        if (feed.revision !== revision) feed.served.clear()
        const now = Date.now()
        const filters = filtersOf(parsed, now)
        const timeKey = filters.window.start === null ? '' : dayKeyOf(filters.window.start) ?? ''
        const requestKey = requestKeyOf(parsed, timeKey)
        if (dirty.size === 0 && parsed.revision !== undefined
          && parsed.revision === revision && servedOf(feed, requestKey)) {
          return { revision, unchanged: true }
        }
        let rows: HostRow[]
        if (feed.rows !== null && feed.rowsRevision === revision && sessionsReady && dirty.size === 0) {
          rows = feed.rows
        } else {
          if (!sessionsReady) {
            const cachedSessions = await loadColdSessions(coldIds)
            for (const [id, session] of cachedSessions) feed.sessions.set(id, session)
            sessionsReady = true
          }
          for (const id of dirty) feed.sessions.delete(id)
          const missing = workerFolded.filter(id => coldIds.has(id) && !feed.sessions.has(id))
          if (missing.length > 0) {
            const reloaded = await loadColdSessions(new Set(missing))
            for (const [id, session] of reloaded) feed.sessions.set(id, session)
          }
          for (const entry of entries) {
            const session = feed.sessions.get(entry.id)
            if (session !== undefined) session.signature = entry.signature
          }
          const buildOptions = options.yieldEvery === undefined && options.yieldTo === undefined
            ? {}
            : {
              ...(options.yieldEvery === undefined ? {} : { yieldEvery: options.yieldEvery }),
              ...(options.yieldTo === undefined ? {} : { yieldTo: options.yieldTo }),
            }
          const built = await buildRows(feed.sessions, { entries }, workspace, cacheFace, projections, c, buildOptions)
          feed.sessions = built.reusableSessions
          rows = built.rows
          feed.rows = rows
          feed.revision = revision
          feed.rowsRevision = built.incomplete > 0 ? '' : revision
          if (identityMode && (dirty.size > 0 || built.rebuilt > 0)) saveCache(coldIds)
        }
        const open = filters.day === null && filters.window.start === null && filters.window.end === null
        const value = valueOf(parsed, revision, cost, {
          allRows: rows,
          rows: rows.filter(row => matches(row, filters)),
          scoped: rows.filter(row => matches(row, { ...filters, group: null, pick: null })),
          workspace,
          coverage: backfill.coverage(),
          filters,
          open,
        })
        rememberServed(feed, requestKey, servedKeysMax)
        return value
      }

      return async (request: Request): Promise<Response> => {
        const read = await readBody(request)
        if (!read.ok) return read.response
        const parsed = requestOf(read.body)
        if (parsed === null) return failure('dsh-context/bad-request', 'unknown overview part')
        resetIdle()
        try {
          const scanned = await awaitScan()
          const value = await withMaterializeLock(() => materialize(parsed, scanned))
          return reply({ ok: true, value })
        } catch (err) {
          return failure('gateway/internal', err instanceof Error ? err.message : String(err))
        }
      }
    },
  })
  return dispose
}

function requestKeyOf(parsed: ParsedRequest, timeKey: string): string {
  return JSON.stringify([
    parsed.part, parsed.scope, parsed.sort, parsed.page, parsed.tally, parsed.pick, timeKey,
  ])
}

function servedOf(feed: FeedState, key: string): boolean {
  return feed.served.get(key) === feed.revision
}

function rememberServed(feed: FeedState, key: string, max: number): void {
  feed.served.delete(key)
  feed.served.set(key, feed.revision)
  if (feed.served.size <= max) return
  for (const key of feed.served.keys()) {
    feed.served.delete(key)
    return
  }
}
