import { billedParts, RING_ORDER } from './categories'
import { estimateSessionCost, mergeCostUsage } from './cost'
import type { CostCurrency, ModelBook } from './cost'
import { cacheHitPercent } from './format'
import { turnsOf, usageTotalsOf, windowTotalsOf, type RangeWindow } from './overviewQuery'
import type { OverviewRow } from './overviewModel'
import { asRecord, numOf } from './wire'
import type { ContextActivity, SessionCostUsage, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export function timingSumOf(rows: readonly OverviewRow[]): TimingTotals | null {
  let out: TimingTotals | null = null
  let toolBusyComplete = true
  for (const row of rows) {
    for (const member of row.family) {
      const t = member?.timing
      if (t === undefined) continue
      if (t.toolBusyMs === undefined) toolBusyComplete = false
      if (out === null) {
        out = { ...t, tools: { ...t.tools } }
        continue
      }
      out.wallMs += t.wallMs
      out.ttftMs += t.ttftMs
      out.genMs += t.genMs
      out.calls += t.calls
      out.toolsMs += t.toolsMs
      out.toolCalls += t.toolCalls
      addOptionalOf(out, t, 'reasoningMs')
      addOptionalOf(out, t, 'reasoningBlocks')
      addOptionalOf(out, t, 'textMs')
      addOptionalOf(out, t, 'textBlocks')
      addOptionalOf(out, t, 'toolArgMs')
      addOptionalOf(out, t, 'toolArgBlocks')
      addOptionalOf(out, t, 'toolBusyMs')
      addOptionalOf(out, t, 'idleMs')
      addOptionalOf(out, t, 'speedTokens')
      addOptionalOf(out, t, 'speedMs')
      for (const name of Object.keys(t.tools)) {
        const tool = t.tools[name]
        const outTools: Record<string, ToolTimingTotals | undefined> = out.tools
        const prev = outTools[name]
        out.tools[name] = prev === undefined ? { ...tool } : { calls: prev.calls + tool.calls, ms: prev.ms + tool.ms }
      }
    }
  }
  if (out !== null && !toolBusyComplete) delete out.toolBusyMs
  return out
}

function addOptionalOf(target: TimingTotals, source: TimingTotals, key: OptionalTimingKey): void {
  const a = target[key]
  const b = source[key]
  if (a !== undefined || b !== undefined) target[key] = (a ?? 0) + (b ?? 0)
}

type OptionalTimingKey = 'reasoningMs' | 'reasoningBlocks' | 'textMs' | 'textBlocks'
  | 'toolArgMs' | 'toolArgBlocks' | 'toolBusyMs' | 'idleMs' | 'speedTokens' | 'speedMs'

export interface TokenPartTotal {
  key: string
  color: string
  value: number
}

export function tokenPartsOf(
  rows: readonly OverviewRow[],
  scope?: RangeWindow,
): { parts: TokenPartTotal[]; total: number } | null {
  const sums = new Map<string, TokenPartTotal>()
  let total = 0
  let any = false
  for (const row of rows) {
    for (let index = 0; index < row.family.length; index++) {
      const member = row.family[index]
      if (member === null) continue
      const memberUsage = scope === undefined
        ? member.cost
        : row.familyActivity === undefined
          ? null
          : windowTotalsOf(row.familyActivity[index] ?? null, scope).usage
      const totals = usageTotalsOf(memberUsage)
      if (totals === null) continue
      any = true
      const usage: TokenUsage = {
        uncachedInputTokens: totals.input,
        cacheReadTokens: totals.cacheRead,
        cacheWriteTokens: totals.cacheWrite,
        outputTokens: totals.output,
      }
      for (const part of billedParts(member.current, null, usage, {
        reasoning: member.generatedReasoning,
        answers: member.generatedAnswerTokens,
        calls: member.generatedCallTokens,
      })) {
        if (!Number.isFinite(part.value) || part.value <= 0) continue
        total += part.value
        const sumsGet: Map<string, TokenPartTotal | undefined> = sums
        const prev = sumsGet.get(part.key)
        sums.set(part.key, prev === undefined
          ? { key: part.key, color: part.color, value: part.value }
          : { ...prev, value: prev.value + part.value })
      }
    }
  }
  if (!any) return null
  return { parts: [...sums.values()].sort((a, b) => RING_ORDER.indexOf(a.key) - RING_ORDER.indexOf(b.key)), total }
}

interface OverviewKpis {
  sessions: number
  tokens: number
  turns: number
  cost: number | null
  costSessions: number
  cacheHit: string | null
  usageSessions: number
  tokenParts: { parts: TokenPartTotal[]; total: number } | null
  timing: TimingTotals | null
}

export function kpisOf(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  scope?: RangeWindow,
): OverviewKpis {
  let usage: SessionCostUsage | null = null
  let turns = 0
  let costSessions = 0
  let usageSessions = 0
  const open = scope === undefined || (scope.start === null && scope.end === null)
  for (const row of rows) {
    const windowTotals = scope !== undefined && row.activity !== null ? windowTotalsOf(row.activity, scope) : null
    const rowUsage = windowTotals !== null ? windowTotals.usage : open ? row.familyCost : null
    usage = mergeCostUsage(usage, rowUsage)
    if (windowTotals !== null && !open) turns += windowTotals.turns
    else if (open) {
      for (const member of row.family) turns += turnsOf(member)
    }
    if (estimateSessionCost(rowUsage, book, currency) !== null) costSessions++
    if (usageTotalsOf(rowUsage) !== null) usageSessions++
  }
  const totals = usageTotalsOf(usage)
  return {
    sessions: rows.length,
    tokens: totals?.total ?? 0,
    turns,
    cost: estimateSessionCost(usage, book, currency),
    costSessions,
    cacheHit: totals === null ? null : cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite),
    usageSessions,
    tokenParts: tokenPartsOf(rows, scope),
    timing: timingSumOf(rows),
  }
}

