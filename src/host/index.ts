import type { Context } from '@deepseek-ai/cordis'
import { createContextActivityDefinition } from './activity'
import { createCatalogService } from './catalog'
import { watchVersionChannel } from './versionRoute'
import { createCostSource } from './cost'
import { watchAttachmentChannel } from './attachment'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { watchActivityBackfill } from './backfill'
import { makeColdReadGate } from './coldRead'
import { watchCommandPageChannel } from './commandPages'
import { Config, resolveBounds } from './config'
import { watchDetailChannel, createDetailGate, type DetailChannelGate } from './detail'
import { watchDeltaChannel } from './delta'
import { DetailShadow } from './detailShadow'
import { observeOf } from './postRoute'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFactsChannel } from './facts'
import { watchHeadsChannel } from './headsRoute'
import { watchFleetChannel } from './fleet'
import { createContextHeadersDefinition } from './headers'
import { watchOverviewRoute } from './overview'
import { watchPromptInjection } from './promptInjection'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { watchRecomChannel } from './recoms'
import { watchSnapshotRoute } from './snapshotRoute'
import { watchTimelineRowSweep } from './sweep'
import { createContextTimelineDefinition } from './timeline'
import { detectHarnessVersion } from './version'
import { meetsBaseline } from '../shared/version'
import { createOverviewCache } from './overviewCache'
import { startFoldWorkerChannel } from './foldWorker'

export const name = 'dsh-context'

export const inject = ['sessionProjections']

export { Config } from './config'
export function apply(ctx: Context, config: Config): void {
  const coldReads = makeColdReadGate()
  const catalog = createCatalogService()
  const pricing = createCostSource(catalog)
  ctx.effect(() => () => { catalog.dispose() }, 'dsh-context: catalog cache')
  watchVersionChannel(ctx, catalog)
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
  const attribution = createToolAttribution(ctx, harnessVersion)
  watchStepIdentity(ctx)
  const gate = createDetailGate(ctx)
  const bounds = resolveBounds(config)
  const shadow = new DetailShadow(ctx, bounds, coldReads, () => observeOf(ctx))
  watchDetailChannel(ctx, bounds, coldReads, gate, shadow, pricing)
  const deltaGate: DetailChannelGate = { ...gate, live: false }
  watchDeltaChannel(ctx, bounds, coldReads, deltaGate, shadow, attribution.ownerOf.bind(attribution))
  watchFactsChannel(ctx, bounds, { gates: gate, coldReads, detailState: id => shadow.stateOf(id), cost: pricing })
  watchCommandPageChannel(ctx, resolveBounds(config), coldReads)
  watchHeadsChannel(ctx, { bounds, coldReads, cost: pricing })
  gate.retain('contextTimeline', ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live, pricing)))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  ctx.sessionProjections.register(createContextActivityDefinition())
  watchTimelineRowSweep(ctx)
  const cache = createOverviewCache()
  const backfill = watchActivityBackfill(ctx, coldReads, undefined, { ownCache: cache, config })
  watchSnapshotRoute(ctx, backfill)
  watchOverviewRoute(ctx, pricing, backfill, { cache })
  watchPromptInjection(ctx, config)
}

export { startFoldWorkerChannel }

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
