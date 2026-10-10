/**
 * dsh-context — Host half (installed package entry).
 *
 * A plain Cordis plugin module (ESM) loaded by the harness as the `dsh-context` loader row.
 * The projection units (`timeline.ts`, `headers.ts`, `activity.ts`) register on
 * `ctx.sessionProjections`, fold the durable event log, and let the harness stream the finished
 * values to the browser; the one exception is the on-demand detail channel (detail.ts), which
 * serves the heavy collections per VIEWING client so the wire value stays a slim head.
 *
 * The session-projection registry is required: Cordis keeps this plugin PENDING until it
 * exists, and each registration is an effect whose disposer rides the calling fiber.
 */

import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { Config, resolveBounds } from './config'
import { watchDetailChannel } from './detail'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFleetChannel } from './fleet'
import { createContextHeadersDefinition } from './headers'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

/** Re-exported as both value (the cordis validator) and type (the resolved config shape). */
export { Config } from './config'

export function apply(ctx: Context, config: Config): void {
  // The host-wide cold-read gate (issue #121): every on-demand log read — detail, fleet, the
  // warm-up — shares one FIFO admission, so a viewing client can never stack decoded logs.
  // Routes read only runtime-proved faces and work on either side of the baseline gate, so they
  // MUST arm before the gate's early return below.
  const coldReads = makeColdReadGate()
  watchBalanceChannel(ctx)
  watchSkillCatalog(ctx)
  watchFleetChannel(ctx, coldReads)
  // A harness BELOW the baseline never gets the real folds (its log shapes and seam faces are
  // outside the compat matrix); fallback units serve zeroed data plus the gate record. An
  // undetectable version fails open into the normal composition below.
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    // register() constrains state to the declared SessionProjectionStateMap entry; the gate's
    // opaque empty state is deliberately neither (nothing is folded) — cast through.
    ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion) as never)
    ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)
    ctx.sessionProjections.register(createFallbackActivityDefinition() as never)
    return
  }
  // Additive over toolSources.ts's static chain; an unsupported cordis or a missed read degrades to it.
  const attribution = createToolAttribution(ctx)
  watchStepIdentity(ctx)
  // The unit's view reads the gate per serve: slim wire while the detail channel is live, inline otherwise.
  const gate = watchDetailChannel(ctx, resolveBounds(config), coldReads)
  ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  ctx.sessionProjections.register(createContextActivityDefinition())
  watchActivityBackfill(ctx, coldReads)
}

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
