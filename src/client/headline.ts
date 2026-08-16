/**
 * Provider-anchored headline derivation, shared by the Context tab and the
 * /context popup: the best-known occupancy of the next request, the route
 * capacity it scales against, and the composition parts anchored to that
 * total (heuristic ratios, provider-anchored sum — the same trick the
 * official ContextMeter uses).
 */

import type { ContextTimeline } from '../shared/types'
import { anchoredParts, partsOf, type PartsPart } from './categories'

export interface Headline {
  /** Best-known occupancy of the next request (projected ?? derived ?? heuristic total). */
  tokens: number
  /** Route capacity the headline scales against (may be unknown). */
  window?: number
  /** tokens / window, clamped to 100; null without a window. */
  pct: number | null
  /** Composition parts anchored to the provider total when one exists. */
  parts: PartsPart[]
  /** True when no provider anchor applied (parts sum to the heuristic total). */
  estimated: boolean
}

export function headlineOf(data: ContextTimeline): Headline {
  const current = data.current
  const occ = data.occupancy
  const projected = occ !== undefined && typeof occ.projectedTokens === 'number' ? occ.projectedTokens : undefined
  const requests = data.requests || []
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  // Fallback anchor: the newest request's provider prompt plus the heuristic
  // surface movement since it was logged.
  const derived = lastReq !== null && typeof lastReq.prompt === 'number'
    ? lastReq.prompt + (current.total - lastReq.total)
    : undefined
  const occupancyTokens = projected ?? derived ?? null
  const window = occ !== undefined && typeof occ.contextWindow === 'number' ? occ.contextWindow : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? Math.min(100, Math.round(tokens / window * 100)) : null
  const parts = anchoredParts(partsOf(current), occupancyTokens !== null && tokens > 0 ? tokens : null)
  return { tokens, window, pct, parts, estimated: occupancyTokens === null }
}
