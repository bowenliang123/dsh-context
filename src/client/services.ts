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
import type { ContextPressure, ContextTimeline } from '../shared/types'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  subscribe(fn: () => void): () => void
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
 * The framework standard kit of a session-scope slot component, as far as
 * this plugin consumes it: the resolve session id and the key-addressed
 * projection reader that delivers the `contextTimeline` value (undefined =
 * the host unit is absent or no value has arrived yet).
 */
export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
}

/** The client context: cordis plus the services this plugin injects. */
export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

/** Narrow a delivered projection value to the context timeline. */
export function timelineOf(value: unknown): ContextTimeline | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as ContextTimeline
}

/**
 * Narrow a delivered projection value to the official token-meter
 * `contextPressure` projection (provider-anchored occupancy of the next
 * request). Absent key or value = the meter's projection is not composed
 * (e.g. a harness without the session-projection registry) — callers fall
 * back to their derived anchor, so the UI degrades gracefully.
 */
export function contextPressureOf(value: unknown): ContextPressure | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as ContextPressure
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

/** The session runtime (`ctx.sessions`), as consumed here. */
export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
}
