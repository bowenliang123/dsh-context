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
import { createToolAttribution } from './attribution'
import { Config } from './config'
import { createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { createContextHeadersDefinition } from './headers'
import { installSettings } from './settings'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

/**
 * Entry config: retention/slice bounds, validated by cordis (Standard Schema).
 * Re-exported as both value (the validator) and type (the interface).
 */
export { Config } from './config'

export function apply(ctx: Context, config: Config): void {
  // The baseline gate: a harness BELOW the supported baseline (detected at
  // apply time — see version.ts) never gets the real folds, since its log
  // shapes and seam faces are outside the compat matrix. Fallback units
  // serve the client zeroed data plus the gate record instead. An
  // UNDETECTABLE version is not a gate: detection failure fails open into
  // the normal composition below.
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    // The dts register() constrains a unit's state to the declared
    // SessionProjectionStateMap entry; the gate's opaque empty state is
    // deliberately neither (nothing is folded) — cast through.
    ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion) as never)
    ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)
    return
  }
  // Tool-to-plugin attribution (see attribution.ts): the static chain from
  // toolSources.ts stays the backbone, the runtime register() hook adds
  // third-party / agent-scoped / dynamic tools on top. Strictly additive — an
  // unsupported cordis or a missed read degrades to the static chain.
  const attribution = createToolAttribution(ctx)
  ctx.sessionProjections.register(createContextTimelineDefinition(config))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  installSettings(ctx)
}

// ---- public type surface (stable for downstream consumers) -------------------

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ContextHeaders, HeaderRecord, HeaderTool } from '../shared/types'
export type { TimelineState } from './fold'
export type { HeadersState } from './headers'
