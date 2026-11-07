import type { ContextBreakdown, ContextPressure, ContextTimeline, TokenUsage } from '../shared/types'
import { contextBreakdownOf, contextPressureOf, projectionOf, tokenUsageOf, type SessionStandardProps } from './services'
import { useTimelineSource, type TimelineSource } from './timelineSource'

interface ContextSession {
  source: TimelineSource
  data: ContextTimeline | null
  pressure: ContextPressure | null
  breakdown: ContextBreakdown | null
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