export interface DayTotals {
  tokens: number
  requests: number
  sessions: number
  cost: number | null
}

export function aggregateDays(
  rows: readonly OverviewRow[],
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): Record<string, DayTotals> {
  return new DayAggregator().aggregate(rows, book, currency)
}

interface MutableDay {
  tokens: number
  requests: number
  sessions: number
  cost: SessionCostUsage
}

function emptyCost(): SessionCostUsage {
  return {}
}

function addCost(target: SessionCostUsage, source: SessionCostUsage, sign: 1 | -1): void {
  for (const provider of Object.keys(source)) {
    const models = asRecord(source[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = target[provider] ?? (target[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const targetPeriods = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = targetPeriods[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        const next = {
          uncached: prev.uncached + sign * numOf(bucket.uncached),
          cacheRead: prev.cacheRead + sign * numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + sign * numOf(bucket.cacheWrite),
          output: prev.output + sign * numOf(bucket.output),
        }
        const carried = numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output) > 0
        if (sign < 0 && carried && next.uncached === 0 && next.cacheRead === 0 && next.cacheWrite === 0 && next.output === 0) {
          Reflect.deleteProperty(targetPeriods, period)
          if (Object.keys(targetPeriods).length === 0) Reflect.deleteProperty(branch, model)
          if (Object.keys(branch).length === 0) Reflect.deleteProperty(target, provider)
        } else {
          targetPeriods[period] = next
        }
      }
    }
  }
}

export class DayAggregator {
  private readonly rows = new Map<OverviewRow, ContextActivity | null>()
  private readonly days = new Map<string, MutableDay>()
  private readonly values = new Map<string, DayTotals>()
  private lastRows: readonly OverviewRow[] | null = null
  private lastBook: ModelBook | null | undefined
  private lastCurrency: CostCurrency | undefined
  private last: Record<string, DayTotals> | null = null

  aggregate(
    rows: readonly OverviewRow[],
    book: ModelBook | null | undefined,
    currency: CostCurrency,
  ): Record<string, DayTotals> {
    if (rows === this.lastRows && book === this.lastBook && currency === this.lastCurrency && this.last !== null) {
      return this.last
    }
    const seen = new Set<OverviewRow>()
    let changed = false
    for (const row of rows) {
      seen.add(row)
      const prev = this.rows.get(row)
      if (prev === row.activity) continue
      if (prev !== undefined) this.addActivity(prev, -1)
      this.addActivity(row.activity, 1)
      this.rows.set(row, row.activity)
      changed = true
    }
    for (const [row, activity] of this.rows) {
      if (seen.has(row)) continue
      this.rows.delete(row)
      this.addActivity(activity, -1)
      changed = true
    }
    if (book !== this.lastBook || currency !== this.lastCurrency) {
      this.values.clear()
      this.lastBook = book
      this.lastCurrency = currency
      changed = true
    }
    if (!changed && this.last !== null) {
      this.lastRows = rows
      return this.last
    }
    const out: Record<string, DayTotals> = {}
    for (const [key, day] of this.days) {
      if (day.tokens <= 0 && day.requests <= 0) {
        this.days.delete(key)
        this.values.delete(key)
        continue
      }
      let value = this.values.get(key)
      if (value === undefined) {
        value = {
          tokens: day.tokens,
          requests: day.requests,
          sessions: day.sessions,
          cost: estimateSessionCost(day.cost, book, currency),
        }
        this.values.set(key, value)
      }
      out[key] = value
    }
    this.lastRows = rows
    this.last = out
    return out
  }

  private addActivity(activity: ContextActivity | null, sign: 1 | -1): void {
    if (activity === null) return
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      if (entry.tokens <= 0 && entry.requests <= 0) continue
      let day = this.days.get(key)
      if (day === undefined) {
        /* v8 ignore next 1 */
        if (sign < 0) continue
        day = { tokens: 0, requests: 0, sessions: 0, cost: emptyCost() }
        this.days.set(key, day)
      }
      day.tokens += sign * entry.tokens
      day.requests += sign * entry.requests
      day.sessions += sign
      if (entry.cost !== undefined) addCost(day.cost, entry.cost, sign)
      this.values.delete(key)
    }
  }
}
