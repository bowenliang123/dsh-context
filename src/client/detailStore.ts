import type { ContextEventRecord, ContextTimeline, ContextTimelineDetail, FileOpRecord, HistoryRow, RequestRecord, SurfaceNode, TimingSpan } from '../shared/types'
import { subscribeInvalidations } from './invalidation'
import { makeRetentionCache } from './retention'
import { RouteError } from './route'
import { makeDetailFetcher, makeFactsFetchers, type CoreFetcher, type CoreRead, type FactPart, type FactWindow, type FactsFetchers, type StoreFetcher } from './detailFetcher'
import type { FactsRead, HistoryFetcher } from './timelineWire'
import { CANCELLED, HISTORY_PAGE_MAX, loadAllHistory, loadHistoryTailIndex, loadTailHistory, readHistoryPage, type HistoryPagingOptions, type HistoryRows, type HistoryTailRows } from './historyPaging'
import { WIRE_BYTES, textBytes } from '../shared/bytes'

export { deltaOf, detailOf, factsOf, historyOf } from './timelineWire'
export type { DeltaFetcher, FactsRead, HistoryCursor, HistoryFetcher } from './timelineWire'
export type { FactPart, FactWindow } from './detailFetcher'

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

interface DetailSnap {
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

export const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

const EAGER_DELAY_MS = 16

const CATCH_UP_MS = 1_000

const PART_RETRY_MS = 1_000

const PART_RETRY_LIMIT = 3

const HISTORY_RETRY_LIMIT = 3

type CollectionPart = 'nodes' | 'archive' | 'files' | 'spans'

type CollectionState = 'loading' | 'ready' | 'failed'

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
  private fullNodes: SurfaceNode[] | null = null
  private fullArchive: SurfaceNode[] | null = null
  private fullFiles: FileOpRecord[] | null = null
  private fullSpans: TimingSpan[] | null = null
  private readonly collectionStates = new Map<CollectionPart, CollectionState>()
  private readonly collectionRevs = new Map<CollectionPart, number>()
  private readonly pendingCollections = new Set<CollectionPart>()
  private collectionTask: Promise<void> | null = null
  private collectionTimer: ReturnType<typeof setTimeout> | null = null
  private collectionRetryMs = PART_RETRY_MS
  private archiveKnownRev = -1
  private archiveChangedAt = -1

  constructor(
    private readonly fetcher: StoreFetcher | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    private readonly eagerFirst: boolean = false,
    private readonly onResize?: () => void,
  ) {}

