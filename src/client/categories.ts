/**
 * Category presentation config: the six priced buckets (system, tool
 * schemas, and the four surface categories) with their chart colors, plus
 * `partsOf` which projects a token breakdown (snapshot current or a request
 * record) into renderable parts.
 */

import type { Category, RequestRecord, Snapshot } from '../shared/types'

export interface PartsPart { key: string; color: string; value: number }

export const CATS: { key: Category | 'system' | 'tools'; color: string }[] = [
  { key: 'system', color: '#6366f1' },
  { key: 'tools', color: '#f59e0b' },
  { key: 'user', color: '#22c55e' },
  { key: 'inject', color: '#a855f7' },
  { key: 'assistant', color: '#3b82f6' },
  { key: 'tool', color: '#14b8a6' },
]

export function partsOf(breakdown: Snapshot['current'] | RequestRecord): PartsPart[] {
  return CATS.map(c => {
    return { key: c.key, color: c.color, value: breakdown[c.key] || 0 }
  })
}

/**
 * Reproportion heuristic parts so they sum to a provider-anchored target —
 * the same trick the official ContextMeter uses: the heuristic breakdown
 * supplies the composition RATIOS, the provider sample the total. Returns
 * the parts unchanged when no anchor applies.
 */
export function anchoredParts(parts: PartsPart[], target: number | null): PartsPart[] {
  if (target === null || target <= 0) return parts
  let total = 0
  for (const p of parts) total += p.value
  if (total <= 0 || total === target) return parts
  const scale = target / total
  return parts.map(p => ({ ...p, value: Math.round(p.value * scale) }))
}
