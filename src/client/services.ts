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
import type { ContextHeaders, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'

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

/** Narrow a delivered projection value to the context timeline. */
export const timelineOf = (value: unknown): ContextTimeline | null => asRecord<ContextTimeline>(value)

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
 */
export function headersOf(value: unknown): ContextHeaders | null {
  const headers = asRecord<ContextHeaders>(value)
  return headers !== null && Array.isArray(headers.headers) ? headers : null
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
