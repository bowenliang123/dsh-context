/**
 * The session data path shared by the Context tab and the Fleet tab: the merged head+detail timeline source
 * and the three token-meter projections both mounts derive their figures from. One hook, so the two views
 * cannot drift apart on what they read — and a session with no pushed `contextTimeline` value keeps the
 * source's own cold start (rev 0) and retryable note rather than an eternal spinner.
 */

import type { ContextBreakdown, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'
import { contextBreakdownOf, contextPressureOf, projectionOf, tokenUsageOf, type SessionStandardProps } from './services'
import { useTimelineSource, type TimelineSource } from './timelineSource'

export interface ContextSession {
  source: TimelineSource
  /** The renderable value, or null while nothing is: drawing the retryable note is the caller's. */
  data: ContextTimeline | null
  /** The key the chat's composer ring reads; absent on an older host → the caller's derived fallback. */
  pressure: ContextPressure | null
  /** The exact rows the chat ring's click-open panel shows. */
  breakdown: ContextBreakdown | null
  /** The same tally the chat stats line reads, so the figures match by construction. */
  usage: TokenUsage | null
}

export function useContextSession(props: SessionStandardProps): ContextSession {
  const source = useTimelineSource(props)
  return {
    source,
    data: source.data,
    pressure: projectionOf(props, 'contextPressure', contextPressureOf),
    breakdown: projectionOf(props, 'contextBreakdown', contextBreakdownOf),
    usage: projectionOf(props, 'tokenUsage', tokenUsageOf),
  }
}
