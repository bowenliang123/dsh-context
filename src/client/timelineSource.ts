/**
 * The timeline source behind the Context tab and the /context modal —
 * reconciles the two `contextTimeline` wire generations into the single
 * value the cards have always rendered.
 *
 * Generations (the marker is `detailRev` on the delivered value):
 * - INLINE (older hosts, channel-less deployments, the baseline-gate
 *   fallback): the wire value carries the collections in place. It passes
 *   through untouched — no fetch ever happens.
 * - SPLIT (current host with the detail channel live): the wire value is the
 *   slim head (~1KB — every session.list row, control baseline, and push
 *   frame carries it whole). The collections arrive from the host's
 *   `/dsh-context` `detail` endpoint (host/detail.ts): one targeted read
 *   when the tab/modal first opens, then a debounced refetch whenever the
 *   pushed `detailRev` outruns the served detail. Closed tabs fetch nothing.
 *
 * The no-stale-content guarantees: the store is per session and shared by
 * the tab and the modal; a refetch is single-flight with a trailing edge
 * (a rev bumped mid-flight re-reads after settle); responses race-safe by
 * revision (latest wins, with the refold exception — a host that refolded
 * restarts the revision, and a response matching the requested rev is
 * accepted regardless of order); a transport failure keeps the last good
 * detail and backs off; an absent answer (the session left the live set)
 * stops the trailing until the head moves again. With no detail at all,
 * failure surfaces as a retryable note on the detail cards instead of an
 * empty chart.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import type { ClientCtx, SessionStandardProps } from './services'
import { asRecord, numOf, objectsOf, projectionOf, rpcCallOf, timelineOf } from './services'

// The channel/endpoint pair of host/detail.ts — re-declared here: the client
// bundle inlines every import, and the host module must never reach it.
const DETAIL_CHANNEL = '/dsh-context'
const DETAIL_ENDPOINT = 'detail'

/**
 * Narrow the detail endpoint's payload to a render-safe value (the same
 * boundary rigor as `timelineOf`): collections re-proved per item, scalars
 * zeroed, a missing/NaN revision rejects the whole payload (the caller then
 * shows the retryable failure note instead of half-merged data).
 */
export function detailOf(value: unknown): ContextTimelineDetail | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.rev !== 'number' || !Number.isFinite(data.rev) || data.rev < 0) return null
  return {
    rev: data.rev,
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    archive: objectsOf(data.archive),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
    ...(data.fileOps !== undefined ? { fileOps: objectsOf(data.fileOps) } : {}),
    ...(typeof data.fileOpsFloor === 'number' ? { fileOpsFloor: data.fileOpsFloor } : {}),
  }
}

/**
 * The detail reader over the harness's generic Connection RPC
 * (`ctx.connection.rpc.call`) — resolved through the shared `rpcCallOf`
 * reflect read (the same seam openPathVia/canOpenPathsOf use), so a hostile
 * or absent connection service degrades to `undefined` instead of throwing.
 * The returned thunk resolves the session's current detail, `null` when the
 * session is not live anymore, and rejects on transport failure or a
 * malformed payload (the store turns the two into the retryable state).
 */
export function makeDetailFetcher(
  ctx: ClientCtx,
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  const call = rpcCallOf(ctx)
  if (call === undefined) return undefined
  return async () => {
    const result = await call(DETAIL_CHANNEL, DETAIL_ENDPOINT, { sessionId })
    const r = asRecord(result)
    if (r === null || r.ok !== true) throw new Error('dsh-context: detail rpc failed')
    if (r.value === null) return null
    const detail = detailOf(r.value)
    if (detail === null) throw new Error('dsh-context: detail rpc malformed')
    return detail
  }
}

/** The store's observable snapshot, rebuilt on every transition (identity-gated for useSyncExternalStore). */
export interface DetailSnap {
  /** The newest accepted detail (kept while a refetch is in flight — the cards never flicker back to loading). */
  detail: ContextTimelineDetail | null
  /** The last read settled without data (transport failure or absence) and there is no detail to show. */
  failed: boolean
  /** A read is scheduled or in flight. */
  pending: boolean
}

const EMPTY_SNAP: DetailSnap = { detail: null, failed: false, pending: false }

/** The fetch debounce base; each consecutive failure doubles the wait, capped at 3 doublings. */
const DETAIL_DEBOUNCE_MS = 300

/**
 * One session's detail ledger. Exported for tests (a zero debounce makes the
 * machine synchronous-ish); the app reaches it through `detailStoreOf`.
 */
export class DetailStore {
  private detail: ContextTimelineDetail | null = null
  /** The revision of `detail` (latest-wins cursor); -1 before the first landing. */
  private acceptedRev = -1
  /** The newest revision the head has asked for. */
  private wantedRev = -1
  /** The head rev the IN-FLIGHT (or scheduled) read targets — the refold exception's acceptance key. */
  private targetRev = -1
  /** The head rev seen last — a DECREASE means the host refolded (revisions restart). */
  private lastHeadRev = -1
  private failed = false
  private inFlight = false
  private timer: ReturnType<typeof setTimeout> | null = null
  private failures = 0
  private readonly listeners = new Set<() => void>()
  private snap: DetailSnap = EMPTY_SNAP

