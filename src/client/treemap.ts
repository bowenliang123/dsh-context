import type { Category, SurfaceNode } from '../shared/types'
import type { Assembled } from '../shared/assemble'
import { MESSAGE_CATS } from './categories'
import type { Translate } from './i18n'
import { formLabelOf } from './labels'

const MAX_BLOCKS = 12
const TOP_BLOCKS = MAX_BLOCKS - 1

export interface MapBlock {
  key: string
  label: string
  tokens: number
  count: number
  elem?: string
  query?: string
}

export interface MapCat {
  cat: Category | 'system' | 'tools'
  tokens: number
  blocks: MapBlock[]
}

interface MapBox { x: number; y: number; w: number; h: number }
interface Laid<T> { item: T; rect: MapBox }

function groupOf(n: SurfaceNode, t: Translate): { gkey: string; label: string } {
  switch (n.cat) {
    case 'tool': return { gkey: 'tool:' + (n.tool ?? '?'), label: n.tool ?? '?' }
    case 'skill':
      return n.skill !== undefined
        ? { gkey: 'skill:' + n.skill, label: n.skill }
        : { gkey: 'skill~' + (n.form || 'context'), label: formLabelOf(t, n.form) }
    default: return { gkey: 'inject:' + (n.form || 'context'), label: formLabelOf(t, n.form) }
  }
}

function pushCat(cats: MapCat[], cat: Category | 'system' | 'tools', blocks: MapBlock[], t: Translate): void {
  if (blocks.length === 0) return
  blocks.sort((a, b) => b.tokens - a.tokens)
  let folded = blocks
  if (blocks.length > MAX_BLOCKS) {
    const rest = blocks.slice(TOP_BLOCKS)
    let tokens = 0
    for (const b of rest) tokens += b.tokens
    folded = [
      ...blocks.slice(0, TOP_BLOCKS),
      { key: '~' + cat, label: t('browser.mapOthers', { n: rest.length }), tokens, count: rest.length },
    ]
  }
  let tokens = 0
  for (const b of folded) tokens += b.tokens
  cats.push({ cat, tokens, blocks: folded })
}

export function mapOf(view: Assembled, t: Translate, catLabel: (key: string) => string): MapCat[] {
  const cats: MapCat[] = []
  const sys = view.system
  if (sys !== null && sys.tokens > 0) {
    cats.push({
      cat: 'system',
      tokens: sys.tokens,
      blocks: [{ key: 'sys', label: catLabel('system'), tokens: sys.tokens, count: 1, elem: 'sys' }],
    })
  }
  if (view.header !== null) {
    pushCat(cats, 'tools', view.header.tools
      .filter(tool => tool.tokens > 0)
      .map(tool => ({ key: 'tools:' + tool.name, label: tool.name, tokens: tool.tokens, count: 1, elem: 'tool:' + tool.name })), t)
  }
  for (const cat of MESSAGE_CATS) {
    const blocks: MapBlock[] = []
    const groups = new Map<string, MapBlock & { seq: number }>()
    for (const n of view.nodes) {
      if (n.cat !== cat || n.tokens <= 0) continue
      if (n.cat === 'user' || n.cat === 'assistant') {
        const label = n.cat === 'assistant' && Array.isArray(n.calls) && n.calls.length > 0
          ? n.calls.join(' › ')
          : '#' + String(n.seq)
        blocks.push({ key: 'n' + String(n.seq), label, tokens: n.tokens, count: 1, elem: 'n' + String(n.seq) })
        continue
      }
      const g = groupOf(n, t)
      const acc = groups.get(g.gkey)
      if (acc !== undefined) {
        acc.tokens += n.tokens
        acc.count += 1
      } else {
        groups.set(g.gkey, { key: g.gkey, label: g.label, tokens: n.tokens, count: 1, seq: n.seq })
      }
    }
    for (const g of groups.values()) {
      blocks.push(g.count === 1
        ? { key: g.key, label: g.label, tokens: g.tokens, count: 1, elem: 'n' + String(g.seq) }
        : { key: g.key, label: g.label, tokens: g.tokens, count: g.count, query: g.label })
    }
    pushCat(cats, cat, blocks, t)
  }
  return cats
}

export function squarify<T extends { tokens: number }>(items: readonly T[], box: MapBox): Laid<T>[] {
  const sized = items.filter(it => it.tokens > 0)
  sized.sort((a, b) => b.tokens - a.tokens)
  let total = 0
  for (const it of sized) total += it.tokens
  if (total <= 0 || box.w <= 0 || box.h <= 0) return []
  const scale = box.w * box.h / total
  const entries = sized.map(it => ({ it, a: it.tokens * scale }))
  const out: Laid<T>[] = []
  let rem: MapBox = { ...box }
  let row: typeof entries = []

  const worst = (areas: number[], side: number): number => {
    let sum = 0
    for (const a of areas) sum += a
    const thick = sum / side
    let bad = 0
    for (const a of areas) {
      const len = a / thick
      const ratio = len > thick ? len / thick : thick / len
      if (ratio > bad) bad = ratio
    }
    return bad
  }

  const flush = (): void => {
    let sum = 0
    for (const r of row) sum += r.a
    if (rem.w >= rem.h) {
      const thick = sum / rem.h
      let y = rem.y
      for (const r of row) {
        const len = r.a / thick
        out.push({ item: r.it, rect: { x: rem.x, y, w: thick, h: len } })
        y += len
      }
      rem = { x: rem.x + thick, y: rem.y, w: rem.w - thick, h: rem.h }
    } else {
      const thick = sum / rem.w
      let x = rem.x
      for (const r of row) {
        const len = r.a / thick
        out.push({ item: r.it, rect: { x, y: rem.y, w: len, h: thick } })
        x += len
      }
      rem = { x: rem.x, y: rem.y + thick, w: rem.w, h: rem.h - thick }
    }
    row = []
  }

  for (const entry of entries) {
    if (row.length > 0) {
      const side = Math.min(rem.w, rem.h)
      const without = worst(row.map(r => r.a), side)
      if (worst([...row.map(r => r.a), entry.a], side) > without) flush()
    }
    row.push(entry)
  }
  flush()
  return out
}
