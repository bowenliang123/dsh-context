/**
 * The context-timeline fold — replays a session's durable event log into the
 * per-request context-composition timeline.
 *
 * Since v0.9 the fold lives as a *session projection unit* registered on the
 * harness's `ctx.sessionProjections`: the framework drives `applyTimeline`
 * once per committed `session/event`, persists the state through the
 * projection cache, and pushes the finished `buildTimelineView` value to the
 * browser (this plugin no longer runs a custom RPC channel — see timeline.ts).
 *
 * Projection contract notes (mirrored from `ProjectionDefinition`):
 * - `applyTimeline(state, event)` returns the SAME reference when the event
 *   does not change the unit's state (`Object.is` gates the change feed);
 *   any change returns a new reference built from a lazy shallow clone.
 * - `state` must stay plain JSON (persisted-cache precondition) and bounded.
 *   Retention bounds: per-step request records capped (trimmed by whole turns,
 *   never cutting a turn in half), events capped to the newest tail.
 * - Surface nodes are priced with the token-meter heuristic (pricing.ts) and
 *   the request/event records are the raw material of `buildTimelineView`.
 */

import type { Category, ContextEventRecord, ContextTimelineDetail, CostFamilyUsage, FileOpRecord, RequestRecord, SessionCostUsage, Snapshot, SurfaceNode, SystemPromptNode, TimingTotals, ToolTimingTotals } from '../shared/types'
import { estimateSystemContent, estimateSystemTokens } from '../shared/estimate'
import type { FoldBounds } from './config'
import {
  estimateMessage,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from './pricing'
import type { ContentBlock, MessageSource } from './pricing'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { decodeKindOfBlock, decodeSpansOfStream, firstTokenTimeOfStream, isTokenChunk, replaceRangeOf } from './logShapes'
import type { DecodeKind } from './logShapes'
import { opsOfCall, parseCallArgs } from '../shared/fileOps'

/**
 * The runtime event envelope this fold consumes. The core
 * `@deepseek-ai/dsh-session` `SessionEvent` union only carries the core event
 * types — plugin-merged vocabulary (the `compaction/*` family is declared by
 * `dsh-compaction`) is absent from the union. The fold must not depend on
 * those packages, so it widens to this structural envelope (validated by the
 * durable log, which rejects unknown REQUIRED events at the envelope layer).
 */
export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

/**
 * History retention bounds (configurable since 0.11 — see config.ts; these
 * are the defaults' values). The fold keeps per-STEP request records; once the
 * newest run count exceeds `maxKeptTurns`, the timeline is trimmed to the
 * most recent whole TURN runs (never cutting a turn in half), so turn
 * granularity can always show the full recent turn range instead of a
 * step-count fragment. The turn-run trim runs whenever the cap is crossed
 * (not only when the raw step bound is), so the bounded state stays at the
 * newest ~`maxKeptTurns` turns deterministically as a live log grows.
 */

export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  sums: Record<Category, number>
  systemTokens: number
  /**
   * The live system-prompt nodes, oldest first — a V3 log's `system/message`
   * surface nodes, or the single entry a V0/V2 `request/header.header.system`
   * envelope defines. `systemTokens` is the LAST entry with tokens > 0 (the
   * harness's own "last nonempty surviving system" rule), so an empty dormant
   * node keeps its position without clearing the prompt. Bounded by
   * SYSTEM_NODES_MAX. ABSENT on rows folded before this field existed — the
   * wire then serves no `systems` and the client falls back to the header
   * epoch's own envelope figure.
   */
  systems?: SystemPromptNode[]
  /**
   * Whether `systems` was built from the V0/V2 request ENVELOPE
   * (`header.system`) rather than from V3 `system/message` events. Only then
   * may a system-less header CLEAR the list: its canonical V0 meaning is
   * "this request has no system prompt", while a V3 header never carries one
   * (its prompt lives in the message history). Absent = log-sourced, and
   * never materialized as an `undefined`-valued property (plain-JSON
   * precondition — see the note above `model`).
   */
  systemsFromHeader?: true
  toolsTokens: number
  /**
   * The projection-cache precondition is plain JSON: a property whose value
   * is `undefined` makes the whole checkpoint unserializable
   * (`snapshotJsonValue` rejects it), which fails EVERY cache write for the
   * session — including the `title` projection row that powers the session
   * list after a restart. Optional fields therefore use absent properties
   * (`model`/`provider`/`lastModel`/`contextWindow` are simply not set until
   * a value is known) instead of `undefined`-valued ones. Reads via
   * `state.model` are identical for both shapes (`undefined` on miss).
   */
  model?: string
  provider?: string
  lastModel?: string
  contextWindow?: number
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /**
   * Recently removed surface nodes (stamped COPIES carrying `gone`), in
   * removal order. Feeds the Context browser's per-step reconstruction.
   * Bounded two ways in trimState: capped to `maxArchiveNodes`, and pruned
   * to removals after the oldest retained request (older removals can only
   * serve steps the requests trim already forgot).
   */
  archived: SurfaceNode[]
  /**
   * Session-cost raw material: cumulative billed-token totals per DeepSeek
   * model family and pricing period (see SessionCostUsage). Running
   * totals — never trimmed, so the estimate always covers the COMPLETE
   * session log even after the request/event retention bounds cut in.
   * Absent until a DeepSeek flash/pro request reports usage.
   */
  cost?: SessionCostUsage
  archiveFloor?: number
  /**
   * The detail collections' revision marker (see ContextTimelineDetail):
   * bumped by every fold that mutates the request records, context events,
   * live surface, or the removed-node archive — the slim wire head carries
   * it so an open tab knows its fetched detail went stale. Absent until the
   * first detail fold (undefined reads as 0; never materialize an
   * `undefined`-valued property — the plain-JSON precondition above).
   */
  detailRev?: number
  /**
   * Whole-session timing totals (see TimingTotals) — running sums over the
   * COMPLETE session log, like `cost`. Absent until the first step or tool
   * lifecycle folds in; created once and cloned-on-touch afterwards (the
   * object is shared with the persisted previous state — see `ensure`).
   */
  timing?: TimingTotals
  /**
   * The open step's start instant, armed by `step/start` and consumed by the
   * `assistant/message` (TTFT/generation split) and `step/end` (wall time)
   * that follow it; `assistant/chunk` stamps `firstToken` on the step's first
   * token delta — absent when the stream carried none (legacy or aborted
   * steps), which leaves that call's model time unattributed. One slot, not a
   * map: steps are sequential in the log, so the newest `step/start` is the
   * one those events close — a hostile interleaved log degrades to skipped
   * durations, never to unbounded state. Same arm/remove lifecycle as
   * `pendingShadowedSeqs`.
   *
   * `decode` and `block` carry the generation split (reasoning / answer text /
   * tool arguments — see TimingTotals): a V0 log's `assistant/chunk`
   * `block-start` markers open `block` and close the previous one into
   * `decode`; a V2+ log carries no such events, so `decode` stays absent and
   * `assistant/message` reads the spans off its embedded stream instead.
   */
  stepStart?: { time: number; firstToken?: number; decode?: Record<DecodeKind, number>; block?: { kind: DecodeKind; since: number } }
  /**
   * Tool callId → the call's name, start instant, and raw arguments, armed by
   * `tool/call` and DELETED when its `tool/result` folds in (one result per
   * call, in log order) — the map stays at pending-call size instead of
   * growing for the session's whole lifetime (it is persisted state,
   * shallow-copied by every fold step). The start instant prices the call's
   * duration into `timing.toolsMs` when the result arrives; the raw arguments
   * feed the file-op derivation (shared/fileOps.ts) at that same moment.
   */
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  /**
   * Seq list of the surface nodes the next replacement will shadow, armed by
   * the metering event (`compaction/summary` | `compaction/prune`) and
   * consumed by the replacement that must follow it synchronously. The
   * producer's shadow price covers exactly these seqs — which can differ
   * from the replacement's declared range (pruned replacement nodes keep
   * their own seqs, beyond the range end) — so removal must follow the seqs.
   * Absent until armed, and REMOVED (not set to `undefined`) when consumed,
   * to keep the state plain JSON for the projection cache.
   */
  pendingShadowedSeqs?: number[]
  /**
   * The seq of the compaction/prune event that armed `pendingShadowedSeqs` —
   * the shadowed path rewrites that event's `tokens` from the gross shadow
   * price to the NET freed amount (removed nodes minus the synchronous
   * replacement), so the row matches the drop the trend chart shows. Same
   * arm/remove lifecycle as `pendingShadowedSeqs`.
   */
  pendingShadowEventSeq?: number
  /**
   * The fold-derived file-operation log (the File Activity card's raw
   * material, shared/fileOps.ts): one record per executed file op, appended
   * in log order — at `tool/result` (the armed call's arguments + the
   * result's meta) and at a run_code result's flush of its nested
   * dispatches. Bounded by `maxFileOps`; the trim stamps `fileOpsFloor`.
   */
  fileOps: FileOpRecord[]
  /** The newest dropped op's seq (the card's coverage floor for the served op log). */
  fileOpsFloor?: number
  /**
   * Nested Code-Mode ops buffered by their top run_code call id until the
   * parent's result folds (the dispatch events land BEFORE it, and the ops'
   * locate target is that result's seq). Flushed (and the key deleted) when
   * the result with that callId folds; absent until the first dispatch books
   * an op. Bounded by PENDING_CODE_OPS_MAX — a hostile log that never
   * settles a run_code cannot grow it.
   */
  pendingCodeOps?: Record<string, FileOpRecord[]>
}

