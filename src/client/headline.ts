/** Provider-anchored headline derivation for the Context tab and the /context popup: the two official
 * token-meter projections the chat's composer ring also reads — `contextPressure` for the anchored total,
 * `contextBreakdown` for the composition counts — so the legend matches the ring panel by construction. */

import type { ContextBreakdown, ContextPressure, ContextTimeline } from '../shared/types'
import { anchoredParts, officialParts, type PartsPart } from './categories'

export interface Headline {
  tokens: number
  window?: number
  pct: number | null
  /** Composition parts: `value` is the provider-anchored bar width (the ring's fill), `raw` the official
   *  heuristic count the legend and tooltips show. */
  parts: PartsPart[]
  /** What the newest request actually carried per the provider (`contextPressure.pressureTokens`, or the
   *  derived anchor's reported prompt when no projection is delivered). */
  sampled?: number
}

/** Wire-gap flag thresholds. The fixed heuristic underprices CJK text and JSON schemas (the token-meter's
 * own documented bias), so samples ABOVE the estimate are normal; only the reverse direction — the wire
 * carrying much less than the assembled context — indicates external compression or pruning on the proxy
 * side. Both a ratio and an absolute margin must hold so sub-kilo sessions never trip the flag. */
export const WIRE_GAP_RATIO = 2
export const WIRE_GAP_MIN = 4096

/** The provider-carried reading behind the headline when the assembled context outgrows it by both
 * thresholds — null otherwise (no sample, or no wide-enough divergence in either direction). */
export function wireGapOf(head: Pick<Headline, 'tokens' | 'sampled'>): number | null {
  const s = head.sampled
  if (s === undefined || s <= 0 || head.tokens <= 0) return null
  return head.tokens >= WIRE_GAP_RATIO * s && head.tokens - s >= WIRE_GAP_MIN ? s : null
}

/**
 * The kernel's own composer-ring derivation (ui-conversation's `contextOccupancy`:
 * `Math.min(100, Math.round(used / window * 100))`, `used` = `projectedTokens ?? pressureTokens`) on a
 * 0.1 grid. Callers prove `window > 0`.
 */
export function occupancyPercent(tokens: number, window: number): number {
  return Math.min(100, Math.round(tokens / window * 1000) / 10)
}

export function headlineOf(
  data: ContextTimeline,
  pressure: ContextPressure | null = null,
  breakdown: ContextBreakdown | null = null,
): Headline {
  const current = data.current
  // Same formula the chat ring displays: the official projection is the newest usage sample carried
  // forward by the heuristic surface movement since it was taken.
  const projected = pressure !== null && typeof pressure.projectedTokens === 'number'
    ? pressure.projectedTokens
    : undefined
  // The kernel's own fallback order (`contextOccupancy`): the bare provider sample. A real fold stamps
  // `pressureTokens` and the surface sample together, so the order matters only for foreign or hand-edited rows.
  const sampled = pressure !== null && typeof pressure.pressureTokens === 'number'
    ? pressure.pressureTokens
    : undefined
  // Fallback anchor, one request behind the projection: the newest request's provider prompt plus the
  // heuristic movement since it was logged. The split-generation wire head carries that record's billing
  // summary as `last` (request records ride the detail channel); the inline generation reads its newest record.
  const last = data.last
  const requests = data.requests
  const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
  const anchor = last !== undefined ? last : lastReq
  const anchorTotal = anchor !== null ? anchor.total : 0
  const anchorPrompt = anchor !== null && typeof anchor.prompt === 'number' ? anchor.prompt : undefined
  const derived = anchorPrompt !== undefined ? anchorPrompt + (current.total - anchorTotal) : undefined
  const occupancyTokens = projected ?? sampled ?? derived ?? null
  const window = pressure !== null && typeof pressure.contextWindow === 'number'
    ? pressure.contextWindow
    : data.contextWindow
  const tokens = occupancyTokens ?? current.total
  const pct = window !== undefined && window > 0 ? occupancyPercent(tokens, window) : null
  const parts = anchoredParts(
    officialParts(current, breakdown),
    occupancyTokens !== null && tokens > 0 ? tokens : null,
  )
  // The provider sample behind whatever anchors the figure; on real rows the projection's sample and the
  // fold's newest request prompt agree, so the order only matters for foreign or hand-edited values.
  const exposedSampled = sampled ?? anchorPrompt
  return {
    tokens,
    window,
    pct,
    parts,
    ...(exposedSampled === undefined ? {} : { sampled: exposedSampled }),
  }
}
