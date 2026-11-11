import type { Category, HeaderRecord, HeaderTool, SurfaceNode, SystemPromptNode } from '../../shared/types'
import type { Assembled } from '../assemble'
import { CATS } from '../categories'
import type { PartsPart } from '../categories'

export type IncrementCat = Category | 'system' | 'tools'

export interface Increment {
  nodes: SurfaceNode[]
  byCat: Partial<Record<Category, SurfaceNode[]>>
  seqs: ReadonlySet<number>
  system: SystemPromptNode | null
  tools: HeaderTool[]
  toolNames: ReadonlySet<string>
  header: HeaderRecord | null
  counts: Record<IncrementCat, number>
  tokens: Record<IncrementCat, number>
  parts: PartsPart[]
  items: number
  total: number
}

const ZERO_COUNTS = Object.fromEntries(CATS.map(c => [c.key, 0])) as Record<IncrementCat, number>

function zeroCounts(): Record<IncrementCat, number> {
  return { ...ZERO_COUNTS }
}

export function incrementOf(view: Assembled, base: Assembled | null): Increment {
  const baseNodes = base?.nodes ?? []
  let baseAt = 0
  const nodes: SurfaceNode[] = []
  const byCat: Partial<Record<Category, SurfaceNode[]>> = {}
  const seqs = new Set<number>()
  const counts = zeroCounts()
  const tokens = zeroCounts()
  for (const n of view.nodes) {
    while (baseAt < baseNodes.length && baseNodes[baseAt].seq < n.seq) baseAt++
    if (baseAt < baseNodes.length && baseNodes[baseAt].seq === n.seq) {
      baseAt++
      continue
    }
    nodes.push(n)
    ;(byCat[n.cat] ??= []).push(n)
    seqs.add(n.seq)
    counts[n.cat] += 1
    tokens[n.cat] += n.tokens
  }
  const system = view.system !== null && (base === null || base.system === null) ? view.system : null
  if (system !== null) {
    counts.system = 1
    tokens.system = system.tokens
  }
  const baseTools = new Set<string>()
  for (const tool of base?.header?.tools ?? []) baseTools.add(tool.name)
  const tools: HeaderTool[] = []
  const toolNames = new Set<string>()
  for (const tool of view.header?.tools ?? []) {
    if (baseTools.has(tool.name)) continue
    tools.push(tool)
    toolNames.add(tool.name)
    tokens.tools += tool.tokens
  }
  counts.tools = tools.length
  const header = tools.length > 0 && view.header !== null ? { ...view.header, tools } : null
  const parts = CATS.map(c => ({ key: c.key, color: c.color, value: tokens[c.key] }))
  let total = 0
  for (const c of CATS) total += tokens[c.key]
  return {
    nodes,
    byCat,
    seqs,
    system,
    tools,
    toolNames,
    header,
    counts,
    tokens,
    parts,
    items: nodes.length + tools.length + (system === null ? 0 : 1),
    total,
  }
}

export function incrementHas(inc: Increment, key: string): boolean {
  if (key === 'sys') return inc.system !== null
  if (key === 'tools') return inc.tools.length > 0
  if (key.startsWith('tool:')) return inc.toolNames.has(key.slice(5))
  return key.startsWith('n') && inc.seqs.has(Number(key.slice(1)))
}
