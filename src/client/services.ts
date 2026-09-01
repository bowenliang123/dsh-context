/**
 * Client-side service contracts — the exact API surface this plugin consumes
 * from the harness web half.
 *
 * The plugin bundles its own code but relies on the reader to deliver the
 * framework standard kit to slot components (`sessionId`, `useSession`,
 * `useProjection`, `t` …); only the small faces below are referenced across
 * modules. These are TYPE-ONLY: the runtime services come from the user's
 * harness. This plugin no longer calls any RPC — data arrives as pushed
 * session projections (`useProjection` standard seat).
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, HeaderEpochContent, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
}

export interface SlotRegistration {
  name: string
  /** List slots dispatch on id + order. */
  id?: string
  order?: number
  /** Keyed slots (e.g. settings.plugin.item) dispatch on the entry key. */
  key?: string
  /** optional dictionary namespace; the framework then synthesizes the `t` seat. */
  locale?: string
  label?: () => string
  /** optional business face factory; a `hooks` compartment binds selector hooks onto props. */
  inject?: (sessionId?: string) => unknown
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  ): unknown
}

/**
 * The conversation node, as far as the Context browser consumes it: the
 * framework's finalized chat nodes carry the source surface event's `seq`
 * plus the full content — the browser joins its surface nodes on `seq` to
 * show actual content without carrying it through the projection.
 */
export interface ConversationNodeLike {
  kind: string
  seq: number
  /**
   * The durable message id (assistant nodes on the harness chat nodes; absent
   * on synthetic/interrupted replies) — the key the chat's assistant-action
   * seat addresses a finalized reply by.
   */
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  /**
   * Nested Code-Mode call tree (dsh's recursive ToolCallBlock[]) on a tool
   * result whose call ran sub-dispatches — a PTC `run_code` program. Consumed
   * structurally only (fileActivity): every block is re-proved at runtime and
   * malformed shapes drop out instead of throwing.
   */
  subCalls?: readonly unknown[]
  /** The tool result's bounded presentation meta (a search's matched files), as the join delivers it. */
  meta?: unknown
}

/**
 * A durable image attachment reference, as far as this plugin consumes it
 * (dsh's `ImageAttachmentRef`, minimally re-typed so the plugin stays free
 * of an attachment-package dependency). The durable log holds only this ref
 * — never inline bytes. Since dsh 0.1.1 the width/height/bytes describe the
 * NORMALIZED raster (long edge 2048px); `originalDimensions` carries the
 * pre-normalization size when normalization reduced the image.
 */
export interface ImageRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

/** Loads a session-authorized display URL for one durable image reference. */
export type ImageLoader = (attachment: ImageRefLike) => Promise<string>

/**
 * The harness conversation client service, minimally typed for image
 * resolution — the same call the chat view's own message images ride on.
 * Renamed across dsh versions: `ctx.conversation.resolveImage` before
 * 0.1.2, `ctx.uiConversation.imageUrl` since. Whichever face is present
 * serves the loader; absence degrades the cards to metadata-only.
 */
export interface ConversationFace {
  resolveImage?(sessionId: string, attachment: ImageRefLike): Promise<string>
}

export interface UiConversationFace {
  imageUrl?(sessionId: string, attachment: ImageRefLike): Promise<string>
}

/**
 * A session-authorized durable-image loader over whichever conversation
 * face the running harness provides (`resolveImage` pre-0.1.2, `imageUrl`
 * since), or undefined when neither service is composed — the caller
 * degrades to metadata-only cards. Hostile snapshots and throwing service
 * reads are caught: this helper can never take a render down.
 */
export function imageLoaderOf(
  ctx: ClientCtx,
  sessionId: string | undefined,
): ImageLoader | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const legacy = ctx.get('conversation') as ConversationFace | undefined
    if (legacy !== undefined && typeof legacy.resolveImage === 'function') {
      const resolveImage = legacy.resolveImage.bind(legacy)
      return attachment => resolveImage(sessionId, attachment)
    }
    const modern = ctx.get('uiConversation') as UiConversationFace | undefined
    if (modern !== undefined && typeof modern.imageUrl === 'function') {
      const imageUrl = modern.imageUrl.bind(modern)
      return attachment => imageUrl(sessionId, attachment)
    }
  } catch { /* absent or hostile service — metadata-only cards */ }
  return undefined
}

