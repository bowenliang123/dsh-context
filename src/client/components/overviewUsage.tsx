/**
 * The Context Insights panel's first-row usage chart — the RIGHT half of the
 * KPI row. Seven day columns ending today, each pairing two bars priced off
 * the merged daily ledger (overview.ts aggregateDays): billed TOKENS (the
 * heatmap's own blue) and the day's estimated COST (green). The fee rides
 * the same per-day pricing records the host fold books at each turn's
 * initiation, priced by the same book and estimator as the KPI band's cost
 * cell — never a whole session's spend dumped on the day it was last
 * active. The two series scale on their OWN window maxima (a $2 week must
 * not flatten under a 169M-token week), so each bar reads as a share of its
 * series' peak; the tooltip (the page's portaled hover tip, off the column's
 * `data-lc-tip`) carries the exact figures. The window spans the last 7 or 30
 * days (the cost settings' usage window) — the range selector above scopes
 * the KPI figures, not this calendar. The dense 30-day layout drops the
 * per-bar value labels and shows every fifth day strip label.
 *
 * The plot is framed like a chart: hairline gridlines at 0/25/50/75/100% of
 * each series' own peak, a solid baseline at 0, and a tick rail on each
 * side — TOKENS on the left, COST on the right, computed from the same
 * maxima the bars scale to. The cost rail reads '—' until some day actually
 * prices. Each tokens bar carries its own day's figure above it, so the
 * common case reads without hovering.
 */

import type { ReactElement } from 'react'
import { formatCost, type CostCurrency } from '../cost'
import { type DayTotals } from '../overview'
import { shiftDayKey } from '../../shared/days'
import type { UsageWindow } from '../../shared/types'
import type { ViewKit } from '../viewkit'

export interface OverviewUsageProps {
  /** The merged daily ledger (day key → that day's figures). */
  days: Record<string, DayTotals>
  /** The display currency the day fees were priced in. */
  currency: CostCurrency
  /** The local today key (injected so specs pin the calendar). */
  today: string
  /** The chart's calendar span: the last 7 or 30 days. */
  window: UsageWindow
}

/** The chart's window: today and the `window`'s span before it, oldest first. */
export function usageWindowOf(today: string, window: UsageWindow = '7d'): string[] {
  const columns: string[] = []
  for (let d = -(window === '30d' ? 30 : 7) + 1; d <= 0; d++) {
    const key = shiftDayKey(today, d)
    if (key === null) return []
    columns.push(key)
  }
  return columns
}

/** The shared gridline/tick positions, in percent of each series' peak. */
const TICKS: readonly number[] = [0, 25, 50, 75, 100]

