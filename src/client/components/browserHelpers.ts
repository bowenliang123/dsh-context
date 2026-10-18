import type { Assembled } from '../assemble'
import type { Category, RequestRecord, SurfaceNode } from '../../shared/types'
import type { RowKind } from './browserNodes'

export interface CatFocus {
  cat: string
  kind?: RowKind
}

export function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

export function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

/** The turn/step marking where a surface item entered the context: the FIRST request logged after the item's seq is
 * the first that carried it (assemble's inclusion rule is `n.seq < R.seq`); no following request stamps null. */
export function stepStampOf(requests: RequestRecord[]): (itemSeq: number) => { turn: number; step: number } | null {
  // Sort a copy: the wire arrives in append order, but the derivation must not depend on it (restored rows can re-order).
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  return (itemSeq) => {
    for (const r of sorted) {
      if (r.seq > itemSeq) {
        return typeof r.turn === 'number' && typeof r.step === 'number' ? { turn: r.turn, step: r.step } : null
      }
    }
    return null
  }
}

/** Bands keep at least this share of the occupied region, so a tiny item stays a hoverable/clickable filament
 * instead of a sub-pixel sliver; tooltips still report true shares. */
export const DNA_MIN_BAND = 0.35
