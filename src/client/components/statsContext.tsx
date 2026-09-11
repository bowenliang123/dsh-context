/**
 * The Context card: what the session's context IS and how it evolved — an
 * eight-cell 2×4 grid pairing the session's shape (turns / steps / live tool
 * calls / images) with the context-event tally (injections / compactions /
 * prunes) and the conversation cost estimate. Count figures only: nothing
 * here is part of a spendable whole, so no pie — proportions live in the
 * composition card. The cost cell prices the host-folded cumulative billed
 * totals (complete session log, never trimmed) at the hardcoded DeepSeek V4
 * list prices (cost.ts) in the locale's currency, PLUS every subagent
 * session's own totals (agentTree.ts walks the lineage the list snapshot
 * carries): a subagent's spend lands in its own session log and never in this
 * one's, so pricing the log alone reports a fraction of what the conversation
 * cost. The cell also carries the own/subagents split — a proportion bar over
 * two compact figures — because a subagent's spend is written only in that
 * subagent's own log and therefore has to read without hovering. Its hover
 * bubble (a '?' marker + styled DOM tip) explains the estimate and lists the
 * per-1M-token table straight from cost.ts, so printed rates can never drift
 * from the math.
 *
 * The counts arrive precomputed: the split-generation wire head carries them
 * (shared/types.ts `TimelineCounts` — computed over the retained records),
 * and the caller derives them from the collections on the inline generation
 * (`countsOfRecords`). The card itself never touches the collections.
 */

import { type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TimelineCounts } from '../../shared/types'
import { estimateSessionCost, formatCost, formatPriceRate, sessionPrices } from '../cost'
import type { CostCurrency } from '../cost'
import type { ViewKit } from '../viewkit'

/**
 * The inline generation's counter derivation — the exact tally the card ran
 * over the served collections before the split (distinct turn values, record
 * count, per-kind event tallies). The host's split-generation counts match
 * it by construction (fold.ts buildTimelineHead).
 */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes }
}

export function makeStatsContext(kit: ViewKit): (props: {
  /** The session-shape and event tallies (host-precomputed on the split generation). */
  counts: TimelineCounts
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number
  /** Image blocks live in the current context (absent on older hosts). */
  images?: number
  cost?: SessionCostUsage
  /** Billed-token totals of every session under this one, at any depth (absent when none priced). */
  subagentCost?: SessionCostUsage
  /** Sessions behind `subagentCost`; 0 or absent leaves the cell unsplit. */
  subagentCount?: number
  locale: string
}) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: {
    counts: TimelineCounts
    toolCalls?: number
    images?: number
    cost?: SessionCostUsage
    subagentCost?: SessionCostUsage
    subagentCount?: number
    locale: string
  }): ReactElement {
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const own = estimateSessionCost(props.cost, currency)
    const subagents = estimateSessionCost(props.subagentCost, currency)
    // The cell prices the conversation, not just the session: a subagent runs
    // on its own session and its spend never lands in this one's log, so the
    // two estimates add up (each already priced at its own family's rates).
    const cost = own === null ? subagents : subagents === null ? own : own + subagents
    // Non-null exactly when the split is worth showing: at least one subagent
    // reported priced usage. Absent subagents (or a harness that cannot reach
    // them) leave the cell byte-for-byte as it was.
    const subTotal = props.subagentCount !== undefined && props.subagentCount > 0 ? subagents : null
    // The split rides the CELL rather than the bubble — the subagent share is
    // invisible in this session's own log, so it has to read without hovering.
    // The bar divides the priced total; an unpriced side takes no width.
    const ownCost = own ?? 0
    const priced = ownCost + (subTotal ?? 0)
    const ownShare = subTotal !== null && priced > 0 ? ownCost / priced : 0
    const fmtRate = (n: number): string => formatPriceRate(n, currency)
    const costTip: ReactNode = [
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
    const costSplit: ReactNode = subTotal === null
      ? null
      : (
        <>
          <span className="lc-stat-bar" aria-hidden="true">
            <span className="lc-stat-bar-own" style={{ width: `${(ownShare * 100).toFixed(1)}%` }} />
            <span className="lc-stat-bar-sub" />
          </span>
          <span className="lc-stat-split">
            <span>{t('stats.costOwn')} <b>{own === null ? '—' : formatCost(own, currency)}</b></span>
            <span>{t('stats.costSub')} <b>{formatCost(subTotal, currency)}</b></span>
          </span>
        </>
      )
    const cell = (label: string, value: string | number, tip?: ReactNode, extra?: ReactNode): ReactElement => (
      <div className={'lc-stat' + (tip === undefined ? '' : ' lc-stat-tipped')}>
        <span className="lc-stat-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q" aria-hidden="true">?</i>}
        </span>
        <b className="lc-stat-value">{typeof value === 'number' ? fmt(value) : value}</b>
        {extra}
        {tip !== undefined && <span className="lc-tip lc-stat-tip" role="tooltip">{tip}</span>}
      </div>
    )
    return (
      <div className="lc-card lc-col-stats">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div className="lc-stats">
          {cell(t('stats.turns'), props.counts.turns)}
          {cell(t('stats.steps'), props.counts.steps)}
          {cell(t('stats.toolCalls'), props.toolCalls ?? 0)}
          {cell(t('stats.images'), props.images ?? 0)}
          {cell(t('stats.cost'), cost === null ? '—' : formatCost(cost, currency), costTip, costSplit)}
          {cell(t('stats.injects'), props.counts.injects)}
          {cell(t('stats.compactions'), props.counts.compactions)}
          {cell(t('stats.prunes'), props.counts.prunes)}
        </div>
      </div>
    )
  }
}
