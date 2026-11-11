import type { ContextHeaders, HeaderRecord, SurfaceNode, SystemPromptNode } from './types'

export interface Assembled {
  live: boolean
  header: HeaderRecord | null
  system: SystemPromptNode | null
  nodes: SurfaceNode[]
  missingLive: number
  approximate: boolean
}

export interface AssembleSource {
  nodes: SurfaceNode[]
  archive: SurfaceNode[]
  systems?: SystemPromptNode[]
  droppedNodes?: number
  surfaceFloor?: number
  archiveFloor?: number
}

export function headerAt(headers: ContextHeaders | null, seq: number | null): HeaderRecord | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

export function systemAt(
  data: Pick<AssembleSource, 'systems'>,
  header: HeaderRecord | null,
  seq: number | null,
): SystemPromptNode | null {
  const systems = data.systems
  if (systems !== undefined && systems.length > 0) {
    for (let i = systems.length - 1; i >= 0; i--) {
      const node = systems[i]
      if (node.tokens <= 0) continue
      if (seq === null || node.seq < seq) return node
    }
    return null
  }
  return header !== null && header.systemTokens !== undefined
    ? { seq: header.seq, time: header.time, tokens: header.systemTokens }
    : null
}

export function assemble(data: AssembleSource, headers: ContextHeaders | null, seq: number | null): Assembled {
  const live = seq === null
  let nodes: SurfaceNode[]
  if (live) {
    nodes = data.nodes.slice()
  } else {
    const picked: SurfaceNode[] = []
    for (const n of data.nodes) {
      if (n.seq < seq) picked.push(n)
    }
    for (const n of data.archive) {
      if (n.seq < seq && n.gone !== undefined && n.gone > seq) picked.push(n)
    }
    nodes = picked
  }
  nodes.sort((a, b) => a.seq - b.seq)

  const droppedNodes = data.droppedNodes ?? 0
  let missingLive = 0
  if (droppedNodes > 0) {
    if (live || (data.surfaceFloor !== undefined && seq > data.surfaceFloor)) {
      missingLive = droppedNodes
    }
  }
  const approximate = !live
    && data.archiveFloor !== undefined
    && seq < data.archiveFloor

  const header = headerAt(headers, seq)
  return { live, header, system: systemAt(data, header, seq), nodes, missingLive, approximate }
}
