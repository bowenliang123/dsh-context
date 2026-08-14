/**
 * dsh-context — Host half (installed package entry).
 *
 * A plain Cordis plugin module (ESM, zero runtime dependencies) loaded by the
 * harness as the `dsh-context` loader row. It replays a session's durable
 * event log into a per-request context-composition timeline and serves it to
 * the Client half over a generic Connection RPC channel (`/dsh-context`).
 *
 * Performance: live sessions are folded straight from the in-memory log
 * (`sessions.get(id).events` — no clone, no parse) and the fold is
 * INCREMENTAL: per-session state advances only over newly appended events.
 * Cold (persisted, not live) sessions fall back to `sessionQuery` and are
 * served from cache once folded, since their logs never grow.
 *
 * Token figures use the same fixed-density heuristic as the harness's own
 * token-meter (4 chars ≈ 1 token, +4 per content block, +4 role framing).
 * Labels are sent structured (kind/form/name/count) so the Client localizes.
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'dsh-context'

/** Required services: the generic Connection RPC registry (host half). */
export const inject = ['connection']

// ---- local service contracts ------------------------------------------------
//
// The `@deepseek-ai/*` service type packages publish broken dependency chains
// on npm (e.g. `dsh-paths` is missing), so this third-party plugin declares
// the exact API surface it consumes against the documented harness contracts.
// These are TYPE-ONLY: the runtime services come from the user's harness.

/** A minimal session-log event, as folded by this plugin. */
export interface SessionEvent {
  seq: number
  type: string
  time: number
  data?: unknown
  surfaceOp?: unknown
}

interface SessionLike {
  readonly events: readonly SessionEvent[]
}

interface SessionStoreLike {
  get(id: string): SessionLike | undefined
}

interface SessionQueryLike {
  listEvents(id: string): Promise<readonly unknown[]>
  readSession(id: string): Promise<{ events?: readonly SessionEvent[] }>
}

/** The generic Connection RPC channel registry (`ctx.connection.rpc`). */
interface HostConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    options: { authority: 'trusted-host' | 'loopback' },
  ): () => Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    connection: { rpc: HostConnectionRpc }
    sessions: SessionStoreLike
    sessionQuery: SessionQueryLike
  }
}

// ---- wire envelope (mirrors the harness RpcResult shape) --------------------

type RpcError = { code: string; message: string; details: unknown }
type RpcResult<T> = { ok: true; value: T } | { ok: false; error: RpcError }

// ---- snapshot model (shared wire contract with the Client half) -------------

export type Category = 'user' | 'inject' | 'assistant' | 'tool'

export interface Snapshot {
  ok: boolean
  model?: string
  provider?: string
  contextWindow?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    assistant: number
    tool: number
    total: number
  }
  toolList: { name: string; tokens: number }[]
  requests: RequestRecord[]
  events: ContextEventRecord[]
  nodes: SurfaceNode[]
  droppedNodes: number
}

export interface SurfaceNode {
  seq: number
  /** Event timestamp (ms epoch); the Client shows it when present. */
  time?: number
  cat: Category
  tokens: number
  form?: string
  text?: string
  tool?: string
  err?: boolean
  skill?: string
  calls?: string[]
}

export interface RequestRecord {
  turn?: number
  step?: number
  time: number
  seq: number
  system: number
  tools: number
  user: number
  inject: number
  assistant: number
  tool: number
  total: number
  prompt?: number
  output?: number
}

export interface ContextEventRecord {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model'
  form?: string
  tokens?: number
  count?: number
  sub?: string
  name?: string
  from?: string
  to?: string
}

interface FoldState {
  n: number
  surface: SurfaceNode[]
  sums: Record<Category, number>
  systemTokens: number
  toolsTokens: number
  toolList: { name: string; tokens: number }[]
  model: string | undefined
  provider: string | undefined
  lastModel: string | undefined
  contextWindow: number | undefined
  requests: RequestRecord[]
  events: ContextEventRecord[]
  callNames: Record<string, string>
}

// ---- harness token-meter heuristic (mirrors dsh-token-meter/estimate.ts) ----

const CHARS_PER_TOKEN = 4
const BLOCK_OVERHEAD = 4
const ROLE_OVERHEAD = 4

