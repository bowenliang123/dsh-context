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

import type { Category, ContextEventRecord, CostFamilyUsage, RequestRecord, SessionCostUsage, Snapshot, SurfaceNode } from '../shared/types'
import type { FoldBounds } from './config'
import {
  estimateMessage,
  estimateSystem,
  estimateToolsTotal,
  estimateToolSchema,
  firstText,
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

/** The projection unit's persisted state (plain JSON, bounded see above). */
export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  /** Live per-category token sums over the surface. */
  sums: Record<Category, number>
  systemTokens: number
  toolsTokens: number
  toolList: { name: string; tokens: number }[]
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
  /** Newest `gone` among archive entries dropped by the retention bounds. */
  archiveFloor?: number
  /**
   * Tool callId → name, armed by `tool/call` and DELETED when its
   * `tool/result` folds in (one result per call, in log order) — the map
   * stays at pending-call size instead of growing for the session's whole
   * lifetime (it is persisted state, shallow-copied by every fold step).
   */
  callNames: Record<string, string>
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
}

/** Keep only the trailing `maxTurns` turn-runs of a request timeline. */
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

/** Distinct turn runs in a request timeline (consecutive equal-turn runs). */
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

/** Retain the newest tail of the two unbounded lists (bounded persisted state). */
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
    // Hard count cap.
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
    toolList: [],
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
    const srcName = typeof srcId === 'string' ? st.callNames[srcId] : undefined
    const block = message?.content?.[0] as { toolCallId?: unknown } | undefined
    const blockId = block?.toolCallId
    if (srcName) node.tool = srcName
    else if (typeof blockId === 'string') node.tool = st.callNames[blockId]
    // Consume-once: the entry is never looked up again after its result
    // folds in (see TimelineState.callNames). Rebuild without the used ids
    // (no dynamic delete, per repo lint) — consume-once holds the map at
    // pending-call size, so the copy is trivial.
    if (typeof srcId === 'string' || typeof blockId === 'string') {
      const kept: Record<string, string> = {}
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

  // The metering event armed the shadowed seqs for the replacement that must
  // follow it synchronously; consume them here (any later surface event
  // would expire them, mirroring the official shadow-price protocol).
  // DELETE the armed field — assigning `undefined` would leave an
  // `undefined`-valued property behind, which violates the plain-JSON
  // persisted-state precondition (see TimelineState) and would fail the
  // whole session's projection-cache write.
  const shadowedSeqs = st.pendingShadowedSeqs
  delete st.pendingShadowedSeqs

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
export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  const ensure = (): TimelineState => st ??= {
    ...state,
    surface: [...state.surface],
    sums: { ...state.sums },
    toolList: [...state.toolList],
    requests: [...state.requests],
    events: [...state.events],
    archived: [...state.archived],
    callNames: { ...state.callNames },
  }

  const data = event.data
  switch (event.type) {
    case 'request/header': {
      const header = (data?.header ?? {}) as {
        system?: unknown
        tools?: unknown[]
        config?: { model?: unknown; provider?: unknown }
      }
      const tools = Array.isArray(header.tools) ? header.tools : []
      const s = ensure()
      s.toolList = tools.map(t => ({
        name: typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : '?',
        tokens: estimateToolSchema(t),
      }))
      // The tools TOTAL uses dsh's whole-array price (one JSON string of
      // every schema); per-tool prices above are display-only rankings.
      s.toolsTokens = estimateToolsTotal(tools)
      s.systemTokens = estimateSystem(header.system)
      // Current route/model: the durable request envelope is the source of
      // truth (request/context is only route/capacity metadata, appended
      // AFTER request/header per request — see agent-loop buildRequestHeader).
      // Optional fields are set via conditional spread so a still-unknown
      // value never materializes an `undefined` property (plain-JSON state
      // precondition — see TimelineState).
      if (header.config && typeof header.config.model === 'string') s.model = header.config.model
      if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
      // A model switch has no dedicated durable event: it is a request
      // header that differs from the previous one, logged with reason
      // 'change' ('initial' opens a session, 'resume' reopens it). Firing
      // only here keeps the model event list equal to the durable record.
      if (data?.reason === 'change' && s.model && s.lastModel && s.model !== s.lastModel) {
        s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
      }
      if (s.model) s.lastModel = s.model
      break
    }
    case 'request/context': {
      const s = ensure()
      // Route/capacity metadata: request/context is logged only when the
      // route or capacity changes (appended after request/header), so it
      // updates the CURRENT route display — it never fires a model-switch
      // event on its own (see the request/header case). All three fields
      // are only written on a real value (plain-JSON state — see
      // TimelineState), so no `undefined` property can materialize here.
      if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
      if (data && typeof data.model === 'string') s.model = data.model
      if (data && typeof data.provider === 'string') s.provider = data.provider
      break
    }
    case 'tool/call': {
      if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
        const s = ensure()
        s.callNames[data.callId] = data.name
      }
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
        } else if (typeof source.plugin === 'string' && source.plugin !== '') {
          rec.name = source.plugin
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
      applySurface(s, event, event.type, data, toolMsg)
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
      // `turn`/`step` are optional in the durable vocabulary (and on replay);
      // write them only on a real number so an absent value never materializes
      // an `undefined` property (plain-JSON persisted-state precondition — see
      // TimelineState) — the same trap that broke the projection cache here.
      if (data && typeof data.turn === 'number') record.turn = data.turn
      if (data && typeof data.step === 'number') record.step = data.step
      if (usage && typeof usage.inputTokens === 'number') {
        // Official TokenUsage semantics (dsh-llm): the buckets are disjoint —
        // inputTokens is uncached input only, cache read/write are separate,
        // and billed prompt-side = input + cacheRead + cacheWrite. outputTokens
        // already includes reasoningTokens. No separate prompt/output field
        // exists in the durable vocabulary.
        record.prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
        if (typeof usage.outputTokens === 'number') record.output = usage.outputTokens
        // Session-cost raw material: the SAME billed buckets, attributed to
        // the current model family and the request's pricing period.
        accumulateCost(s, event.time, usage)
      }
      s.requests.push(record)
      // `deriveEventMessage` returns `data.message` for assistant/message, or
      // null when the content array is empty (usage-only events project to no
      // message — same rule as dsh's surface fold).
      const asstMsg = deriveEventMessage(event as never) as MessageLike | null
      applySurface(s, event, event.type, data, asstMsg)
      break
    }
    case 'compaction/summary':
    case 'compaction/prune': {
      const s = ensure()
      // Arm the shadow-price claim: the replacement that follows this
      // event synchronously shadows exactly these node seqs.
      if (data && Array.isArray(data.shadowedSeqs)) {
        s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
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
      // Unrecognized / log-only events (turn boundaries, chunks, todo/write,
      // compaction brackets, …) don't move the timeline — no state change.
      return state
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

/**
 * Build the wire snapshot served to the browser — the projection's `view()`.
 * Bounds the surface nodes (newest carry the signal), and attributes each
 * event to the request around it by stamping COPIES (the persisted state
 * objects are never mutated).
 */
export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.assistant + state.sums.tool
  // NOTE: provider-anchored occupancy (the official chat ring) is NOT folded
  // here since 0.11 — the Client reads token-meter's own `contextPressure`
  // projection key for it (token-meter owns estimation and replay). This
  // value keeps only the heuristic composition; `current.total` includes the
  // envelope (system + tools) and the live surface.
  const result: Snapshot = {
    ok: true,
    model: state.model,
    provider: state.provider,
    contextWindow: state.contextWindow,
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      assistant: state.sums.assistant,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    toolList: state.toolList,
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

  // Attribute each event to the requests around it — the context that event
  // contributed to (same attachment the chart uses for ✂ markers). `turn`/
  // `step` name the FIRST request logged after the event (an injection lands
  // on the step that consumed it, a between-turn compaction on the next
  // turn's first step); `fromTurn`/`fromStep` name the request logged right
  // BEFORE it, so boundary events can show the gap they sit in
  // ("Step 2→3", or "Turn 50 · Step 8 → Turn 51 · Step 1"). Both lists stay
  // sorted by seq, so one pointer walk suffices. Events with no following
  // request (still in flight, or older than the retained window) keep only
  // the `from*` side; events before the first retained request keep none.
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
