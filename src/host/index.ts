import type { Context } from '@deepseek-ai/cordis'
import { createCatalogService } from './catalog'
import { watchVersionChannel } from './versionRoute'
import { createCostSource } from './cost'
import { watchAttachmentChannel } from './attachment'
import { createToolAttribution } from './attribution'
import { watchBalanceChannel } from './balance'
import { makeColdReadGate } from './coldRead'
import { Config } from './config'
import { watchFleetChannel } from './fleet'
import { watchPromptInjection } from './promptInjection'
import { watchStepIdentity } from './stepIdentity'
import { watchSkillCatalog } from './skills'
import { watchRecomChannel } from './recoms'
import { createContextHeadersDefinition } from './headers'
import { detectHarnessVersion } from './version'
import { startStorage, type StorageHandle } from './db/plugin'

export const name = 'dsh-context'

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
  const attribution = createToolAttribution(ctx, harnessVersion)
  const projections = ctx.sessionProjections as { register?: (unit: unknown) => unknown }
  if (typeof projections.register === 'function') {
    projections.register(createContextHeadersDefinition(name => attribution.ownerOf(name)))
  }
  watchStepIdentity(ctx)
  let storage: StorageHandle | null = null
  try {
    storage = startStorage(ctx, config, {
      cost: pricing,
      harnessVersion,
      attribution: attribution.ownerOf.bind(attribution),
    })
  } catch (error: unknown) {
    ctx.logger.error(`dsh-context: storage startup failed: ${String(error)}`)
  }
  ctx.effect(() => () => {
    storage?.dispose()
    storage = null
  }, 'dsh-context: storage')
  watchPromptInjection(ctx, config)
}

export { startStorage } from './db/plugin'

export type { Category, ContextEventRecord, RequestRecord, Snapshot, ContextTimeline, SurfaceNode } from '../shared/types'
export type { ActivityDay, ContextActivity, ContextHeaders, HeaderRecord, HeaderTool, ContextTimelineDetail, TimelineCounts, TimelineLast } from '../shared/types'
export type { PlatformBalance, PlatformBalanceEntry, SkillInfo } from '../shared/types'
export type { ActivityState } from './activity'
export type { TimelineState } from './foldState'
export type { HeadersState } from './headers'
