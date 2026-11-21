import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { ContextTimeline } from '../shared/types'
import { noteCostPending } from './costRefresh'
import type { SessionStandardProps } from './services'
import { projectionOf, timelineOf } from './services'
import { detailStoreOf, EMPTY_SNAP, type DetailState, type FactPart, type FactWindow } from './detailStore'

export { DetailStore, detailBytesOf, detailStoreOf, resetTimelineDetailStores, EMPTY_SNAP } from './detailStore'
export type { DetailState, FactPart, FactWindow } from './detailStore'
export { makeFactsFetchers, makeDetailFetcher, makeDeltaFetcher } from './detailFetcher'
export { deltaOf, detailOf, factsOf, historyOf } from './detailStore'
export type { DeltaFetcher, FactsRead, HistoryCursor, HistoryFetcher } from './detailStore'

export interface TimelineSource {
  data: ContextTimeline | null
  detailState: DetailState
  retryDetail: () => void
  ensurePart: (part: FactPart, window?: FactWindow) => void
  ensureHistory: () => void
}

const noopSubscribe = (): (() => void) => () => {}
const noopRetry = (): void => {}
const noopEnsurePart = (): void => {}
const noopEnsureHistory = noopEnsurePart

export function useTimelineSource(props: SessionStandardProps): TimelineSource {
  const head = projectionOf(props, 'contextTimeline', timelineOf)
  const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
  const headRev = head !== null && typeof head.detailRev === 'number' ? head.detailRev : null
  const slim = headRev !== null
  const cold = head === null
  const store = useMemo(
    () => (sessionId !== '' && (slim || cold) ? detailStoreOf(sessionId) : null),
    [sessionId, slim, cold],
  )
  const snap = useSyncExternalStore(
    store !== null ? store.subscribe : noopSubscribe,
    store !== null ? store.getSnapshot : () => EMPTY_SNAP,
  )
  useEffect(() => {
    if (store !== null) store.request(headRev ?? 0)
  }, [store, headRev])

  useEffect(() => {
    if (store !== null && snap.detail !== null) store.ensureHistory()
  }, [store, snap.detail])

  return useMemo<TimelineSource>(() => {
    const detail = snap.detail
    const retry = store !== null ? store.retry : noopRetry
    const ensurePart = store !== null ? store.ensurePart : noopEnsurePart
    const ensureHistory = store !== null ? store.ensureHistory : noopEnsureHistory
    if (head !== null && !slim) {
      noteCostPending(head.costRead)
      return { data: head, detailState: 'legacy', retryDetail: noopRetry, ensurePart: noopEnsurePart, ensureHistory: noopEnsureHistory }
    }
    const base = head !== null ? head : detail !== null ? detail.head ?? null : null
    if (base === null) {
      const failed = store !== null && (snap.failed || detail !== null)
      return { data: null, detailState: failed ? 'failed' : 'loading', retryDetail: retry, ensurePart, ensureHistory }
    }
    if (detail === null) {
      noteCostPending(base.costRead)
      return { data: base, detailState: snap.failed ? 'failed' : 'loading', retryDetail: retry, ensurePart, ensureHistory }
    }
    noteCostPending(detail.head?.costRead ?? base.costRead)
    const data: ContextTimeline = {
      ...base,
      ...(detail.head?.costRead === undefined ? {} : { costRead: detail.head.costRead }),
      requests: detail.requests,
      events: detail.events,
      nodes: detail.nodes,
      droppedNodes: detail.droppedNodes,
      archive: detail.archive,
      ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
      ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
      ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
      ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
      ...(detail.commands !== undefined ? { commands: detail.commands } : {}),
      ...(detail.commandsFloor !== undefined ? { commandsFloor: detail.commandsFloor } : {}),
      ...(detail.commandStats !== undefined ? { commandStats: detail.commandStats } : {}),
      ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
    }
    return { data, detailState: 'ready', retryDetail: retry, ensurePart, ensureHistory }
  }, [head, slim, store, snap])
}
