/**
 * Step brief — the semantic identity of one history bar ("what this step was
 * about"), derived CLIENT-SIDE from the timeline's served nodes; no host or
 * wire additions. A request record's seq IS its response's surface seq (the
 * fold logs both on the same assistant/message event), so:
 *
 *   response node = the node at exactly req.seq
 *   step inputs   = nodes with (previous bar's seq) < seq < req.seq
 *   turn opener   = the newest user message before this turn's first bar
 *
 * Coverage degrades silently: steps older than the nodes/archive retention
 * window simply yield no rows.
 */

import type { ContextTimeline, RequestRecord, SurfaceNode } from '../shared/types'

export interface StepBrief {
  /** The user message that opened this turn (absent when outside retention). */
  opener?: SurfaceNode
  /** Nodes that entered the context since the previous bar (mid-turn steps only). */
  inputs: SurfaceNode[]
  /** This bar's own response node. */
  response?: SurfaceNode
}

/** Every served node (live tail + removed archive copies), seq-sorted. */
export function briefNodes(data: ContextTimeline): SurfaceNode[] {
  return [...data.nodes, ...data.archive].sort((a, b) => a.seq - b.seq)
}

/** First index whose node seq is >= `seq` (lower bound over the sorted list). */
function lowerBound(nodes: SurfaceNode[], seq: number): number {
  let lo = 0
  let hi = nodes.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (nodes[mid].seq < seq) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Derive the brief for `requests[idx]` (the DISPLAY list — step records or
 * turn aggregates; a turn aggregate is always a turn start, so its inputs row
 * stays hidden and the opener/response carry the narrative).
 */
export function briefOf(nodes: SurfaceNode[], requests: RequestRecord[], idx: number): StepBrief | null {
  if (idx < 0 || idx >= requests.length) return null
  const req = requests[idx]
  const ri = lowerBound(nodes, req.seq)
  const hit = ri < nodes.length && nodes[ri].seq === req.seq ? nodes[ri] : undefined
  const response = hit !== undefined && hit.cat === 'assistant' ? hit : undefined

  const turnStart = idx === 0 || (requests[idx - 1].turn ?? 0) !== (req.turn ?? 0)

  // Opener: the newest user message in (previous turn's last bar seq, this
  // turn's first bar seq) — user messages only land at turn starts.
  let firstIdx = idx
  while (firstIdx > 0 && (requests[firstIdx - 1].turn ?? 0) === (req.turn ?? 0)) firstIdx--
  const upper = requests[firstIdx].seq
  const lower = firstIdx > 0 ? requests[firstIdx - 1].seq : -1
  let opener: SurfaceNode | undefined
  for (let i = lowerBound(nodes, upper) - 1; i >= 0; i--) {
    const n = nodes[i]
    if (n.seq <= lower) break
    if (n.cat === 'user') { opener = n; break }
  }

  const inputs: SurfaceNode[] = []
  if (!turnStart) {
    // idx > 0 here (a first bar is always a turn start): collect everything that landed since the previous bar.
    const prevSeq = requests[idx - 1].seq
    for (let i = lowerBound(nodes, prevSeq + 1); i < nodes.length && nodes[i].seq < req.seq; i++) {
      inputs.push(nodes[i])
    }
  }
  return { opener, inputs, response }
}

/**
 * seq → one-line reply preview for the chart tooltip: the response node's
 * text, else its tool-call breadcrumb. Absent for usage-only replies and
 * steps outside retention.
 */
export function replyTipsOf(nodes: SurfaceNode[]): Map<number, string> {
  const m = new Map<number, string>()
  for (const n of nodes) {
    if (n.cat !== 'assistant') continue
    const s = n.text ?? (n.calls !== undefined ? n.calls.join(' › ') : '')
    if (s !== '') m.set(n.seq, s)
  }
  return m
}
