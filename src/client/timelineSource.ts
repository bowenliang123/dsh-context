import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextEventRecord, ContextTimeline, ContextTimelineDetail, HistoryPart, RequestRecord } from '../shared/types'
import { DELTA_ROUTE, DETAIL_ROUTE, FACTS_ROUTE, HISTORY_ROUTE } from './apiRoutes'
import { subscribeInvalidations } from './invalidation'
import { noteCostPending } from './costRefresh'
import { makeRetentionCache } from './retention'
import { postRoute, postRouteQuietly, RouteError } from './route'
import type { SessionStandardProps } from './services'
import { projectionOf, timelineOf } from './services'
import { deltaOf, detailOf, factsOf, historyOf, type DeltaFetcher, type FactsRead, type HistoryFetcher } from './timelineWire'
import { historyRowKey, mergeHistoryRows, type HistorySeqRow } from './historyMerge'
import { WIRE_BYTES, textBytes } from '../shared/bytes'

export { deltaOf, detailOf, factsOf, historyOf } from './timelineWire'
export type { DeltaFetcher, FactsRead, HistoryCursor, HistoryFetcher } from './timelineWire'

export type FactPart = 'requests' | 'nodes' | 'events' | 'files' | 'commands' | 'spans'

export interface FactWindow {
  requestsTail?: number
  nodesTail?: number
  eventsTail?: number
  filesTail?: number
  commandsTail?: number
  spansTail?: number
}

export function makeDetailFetcher(
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(DETAIL_ROUTE, { sessionId }, detailOf, { label: 'detail' })
}

export function makeDeltaFetcher(sessionId: string): DeltaFetcher | undefined {
  if (sessionId === '') return undefined
  return (seq, baseSeq) => postRouteQuietly(
    DELTA_ROUTE,
    { sessionId, seq, baseSeq },
    deltaOf,
    { label: 'delta' },
  )
}

type CoreRead = FactsRead | ContextTimelineDetail

export interface FactsFetchers {
  core: () => Promise<CoreRead | null>
  part: (part: FactPart, window: FactWindow) => Promise<CoreRead | null>
  history?: HistoryFetcher
  legacy?: CoreFetcher
}

export function makeFactsFetchers(sessionId: string): FactsFetchers | undefined {
  if (sessionId === '') return undefined
  const read = (parts: readonly (FactPart | 'head' | 'series')[], window?: FactWindow): Promise<CoreRead | null> => postRoute(
    FACTS_ROUTE,
    { sessionId, parts, ...(window === undefined ? {} : { window }) },
    value => factsOf(value) ?? detailOf(value),
    { label: 'facts' },
  )
  const history: HistoryFetcher = (part, cursor, limit) => postRoute(
    HISTORY_ROUTE,
    {
      sessionId,
      part,
      ...(cursor?.beforeSeq === undefined ? {} : { beforeSeq: cursor.beforeSeq }),
      ...(limit === undefined ? {} : { limit }),
    },
    historyOf,
    { label: 'history' },
  )
  return {
    core: () => read(['head', 'series']),
    part: (part, window) => read([part], window),
    history,
    legacy: makeDetailFetcher(sessionId) as CoreFetcher,
  }
}

type CoreFetcher = () => Promise<ContextTimelineDetail | null>

type StoreFetcher = CoreFetcher | FactsFetchers

