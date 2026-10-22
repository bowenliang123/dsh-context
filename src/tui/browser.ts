import { assemble } from '../client/assemble'
import { CATS } from '../client/categories'
import type { Translate } from '../client/i18n'
import type { Category, ContextHeaders, ContextTimeline, RequestRecord, Snapshot } from '../shared/types'
import { nodeLabel } from './model'

export interface BrowserItem {
  id: string
  label: string
  tokens: number
  source?: string
  err?: boolean
  /** The fold's preview (tool results carry none). */
  content?: string
}

export interface BrowserCategory {
  key: string
  slot: number
  tokens: number
  /** Change vs the previous step; null when there is none to compare with. */
  delta: number | null
  items: BrowserItem[]
}

export interface BrowserView {
  /** null = the live context (the next request). */
  seq: number | null
  categories: BrowserCategory[]
  /** Live nodes outside the served window, and a past step whose removed nodes outran retention. */
  missing: number
  approximate: boolean
}

type Figures = Snapshot['current'] | RequestRecord

function figure(figures: Figures, key: Category | 'system' | 'tools'): number {
  return figures[key] ?? 0
}

function itemsOf(timeline: ContextTimeline, headers: ContextHeaders | null, seq: number | null, t: Translate): {
  items: Map<string, BrowserItem[]>
  missing: number
  approximate: boolean
} {
  const asm = assemble(timeline, headers, seq)
  const items = new Map<string, BrowserItem[]>()
  const push = (key: string, item: BrowserItem): void => {
    const list = items.get(key)
    if (list === undefined) items.set(key, [item])
    else list.push(item)
  }
  if (asm.system !== null) push('system', { id: 'system', label: t('cat.system'), tokens: asm.system.tokens })
  const tools = asm.header?.tools.slice().sort((a, b) => b.tokens - a.tokens) ?? []
  for (const tool of tools) {
    push('tools', { id: 'tool:' + tool.name, label: tool.name, tokens: tool.tokens, ...(tool.plugin !== undefined ? { source: tool.plugin } : {}) })
  }
  for (const node of asm.nodes) {
    push(node.cat, {
      id: 'node:' + String(node.seq),
      label: nodeLabel(node),
      tokens: node.tokens,
      ...(node.err === true ? { err: true } : {}),
      ...(node.text !== undefined && node.text !== '' ? { content: node.text } : {}),
    })
  }
  return { items, missing: asm.missingLive, approximate: asm.approximate }
}

export function browserView(timeline: ContextTimeline, headers: ContextHeaders | null, seq: number | null, t: Translate): BrowserView {
  const requests = timeline.requests
  const found = seq === null ? -1 : requests.findIndex(r => r.seq === seq)
  const live = found < 0
  const index = live ? requests.length : found
  const current: Figures = live ? timeline.current : requests[index]
  const previous: Figures | undefined = index > 0 ? requests[index - 1] : undefined
  const { items, missing, approximate } = itemsOf(timeline, headers, live ? null : seq, t)
  return {
    seq: live ? null : seq,
    categories: CATS.map((c, slot) => ({
      key: c.key,
      slot,
      tokens: figure(current, c.key),
      delta: previous === undefined ? null : figure(current, c.key) - figure(previous, c.key),
      items: items.get(c.key) ?? [],
    })),
    missing,
    approximate,
  }
}

export const PREVIEW_INDENT = 4

/** Every row is exactly one terminal line: an expanded item's preview arrives pre-wrapped, one row per wrapped line, so the
 * scene windows and scrolls by physical lines. */
export type BrowserRow =
  | { kind: 'category'; id: string; category: BrowserCategory }
  | { kind: 'item'; id: string; item: BrowserItem }
  | { kind: 'line'; id: string; itemId: string; text: string }

export function browserRows(view: BrowserView, expanded: ReadonlySet<string>, wrap: (text: string) => string[]): BrowserRow[] {
  const rows: BrowserRow[] = []
  for (const category of view.categories) {
    const id = 'cat:' + category.key
    rows.push({ kind: 'category', id, category })
    if (!expanded.has(id)) continue
    for (const item of category.items) {
      rows.push({ kind: 'item', id: item.id, item })
      if (item.content === undefined || !expanded.has(item.id)) continue
      wrap(item.content).forEach((text, i) => rows.push({ kind: 'line', id: `${item.id}:${i}`, itemId: item.id, text }))
    }
  }
  return rows
}
