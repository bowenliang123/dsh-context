/**
 * StatsBoard — the session context statistics card above the composition:
 * conversation size (turns/steps), context churn (compaction count,
 * prune count, injection count), and the cache-hit share. The counts cover
 * the retained history window, matching the History chart; the cache-hit
 * figure reuses the official token-meter `tokenUsage` projection verbatim —
 * the exact same data and formula as the chat stats line below the input box.
 * JSX component.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord, TokenUsage } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

/**
 * Cache-hit share of billed prompt-side input — same buckets as the harness's
 * chat stats line below the input box (`cacheReadTokens` over the three
 * disjoint billed buckets: uncached + reads + writes). Unlike that line's
 * whole-percent rounding, this one TRUNCATES to two decimal places (cut, not
 * round). Null when no input was billed. A tiny epsilon keeps a double stored
 * a hair below a cent boundary (e.g. 80.00 as 79.9999999999…) from losing its
 * last digit — with integer token counts no genuine value ever sits that close
 * to a boundary, so the epsilon can only absorb float noise.
 */
function cacheHitPercent(usage: TokenUsage): string | null {
  const billed = usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  if (billed === 0) return null
  const hundredths = Math.trunc((usage.cacheReadTokens / billed) * 10000 + 1e-9)
  return `${Math.floor(hundredths / 100)}.${String(hundredths % 100).padStart(2, '0')}`
}

export function makeStatsBoard(kit: ViewKit): (props: {
  requests: RequestRecord[]
  events: ContextEventRecord[]
  usage: TokenUsage | null
}) => ReactNS.ReactElement {
  const { t, fmt } = kit
  return function StatsBoard(props: {
    requests: RequestRecord[]
    events: ContextEventRecord[]
    usage: TokenUsage | null
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
    const cell = (label: string, value: string) => (
      <div className="lc-stat">
        <span className="lc-stat-label">{label}</span>
        <b className="lc-stat-value">{value}</b>
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
          {cell(t('stats.cacheHit'), hit === null ? '—' : hit + '%')}
        </div>
      </div>
    )
  }
}
