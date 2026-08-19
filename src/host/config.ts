/**
 * dsh-context host configuration — the `config:` block of the `dsh-context`
 * loader row in cordis.yml.
 *
 * Cordis validates the entry config against this exported `Config` schema
 * (any Standard Schema v1 validator — zod is ours) before `apply` runs, fills
 * per-field defaults, and fails the load loudly on invalid or unknown keys
 * (`.strict()`). The official plugin-config principle this answers: "anything
 * that two deployments may want to set differently is a configuration field".
 *
 * The persisted projection state shape is independent of these bounds — they
 * only tune the fold's retention / presentation slice, so changing them never
 * requires a projection `stateVersion` bump.
 */

import { z } from 'zod'

/** dsh-context host config. All fields optional; defaults below. */
export interface Config {
  /** Cap on kept per-step request records (the hard step backstop). */
  maxRequestSteps?: number
  /** Newest whole-turn window kept; trimming crosses whole turns, never mid-turn. */
  maxKeptTurns?: number
  /** Newest context-event records kept. */
  maxEvents?: number
  /**
   * Surface nodes served to the browser (newest carry the signal; live
   * inject nodes are always served — they are few and land first). The
   * default is deliberately generous: auto-compaction keeps the live
   * surface far below it in healthy sessions, so the browser effectively
   * lists EVERY live node; the bound stays as a backstop for pathological
   * sessions (every projection push ships the whole value, ~150B per node).
   */
  maxNodes?: number
  /** Removed (shadowed) surface nodes kept for per-step reconstruction. */
  maxArchiveNodes?: number
}

/** Defaults — the exact bounds the fold used before they became configurable. */
export const DEFAULT_BOUNDS: Required<Config> = {
  maxRequestSteps: 1500,
  maxKeptTurns: 300,
  maxEvents: 400,
  maxNodes: 2000,
  maxArchiveNodes: 400,
}

/**
 * The cordis `Config` validator: strict on keys, defaults on the schema fields.
 * Tolerates `undefined` (a patch row without a `config:` block — defaults win).
 */
export const Config = z.preprocess(
  (v) => v ?? {},
  z.object({
    maxRequestSteps: z.number().int().min(1).default(DEFAULT_BOUNDS.maxRequestSteps),
    maxKeptTurns: z.number().int().min(1).default(DEFAULT_BOUNDS.maxKeptTurns),
    maxEvents: z.number().int().min(1).default(DEFAULT_BOUNDS.maxEvents),
    maxNodes: z.number().int().min(1).default(DEFAULT_BOUNDS.maxNodes),
    maxArchiveNodes: z.number().int().min(1).default(DEFAULT_BOUNDS.maxArchiveNodes),
  }).strict()
)

/** The resolved retention/slice bounds the fold operates under. */
export type FoldBounds = Required<Config>

/** Validate (and default) the entry config into concrete fold bounds. */
export function resolveBounds(config: Config | undefined): FoldBounds {
  return Config.parse(config ?? {})
}