export type UseSessionLike = <T>(
  selector: (snapshot: {
    nodes?: readonly ConversationNodeLike[]
  }) => T,
) => T

/**
 * The `useChat` standard seat (dsh 0.1.2+: the finalized chat nodes moved
 * from the session snapshot to a per-view `ChatSnapshot` whose `legacy`
 * slice keeps the plain `ConversationNode[]`). Minimally typed: the selector
 * receives the harness snapshot (untrusted — re-proved outside), and the
 * slice it returns must be reference-stable so the framework's
 * selector-hook equality can gate re-renders.
 */
export type UseChatLike = <T>(selector: (snapshot: unknown) => T) => T

/**
 * The conversation-window nodes this plugin joins on, from whichever seat
 * the running harness provides — `useChat` (`ChatSnapshot.legacy.nodes`) on
 * dsh 0.1.2+, the session snapshot's own `nodes` before that. Returns
 * undefined when neither seat delivers a real array (absent seat, older or
 * foreign harness, hostile snapshot) — callers render without the join,
 * never an error.
 *
 * Hook-order contract: the seats are real React hooks, so BOTH are invoked
 * on every call whenever present (the chat seat first, the session seat
 * second) and only the RESULT is picked conditionally — a stable call order
 * across renders. Selectors return stable slice references so the
 * framework's snapshot equality can gate re-renders.
 */
export function conversationNodesOf(props: {
  useChat?: UseChatLike
  useSession?: UseSessionLike
}): readonly ConversationNodeLike[] | undefined {
  const useChat: unknown = props.useChat
  let chatNodes: unknown
  if (typeof useChat === 'function') {
    try {
      // `s.legacy` is a stable object; the array is read outside the selector.
      const slice = (useChat as UseChatLike)((s: unknown) =>
        s !== null && typeof s === 'object' ? (s as { legacy?: unknown }).legacy : undefined)
      chatNodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    } catch { /* hostile seat — the session snapshot still answers */ }
  }
  const useSession: unknown = props.useSession
  let sessionNodes: unknown
  if (typeof useSession === 'function') {
    try {
      sessionNodes = (useSession as UseSessionLike)(s => s.nodes)
    } catch { /* hostile seat — the join degrades to nothing */ }
  }
  if (Array.isArray(chatNodes)) return chatNodes as readonly ConversationNodeLike[]
  if (Array.isArray(sessionNodes)) return sessionNodes as readonly ConversationNodeLike[]
  return undefined
}

/**
 * The framework standard kit of a session-scope slot component, as far as
 * this plugin consumes it: the resolve session id and the key-addressed
 * projection reader that delivers the `contextTimeline` value (undefined =
 * the host unit is absent or no value has arrived yet).
 */
export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  useSession?: UseSessionLike
  /** The chat-view snapshot seat (dsh 0.1.2+; see {@link UseChatLike}). */
  useChat?: UseChatLike
}

export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

/**
 * Narrow an unknown projection value to a string-keyed record, or null when
 * it is not one. The boundary type is Record<string, unknown> on purpose:
 * every field read below must re-prove itself (the no-white-screen
 * guarantee), so no field may borrow the wire type before its check.
 */
function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

/**
 * Safe finite-number read: a missing/non-numeric/NaN field degrades to 0
 * instead of leaking into the UI as NaN percentages or broken arithmetic.
 */
export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function objectsOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is T => v !== null && typeof v === 'object')
}

/**
 * Narrow a delivered projection value to a RENDER-SAFE context timeline —
 * the client's no-white-screen guarantee against backend/parse failures.
 *
 * A value that is not a record at all (capability absent, nothing delivered
 * yet) stays `null` and callers show the loading screen. A record that fails
 * the wire shape (corrupt checkpoint restore, a failed/older host payload,
 * plugin drift) is SANITIZED instead of rejected: every collection becomes
 * an array, non-object entries are dropped, `current` becomes a numeric
 * breakdown, and wrong-typed scalars are dropped or zeroed — so the whole
 * tab still renders with every usable piece of data instead of throwing
 * during render and unmounting the conversation view.
 */
