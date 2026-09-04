/**
 * Session-projection unit contract compatibility layer.
 *
 * Supported harness baseline (see AGENTS.md "Compatibility"): dsh
 * 0.1.2-rc.1+. On it, the session-projection registry drives the unit
 * contract (introduced in dsh 0.1.1-rc.1, replacing the pre-0.1.1
 * `{ schema, view }` shape): the real projection units emit only the modern
 * shape, while the below-baseline fallback units (fallback.ts) still carry
 * the legacy top-level aliases so the gate serves on any harness that can
 * deliver projections at all.
 *
 *   `{ key, stateSchema, init, apply, wire?, stateVersion }`
 *
 * - `stateSchema` validates the PERSISTED fold state before a checkpoint row
 *   seeds a fold; the state itself must stay plain JSON (the projection
 *   cache's lossless-JSON write precondition).
 * - A client-visible unit carries a `wire` block (`viewSchema` + `view`).
 *   A unit WITHOUT `wire` is host-only — its value is never delivered to
 *   clients, and the Context tab would sit on its loading screen forever.
 *
 * The registry hands the session's immutable header to a fresh fold:
 * `init(header: SessionHeader)`. A zero-argument `init` satisfies that
 * contract as-is (the extra argument is simply not observed).
 *
 * The installed devDependency types pin the newest published surface
 * (0.1.2-rc.1), whose `wire?` is optional; this plugin's units are always
 * client-visible, and the registry's wired-register overload demands `wire`
 * PRESENT — which the dts's optional `wire?` fails. The contract is
 * therefore mirrored here as {@link ProjectionDefinition} to keep both
 * halves compile-checked.
 */

import type { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session-projection unit contract served by dsh 0.1.2-rc.1+ (local mirror). */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K
  stateSchema: z.ZodType<S>
  /**
   * Fresh fold state for the empty log. The registry passes the session's
   * immutable header; a zero-argument init satisfies the contract (the
   * extra argument goes unobserved).
   */
  init(): S
  /**
   * Pure transition: previous state + one committed event → next state.
   * Events the unit ignores MUST return the same state reference.
   */
  apply(state: S, event: SessionEvent): S
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    view(state: S): SessionProjectionMap[K]
  }
  stateVersion: number
}
