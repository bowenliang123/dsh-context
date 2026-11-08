import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail, RequestRecord, SurfaceNode } from '../shared/types'
import { DETAIL_ROUTE, FACTS_ROUTE } from './apiRoutes'
import { BoundedCache } from './boundedCache'
import { postRoute } from './route'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf } from './services'

export type FactPart = 'requests' | 'nodes' | 'events' | 'files' | 'commands' | 'spans'

export interface FactWindow {
  requestsTail?: number
  nodesTail?: number
  eventsTail?: number
  filesTail?: number
  commandsTail?: number
  spansTail?: number
}

interface FactParts {
  head?: ContextTimeline
  series?: RequestRecord[]
  requests?: RequestRecord[]
  nodes?: { nodes: SurfaceNode[]; archive: SurfaceNode[]; droppedNodes: number; surfaceFloor?: number; archiveFloor?: number }
  events?: ContextTimeline['events']
  files?: { fileOps: NonNullable<ContextTimeline['fileOps']>; fileOpsFloor?: number }
  commands?: { commands: NonNullable<ContextTimeline['commands']>; commandsFloor?: number; commandStats?: ContextTimeline['commandStats'] }
  spans?: NonNullable<ContextTimeline['spans']>
}

export interface FactsRead {
  rev: number
  live: boolean
  asOfSeq?: number
  parts: FactParts
  missing?: readonly string[]
}

function numOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function rowsOf(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((entry): entry is Record<string, unknown> => entry !== null && typeof entry === 'object')
}

function nodesPartOf(value: unknown): FactParts['nodes'] | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const nodes = rowsOf(data.nodes) as SurfaceNode[] | undefined
  const archive = rowsOf(data.archive) as SurfaceNode[] | undefined
  if (nodes === undefined || archive === undefined) return undefined
  return {
    nodes,
    archive,
    droppedNodes: numOf(data.droppedNodes) ?? 0,
    ...(numOf(data.surfaceFloor) === undefined ? {} : { surfaceFloor: numOf(data.surfaceFloor) }),
    ...(numOf(data.archiveFloor) === undefined ? {} : { archiveFloor: numOf(data.archiveFloor) }),
  }
}

export function factsOf(value: unknown): FactsRead | null {
  const data = asRecord(value)
  if (data === null) return null
  const rev = numOf(data.rev)
  if (rev === undefined) return null
  const parts = asRecord(data.parts)
  if (parts === null) return null
  const head = parts.head === undefined ? undefined : timelineOf(parts.head)
  const series = rowsOf(parts.series) as RequestRecord[] | undefined
  const requests = rowsOf(parts.requests) as RequestRecord[] | undefined
  const events = rowsOf(parts.events) as ContextTimeline['events'] | undefined
  const spans = rowsOf(parts.spans) as NonNullable<ContextTimeline['spans']> | undefined
  const files = asRecord(parts.files)
  const fileOps = files === null ? undefined : rowsOf(files.fileOps) as NonNullable<ContextTimeline['fileOps']> | undefined
  const commands = asRecord(parts.commands)
  const commandRows = commands === null ? undefined : rowsOf(commands.commands) as NonNullable<ContextTimeline['commands']> | undefined
  const stats = asRecord(commands?.commandStats)
  const nodes = nodesPartOf(parts.nodes)
  const fileOpsFloor = files === null ? undefined : numOf(files.fileOpsFloor)
  const commandsFloor = commands === null ? undefined : numOf(commands.commandsFloor)
  const missing = Array.isArray(data.missing) ? data.missing.filter((entry): entry is string => typeof entry === 'string') : undefined
  return {
    rev,
    live: data.live === true,
    ...(numOf(data.asOfSeq) === undefined ? {} : { asOfSeq: numOf(data.asOfSeq) }),
    parts: {
      ...(head === null || head === undefined ? {} : { head }),
      ...(series === undefined ? {} : { series }),
      ...(requests === undefined ? {} : { requests }),
      ...(nodes === undefined ? {} : { nodes }),
      ...(events === undefined ? {} : { events }),
      ...(fileOps === undefined
        ? {}
        : {
          files: {
            fileOps,
            ...(fileOpsFloor === undefined ? {} : { fileOpsFloor }),
          },
        }),
      ...(commandRows === undefined
        ? {}
        : {
          commands: {
            commands: commandRows,
            ...(commandsFloor === undefined ? {} : { commandsFloor }),
            ...(stats === null
              ? {}
              : {
                commandStats: {
                  runs: numOf(stats.runs) ?? 0,
                  failed: numOf(stats.failed) ?? 0,
                  ms: numOf(stats.ms) ?? 0,
                  bg: numOf(stats.bg) ?? 0,
                },
              }),
          },
        }),
      ...(spans === undefined ? {} : { spans }),
    },
    ...(missing === undefined || missing.length === 0 ? {} : { missing }),
  }
}

