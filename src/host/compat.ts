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
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SessionProjectionMap } from '@deepseek-ai/dsh-session-projection/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** The session-projection unit contract as of dsh 0.1.1-rc.1 (local mirror). */
export interface ProjectionDefinitionV2<K extends keyof SessionProjectionMap, S> {
  /** The projection key this unit owns (its `SessionProjectionMap` entry). */
  key: K
  /** Validates persisted state before it seeds a fold. */
  stateSchema: z.ZodType<S>
  /** State for the empty log. */
  init(): S
  /**
   * Pure transition: previous state + one committed event → next state.
   * Events the unit ignores MUST return the same state reference.
   */
  apply(state: S, event: SessionEvent): S
  /** Client view: `viewSchema` validates the wire payload before it leaves the host. */
  wire: {
    viewSchema: z.ZodType<SessionProjectionMap[K]>
    /** State → wire payload (the read-side projection). */
    view(state: S): SessionProjectionMap[K]
  }
  /** Persisted-cache invalidation version (same semantics in both contracts). */
  stateVersion: number
}

/**
 * One unit definition under BOTH contracts: the pre-0.1.1 fields (`schema`,
 * top-level `view`) plus the 0.1.1-rc.1+ fields (`stateSchema`, `wire`).
 * Registries of every dsh version read their own fields off the same object.
 */
export type CompatProjectionDefinition<K extends keyof SessionProjectionMap, S> =
  ProjectionDefinitionV2<K, S> & Pick<ProjectionDefinition<K, S>, 'schema' | 'view'>