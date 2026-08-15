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
import type { ContextTimeline } from '../shared/types'

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
  label: () => string
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
