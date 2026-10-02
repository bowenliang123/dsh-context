/**
 * The timeline source behind the Context tab and the /context modal —
 * reconciles the two `contextTimeline` wire generations into the single
 * value the cards have always rendered.
 *
 * Generations (the marker is `detailRev` on the delivered value):
 * - INLINE (older hosts, channel-less deployments, the baseline-gate
 *   fallback): the wire value carries the collections in place. It passes
 *   through untouched — no fetch ever happens.
 * - SPLIT (current host with the detail route live): the wire value is the
 *   slim head (~1KB — every session.list row, control baseline, and push
 *   frame carries it whole). The collections arrive from the plugin's
 *   `/api/dsh-context/detail` fetch route (host/detail.ts): one targeted read
 *   when the tab/modal first opens, then a debounced refetch whenever the
 *   pushed `detailRev` outruns the served detail. Closed tabs fetch nothing.
 *
 * The no-stale-content guarantees: the store is per session and shared by
 * the tab and the modal; a refetch is single-flight with a trailing edge
 * (a rev bumped mid-flight re-reads after settle); responses race-safe by
 * generation and revision (a host refold invalidates reads started before
 * its revisions restarted, and latest wins within a generation); a
 * transport failure keeps the last good
 * detail and backs off; an absent answer (the session left the live set)
 * stops the trailing until the head moves again. With no detail at all,
 * failure surfaces as a retryable note on the detail cards instead of an
 * empty chart.
 *
 * The cold start: a session can sit with NO pushed `contextTimeline` value
 * at all — the enable recomposition raced its open baseline (and the
 * projection store clears a key its baseline omits), or its checkpoint row
 * is missing or version-stale on a cold-observed session. Waiting for a
 * push that never comes would stall the view on "loading" forever, so the
 * source opens the detail channel on its own (rev 0): the route folds the
 * durable log on demand and serves the slim head beside the collections,
 * and the next pushed head takes the channel back per its own revision.
 */

import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline, ContextTimelineDetail } from '../shared/types'
import type { ClientCtx, SessionStandardProps } from './services'
import { asRecord, numOf, objectsOf, projectionOf, timelineOf } from './services'

// The detail route of host/detail.ts — re-declared here: the client bundle
// inlines every import, and the host module must never reach it. Same-origin
// POST under the harness's authenticated `/api` fence.
const DETAIL_ROUTE = '/api/dsh-context/detail'

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
  // The slim head rides the payload for the Agent network's cold-node ring
  // fetch; a missing or malformed head only degrades that composition (the
  // detail cards never read it), so it drops out instead of rejecting the
  // payload the cards consume.
  const head = timelineOf(data.head)
  return {
    rev: data.rev,
    ...(head !== null ? { head } : {}),
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    archive: objectsOf(data.archive),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
    ...(data.fileOps !== undefined ? { fileOps: objectsOf(data.fileOps) } : {}),
    ...(typeof data.fileOpsFloor === 'number' ? { fileOpsFloor: data.fileOpsFloor } : {}),
    ...(data.spans !== undefined ? { spans: objectsOf(data.spans) } : {}),
  }
}

/**
 * The detail reader over the plugin's own `/api` fetch route (host/detail.ts).
 * Same-origin POST through the harness's authenticated fence; the returned
 * thunk resolves the session's current detail, `null` when the session is not
 * live anymore, and rejects on transport failure or a malformed payload (the
 * store turns the two into the retryable state).
 */
export function makeDetailFetcher(
  ctx: ClientCtx,
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  void ctx
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
  private generation = 0
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
      this.generation++
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
      // No session id to read for: the typed failure arms the cards' note.
      // (The slim head is only served when the host route went live, so this
      // is the exotic path.)
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
        // Compare revisions only within the generation that started this read.
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
      if (generation === this.generation) {
        this.failed = this.detail === null
        this.failures++
      }
    } finally {
      this.inFlight = false
      // The head moved or refolded while the read settled: trail once more.
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
  // The cold start arms whenever no value has been pushed: the channel is
  // opened by the source itself (rev 0) instead of waiting on a push that
  // may never come (the enable recomposition raced the baseline, a cleared
  // or stale checkpoint row). The store is per session, so the cold read's
  // result carries straight into the pushed generation's later refetches.
  const cold = head === null
  const store = useMemo(
    () => (slim || cold ? detailStoreOf(ctx, sessionId) : null),
    [ctx, sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    // The pushed head's revision drives the trailing refetch; the cold start
    // requests rev 0 — acceptance is rev-safe, and a head that arrives later
    // trails per its own revision.
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    // A head-with-detail can only exist through a live channel store — the
    // fallback covers TS's narrowing loss, never a real state.
    const retry = store !== null ? store.retry : noopRetry
    // The inline generation passes through untouched — no store exists, the
    // collections never ride the channel.
    if (head !== null && !slim) return { data: head, detailState: 'legacy', retryDetail: noopRetry }
    // The render head: the pushed value, or — while nothing has been pushed —
    // the detail read's own slim head.
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      // Nothing renderable: the cold read still pending, or settled without
      // a usable value (transport failure, absence, a headless payload) —
      // the retryable failure, never a spinner that never resolves.
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry }
    }
    if (detail === null) {
      // The head's own counters render while the first read is in flight (or
      // once it settled without data — the failure note rides beside).
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry }
    }
    const data: ContextTimeline = {
      ...base,
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
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry }
  }, [head, slim, store, snap])
}
