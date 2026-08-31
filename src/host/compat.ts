/**
 * Session-projection unit contract compatibility layer.
 *
 * Supported harness baselines (see AGENTS.md "Compatibility"): dsh
 * 0.1.1-rc.2+ and 0.1.2-alpha.2+. On both, the session-projection registry
 * drives the SAME unit contract (introduced in dsh 0.1.1-rc.1, replacing the
 * pre-0.1.1 `{ schema, view }` shape this plugin no longer emits):
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
 * dsh 0.1.2-alpha.1 widened `init` to `init(header: SessionHeader)` — the
 * registry now hands the session's immutable header to a fresh fold. A
 * zero-argument `init` satisfies that contract as-is (extra arguments are
 * simply not observed), so one definition installs unchanged on both
 * baselines: the 0.1.1-rc.2 registry calls `init()` and the 0.1.2-alpha.2
 * registry calls `init(header)`.
 *
 * The installed devDependency types pin the newest published surface
 * (0.1.2-alpha.2), whose `wire?` is optional on both supported baselines;
 * this plugin's units are always client-visible, and the registry's
 * wired-register overload demands `wire` PRESENT — which the dts's optional
 * `wire?` fails. The contract is therefore mirrored here as {@link
 * ProjectionDefinition} to keep both halves compile-checked.
 */

import type { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session-projection unit contract served by dsh 0.1.1-rc.2+ and 0.1.2-alpha.2+ (local mirror). */
export interface ProjectionDefinition<K extends keyof SessionProjectionMap, S> {
  key: K
  stateSchema: z.ZodType<S>
  /**
   * Fresh fold state for the empty log. dsh 0.1.2-alpha.1 widened the
   * contract to `init(header: SessionHeader)`; a zero-argument init
   * satisfies every supported registry (extra arguments go unobserved).
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