export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i].turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

function trimState(st: TimelineState, bounds: FoldBounds): void {
  // Trim by WHOLE turn-runs as soon as the run count crosses the cap —
  // not only when the raw step count does — so the state stays
  // deterministically at the newest ~maxKeptTurns turns (a threshold-only
  // policy would oscillate: trim to 1200, regrow to 1500, trim again).
  if (countTurnRuns(st.requests) > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
  }
  // Pathological many-step turns: hard step backstop after the turn trim.
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  // The file-op log: newest tail; the newest dropped op's seq rides
  // `fileOpsFloor` (the same coverage-floor family as archiveFloor).
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  // Archive retention (the Context browser's per-step reconstruction raw
  // material). Entries leave in removal order (oldest `gone` first), so the
  // newest dropped `gone` is the last dropped entry's — recorded as
  // `archiveFloor` for the client's approximate-reconstruction note.
  if (st.archived.length > 0) {
    let drop = 0
    // Removals at or before the oldest retained request can only reconstruct
    // steps the requests trim already forgot.
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
  }
}

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/**
 * Mark the detail collections dirty (TimelineState.detailRev). Every caller
 * is a fold branch that just mutated the requests/events/surface/archive;
 * branches that touch only the working slots (stepStart, callNames, the
 * shadow claim) or the envelope scalars do NOT bump — the served detail is
 * unchanged, and an open tab has nothing to refetch.
 */
function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

/**
 * Bound on the live system-prompt nodes (TimelineState.systems). The
 * effective figure is the LAST nonempty node, so dropping the oldest can only
 * under-report a pathological log whose newest SYSTEM_NODES_MAX nodes are all
 * empty while an older one still carried text.
 */
const SYSTEM_NODES_MAX = 8

/** The effective system-prompt price: the last nonempty node, else 0 (the harness's own rule). */
function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    if (systems[i].tokens > 0) return systems[i].tokens
  }
  return 0
}

/** Append one system-prompt node, bounding the list (see SYSTEM_NODES_MAX). */
function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

/**
 * Bound on the buffered nested Code-Mode ops (TimelineState.pendingCodeOps)
 * — a hostile log that dispatches without settling the parent run_code
 * cannot grow the persisted state past this.
 */
const PENDING_CODE_OPS_MAX = 200

