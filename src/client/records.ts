import type { ContextEventRecord, RequestRecord, TimelineCounts } from '../shared/types'

/** One bar per turn: a run of equal turns collapses to its LAST record (tagged `stepCount`), its `activeMs` the steps' SUM. */
export function aggregateByTurn(requests: RequestRecord[]): RequestRecord[] {
  const out: RequestRecord[] = []
  let runSteps = 0
  let runActiveMs = 0
  let runHasActiveMs = false
  for (const req of requests) {
    const last = out.length > 0 ? out[out.length - 1] : null
    if (last !== null && (last.turn ?? 0) === (req.turn ?? 0)) {
      runSteps++
      if (req.activeMs !== undefined) { runActiveMs += req.activeMs; runHasActiveMs = true }
      out[out.length - 1] = { ...req, stepCount: runSteps, ...(runHasActiveMs ? { activeMs: runActiveMs } : {}) }
    } else {
      runSteps = 1
      runActiveMs = req.activeMs ?? 0
      runHasActiveMs = req.activeMs !== undefined
      out.push({ ...req, stepCount: 1 })
    }
  }
  return out
}

/** Records without a turn stamp pool under 0; the getter answers 1 for a turn outside the list so a caller can never miss. */
export function turnStepsOf(requests: RequestRecord[]): (turn: number | undefined) => number {
  const counts = new Map<number, number>()
  for (const req of requests) {
    const turn = req.turn ?? 0
    counts.set(turn, (counts.get(turn) ?? 0) + 1)
  }
  return turn => counts.get(turn ?? 0) ?? 1
}

/** Each boundary event attaches to the first request logged after it; shared with the detail panel so both show the SAME event. */
export function attachMarkers(requests: RequestRecord[], events: ContextEventRecord[]): (ContextEventRecord | undefined)[] {
  const markers: (ContextEventRecord | undefined)[] = new Array<ContextEventRecord | undefined>(requests.length)
  for (const ev of events) {
    if (ev.kind !== 'compaction' && ev.kind !== 'prune') continue
    const i = boundaryIndex(requests, ev.seq)
    if (i >= 0 && markers[i] === undefined) markers[i] = ev
  }
  return markers
}

export function boundaryIndex(requests: RequestRecord[], seq: number): number {
  for (let i = 0; i < requests.length; i++) if (requests[i].seq >= seq) return i
  return -1
}

/** Inline counter derivation; the host's split-generation counts match it by construction (fold.ts buildTimelineHead). */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // Loaded skills: distinct names among skill-tagged injects — the host fold's tag set (`sub: 'skill'`).
  const skills = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
    if (ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '') skills.add(ev.name)
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes, skills: skills.size }
}
