/**
 * The Context card: what the session's context IS and how it evolved — an
 * eight-cell 2×4 grid pairing the session's shape (turns / steps / live tool
 * calls / images) with the context-event tally (injections / compactions /
 * prunes) and the whole-session cost estimate. Count figures only: nothing
 * here is part of a spendable whole, so no pie — proportions live in the
 * composition card. The cost cell prices the host-folded cumulative billed
 * totals (complete session log, never trimmed) at the hardcoded DeepSeek V4
 * list prices (cost.ts) in the locale's currency; its hover bubble (a '?'
 * marker + styled DOM tip) explains the whole-session estimate and lists the
 * per-1M-token table straight from cost.ts, so printed rates can never drift
 * from the math.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord, SessionCostUsage } from '../../shared/types'
import { estimateSessionCost, formatCost, formatPriceRate, sessionPrices } from '../cost'
import type { CostCurrency } from '../cost'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export function makeStatsContext(kit: ViewKit): (props: {
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number
  /** Image blocks live in the current context (absent on older hosts). */
  images?: number
  cost?: SessionCostUsage
  locale: string
}) => ReactNS.ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: {
    requests: RequestRecord[]
    events: ContextEventRecord[]
    toolCalls?: number
    images?: number
    cost?: SessionCostUsage
    locale: string
  }): ReactNS.ReactElement {
    const turns = new Set<number>()
    let steps = 0
    for (const req of props.requests) {
      turns.add(req.turn ?? 0)
      steps++
    }
    let injects = 0, compactions = 0, prunes = 0
    for (const ev of props.events) {
      if (ev.kind === 'inject') injects++
      else if (ev.kind === 'compaction') compactions++
      else if (ev.kind === 'prune') prunes++
    }
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const cost = estimateSessionCost(props.cost, currency)
    const fmtRate = (n: number): string => formatPriceRate(n, currency)
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
    const cell = (label: string, value: string | number, tip?: ReactNS.ReactNode): ReactNS.ReactElement => (
      <div className={'lc-stat' + (tip === undefined ? '' : ' lc-stat-tipped')}>
        <span className="lc-stat-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q" aria-hidden="true">?</i>}
        </span>
        <b className="lc-stat-value">{typeof value === 'number' ? fmt(value) : value}</b>
        {tip !== undefined && <span className="lc-tip lc-stat-tip" role="tooltip">{tip}</span>}
      </div>
    )
    return (
      <div className="lc-card lc-col-stats">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
          <span className="lc-card-sub">{t('stats.hint')}</span>
        </div>
        <div className="lc-stats">
          {cell(t('stats.turns'), turns.size)}
          {cell(t('stats.steps'), steps)}
          {cell(t('stats.toolCalls'), props.toolCalls ?? 0)}
          {cell(t('stats.images'), props.images ?? 0)}
          {cell(t('stats.cost'), cost === null ? '—' : formatCost(cost, currency), costTip)}
          {cell(t('stats.injects'), injects)}
          {cell(t('stats.compactions'), compactions)}
          {cell(t('stats.prunes'), prunes)}
        </div>
      </div>
    )
  }
}
