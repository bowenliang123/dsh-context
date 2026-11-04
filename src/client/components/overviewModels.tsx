import type { ReactElement } from 'react'
import type { ModelRankStat } from '../modelRank'
import { nameColorOf } from '../nameColor'
import { IconData } from '../primitives'
import type { ViewKit } from '../viewkit'
import { shareOf, TallyCard } from './overviewTally'

const MAX_ROWS = 24

export interface OverviewModelsProps {
  stats: readonly ModelRankStat[]
  day?: string | null
}

export function makeOverviewModels(kit: ViewKit): (props: OverviewModelsProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewModels(props: OverviewModelsProps): ReactElement {
    const stats = props.stats
    const total = stats.reduce((sum, s) => sum + s.total, 0)
    const max = stats.reduce((top, s) => Math.max(top, s.total), 0)
    const shown = stats.slice(0, MAX_ROWS)
    const hidden = stats.length - shown.length
    const title = t('ov.models.title')
    return (
      <TallyCard
        icon={<IconData size={14} />}
        title={title}
        day={props.day}
        className="lc-ov-model-card"
        summary={t('ov.models.summary', { n: fmt(stats.length), tokens: fmt(total) })}
      >
        {stats.length === 0 ? (
          <div className="lc-empty">{t('ov.models.empty')}</div>
        ) : (
          <div className="lc-ov-tallies" role="group" aria-label={title}>
            {shown.map((s, i) => {
              const color = nameColorOf(s.model)
              return (
                <div
                  key={`${s.provider}/${s.model}`}
                  className={'lc-ov-tally lc-ov-model' + (s.active ? '' : ' lc-ov-model-off')}
                  title={t('ov.models.tip', { provider: s.providerName, tokens: fmt(s.total), sessions: fmt(s.sessions) })}
                >
                  <span className="lc-ov-model-rank">{i + 1}</span>
                  <i className="lc-ov-tally-dot" style={{ background: color }} />
                  <span className="lc-ov-model-label">
                    <span className="lc-ov-model-provider">{s.providerName}/</span>
                    <span className="lc-ov-tally-name">{s.name}</span>
                  </span>
                  {!s.active && <span className="lc-ov-model-badge">{t('ov.models.inactive')}</span>}
                  <span className="lc-ov-tally-count">{fmt(s.total)}</span>
                  <i
                    className="lc-ov-tally-bar"
                    style={{ width: `calc(${shareOf(s.total, max)}% - ${Math.round(shareOf(s.total, max) * 12) / 100}px)`, background: color }}
                  />
                </div>
              )
            })}
            {hidden > 0 && (
              <div className="lc-ov-tally-more">{t('ov.models.more', { n: fmt(hidden) })}</div>
            )}
          </div>
        )}
      </TallyCard>
    )
  }
}
