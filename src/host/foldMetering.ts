import type { CostBucketTotals, CostModelUsage, SessionCostUsage, TimingSpan, TimingTotals, ToolTimingTotals } from '../shared/types'
import { isDeepSeekProvider } from '../shared/providers'
import type { DecodeKind } from './logShapes'
import type { TimelineState } from './foldState'

export interface UsageLike {
  inputTokens?: unknown
  cacheReadTokens?: unknown
  cacheWriteTokens?: unknown
  outputTokens?: unknown
  reasoningTokens?: unknown
}

export type BilledUsage = CostBucketTotals

export function tokenCountOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.max(0, Math.round(value)) : null
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : null
  }
  return null
}

const BEIJING_OFFSET_MS = 8 * 3_600_000

export function isBeijingPeak(time: number): boolean {
  const at = new Date(time + BEIJING_OFFSET_MS)
  const day = at.getUTCDay()
  if (day === 0 || day === 6) return false
  const h = at.getUTCHours()
  return (h >= 9 && h < 12) || (h >= 14 && h < 18)
}

export function addBilledUsage(
  prev: SessionCostUsage | undefined,
  provider: string,
  model: string,
  time: number,
  usage: BilledUsage,
): SessionCostUsage {
  const period = isDeepSeekProvider(provider) && !isBeijingPeak(time) ? 'off' : 'peak'
  const models = prev?.[provider] ?? {}
  const periods = models[model] ?? {}
  const b = periods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
  const nextPeriods: CostModelUsage = { ...periods }
  nextPeriods[period] = {
    uncached: b.uncached + usage.uncached,
    cacheRead: b.cacheRead + usage.cacheRead,
    cacheWrite: b.cacheWrite + usage.cacheWrite,
    output: b.output + usage.output,
  }
  const nextModels: Record<string, CostModelUsage> = { ...models, [model]: nextPeriods }
  return { ...(prev ?? {}), [provider]: nextModels }
}

export function copyCostUsage(cost: SessionCostUsage): SessionCostUsage {
  const copy: SessionCostUsage = {}
  for (const provider in cost) {
    const models: Record<string, CostModelUsage> = {}
    for (const model in cost[provider]) {
      const periods = cost[provider][model]
      const modelCopy: CostModelUsage = {}
      if (periods.peak !== undefined) modelCopy.peak = { ...periods.peak }
      if (periods.off !== undefined) modelCopy.off = { ...periods.off }
      models[model] = modelCopy
    }
    copy[provider] = models
  }
  return copy
}

export function accumulateCost(st: TimelineState, time: number, usage: BilledUsage): void {
  const model = st.model
  if (model === undefined) return
  st.cost = addBilledUsage(st.cost, st.provider ?? '', model, time, usage)
}

const TOOL_TIMING_CAP = 16

export function durOf(from: number, to: number): number {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.max(0, to - from)
}

export function ensureTiming(st: TimelineState): TimingTotals {
  if (st.timing === undefined) {
    st.timing = { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolBusyMs: 0, toolCalls: 0, tools: {} }
  }
  return st.timing
}

const DECODE_FIELDS: Record<DecodeKind, { ms: 'reasoningMs' | 'textMs' | 'toolArgMs'; n: 'reasoningBlocks' | 'textBlocks' | 'toolArgBlocks' }> = {
  reasoning: { ms: 'reasoningMs', n: 'reasoningBlocks' },
  text: { ms: 'textMs', n: 'textBlocks' },
  toolarg: { ms: 'toolArgMs', n: 'toolArgBlocks' },
}

export function addDecodeSpan(timing: TimingTotals, kind: DecodeKind, ms: number): void {
  const field = DECODE_FIELDS[kind]
  timing[field.ms] = (timing[field.ms] ?? 0) + ms
  timing[field.n] = (timing[field.n] ?? 0) + 1
}

export function bumpToolTotals(timing: TimingTotals, name: string, ms: number): void {
  if (name === '__proto__') return
  if (!Object.hasOwn(timing.tools, name)) {
    if (Object.keys(timing.tools).length >= TOOL_TIMING_CAP) {
      let minKey = ''
      let minMs = Infinity
      for (const k in timing.tools) {
        if (timing.tools[k].ms < minMs) {
          minMs = timing.tools[k].ms
          minKey = k
        }
      }
      const kept: Record<string, ToolTimingTotals> = {}
      for (const k in timing.tools) {
        if (k !== minKey) kept[k] = timing.tools[k]
      }
      timing.tools = kept
    }
    timing.tools[name] = { calls: 1, ms }
    return
  }
  const cur = timing.tools[name]
  timing.tools[name] = { calls: cur.calls + 1, ms: cur.ms + ms }
}

export const IDLE_MIN_MS = 120_000

export interface IdleWindow {
  start: number
  end: number
}

export function idleGapWindows(beats: readonly number[], from: number, to: number, zoneStart: number): IdleWindow[] {
  const windows: IdleWindow[] = []
  let prev = from
  for (const t of beats) {
    if (!(t > prev) || !Number.isFinite(t)) continue
    if (t >= to) break
    pushIdleGap(windows, prev, t, zoneStart)
    prev = t
  }
  pushIdleGap(windows, prev, to, zoneStart)
  return windows
}

function pushIdleGap(windows: IdleWindow[], from: number, to: number, zoneStart: number): void {
  const idleFrom = Math.max(from, zoneStart)
  if (Number.isFinite(idleFrom) && to - idleFrom >= IDLE_MIN_MS) {
    windows.push({ start: idleFrom, end: to })
  }
}

export function mergeWindows(list: readonly IdleWindow[]): IdleWindow[] {
  const sorted = list
    .filter(w => Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start)
    .sort((a, b) => (a.start - b.start) || (a.end - b.end))
  const out: IdleWindow[] = []
  for (const window of sorted) {
    const last = out.at(-1)
    if (last !== undefined && window.start <= last.end) {
      if (window.end > last.end) last.end = window.end
      continue
    }
    out.push({ ...window })
  }
  return out
}

export function carveWindows(out: TimingSpan[], kind: TimingSpan['kind'], from: number, to: number, idle: readonly IdleWindow[]): number {
  if (!(to > from)) return 0
  let cursor = from
  let carved = 0
  for (const window of idle) {
    if (window.end <= cursor) continue
    if (window.start >= to) break
    const a = Math.max(cursor, window.start)
    if (a > cursor) out.push({ kind, start: cursor, end: a })
    const b = Math.min(to, window.end)
    carved += b - a
    cursor = Math.max(cursor, b)
    if (cursor >= to) break
  }
  if (to > cursor) out.push({ kind, start: cursor, end: to })
  return carved
}
