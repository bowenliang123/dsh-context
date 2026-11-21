import type { ContextTimelineDetail } from '../shared/types'
import { DELTA_ROUTE, DETAIL_ROUTE, FACTS_ROUTE, HISTORY_ROUTE } from './apiRoutes'
import { postRoute, postRouteQuietly } from './route'
import { deltaOf, detailOf, factsOf, historyOf, type DeltaFetcher, type FactsRead, type HistoryFetcher } from './timelineWire'

export type FactPart = 'requests' | 'nodes' | 'events' | 'files' | 'commands' | 'spans'

export interface FactWindow {
  requestsTail?: number
  nodesTail?: number
  eventsTail?: number
  filesTail?: number
  commandsTail?: number
  spansTail?: number
}

export type CoreRead = FactsRead | ContextTimelineDetail

export type CoreFetcher = () => Promise<ContextTimelineDetail | null>

export type StoreFetcher = CoreFetcher | FactsFetchers

export interface FactsFetchers {
  core: () => Promise<CoreRead | null>
  part: (part: FactPart, window: FactWindow) => Promise<CoreRead | null>
  history?: HistoryFetcher
  legacy?: CoreFetcher
}

export function makeDetailFetcher(
  sessionId: string,
): (() => Promise<ContextTimelineDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(DETAIL_ROUTE, { sessionId }, detailOf, { label: 'detail' })
}

export function makeDeltaFetcher(sessionId: string): DeltaFetcher | undefined {
  if (sessionId === '') return undefined
  return (seq, baseSeq) => postRouteQuietly(
    DELTA_ROUTE,
    { sessionId, seq, baseSeq },
    deltaOf,
    { label: 'delta' },
  )
}

export function makeFactsFetchers(sessionId: string): FactsFetchers | undefined {
  if (sessionId === '') return undefined
  const read = (parts: readonly (FactPart | 'head' | 'series')[], window?: FactWindow): Promise<CoreRead | null> => postRoute(
    FACTS_ROUTE,
    { sessionId, parts, ...(window === undefined ? {} : { window }) },
    value => factsOf(value) ?? detailOf(value),
    { label: 'facts' },
  )
  const history: HistoryFetcher = (part, cursor, limit) => postRoute(
    HISTORY_ROUTE,
    {
      sessionId,
      part,
      ...(cursor?.beforeSeq === undefined ? {} : { beforeSeq: cursor.beforeSeq }),
      ...(cursor?.beforeIndex === undefined ? {} : { beforeIndex: cursor.beforeIndex }),
      ...(limit === undefined ? {} : { limit }),
    },
    historyOf,
    { label: 'history' },
  )
  return {
    core: () => read(['head', 'series']),
    part: (part, window) => read([part], window),
    history,
    legacy: makeDetailFetcher(sessionId) as CoreFetcher,
  }
}
