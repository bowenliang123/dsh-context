/**
 * The cost cell prices the host-folded cumulative billed-token totals (complete session log, never trimmed) at the hardcoded DeepSeek V4
 * list prices (cost.ts) in the locale's currency; its hover bubble (a '?' marker + styled DOM tip) explains the whole-session estimate and
 * lists the per-1M-token table straight from cost.ts, so printed rates can never drift from the math.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TokenUsage } from '../../shared/types'
import { estimateSessionCost, formatCost, formatPriceRate, sessionPrices } from '../cost'
import type { CostCurrency } from '../cost'
import { numOf } from '../services'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

/**
 * Cache-hit share of billed prompt-side input — same three disjoint buckets as the harness chat line (`cacheReadTokens` over uncached +
 * reads + writes), but deliberately TRUNCATES to two decimals (cut, not round), unlike that line's integer rounding; null when nothing was
 * billed. The 1e-9 epsilon absorbs only float noise (integer token counts never sit that close to a boundary); `numOf` keeps malformed
 * payloads at a dash.
 */
function cacheHitPercent(usage: TokenUsage): string | null {
  const uncached = numOf(usage.uncachedInputTokens)
  const reads = numOf(usage.cacheReadTokens)
  const writes = numOf(usage.cacheWriteTokens)
  const billed = uncached + reads + writes
  if (billed === 0) return null
  const hundredths = Math.trunc((reads / billed) * 10000 + 1e-9)
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`
}

export function makeStatsBoard(kit: ViewKit): (props: {
  requests: RequestRecord[]
  events: ContextEventRecord[]
  usage: TokenUsage | null
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number
  /** Image blocks live in the current context (absent on older hosts). */
  images?: number
  cost?: SessionCostUsage
  locale: string
}) => ReactNS.ReactElement {
  const { t, fmt } = kit
  return function StatsBoard(props: {
    requests: RequestRecord[]
    events: ContextEventRecord[]
    usage: TokenUsage | null
    toolCalls?: number
    images?: number
    cost?: SessionCostUsage
    locale: string
  }): ReactNS.ReactElement {
    const turns = new Set<number>()
    let steps = 0, compactions = 0, prunes = 0, injects = 0
    for (const req of props.requests) {
      turns.add(req.turn ?? 0)
      steps++
    }
    for (const ev of props.events) {
      if (ev.kind === 'compaction') compactions++
      else if (ev.kind === 'prune') prunes++
      else if (ev.kind === 'inject') injects++
    }
    const hit = props.usage !== null ? cacheHitPercent(props.usage) : null
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const cost = estimateSessionCost(props.cost, currency)
    const fmtRate = (n: number) => formatPriceRate(n, currency)
    const costTip: ReactNS.ReactNode = [
      t('stats.costTip'),
      <span key="prices" className="lc-stat-tip-prices">
        <span className="lc-stat-tip-head">{t('stats.costPriceHead')}</span>
        {sessionPrices(currency).map(r => (
          <span key={r.family} className="lc-stat-tip-row">
            <b className="lc-stat-tip-model">{r.family}</b>
            {' '}{t('stats.costHit')} {fmtRate(r.peak.hit)}/{fmtRate(r.off.hit)}
            {' · '}{t('stats.costMiss')} {fmtRate(r.peak.miss)}/{fmtRate(r.off.miss)}
            {' · '}{t('stats.costOut')} {fmtRate(r.peak.out)}/{fmtRate(r.off.out)}
          </span>
        ))}
      </span>,
    ]
    // A cell may carry an explanation bubble: the label shows a '?' marker and the styled tip (`.lc-stat-tip`, revealed on cell hover) —
    // the native `title` attribute is invisible in the harness GUI.
    const cell = (label: string, value: string, tip?: ReactNS.ReactNode) => (
      <div className={'lc-stat' + (tip === undefined ? '' : ' lc-stat-tipped')}>
        <span className="lc-stat-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q" aria-hidden="true">?</i>}
        </span>
        <b className="lc-stat-value">{value}</b>
        {tip !== undefined && <span className="lc-stat-tip" role="tooltip">{tip}</span>}
      </div>
    )
    return (
      <div className="lc-card lc-col lc-col-stats">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
          <span className="lc-card-sub">{t('stats.hint')}</span>
        </div>
        <div className="lc-stats">
          {cell(t('stats.turns'), fmt(turns.size))}
          {cell(t('stats.steps'), fmt(steps))}
          {cell(t('stats.injects'), fmt(injects))}
          {cell(t('stats.compactions'), fmt(compactions))}
          {cell(t('stats.prunes'), fmt(prunes))}
          {cell(t('stats.toolCalls'), fmt(props.toolCalls ?? 0))}
          {cell(t('stats.images'), fmt(props.images ?? 0))}
          {cell(t('stats.cacheHit'), hit === null ? '—' : hit + '%')}
          {cell(t('stats.cost'), cost === null ? '—' : formatCost(cost, currency), costTip)}
        </div>
      </div>
    )
  }
}