/** JSON-stringify an unknown argument payload; a hostile (cyclic) value yields no args. */
function argsRawOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

/** Append op records to the fold-derived log (the trim lives in trimState, with the other collections). */
function pushFileOps(st: TimelineState, ops: FileOpRecord[]): void {
  for (const op of ops) st.fileOps.push(op)
}

/**
 * Buffer nested Code-Mode ops under their top run_code call id (they flush
 * when the parent's result folds — the ops' locate target). A full buffer
 * drops new arrivals wholesale (defensive logs only).
 */
function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

/**
 * Archive removed surface nodes as stamped COPIES — the objects leaving
 * `st.surface` are shared with the persisted previous state, so `gone` must
 * never be written onto them directly.
 */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

/**
 * Remove every live surface node whose seq the replacement claims, keeping the
 * per-category sums equal to the surviving nodes and archiving the removals.
 * Removal follows the SEQ list, not the declared range: pruned replacement
 * nodes keep their own seqs beyond the range end, so a range-based removal
 * would leave them behind and overcount. Returns the removed nodes.
 */
function removeSurfaceSeqs(st: TimelineState, claimed: ReadonlySet<number>, goneSeq: number): SurfaceNode[] {
  if (claimed.size === 0) return []
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      st.sums[n.cat] -= n.tokens
      removed.push(n)
    } else {
      kept.push(n)
    }
  }
  archiveRemoved(st, removed, goneSeq)
  st.surface = kept
  return removed
}

interface SurfaceEventLike {
  seq: number
  time: number
  surfaceOp?: unknown
}

interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  error?: boolean
}

/**
 * The message nested under an event payload's `message` field
 * (`system/message`, `assistant/message`, `tool/result`) — read structurally
 * rather than through `deriveEventMessage`, whose 0.1.2-rc.1 generation knows
 * nothing of the V3 `system/message` variant. A malformed payload reads null.
 */
function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

/**
 * The first full text block, recursing through nested content blocks (a tool
 * result wraps its text in a `tool-result` block). Unlike `firstText` this
 * must NOT truncate/normalize: the skill name is matched off the raw
 * `<skill_content name="…">` wrapper.
 */
function nestedText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
    if (block.content !== undefined) {
      const nested = nestedText(block.content)
      if (nested !== '') return nested
    }
  }
  return ''
}

/**
 * The skill name a `skill`-tool result carries. Loaded skills are rendered as
 * `<skill_content name="…">…</skill_content>` in the result's text, so the name
 * is recovered from the content rather than trusted from the call envelope.
 */
function skillNameOf(msg: MessageLike | null | undefined): string {
  const text = nestedText(msg?.content)
  const match = text.match(/<skill_content\s+name="([^"]+)"/)
  return match === null ? '' : match[1]
}

function applySurface(
  st: TimelineState,
  ev: SurfaceEventLike,
  type: string,
  data: { error?: boolean } | undefined,
  message: MessageLike | null | undefined,
): SurfaceNode {
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    // Empty assistant messages project to no model message (usage-only), so
    // they price 0 — `deriveEventMessage` returns null for that case, and
    // `estimateMessage(null, true)` short-circuits before ROLE_OVERHEAD.
    tokens: estimateMessage(message, type === 'assistant/message'),
  }
  // Image blocks ride the NODE (absent when zero): the stats board's image
  // cell sums the live surface, so a compacted message's images stop counting.
  const imgs = imageCountOf(message?.content)
  if (imgs > 0) node.imgs = imgs
  const source = message?.source
  const form = source?.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
    else {
      const names = toolCallNames(message?.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    // The call id rides the durable source authoritatively
    // (`tool/result.message.source.callId`); the content block mirrors it as
    // `toolCallId` (not `callId` — a shape earlier plugin builds misread).
    const srcId = (source as { callId?: unknown } | undefined)?.callId
    const block = message?.content?.[0] as { toolCallId?: unknown } | undefined
    const blockId = block?.toolCallId
    // The name is stamped only on a real map hit: an unpaired result (a call
    // event that aged out of the log, a foreign producer, a duplicate callId)
    // must not materialize an `undefined`-valued property — that one property
    // fails EVERY projection-cache write for the session (the plain-JSON
    // precondition, see TimelineState).
    const srcEntry = typeof srcId === 'string' ? st.callNames[srcId] : undefined
    const blockEntry = srcEntry === undefined && typeof blockId === 'string'
      ? st.callNames[blockId]
      : undefined
    // Price the completed call into the timing totals: the same entry that
    // names the node carries the call's start instant; an unpaired result
    // carries neither name nor duration.
    const toolEntry = srcEntry ?? blockEntry
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      const timing = ensureTiming(st)
      const dur = durOf(toolEntry.start, ev.time)
      timing.toolsMs += dur
      timing.toolCalls += 1
      bumpToolTotals(timing, toolEntry.name, dur)
    }
    // Consume-once: the entry is never looked up again after its result
    // folds in (see TimelineState.callNames). Rebuild without the used ids
    // (no dynamic delete, per repo lint) — consume-once holds the map at
    // pending-call size, so the copy is trivial.
    if (typeof srcId === 'string' || typeof blockId === 'string') {
      const kept: Record<string, { name: string; start: number }> = {}
      for (const k in st.callNames) {
        if (k !== srcId && k !== blockId) kept[k] = st.callNames[k]
      }
      st.callNames = kept
    }
    if (data?.error) node.err = true
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(s => s?.name).filter(Boolean).join(', ').slice(0, 80)
    } else {
      const ptext = firstText(message?.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    const utext = firstText(message?.content)
    if (utext !== '') node.text = utext
  }

  // Consume the armed shadow claim here (a later surface event would expire it, per the shadow-price protocol); DELETE the fields —
  // assigning `undefined` would break the plain-JSON persisted-state precondition (see TimelineState).
  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      // The producer's shadow price covers exactly these node seqs, which can
      // include replacement nodes BEYOND the declared range end (their own
      // seqs postdate the range). Removing by seqs keeps our per-category
      // bookkeeping equal to the producer's total — a range-based removal
      // would leave those nodes behind and overcount.
      const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq)
      st.sums[cat] += node.tokens
      st.surface.push(node)
      // Rewrite the metering event's row from its gross shadow price to the
      // NET freed amount (the replacement re-adds its own tokens), so the
      // number matches the drop the trend chart shows. The record is cloned:
      // the events array's elements are shared with the persisted state.
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) st.events[i] = { ...st.events[i], tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    // No shadow claim: the replacement names its span directly, read off BOTH
    // endpoint spellings (logShapes.replaceRangeOf) and spliced IN PLACE — the
    // harness's own surface semantics (the replacing node takes the span's
    // position). BOTH endpoints must name live nodes, exactly as the harness's
    // registry validates; a malformed span degrades to an append, which keeps
    // the nodes rather than silently dropping context.
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      archiveRemoved(st, removed, ev.seq)
      for (const r of removed) st.sums[r.cat] -= r.tokens
      st.sums[cat] += node.tokens
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  return node
}

