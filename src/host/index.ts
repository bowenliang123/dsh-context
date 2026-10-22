/** Host-half package entry: a plain Cordis plugin module loaded as the `dsh-context` loader row. The projection units
 * register on `ctx.sessionProjections` (REQUIRED — Cordis keeps this plugin pending until it exists); the detail
 * channel serves the heavy collections per viewing client, keeping the wire value a slim head. */

import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { watchAttachmentChannel } from './attachment'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { Config, resolveBounds } from './config'
import { watchDetailChannel } from './detail'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFleetChannel } from './fleet'
import { createContextHeadersDefinition } from './headers'
import { watchPromptInjection } from './promptInjection'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { watchTerminal } from './terminal'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

/** Re-exported as both value (the cordis validator) and type (the resolved config shape). */
export { Config } from './config'
export function apply(ctx: Context, config: Config): void {
  // One host-wide cold-read gate: every on-demand log read shares one FIFO admission. Routes MUST arm before the baseline gate's early
  // return below — they work on either side of it.
  const coldReads = makeColdReadGate()
  watchBalanceChannel(ctx)
  watchSkillCatalog(ctx)
  watchFleetChannel(ctx, coldReads)
  watchAttachmentChannel(ctx, coldReads)
  // The terminal half shows the gate record too, so it arms before the early return.
  watchTerminal(ctx, config)
  // Below the baseline: fallback units serve zeroed data plus the gate record, never the real folds; an undetectable version fails open
  // into the normal composition below (docs/compatibility.md §2).
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    // register() constrains state to the declared SessionProjectionStateMap entry; the gate's opaque empty state is deliberately neither
    // (nothing is folded) — cast through.
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
  watchPromptInjection(ctx, config)
}

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
