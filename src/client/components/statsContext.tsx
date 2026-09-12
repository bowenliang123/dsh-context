/**
 * The Context card: what the session's context IS and how it evolved — a
 * six-cell grid of the session's shape (turns / steps / human inputs / live
 * tool calls), the whole-session cache-hit rate, and the whole-session cost
 * estimate.
 * Count figures only: nothing here is part of a spendable whole, so no pie —
 * proportions live in the composition card, and the context-event tallies
 * live on the events card's kind filters (contextView.tsx). The cache-hit
 * cell reads the official `tokenUsage` projection — the same source and
 * formula as the harness chat stats line under the composer, shown with one
 * decimal — and dashes until a provider reports usage. The cost cell prices
 * the host-folded cumulative billed totals (complete session log, never
 * trimmed) from the models.dev price book (modelPrices.ts) in the locale's
 * currency; its hover bubble (a '?' marker + styled DOM tip) explains the
 * whole-session estimate and lists the per-1M-token rates of the models this
 * session actually billed, straight from the same book (cost.ts), so printed
 * rates can never drift from the math. A book that has not loaded (or
 * failed) dashes the cell and notes the outage.
 *
 * The counts arrive precomputed: the split-generation wire head carries them
 * (shared/types.ts `TimelineCounts` — computed over the retained records),
 * and the caller derives them from the collections on the inline generation
 * (`countsOfRecords`). The card itself never touches the collections.
 */

import { type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TimelineCounts, TokenUsage } from '../../shared/types'
import { estimateSessionCost, formatCost, formatPriceRate, offPeakOf, priceOf, toCurrency } from '../cost'
import type { CostCurrency, ModelPrices, PriceTriple } from '../cost'
import { cacheHitPercent } from '../format'
import { useModelPrices } from '../modelPrices'
import { asRecord, numOf } from '../services'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'

/** One billed model's tooltip row: its display label and USD rates (`offRate` present only when the model billed off-peak). */
interface PriceRow { key: string; label: string; rate: PriceTriple; offRate?: PriceTriple }

/**
 * The rate rows for the models this session actually billed — the usage
 * keys priced against the book, in fold order. Hostile branches skip;
 * unpriced models drop (their buckets simply do not contribute). The label
 * carries the provider only when the session billed more than one; a model
 * with an off-peak bucket (DeepSeek's period-based list) shows the
 * peak | off-peak pair.
 */
function priceRowsOf(usage: SessionCostUsage | undefined, prices: ModelPrices | null): PriceRow[] {
  if (usage === undefined || prices === null) return []
  const rows: PriceRow[] = []
  const multi = Object.keys(usage).length > 1
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const rate = priceOf(prices, provider, model)
      if (rate === null) continue
      const periods = asRecord(models[model])
      // The peak | off-peak pair is DeepSeek's alone (shared/providers):
      // other providers bill everything at list price.
      const off = isDeepSeekProvider(provider) && periods !== null && periods.off !== undefined
        ? offPeakOf(rate)
        : undefined
      rows.push({
        key: provider + '/' + model,
        label: multi && provider !== '' ? `${model} · ${provider}` : model,
        rate,
        ...(off !== undefined ? { offRate: off } : {}),
      })
    }
  }
  return rows
}

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
  /** The session-shape tally (host-precomputed on the split generation). */
  counts: TimelineCounts
  /** The whole-session human-input tally (the user's messages + question answers; absent on older hosts). */
  humanInputs?: number
  /** Tool calls with a result live in the current context (absent on older hosts). */
  toolCalls?: number
  /** The official tokenUsage projection — the cache-hit cell's source (null until a provider reports). */
  usage: TokenUsage | null
  cost?: SessionCostUsage
  locale: string
}) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: {
    counts: TimelineCounts
    humanInputs?: number
    toolCalls?: number
    usage: TokenUsage | null
    cost?: SessionCostUsage
    locale: string
  }): ReactElement {
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const { prices, failed } = useModelPrices()
    const cost = estimateSessionCost(props.cost, prices, currency)
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const rows = priceRowsOf(props.cost, prices)
    // DeepSeek's peak/off-peak scheme is explained only when the session
    // actually billed a DeepSeek provider — other sessions see nothing of it.
    const deepseek = props.cost !== undefined && Object.keys(props.cost).some(p => isDeepSeekProvider(p))
    const anyPair = rows.some(r => r.offRate !== undefined)
    // Usage folded but nothing priced (the book has not loaded, or carries
    // none of this session's models): say so instead of a bare dash.
    const unpriced = rows.length === 0 && props.cost !== undefined && Object.keys(props.cost).length > 0
      && (failed || prices !== null)
    const costTip: ReactNode = [
      t('stats.costTip') + (deepseek ? ' ' + t('stats.costTipDeepseek') : ''),
      rows.length > 0 ? (
        <span key="prices" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">
            {anyPair ? t('stats.costPriceHeadPair') : t('stats.costPriceHead')}
          </span>
          {rows.map((r) => {
            const cells: [string, number, number | undefined][] = [
              [t('stats.costHit'), r.rate.hit, r.offRate?.hit],
              [t('stats.costMiss'), r.rate.miss, r.offRate?.miss],
              [t('stats.costWrite'), r.rate.write, r.offRate?.write],
              [t('stats.costOut'), r.rate.out, r.offRate?.out],
            ]
            return (
              <span key={r.key} className="lc-stat-tip-row">
                <b className="lc-stat-tip-model">{r.label}</b>
                {cells.map(([name, peak, off]) => (
                  <span key={name}>{' · '}{name} {off === undefined ? fmtRate(peak) : `${fmtRate(peak)}|${fmtRate(off)}`}</span>
                ))}
              </span>
            )
          })}
        </span>
      ) : null,
      unpriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    // The chat stats line's own figure, one decimal: prompt-side cache reads
    // over the whole billed input (output excluded), dashed until reported.
    const hit = props.usage === null ? null
      : cacheHitPercent(
        numOf(props.usage.cacheReadTokens),
        numOf(props.usage.uncachedInputTokens) + numOf(props.usage.cacheReadTokens) + numOf(props.usage.cacheWriteTokens),
        1,
      )
    const cell = (label: string, value: string | number, tip?: ReactNode): ReactElement => (
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
        </div>
        <div className="lc-stats">
          {cell(t('stats.turns'), props.counts.turns)}
          {cell(t('stats.steps'), props.counts.steps)}
          {cell(t('stats.humanInputs'), props.humanInputs ?? 0, t('stats.humanInputsTip'))}
          {cell(t('stats.toolCalls'), props.toolCalls ?? 0)}
          {cell(t('stats.cacheHit'), hit === null ? '—' : `${hit}%`)}
          {cell(t('stats.cost'), cost === null ? '—' : formatCost(cost, currency), costTip)}
        </div>
      </div>
    )
  }
}
