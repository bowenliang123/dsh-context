import { formatCost } from '../client/cost'
import { cacheHitPercent, fmt, fmtDuration } from '../client/format'
import type { Translate } from '../client/i18n'
import { usageTotalsOf } from '../client/overview'
import { countsOfRecords } from '../client/records'
import type { ContextTimeline } from '../shared/types'
import type { HostUsage } from './detect'

export interface StatRow {
  label: string
  value: string
}

export function sessionRows(timeline: ContextTimeline, t: Translate): StatRow[] {
  const counts = timeline.counts ?? countsOfRecords(timeline.requests, timeline.events)
  return [
    { label: t('stats.turns'), value: fmt(counts.turns) },
    { label: t('stats.steps'), value: fmt(counts.steps) },
    { label: t('stats.answers'), value: fmt(timeline.answers ?? 0) },
    { label: t('stats.humanInputs'), value: fmt(timeline.humanInputs ?? 0) },
    { label: t('stats.toolCalls'), value: fmt(timeline.toolCalls ?? 0) },
    { label: t('stats.skills'), value: fmt(counts.skills ?? 0) },
    { label: t('kind.inject'), value: fmt(counts.injects) },
    { label: t('kind.compaction'), value: fmt(counts.compactions) },
    { label: t('kind.prune'), value: fmt(counts.prunes) },
  ]
}

/** Billed buckets from the fold's own cost record; the cost figure is the host's, so it matches the host's `/tokens`. */
export function tokenRows(timeline: ContextTimeline, usage: HostUsage, t: Translate): StatRow[] {
  const rows: StatRow[] = []
  const totals = usageTotalsOf(timeline.cost)
  if (totals !== null) {
    const hit = cacheHitPercent(totals.cacheRead, totals.input + totals.cacheRead + totals.cacheWrite)
    rows.push(
      { label: t('stats.costMiss'), value: fmt(totals.input) },
      { label: t('stats.costHit'), value: fmt(totals.cacheRead) },
      { label: t('stats.costWrite'), value: fmt(totals.cacheWrite) },
      { label: t('stats.costOut'), value: fmt(totals.output) },
      { label: t('tokens.total'), value: fmt(totals.total) },
      { label: t('stats.cacheHit'), value: hit === null ? '—' : `${hit}%` },
    )
  }
  const cost = usage.cost
  if (cost !== undefined) {
    const currency = cost.currency.toLowerCase()
    const value = currency === 'cny' || currency === 'usd' ? formatCost(cost.amount, currency) : `${cost.amount.toFixed(2)} ${cost.currency}`
    rows.push({ label: t('stats.cost'), value })
  }
  return rows
}

export function timingRows(timeline: ContextTimeline, t: Translate): StatRow[] {
  const timing = timeline.timing
  if (timing === undefined) return []
  return [
    { label: t('timing.total'), value: fmtDuration(timing.wallMs) },
    { label: t('timing.ttft'), value: fmtDuration(timing.ttftMs) },
    { label: t('timing.gen'), value: fmtDuration(timing.genMs) },
    { label: t('timing.tools'), value: `${fmtDuration(timing.toolsMs)} · ${t('timing.toolTimes', { n: timing.toolCalls })}` },
  ]
}
