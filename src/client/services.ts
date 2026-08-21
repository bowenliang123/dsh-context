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
import type { ContextHeaders, ContextPressure, ContextTimeline, SessionCostUsage, TokenUsage } from '../shared/types'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  subscribe(fn: () => void): () => void
  /** The current immutable locale snapshot (harness locale runtime). */
  getLocale?(): { active: string }
}

export interface SlotRegistration {
  name: string
  id: string
  order: number
  /** optional dictionary namespace; the framework then synthesizes the `t` seat. */
  locale?: string
  label?: () => string
  /** optional business face factory; a `hooks` compartment binds selector hooks onto props. */
  inject?: (sessionId: string) => unknown
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string }) => unknown,
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

/** The conversation-snapshot selector hook, minimally typed for this plugin. */
export type UseSessionLike = <T>(
  selector: (snapshot: {
    nodes?: readonly ConversationNodeLike[]
    /** whether older history remains outside the loaded window */
    hasMore?: boolean
    /** whether an older-history page is currently being pulled */
    loadingOlder?: boolean
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
  /**
   * History-pagination verb this plugin contributes through the harness's
   * `sessions.provide` channel (one call prepends one older page to the
   * conversation window). Absent on older hosts without the channel — the
   * Context browser then keeps its preview-plus-hint degradation.
   */
  loadOlderHistory?: () => Promise<void>
}

/** The client context: cordis plus the services this plugin injects. */
export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

/** Narrow an unknown projection value to a record, or null when it is not one. */
function asRecord<T>(value: unknown): T | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as T
}

/**
 * Safe finite-number read: a missing/non-numeric/NaN field degrades to 0
 * instead of leaking into the UI as NaN percentages or broken arithmetic.
 */
export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** The usable (non-null object) entries of a delivered list; [] when the field is not a list. */
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
  const data = asRecord<ContextTimeline>(value)
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
    // Well-formed: pass the delivered value through untouched (cheap, and
    // reference-stable so plain re-renders stay zero-copy).
    return data
  }
  // Malformed: rebuild with safe defaults, keeping every usable piece.
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current : {}
  const cost = typeof data.cost === 'object' && data.cost !== null && !Array.isArray(data.cost)
    ? data.cost as SessionCostUsage
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
export const contextPressureOf = (value: unknown): ContextPressure | null => asRecord<ContextPressure>(value)

/**
 * Narrow a delivered projection value to the official token-meter
 * `tokenUsage` projection (durable cumulative provider usage). Absent key or
 * value = the meter's projection is not composed (or no request has reported
 * usage yet) — callers drop the cache-hit cell to a dash.
 */
export const tokenUsageOf = (value: unknown): TokenUsage | null => asRecord<TokenUsage>(value)

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
  const headers = asRecord<ContextHeaders>(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const h of headers.headers) {
    if (h === null || typeof h !== 'object') return null
    const entry = h as { tools?: unknown; system?: unknown }
    if (!Array.isArray(entry.tools)) return null
    if (entry.system !== undefined && typeof entry.system !== 'string') return null
  }
  return headers
}

// ---- /context command faces (framework `inputTriggers` service) ----

/** One menu candidate offered by a trigger source. */
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

/** Everything a source receives on a menu pick. */
export interface TriggerPick {
  candidate: TriggerCandidate
  session: { sessionId: string }
  position: string
  via: string
  span: TokenSpan
}

/** The pick outcomes this plugin produces (see the framework's PickOutcome). */
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

/**
 * One standard-props contribution to the harness's `sessions.provide`
 * channel: declared members are resolved per session and delivered to every
 * session-scope slot component (hooks become `use<Name>` selector hooks,
 * props spread verbatim). Minimally typed against the runtime contract.
 */
export interface SessionProvideDescriptorLike {
  hooks?: readonly string[]
  props?: readonly string[]
  resolve(binding: { session: { loadOlder(): Promise<void> } }): {
    hooks?: Record<string, unknown>
    props?: Record<string, unknown>
  }
}

/** The session runtime (`ctx.sessions`), as consumed here. */
export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
  /**
   * The standard-props provide channel (absent on older hosts). Throws on a
   * misdeclared or duplicate contribution — callers fail soft.
   */
  provide?(descriptor: SessionProvideDescriptorLike): () => void
}
