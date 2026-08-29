/**
 * The Token card: the provider-reported cumulative billing buckets (the
 * official `tokenUsage` projection, whole session). The donut's center is
 * the cache-hit share — the same figure the harness chat stats line shows —
 * and the slice rows carry each bucket's token count: cache reads/writes,
 * uncached input, and output (reasoning included).
 */

import type * as ReactNS from 'react'
import type { TokenUsage } from '../../shared/types'
import { cacheHitPercent as cacheHitPercentOf } from '../format'
import { numOf } from '../services'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

import { makeSliceList } from './sliceList'
import type { SliceRow } from './sliceList'
import type { DonutSegment } from './donut'

export function makeStatsTokens(kit: ViewKit, Donut: (props: {
  segments: DonutSegment[]
  centerTop: ReactNS.ReactNode
  centerSub?: ReactNS.ReactNode
  size?: number
}) => ReactNS.ReactElement): (props: {
  usage: TokenUsage | null
}) => ReactNS.ReactElement {
  const { t, fmt, fmtShare } = kit
  const SliceList = makeSliceList(kit)
  return function StatsTokens(props: { usage: TokenUsage | null }): ReactNS.ReactElement {
    const reads = props.usage !== null ? numOf(props.usage.cacheReadTokens) : 0
    const writes = props.usage !== null ? numOf(props.usage.cacheWriteTokens) : 0
    const uncached = props.usage !== null ? numOf(props.usage.uncachedInputTokens) : 0
    const output = props.usage !== null ? numOf(props.usage.outputTokens) : 0
    const billed = reads + writes + uncached + output
    // The center keeps the chat line's PROMPT-side cache-hit formula (reads
    // over uncached + reads + writes, output excluded) — the established
    // figure the harness stats line shows; the donut/rows normalize over the
    // whole billed total instead.
    const hit = props.usage !== null ? cacheHitPercentOf(reads, uncached + reads + writes) : null
    const buckets: { key: string; color: string; label: string; value: number }[] = [
      { key: 'read', color: '#22c55e', label: t('tokens.cacheRead'), value: reads },
      { key: 'write', color: '#f59e0b', label: t('tokens.cacheWrite'), value: writes },
      { key: 'uncached', color: '#6366f1', label: t('tokens.uncached'), value: uncached },
      { key: 'output', color: '#3b82f6', label: t('tokens.output'), value: output },
    ]
    const rows: SliceRow[] = buckets.map(b => ({
      key: b.key, color: b.color, label: b.label,
      pct: fmtShare(b.value, billed), count: fmt(b.value),
    }))
    return (
      <div className="lc-card lc-col-stats lc-col-donut">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('tokens.title')}</span>
          <span className="lc-card-sub">{t('tokens.hint')}</span>
        </div>
        <div className="lc-donut-row">
          <Donut
            segments={buckets.map(b => ({ key: b.key, color: b.color, value: b.value }))}
            size={96}
            centerTop={hit === null ? '—' : `${hit}%`}
            centerSub={t('tokens.cacheHit')}
          />
          <SliceList rows={rows} />
        </div>
      </div>
    )
  }
}
