import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import { DETAIL_ROUTE } from './apiRoutes'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf } from './services'

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
  return async () => {
    const response = await fetch(DETAIL_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    })
    if (!response.ok) throw new Error(`dsh-context: detail route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: detail read failed')
    if (r.value === null) return null
    const detail = detailOf(r.value)
    if (detail === null) throw new Error('dsh-context: detail read malformed')
    return detail
  }
}

export interface DetailSnap {
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

const EAGER_DELAY_MS = 16

const CATCH_UP_MS = 1_000

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
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: (() => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
    private readonly eagerFirst: boolean = false,
  ) {}

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
    if (rev < this.wantedRev) return
    if (rev === this.wantedRev && this.acceptedRev >= rev) return
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
    let retry = false
    this.emit()
    try {
      const d = await this.fetcher()
      if (generation !== this.generation) return
      if (d !== null) {
        const previousAccepted = this.acceptedRev
        const accepted = d.rev >= previousAccepted || d.rev === this.targetRev
        if (accepted) {
          this.detail = d
          this.bytes = detailBytesOf(d)
          this.acceptedRev = d.rev
        }
        if (d.rev < this.targetRev) {
          if (accepted) {
            if (this.listeners.size > 0 && this.catchUpTarget !== this.wantedRev) {
              const target = this.wantedRev
              this.catchUpTarget = target
              this.clearCatchUp()
              this.catchUp = setTimeout(() => {
                this.catchUp = null
                if (this.detail === null || this.acceptedRev < target) void this.fire()
              }, CATCH_UP_MS)
            }
          } else {
            retry = true
          }
        }
        this.failures = 0
        this.failed = false
      } else {
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
        retry = true
      }
    } finally {
      this.inFlight = false
      const replaced = generation !== this.generation
      if (this.wantedRev >= 0
        && (replaced || this.wantedRev > this.targetRev || retry)
        && (this.listeners.size > 0 || !background)) this.schedule()
      this.emit()
    }
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
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

const stores = new Map<string, DetailStore>()

function payloadHolders(): number {
  let held = 0
  for (const store of stores.values()) if (store.hasPayload) held++
  return held
}

function payloadBytes(): number {
  let bytes = 0
  for (const store of stores.values()) bytes += store.byteSize
  return bytes
}

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  const store = known ?? new DetailStore(makeDetailFetcher(sessionId), DETAIL_DEBOUNCE_MS, true)
  if (known !== undefined) stores.delete(sessionId)
  stores.set(sessionId, store)
  let excess = payloadHolders() - DETAIL_STORES_MAX + (store.hasPayload ? 0 : 1)
  let bytes = payloadBytes()
  for (const candidate of stores.values()) {
    if (excess <= 0 && bytes <= DETAIL_BYTES_MAX) break
    if (candidate === store || candidate.active || !candidate.hasPayload) continue
    bytes -= candidate.byteSize
    candidate.release()
    excess--
  }
  if (stores.size > DETAIL_STORE_ENTRIES_MAX) {
    for (const id of stores.keys()) {
      if (stores.size <= DETAIL_STORE_ENTRIES_MAX) break
      if (id === sessionId) continue
      const candidate = stores.get(id)
      if (candidate === undefined || candidate.active) continue
      stores.delete(id)
    }
  }
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
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}

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
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry }
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
    return { data, detailState: 'ready', retryDetail: retry }
  }, [head, slim, store, snap])
}
