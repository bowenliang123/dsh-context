/**
 * The browser's DNA mode: decompose an assembled context into ONE band per
 * item (the system prompt, every tool schema, every surface message) and
 * lay them out in the order the model actually reads them — the context's
 * "fingerprint" strip behind the composition bar's `dna` toggle.
 *
 * The order is PROMPT order, which is also the order items joined the
 * context: the system prompt and tool schemas prefix every request, so they
 * lead the strip; the message flow follows in seq (chronological) order.
 * The system band rides the timeline's own `systems` nodes (the prompt's real
 * surface positions), the tool bands their header epoch. The header epoch's
 * own seq is NOT usable as an ordering key: dsh appends `request/header` at
 * dispatch time of the first request that uses a header (agent.ts —
 * 'initial'/'resume'/'change'/'series'), a bookkeeping snapshot that lands
 * AFTER every message already in context. A mid-session refresh would
 * otherwise park the tools bands in the middle of the strip, behind the very
 * tool results those schemas describe. A refreshed epoch REPLACES the prefix
 * in place — the strip reflects that by keeping the current epoch's bands at
 * the front (the band's tooltip carries the epoch's time).
 */

import type { Category, SurfaceNode } from '../shared/types'
import type { Assembled } from './assemble'

/**
 * One band of the DNA strip. Header bands carry their tokens only; message
 * bands hand the node through so the label builder reads tool/form/skill
 * straight off it (the union discriminates on `cat` — no defensive guards).
 */
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
  // `assemble` guarantees seq order; zero-token items keep their band (the
  // bar drops zero widths, the reading order stays truthful).
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
