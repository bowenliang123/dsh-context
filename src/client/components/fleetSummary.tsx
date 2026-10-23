/** Fleet overview strip: family-wide stats; the progress bar follows the team's shared tasks when present, else
 * subagent completion, and stays absent for a solo session. */

import type { ReactElement } from 'react'
import type { AgentForest } from '../agentTree'
import { BOOK_PREFS, estimateSessionCost, formatCost, type CostCurrency, type CostPrefs, type ModelBook } from '../cost'
import type { FleetTeam } from '../fleetTeam'
import type { ViewKit } from '../viewkit'

export interface FleetSummaryProps {
  forest: AgentForest
  team: FleetTeam | null
  book: ModelBook | null
  currency: CostCurrency
  /** The pricing inputs the caller resolved; absent reads as the book's own list rates. */
  prefs?: CostPrefs
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

export function FleetSummary(props: FleetSummaryProps): ReactElement {
  const { forest, team, t, fmt } = props
  const nodes = forest.nodes
  const running = nodes.filter(n => n.running).length
  const subs = nodes.filter(n => !n.isCurrent)
  const subsDone = subs.filter(n => n.completed).length
  let tokens = 0
  for (const n of nodes) tokens += n.head?.tokens ?? 0
  let cost = 0
  let costKnown = false
  for (const n of nodes) {
    const priced = estimateSessionCost(n.costUsage, props.book, props.currency, props.prefs ?? BOOK_PREFS)
    if (priced !== null && priced > 0) {
      cost += priced
      costKnown = true
    }
  }

  const tasks = team?.tasks ?? []
  const tasksDone = tasks.filter(task => task.status === 'completed').length
  const progress = tasks.length > 0
    ? { label: t('fleet.summary.tasks'), done: tasksDone, total: tasks.length }
    : subs.length > 0
      ? { label: t('fleet.summary.subs'), done: subsDone, total: subs.length }
      : null

  return (
    <div className="lc-card lc-summary">
      <div className="lc-summary-chips">
        <span className="lc-agents-chip">{t('agents.chip.count', { n: nodes.length })}</span>
        <span className={'lc-agents-chip' + (running > 0 ? ' lc-agents-chip-on' : '')}>
          {t('agents.chip.running', { n: running })}
        </span>
        {subs.length > 0
          ? <span className="lc-agents-chip">{t('fleet.summary.done', { n: subsDone })}</span>
          : null}
        {tokens > 0
          ? <span className="lc-agents-chip">{t('agents.chip.tokens', { n: fmt(tokens) })}</span>
          : null}
        {costKnown
          ? <span className="lc-agents-chip">{t('fleet.summary.cost', { n: formatCost(cost, props.currency) })}</span>
          : null}
      </div>
      {progress !== null ? (
        <div className="lc-summary-progress">
          <span className="lc-summary-progress-label">{progress.label}</span>
          <span className="lc-tasks-progress-track">
            <i style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }} />
          </span>
          <span className="lc-summary-progress-n">{progress.done}/{progress.total}</span>
        </div>
      ) : null}
    </div>
  )
}
