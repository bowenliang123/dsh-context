import type { Category, ContextHeaders, ContextTimeline, RequestRecord, SurfaceNode } from '../shared/types'
import { assembleCached } from './components/derivedCache'
import { headerAt, systemAt } from './assemble'
import type { Assembled } from './assemble'
import { CAT_COLOR } from './categories'
import type { Translate } from './i18n'
import { formLabelOf } from './labels'

export type DnaItem =
  | { key: string; cat: 'system' | 'tools'; tokens: number; time?: number }
  | { key: string; cat: Category; tokens: number; time?: number; node: SurfaceNode }

export function dnaOf(view: Assembled): DnaItem[] {
  const items: DnaItem[] = []
  if (view.system !== null) {
    items.push({ key: 'sys', cat: 'system', tokens: view.system.tokens, time: view.system.time })
  }
  if (view.header !== null) {
    for (const tool of view.header.tools) {
      items.push({ key: 'tool:' + tool.name, cat: 'tools', tokens: tool.tokens })
    }
  }
  for (const n of view.nodes) {
    items.push({
      key: 'n' + String(n.seq),
      cat: n.cat,
      tokens: n.tokens,
      node: n,
      ...(n.time !== undefined ? { time: n.time } : {}),
    })
  }
  return items
}

export type TrendBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

export function trendBandsOf(view: Assembled): TrendBand[] {
  const bands: TrendBand[] = []
  let off = 0
  for (const it of dnaOf(view)) {
    if ('node' in it) {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat], node: it.node })
    } else {
      bands.push({ key: it.key, cat: it.cat, tokens: it.tokens, off, color: CAT_COLOR[it.cat] })
    }
    off += it.tokens
  }
  return bands
}

export type DeltaBand =
  | { key: string; cat: 'system' | 'tools'; tokens: number; off: number; color: string }
  | { key: string; cat: Category; tokens: number; off: number; color: string; node: SurfaceNode }

export interface DnaDelta {
  up: DeltaBand[]
  down: DeltaBand[]
}

export function deltaTotalsOf(bands: readonly TrendBand[], prev: readonly TrendBand[] | null): { up: number; down: number } {
  if (prev === null) return { up: 0, down: 0 }
  const before = new Map<string, number>()
  for (const b of prev) before.set(b.key, b.tokens)
  let up = 0
  let down = 0
  for (const b of bands) {
    const d = b.tokens - (before.get(b.key) ?? 0)
    if (d > 0) up += d
    else if (d < 0) down -= d
    before.delete(b.key)
  }
  for (const tokens of before.values()) {
    if (tokens > 0) down += tokens
    else if (tokens < 0) up -= tokens
  }
  return { up, down }
}

