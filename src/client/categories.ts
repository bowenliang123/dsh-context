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
