import { useState, type ReactElement } from 'react'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../shared/types'
import { billedParts } from '../categories'
import { cacheHitPercent } from '../format'
import { numOf } from '../services'
import type { ViewKit } from '../viewkit'
import { IconDatabase } from '../primitives'

import { SliceList } from './sliceList'
import type { DonutProps } from './donut'
import { tokenRowsOf } from './tokenRows'

const NO_USAGE: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export function makeStatsTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  usage: TokenUsage | null
  current: Snapshot['current']
  breakdown: ContextBreakdown | null
  generatedReasoning?: number
  generatedAnswerTokens?: number
  generatedCallTokens?: number
}) => ReactElement {
  const { t, fmt } = kit
  return function StatsTokens(props: {
    usage: TokenUsage | null
    current: Snapshot['current']
    breakdown: ContextBreakdown | null
    generatedReasoning?: number
    generatedAnswerTokens?: number
    generatedCallTokens?: number
  }): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const input = props.usage !== null
      ? numOf(props.usage.uncachedInputTokens) + numOf(props.usage.cacheReadTokens) + numOf(props.usage.cacheWriteTokens)
      : 0
    const output = props.usage !== null ? numOf(props.usage.outputTokens) : 0
    const total = input + output
    const hit = props.usage === null
      ? null
      : cacheHitPercent(numOf(props.usage.cacheReadTokens), input)
    const parts = billedParts(props.current, props.breakdown, props.usage ?? NO_USAGE, {
      reasoning: props.generatedReasoning,
      answers: props.generatedAnswerTokens,
      calls: props.generatedCallTokens,
    })
    const shown = parts.some(p => p.value > 0) ? parts.filter(p => p.value > 0) : parts
    const rows = tokenRowsOf(kit, shown, total)
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconDatabase size={14} />
            {t('tokens.title')}
          </span>
          {hit !== null && (
            <span className="lc-card-rate" title={t('stats.cacheHitTip')}>{t('stats.cacheHit')} {hit}%</span>
          )}
        </div>
        <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
          <Donut
            segments={shown}
            size={96}
            centerTop={props.usage === null ? '—' : fmt(total)}
            centerSub={t('tokens.total')}
            hoverKey={hoverKey}
            onHoverKey={setHoverKey}
          />
          <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
        </div>
      </div>
    )
  }
}
