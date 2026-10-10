/**
 * The Fleet roster — every agent of the family as a filterable, sortable list. A row click pins
 * the agent into the network card's inspector (and rings its graph node); the tail button opens
 * its session. Rows hover-feed the graph's lineage focus through the shared `onHover`.
 */

import { useMemo, useState, type ReactElement } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest, AgentNode } from '../agentTree'
import { fmtDurationCompact } from '../agentTree'
import { teamMemberOf, type FleetTeam } from '../fleetTeam'
import type { ViewKit } from '../viewkit'

export interface FleetListProps {
  forest: AgentForest
  team: FleetTeam | null
  pinnedId: string | null
  onPin: (id: string | null) => void
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

type StatusFilter = 'all' | 'running' | 'done' | 'idle'
type SortKey = 'spawn' | 'tokens' | 'duration' | 'steps' | 'recent'

function statusOf(node: AgentNode): Exclude<StatusFilter, 'all'> {
  if (node.running) return 'running'
  return node.completed ? 'done' : 'idle'
}

const SORTERS: Record<Exclude<SortKey, 'spawn'>, (a: AgentNode, b: AgentNode) => number> = {
  tokens: (a, b) => (b.head?.tokens ?? 0) - (a.head?.tokens ?? 0),
  duration: (a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0),
  steps: (a, b) => b.requests - a.requests,
  recent: (a, b) => b.updatedAt - a.updatedAt,
}

export function FleetList(props: FleetListProps): ReactElement {
  const { forest, team, t, fmt } = props
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const [sort, setSort] = useState<SortKey>('spawn')

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const out = forest.nodes.filter((node) => {
      if (status !== 'all' && statusOf(node) !== status) return false
      if (needle !== '' && !node.label.toLowerCase().includes(needle) && !node.id.toLowerCase().includes(needle)) return false
      return true
    })
    // Spawn order is the forest's own DFS order — the parent catalog's own sibling sequence.
    return sort === 'spawn' ? out : [...out].sort(SORTERS[sort])
  }, [forest, query, status, sort])

  const counts = useMemo(() => {
    const c = { all: forest.nodes.length, running: 0, done: 0, idle: 0 }
    for (const n of forest.nodes) c[statusOf(n)]++
    return c
  }, [forest])

  return (
    <div className="lc-card lc-fleet-list">
      <div className="lc-card-title">
        <span className="lc-card-title-text">{t('fleet.list.title')}</span>
        <span className="lc-card-sub">{t('fleet.list.sub')}</span>
      </div>

      <div className="lc-fleet-toolbar">
        <input
          type="search"
          className="lc-fleet-search"
          placeholder={t('fleet.list.search')}
          value={query}
          onChange={(ev) => { setQuery(ev.target.value) }}
        />
        <div className="lc-fleet-filters" role="group" aria-label={t('fleet.list.filter')}>
          {(['all', 'running', 'done', 'idle'] as const).map(key => (
            <button
              key={key}
              type="button"
              className={'lc-gran-btn' + (status === key ? ' lc-gran-on' : '')}
              onClick={() => { setStatus(key) }}
            >
              {t(`fleet.filter.${key}`)}
              <span className="lc-kind-n">{fmt(counts[key])}</span>
            </button>
          ))}
        </div>
        <select
          className="lc-fleet-sort"
          value={sort}
          aria-label={t('fleet.list.sort')}
          onChange={(ev) => { setSort(ev.target.value as SortKey) }}
        >
          {(['spawn', 'tokens', 'duration', 'steps', 'recent'] as const).map(key => (
            <option key={key} value={key}>{t(`fleet.sort.${key}`)}</option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="lc-empty">{t('fleet.list.empty')}</div>
      ) : (
        <ul className="lc-fleet-rows">
          {rows.map((node) => {
            const member = teamMemberOf(team, node.id)
            const pct = node.head !== null ? node.head.pct : null
            const meta: string[] = []
            if (node.head !== null) meta.push(fmt(node.head.tokens))
            if (node.model !== undefined) meta.push(node.model)
            if (node.durationMs !== null) meta.push(fmtDurationCompact(node.durationMs))
            if (node.requests > 0) meta.push(t('agents.steps', { n: node.requests }))
            return (
              <li key={node.id}>
                <div
                  className={
                    'lc-fleet-row'
                    + (props.pinnedId === node.id ? ' lc-fleet-row-pinned' : '')
                    + (node.isCurrent ? ' lc-fleet-row-self' : '')
                  }
                  role="button"
                  tabIndex={0}
                  onClick={() => { props.onPin(props.pinnedId === node.id ? null : node.id) }}
                  onKeyDown={(ev) => {
                    if (ev.key !== 'Enter' && ev.key !== ' ') return
                    ev.preventDefault()
                    props.onPin(props.pinnedId === node.id ? null : node.id)
                  }}
                  onMouseEnter={() => { props.onHover(node.id) }}
                  onMouseLeave={() => { props.onHover(null) }}
                >
                  {node.running || node.completed
                    ? <StateDot state={node.running ? 'ongoing' : 'done'} size={10} className="lc-agent-state" />
                    : <span className="lc-fleet-dot-idle" />}
                  <span className="lc-fleet-row-label" title={node.label}>{node.label}</span>
                  {node.isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
                  {member !== null && member.role === 'teammate'
                    ? <span className="lc-agents-badge lc-fleet-row-team">{member.name}</span>
                    : null}
                  {member !== null && member.role === 'lead'
                    ? <span className="lc-agents-badge lc-fleet-row-team">{t('fleet.role.lead')}</span>
                    : null}
                  <span className="lc-fleet-row-meta">{meta.join(' · ')}</span>
                  {pct !== null
                    ? <span className="lc-fleet-row-pct">{pct}%</span>
                    : null}
                  {!node.isCurrent ? (
                    <button
                      type="button"
                      className="lc-inspector-btn lc-fleet-row-open"
                      title={t('fleet.open')}
                      onClick={(ev) => {
                        ev.stopPropagation()
                        props.onOpen(node.id)
                      }}
                    >
                      →
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
