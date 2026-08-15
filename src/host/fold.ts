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

import type { Category, ContextEventRecord, RequestRecord, Snapshot, SurfaceNode } from '../shared/types'
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
 * History retention bounds. The fold keeps per-STEP request records; once the
 * newest run count exceeds `MAX_KEPT_TURNS`, the timeline is trimmed to the
 * most recent whole TURN runs (never cutting a turn in half), so turn
 * granularity can always show the full recent turn range instead of a
 * step-count fragment. The turn-run trim runs whenever the cap is crossed
 * (not only when the raw step bound is), so the bounded state stays at the
 * newest ~`MAX_KEPT_TURNS` turns deterministically as a live log grows.
 */
const MAX_REQUEST_STEPS = 1500
const MAX_KEPT_TURNS = 300
const MAX_EVENTS = 400
/** Surface nodes served to the browser (the newest carry the most signal). */
const MAX_NODES = 200

/** The projection unit's persisted state (plain JSON, bounded see above). */
export interface TimelineState {
  /** Model-visible surface, newest last. */
  surface: SurfaceNode[]
  /** Live per-category token sums over the surface. */
  sums: Record<Category, number>
  systemTokens: number
  toolsTokens: number
  toolList: { name: string; tokens: number }[]
  model: string | undefined
  provider: string | undefined
  lastModel: string | undefined
  contextWindow: number | undefined
  /**
   * Provider-anchored occupancy, mirroring dsh token-meter's contextPressure
   * projection: the newest usage sample's prompt-side pressure (input + cache
   * read + write) and the heuristic surface total at that moment.
   * `buildTimelineView` derives projectedTokens = pressure + (surface now −
   * surface at sample).
   */
  pressureTokens: number | undefined
  sampledSurfaceTokens: number | undefined
  /** Last-wins route capacity for occupancy (mirrors the official removal semantics). */
  occupancyWindow: number | undefined
  requests: RequestRecord[]
  events: ContextEventRecord[]
  callNames: Record<string, string>
  /**
   * Seq list of the surface nodes the next replacement will shadow, armed by
   * the metering event (`compaction/summary` | `compaction/prune`) and
   * consumed by the replacement that must follow it synchronously. The
   * producer's shadow price covers exactly these seqs — which can differ
   * from the replacement's declared range (pruned replacement nodes keep
   * their own seqs, beyond the range end) — so removal must follow the seqs.
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
function trimState(st: TimelineState): void {
  // Trim by WHOLE turn-runs as soon as the run count crosses the cap —
  // not only when the raw step count does — so the state stays
  // deterministically at the newest ~MAX_KEPT_TURNS turns (a threshold-only
  // policy would oscillate: trim to 1200, regrow to 1500, trim again).
  if (countTurnRuns(st.requests) > MAX_KEPT_TURNS) {
    st.requests = trimToLastTurns(st.requests, MAX_KEPT_TURNS)
  }
  // Pathological many-step turns: hard step backstop after the turn trim.
  if (st.requests.length > MAX_REQUEST_STEPS) {
    st.requests = st.requests.slice(-MAX_REQUEST_STEPS)
  }
  if (st.events.length > MAX_EVENTS) st.events = st.events.slice(-MAX_EVENTS)
}

export function createTimelineState(): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    toolList: [],
    model: undefined,
    provider: undefined,
    lastModel: undefined,
    contextWindow: undefined,
    pressureTokens: undefined,
    sampledSurfaceTokens: undefined,
    occupancyWindow: undefined,
    requests: [],
    events: [],
    callNames: {},
  }
}

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
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
  message: MessageLike | undefined,
): SurfaceNode {
  const cat = categoryOf(type, message)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    // Empty assistant messages project to no model message (usage-only), so
    // they price 0 — mirroring dsh's deriveEventMessage/estimate.
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
  const shadowedSeqs = st.pendingShadowedSeqs
  st.pendingShadowedSeqs = undefined

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
      for (const n of st.surface) {
        if (shadowed.has(n.seq)) st.sums[n.cat] -= n.tokens
        else kept.push(n)
      }
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

/** Prompt-side pressure of one usage sample: input plus cache traffic, no output. */
function pressureOf(usage: UsageLike | undefined): number | undefined {
  if (usage === undefined || typeof usage.inputTokens !== 'number') return undefined
  return usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
}

/**
 * Anchor the occupancy sample: the provider's prompt-side pressure paired with
 * the heuristic surface total AT THIS MOMENT. Callers must sample BEFORE the
 * same event joins the surface, so the anchor matches the surface the sampled
 * request actually saw (mirroring token-meter's contextPressure fold).
 */
function sampleUsage(st: TimelineState, usage: UsageLike | undefined): void {
  const pressureTokens = pressureOf(usage)
  if (pressureTokens === undefined) return
  st.pressureTokens = pressureTokens
  st.sampledSurfaceTokens = st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
}

/**
 * Advance the fold over ONE committed session event under the projection
 * contract. Uninteresting events return the same reference (`Object.is` gates
 * the change feed); any change returns a new reference over a lazy shallow
 * clone, so the persisted state is never mutated in place by the caller.
 */
export function applyTimeline(state: TimelineState, event: TimelineEvent): TimelineState {
  let st: TimelineState | undefined
  const ensure = (): TimelineState => st ??= {
    ...state,
    surface: [...state.surface],
    sums: { ...state.sums },
    toolList: [...state.toolList],
    requests: [...state.requests],
    events: [...state.events],
    callNames: { ...state.callNames },
  }

  const data = event.data as Record<string, unknown> | undefined
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
      if (header.config && typeof header.config.model === 'string') s.model = header.config.model
      if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
      if (data?.reason === 'change' && s.model && s.lastModel && s.model !== s.lastModel) {
        s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
      }
      if (s.model) s.lastModel = s.model
      break
    }
    case 'request/context': {
      const s = ensure()
      if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
      if (data && typeof data.model === 'string') s.model = data.model
      if (data && typeof data.provider === 'string') s.provider = data.provider
      // Occupancy capacity is last-wins (an absent window retracts it),
      // unlike the sticky display window above — the official semantics.
      s.occupancyWindow = data && typeof data.contextWindow === 'number' ? data.contextWindow : undefined
      break
    }
    case 'tool/call': {
      if (data && data.callId !== undefined && typeof data.name === 'string') {
        const s = ensure()
        s.callNames[String(data.callId)] = data.name
      }
      break
    }
    case 'user/message': {
      const msg = data as unknown as MessageLike
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
      // The model-visible message is data.message (the envelope also
      // carries callId/error); pricing the envelope would miss all content.
      const toolMsg = (data?.message ?? null) as MessageLike | undefined
      const s = ensure()
      applySurface(s, event, event.type, data, toolMsg)
      break
    }
    case 'assistant/chunk': {
      // A streamed usage chunk is a valid occupancy sample even when its
      // step never completes (no assistant/message follows a failed step).
      const chunk = data?.chunk as { type?: string; usage?: UsageLike } | undefined
      if (chunk !== undefined && chunk.type === 'usage') {
        const s = ensure()
        sampleUsage(s, chunk.usage)
      }
      break
    }
    case 'assistant/message': {
      // Snapshot the request exactly as dispatched: current surface + header,
      // before this response joins the surface.
      const usage = data?.usage as UsageLike | undefined
      const s = ensure()
      // The occupancy anchor is stamped against the surface this request
      // saw, i.e. BEFORE this message joins it (mirrors the official fold).
      sampleUsage(s, usage)
      const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.assistant + s.sums.tool
      const record: RequestRecord = {
        turn: data && typeof data.turn === 'number' ? data.turn : undefined,
        step: data && typeof data.step === 'number' ? data.step : undefined,
        time: event.time, seq: event.seq,
        system: s.systemTokens,
        tools: s.toolsTokens,
        user: s.sums.user,
        inject: s.sums.inject,
        assistant: s.sums.assistant,
        tool: s.sums.tool,
        total,
      }
      if (usage && typeof usage.inputTokens === 'number') {
        record.prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
        if (typeof usage.outputTokens === 'number') record.output = usage.outputTokens
      }
      s.requests.push(record)
      // The model-visible message is data.message (mirrors dsh's
      // deriveEventMessage); the envelope also carries turn/step/usage.
      const asstMsg = (data?.message ?? null) as MessageLike | undefined
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
    trimState(st)
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
export function buildTimelineView(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.assistant + state.sums.tool
  // Provider-anchored occupancy (the official chat ring's formula): the newest
  // usage sample carried forward by the surface's movement since it was taken,
  // so a compaction shows immediately instead of waiting for the next request.
  const projectedTokens = state.pressureTokens !== undefined && state.sampledSurfaceTokens !== undefined
    ? Math.max(0, state.pressureTokens + surfaceTotal - state.sampledSurfaceTokens)
    : undefined
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
    occupancy: {
      ...state.pressureTokens === undefined ? {} : { pressureTokens: state.pressureTokens },
      surfaceTokens: surfaceTotal,
      ...state.sampledSurfaceTokens === undefined ? {} : { sampledSurfaceTokens: state.sampledSurfaceTokens },
      ...projectedTokens === undefined ? {} : { projectedTokens },
      ...state.occupancyWindow === undefined ? {} : { contextWindow: state.occupancyWindow },
    },
    toolList: state.toolList,
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
  }
  result.droppedNodes = Math.max(0, state.surface.length - MAX_NODES)
  result.nodes = state.surface.slice(-MAX_NODES)

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
    const next = requests[ri]
    const prev = ri > 0 ? requests[ri - 1] : undefined
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
