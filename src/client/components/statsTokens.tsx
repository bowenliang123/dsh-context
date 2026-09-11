/**
 * The Token card: the session's whole billed token usage — the SAME total
 * the harness chat stats line shows under the composer (uncached input +
 * cache read + cache write + output off the official `tokenUsage`
 * projection) — split by WHAT the tokens are, not by how the provider
 * cached them. The six composition categories share the provider-reported
 * prompt-side total by the composition card's own estimated ratios
 * (billedParts), and the provider's exact output count is its own slice, so
 * the ring and the center figure always equal the chat line's figure by
 * construction. The estimated category counts carry the ≈ marker (the
 * composition card's convention); the center total and the output count are
 * exact. Zero parts stay hidden once any usage is reported; the empty state
 * (no provider report yet) keeps all seven rows behind a dash center.
 */

import { useState, type ReactElement } from 'react'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../shared/types'
import { billedParts } from '../categories'
import { numOf } from '../services'
import type { ViewKit } from '../viewkit'

import { makeSliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutProps } from './donut'

const NO_USAGE: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

export function makeStatsTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  usage: TokenUsage | null
  current: Snapshot['current']
  breakdown: ContextBreakdown | null
}) => ReactElement {
  const { t, fmt, fmtShare, catLabel } = kit
  const SliceList = makeSliceList(kit)
  return function StatsTokens(props: {
    usage: TokenUsage | null
    current: Snapshot['current']
    breakdown: ContextBreakdown | null
  }): ReactElement {
    // The legend row ↔ donut segment hover link (shared key, set from either side).
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const input = props.usage !== null
      ? numOf(props.usage.uncachedInputTokens) + numOf(props.usage.cacheReadTokens) + numOf(props.usage.cacheWriteTokens)
      : 0
    const output = props.usage !== null ? numOf(props.usage.outputTokens) : 0
    const total = input + output
    // Null usage (no provider report — the chat line shows no pill either)
    // takes the same zeroed split billedParts produces for a zero report.
    const parts = billedParts(props.current, props.breakdown, props.usage ?? NO_USAGE)
    const shown = total > 0 ? parts.filter(p => p.value > 0) : parts
    const rows: SliceRow[] = shown.map(p => ({
      key: p.key,
      color: p.color,
      label: p.key === 'output' ? t('tokens.output') : catLabel(p.key),
      pct: fmtShare(p.value, total),
      // The six prompt-side shares are ratio estimates (≈, the composition
      // card's convention); output alone is provider-exact.
      count: p.key === 'output' ? `${fmt(p.value)} · ${t('tokens.outputNote')}` : '≈' + fmt(p.value),
    }))
    return (
      <div className="lc-card lc-col-stats lc-col-donut">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('tokens.title')}</span>
        </div>
        <div className="lc-donut-row">
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
