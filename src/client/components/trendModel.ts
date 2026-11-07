import type { Category, ContextEventRecord, RequestRecord } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

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

export function turnStepsOf(requests: RequestRecord[]): (turn: number | undefined) => number {
  const counts = new Map<number, number>()
  for (const req of requests) {
    const turn = req.turn ?? 0
    counts.set(turn, (counts.get(turn) ?? 0) + 1)
  }
  return turn => counts.get(turn ?? 0) ?? 1
}

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

export function jumpTargetOf(requests: RequestRecord[], seq: number): RequestRecord | null {
  for (const req of requests) if (req.seq === seq) return req
  return requests.length > 0 ? requests[0] : null
}

export const TURN_FILLS = [
  'color-mix(in srgb, var(--color-neutral-500) 12%, transparent)',
  'color-mix(in srgb, var(--color-neutral-500) 26%, transparent)',
]

function focusOf(req: RequestRecord, cat: string): RequestRecord {
  const key = cat as Category | 'system' | 'tools'
  const out: RequestRecord = { ...req }
  const v = req[key] || 0
  out.total = v
  for (const c of CATS) out[c.key] = c.key === key ? v : 0
  return out
}

function deltaOf(req: RequestRecord, prev: RequestRecord | null): RequestRecord {
  const { prompt: _prompt, output: _output, ...out } = req
  let churn = 0
  let net = 0
  for (const c of CATS) {
    const d = prev !== null ? (req[c.key] || 0) - (prev[c.key] || 0) : 0
    out[c.key] = d
    churn += Math.abs(d)
    net += d
  }
  out.total = churn
  out.net = net
  return out
}

export function preprocessTrend(
  requests: RequestRecord[],
  delta: boolean,
  focusCat: string | null | undefined,
): { requests: RequestRecord[]; focus: string | null } {
  const focus = focusCat !== null && focusCat !== undefined && CATS.some(c => c.key === focusCat) ? focusCat : null
  const base = focus !== null ? requests.map(req => focusOf(req, focus)) : requests
  return { requests: delta ? base.map((req, i) => deltaOf(req, i > 0 ? base[i - 1] : null)) : base, focus }
}

export function trendMaxima(requests: RequestRecord[], delta: boolean): { maxTotal: number; maxUp: number; maxDown: number } {
  let maxTotal = 1
  let maxUp = 0
  let maxDown = 0
  if (delta) {
    for (const req of requests) {
      let up = 0
      let down = 0
      for (const c of CATS) {
        const d = req[c.key] || 0
        if (d > 0) up += d
        else down -= d
      }
      if (up > maxUp) maxUp = up
      if (down > maxDown) maxDown = down
    }
  } else {
    for (const req of requests) if (req.total > maxTotal) maxTotal = req.total
  }
  return { maxTotal, maxUp, maxDown }
}

export function trendTipRows(
  kit: Pick<ViewKit, 't' | 'fmt' | 'fmtDuration' | 'catLabel'>,
  opts: {
    granularity: 'step' | 'turn'
    stepsOf: (turn: number | undefined) => number
    delta: boolean
    focus: string | null
    durationOn: boolean
    metric?: string
  },
  req: RequestRecord,
): string[] {
  const { t, fmt, fmtDuration, catLabel } = kit
  const n = req.stepCount ?? 1
  const head = opts.granularity === 'turn'
    ? (n > 1 ? t('tip.turn', { t: req.turn ?? 0, n }) : t('tip.turn1', { t: req.turn ?? 0 }))
    : t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0, n: opts.stepsOf(req.turn) })
  let metric = opts.metric
  if (metric === undefined) {
    if (opts.delta) {
      /* v8 ignore next 1 */
      metric = t('tip.delta', { n: (req.net ?? 0) > 0 ? '+' + fmt(req.net ?? 0) : fmt(req.net ?? 0) })
    } else {
      metric = opts.focus !== null
        ? t('tip.cat', { cat: catLabel(opts.focus), n: fmt(req.total) })
        : t('tip.total', { n: fmt(req.total) })
    }
  }
  const rows = [head, metric]
  if (opts.durationOn && req.activeMs !== undefined) rows.push(t('tip.duration', { n: fmtDuration(req.activeMs) }))
  return rows
}