export function makeOverviewUsage(kit: ViewKit): (props: OverviewUsageProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewUsage(props: OverviewUsageProps): ReactElement {
    const window = usageWindowOf(props.today, props.window)
    // The 30-column layout is too tight for the per-bar figures and every day
    // strip label: the value labels yield to the tooltip, and the strip labels
    // step back from today every fifth column.
    const dense = props.window === '30d'
    const labelStride = dense ? 5 : 1
    // Widened: a Record index read can miss at runtime.
    const byKey: Record<string, DayTotals | undefined> = props.days
    const columns = window.map(key => ({ key, entry: byKey[key] }))
    const empty = columns.every(c => c.entry === undefined || (c.entry.tokens <= 0 && c.entry.cost === null))
    let maxTokens = 0
    let maxCost = 0
    for (const c of columns) {
      if (c.entry === undefined) continue
      if (c.entry.tokens > maxTokens) maxTokens = c.entry.tokens
      if (c.entry.cost !== null && c.entry.cost > maxCost) maxCost = c.entry.cost
    }
    const heightOf = (value: number, max: number): string => (max <= 0 || value <= 0 ? '0%' : `${Math.max(4, Math.round((value / max) * 100))}%`)
    const tickOf = (percent: number): string => fmt(Math.round((maxTokens * percent) / 100))
    // '—' while nothing prices (an all-zero rail would read as free); the 0
    // tick reads bare — formatCost's toPrecision renders the floor as the odd "¥0.0".
    const costTickOf = (percent: number): string => {
      if (maxCost <= 0) return '—'
      return percent === 0 ? '0' : formatCost((maxCost * percent) / 100, props.currency)
    }
    return (
      <div className={'lc-card lc-ov-usage' + (dense ? ' lc-ov-usage-dense' : '')}>
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t(dense ? 'ov.usage.title30' : 'ov.usage.title')}</span>
        </div>
        {empty || window.length === 0
          ? <div className="lc-empty">{t(dense ? 'ov.usage.empty30' : 'ov.usage.empty')}</div>
          : (
            <>
              <div className="lc-ov-usage-plot" role="group" aria-label={t('ov.usage.title')}>
                <div className="lc-ov-usage-rail lc-ov-usage-rail-l" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lc-ov-usage-tick" style={{ top: `${100 - p}%` }}>{tickOf(p)}</span>)}
                </div>
                <div className="lc-ov-usage-grid">
                  <div className="lc-ov-usage-cols">
                    {/* The gridlines resolve against the bars' own box, so the headroom the value labels
                        take above the tallest bar never shifts the scale they mark. */}
                    {TICKS.map(p => (
                      <span
                        key={p}
                        className={'lc-ov-usage-line' + (p === 0 ? ' lc-ov-usage-line-0' : '')}
                        style={{ bottom: `${p}%` }}
                        aria-hidden="true"
                      />
                    ))}
                    {columns.map((c) => {
                      const tokens = c.entry?.tokens ?? 0
                      const cost = c.entry?.cost ?? null
                      // The tooltip line reads the BARE label; the legend's priced-models qualifier stays off the bubble.
                      const label = `${c.key}\n${t('ov.usage.tokens')} ${fmt(tokens)}\n${t('ov.usage.costTip')} ${cost === null ? '—' : formatCost(cost, props.currency)}`
                      return (
                        <div key={c.key} className="lc-ov-usage-col" data-lc-tip={label}>
                          <div className="lc-ov-usage-bars">
                            <span
                              className="lc-ov-usage-bar lc-ov-usage-tokens"
                              style={{ height: heightOf(tokens, maxTokens) }}
                            >
                              {/* The day's own figure, riding its bar's top — a day with no tokens has nothing to say,
                                  and the dense window's columns have no room for it (the tooltip carries it). */}
                              {!dense && tokens > 0 && <span className="lc-ov-usage-value">{fmt(tokens)}</span>}
                            </span>
                            <span
                              className="lc-ov-usage-bar lc-ov-usage-cost"
                              style={{ height: cost === null ? '0%' : heightOf(cost, maxCost) }}
                            />
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="lc-ov-usage-rail lc-ov-usage-rail-r" aria-hidden="true">
                  {TICKS.map(p => <span key={p} className="lc-ov-usage-tick" style={{ top: `${100 - p}%` }}>{costTickOf(p)}</span>)}
                </div>
                {/* The day strip is the plot grid's row 2 in the chart's own
                    column, so every label centers under its column by
                    construction — no mirrored geometry to keep in sync. */}
                <div className="lc-ov-usage-days" aria-hidden="true">
                  {columns.map((c, i) => (
                    <span
                      key={c.key}
                      className="lc-ov-usage-day"
                      style={dense && (columns.length - 1 - i) % labelStride !== 0 ? { visibility: 'hidden' } : undefined}
                    >{c.key.slice(5)}</span>
                  ))}
                </div>
              </div>
            </>
          )}
        <div className="lc-ov-usage-key" aria-hidden="true">
          <span className="lc-ov-usage-swatch lc-ov-usage-tokens" />
          <span className="lc-ov-usage-key-label">{t('ov.usage.tokens')}</span>
          <span className="lc-ov-usage-swatch lc-ov-usage-cost" />
          <span className="lc-ov-usage-key-label">{t('ov.usage.cost')}</span>
        </div>
      </div>
    )
  }
}
