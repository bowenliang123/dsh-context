/**
 * Category presentation config: the six priced buckets (system, tool
 * schemas, and the four surface categories) with their chart colors, plus
 * the part builders behind the composition card.
 *
 * Two figures ride on every part, mirroring the official chat context
 * meter's own split: `raw` is the heuristic count (the meter panel's `~`
 * rows — identical to the ring panel by construction when the official
 * `contextBreakdown` projection feeds it), while `value` is the
 * provider-anchored bar width (the ring's fill proportioned by the
 * heuristic ratios). Without a provider anchor the two are equal.
 */

import type { Category, ContextBreakdown, RequestRecord, Snapshot } from '../shared/types'

export interface PartsPart {
  key: string
  color: string
  /** Bar-width figure (provider-anchored when an anchor applies). */
  value: number
  /** Heuristic count shown by the legend and tooltips (defaults to value). */
  raw?: number
}

export const CATS: { key: Category | 'system' | 'tools'; color: string }[] = [
  { key: 'system', color: '#6366f1' },
  { key: 'tools', color: '#f59e0b' },
  { key: 'user', color: '#22c55e' },
  { key: 'inject', color: '#a855f7' },
  { key: 'assistant', color: '#3b82f6' },
  { key: 'tool', color: '#14b8a6' },
]

const MESSAGE_CATS: readonly (Category | 'system' | 'tools')[] = ['user', 'inject', 'assistant', 'tool']

export function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
  return CATS.map((c) => {
    return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
  })
}

/**
 * Build the pie-consistent raw parts: system/tools/messages take the
 * OFFICIAL `contextBreakdown` figures when delivered (the exact counts the
 * chat ring's panel shows), with the message bucket subdivided into the
 * four surface categories by the fold's per-category ratios (rounding
 * residue lands on the largest category, so the four always sum exactly to
 * the official message figure). Absent the projection, the fold's own sums
 * serve — the same fixed estimator, so identical on image-free sessions.
 */
export function officialParts(
  current: Snapshot['current'],
  breakdown: ContextBreakdown | null,
): PartsPart[] {
  const foldSurface = current.user + current.inject + current.assistant + current.tool
  const system = breakdown?.systemTokens ?? current.system
  const tools = breakdown?.toolsTokens ?? current.tools
  const messages = breakdown?.messageTokens ?? foldSurface
  const shares: Record<string, number> = { system, tools }
  if (foldSurface > 0) {
    let assigned = 0
    let largest: Category = 'user'
    for (const cat of MESSAGE_CATS) {
      const count = Math.round(messages * (current[cat as Category] / foldSurface))
      shares[cat] = count
      assigned += count
      if (current[cat as Category] > current[largest]) largest = cat as Category
    }
    // Rounding residue lands on the largest category; clamp so a tiny
    // message bucket with several rounded-up shares never goes negative.
    shares[largest] = Math.max(0, shares[largest] + messages - assigned)
  } else {
    for (const cat of MESSAGE_CATS) shares[cat] = 0
  }
  return CATS.map(c => ({ key: c.key, color: c.color, value: shares[c.key] ?? 0 }))
}

/**
 * Reproportion heuristic parts so they sum to a provider-anchored target —
 * the same trick the official ContextMeter uses: the heuristic breakdown
 * supplies the composition RATIOS, the provider sample the total. The
 * anchored figure rides `value` (bar widths); the heuristic count stays on
 * `raw` for the legend and tooltips. Returns the parts unchanged when no
 * anchor applies.
 */
export function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  const sourced = parts.map(p => ({ ...p, raw: p.raw ?? p.value }))
  if (target === null || target <= 0) return sourced
  let total = 0
  for (const p of sourced) total += p.raw
  if (total <= 0) return sourced
  if (total === target) return sourced.map(p => ({ ...p, value: p.raw }))
  const scale = target / total
  return sourced.map(p => ({ ...p, value: Math.round(p.raw * scale) }))
}
