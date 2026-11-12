import type { Assembled } from '../../shared/assemble'
import type { Category, RequestRecord, SurfaceNode } from '../../shared/types'
import type { DefaultDeltaBase } from '../settings'
import type { RowKind } from './browserNodes'

export interface CatFocus {
  cat: string
  kind?: RowKind
  step?: number
  query?: string
}

export function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

export function lastOfTurn(requests: readonly RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

export function baseRequestOf(
  requests: readonly RequestRecord[],
  req: RequestRecord | null,
  base: DefaultDeltaBase,
): RequestRecord | null {
  if (req === null) {
    const last = requests.length > 0 ? requests[requests.length - 1] : null
    if (last === null) return null
    return base === 'step' ? last : lastOfTurn(requests, (last.turn ?? 0) - 1)
  }
  if (base === 'turn') return lastOfTurn(requests, (req.turn ?? 0) - 1)
  const i = requests.indexOf(req)
  return i > 0 ? requests[i - 1] : null
}

export function findRowByKey(root: HTMLElement, key: string): HTMLElement | null {
  for (const row of root.querySelectorAll<HTMLElement>('[data-lc-key]')) {
    if (row.dataset.lcKey === key) return row
  }
  return null
}

export const safeIdPart = (key: string): string => key.replace(/[^a-zA-Z0-9_-]/g, '_')

export const STEP_PICK_MAX = 500

export interface StepPickOption {
  value: string
  label: string
}

function stepMatches(option: StepPickOption, query: string): boolean {
  return `${option.label} ${option.value}`.toLowerCase().includes(query)
}

export function stepPickOptionsOf(
  requests: readonly RequestRecord[],
  sel: 'live' | number,
  seq: number | null,
  live: StepPickOption,
  optionOf: (request: RequestRecord) => StepPickOption,
): StepPickOption[] {
  const count = requests.length
  let from = Math.max(0, count - STEP_PICK_MAX)
  if (count > STEP_PICK_MAX) {
    const newest = requests[from]
    const selSeq = typeof sel === 'number' && (seq === null || seq < newest.seq) ? sel : null
    if (selSeq !== null) {
      let low = 0
      let high = count - 1
      let idx = count - 1
      while (low <= high) {
        const mid = (low + high) >> 1
        if (requests[mid].seq >= selSeq) { idx = mid; high = mid - 1 } else low = mid + 1
      }
      from = Math.max(0, idx - (STEP_PICK_MAX >> 1))
    }
  }
  return [live, ...requests.slice(from, from + STEP_PICK_MAX).map(optionOf).reverse()]
}

export function stepPickMatchesOf(
  requests: readonly RequestRecord[],
  query: string,
  live: StepPickOption,
  optionOf: (request: RequestRecord) => StepPickOption,
): StepPickOption[] {
  const q = query.trim().toLowerCase()
  const out: StepPickOption[] = stepMatches(live, q) ? [live] : []
  for (let i = requests.length - 1; i >= 0 && out.length < STEP_PICK_MAX; i--) {
    const option = optionOf(requests[i])
    if (stepMatches(option, q)) out.push(option)
  }
  return out
}

export const nodeEstimateSize = (): number => 30

export function stepStampOf(requests: RequestRecord[]): (itemSeq: number) => { turn: number; step: number } | null {
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

export const DNA_MIN_BAND = 0.35
