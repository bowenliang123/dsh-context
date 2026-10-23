/**
 * The KPI row's usage chart: day columns pairing billed TOKENS and the day's estimated COST, each bar a share of
 * its own series' peak. The window is the last 7 or 30 days, and the dense 30-day layout drops the per-bar figures.
 */

import type { ReactElement } from 'react'
import { formatCost, type CostCurrency } from '../cost'
import { type DayTotals } from '../overview'
import { shiftDayKey } from '../../shared/days'
import type { UsageWindow } from '../../shared/types'
import type { ViewKit } from '../viewkit'

export interface OverviewUsageProps {
  days: Record<string, DayTotals>
  currency: CostCurrency
  /** Local today key — injected so specs can pin the calendar. */
  today: string
  /** The chart's calendar span: the last 7 or 30 days. */
  window: UsageWindow
}

/** Today and the span before it, oldest first. */
export function usageWindowOf(today: string, window: UsageWindow = '7d'): string[] {
  const columns: string[] = []
  for (let d = -(window === '30d' ? 30 : 7) + 1; d <= 0; d++) {
    const key = shiftDayKey(today, d)
    if (key === null) return []
    columns.push(key)
  }
  return columns
}

const TICKS: readonly number[] = [0, 25, 50, 75, 100]

export function makeOverviewUsage(kit: ViewKit): (props: OverviewUsageProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewUsage(props: OverviewUsageProps): ReactElement {
    const window = usageWindowOf(props.today, props.window)
    const dense = props.window === '30d'
    const labelStride = dense ? 5 : 1
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
    // '—' while nothing prices (a zero rail would read as free); the 0 tick reads bare ("¥0.0" is odd).
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
                    {/* Gridlines resolve against the bars' box, so value-label headroom never shifts the scale. */}
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
                      // Tooltip reads the bare label; the legend's priced-models qualifier stays off the bubble.
                      const label = `${c.key}\n${t('ov.usage.tokens')} ${fmt(tokens)}\n${t('ov.usage.costTip')} ${cost === null ? '—' : formatCost(cost, props.currency)}`
                      return (
                        <div key={c.key} className="lc-ov-usage-col" data-lc-tip={label}>
                          <div className="lc-ov-usage-bars">
                            <span
                              className="lc-ov-usage-bar lc-ov-usage-tokens"
                              style={{ height: heightOf(tokens, maxTokens) }}
                            >
                              {/* Dense columns have no room for the figure; the tooltip carries it. */}
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
                {/* Day strip is the plot grid's row 2, so labels center under their columns by construction. */}
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