/** The durable usage object, as far as the fold reads it — every bucket is re-proved by `tokenCountOf`, never trusted. */
interface UsageLike {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
}

/** One usage object's buckets, deeply normalized to billed counts (see {@link tokenCountOf}). */
interface BilledUsage {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/**
 * One provider-reported usage bucket as a billed count, or null when the
 * field carries no readable number. Accepts finite numbers and numeric
 * strings; fractions round (some gateways report fractional counts) and
 * negatives clamp to 0 — a mis-accounting gateway that reports
 * `cached_tokens > prompt_tokens` drives the disjoint uncached-input figure
 * below zero, and one raw figure in the state would fail the wire and state
 * schemas' `.int().nonnegative()` gates on EVERY later delivery, permanently
 * freezing the projection feed for the session (issue #44). NaN, infinities,
 * and non-numeric values read as absent.
 */
function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

/**
 * The DeepSeek model family a model name prices as — matched on the NAME
 * alone (provider-agnostic: official API, proxies, OpenRouter spellings like
 * `deepseek/deepseek-v4.1-flash` and `deepseek/deepseek-flash` all land
 * here). The name must carry a DeepSeek marker (`v4` or `deepseek`) so a
 * foreign flash/pro-named model (gemini-2.0-flash) is never priced.
 */
function costFamilyOf(model: string | undefined): 'flash' | 'pro' | null {
  if (model === undefined) return null
  const m = model.toLowerCase()
  if (!m.includes('v4') && !m.includes('deepseek')) return null
  if (m.includes('flash')) return 'flash'
  if (m.includes('pro')) return 'pro'
  return null
}

/**
 * DeepSeek's peak windows (Beijing Time, UTC+8): 09:00-12:00 and 14:00-18:00
 * on weekdays; off-peak (half the peak rate) covers all other hours plus all
 * of Saturday and Sunday.
 */
function isPeakUtc(time: number): boolean {
  const bj = new Date(time + 8 * 3600_000)
  const day = bj.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = bj.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

/**
 * Fold one billed request into the session-cost totals, cloning along the
 * mutated path only (the untouched branch stays shared with the persisted
 * previous state — the apply contract never mutates it in place). The
 * buckets arrive sanitized ({@link BilledUsage}), so the totals stay at the
 * schemas' non-negative safe integers no matter what the provider reported.
 */
function accumulateCost(st: TimelineState, time: number, usage: BilledUsage): void {
  const family = costFamilyOf(st.model)
  if (family === null) return
  const prev: SessionCostUsage = st.cost ?? {}
  const fam: CostFamilyUsage = prev[family] ?? {}
  const period = isPeakUtc(time) ? 'peak' : 'off'
  const b = fam[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextFam: CostFamilyUsage = { ...fam }
  nextFam[period] = {
    uncached: b.uncached + usage.input,
    cacheRead: b.cacheRead + usage.cacheRead,
    cacheWrite: b.cacheWrite + usage.cacheWrite,
    output: b.output + usage.output,
  }
  const next: SessionCostUsage = { ...prev }
  next[family] = nextFam
  st.cost = next
}

/**
 * Advance the fold over ONE committed session event under the projection
 * contract. Uninteresting events return the same reference (`Object.is` gates
 * the change feed); any change returns a new reference over a lazy shallow
 * clone, so the persisted state is never mutated in place by the caller.
 * `bounds` come from the plugin config (config.ts) — retention only, they
 * never change the state shape.
 */

/** The timing card's per-tool ranking cap: the busiest 16 names are kept. */
const TOOL_TIMING_CAP = 16

/** The decode buckets of the generation split, in card order (see TimingTotals). */
const DECODE_KINDS: readonly DecodeKind[] = ['reasoning', 'text', 'toolarg']

/** Non-negative, NaN-proof duration between two instants (hostile times degrade to 0). */
function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/**
 * The fold's private timing accumulator: created on first use, and CLONED on
 * every later ensure() (see `applyTimeline`) — the object left in the
 * persisted previous state is never written into in place.
 */
function ensureTiming(st: TimelineState): TimingTotals {
  if (st.timing === undefined) {
    st.timing = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }
  }
  return st.timing
}

/**
 * Fold one block's decode span into the totals' generation split (see
 * TimingTotals). A zero span stays ABSENT — the field then carries the
 * "no time was decoded in this bucket" fact without adding dead properties to
 * every pre-split-shaped state, and the card reads absence as 0.
 */
function addDecode(timing: TimingTotals, kind: DecodeKind, ms: number): void {
  if (!(ms > 0)) return
  if (kind === 'reasoning') timing.reasoningMs = (timing.reasoningMs ?? 0) + ms
  else if (kind === 'text') timing.textMs = (timing.textMs ?? 0) + ms
  else timing.toolArgMs = (timing.toolArgMs ?? 0) + ms
}

/**
 * Tally one completed tool call into the per-name ranking, bounded to
 * TOOL_TIMING_CAP names: repeated names update in place, a new name beyond
 * the cap evicts the smallest tally first (the ranking's tail), so state
 * stays bounded even over a hostile log of unique names.
 */
function bumpToolTotals(timing: TimingTotals, name: string, ms: number): void {
  // hasOwn, not an index check: a missing key IS possible at runtime (a name
  // outside the persisted tally), and the hasOwn guard reads honestly.
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      // The record is non-empty whenever the cap binds, so the scan always
      // names a minimum (the first probe wins against +Infinity).
      let minKey = ''
      let minMs = Infinity
      for (const k in timing.tools) {
        if (timing.tools[k].ms < minMs) {
          minMs = timing.tools[k].ms
          minKey = k
        }
      }
      const kept: Record<string, ToolTimingTotals> = {}
      for (const k in timing.tools) {
        if (k !== minKey) kept[k] = timing.tools[k]
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const cur = timing.tools[name]
  timing.tools[name] = { calls: cur.calls + 1, ms: cur.ms + ms }
}

export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  const ensure = (): TimelineState => st ??= {
    ...state,
    surface: [...state.surface],
    sums: { ...state.sums },
    requests: [...state.requests],
    events: [...state.events],
    archived: [...state.archived],
    callNames: { ...state.callNames },
    fileOps: [...state.fileOps],
    // The pending-ops MAP is cloned here; each key's array is rebuilt on
    // touch (bufferCodeOps/flush), never mutated in place — same rule.
    ...(state.pendingCodeOps !== undefined
      ? { pendingCodeOps: { ...state.pendingCodeOps } }
      : {}),
    // The timing totals are shared with the persisted previous state —
    // private working copies for this event's accumulations (per-name rows
    // are replaced, never mutated, so a one-level copy suffices for them).
    ...(state.timing !== undefined
      ? { timing: { ...state.timing, tools: { ...state.timing.tools } } }
      : {}),
  }

  const data = event.data
  // The projection registry drives `apply` straight off the session/event bus
  // with no error boundary: one throwing fold stops this unit's cells (and the
  // `contextTimeline` push feed) from advancing — the browser waits on
  // "loading" forever. The durable log is untrusted input, so a malformed
  // event is DROPPED, never thrown; any partial mutations are private lazy
  // clones and stay valid plain JSON.
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          system?: unknown
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure()
        // Tools TOTAL = dsh's whole-array price (one JSON string of every schema).
        s.toolsTokens = estimateToolsTotal(tools)
        // The V0/V2 system prompt rides this ENVELOPE; V3 rejects it outright
        // (surface.ts: "must omit header.system; use system/message") and
        // carries the prompt as a surface node instead. A present string is
        // the envelope's own prompt for every request in its series; an
        // absent one means "this request has no system prompt" ONLY when the
        // list was envelope-sourced — otherwise the header is a V3 snapshot
        // and the log's system nodes stay untouched.
        const systemText = header.system
        if (typeof systemText === 'string' && systemText !== '') {
          s.systems = [{ seq: event.seq, time: event.time, tokens: estimateSystemTokens(systemText) }]
          s.systemsFromHeader = true
          s.systemTokens = systemTokensOf(s.systems)
        } else if (s.systemsFromHeader === true) {
          s.systems = []
          delete s.systemsFromHeader
          s.systemTokens = 0
        }
        // Current route/model: the durable request envelope is the source of
        // truth (request/context is only route/capacity metadata, appended
        // AFTER request/header per request — see agent-loop `buildRequest`).
        // Optional fields are set via conditional spread so a still-unknown
        // value never materializes an `undefined` property (plain-JSON state
        // precondition — see TimelineState).
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        // A model switch has no dedicated durable event: it is a request
        // header that differs from the previous one, logged with reason
        // 'change' ('initial' opens a session, 'resume' reopens it). A resume
        // carrying a different model is a real switch the user made between
        // sessions — lastModel survived in the projection state, so record it
        // too. Firing only on a real change keeps the list equal to the record.
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        // The V3 system prompt: a SURFACE node (position 0 of the harness's
        // ordered surface) that the plugin tracks outside its message
        // categories — it is the envelope figure's source, never a
        // user/inject/assistant/tool node, so it must not enter `surface` or
        // `sums` (that would double-count it against `systemTokens`).
        const s = ensure()
        // Consume the armed shadow claim (the shadow-price protocol expires it
        // on the next surface event) — a system node never carries one.
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          // Defensive: a replacement claiming ordinary surface nodes (never
          // produced by dsh's system-prompt projection) removes them too, so
          // the surface and its sums stay consistent with the claim.
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s)
        }
        delete s.systemsFromHeader
        pushSystem(s, { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) })
        break
      }
      case 'request/context': {
        const s = ensure()
        // Route/capacity metadata: request/context is logged only when the route or capacity changes (after request/header), so it updates
        // the current route display — never firing a model-switch event on its own.
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const s = ensure()
          // The raw arguments ride along for the result-time file-op derivation (shared/fileOps.ts).
          const argsRaw = argsRawOf(data.arguments)
          s.callNames[data.callId] = {
            name: data.name,
            start: event.time,
            ...(argsRaw !== undefined ? { argsRaw } : {}),
          }
        }
        break
      }
      case 'tool/code-dispatch':
      case 'tool/ptc-dispatch': {
        // A nested PTC (Code Mode) call settling inside a run_code program:
        // one settled sub-dispatch books its file ops exactly like a top-level
        // call — minus meta (the dispatch event carries none, so read windows
        // and per-file search attribution degrade to the argument-only
        // forms). The ops buffer under the top run_code call id and flush
        // when its result folds (their locate target is that result's row).
        // BOTH vocabulary generations land here: `tool/code-dispatch` on
        // V0/V2 logs, `tool/ptc-dispatch` on V3 (the rename keeps the payload).
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId === 'string' && typeof name === 'string') {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: name,
            argsRaw: argsRawOf(data?.arguments),
            err: data?.isError === true,
          })
          if (ops.length > 0) {
            const s = ensure()
            bufferCodeOps(s, rootCallId, ops)
          }
        }
        break
      }
      case 'assistant/chunk': {
      // V0 stream events: the token flood, one event per chunk, so this case
      // stays cheap and mostly reference-stable — only the open step's FIRST
      // token delta stamps the slot (later deltas and steps without a slot
      // return the same state). V2+ logs carry no such events; their timed
      // stream rides `assistant/message` / `assistant/attempt` (see below).
      //
      // A `block-start` marker opens a decode block (reasoning / answer text /
      // tool arguments) and closes the previous one into the slot's decode
      // spans, so the generation window splits by what was being decoded.
        const start = state.stepStart
        if (start === undefined) return state
        const chunk = data?.chunk as { type?: unknown; blockType?: unknown } | null | undefined
        if (chunk !== null && typeof chunk === 'object' && chunk.type === 'block-start') {
          const kind = decodeKindOfBlock(chunk.blockType)
          // An unknown marker still CLOSES the open block (its end is real);
          // only the interval it would open stays unattributed.
          if (start.block === undefined && kind === undefined) return state
          const s = ensure()
          const decode = { ...(start.decode ?? { reasoning: 0, text: 0, toolarg: 0 }) }
          if (start.block !== undefined) decode[start.block.kind] += durOf(start.block.since, event.time)
          // The next block is ABSENT (not undefined-valued) when unknown — the
          // plain-JSON persisted-state precondition (see TimelineState).
          s.stepStart = {
            time: start.time,
            ...(start.firstToken !== undefined ? { firstToken: start.firstToken } : {}),
            decode,
            ...(kind !== undefined ? { block: { kind, since: event.time } } : {}),
          }
          break
        }
        if (start.firstToken !== undefined) return state
        if (!isTokenChunk(data?.chunk)) return state
        const s = ensure()
        s.stepStart = { ...start, firstToken: event.time }
        break
      }
      case 'assistant/attempt': {
      // V2+: one model attempt that committed no surface message. Its embedded
      // stream still carries the attempt's first token, which the harness's own
      // sessionStats fold stamps on the open step the same way — an in-step
      // retry therefore keeps its real TTFT instead of falling into the card's
      // residue.
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure()
        s.stepStart = { time: start.time, firstToken: first }
        break
      }
      case 'step/start': {
        // Arm the single pending-step slot (see TimelineState.stepStart): the
        // following assistant/chunk stamps the first token on it, and the
        // assistant/message and step/end price the model wait/generation and
        // the whole step against this instant. Always a state change (a new
        // slot value), even over an un-consumed predecessor — sequential logs
        // never hit that, hostile ones just supersede it.
        const s = ensure()
        s.stepStart = { time: event.time }
        break
      }
      case 'step/end': {
        // No open slot (an unpaired step/end, or the step aged past a
        // refold) — nothing to price, and the state must stay reference-equal.
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure()
        ensureTiming(s).wallMs += durOf(start.time, event.time)
        // Consume-once: DELETE the optional field — assigning `undefined`
        // would break the plain-JSON persisted-state precondition.
        delete s.stepStart
        break
      }
      case 'user/message': {
      // `deriveEventMessage` is the canonical per-event projection: returns
      // `event.data` for user/message (no `data.message` indirection).
        const msg = deriveEventMessage(event as never) as MessageLike | null
        const s = ensure()
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, data, msg)
        const source = msg?.source
        if (isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: event.seq, time: event.time, kind: 'inject', form: source.form || 'context', tokens: node.tokens,
          }
          if (source.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else {
            const label = injectionSourceName(source)
            if (label !== '') rec.name = label
            // A notice carries the producer's bounded one-line account; show it after the source name, as the dsh transcript row does.
            if (source.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
        }
        break
      }
      case 'tool/result': {
      // The model-visible message is data.message; `deriveEventMessage`
      // returns that directly (the envelope also carries callId/error; pricing
      // the envelope would miss all content).
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        // Read the pairing BEFORE applySurface consumes it (consume-once):
        // the armed call's name/arguments pair this result into file ops, and
        // the result's callId is the flush key for buffered Code-Mode ops.
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const firstBlock = toolMsg?.content?.[0] as { toolCallId?: unknown; isError?: unknown } | undefined
        const blockId = firstBlock?.toolCallId
        const pendingEntry = (typeof srcId === 'string' ? state.callNames[srcId] : undefined)
          ?? (typeof blockId === 'string' ? state.callNames[blockId] : undefined)
        const buffered = (typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined)
          ?? (typeof blockId === 'string' ? state.pendingCodeOps?.[blockId] : undefined)
        const s = ensure()
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, data, toolMsg)
        // The file-op derivation (shared/fileOps.ts): the armed call's
        // arguments + the result's presentation meta. Unpaired results book
        // nothing (parity with the surface node's missing tool label).
        if (pendingEntry !== undefined) {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: pendingEntry.name,
            argsRaw: pendingEntry.argsRaw,
            meta: data?.meta,
            err: Boolean(data?.error) || firstBlock?.isError === true,
          })
          pushFileOps(s, ops)
        }
        if (buffered !== undefined && buffered.length > 0) {
          // The run_code root settles: its nested ops land with `parent` = this
          // result's row, plus the program description off its call arguments.
          const program = parseCallArgs(pendingEntry?.argsRaw)?.description
          pushFileOps(s, buffered.map(op => ({
            ...op,
            parent: event.seq,
            ...(typeof program === 'string' && program !== '' ? { program } : {}),
          })))
          const kept: Record<string, FileOpRecord[]> = {}
          for (const k in s.pendingCodeOps) {
            if (k !== srcId && k !== blockId) kept[k] = s.pendingCodeOps[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeOps = kept
          else delete s.pendingCodeOps
        }
        // A skill load via the `skill` tool returns the loaded skill's
        // instructions as a tool result — content the harness injected into the
        // model's context. Keep it a tool result (that is what it is), but make
        // it findable: tag the node with the skill name so the browser can label
        // the row, and record an inject event so a `Skill 注入（name）` entry
        // shows in the Context Events card instead of being buried among
        // ordinary tool results. `node.tool` resolves to the tool name `skill`;
        // the skill NAME comes from the rendered `<skill_content name="…">`.
        // When the tool/call event is gone (trimmed window, replay) the name is
        // unresolvable — fall back to the wrapper alone: it only appears in
        // genuine skill results, and a missed tag is worse than a content guess.
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
          }
        }
        break
      }
      case 'assistant/message': {
      // Snapshot the request exactly as dispatched: current surface + header,
      // before this response joins the surface.
        const usage = data?.usage as UsageLike | null | undefined
        const s = ensure()
        bumpDetailRev(s)
        const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.assistant + s.sums.tool
        const record: RequestRecord = {
          time: event.time, seq: event.seq,
          system: s.systemTokens,
          tools: s.toolsTokens,
          user: s.sums.user,
          inject: s.sums.inject,
          assistant: s.sums.assistant,
          tool: s.sums.tool,
          total,
        }
        // `turn`/`step` are optional in the durable vocabulary (and on replay); write only real numbers — an absent value must not
        // materialize an `undefined` property (plain-JSON precondition, the trap that broke the projection cache here).
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        if (usage !== null && typeof usage === 'object') {
        // Official TokenUsage semantics (dsh-llm): the buckets are disjoint —
        // inputTokens is uncached input only, cache read/write are separate,
        // and billed prompt-side = input + cacheRead + cacheWrite. outputTokens
        // already includes reasoningTokens. No separate prompt/output field
        // exists in the durable vocabulary. Every bucket passes the deep
        // `tokenCountOf` read first: the durable log is untrusted input, and a
        // raw nonconforming figure must never enter the state (issue #44).
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          const output = tokenCountOf(usage.outputTokens)
          // Any readable bucket is a billing sample (the official meter folds
          // every reported usage object; an output-only sample bills prompt 0
          // there too). A fully unreadable object is treated as absent, so a
          // fabricated 0 never reaches the client's derived-occupancy anchor.
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            // Cache-hit share of the billed prompt (the step line's 缓存 figure):
            // keep the cache-served half of `prompt`; absent = no cache bucket.
            if (cacheRead !== null) record.cacheRead = cacheRead
            if (output !== null) record.output = output
            accumulateCost(s, event.time, {
              input: input ?? 0,
              cacheRead: cacheRead ?? 0,
              cacheWrite: cacheWrite ?? 0,
              output: output ?? 0,
            })
          }
        }
        s.requests.push(record)
        // Timing: one completed model call; its wait/generation split prices
        // off the slot's first-token stamp. That stamp comes from a V0
        // `assistant/chunk` delta or, when the log carries none, from the
        // message's own EMBEDDED stream (V2+ settlements) — the same fallback
        // the harness's sessionStats fold applies. A call whose stream carried
        // no token (legacy log, aborted step) stays unattributed and lands in
        // the card's residue. The pending slot stays armed — the step's tool
        // calls and `step/end` still follow.
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const firstToken = stepStart.firstToken ?? firstTokenTimeOfStream(data?.stream)
          if (firstToken !== undefined) {
            timing.ttftMs += durOf(stepStart.time, firstToken)
            timing.genMs += durOf(firstToken, event.time)
            // Generation split: a V0 log's chunk stream accumulated the block
            // spans in the slot (its last block closes HERE, at the message);
            // a V2+ log has no chunk events, so the spans come off the embedded
            // stream. Either way the three buckets tile the generation window
            // and only the settlement tail stays unattributed. The split is
            // priced ONLY when the window was: an unstamped call's model time
            // is unattributed wholesale, so its spans must not reappear as
            // generation time the caller never charged.
            if (stepStart.decode !== undefined) {
              const decode = { ...stepStart.decode }
              if (stepStart.block !== undefined) {
                decode[stepStart.block.kind] += durOf(stepStart.block.since, event.time)
              }
              for (const kind of DECODE_KINDS) addDecode(timing, kind, decode[kind])
            } else {
              const spans = decodeSpansOfStream(data?.stream, event.time)
              for (const kind of DECODE_KINDS) addDecode(timing, kind, spans[kind])
            }
          }
        }
        // `deriveEventMessage` returns `data.message` for assistant/message, or
        // null when the content array is empty (usage-only events project to no
        // message — same rule as dsh's surface fold).
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        applySurface(s, event, event.type, data, asstMsg)
        break
      }
      case 'plan/mode': {
      // Plan mode adds a guidance section to every model request while
      // active — a real context-composition change, so it earns an event.
        if (data && typeof data.active === 'boolean') {
          const s = ensure()
          s.events.push({ seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' })
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure()
        bumpDetailRev(s)
        // Arm the shadow-price claim: the replacement that follows this
        // event synchronously shadows exactly these node seqs.
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        s.events.push({
          seq: event.seq, time: event.time, kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
            ? { count: data.shadowedSeqs.length }
            : {}),
        })
        break
      }
      default:
        return state
    }
  } catch {
    // Unreachable over well-formed events; the guard exists so it can never
    // take the projection (or the session event bus) down. A failed event is
    // dropped WHOLE: any partial mutation lived on private lazy clones, so
    // falling back to the previous state reference keeps the transition
    // all-or-nothing.
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

/**
 * The envelope scalars both wire generations share: current composition, the
 * live-surface counters, and the copied cost/timing totals. Served value
 * fields are COPIES — the served value must never alias persisted state.
 * Optional scalars use conditional spread: an unknown value must not
 * materialize an `undefined`-valued property (the lossless-JSON pipeline —
 * a single such property can fail the whole push, the failure mode behind
 * issue #29).
 */
function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.assistant + state.sums.tool
  // NOTE: provider-anchored occupancy (the official chat ring) is NOT folded
  // here since 0.11 — the Client reads token-meter's own `contextPressure`
  // projection key for it (token-meter owns estimation and replay). This
  // value keeps only the heuristic composition; `current.total` includes the
  // envelope (system + tools) and the live surface.
  const result: Snapshot = {
    ok: true,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images: state.surface.reduce((n, node) => n + (node.imgs ?? 0), 0),
    // Tool calls WITH A RESULT live in the current context: one `tool/result`
    // folds to exactly one `tool` surface node, so live tool nodes are the
    // count. Calls still in flight (no result yet) and results compacted or
    // pruned out of the surface are both excluded.
    toolCalls: state.surface.reduce((n, node) => node.cat === 'tool' ? n + 1 : n, 0),
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  // The cost totals ride the wire as COPIES (same rule as the collections:
  // the served value must never alias persisted state).
  if (state.cost !== undefined) {
    const copyFam = (f: CostFamilyUsage | undefined): CostFamilyUsage | undefined => {
      if (f === undefined) return undefined
      const out: CostFamilyUsage = {}
      if (f.peak !== undefined) out.peak = { ...f.peak }
      if (f.off !== undefined) out.off = { ...f.off }
      return out
    }
    const cost: SessionCostUsage = {}
    const flash = copyFam(state.cost.flash)
    if (flash !== undefined) cost.flash = flash
    const pro = copyFam(state.cost.pro)
    if (pro !== undefined) cost.pro = pro
    result.cost = cost
  }
  // The timing totals ride the wire as COPIES too (per-name rows included).
  if (state.timing !== undefined) {
    const tools: Record<string, ToolTimingTotals> = {}
    for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] }
    result.timing = { ...state.timing, tools }
  }
  // The live system-prompt nodes ride the wire as COPIES: the browser resolves
  // the prompt in force at any step from them and fetches its TEXT on demand
  // from `seq` — a `system/message` event on V3, the epoch's `request/header`
  // on V0/V2. Absent when the log carried none, which is exactly the legacy
  // shape older clients already degrade on (they fall back to the epoch).
  if (state.systems !== undefined && state.systems.length > 0) {
    result.systems = state.systems.map(n => ({ ...n }))
  }
  return result
}

