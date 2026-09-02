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

import type { Category, ContextEventRecord, CostFamilyUsage, RequestRecord, SessionCostUsage, Snapshot, SurfaceNode, TimingTotals, ToolTimingTotals } from '../shared/types'
import { estimateSystemTokens } from '../shared/estimate'
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
   * V4 model family and pricing period (see SessionCostUsage). Running
   * totals — never trimmed, so the estimate always covers the COMPLETE
   * session log even after the request/event retention bounds cut in.
   * Absent until a v4-flash / v4-pro request reports usage.
   */
  cost?: SessionCostUsage
  archiveFloor?: number
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
   */
  stepStart?: { time: number; firstToken?: number }
  /**
   * Tool callId → the call's name and start instant, armed by `tool/call` and
   * DELETED when its `tool/result` folds in (one result per call, in log
   * order) — the map stays at pending-call size instead of growing for the
   * session's whole lifetime (it is persisted state, shallow-copied by every
   * fold step). The start instant prices the call's duration into
   * `timing.toolsMs` when the result arrives.
   */
  callNames: Record<string, { name: string; start: number }>
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
  }
}

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/**
 * Archive removed surface nodes as stamped COPIES — the objects leaving
 * `st.surface` are shared with the persisted previous state, so `gone` must
 * never be written onto them directly.
 */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
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

  const op = ev.surfaceOp as { op?: string; start?: number; end?: number } | null | undefined
  if (op !== null && typeof op === 'object' && op.op === 'replace') {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      // The producer's shadow price covers exactly these node seqs, which can
      // include replacement nodes BEYOND the declared range end (their own
      // seqs postdate the range). Removing by seqs keeps our per-category
      // bookkeeping equal to the producer's total — a range-based removal
      // would leave those nodes behind and overcount.
      const shadowed = new Set(shadowedSeqs)
      const kept: SurfaceNode[] = []
      const removed: SurfaceNode[] = []
      for (const n of st.surface) {
        if (shadowed.has(n.seq)) { st.sums[n.cat] -= n.tokens; removed.push(n) }
        else kept.push(n)
      }
      archiveRemoved(st, removed, ev.seq)
      st.surface = kept
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

interface UsageLike {
  inputTokens?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  outputTokens?: number
}

/**
 * The DeepSeek V4 model family a model name prices as — matched on the NAME
 * alone (provider-agnostic: official API, proxies, OpenRouter spellings like
 * `deepseek/deepseek-v4-flash` all land here). Null for any other model:
 * non-V4 usage is simply not priced.
 */
function costFamilyOf(model: string | undefined): 'flash' | 'pro' | null {
  if (model === undefined) return null
  const m = model.toLowerCase()
  if (!m.includes('v4')) return null
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
 * previous state — the apply contract never mutates it in place).
 */
function accumulateCost(st: TimelineState, time: number, usage: UsageLike): void {
  const family = costFamilyOf(st.model)
  if (family === null) return
  const prev: SessionCostUsage = st.cost ?? {}
  const fam: CostFamilyUsage = prev[family] ?? {}
  const period = isPeakUtc(time) ? 'peak' : 'off'
  const b = fam[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextFam: CostFamilyUsage = { ...fam }
  nextFam[period] = {
    /* v8 ignore next 1 -- accumulateCost only runs under the
       `typeof usage.inputTokens === 'number'` guard; the fallback is
       defensive against a hand-built UsageLike. */
    uncached: b.uncached + (usage.inputTokens ?? 0),
    cacheRead: b.cacheRead + (usage.cacheReadTokens ?? 0),
    cacheWrite: b.cacheWrite + (usage.cacheWriteTokens ?? 0),
    output: b.output + (usage.outputTokens ?? 0),
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

/** Non-negative, NaN-proof duration between two instants (hostile times degrade to 0). */
function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

/**
 * Whether a stream chunk carries a non-empty token delta — the first-token
 * marker the TTFT fold waits for (the same rule as the harness's own
 * session-stats fold). Shape-guarded: a malformed chunk is just not a token.
 */
function isTokenDelta(chunk: unknown): boolean {
  if (chunk === null || typeof chunk !== 'object') return false
  const c = chunk as { type?: unknown; text?: unknown; argumentsDelta?: unknown; name?: unknown }
  switch (c.type) {
    case 'text-delta':
    case 'reasoning-delta':
      return typeof c.text === 'string' && c.text !== ''
    case 'tool-call-delta':
      return (typeof c.argumentsDelta === 'string' && c.argumentsDelta !== '') || c.name !== undefined
    default:
      return false
  }
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
        s.systemTokens = estimateSystemTokens(header.system)
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
        }
        if (s.model) s.lastModel = s.model
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
          s.callNames[data.callId] = { name: data.name, start: event.time }
        }
        break
      }
      case 'assistant/chunk': {
      // The token flood: every stream chunk is one event, so this case stays
      // cheap and mostly reference-stable — only the open step's FIRST token
      // delta stamps the slot (later deltas and steps without a slot return
      // the same state). A malformed chunk just is not a token.
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        if (!isTokenDelta(data?.chunk)) return state
        const s = ensure()
        s.stepStart = { time: start.time, firstToken: event.time }
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
        const s = ensure()
        const node = applySurface(s, event, event.type, data, toolMsg)
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
        const usage = data?.usage as UsageLike | undefined
        const s = ensure()
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
        if (usage && typeof usage.inputTokens === 'number') {
        // Official TokenUsage semantics (dsh-llm): the buckets are disjoint —
        // inputTokens is uncached input only, cache read/write are separate,
        // and billed prompt-side = input + cacheRead + cacheWrite. outputTokens
        // already includes reasoningTokens. No separate prompt/output field
        // exists in the durable vocabulary.
          record.prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
          // Cache-hit share of the billed prompt (the step line's 缓存 figure):
          // keep the cache-served half of `prompt`; absent = no cache buckets.
          if (typeof usage.cacheReadTokens === 'number') record.cacheRead = usage.cacheReadTokens
          if (typeof usage.outputTokens === 'number') record.output = usage.outputTokens
          accumulateCost(s, event.time, usage)
        }
        s.requests.push(record)
        // Timing: one completed model call; its wait/generation split prices
        // off the slot's first-token stamp when the stream carried one (a
        // chunk-less call — legacy log, aborted step — stays unattributed and
        // lands in the card's residue). The pending slot stays armed —
        // the step's tool calls and `step/end` still follow.
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined && stepStart.firstToken !== undefined) {
          timing.ttftMs += durOf(stepStart.time, stepStart.firstToken)
          timing.genMs += durOf(stepStart.firstToken, event.time)
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
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure()
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
   * Serve the projection's wire view: bound the surface nodes to the newest tail and attach each event to the request around it; stamp
   * COPIES
  * — the persisted state objects are never mutated.
 */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.assistant + state.sums.tool
  // NOTE: provider-anchored occupancy (the official chat ring) is NOT folded
  // here since 0.11 — the Client reads token-meter's own `contextPressure`
  // projection key for it (token-meter owns estimation and replay). This
  // value keeps only the heuristic composition; `current.total` includes the
  // envelope (system + tools) and the live surface.
  // Optional scalars use conditional spread: an unknown value must not
  // materialize an `undefined`-valued property on the served view. The wire
  // value travels the harness's lossless-JSON pipeline — a single
  // `undefined`-valued property can fail the whole push (the failure mode
  // behind issue #29), so absence beats a present-but-undefined key.
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
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
  }
  // The cost totals ride the wire as COPIES (same rule as requests/events:
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