  readonly ensureHistory = (): void => {
    const facts = this.facts
    const current = this.detail
    if (this.factsUnavailable || facts?.history === undefined || current === null || this.acceptedRev < 0) return
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
    const options = { rev, cancelled: () => this.parked || generation !== this.generation }
    try {
      if (refresh) {
        const [requests, events] = await Promise.all([
          loadTailHistory<RequestRecord>(history, 'requests', current.requests, options),
          loadTailHistory<ContextEventRecord>(history, 'events', current.events, options),
        ])
        if (generation !== this.generation || requests === CANCELLED || events === CANCELLED) return
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
      const requests = await loadAllHistory<RequestRecord>(history, 'requests', options)
      if (requests === CANCELLED) {
        if (this.historyState === 'loading') this.historyState = 'idle'
        return
      }
      if (requests === null) {
        this.failHistory()
        return
      }
      const events = await loadAllHistory<ContextEventRecord>(history, 'events', options)
      if (events === CANCELLED) {
        if (this.historyState === 'loading') this.historyState = 'idle'
        return
      }
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

  private collectionRowsOf(part: CollectionPart): HistoryRow[] | null {
    switch (part) {
      case 'nodes':
        return this.fullNodes
      case 'archive':
        return this.fullArchive
      case 'files':
        return this.fullFiles
      case 'spans':
        return this.fullSpans
    }
  }

  private setFullCollection(part: CollectionPart, rows: HistoryRow[], rev: number): void {
    switch (part) {
      case 'nodes':
        this.fullNodes = rows as SurfaceNode[]
        break
      case 'archive':
        this.fullArchive = rows as SurfaceNode[]
        this.archiveKnownRev = rev
        break
      case 'files':
        this.fullFiles = rows as FileOpRecord[]
        break
      case 'spans':
        this.fullSpans = rows as TimingSpan[]
        break
    }
    this.collectionStates.set(part, 'ready')
    this.collectionRevs.set(part, rev)
    this.collectionRetryMs = PART_RETRY_MS
    this.refreshDetailFromFull()
    this.runCollectionQueue()
  }

  private refreshDetailFromFull(): void {
    /* v8 ignore next 1 */
    if (this.detail === null) return
    this.detail = this.withHistory(this.detail)
    this.bytes = detailBytesOf(this.detail)
    this.onResize?.()
    this.emit()
  }

  private isPartComplete(part: FactPart): boolean {
    if (part === 'requests' || part === 'events') return this.historyState === 'ready'
    if (part === 'nodes') return this.fullNodes !== null && this.fullArchive !== null
    if (part === 'files') return this.fullFiles !== null
    if (part === 'spans') return this.fullSpans !== null
    return false
  }

  private ensureCollectionsFor(part: FactPart): void {
    if (part === 'nodes') this.ensureCollections(['archive', 'nodes'])
    else if (part === 'files') this.ensureCollections(['archive', 'files'])
    else if (part === 'spans') this.ensureCollections(['spans'])
  }

  private ensureCollections(parts: readonly CollectionPart[]): void {
    if (this.factsUnavailable || this.facts?.history === undefined) return
    let added = false
    for (const part of parts) {
      if (this.collectionStates.get(part) === 'ready' && this.collectionRevs.get(part) === this.acceptedRev) continue
      if (this.collectionStates.get(part) === 'loading') continue
      if (!this.pendingCollections.has(part)) {
        this.pendingCollections.add(part)
        added = true
      }
    }
    if (added) this.runCollectionQueue()
  }

  private runCollectionQueue(): void {
    if (this.parked || this.collectionTask !== null || this.pendingCollections.size === 0) return
    const history = this.facts?.history
    if (history === undefined || this.detail === null || this.historyState !== 'ready') return
    const task = this.drainCollections(history)
    this.collectionTask = task
    void task.finally(() => {
      this.collectionTask = null
      this.runCollectionQueue()
    })
  }

  private async drainCollections(history: HistoryFetcher): Promise<void> {
    while (this.pendingCollections.size > 0 && !this.parked) {
      const part = this.pendingCollections.values().next().value as CollectionPart
      this.pendingCollections.delete(part)
      await this.loadCollection(history, part)
      if (this.historyState !== 'ready' || this.detail === null) return
    }
  }

  private async loadCollection(history: HistoryFetcher, part: CollectionPart): Promise<void> {
    const state = this.collectionStates.get(part)
    const old = this.collectionRowsOf(part)
    const rev = this.acceptedRev
    this.collectionStates.set(part, 'loading')
    const generation = this.generation
    const options = { rev, cancelled: () => this.parked || generation !== this.generation }
    let rows: HistoryRows<HistoryRow> = null
    try {
      if (old !== null && state === 'ready') {
        const tail = await this.refreshCollection(history, part, old, options)
        rows = tail === 'reload' ? await loadAllHistory<HistoryRow>(history, part, options) : tail
      } else {
        rows = await loadAllHistory<HistoryRow>(history, part, options)
      }
    } catch {
      rows = null
    }
    if (generation !== this.generation) return
    if (rows === CANCELLED) {
      this.collectionStates.delete(part)
      this.pendingCollections.add(part)
      return
    }
    if (rows === null) {
      this.collectionStates.set(part, old === null ? 'failed' : 'ready')
      this.scheduleCollectionRetry()
      return
    }
    if (rev !== this.acceptedRev) {
      if (old === null) this.collectionStates.delete(part)
      else this.collectionStates.set(part, 'ready')
      this.pendingCollections.add(part)
      return
    }
    this.setFullCollection(part, rows, rev)
  }

  private async refreshCollection(
    history: HistoryFetcher,
    part: CollectionPart,
    old: HistoryRow[],
    options: HistoryPagingOptions,
  ): Promise<HistoryTailRows<HistoryRow>> {
    const rev = options.rev
    if (part === 'archive') {
      const page = await readHistoryPage(history, part, undefined, HISTORY_PAGE_MAX, options)
      if (page === CANCELLED || page === null) return page
      this.archiveKnownRev = rev
      if (page.total !== old.length) {
        this.archiveChangedAt = rev
        return 'reload'
      }
      return old
    }
    if (part === 'nodes' && (this.archiveKnownRev !== rev || this.archiveChangedAt === rev)) return 'reload'
    return await loadHistoryTailIndex(history, part, old, options)
  }

  private scheduleCollectionRetry(): void {
    if (!this.active || this.collectionTimer !== null) return
    this.collectionTimer = setTimeout(() => {
      this.collectionTimer = null
      this.retryCollections()
    }, this.collectionRetryMs)
    this.collectionRetryMs = Math.min(8_000, this.collectionRetryMs * 2)
  }

  private retryCollections(): void {
    for (const part of ['archive', 'nodes', 'files', 'spans'] as const) {
      const state = this.collectionStates.get(part)
      if (state === 'failed' || (state === 'ready' && this.collectionRevs.get(part) !== this.acceptedRev)) {
        this.pendingCollections.add(part)
      }
    }
    this.runCollectionQueue()
  }

  private clearCollectionRetry(): void {
    if (this.collectionTimer !== null) {
      clearTimeout(this.collectionTimer)
      this.collectionTimer = null
    }
  }

  private queueCollectionRefresh(): void {
    this.archiveKnownRev = -1
    this.archiveChangedAt = -1
    for (const part of ['archive', 'nodes', 'files', 'spans'] as const) {
      if (this.collectionRevs.has(part) || this.collectionStates.get(part) === 'failed') this.pendingCollections.add(part)
    }
    this.runCollectionQueue()
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
    this.historyState = 'ready'
    this.historyRev = this.acceptedRev
    this.historyFailures = 0
    this.clearHistoryRetry()
    this.detail = this.withHistory(detail)
    this.bytes = detailBytesOf(this.detail)
    this.queueCollectionRefresh()
    this.emit()
  }

  private withHistory(detail: ContextTimelineDetail): ContextTimelineDetail {
    const next: ContextTimelineDetail = { ...detail }
    if (this.historyState === 'ready' && this.detail !== null) {
      next.requests = this.detail.requests
      next.events = this.detail.events
    }
    if (this.fullNodes !== null) {
      next.nodes = this.fullNodes
      next.droppedNodes = 0
      delete next.surfaceFloor
    }
    if (this.fullArchive !== null) {
      next.archive = this.fullArchive
      delete next.archiveFloor
    }
    if (this.fullFiles !== null) {
      next.fileOps = this.fullFiles
      delete next.fileOpsFloor
    }
    if (this.fullSpans !== null) next.spans = this.fullSpans
    return next
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
    this.ensureCollectionsFor(part)
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
      this.ensureHistory()
      this.runCollectionQueue()
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
    this.clearCollectionRetry()
    this.pendingCollections.clear()
    this.collectionStates.clear()
    this.collectionRevs.clear()
    this.collectionRetryMs = PART_RETRY_MS
    this.archiveKnownRev = -1
    this.archiveChangedAt = -1
    this.fullNodes = null
    this.fullArchive = null
    this.fullFiles = null
    this.fullSpans = null
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
    this.clearCollectionRetry()
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
    if (this.isPartComplete(part)) {
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
      if (this.isPartComplete(part)) {
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
      const merged = this.withHistory(mergeFactsInto(this.detail as ContextTimelineDetail, read))
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
    this.detail = this.withHistory(withoutPart(this.detail as ContextTimelineDetail, part))
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
