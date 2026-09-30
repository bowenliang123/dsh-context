/**
 * One session card in the Context Dashboard's grid: the row's title (wrap-
 * clamped) with the workspace breadcrumb trailing it on the same line (group
 * text / project pill — segments the active workspace scope already asserts
 * are dropped), last-activity and first-active times, and over a mini
 * composition donut (the same seven-category ring the stats board draws, at
 * card scale) the three figures a user scans for — turns and steps, billed
 * tokens, cost. A row whose host folded nothing yet degrades to a
 * metadata-only card (never an error). The whole card is one button: clicking
 * opens the session (the panel's `onOpen`).
 */

import type { ReactElement } from 'react'
import { billedOf, createdDayOf, projectOf, relativeTime, turnsOf, type OverviewRow } from '../overview'
import { partsOf } from '../categories'
import { fmt, fmtShare } from '../format'
import type { ViewKit } from '../viewkit'
import { makeDonut } from './donut'

export interface OverviewCardProps {
  row: OverviewRow
  /** The workspace title claiming this session, when one does (the breadcrumb's group). */
  group?: string
  /** The workspace chip the grid is currently scoped to, when one is on: the
      crumb drops every segment that scope already asserts, so a filtered grid
      never repeats one constant label on every card. */
  workspaceScope?: string
  /** The priced cost label ('—' until the price book lands or nothing billed). */
  costLabel: string
  /** Render instant for the relative-time label. */
  now: number
  onOpen(id: string): void
}

export function makeOverviewCard(kit: ViewKit): (props: OverviewCardProps) => ReactElement {
  const { t } = kit
  const Donut = makeDonut(kit)
  return function OverviewCard(props: OverviewCardProps): ReactElement {
    const { row } = props
    const timeline = row.timeline
    const billed = billedOf(timeline)
    const occupancy = timeline !== null && typeof timeline.contextWindow === 'number' && timeline.contextWindow > 0
      ? fmtShare(timeline.current.total, timeline.contextWindow)
      : null
    // The lead figure: turns and steps when the fold reported counts, the
    // bare turns estimate otherwise (a counts-less head falls back to the
    // request tally inside turnsOf).
    const turns = turnsOf(timeline)
    const steps = timeline?.counts?.steps
    const turnsLabel = steps === undefined ? String(turns) : t('ov.card.turns', { n: turns, s: steps })
    // The breadcrumb: group (workspace title) / project (cwd basename); a
    // session with neither drops the crumb, and the full path stays on the tip.
    // A workspace whose title IS the project (the common single-repo case)
    // shows the name ONCE — never "dsh-context / dsh-context". A segment the
    // active workspace scope already asserts is dropped the same way: under a
    // filter that label is constant across the grid, so it discriminates
    // nothing and must not cost a row.
    const project = projectOf(row.cwd)
    const group = props.group !== undefined && props.group !== project ? props.group : undefined
    const scope = props.workspaceScope
    const crumbGroup = group !== undefined && group !== scope ? group : undefined
    const crumbProject = project !== undefined && project !== scope ? project : undefined
    const created = createdDayOf(row.activity)
    // The footer preview: the user's newest own message, up to two clamped
    // lines under its hairline rule. Absent from rows folded before the fold
    // carried it — the row just stays off the card.
    const lastUser = timeline?.lastUser
    return (
      <button
        type="button"
        className={'lc-ov-session' + (row.current ? ' lc-ov-session-current' : '')}
        onClick={() => { props.onOpen(row.id) }}
      >
        <span className="lc-ov-session-head">
          {row.running && <span className="lc-ov-running" title={t('ov.running')} />}
          <span className="lc-ov-session-title" title={row.title}>{row.title}</span>
          {(crumbGroup !== undefined || crumbProject !== undefined) && (
            <span className="lc-ov-session-crumb" title={row.cwd}>
              {crumbGroup !== undefined && <span className="lc-ov-crumb-group">{crumbGroup}</span>}
              {crumbGroup !== undefined && crumbProject !== undefined && <span className="lc-ov-crumb-sep">/</span>}
              {crumbProject !== undefined && <span className="lc-ov-crumb-project">{crumbProject}</span>}
            </span>
          )}
          {row.current && <span className="lc-ov-current">{t('ov.current')}</span>}
          <span className="lc-ov-session-times">
            <span className="lc-ov-session-time">{relativeTime(t, row.updatedAt, props.now)}</span>
            {created !== undefined && <span className="lc-ov-session-created">{created}</span>}
          </span>
        </span>
        {timeline === null ? (
          <span className="lc-ov-session-empty">{t('ov.list.noData')}</span>
        ) : (
          <span className="lc-ov-session-body">
            <Donut
              size={64}
              segments={partsOf(timeline.current)}
              centerTop={fmt(timeline.current.total)}
              centerSub={occupancy ?? undefined}
            />
            <span className="lc-ov-mini-stats">
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('stats.turns')}</span>
                <span className="lc-ov-mini-value">{turnsLabel}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('tokens.total')}</span>
                <span className="lc-ov-mini-value">{billed === null ? '—' : fmt(billed)}</span>
              </span>
              <span className="lc-ov-mini-stat">
                <span className="lc-ov-mini-label">{t('stats.cost')}</span>
                <span className="lc-ov-mini-value">{props.costLabel}</span>
              </span>
            </span>
          </span>
        )}
        {lastUser !== undefined && (
          <span className="lc-ov-session-preview" title={lastUser}>
            <span className="lc-ov-session-preview-label">{t('ov.card.lastUser')}</span>
            <span className="lc-ov-session-preview-text">{lastUser}</span>
          </span>
        )}
      </button>
    )
  }
}