interface ContentBlock {
  type: string
  text?: string
  name?: string
  arguments?: string
  content?: ContentBlock[]
  callId?: string
}

function estimateBlocks(blocks: ContentBlock[] | undefined): number {
  let tokens = 0
  if (!Array.isArray(blocks)) return 0
  for (const block of blocks) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
      case 'reasoning':
        tokens += Math.ceil(String(block.text || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-call':
        tokens += Math.ceil(String(block.name || '').length / CHARS_PER_TOKEN)
          + Math.ceil(String(block.arguments || '').length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
        break
      case 'tool-result':
        tokens += estimateBlocks(block.content) + BLOCK_OVERHEAD
        break
      default:
        tokens += BLOCK_OVERHEAD + Math.ceil(JSON.stringify(block).length / CHARS_PER_TOKEN)
    }
  }
  return tokens
}

function estimateMessage(message: { content?: ContentBlock[] } | undefined | null): number {
  return estimateBlocks(message?.content) + ROLE_OVERHEAD
}

function estimateSystem(text: unknown): number {
  if (typeof text !== 'string' || text.length === 0) return 0
  return Math.ceil(text.length / CHARS_PER_TOKEN) + ROLE_OVERHEAD
}

function estimateToolSchema(tool: unknown): number {
  return Math.ceil(JSON.stringify(tool).length / CHARS_PER_TOKEN) + BLOCK_OVERHEAD
}

// ---- content extraction -----------------------------------------------------

function firstText(blocks: ContentBlock[] | undefined): string {
  if (!Array.isArray(blocks)) return ''
  for (const b of blocks) {
    if (b && b.type === 'text' && typeof b.text === 'string' && b.text.trim() !== '') {
      return b.text.replace(/\s+/g, ' ').trim().slice(0, 80)
    }
  }
  return ''
}

function toolCallNames(blocks: ContentBlock[] | undefined): string[] {
  const names: string[] = []
  if (!Array.isArray(blocks)) return names
  for (const b of blocks) {
    if (b && b.type === 'tool-call' && typeof b.name === 'string') names.push(b.name)
  }
  return names
}

interface MessageSource {
  kind?: string
  form?: string
  name?: string
  plugin?: string
  summary?: string
  sections?: { name?: string }[]
}

function isInjection(source: MessageSource | undefined): source is MessageSource {
  // plugin context (AGENTS.md, snapshots, notices, …) and user-explicit skill
  // invocations both ride user-role messages with a declared form.
  return source !== null && typeof source === 'object'
    && (source.kind === 'plugin' || source.kind === 'skill-invocation' || typeof source.form === 'string')
}

// ---- the incremental fold -----------------------------------------------------

function createFold(): FoldState {
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
  const node: SurfaceNode = { seq: ev.seq, time: ev.time, cat, tokens: estimateMessage(message) }
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

  const op = ev.surfaceOp as { op?: string; start?: number; end?: number } | null | undefined
  if (op !== null && typeof op === 'object' && op.op === 'replace') {
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

function foldInto(st: FoldState, events: readonly SessionEvent[]): void {
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
        st.toolsTokens = st.toolList.reduce((a, t) => a + t.tokens, 0)
        if (tools.length > 0) st.toolsTokens += BLOCK_OVERHEAD
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
      case 'tool/result':
        applySurface(st, ev, ev.type, data, data as unknown as MessageLike)
        break
      case 'assistant/message': {
        // Snapshot the request exactly as dispatched: current surface + header,
        // before this response joins the surface.
        const usage = data?.usage as { inputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number; outputTokens?: number } | undefined
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
        applySurface(st, ev, ev.type, data, data as unknown as MessageLike)
        break
      }
      case 'compaction/summary':
        st.events.push({
          seq: ev.seq, time: ev.time, kind: 'compaction',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          count: data && Array.isArray(data.shadowedSeqs) ? data.shadowedSeqs.length : 0,
        })
        break
      case 'compaction/prune':
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
  // Keep a deep-enough history for both display granularities: turn mode
  // collapses steps, so these bounds must cover many turns, not just steps.
  if (st.requests.length > 500) st.requests = st.requests.slice(-500)
  if (st.events.length > 400) st.events = st.events.slice(-400)
}

function buildResult(st: FoldState): Snapshot {
  const surfaceTotal = st.sums.user + st.sums.inject + st.sums.assistant + st.sums.tool
  const result: Snapshot = {
    ok: true,
    model: st.model,
    provider: st.provider,
    contextWindow: st.contextWindow,
    current: {
      system: st.systemTokens,
      tools: st.toolsTokens,
      user: st.sums.user,
      inject: st.sums.inject,
      assistant: st.sums.assistant,
      tool: st.sums.tool,
      total: surfaceTotal + st.systemTokens + st.toolsTokens,
    },
    toolList: st.toolList,
    requests: st.requests,
    events: st.events,
    nodes: [],
    droppedNodes: 0,
  }
  // Bound the payload: the newest surface nodes carry the most signal.
  const MAX_NODES = 200
  result.droppedNodes = Math.max(0, st.surface.length - MAX_NODES)
  result.nodes = st.surface.slice(-MAX_NODES)
  return result
}

// ---- RPC endpoint: /dsh-context snapshot -------------------------------------
//
// The generic Connection RPC channel replaces the dynamic-runner
// `harness.handle` seat: installed packages register a channel on the host
// half and call it from the browser half through `ctx.connection.rpc.call`.
// Responses use the harness RpcResult envelope ({ok:true,value} | {ok:false,error}).

interface SessionState {
  fold: FoldState
  count: number
  result: Snapshot | null
}

async function computeSnapshot(ctx: Context, states: Map<string, SessionState>, sessionId: string): Promise<Snapshot> {
  let st = states.get(sessionId)
  if (st === undefined) {
    st = { fold: createFold(), count: -1, result: null }
    states.set(sessionId, st)
  }

  // Resolve the log sources lazily per call: `sessions` / `sessionQuery` may
  // be provided after this plugin applies, and a replaced service must not
  // leave us holding a stale instance.
  const sessions = ctx.get('sessions')
  const sessionQuery = ctx.get('sessionQuery')

  // Live sessions fold from the in-memory log — no clone, no disk parse.
  const live = sessions !== undefined ? sessions.get(sessionId) : undefined
  let events: readonly SessionEvent[]
  if (live !== undefined) {
    events = live.events
  } else {
    if (sessionQuery === undefined) throw new Error('session is not live and sessionQuery is unavailable')
    if (st.result !== null && st.count >= 0) {
      // Cold logs never grow: probe the lightweight record count only.
      const records = await sessionQuery.listEvents(sessionId)
      if (records.length === st.count) return st.result
    }
    const snapshot = await sessionQuery.readSession(sessionId)
    events = snapshot && Array.isArray(snapshot.events) ? snapshot.events : []
  }

  if (events.length === st.count && st.result !== null) return st.result
  if (events.length < st.fold.n) st.fold = createFold() // defensive: log replaced
  foldInto(st.fold, events)
  st.count = events.length
  st.result = buildResult(st.fold)
  return st.result
}

export function apply(ctx: Context): void {
  // sessionId -> { fold state + last built result + the count it reflects }.
  const states = new Map<string, SessionState>()

  ctx.effect(() => {
    return ctx.connection.rpc.handle(
      '/dsh-context',
      async (endpoint: string, payload: unknown): Promise<RpcResult<Snapshot>> => {
        try {
          if (endpoint !== 'snapshot') {
            return { ok: false, error: { code: 'internal', message: `unknown endpoint: ${endpoint}`, details: {} } }
          }
          const sessionId = payload !== null && typeof payload === 'object'
            ? (payload as { sessionId?: unknown }).sessionId
            : undefined
          if (typeof sessionId !== 'string' || sessionId === '') {
            return { ok: false, error: { code: 'internal', message: 'missing sessionId', details: {} } }
          }
          const value = await computeSnapshot(ctx, states, sessionId)
          return { ok: true, value }
        } catch (err) {
          return {
            ok: false,
            error: {
              code: 'internal',
              message: err instanceof Error ? err.message : String(err),
              details: {},
            },
          }
        }
      },
      { authority: 'trusted-host' },
    )
  }, 'dsh-context: rpc channel')
}
