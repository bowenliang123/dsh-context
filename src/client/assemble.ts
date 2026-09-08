/**
 * Per-step context assembly — the pure reconstruction behind the Context
 * browser card.
 *
 * A request record R was snapshotted by the Host exactly as dispatched:
 * header in force + the model-visible surface BEFORE the response landed.
 * Given the timeline's live `nodes` (newest tail) and `archive` (removed
 * nodes stamped with `gone`), the surface assembled into R is:
 *
 *   every node with seq < R.seq AND (gone undefined OR gone > R.seq)
 *
 * For the LIVE view (the next request's context) it is simply the current
 * live nodes. Coverage is honest: when the served window cannot contain the
 * full answer (older live nodes dropped, or removals older than the archive
 * retention), the result carries the flags the UI turns into notices.
 */

import type { ContextHeaders, ContextTimeline, HeaderRecord, SurfaceNode, SystemPromptNode } from '../shared/types'

export interface Assembled {
  /** True when browsing the live surface (the next request's context). */
  live: boolean
  /** The header epoch in force (null = headers projection absent or none yet). */
  header: HeaderRecord | null
  /**
   * The system prompt in force at the shown step (null = none), resolved from
   * the timeline's live `systems` nodes; on rows folded before that field
   * existed the header epoch's own envelope figure stands in.
   */
  system: SystemPromptNode | null
  /** The assembled surface messages, in seq order. */
  nodes: SurfaceNode[]
  /** Live nodes outside the served window that are also part of the context. */
  missingLive: number
  /** True when removals this step depends on may exceed archive retention. */
  approximate: boolean
}

/** The header epoch in force at `seq` (last logged before it), or the newest. */
export function headerAt(headers: ContextHeaders | null, seq: number | null): HeaderRecord | null {
  if (headers === null || headers.headers.length === 0) return null
  if (seq === null) return headers.headers[headers.headers.length - 1]
  for (let i = headers.headers.length - 1; i >= 0; i--) {
    if (headers.headers[i].seq < seq) return headers.headers[i]
  }
  return null
}

/**
 * The system prompt in force at `seq` (null = none) — the LAST live system
 * node at or before it carrying tokens, which is exactly the host fold's
 * "last nonempty surviving system" rule and therefore agrees with the
 * per-step `system` figure the fold recorded. Rows folded before `systems`
 * existed carry none; the header epoch's envelope figure stands in for them
 * (the pre-V3 wire shape).
 */
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
  nodes.sort((a, b) => a.seq - b.seq)

  let missingLive = 0
  if (data.droppedNodes > 0) {
    // Live: every dropped live node is part of the current context. A past
    // step: the dropped slice sits at or below `surfaceFloor`, so a step
    // after it contains them all (an older step's unknown subset is left
    // unflagged rather than overstated).
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
