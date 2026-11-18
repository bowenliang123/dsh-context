import type { ReactElement } from 'react'
import { nameColorOf } from '../nameColor'
import { UNGROUPED_KEY } from '../overview'
import type { OverviewProjectStat } from '../../shared/types'
import { IconFolderOpen } from '../primitives'
import type { ViewKit } from '../viewkit'
import { SkeletonRows } from './skeleton'
import { TallyCard, TallyRow, shareOf } from './overviewTally'

export interface OverviewProjectsProps {
  stats: OverviewProjectStat[]
  day?: string | null
  selected?: string | null
  onSelect?: (key: string | null) => void
  pending?: boolean
}

export function makeOverviewProjects(kit: ViewKit): (props: OverviewProjectsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewProjects(props: OverviewProjectsProps): ReactElement {
    const stats = props.stats
    const total = stats.reduce((sum, stat) => sum + stat.tokens, 0)
    const max = stats.reduce((top, stat) => Math.max(top, stat.tokens), 0)
    const title = t('ov.projects.title')
    return (
      <TallyCard
        icon={<IconFolderOpen size={14} />}
        title={title}
        day={props.day}
        summary={t('ov.projects.summary', { n: fmt(stats.length), tokens: fmt(total) })}
      >
        {stats.length === 0 ? (
          props.pending === true
            ? <SkeletonRows rows={6} className="lc-ov-tallies-skel" />
            : <div className="lc-empty">{t('ov.projects.empty')}</div>
        ) : (
          <div className="lc-ov-tallies" role="group" aria-label={title}>
            {stats.map((stat) => {
              const label = stat.key === UNGROUPED_KEY ? t('ov.group.ungrouped') : stat.key
              const pinned = props.selected === stat.key
              return (
                <TallyRow
                  key={stat.key}
                  name={label}
                  count={`${fmt(stat.sessions)} · ${fmt(stat.tokens)}`}
                  share={shareOf(stat.tokens, max)}
                  color={stat.key === UNGROUPED_KEY ? 'var(--color-gray-400)' : nameColorOf(stat.key)}
                  selected={pinned}
                  title={`${t('ov.projects.sessions', { n: fmt(stat.sessions) })} · ${t('ov.projects.tokens', { n: fmt(stat.tokens) })}`}
                  onSelect={() => { props.onSelect?.(pinned ? null : stat.key) }}
                />
              )
            })}
          </div>
        )}
      </TallyCard>
    )
  }
}
