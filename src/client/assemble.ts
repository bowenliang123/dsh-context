/** Per-step context assembly — the pure reconstruction behind the Context browser card. A request record
 * was snapshotted by the Host exactly as dispatched: header in force plus the model-visible surface
 * BEFORE the response landed. Coverage is honest: when the served window cannot contain the full answer
 * (older live nodes dropped, removals past archive retention), the result carries the flags the UI turns into notices. */

import type { ContextHeaders, ContextTimeline, HeaderRecord, SurfaceNode, SystemPromptNode } from '../shared/types'

export interface Assembled {
  live: boolean
  header: HeaderRecord | null
  /** Resolved from the timeline's live `systems` nodes; on rows folded before that field existed, the
   *  header epoch's own envelope figure stands in. */
  system: SystemPromptNode | null
  nodes: SurfaceNode[]
  missingLive: number
  approximate: boolean
}

export function headerAt(headers: ContextHeaders | null, seq: number | null): HeaderRecord | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

/** The LAST live system node at or before `seq` carrying tokens — exactly the host fold's "last nonempty
 * surviving system" rule, so it agrees with the per-step `system` figure the fold recorded. Rows folded
 * before `systems` existed fall back to the header epoch's figure. */
export function systemAt(
  data: ContextTimeline,
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

export function assemble(data: ContextTimeline, headers: ContextHeaders | null, seq: number | null): Assembled {
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
  // Model-visible order: a replacement node carries the seat of the range it replaced, every other node its log
  // seq. Past-step archive copies ride the same key, so their interleaving stays truthful too.
  nodes.sort((a, b) => (a.seat ?? a.seq) - (b.seat ?? b.seq))

  let missingLive = 0
  if (data.droppedNodes > 0) {
    // Live: every dropped live node is part of the current context. A past step: the dropped slice sits at
    // or below `surfaceFloor`, so only a step after it is flagged (an older step's subset is not overstated).
    if (live || (data.surfaceFloor !== undefined && seq > data.surfaceFloor)) {
      missingLive = data.droppedNodes
    }
  }
  const approximate = !live
    && data.archiveFloor !== undefined
    && seq < data.archiveFloor

  const header = headerAt(headers, seq)
  return { live, header, system: systemAt(data, header, seq), nodes, missingLive, approximate }
}