interface DetailSnap {
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

const EAGER_DELAY_MS = 16

const CATCH_UP_MS = 1_000

const PART_RETRY_MS = 1_000

const PART_RETRY_LIMIT = 3

const HISTORY_PAGE_MAX = 1_000

const HISTORY_RETRY_LIMIT = 3

const CANCELLED = 'cancelled'

type HistoryRows<T> = T[] | typeof CANCELLED | null

function emptyDetail(rev: number, head?: ContextTimeline, requests?: RequestRecord[]): ContextTimelineDetail {
  return {
    rev,
    ...(head === undefined ? {} : { head }),
    requests: requests ?? [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
}

function seriesHasBreakdown(series: readonly RequestRecord[]): boolean {
  return series.every(request => typeof request.system === 'number' || typeof request.assistant === 'number' || typeof request.tool === 'number')
}

function sameWindow(a: FactWindow, b: FactWindow): boolean {
  return a.requestsTail === b.requestsTail && a.nodesTail === b.nodesTail && a.eventsTail === b.eventsTail
    && a.filesTail === b.filesTail && a.commandsTail === b.commandsTail && a.spansTail === b.spansTail
}

function carriedDetail(prev: ContextTimelineDetail, facts: FactsRead): ContextTimelineDetail {
  return {
    ...prev,
    rev: facts.rev,
    head: facts.parts.head ?? prev.head,
    requests: facts.parts.series ?? prev.requests,
  }
}

function detailFromFacts(facts: FactsRead, prev: ContextTimelineDetail | null): ContextTimelineDetail {
  const base = prev === null
    ? emptyDetail(facts.rev, facts.parts.head, facts.parts.series ?? facts.parts.requests)
    : carriedDetail(prev, facts)
  return mergeFactsInto(base, facts)
}

function withoutPart(detail: ContextTimelineDetail, part: FactPart): ContextTimelineDetail {
  if (part === 'requests') return detail
  const next: ContextTimelineDetail = { ...detail }
  switch (part) {
    case 'events':
      next.events = []
      break
    case 'nodes':
      next.nodes = []
      next.droppedNodes = 0
      next.archive = []
      delete next.surfaceFloor
      delete next.archiveFloor
      break
    case 'files':
      delete next.fileOps
      delete next.fileOpsFloor
      break
    case 'commands':
      delete next.commands
      delete next.commandsFloor
      delete next.commandStats
      break
    case 'spans':
      delete next.spans
      break
  }
  return next
}

function mergeFactsInto(detail: ContextTimelineDetail, facts: FactsRead): ContextTimelineDetail {
  const parts = facts.parts
  const next: ContextTimelineDetail = {
    ...detail,
    ...(parts.requests === undefined ? {} : { requests: parts.requests }),
    ...(parts.events === undefined ? {} : { events: parts.events }),
    ...(parts.nodes === undefined
      ? {}
      : {
        nodes: parts.nodes.nodes,
        droppedNodes: parts.nodes.droppedNodes,
        archive: parts.nodes.archive,
        surfaceFloor: parts.nodes.surfaceFloor,
        archiveFloor: parts.nodes.archiveFloor,
      }),
    ...(parts.files === undefined
      ? {}
      : {
        fileOps: parts.files.fileOps,
        fileOpsFloor: parts.files.fileOpsFloor,
      }),
    ...(parts.commands === undefined
      ? {}
      : {
        commands: parts.commands.commands,
        commandsFloor: parts.commands.commandsFloor,
        commandStats: parts.commands.commandStats,
      }),
    ...(parts.spans === undefined ? {} : { spans: parts.spans }),
  }
  return next
}

export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  private acceptedRev = -1
  private wantedRev = -1
  private targetRev = -1
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private parked = false
  private bytes = 0
  private background = false
  private catchUp: ReturnType<typeof setTimeout> | null = null
  private catchUpTarget = -1
  private factsUnavailable = false
  private readonly wantedParts = new Map<FactPart, FactWindow>()
  private readonly partRev = new Map<FactPart, number>()
  private readonly partRetries = new Map<FactPart, ReturnType<typeof setTimeout>>()
  private readonly partFailures = new Map<FactPart, number>()
  private readonly inflightParts = new Set<FactPart>()
  private readonly unavailableParts = new Set<FactPart>()
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP
  private historyState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle'
  private historyRev = -1
  private historyTimer: ReturnType<typeof setTimeout> | null = null
  private historyFailures = 0

  constructor(
    private readonly fetcher: StoreFetcher | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    private readonly eagerFirst: boolean = false,
    private readonly onResize?: () => void,
  ) {}

  readonly ensureHistory = (): void => {
    const facts = this.facts
    const current = this.detail
    if (facts?.history === undefined || current === null || this.acceptedRev < 0) return
    if (this.historyState === 'loading') return
    if (this.historyState === 'ready' && this.historyRev === this.acceptedRev) return
    const refresh = this.historyState === 'ready'
    if (!refresh) this.historyState = 'loading'
    void this.loadHistory(facts.history, this.generation, this.acceptedRev, refresh, current)
  }

  private async loadHistory(
    history: HistoryFetcher,
    generation: number,
    rev: number,
    refresh: boolean,
    current: ContextTimelineDetail,
  ): Promise<void> {
    try {
      if (refresh) {
        const [requests, events] = await Promise.all([
          this.loadTailHistory<RequestRecord>(history, 'requests', current.requests),
          this.loadTailHistory<ContextEventRecord>(history, 'events', current.events),
        ])
        if (generation !== this.generation) return
        if (requests === null || events === null) {
          this.scheduleHistoryRetry()
          return
        }
        if (rev !== this.acceptedRev || this.detail === null) {
          this.ensureHistory()
          return
        }
        this.commitHistory({ ...this.detail, requests, events })
        return
      }
      const requests = await this.loadAllHistory<RequestRecord>(history, 'requests', generation)
      if (requests === CANCELLED) return
      if (requests === null) {
        this.failHistory()
        return
      }
      const events = await this.loadAllHistory<ContextEventRecord>(history, 'events', generation)
      if (events === CANCELLED) return
      if (events === null) {
        this.failHistory()
        return
      }
      if (rev !== this.acceptedRev || this.detail === null) {
        this.historyState = 'idle'
        this.ensureHistory()
        return
      }
      this.commitHistory({ ...this.detail, requests, events })
    } catch {
      if (refresh) this.scheduleHistoryRetry()
      else this.failHistory()
    }
  }

  private async loadAllHistory<T>(
    history: HistoryFetcher,
    part: HistoryPart,
    generation: number,
  ): Promise<HistoryRows<T>> {
    let beforeSeq: number | undefined
    const rows: T[] = []
    for (;;) {
      const page = await history(part, beforeSeq === undefined ? undefined : { beforeSeq }, HISTORY_PAGE_MAX)
      if (generation !== this.generation) return CANCELLED
      if (page === null) return null
      rows.unshift(...page.rows as T[])
      if (page.beforeSeq === undefined || page.rows.length === 0) break
      beforeSeq = page.beforeSeq
    }
    return rows
  }

  private async loadTailHistory<T extends HistorySeqRow>(
    history: HistoryFetcher,
    part: HistoryPart,
    old: T[],
  ): Promise<T[] | null> {
    const known = new Set(old.map(historyRowKey))
    const add: T[] = []
    let unseen = 0
    let cursor: number | undefined
    for (;;) {
      const page = await history(part, cursor === undefined ? undefined : { beforeSeq: cursor }, HISTORY_PAGE_MAX)
      if (page === null) return null
      for (const row of page.rows as unknown as T[]) {
        const key = historyRowKey(row)
        if (known.has(key)) continue
        known.add(key)
        unseen++
      }
      add.unshift(...page.rows as unknown as T[])
      if (unseen >= Math.max(0, page.total - old.length)
        || page.atStart || page.beforeSeq === undefined || page.rows.length === 0) break
      cursor = page.beforeSeq
    }
    return mergeHistoryRows(old, add)
  }

  private failHistory(): void {
    this.historyState = 'failed'
    this.scheduleHistoryRetry()
  }

  private scheduleHistoryRetry(): void {
    if (!this.active || this.historyTimer !== null) return
    this.historyFailures += 1
    if (this.historyFailures > HISTORY_RETRY_LIMIT) return
    this.historyTimer = setTimeout(() => {
      this.historyTimer = null
      this.ensureHistory()
    }, PART_RETRY_MS * 2 ** (this.historyFailures - 1))
  }

  private clearHistoryRetry(): void {
    if (this.historyTimer !== null) {
      clearTimeout(this.historyTimer)
      this.historyTimer = null
    }
  }

  private commitHistory(detail: ContextTimelineDetail): void {
    this.detail = detail
    this.bytes = detailBytesOf(detail)
    this.historyState = 'ready'
    this.historyRev = this.acceptedRev
    this.historyFailures = 0
    this.clearHistoryRetry()
    this.emit()
  }

  private withHistory(detail: ContextTimelineDetail): ContextTimelineDetail {
    if (this.historyState !== 'ready' || this.detail === null) return detail
    return { ...detail, requests: this.detail.requests, events: this.detail.events }
  }

  private get facts(): FactsFetchers | undefined {
    return this.fetcher !== undefined && typeof this.fetcher === 'object' ? this.fetcher : undefined
  }

  private get legacy(): CoreFetcher | undefined {
    return typeof this.fetcher === 'function' ? this.fetcher : this.fetcher?.legacy
  }

  readonly ensurePart = (part: FactPart, window: FactWindow = {}): void => {
    if (this.facts === undefined || this.factsUnavailable) return
    const prev = this.wantedParts.get(part)
    const same = prev !== undefined && sameWindow(prev, window)
    if (same && this.partRev.get(part) === this.acceptedRev) return
    this.wantedParts.set(part, window)
    if (prev !== undefined && !same) this.partRev.delete(part)
    this.fetchWantedParts()
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    if (this.parked) {
      this.parked = false
      if (this.detail === null) {
        this.resetLedger()
        this.failures = 0
      }
      this.fetchWantedParts()
    }
    return () => {
      this.listeners.delete(fn)
      if (this.listeners.size === 0) this.park()
    }
  }

  readonly getSnapshot = (): DetailSnap => this.snap

  request(rev: number): void {
    this.background = false
    if (rev < this.lastHeadRev) this.resetLedger()
    if (rev >= this.lastHeadRev) {
      this.clearCatchUp()
      this.catchUpTarget = -1
    }
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  warm(rev = 0): void {
    this.background = this.listeners.size === 0
    if (rev > this.lastHeadRev) this.lastHeadRev = rev
    if (rev > this.wantedRev) this.wantedRev = rev
    if (this.inFlight) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.parked = false
    if (this.detail === null || rev > this.acceptedRev) void this.fire()
  }

  get byteSize(): number {
    return this.bytes
  }

  refresh(): void {
    if (!this.active) {
      this.release()
      return
    }
    this.partRev.clear()
    this.unavailableParts.clear()
    this.clearPartRetries()
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (this.detail !== null) {
      this.failed = false
      this.failures = 0
      this.wantedRev = Math.max(this.wantedRev, this.acceptedRev)
    }
    if (!this.inFlight) void this.fire()
  }

  readonly retry = (): void => {
    this.background = false
    this.failures = 0
    if (this.detail !== null) {
      this.clearPartRetries()
      this.unavailableParts.clear()
      this.fetchWantedParts()
      return
    }
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.clearCatchUp()
    this.clearPartRetries()
    this.catchUpTarget = -1
    this.generation++
    this.acceptedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.bytes = 0
    this.failed = false
    this.partRev.clear()
    this.unavailableParts.clear()
    this.inflightParts.clear()
    this.clearHistoryRetry()
    this.historyState = 'idle'
    this.historyRev = -1
    this.historyFailures = 0
    this.snap = EMPTY_SNAP
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  release(): void {
    this.clearCatchUp()
    this.catchUpTarget = -1
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.resetLedger()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    this.clearCatchUp()
    this.clearPartRetries()
    this.clearHistoryRetry()
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private clearCatchUp(): void {
    if (this.catchUp !== null) {
      clearTimeout(this.catchUp)
      this.catchUp = null
    }
  }

  private schedule(): void {
    if (this.parked || this.timer !== null) return
    if (this.eagerFirst && this.detail === null && !this.failed) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.fire()
      }, EAGER_DELAY_MS)
      this.emit()
      return
    }
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private fetchWantedParts(): void {
    const facts = this.facts
    if (facts === undefined || this.detail === null || this.acceptedRev < 0 || this.factsUnavailable) return
    for (const [part, window] of this.wantedParts) {
      if (this.unavailableParts.has(part) || this.inflightParts.has(part) || this.partRev.get(part) === this.acceptedRev) continue
      void this.fetchPart(facts, part, window)
    }
  }

  private disableFacts(): void {
    this.factsUnavailable = true
    this.wantedParts.clear()
  }

  private async legacyRead(): Promise<ContextTimelineDetail | null> {
    const legacy = this.legacy
    return legacy === undefined ? null : legacy()
  }

  private async fetchCore(): Promise<{ detail: ContextTimelineDetail | null; disable: boolean }> {
    const facts = this.facts
    if (facts !== undefined && !this.factsUnavailable) {
      let read: CoreRead | null = null
      let threw = false
      try {
        read = await facts.core()
      } catch (error: unknown) {
        threw = true
        if (error instanceof RouteError && error.status === 404) {
          return { detail: await this.legacyRead(), disable: true }
        }
      }
      if (!threw) {
        if (read === null) {
          const detail = await this.legacyRead()
          return { detail, disable: detail === null }
        }
        if (!('parts' in read)) return { detail: read, disable: true }
        if ('missing' in read && read.missing?.includes('series') === true) {
          return { detail: await this.legacyRead(), disable: true }
        }
        return { detail: this.withHistory(detailFromFacts(read, this.detail)), disable: false }
      }
    }
    return { detail: await this.legacyRead(), disable: false }
  }

  private async fetchPart(facts: FactsFetchers, part: FactPart, window: FactWindow): Promise<void> {
    if (this.historyState === 'ready' && (part === 'events' || part === 'requests')) {
      this.partRev.set(part, this.acceptedRev)
      return
    }
    const generation = this.generation
    const rev = this.acceptedRev
    this.inflightParts.add(part)
    this.emit()
    try {
      const read = await facts.part(part, window)
      if (generation !== this.generation || this.acceptedRev !== rev) return
      if (this.historyState === 'ready' && (part === 'events' || part === 'requests')) {
        this.partRev.set(part, this.acceptedRev)
        return
      }
      if (read === null) {
        this.schedulePartRetry(part)
        return
      }
      if (!('parts' in read)) {
        this.unavailableParts.add(part)
        this.dropPart(part)
        return
      }
      if (read.rev !== rev) {
        this.wantedRev = Math.max(this.wantedRev, read.rev)
        this.schedule()
        return
      }
      if (read.missing?.includes(part) === true) {
        this.unavailableParts.add(part)
        this.dropPart(part)
        return
      }
      if (read.parts[part] === undefined) {
        this.unavailableParts.add(part)
        this.dropPart(part)
        return
      }
      const merged = mergeFactsInto(this.detail as ContextTimelineDetail, read)
      this.detail = merged
      this.bytes = detailBytesOf(merged)
      this.partRev.set(part, rev)
      this.clearPartRetry(part)
      this.onResize?.()
    } catch {
      if (generation === this.generation && this.acceptedRev === rev) this.schedulePartRetry(part)
    } finally {
      this.inflightParts.delete(part)
      if (generation === this.generation && this.acceptedRev !== rev) this.fetchWantedParts()
      this.emit()
    }
  }

  private dropPart(part: FactPart): void {
    this.detail = withoutPart(this.detail as ContextTimelineDetail, part)
    this.bytes = detailBytesOf(this.detail)
  }

  private schedulePartRetry(part: FactPart): void {
    if (!this.active || this.partRetries.has(part)) return
    const failures = (this.partFailures.get(part) ?? 0) + 1
    this.partFailures.set(part, failures)
    if (failures > PART_RETRY_LIMIT) {
      this.dropPart(part)
      return
    }
    const delay = PART_RETRY_MS * 2 ** (failures - 1)
    this.partRetries.set(part, setTimeout(() => {
      this.partRetries.delete(part)
      this.fetchWantedParts()
      this.emit()
    }, delay))
  }

  private clearPartRetry(part: FactPart): void {
    const timer = this.partRetries.get(part)
    if (timer === undefined) return
    clearTimeout(timer)
    this.partRetries.delete(part)
    this.partFailures.delete(part)
  }

  private clearPartRetries(): void {
    for (const timer of this.partRetries.values()) clearTimeout(timer)
    this.partRetries.clear()
    this.partFailures.clear()
  }

  private async fire(): Promise<void> {
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    const background = this.background
    const generation = this.generation
    this.emit()
    try {
      const read = await this.fetchCore()
      if (generation !== this.generation) return
      if (read.disable) this.disableFacts()
      const d = read.detail
      if (d !== null) {
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.bytes = detailBytesOf(d)
          this.acceptedRev = d.rev
          this.onResize?.()
          this.unavailableParts.clear()
          this.partRev.clear()
          this.clearPartRetries()
          if (!seriesHasBreakdown(d.requests)) this.ensurePart('requests')
          this.fetchWantedParts()
        }
        if (d.rev >= this.acceptedRev && d.rev < this.targetRev) {
          this.wantedRev = d.rev
          if (this.listeners.size > 0 && this.catchUpTarget !== this.targetRev) {
            this.catchUpTarget = this.targetRev
            this.clearCatchUp()
            const target = this.targetRev
            this.catchUp = setTimeout(() => {
              this.catchUp = null
              if (this.detail === null || this.acceptedRev < target) {
                this.wantedRev = target
                void this.fire()
              }
            }, CATCH_UP_MS)
          }
        }
        this.failures = 0
        this.failed = false
      } else {
        this.wantedRev = this.acceptedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      this.inFlight = false
      if (this.failed && background && this.listeners.size === 0) this.wantedRev = this.acceptedRev
      if (this.wantedRev > this.acceptedRev && (this.listeners.size > 0 || !background)) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight || this.inflightParts.size > 0 || this.partRetries.size > 0
    const next: DetailSnap = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snap.detail && next.failed === this.snap.failed && next.pending === this.snap.pending) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

export function detailBytesOf(detail: ContextTimelineDetail): number {
  let bytes = WIRE_BYTES.base
    + detail.requests.length * WIRE_BYTES.request
    + detail.events.length * WIRE_BYTES.event
    + detail.nodes.length * WIRE_BYTES.node
    + detail.archive.length * WIRE_BYTES.node
    + (detail.fileOps?.length ?? 0) * WIRE_BYTES.fileOp
    + (detail.commands?.length ?? 0) * WIRE_BYTES.command
    + (detail.spans?.length ?? 0) * WIRE_BYTES.span
  for (const event of detail.events) {
    bytes += textBytes(event.name) + textBytes(event.detail) + textBytes(event.agent)
    if (event.items !== undefined) {
      for (const item of event.items) bytes += textBytes(item)
    }
  }
  return bytes
}

const stores = makeRetentionCache<string, DetailStore>('detailStores', {
  sizeOf: store => store.byteSize,
  weightOf: store => (store.hasPayload ? 1 : 0),
  evictable: store => !store.active,
  onEvict: (store) => { store.release() },
})

subscribeInvalidations((event) => {
  if (event.kind !== 'pricing') return
  stores.forEach((store) => { store.refresh() })
})

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  if (known !== undefined) {
    stores.trim({ protect: sessionId })
    return known
  }
  stores.trim({ reserveWeight: 1 })
  const facts = makeFactsFetchers(sessionId)
  const resize = (): void => { stores.reweight(sessionId) }
  const store = facts === undefined
    ? new DetailStore(makeDetailFetcher(sessionId), DETAIL_DEBOUNCE_MS, true, resize)
    : new DetailStore(facts, DETAIL_DEBOUNCE_MS, true, resize)
  stores.set(sessionId, store)
  return store
}

export function resetTimelineDetailStores(): void {
  stores.clear()
}

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

export interface TimelineSource {
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
  ensurePart: (part: FactPart, window?: FactWindow) => void
  ensureHistory: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}
const noopEnsurePart = (): void => {}
const noopEnsureHistory = noopEnsurePart

export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  const cold = head === null
  const store = useMemo(
    () => (sessionId !== '' && (slim || cold) ? detailStoreOf(sessionId) : null),
    [sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  useEffect(() => {
    if (store !== null && snap.detail !== null) store.ensureHistory()
  }, [store, snap.detail])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    const ensurePart = store !== null ? store.ensurePart : noopEnsurePart
    const ensureHistory = store !== null ? store.ensureHistory : noopEnsureHistory
    if (head !== null && !slim) {
      noteCostPending(head.costRead)
      return { data: head, detailState: 'legacy', retryDetail: noopRetry, ensurePart: noopEnsurePart, ensureHistory: noopEnsureHistory }
    }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry, ensurePart, ensureHistory }
    }
    if (detail === null) {
      noteCostPending(base.costRead)
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry, ensurePart, ensureHistory }
    }
    noteCostPending(detail.head?.costRead ?? base.costRead)
    const data: ContextTimeline = {
      ...base,
      ...(detail.head?.costRead === undefined ? {} : { costRead: detail.head.costRead }),
      requests: detail.requests,
      events: detail.events,
      nodes: detail.nodes,
      droppedNodes: detail.droppedNodes,
      archive: detail.archive,
      ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
      ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
      ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
      ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      ...(detail.commands !== undefined ? { commands: detail.commands } : {}),
      ...(detail.commandsFloor !== undefined ? { commandsFloor: detail.commandsFloor } : {}),
      ...(detail.commandStats !== undefined ? { commandStats: detail.commandStats } : {}),
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry, ensurePart, ensureHistory }
  }, [head, slim, store, snap])
}
