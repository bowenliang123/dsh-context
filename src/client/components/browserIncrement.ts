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
  removed: Record<IncrementCat, number>
  tokenUp: Record<IncrementCat, number>
  tokenDown: Record<IncrementCat, number>
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
  const removed = zeroCounts()
  const tokenUp = zeroCounts()
  const tokenDown = zeroCounts()
  const remove = (cat: IncrementCat, amount: number): void => {
    removed[cat] += 1
    tokenDown[cat] += amount
  }
  const change = (cat: IncrementCat, d: number): void => {
    if (d > 0) tokenUp[cat] += d
    else if (d < 0) tokenDown[cat] -= d
  }
  const add = (cat: IncrementCat, amount: number): void => {
    tokens[cat] += amount
    tokenUp[cat] += amount
  }
  for (const n of view.nodes) {
    while (baseAt < baseNodes.length && baseNodes[baseAt].seq < n.seq) {
      const gone = baseNodes[baseAt]
      baseAt += 1
      remove(gone.cat, gone.tokens)
    }
    if (baseAt < baseNodes.length && baseNodes[baseAt].seq === n.seq) {
      const before = baseNodes[baseAt]
      baseAt += 1
      change(n.cat, n.tokens - before.tokens)
      continue
    }
    nodes.push(n)
    ;(byCat[n.cat] ??= []).push(n)
    seqs.add(n.seq)
    counts[n.cat] += 1
    add(n.cat, n.tokens)
  }
  while (baseAt < baseNodes.length) {
    const gone = baseNodes[baseAt]
    baseAt += 1
    remove(gone.cat, gone.tokens)
  }
  const baseSystem = base?.system ?? null
  const system = view.system
  if (system !== null) {
    if (baseSystem === null) {
      counts.system = 1
      add('system', system.tokens)
    } else {
      change('system', system.tokens - baseSystem.tokens)
    }
  } else if (baseSystem !== null) {
    remove('system', baseSystem.tokens)
  }
  const baseTools = new Map<string, number>()
  for (const tool of base?.header?.tools ?? []) baseTools.set(tool.name, tool.tokens)
  const tools: HeaderTool[] = []
  const toolNames = new Set<string>()
  for (const tool of view.header?.tools ?? []) {
    const before = baseTools.get(tool.name)
    if (before !== undefined) {
      baseTools.delete(tool.name)
      change('tools', tool.tokens - before)
      continue
    }
    tools.push(tool)
    toolNames.add(tool.name)
    add('tools', tool.tokens)
  }
  for (const tokensBefore of baseTools.values()) remove('tools', tokensBefore)
  counts.tools = tools.length
  const header = tools.length > 0 && view.header !== null ? { ...view.header, tools } : null
  const parts = CATS.map(c => ({ key: c.key, color: c.color, value: tokens[c.key] }))
  let total = 0
  for (const c of CATS) total += tokens[c.key]
  const addedSystem = system !== null && baseSystem === null
  return {
    nodes,
    byCat,
    seqs,
    system: addedSystem ? system : null,
    tools,
    toolNames,
    header,
    counts,
    tokens,
    removed,
    tokenUp,
    tokenDown,
    parts,
    items: nodes.length + tools.length + (addedSystem ? 1 : 0),
    total,
  }
}

export function incrementHas(inc: Increment, key: string): boolean {
  if (key === 'sys') return inc.system !== null
  if (key === 'tools') return inc.tools.length > 0
  if (key.startsWith('tool:')) return inc.toolNames.has(key.slice(5))
  return key.startsWith('n') && inc.seqs.has(Number(key.slice(1)))
}
