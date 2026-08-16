/**
 * dsh-context — Host half (installed package entry).
 *
 * A plain Cordis plugin module (ESM) loaded by the harness as the
 * `dsh-context` loader row. Since v0.9 the Host half is a single *projection
 * unit* (`timeline.ts`): registered on `ctx.sessionProjections`, it folds a
 * session's durable event log into the per-request context-composition
 * timeline and lets the harness stream the finished value to the browser
 * through its push pipeline. There is no custom RPC channel anymore.
 *
 * Required service: the session-projection registry (the framework drives
 * the unit over `session/event` and persists its state via the projection
 * cache). The module-level `inject` is the one gate: Cordis keeps this
 * plugin PENDING until the registry exists, re-runs it when a provider is
 * replaced, and an absent registry leaves the plugin inert (safe). The
 * registration itself is an effect whose disposer rides the calling fiber —
 * an unloaded plugin's key disappears from drives and snapshots.
 */

import type { Context } from '@deepseek-ai/cordis'
import { Config } from './config'
import { createContextTimelineDefinition } from './timeline'

export const name = 'dsh-context'

/** Required services: the session-projection registry that drives the unit. */
export const inject = ['sessionProjections']

/**
 * Entry config: retention/slice bounds, validated by cordis (Standard Schema).
 * Re-exported as both value (the validator) and type (the interface).
 */
export { Config } from './config'

export function apply(ctx: Context, config: Config): void {
  ctx.sessionProjections.register(createContextTimelineDefinition(config))
}

// ---- public type surface (stable for downstream consumers) -------------------

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { TimelineState } from './fold'
