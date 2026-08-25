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
import type { ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'

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
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
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
 * The harness conversation client service (`ctx.conversation`), minimally
 * typed for image resolution — the same call the chat view's own message
 * images ride on.
 */
export interface ConversationFace {
  resolveImage(sessionId: string, attachment: ImageRefLike): Promise<string>
}

export type UseSessionLike = <T>(
  selector: (snapshot: {
    nodes?: readonly ConversationNodeLike[]
  }) => T,
) => T

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
    && Array.isArray(data.toolList)) {
    // Well-formed: pass the delivered value through untouched (cheap, and reference-stable so plain re-renders stay zero-copy).
    return data as unknown as ContextTimeline
  }
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current as Record<string, unknown> : {}
  const cost = typeof data.cost === 'object' && data.cost !== null && !Array.isArray(data.cost)
    ? data.cost as ContextTimeline['cost']
    : undefined
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
    toolList: objectsOf(data.toolList),
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
    ...(typeof data.toolCalls === 'number' ? { toolCalls: data.toolCalls } : {}),
    archive: objectsOf(data.archive),
    ...(cost !== undefined ? { cost } : {}),
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
 * Narrow a delivered projection value to the plugin's `contextHeaders`
 * (request-header content epochs). Absent key = an older Host half without
 * the companion unit — the Context browser degrades its system/tools
 * sections to tokens-only with a note.
 *
 * Entry-level shape is checked too: a malformed epoch (corrupt payload with
 * a missing tools list or wrong-typed system prompt) would crash the
 * browser's tools/sections reads, so the WHOLE projection degrades to null
 * and the card falls back to its tokens-only note.
 */
export function headersOf(value: unknown): ContextHeaders | null {
  const headers = asRecord(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const h of headers.headers as unknown[]) {
    if (h === null || typeof h !== 'object') return null
    const entry = h as { tools?: unknown; system?: unknown }
    if (!Array.isArray(entry.tools)) return null
    if (entry.system !== undefined && typeof entry.system !== 'string') return null
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
 * still holds it. Every response field is re-proven at runtime.
 */
export interface SessionsHistoryFace {
  history(request: { sessionId: string; beforeSeq: number }): Promise<{
    result?: { ok?: unknown; value?: { events?: unknown } | null } | null
  }>
}

/** The connection service face, as far as this plugin consumes it. */
export interface ConnectionFace {
  api?: { sessions?: SessionsHistoryFace }
}

/**
 * On-demand full content for one surface-node seq: resolves the joined
 * conversation node, `null` when the durable log does not hold the seq,
 * rejects on transport/RPC failure (the caller distinguishes the three).
 */
export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>
