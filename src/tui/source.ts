/** The on-screen session's context data for every terminal surface: the host-tracked projection watches, re-proved like the
 * web client's, with a slim head's collections built IN-PROCESS by the plugin's own detail builder — no HTTP. */

import type { Context } from '@deepseek-ai/cordis'
import { headersOf, timelineOf, withDetail } from '../client/services'
import type { FoldBounds } from '../host/config'
import { buildTimelineDetail } from '../host/foldWire'
import type { ContextHeaders, ContextTimeline, ContextTimelineDetail } from '../shared/types'
import type { ProjectionWatch } from './hostTypes'

export interface ContextData {
  sessionId: string | undefined
  timeline: ContextTimeline | null
  headers: ContextHeaders | null
  /** A slim head whose collections could not be read: the totals render, the lists stay empty. */
  partial: boolean
}

export interface ContextSource {
  subscribe: (listener: () => void) => () => void
  read: () => ContextData
}

export type DetailReader = (sessionId: string, rev: number) => ContextTimelineDetail | null

interface SessionsFace {
  get?: (id: string) => unknown
}

/** The registry state can run ahead of the last pushed head, so the payload carries its own revision (and its own head, at
 * the same cut): the cache keys on that, and a payload is reused only for exactly the revision it holds. Head-only fields
 * (model, window, system/tools totals, timing) move without a revision, so a cached payload's head can trail the pushed one. */
export function createDetailReader(ctx: Context, bounds: FoldBounds): DetailReader {
  let cached: { sessionId: string; detail: ContextTimelineDetail } | undefined
  return (sessionId, rev) => {
    if (cached !== undefined && cached.sessionId === sessionId && cached.detail.rev === rev) return cached.detail
    try {
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      const session = typeof sessions?.get === 'function' ? sessions.get(sessionId) : undefined
      if (session === undefined || session === null) return null
      const state = ctx.sessionProjections.stateOf(session as never, 'contextTimeline')
      if (state === undefined) return null
      const detail = buildTimelineDetail(state, bounds)
      cached = { sessionId, detail }
      return detail
    } catch {
      return null
    }
  }
}

export function createContextSource(
  timeline: ProjectionWatch,
  headers: ProjectionWatch | undefined,
  readDetail: DetailReader,
): ContextSource {
  let last: { sessionId: string | undefined; rawTimeline: unknown; rawHeaders: unknown; data: ContextData } | undefined
  const read = (): ContextData => {
    const sessionId = timeline.sessionId
    const rawTimeline = timeline.read()
    const rawHeaders = headers?.read()
    if (last !== undefined && last.sessionId === sessionId && last.rawTimeline === rawTimeline && last.rawHeaders === rawHeaders) {
      return last.data
    }
    const head = timelineOf(rawTimeline)
    let merged = head
    let partial = false
    if (head !== null && typeof head.detailRev === 'number') {
      const detail = sessionId === undefined ? null : readDetail(sessionId, head.detailRev)
      if (detail === null) partial = true
      // Collections folded past the pushed head pair with the head of their own cut; at the same revision the pushed head
      // is the newer one.
      else merged = withDetail(detail.rev > head.detailRev && detail.head !== undefined ? detail.head : head, detail)
    }
    const data: ContextData = { sessionId, timeline: merged, headers: headersOf(rawHeaders), partial }
    last = { sessionId, rawTimeline, rawHeaders, data }
    return data
  }
  const subscribe = (listener: () => void): (() => void) => {
    const offTimeline = timeline.subscribe(listener)
    const offHeaders = headers?.subscribe(listener)
    return () => {
      offTimeline()
      offHeaders?.()
    }
  }
  return { read, subscribe }
}
