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
import { Config, historyBounds, resolveBounds } from './config'
import { watchDetailChannel, createDetailGate, type DetailChannelGate } from './detail'
import { watchDeltaChannel } from './delta'
import { DetailShadow } from './detailShadow'
import type { TimelineState } from './foldState'
import { observeOf } from './postRoute'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from './fallback'
import { watchFactsChannel } from './facts'
import { watchHistoryChannel } from './history'
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

const OVERVIEW_WARM_DELAY_MS = 100

export const inject = ['sessionProjections']

export { Config } from './config'
export function apply(ctx: Context, config: Config): void {
  const coldReads = makeColdReadGate()
  const catalog = createCatalogService()
  const pricing = createCostSource(catalog)
  const harnessVersion = detectHarnessVersion(ctx)
  ctx.effect(() => () => { catalog.dispose() }, 'dsh-context: catalog cache')
  watchVersionChannel(ctx, catalog)
  watchBalanceChannel(ctx, harnessVersion ?? '0.0.0')
  watchRecomChannel(ctx)
  watchSkillCatalog(ctx)
  watchFleetChannel(ctx, coldReads)
  watchAttachmentChannel(ctx, coldReads)
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
  const shadow = new DetailShadow(ctx, historyBounds(bounds), coldReads, () => observeOf(ctx))
  watchDetailChannel(ctx, bounds, coldReads, gate, shadow, pricing)
  const deltaGate: DetailChannelGate = { ...gate, live: false }
  watchDeltaChannel(ctx, bounds, coldReads, deltaGate, shadow, attribution.ownerOf.bind(attribution))
  const detailStateOf = (id: string): Promise<TimelineState | null> => shadow.stateOf(id)
  watchFactsChannel(ctx, bounds, { gates: gate, coldReads, detailState: detailStateOf, cost: pricing })
  watchHistoryChannel(ctx, bounds, { coldReads, detailState: detailStateOf })
  watchCommandPageChannel(ctx, resolveBounds(config), coldReads)
  const cache = createOverviewCache({ config })
  watchHeadsChannel(ctx, { bounds, coldReads, cost: pricing, cache })
  gate.retain('contextTimeline', ctx.sessionProjections.register(createContextTimelineDefinition(config, () => gate.live, pricing)))
  ctx.sessionProjections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  ctx.sessionProjections.register(createContextActivityDefinition())
  watchTimelineRowSweep(ctx)
  let overview: ReturnType<typeof watchOverviewRoute> | null = null
  let warmTimer: ReturnType<typeof setTimeout> | null = null
  ctx.effect(() => () => {
    if (warmTimer !== null) clearTimeout(warmTimer)
    warmTimer = null
  }, 'dsh-context: overview warm schedule')
  const backfill = watchActivityBackfill(ctx, coldReads, undefined, {
    ownCache: cache,
    config,
    autoStart: true,
    onStart: () => { catalog.ensure() },
    onChange: () => {
      if (warmTimer !== null) return
      warmTimer = setTimeout(() => {
        warmTimer = null
        void overview?.warm()
      }, OVERVIEW_WARM_DELAY_MS)
      ;(warmTimer as { unref?: () => void }).unref?.()
    },
  })
  watchSnapshotRoute(ctx, backfill, cache, pricing)
  overview = watchOverviewRoute(ctx, pricing, backfill, { cache })
  watchPromptInjection(ctx, config)
}

export { startFoldWorkerChannel }

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