  constructor(
    private readonly fetcher: (() => Promise<ContextTimelineDetail | null>) | undefined,
    private readonly baseDelay: number = DETAIL_DEBOUNCE_MS,
  ) {}

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  readonly getSnapshot = (): DetailSnap => this.snap

  /**
   * The head's current revision arrived: schedule the trailing-edge read
   * when it outruns the served detail. A rev DECREASE means the host
   * refolded the session (a discarded checkpoint, a restart): revisions are
   * no longer comparable, so the ledger resets and refetches.
   */
  request(rev: number): void {
    if (rev < this.lastHeadRev) {
      this.acceptedRev = -1
      this.wantedRev = -1
      this.detail = null
      this.failed = false
    }
    this.lastHeadRev = rev
    if (rev <= this.acceptedRev || rev <= this.wantedRev) return
    this.wantedRev = rev
    this.schedule()
  }

  /** Re-arm after a failure (the cards' retry note): immediate, backoff reset. */
  readonly retry = (): void => {
    this.failures = 0
    if (this.detail !== null) return
    if (this.timer !== null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.inFlight) void this.fire()
  }

  private schedule(): void {
    if (this.timer !== null) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.fire()
    }, this.baseDelay * 2 ** Math.min(this.failures, 3))
    this.emit()
  }

  private async fire(): Promise<void> {
    // A trailing timer fired while an earlier read is still in flight — that
    // read's settle re-arms when the wanted rev still outruns the served one.
    if (this.inFlight) return
    if (this.fetcher === undefined) {
      // No connection face on this deployment: the typed failure arms the
      // cards' note. (The slim head is only served when the host channel
      // went live, so this is the exotic path.)
      this.failed = true
      this.emit()
      return
    }
    this.inFlight = true
    this.targetRev = this.wantedRev
    this.emit()
    try {
      const d = await this.fetcher()
      if (d !== null) {
        // Latest-wins, with the refold exception: a response matching the
        // requested rev is the current truth even when its number trails a
        // pre-refold landing.
        if (d.rev >= this.acceptedRev || d.rev === this.targetRev) {
          this.detail = d
          this.acceptedRev = d.rev
        }
        this.failures = 0
        this.failed = false
      } else {
        // Absent (the session left the live set): keep the last detail, stop
        // the trailing until the head moves again (a disposed session's rev
        // never does), and arm the note only when nothing is showable.
        this.wantedRev = this.acceptedRev
        this.failed = this.detail === null
        this.failures++
      }
    } catch {
      this.failed = this.detail === null
      this.failures++
    }
    this.inFlight = false
    // The head moved while the read settled (or an earlier read lost the
    // race): trail once more, debounced.
    if (this.wantedRev > this.acceptedRev) this.schedule()
    this.emit()
  }

  private emit(): void {
    const pending = this.timer !== null || this.inFlight
    const next: DetailSnap = { detail: this.detail, failed: this.failed, pending }
    if (next.detail === this.snap.detail && next.failed === this.snap.failed && next.pending === this.snap.pending) return
    this.snap = next
    for (const fn of this.listeners) fn()
  }
}

/** Page-lifetime per-session stores (the tab and the modal share one). */
const stores = new Map<string, DetailStore>()

export function detailStoreOf(ctx: ClientCtx, sessionId: string): DetailStore {
  let store = stores.get(sessionId)
  if (store === undefined) {
    store = new DetailStore(makeDetailFetcher(ctx, sessionId))
    stores.set(sessionId, store)
  }
  return store
}

/** Test isolation: drop every cached store. */
export function resetTimelineDetailStores(): void {
  stores.clear()
}

export type DetailState = 'legacy' | 'loading' | 'ready' | 'failed'

export interface TimelineSource {
  /**
   * The value the cards render — the inline generation's value untouched, or
   * the slim head merged with the fetched detail collections (empty while
   * the first read is in flight; `detailState` names that).
   */
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}

/**
 * The view's one read of the timeline (see the module header for the
 * generation rules). Hook-order safe: every hook runs unconditionally, the
 * branches below only shape the returned record.
 */
export function useTimelineSource(ctx: ClientCtx, props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  // The split marker: the slim head carries the detail revision; anything
  // else (the inline value, the gate fallback, a corrupt payload) is the
  // inline generation — `headRev` null means no detail channel work at all.
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  const store = useMemo(
    () => (slim ? detailStoreOf(ctx, sessionId) : null),
    [ctx, sessionId, slim],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    if (store !== null && headRev !== null) store.request(headRev)
  }, [store, headRev])

  return useMemo<TimelineSource>(() => {
    if (head === null) return { data: null, detailState: 'loading', retryDetail: noopRetry }
    if (!slim || store === null) return { data: head, detailState: 'legacy', retryDetail: noopRetry }
    const detail = snap.detail
    const data: ContextTimeline = detail === null
      ? head
      : {
        ...head,
        requests: detail.requests,
        events: detail.events,
        nodes: detail.nodes,
        droppedNodes: detail.droppedNodes,
        archive: detail.archive,
        // Slim heads serve no floors; the detail's pair lands whole here.
        ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
        ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
        ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
        ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      }
    const detailState: DetailState = detail !== null ? 'ready' : snap.failed ? 'failed' : 'loading'
    return { data, detailState, retryDetail: store.retry }
  }, [head, slim, store, snap])
}