export function timelineOf(value: unknown): ContextTimeline | null {
  const data = asRecord(value)
  if (data === null) return null
  const current = data.current
  // The wire shape check for the cheap pass-through path: `current` must be
  // a full numeric breakdown (the host always sends all seven fields), and
  // every collection must be a real list. Anything else takes the slow path
  // and is rebuilt into the safe shape below.
  const numericBreakdown = current !== null && typeof current === 'object'
    && ['system', 'tools', 'user', 'inject', 'assistant', 'tool', 'total']
      .every(k => typeof (current as Record<string, unknown>)[k] === 'number')
  if (numericBreakdown
    && Array.isArray(data.requests)
    && Array.isArray(data.events)
    && Array.isArray(data.nodes)
    && Array.isArray(data.archive)
    && timingFastOk(data.timing)) {
    // Well-formed: pass the delivered value through untouched (cheap, and reference-stable so plain re-renders stay zero-copy).
    return data as unknown as ContextTimeline
  }
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current as Record<string, unknown> : {}
  const cost = typeof data.cost === 'object' && data.cost !== null && !Array.isArray(data.cost)
    ? data.cost as ContextTimeline['cost']
    : undefined
  const timing = timingOf(data.timing)
  return {
    ok: true,
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(typeof data.contextWindow === 'number' ? { contextWindow: data.contextWindow } : {}),
    current: {
      system: numOf(safeCurrent.system),
      tools: numOf(safeCurrent.tools),
      user: numOf(safeCurrent.user),
      inject: numOf(safeCurrent.inject),
      assistant: numOf(safeCurrent.assistant),
      tool: numOf(safeCurrent.tool),
      total: numOf(safeCurrent.total),
    },
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
    ...(typeof data.toolCalls === 'number' ? { toolCalls: data.toolCalls } : {}),
    archive: objectsOf(data.archive),
    ...(cost !== undefined ? { cost } : {}),
    ...(timing !== null ? { timing } : {}),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
  }
}

/**
 * Narrow a delivered projection value to the official token-meter
 * `contextPressure` projection (provider-anchored occupancy of the next
 * request). Absent key or value = the meter's projection is not composed
 * (e.g. a harness without the session-projection registry) — callers fall
 * back to their derived anchor, so the UI degrades gracefully.
 */
export function contextPressureOf(value: unknown): ContextPressure | null {
  const data: unknown = asRecord(value)
  return data as ContextPressure | null
}

/**
 * Narrow a delivered projection value to the official token-meter
 * `contextBreakdown` projection (the heuristic composition rows of the chat
 * ring's panel). Every figure must be a finite number — a partial/corrupt
 * value degrades to null so the composition card falls back to the fold's
 * own sums instead of mixing sources.
 */
export function contextBreakdownOf(value: unknown): ContextBreakdown | null {
  const data = asRecord(value)
  if (data === null) return null
  const { systemTokens, toolsTokens, messageTokens } = data
  if (typeof systemTokens !== 'number' || !Number.isFinite(systemTokens)) return null
  if (typeof toolsTokens !== 'number' || !Number.isFinite(toolsTokens)) return null
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens)) return null
  return { systemTokens, toolsTokens, messageTokens }
}

/**
 * Narrow a delivered projection value to the official token-meter
 * `tokenUsage` projection (durable cumulative provider usage). Absent key or
 * value = the meter's projection is not composed (or no request has reported
 * usage yet) — callers drop the cache-hit cell to a dash.
 */
export function tokenUsageOf(value: unknown): TokenUsage | null {
  const data: unknown = asRecord(value)
  return data as TokenUsage | null
}

/**
 * A non-negative finite number (the timing totals' every field): NaN or a
 * negative degrades to 0 instead of leaking into donut shares.
 */
function msNumOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * Cheap whole-value check for the pass-through path of `timelineOf`: absent
 * timing passes; present timing must already be well-formed (every scalar
 * numeric, every per-name row shaped) — anything else sends the payload down
 * the sanitizing slow path.
 */
function timingFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  for (const k of ['wallMs', 'lmMs', 'calls', 'toolsMs', 'toolCalls']) {
    if (typeof t[k] !== 'number') return false
  }
  const tools = t.tools
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) return false
  for (const k in tools) {
    const row = (tools as Record<string, unknown>)[k]
    if (row === null || typeof row !== 'object') return false
    if (typeof (row as Record<string, unknown>).calls !== 'number') return false
    if (typeof (row as Record<string, unknown>).ms !== 'number') return false
  }
  return true
}

/**
 * Narrow a delivered timing totals value (see TimingTotals) to a RENDER-SAFE
 * shape — the timing card's no-white-screen guarantee. A value that is not a
 * record stays null (the card renders its empty state); wrong-typed scalars
 * zero out and per-name rows failing the shape drop individually, so one
 * hostile row never blanks the ranking.
 */
