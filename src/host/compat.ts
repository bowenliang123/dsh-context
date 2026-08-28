/**
 * Session-projection unit contract compatibility layer.
 *
 * The harness's session-projection registry changed its unit contract between
 * dsh 0.1.0-rc.8 and 0.1.1-rc.1:
 *   - dsh <= 0.1.0-rc.8: `{ key, schema, init, apply, view, stateVersion }`
 *     (one `schema` validates the wire payload; `view` is top-level).
 *   - dsh >= 0.1.1-rc.1: `{ key, stateSchema, init, apply, wire?, stateVersion }`
 *     (`stateSchema` validates the PERSISTED fold state; a client-visible
 *     unit carries a `wire` block with `viewSchema` + `view`; a unit WITHOUT
 *     `wire` is host-only — its value is never delivered to clients).
 *
 * dsh 0.1.2-alpha.1 widens `init` to `init(header: SessionHeader)` — the
 * registry now hands the session's immutable header to a fresh fold. A
 * zero-argument `init` satisfies that contract as-is (extra arguments are
 * simply not observed), so the dual-shape object below installs unchanged on
 * every supported registry.
 *
 * A definition that carries BOTH shapes on one object is accepted by every
 * registry: each version reads the fields it knows and ignores the extras.
 * That is what this plugin emits — the same fold state and the same wire
 * view, declared twice under the two contracts.
 *
 * The installed devDependency types still pin the pre-0.1.1 contract, so the
 * current (0.1.1-rc.1+) shape is mirrored here as {@link
 * ProjectionDefinitionV2} to keep both halves compile-checked.
 */

import type { z } from 'zod'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session-projection unit contract as of dsh 0.1.1-rc.1 (local mirror). */
export interface ProjectionDefinitionV2<K extends keyof SessionProjectionMap, S> {
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

/** The session-projection unit contract as of dsh <= 0.1.0-rc.8 (local mirror). */
export interface ProjectionDefinitionV1<K extends keyof SessionProjectionMap, S> {
  key: K
  /** Validated the wire payload before it left the host. */
  schema: z.ZodType<SessionProjectionMap[K]>
  init(): S
  apply(state: S, event: SessionEvent): S
  view(state: S): SessionProjectionMap[K]
  stateVersion: number
}

/**
  * One unit definition under BOTH contracts: the pre-0.1.1 fields (`schema`, top-level `view`) plus the 0.1.1-rc.1+ fields (`stateSchema`,
  * `wire`); registries of every dsh version read their own fields off the same object. (The legacy block is mirrored, not `Pick`ed from
  * the installed dts — dsh >= 0.1.1 removed those fields from the published contract.)
 */
export type CompatProjectionDefinition<K extends keyof SessionProjectionMap, S> =
  ProjectionDefinitionV2<K, S> & ProjectionDefinitionV1<K, S>
