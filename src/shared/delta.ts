import type { Category, HeaderRecord, HeaderTool, SurfaceNode, SystemPromptNode } from './types'
import type { Assembled } from './assemble'
import { CATS } from './categories'
import type { Increment, IncrementCat } from './increment'

export interface ContextDelta {
  added: SurfaceNode[]
  viewNodes: SurfaceNode[]
  viewHeader: HeaderRecord | null
  viewSystem: SystemPromptNode | null
  system: SystemPromptNode | null
  tools: HeaderTool[]
  header: HeaderRecord | null
  counts: Record<IncrementCat, number>
  tokens: Record<IncrementCat, number>
  removedCounts: Record<IncrementCat, number>
  tokenUp: Record<IncrementCat, number>
  tokenDown: Record<IncrementCat, number>
  items: number
  total: number
}

export function contextDeltaOf(inc: Increment, view: Assembled): ContextDelta {
  return {
    added: inc.nodes,
    viewNodes: view.nodes,
    viewHeader: view.header,
    viewSystem: view.system,
    system: inc.system,
    tools: inc.tools,
    header: inc.header,
    counts: inc.counts,
    tokens: inc.tokens,
    removedCounts: inc.removed,
    tokenUp: inc.tokenUp,
    tokenDown: inc.tokenDown,
    items: inc.items,
    total: inc.total,
  }
}

export function incrementOfDelta(delta: ContextDelta): Increment {
  const byCat: Partial<Record<Category, SurfaceNode[]>> = {}
  for (const node of delta.added) (byCat[node.cat] ??= []).push(node)
  return {
    nodes: delta.added,
    byCat,
    seqs: new Set(delta.added.map(node => node.seq)),
    system: delta.system,
    tools: delta.tools,
    toolNames: new Set(delta.tools.map(tool => tool.name)),
    header: delta.header,
    counts: delta.counts,
    tokens: delta.tokens,
    removed: delta.removedCounts,
    tokenUp: delta.tokenUp,
    tokenDown: delta.tokenDown,
    parts: CATS.map(cat => ({ key: cat.key, color: cat.color, value: delta.tokens[cat.key] })),
    items: delta.items,
    total: delta.total,
  }
}