export function timingOf(value: unknown): TimingTotals | null {
  const data = asRecord(value)
  if (data === null) return null
  const tools: Record<string, ToolTimingTotals> = {}
  const rawTools = data.tools
  if (rawTools !== null && typeof rawTools === 'object' && !Array.isArray(rawTools)) {
    for (const k in rawTools) {
      // A JSON-delivered record can carry an own '__proto__' key; assigning it
      // would set the prototype instead of a row — skip it.
      if (k === '__proto__' || !Object.hasOwn(rawTools, k)) continue
      const row = (rawTools as Record<string, unknown>)[k]
      if (row === null || typeof row !== 'object') continue
      const calls = (row as Record<string, unknown>).calls
      const ms = (row as Record<string, unknown>).ms
      if (typeof calls !== 'number' || !(calls >= 0) || typeof ms !== 'number' || !(ms >= 0)) continue
      tools[k] = { calls, ms }
    }
  }
  return {
    wallMs: msNumOf(data.wallMs),
    lmMs: msNumOf(data.lmMs),
    calls: msNumOf(data.calls),
    toolsMs: msNumOf(data.toolsMs),
    toolCalls: msNumOf(data.toolCalls),
    tools,
  }
}

/**
 * Narrow a delivered projection value to the plugin's `contextHeaders`
 * (request-header epoch METADATA — boundaries, token prices, attribution).
 * Absent key = an older Host half without the companion unit — the Context
 * browser degrades its system/tools sections to a metadata-only note.
 *
 * Entry-level shape is checked too: a malformed epoch (corrupt payload with
 * a missing tools list or wrong-typed systemTokens) would crash the
 * browser's tools/sections reads, so the WHOLE projection degrades to null
 * and the card falls back to its metadata-only note. The epoch CONTENT is
 * not part of this value — the browser fetches it per epoch on demand.
 */
export function headersOf(value: unknown): ContextHeaders | null {
  const headers = asRecord(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const h of headers.headers as unknown[]) {
    if (h === null || typeof h !== 'object') return null
    const entry = h as { tools?: unknown; systemTokens?: unknown }
    if (!Array.isArray(entry.tools)) return null
    if (entry.systemTokens !== undefined && (typeof entry.systemTokens !== 'number' || !Number.isFinite(entry.systemTokens))) return null
  }
  return headers as unknown as ContextHeaders
}

export interface TriggerCandidate {
  name: string
  description?: string
}

/** Pick-moment snapshot of the trigger token span (draftRev CAS). */
export interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

export interface TriggerPick {
  candidate: TriggerCandidate
  session: { sessionId: string }
  position: string
  via: string
  span: TokenSpan
}

export type SourcePickOutcome = 'handled' | undefined

/**
 * The harness input-trigger service (`ctx.inputTriggers`), as far as this
 * plugin consumes it: registering one '/' source whose candidates, picks,
 * and enter adjudication all stay on the client.
 */
export interface InputTriggersFace {
  registerSource(src: {
    trigger: '/'
    name: string
    order?: number
    candidates(
      session: { sessionId: string },
      req: { query: string; position: string; signal: AbortSignal },
    ): Promise<readonly TriggerCandidate[]>
    onPick(pick: TriggerPick): SourcePickOutcome
    matchEnter?(
      session: { sessionId: string },
      line: string,
      signal: AbortSignal,
    ): Promise<SourcePickOutcome>
  }): () => void
}

/** The session scope (`ctx.sessions.scope`), used to dispatch the scoped consume-token event. */
export interface SessionScopeFace {
  bail(subject: unknown, event: string, payload: unknown): unknown
}

export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
}

/**
 * One raw durable-log event as the history RPC serves it (the wire envelope
 * the Host fold consumes, minimally re-typed): every field re-proved by the
 * mapper before use (the no-white-screen guarantee).
 */
export interface HistoryEventLike {
  type?: unknown
  seq?: unknown
  data?: unknown
}

/** One history page row: the raw event plus the optional host-computed view. */
export interface HistoryEntryLike {
  event?: unknown
}