/**
 * The heavy collections: copies of the retained request records and context
 * events (each event attached to the requests around it — the chart's ✂
 * anchoring), the bounded served surface window, and the removed-node
 * archive. Shared verbatim by the inline wire view (channel-less hosts) and
 * the on-demand detail payload (host/detail.ts).
 */
function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
    // The fold-derived file-op log rides the collections (the inline view and
    // the detail payload share this builder) — COPIES, never state aliases.
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
  }
  // The served slice: the newest `maxNodes` tail PLUS every live inject node
  // older than the tail. Injections (AGENTS.md, session-start context, …)
  // land on the surface FIRST, so in a long session the plain tail window
  // drops their identity while their tokens keep counting (sums cover the
  // full surface) — the browser's inject section would show a token sum with
  // zero listable items. Injects are few; pin them all into the served list.
  // The overflow slice precedes the tail by position, so the concatenation
  // stays seq-ordered.
  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(n => n.cat === 'inject')
  result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  result.droppedNodes = overflowCount - pinned.length
  // Coverage floors for the Context browser's per-step reconstruction:
  // `surfaceFloor` names the newest live node NOT served (the dropped slice
  // is the oldest by position); `archiveFloor` rides the state's retention
  // ledger (see trimState). Both let the client mark a picked step's
  // reconstruction approximate instead of silently under-showing it.
  if (result.droppedNodes > 0) {
    let floor = 0
    for (const n of overflow) if (n.cat !== 'inject') floor = Math.max(floor, n.seq)
    result.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) result.archiveFloor = state.archiveFloor

  // Attach each event to the requests around it (same attachment the chart uses for ✂): `turn`/`step` name the first request logged after
  // the event, `fromTurn`/`fromStep` the request before it; both lists stay seq-sorted, so one pointer walk suffices. Events with no
  // following (or preceding) retained request keep only one side.
  const requests = result.requests
  const events = result.events
  let ri = 0
  for (const ev of events) {
    while (ri < requests.length && requests[ri].seq <= ev.seq) ri++
    // .at() keeps the past-the-end case visible to the type system.
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

/**
 * The split generation's SLIM wire head: the envelope scalars plus the
 * precomputed count figures, the newest request's billing summary (the
 * headline's derived anchor), and the detail revision marker. Small enough
 * to ride every delivery channel whole (~1KB) — the heavy collections moved
 * to the on-demand detail channel (host/detail.ts).
 */
export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  // The stats board's count figures, over the RETAINED records (the same set
  // the detail serves): distinct turn values and per-kind event tallies.
  const turns = new Set<number>()
  for (const r of state.requests) turns.add(r.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const e of state.events) {
    if (e.kind === 'inject') injects++
    else if (e.kind === 'compaction') compactions++
    else if (e.kind === 'prune') prunes++
  }
  result.counts = { turns: turns.size, steps: state.requests.length, injects, compactions, prunes }
  const last = state.requests.at(-1)
  if (last !== undefined) {
    result.last = { seq: last.seq, total: last.total, ...(typeof last.prompt === 'number' ? { prompt: last.prompt } : {}) }
  }
  result.detailRev = state.detailRev ?? 0
  return result
}

/**
 * The on-demand detail payload (host/detail.ts serves it off the live fold
 * state): the heavy collections plus the revision marker the head carries.
 */
export function buildTimelineDetail(state: TimelineState, bounds: FoldBounds): ContextTimelineDetail {
  return { rev: state.detailRev ?? 0, ...detailCollectionsOf(state, bounds) }
}

/**
   * Serve the INLINE projection wire view (channel-less hosts): the head
   * scalars with the detail collections in place — the shape every delivery
   * channel carried before the split generation. Bound the surface nodes to
   * the newest tail and attach each event to the request around it; stamp
   * COPIES — the persisted state objects are never mutated.
 */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  return { ...headFieldsOf(state), ...detailCollectionsOf(state, bounds) }
}
