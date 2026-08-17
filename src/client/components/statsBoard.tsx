/**
 * StatsBoard — the session context statistics card above the composition:
 * conversation size (turns/steps) and context churn (compaction count,
 * prune count, injection count). All figures cover the retained history
 * window, matching the History chart. JSX component.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export function makeStatsBoard(kit: ViewKit): (props: {
  requests: RequestRecord[]
  events: ContextEventRecord[]
}) => ReactNS.ReactElement {
  const { t, fmt } = kit
  return function StatsBoard(props: {
    requests: RequestRecord[]
    events: ContextEventRecord[]
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
    const cell = (label: string, value: string) => (
      <div className="lc-stat">
        <span className="lc-stat-label">{label}</span>
        <b className="lc-stat-value">{value}</b>
      </div>
    )
    return (
      <div className="lc-card">
        <div className="lc-card-title">
          {t('stats.title')}
          <span className="lc-card-sub">{t('stats.hint')}</span>
        </div>
        <div className="lc-stats">
          {cell(t('stats.turns'), fmt(turns.size))}
          {cell(t('stats.steps'), fmt(steps))}
          {cell(t('stats.injects'), fmt(injects))}
          {cell(t('stats.compactions'), fmt(compactions))}
          {cell(t('stats.prunes'), fmt(prunes))}
        </div>
      </div>
    )
  }
}