/**
 * The sessions domain of the shared api client (`connection.api.sessions`),
 * narrowed to the one verb the targeted content fetch rides on: a
 * seq-anchored history page whose boundaries align to whole append-origin
 * messages, so `beforeSeq: seq + 1` always covers that seq when the log
 * still holds it. This is the dsh <= 0.1.1 face — the RPC was rewritten in
 * 0.1.2 into `remote.session.page` (see {@link SessionPageFace}). Every
 * response field is re-proven at runtime.
 */
export interface SessionsHistoryFace {
  history(request: { sessionId: string; beforeSeq: number }): Promise<{
    result?: { ok?: unknown; value?: { events?: unknown; records?: unknown } | null } | null
  }>
}

/**
 * The seq-anchored history page verb of the dsh 0.1.2+ gateway remotes: the
 * session namespace mounts as a traced cordis service literally named
 * `remote.session`, so `ctx.get('remote.session')` reaches it without an
 * inject declaration (undefined on harnesses that never mount it — the
 * 0.1.1 remotes carry no session namespace). `throughSeq` is the inclusive
 * log cut (a seq that must exist in the log), `beforeSeq` the exclusive
 * upper bound, and the response wraps the rows in a `ClientResult`-style
 * envelope. Rows are `SessionHistoryRecord`s — `{type:'event', event}`
 * entries plus packed `{type:'chunks', …}` runs the mapper skips (every
 * event the fold needs — user/assistant messages, tool calls/results,
 * compaction summaries — is always served verbatim; only streaming deltas
 * pack).
 */
export interface SessionPageFace {
  page(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}

/** The connection service face, as far as this plugin consumes it. */
export interface ConnectionFace {
  api?: {
    sessions?: SessionsHistoryFace
    host?: { openPath?(request: { path: string }): Promise<unknown> }
  }
  /** Observable host description (dsh's HostDescriptionSource); `canOpenPath` gates the open affordance. */
  hostDescription?: { getSnapshot(): unknown }
}

/**
 * The SESSION's workspace root — the `cwd` its session-list row carries (the
 * host session canon, not the host process's own launch directory) — or
 * undefined when the face is absent, the snapshot is malformed, or the row
 * names no cwd. Every field is re-proved — the no-white-screen guarantee.
 */
export function workspaceOf(ctx: ClientCtx, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  // The snapshot and its rows are host data — a hostile object may throw on
  // the call or on property access, and the card must never blank over it.
  try {
    const sessions = ctx.get('sessions') as { list?: { getSnapshot(): unknown } } | undefined
    const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    const byId = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
    const row: unknown = byId !== null && typeof byId === 'object' ? (byId as Record<string, unknown>)[sessionId] : undefined
    const cwd = row !== null && typeof row === 'object' ? (row as { cwd?: unknown }).cwd : undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

/** Whether this deployment can hand a path to the user's native desktop (the
 * host description's `canOpenPath`); false when unknown. */
export function canOpenPathsOf(ctx: ClientCtx): boolean {
  try {
    const source = (ctx.get('connection') as ConnectionFace | undefined)?.hostDescription
    const snapshot = typeof source?.getSnapshot === 'function' ? source.getSnapshot() : undefined
    const can = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { canOpenPath?: unknown }).canOpenPath : undefined
    return can === true
  } catch {
    return false
  }
}

/**
 * The system path opener, or undefined when the deployment lacks the RPC.
 * Fire-and-forget: rejections (unknown path, no desktop) swallow — the
 * affordance is best-effort by nature.
 */
export function openPathVia(ctx: ClientCtx): ((path: string) => void) | undefined {
  const host = (ctx.get('connection') as ConnectionFace | undefined)?.api?.host
  if (host === undefined || typeof host.openPath !== 'function') return undefined
  // Bound up front: an implementation relying on `this` survives the hand-off.
  const openPath = host.openPath.bind(host)
  return (path: string): void => {
    try {
      void openPath({ path }).catch(() => { /* the open is best-effort; a failure stays silent */ })
    } catch { /* same contract, for a synchronously throwing transport */ }
  }
}

/**
 * On-demand full content for one surface-node seq: resolves the joined
 * conversation node, `null` when the durable log does not hold the seq,
 * rejects on transport/RPC failure (the caller distinguishes the three).
 */
export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>

/**
 * On-demand CONTENT for one `contextHeaders` epoch seq: the fetched system
 * prompt and tool schemas (see historyPage.ts), `null` when the durable log
 * does not hold the epoch, rejects on transport/RPC failure (the caller
 * distinguishes the three).
 */
export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>
