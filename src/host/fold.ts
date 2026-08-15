/**
 * The incremental fold — replays a session's durable event log into the
 * per-request context-composition timeline.
 *
 * Fold state is per-session and advances ONLY over newly appended events
 * (`foldInto` starts at `st.n`), so live sessions (whose logs grow) are
 * cheap to re-snapshot. Surface nodes are priced with the token-meter
 * heuristic (pricing.ts) and the request/event records are the raw material
 * of the snapshot (snapshot.ts).
 */

import type { Category, ContextEventRecord, RequestRecord, SurfaceNode } from '../shared/types'
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
import type { SessionEvent } from './services'

/**
 * History retention bounds. The fold keeps per-STEP request records; when
 * the absolute step bound is exceeded, the timeline is trimmed to the most
 * recent TURN runs (never cutting a turn in half), so turn granularity can
 * always show the full recent turn range instead of a step-count fragment.
 */
const MAX_REQUEST_STEPS = 1500
const MAX_KEPT_TURNS = 300

export interface FoldState {
  /** Number of log events already folded (the fold resumes from here). */
  n: number
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
   * read + write) and the heuristic surface total at that moment. The snapshot
   * derives projectedTokens = pressure + (surface now − surface at sample).
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

export function createFold(): FoldState {
  return {
    n: 0, // number of log events already folded
    surface: [], // { seq, cat, tokens, form?, text?, tool?, err?, skill?, calls? }
    sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
    systemTokens: 0,
    toolsTokens: 0,
    toolList: [], // { name, tokens }
    model: undefined,
    provider: undefined,
    lastModel: undefined,
    contextWindow: undefined,
    pressureTokens: undefined,
    sampledSurfaceTokens: undefined,
    occupancyWindow: undefined,
    requests: [], // one entry per answered model call
    events: [], // notable context events (structured; the Client labels them)
    callNames: {}, // callId -> tool name
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
  st: FoldState,
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
    const block = message?.content?.[0]
    const tname = block && block.callId !== undefined ? st.callNames[block.callId] : undefined
    if (tname) node.tool = tname
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
function sampleUsage(st: FoldState, usage: UsageLike | undefined): void {
  const pressureTokens = pressureOf(usage)
  if (pressureTokens === undefined) return
  st.pressureTokens = pressureTokens
  st.sampledSurfaceTokens = st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
}

/** Advance the fold over every event not yet folded. Mutates `st` in place. */
export function foldInto(st: FoldState, events: readonly SessionEvent[]): void {
  for (let e = st.n; e < events.length; e++) {
    const ev = events[e]
    if (ev === null || typeof ev !== 'object') continue
    const data = ev.data as Record<string, unknown> | undefined
    switch (ev.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          system?: unknown
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        st.toolList = tools.map(t => ({
          name: typeof (t as { name?: unknown }).name === 'string' ? (t as { name: string }).name : '?',
          tokens: estimateToolSchema(t),
        }))
        // The tools TOTAL uses dsh's whole-array price (one JSON string of
        // every schema); per-tool prices above are display-only rankings.
        st.toolsTokens = estimateToolsTotal(tools)
        st.systemTokens = estimateSystem(header.system)
        if (header.config && typeof header.config.model === 'string') st.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') st.provider = header.config.provider
        if (data?.reason === 'change' && st.model && st.lastModel && st.model !== st.lastModel) {
          st.events.push({ seq: ev.seq, time: ev.time, kind: 'model', from: st.lastModel, to: st.model })
        }
        if (st.model) st.lastModel = st.model
        break
      }
      case 'request/context':
        if (data && typeof data.contextWindow === 'number') st.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') st.model = data.model
        if (data && typeof data.provider === 'string') st.provider = data.provider
        // Occupancy capacity is last-wins (an absent window retracts it),
        // unlike the sticky display window above — the official semantics.
        st.occupancyWindow = data && typeof data.contextWindow === 'number' ? data.contextWindow : undefined
        break
      case 'tool/call':
        if (data && data.callId !== undefined && typeof data.name === 'string') st.callNames[String(data.callId)] = data.name
        break
      case 'user/message': {
        const msg = data as unknown as MessageLike
        const node = applySurface(st, ev, ev.type, data, msg)
        const source = msg?.source
        if (isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: ev.seq, time: ev.time, kind: 'inject', form: source.form || 'context', tokens: node.tokens,
          }
          if (source.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else if (typeof source.plugin === 'string' && source.plugin !== '') {
            rec.name = source.plugin
          }
          st.events.push(rec)
        }
        break
      }
      case 'tool/result': {
        // The model-visible message is data.message (the envelope also
        // carries callId/error); pricing the envelope would miss all content.
        const toolMsg = (data?.message ?? null) as MessageLike | undefined
        applySurface(st, ev, ev.type, data, toolMsg)
        break
      }
      case 'assistant/chunk': {
        // A streamed usage chunk is a valid occupancy sample even when its
        // step never completes (no assistant/message follows a failed step).
        const chunk = data?.chunk as { type?: string; usage?: UsageLike } | undefined
        if (chunk !== undefined && chunk.type === 'usage') sampleUsage(st, chunk.usage)
        break
      }
      case 'assistant/message': {
        // Snapshot the request exactly as dispatched: current surface + header,
        // before this response joins the surface.
        const usage = data?.usage as UsageLike | undefined
        // The occupancy anchor is stamped against the surface this request
        // saw, i.e. BEFORE this message joins it (mirrors the official fold).
        sampleUsage(st, usage)
        const total = st.systemTokens + st.toolsTokens + st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
        const record: RequestRecord = {
          turn: data && typeof data.turn === 'number' ? data.turn : undefined,
          step: data && typeof data.step === 'number' ? data.step : undefined,
          time: ev.time, seq: ev.seq,
          system: st.systemTokens,
          tools: st.toolsTokens,
          user: st.sums.user,
          inject: st.sums.inject,
          assistant: st.sums.assistant,
          tool: st.sums.tool,
          total,
        }
        if (usage && typeof usage.inputTokens === 'number') {
          record.prompt = usage.inputTokens + (usage.cacheReadTokens || 0) + (usage.cacheWriteTokens || 0)
          if (typeof usage.outputTokens === 'number') record.output = usage.outputTokens
        }
        st.requests.push(record)
        // The model-visible message is data.message (mirrors dsh's
        // deriveEventMessage); the envelope also carries turn/step/usage.
        const asstMsg = (data?.message ?? null) as MessageLike | undefined
        applySurface(st, ev, ev.type, data, asstMsg)
        break
      }
      case 'compaction/summary':
        // Arm the shadow-price claim: the replacement that follows this
        // event synchronously shadows exactly these node seqs.
        if (data && Array.isArray(data.shadowedSeqs)) {
          st.pendingShadowedSeqs = data.shadowedSeqs.filter((s): s is number => typeof s === 'number')
        }
        st.events.push({
          seq: ev.seq, time: ev.time, kind: 'compaction',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          count: data && Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        })
        break
      case 'compaction/prune':
        if (data && Array.isArray(data.shadowedSeqs)) {
          st.pendingShadowedSeqs = data.shadowedSeqs.filter((s): s is number => typeof s === 'number')
        }
        st.events.push({
          seq: ev.seq, time: ev.time, kind: 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
        })
        break
      default:
        break
    }
  }
  st.n = events.length
  // Keep a deep-enough history for both display granularities: when the step
  // bound is hit, trim by whole turns so turn mode never loses a turn.
  if (st.requests.length > MAX_REQUEST_STEPS) {
    st.requests = trimToLastTurns(st.requests, MAX_KEPT_TURNS)
    // Pathological many-step turns: hard backstop after the turn trim.
    if (st.requests.length > MAX_REQUEST_STEPS) st.requests = st.requests.slice(-MAX_REQUEST_STEPS)
  }
  if (st.events.length > 400) st.events = st.events.slice(-400)
}
