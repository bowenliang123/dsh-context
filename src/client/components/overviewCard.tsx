import type { ReactElement } from 'react'
import { CAT_COLOR } from '../categories'
import { projectOf, relativeTime } from '../overview'
import { fmt, fmtShare } from '../format'
import type { ViewKit } from '../viewkit'
import { Donut } from './donut'

export interface OverviewCardRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  current: boolean
  archived: boolean
  parts: readonly { key: string; value: number }[]
  total: number
  contextWindow?: number
  turns: number
  steps?: number
  tokens: number
  costUsd: number | null
  lastUser?: string
  createdDay?: string
  group?: string
}

export interface OverviewCardProps {
  row: OverviewCardRow
  group?: string
  costLabel: string
  now: number
  onOpen(id: string): void
}

const FALLBACK_COLOR = 'var(--color-gray-400)'

export function makeOverviewCard(kit: ViewKit): (props: OverviewCardProps) => ReactElement {
  const { t } = kit
  return function OverviewCard(props: OverviewCardProps): ReactElement {
    const { row } = props
    const occupancy = row.contextWindow !== undefined && row.contextWindow > 0
      ? fmtShare(row.total, row.contextWindow)
      : null
    const turnsLabel = row.steps === undefined ? String(row.turns) : t('ov.card.turns', { n: row.turns, s: row.steps })
    const project = projectOf(row.cwd)
    const group = props.group !== undefined && props.group !== project ? props.group : undefined
    const colorOf = CAT_COLOR as Record<string, string | undefined>
    const segments = row.parts
      .filter(part => part.value > 0)
      .map(part => ({ key: part.key, color: colorOf[part.key] ?? FALLBACK_COLOR, value: part.value }))
    return (
      <button
        type="button"
        className={'lc-ov-session' + (row.current ? ' lc-ov-session-current' : '')}
        aria-disabled={row.archived || undefined}
        onClick={() => { if (!row.archived) props.onOpen(row.id) }}
      >
        <span className="lc-ov-session-head">
          {row.running && <span className="lc-ov-running" title={t('ov.running')} />}
          <span className="lc-ov-session-title" title={row.title}>{row.title}</span>
          {row.current && <span className="lc-ov-current">{t('ov.current')}</span>}
          {row.archived && <span className="lc-ov-archived" title={t('ov.card.archivedTip')}>{t('ov.card.archived')}</span>}
          <span className="lc-ov-session-times">
            <span className="lc-ov-session-time">{relativeTime(t, row.updatedAt, props.now)}</span>
            {row.createdDay !== undefined && <span className="lc-ov-session-created">{row.createdDay}</span>}
          </span>
        </span>
        {(group !== undefined || project !== undefined) && (
          <span className="lc-ov-session-crumb" title={row.cwd}>
            {group !== undefined && <span className="lc-ov-crumb-group">{group}</span>}
            {group !== undefined && project !== undefined && <span className="lc-ov-crumb-sep">/</span>}
            {project !== undefined && <span className="lc-ov-crumb-project">{project}</span>}
          </span>
        )}
        {segments.length === 0 ? (
          <span className="lc-ov-session-empty">{t('ov.list.noData')}</span>
        ) : (
          <span className="lc-ov-session-body">
            <Donut
              size={64}
              segments={segments}
              centerTop={fmt(row.total)}
              centerSub={occupancy ?? undefined}
            />
            <span className="lc-ov-mini-stats">
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('stats.turns')}</span>
                <span className="lc-ov-mini-value">{turnsLabel}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('ov.card.teamUsage')}</span>
                <span className="lc-ov-mini-value">{fmt(row.tokens)}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('ov.card.teamCost')}</span>
                <span className="lc-ov-mini-value">{props.costLabel}</span>
              </span>
            </span>
          </span>
        )}
        {row.lastUser !== undefined && (
          <span className="lc-ov-session-preview" title={row.lastUser}>
            <span className="lc-ov-session-preview-label">{t('ov.card.lastUser')}</span>
            <span className="lc-ov-session-preview-text">{row.lastUser}</span>
          </span>
        )}
      </button>
    )
  }
}