export function deltaBandsOf(bands: TrendBand[], prev: TrendBand[] | null): DnaDelta {
  if (prev === null) return { up: [], down: [] }
  const before = new Map(prev.map(b => [b.key, b.tokens] as const))
  const after = new Map(bands.map(b => [b.key, b.tokens] as const))
  const up: DeltaBand[] = []
  const down: DeltaBand[] = []
  for (const b of bands) {
    const d = b.tokens - (before.get(b.key) ?? 0)
    if (d <= 0) continue
    up.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  for (const b of prev) {
    const d = (after.get(b.key) ?? 0) - b.tokens
    if (d >= 0) continue
    down.push('node' in b
      ? { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color, node: b.node }
      : { key: b.key, cat: b.cat, tokens: d, off: 0, color: b.color })
  }
  let u = 0
  for (const x of up) { x.off = u; u += x.tokens }
  let dn = 0
  for (const x of down) { x.off = dn; dn -= x.tokens }
  return { up, down }
}

export interface DeltaMaxima {
  up: number
  down: number
}

export function bandsMaximaOf(bandsPerRequest: readonly TrendBand[][]): DeltaMaxima {
  let up = 0
  let down = 0
  let prev: TrendBand[] | null = null
  for (const bands of bandsPerRequest) {
    const totals = deltaTotalsOf(bands, prev)
    if (totals.up > up) up = totals.up
    if (totals.down > down) down = totals.down
    prev = bands
  }
  return { up, down }
}

function surfaceMaximaOf(data: ContextTimeline, headers: ContextHeaders | null, requests: readonly RequestRecord[]): DeltaMaxima {
  let up = 0
  let down = 0
  let nodeAt = 0
  let prevSys: number | undefined
  let prevTools: Map<string, number> | null = null
  for (let i = 0; i < requests.length; i++) {
    const seq = requests[i].seq
    if (i === 0) {
      while (nodeAt < data.nodes.length && data.nodes[nodeAt].seq < seq) nodeAt += 1
      const system = systemAt(data, headerAt(headers, seq), seq)
      prevSys = system === null ? undefined : system.tokens
      const header = headerAt(headers, seq)
      if (header !== null) {
        prevTools = new Map(header.tools.map(tool => ['tool:' + tool.name, tool.tokens] as const))
      }
      continue
    }
    let stepUp = 0
    let stepDown = 0
    while (nodeAt < data.nodes.length && data.nodes[nodeAt].seq < seq) {
      stepUp += data.nodes[nodeAt].tokens
      nodeAt += 1
    }
    const system = systemAt(data, headerAt(headers, seq), seq)
    const sysTokens = system === null ? undefined : system.tokens
    const sysDelta = (sysTokens ?? 0) - (prevSys ?? 0)
    if (sysDelta > 0) stepUp += sysDelta
    else if (sysDelta < 0) stepDown -= sysDelta
    const header = headerAt(headers, seq)
    const tools = new Map<string, number>()
    if (header !== null) {
      for (const tool of header.tools) tools.set('tool:' + tool.name, tool.tokens)
    }
    if (prevTools !== null || tools.size > 0) {
      const before = prevTools ?? new Map<string, number>()
      for (const [key, tokens] of tools) {
        const delta = tokens - (before.get(key) ?? 0)
        if (delta > 0) stepUp += delta
        else if (delta < 0) stepDown -= delta
        before.delete(key)
      }
      for (const tokens of before.values()) {
        if (tokens > 0) stepDown += tokens
        else if (tokens < 0) stepUp -= tokens
      }
    }
    if (stepUp > up) up = stepUp
    if (stepDown > down) down = stepDown
    prevTools = tools
    prevSys = sysTokens
  }
  return { up, down }
}

export function dnaDeltaMaximaOf(
  data: ContextTimeline,
  headers: ContextHeaders | null,
  requests: readonly RequestRecord[],
): DeltaMaxima {
  const fallback = (): DeltaMaxima => bandsMaximaOf(requests.map(req => trendBandsOf(assembleCached(data, headers, req.seq))))
  if (requests.length === 0) return { up: 0, down: 0 }
  if (data.archive.length > 0) return fallback()
  let sorted = true
  for (const node of data.nodes) {
    if (node.tokens < 0) {
      sorted = false
      break
    }
  }
  for (let i = 1; sorted && i < data.nodes.length; i++) {
    if (data.nodes[i].seq < data.nodes[i - 1].seq) {
      sorted = false
      break
    }
  }
  if (!sorted) return fallback()
  for (let i = 1; i < requests.length; i++) {
    if (requests[i].seq < requests[i - 1].seq) return fallback()
  }
  if (headers !== null) {
    for (const entry of headers.headers) {
      const names = new Set<string>()
      for (const tool of entry.tools) {
        if (names.has(tool.name)) return fallback()
        names.add(tool.name)
      }
    }
  }
  return surfaceMaximaOf(data, headers, requests)
}

export function dnaBaseLabel(b: DnaItem | TrendBand | DeltaBand, t: Translate, catLabel: (key: string) => string): string {
  if (!('node' in b)) return b.cat === 'system' ? catLabel('system') : b.key.slice('tool:'.length)
  const n = b.node
  return n.skill !== undefined ? t('node.skillTag', { name: n.skill })
    : n.cat === 'tool' ? (n.tool ?? '?')
      : n.cat === 'inject' ? formLabelOf(t, n.form)
        : catLabel(n.cat)
}
