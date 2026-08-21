/**
 * Provider-anchored headline derivation, shared by the Context tab and the
 * /context popup: the best-known occupancy of the next request, the route
 * capacity it scales against, and the composition parts anchored to that
 * total (heuristic ratios, provider-anchored sum).
 *
 * The provider anchor is the OFFICIAL token-meter `contextPressure`
 * projection (read via `useProjection('contextPressure')`) — the same
 * "projectedTokens" the chat's context ring displays; the Host no longer
 * mirrors it inside `contextTimeline`. When the projection is absent (older
 * harness, or the meter is not composed), the headline falls back to the
 * newest request's provider prompt plus the heuristic surface movement since
 * it was logged, and finally to the raw heuristic total.
 */

import type { ContextPressure, ContextTimeline } from '../shared/types'
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
}

export function headlineOf(data: ContextTimeline, pressure: ContextPressure | null = null): Headline {
  const current = data.current
  // The official projection's whole value is the newest usage sample carried
  // forward by the heuristic surface movement since it was taken — the same
  // formula the chat ring displays. Fields are last-wins; absent until a
  // provider reports usage.
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  const requests = data.requests
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  // Fallback anchor: the newest request's provider prompt plus the heuristic
  // surface movement since it was logged (same shape as the projection, one
  // request behind).
  const derived = lastReq !== null && typeof lastReq.prompt === 'number'
    ? lastReq.prompt + (current.total - lastReq.total)
    : undefined
  const occupancyTokens = projected ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? Math.min(100, Math.round(tokens / window * 100)) : null
  const parts = anchoredParts(partsOf(current), occupancyTokens !== null && tokens > 0 ? tokens : null)
  return { tokens, window, pct, parts }
}