export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  const head = timelineOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    ...collectionsOf(data),
  }
}

export function makeDetailFetcher(
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(DETAIL_ROUTE, { sessionId }, detailOf, { label: 'detail' })
}

type CoreRead = FactsRead | ContextTimelineDetail

export interface FactsFetchers {
  core: () => Promise<CoreRead | null>
  part: (part: FactPart, window: FactWindow) => Promise<CoreRead | null>
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
  return {
    core: () => read(['head', 'series']),
    part: (part, window) => read([part], window),
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

function detailFromFacts(facts: FactsRead): ContextTimelineDetail {
  const base = emptyDetail(facts.rev, facts.parts.head, facts.parts.series ?? facts.parts.requests)
  return mergeFactsInto(base, facts)
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
        archive: parts.nodes.archive,
        droppedNodes: parts.nodes.droppedNodes,
        ...(parts.nodes.surfaceFloor === undefined ? {} : { surfaceFloor: parts.nodes.surfaceFloor }),
        ...(parts.nodes.archiveFloor === undefined ? {} : { archiveFloor: parts.nodes.archiveFloor }),
      }),
    ...(parts.files === undefined
      ? {}
      : {
        fileOps: parts.files.fileOps,
        ...(parts.files.fileOpsFloor === undefined ? {} : { fileOpsFloor: parts.files.fileOpsFloor }),
      }),
    ...(parts.commands === undefined
      ? {}
      : {
        commands: parts.commands.commands,
        ...(parts.commands.commandsFloor === undefined ? {} : { commandsFloor: parts.commands.commandsFloor }),
        ...(parts.commands.commandStats === undefined ? {} : { commandStats: parts.commands.commandStats }),
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
  private factsDisabled = false
  private readonly wantedParts = new Map<FactPart, FactWindow>()
  private readonly partRev = new Map<FactPart, number>()
  private readonly inflightParts = new Set<FactPart>()
  private readonly unavailableParts = new Set<FactPart>()
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: StoreFetcher | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    private readonly eagerFirst: boolean = false,
  ) {}

  private get facts(): FactsFetchers | undefined {
    return this.fetcher !== undefined && typeof this.fetcher === 'object' ? this.fetcher : undefined
  }

  private get legacy(): CoreFetcher | undefined {
    return typeof this.fetcher === 'function' ? this.fetcher : this.fetcher?.legacy
  }

  readonly ensurePart = (part: FactPart, window: FactWindow = {}): void => {
    if (this.facts === undefined || this.factsDisabled) return
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

  readonly retry = (): void => {
    this.background = false
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.clearCatchUp()
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
    if (facts === undefined || this.detail === null || this.acceptedRev < 0 || this.factsDisabled) return
    for (const [part, window] of this.wantedParts) {
      if (this.unavailableParts.has(part) || this.inflightParts.has(part) || this.partRev.get(part) === this.acceptedRev) continue
      void this.fetchPart(facts, part, window)
    }
  }

  private async fetchCore(): Promise<ContextTimelineDetail | null> {
    const facts = this.facts
    if (facts !== undefined && !this.factsDisabled) {
      const read = await facts.core()
      if (read === null) return null
      if ('missing' in read && read.missing?.includes('series') === true) return null
      if (!('parts' in read)) {
        this.factsDisabled = true
        this.wantedParts.clear()
        return read
      }
      return detailFromFacts(read)
    }
    const legacy = this.legacy
    return legacy === undefined ? null : legacy()
  }

  private async fetchPart(facts: FactsFetchers, part: FactPart, window: FactWindow): Promise<void> {
    const generation = this.generation
    const rev = this.acceptedRev
    this.inflightParts.add(part)
    this.emit()
    try {
      const read = await facts.part(part, window)
      if (generation !== this.generation || this.acceptedRev !== rev) return
      if (read === null || !('parts' in read)) return
      if (read.rev !== rev) {
        this.wantedRev = Math.max(this.wantedRev, read.rev)
        this.schedule()
        return
      }
      if (read.missing?.includes(part) === true) this.unavailableParts.add(part)
      const merged = mergeFactsInto(this.detail as ContextTimelineDetail, read)
      this.detail = merged
      this.bytes = detailBytesOf(merged)
      this.partRev.set(part, rev)
    } catch {
    } finally {
      this.inflightParts.delete(part)
      this.emit()
    }
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
      const d = await this.fetchCore()
      if (generation !== this.generation) return
      if (d === null && this.facts !== undefined && !this.factsDisabled) {
        this.factsDisabled = true
        this.wantedParts.clear()
        this.failures = 0
        this.wantedRev = Math.max(this.wantedRev, this.targetRev, 0)
        return
      }
      if (d !== null) {
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.bytes = detailBytesOf(d)
          this.acceptedRev = d.rev
          this.unavailableParts.clear()
          this.partRev.clear()
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
        if (this.facts !== undefined && !this.factsDisabled) {
          this.factsDisabled = true
          this.wantedParts.clear()
          this.failures = 0
          this.wantedRev = Math.max(this.wantedRev, this.targetRev, 0)
        } else {
          this.failed = this.detail === null
          this.failures++
        }
      }
    } finally {
      this.inFlight = false
      if (this.failed && background && this.listeners.size === 0) this.wantedRev = this.acceptedRev
      if (this.wantedRev > this.acceptedRev && (this.listeners.size > 0 || !background)) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight || this.inflightParts.size > 0
    const next: DetailSnap = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snap.detail && next.failed === this.snap.failed && next.pending === this.snap.pending) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

const DETAIL_STORES_MAX = 8

const DETAIL_BYTES_MAX = 6 * 1024 * 1024

export function detailBytesOf(detail: ContextTimelineDetail): number {
  return 2048
    + detail.requests.length * 180
    + detail.events.length * 120
    + detail.nodes.length * 160
    + detail.archive.length * 160
    + (detail.fileOps?.length ?? 0) * 220
    + (detail.commands?.length ?? 0) * 420
    + (detail.spans?.length ?? 0) * 60
}

const DETAIL_STORE_ENTRIES_MAX = 64

const stores = new BoundedCache<string, DetailStore>({
  maxEntries: DETAIL_STORE_ENTRIES_MAX,
  maxBytes: DETAIL_BYTES_MAX,
  maxWeight: DETAIL_STORES_MAX,
  sizeOf: store => store.byteSize,
  weightOf: store => (store.hasPayload ? 1 : 0),
  evictable: store => !store.active,
  onEvict: (store) => { store.release() },
})

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  if (known !== undefined) {
    stores.trim({ protect: sessionId })
    return known
  }
  stores.trim({ reserveWeight: 1 })
  const facts = makeFactsFetchers(sessionId)
  const store = facts === undefined
    ? new DetailStore(makeDetailFetcher(sessionId), DETAIL_DEBOUNCE_MS, true)
    : new DetailStore(facts, DETAIL_DEBOUNCE_MS, true)
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
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}
const noopEnsurePart = (): void => {}

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

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    const ensurePart = store !== null ? store.ensurePart : noopEnsurePart
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry, ensurePart: noopEnsurePart }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry, ensurePart }
    }
    if (detail === null) {
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry, ensurePart }
    }
    const data: ContextTimeline = {
      ...base,
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
    return { data, detailState: 'ready', retryDetail: retry, ensurePart }
  }, [head, slim, store, snap])
}
