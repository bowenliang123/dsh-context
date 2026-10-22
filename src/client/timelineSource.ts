/** The timeline source behind the Context tab and /context modal: reconciles the INLINE generation (the
 * collections ride the value) with the SPLIT one (a slim head plus `/api/dsh-context/detail`). */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import { DETAIL_ROUTE } from './apiRoutes'
import type { SessionStandardProps } from './services'
import { asRecord, collectionsOf, projectionOf, timelineOf, withDetail } from './services'

/** A missing or NaN revision rejects the whole payload, so the caller shows its retryable note, never half-merged data. */
export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  // A malformed head drops out rather than rejecting the payload.
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

/** The store's snapshot, rebuilt on every transition and identity-gated for `useSyncExternalStore`. */
export interface DetailSnap {
  /** The newest accepted detail, kept while a refetch is in flight so the cards never flicker back to loading. */
  detail: ContextTimelineDetail | null
  failed: boolean
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

const DETAIL_DEBOUNCE_MS = 300

/** One session's detail ledger; exported for tests, reached by the app through `detailStoreOf`. */
export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  /** The revision of `detail` (latest-wins cursor); -1 before the first landing. */
  private acceptedRev = -1
  private wantedRev = -1
  /** The head rev the in-flight (or scheduled) read targets — the refold exception's acceptance key. */
  private targetRev = -1
  /** The head rev seen last; a DECREASE means the host refolded and revisions restarted. */
  private lastHeadRev = -1
  private generation = 0
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  /** No view holds this store: it keeps its cached payload so a re-open renders instantly but arms no read. */
  private parked = false
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: (() => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    if (this.parked) {
      this.parked = false
      // Resume with nothing cached: clear the ledger and the old backoff so the mount's request reads again.
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

  /** Schedule the trailing-edge read when the head outruns the served detail; a DECREASE means the host refolded, so the ledger resets. */
  request(rev: number): void {
    if (rev < this.lastHeadRev) this.resetLedger()
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  readonly retry = (): void => {
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private resetLedger(): void {
    this.generation++
    this.acceptedRev = -1
    this.wantedRev = -1
    this.detail = null
    this.failed = false
    // Drop the snapshot's own payload reference too: it is the second place a released detail could stay reachable from.
    this.snap = EMPTY_SNAP
  }

  get active(): boolean {
    return this.listeners.size > 0
  }

  get hasPayload(): boolean {
    return this.detail !== null
  }

  /** Demote the store: drop its cached payload and pending work, once the page cache exceeds its bound. */
  release(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.resetLedger()
    this.failures = 0
  }

  private park(): void {
    this.parked = true
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.emit()
  }

  private schedule(): void {
    // Nobody reads a parked store's answer, so never arm one.
    if (this.parked || this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    // A trailing timer fired while an earlier read is in flight; that read's settle re-arms.
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      // No session id to read for: the typed failure arms the cards' note.
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    const generation = this.generation
    this.emit()
    try {
      const d = await this.fetcher()
      if (generation !== this.generation) return
      if (d !== null) {
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.acceptedRev = d.rev
        }
        this.failures = 0
        this.failed = false
      } else {
        // Absent (the session left the live set): keep the last detail; arm the note only when nothing is showable.
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
      if (this.wantedRev > this.acceptedRev) this.schedule()
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

/** Cap on sessions keeping a fetched detail payload cached: one measures ~194KB of JSON (~300KB live heap) on a
 * page-lifetime map, so older idle stores are demoted and read again. */
const DETAIL_STORES_MAX = 8

/** Page-lifetime per-session stores (the tab and the modal share one). */
const stores = new Map<string, DetailStore>()

function payloadHolders(): number {
  let held = 0
  for (const store of stores.values()) if (store.hasPayload) held++
  return held
}

export function detailStoreOf(sessionId: string): DetailStore {
  const known = stores.get(sessionId)
  const store = known ?? new DetailStore(makeDetailFetcher(sessionId))
  // Re-inserting moves the entry to the map's newest end, so demotion targets the least recently opened session.
  if (known !== undefined) stores.delete(sessionId)
  stores.set(sessionId, store)
  // A store without a payload is about to fetch one, so it counts as one more; an active store is never demoted.
  let excess = payloadHolders() - DETAIL_STORES_MAX + (store.hasPayload ? 0 : 1)
  for (const candidate of stores.values()) {
    if (excess <= 0) break
    if (candidate.active || !candidate.hasPayload) continue
    candidate.release()
    excess--
  }
  return store
}

export function resetTimelineDetailStores(): void {
  stores.clear()
}

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

export interface TimelineSource {
  /** The value the cards render: the inline generation's value, or the slim head merged with the fetched detail collections. */
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}

/** Hook-order safe: every hook runs unconditionally; the branches below only shape the returned record. */
export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  // The split marker: a slim head carries `detailRev`; null (inline value, gate fallback, corrupt payload) means no channel.
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  // No pushed value yet: the source opens the channel itself (rev 0) rather than waiting on a push.
  const cold = head === null
  const store = useMemo(
    () => (slim || cold ? detailStoreOf(sessionId) : null),
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
      // Nothing renderable yet: the retryable failure, never a dead spinner.
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      // The head's counters render while the first read is in flight (the failure note rides beside).
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry }
    }
    return { data: withDetail(base, detail), detailState: 'ready', retryDetail: retry }
  }, [head, slim, store, snap])
}
