import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { watchAttachmentChannel } from './attachment'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { watchCommandPageChannel } from './commandPages'
import { Config, resolveBounds } from './config'
import { watchDetailChannel } from './detail'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFleetChannel } from './fleet'
import { createContextHeadersDefinition } from './headers'
import { watchPromptInjection } from './promptInjection'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { watchRecomChannel } from './recoms'
import { watchTimelineRowSweep } from './sweep'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

export { Config } from './config'
export function apply(ctx: Context, config: Config): void {
  const coldReads = makeColdReadGate()
  watchBalanceChannel(ctx)
  watchRecomChannel(ctx)
  watchSkillCatalog(ctx)
  watchFleetChannel(ctx, coldReads)
  watchAttachmentChannel(ctx, coldReads)
  const harnessVersion = detectHarnessVersion(ctx)
  if (harnessVersion !== undefined && !meetsBaseline(harnessVersion)) {
    ctx.sessionProjections.register(createFallbackTimelineDefinition(harnessVersion) as never)
    ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)
    ctx.sessionProjections.register(createFallbackActivityDefinition() as never)
    return
  }
  const attribution = createToolAttribution(ctx)
  watchStepIdentity(ctx)
  const gate = watchDetailChannel(ctx, resolveBounds(config), coldReads)
  watchCommandPageChannel(ctx, resolveBounds(config), coldReads)
  ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  ctx.sessionProjections.register(createContextActivityDefinition())
  watchTimelineRowSweep(ctx)
  watchActivityBackfill(ctx, coldReads)
  watchPromptInjection(ctx, config)
}

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
