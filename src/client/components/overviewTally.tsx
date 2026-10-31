import type { ReactElement, ReactNode } from 'react'
import { nameColorOf } from '../nameColor'
import type { TallyStat } from '../overview'
import { IconApi, IconInspect, type IconComponent } from '../primitives'
import type { ViewKit } from '../viewkit'

const MAX_ROWS = 24

export interface TallyCardProps {
  icon: ReactElement
  title: string
  day?: string | null
  summary: string
  children: ReactNode
}

export function TallyCard(props: TallyCardProps): ReactElement {
  return (
    <div className="lc-card lc-ov-tile lc-ov-tally-card">
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          {props.icon}
          {props.title}
        </span>
        {props.day !== null && props.day !== undefined && <span className="lc-card-sub">{props.day}</span>}
        <span className="lc-card-sub lc-ov-tally-note">{props.summary}</span>
      </div>
      <div className="lc-ov-tile-body">{props.children}</div>
    </div>
  )
}

export interface TallyRowProps {
  name: string
  count: string
  share: number
  color: string
  selected?: boolean
  title?: string
  describedBy?: string
  onSelect?: () => void
  onAnchor?: (el: HTMLElement) => void
  onRelease?: () => void
}

export function TallyRow(props: TallyRowProps): ReactElement {
  const { onAnchor, onRelease } = props
  return (
    <button
      type="button"
      className="lc-ov-tally"
      aria-pressed={props.selected === true}
      {...(props.describedBy !== undefined ? { 'aria-describedby': props.describedBy } : {})}
      {...(props.title !== undefined ? { title: props.title } : {})}
      {...(onAnchor !== undefined
        ? {
          onMouseEnter: (ev: { currentTarget: HTMLElement }) => { onAnchor(ev.currentTarget) },
          onFocus: (ev: { currentTarget: HTMLElement }) => { onAnchor(ev.currentTarget) },
        }
        : {})}
      {...(onRelease !== undefined ? { onMouseLeave: onRelease, onBlur: onRelease } : {})}
      onClick={props.onSelect}
    >
      <i className="lc-ov-tally-dot" style={{ background: props.color }} />
      <span className="lc-ov-tally-name">{props.name}</span>
      <span className="lc-ov-tally-count">×{props.count}</span>
      <i
        className="lc-ov-tally-bar"
        style={{ width: `calc(${props.share}% - ${Math.round(props.share * 12) / 100}px)`, background: props.color }}
      />
    </button>
  )
}

export function shareOf(value: number, max: number): number {
  return Math.round(value / Math.max(max, 1) * 100)
}

export type TallyCardKind = 'tool' | 'command'

interface CardFace {
  icon: IconComponent
  title: string
  empty: string
  summary: string
  more: string
  count: string
  sessions: string
}

const FACES: Record<TallyCardKind, CardFace> = {
  tool: {
    icon: IconInspect,
    title: 'stats.toolCalls',
    empty: 'ov.tools.empty',
    summary: 'ov.tools.summary',
    more: 'ov.tools.more',
    count: 'ov.tools.calls',
    sessions: 'ov.tools.sessions',
  },
  command: {
    icon: IconApi,
    title: 'stats.commands',
    empty: 'ov.cmds.empty',
    summary: 'ov.cmds.summary',
    more: 'ov.cmds.more',
    count: 'ov.cmds.runs',
    sessions: 'ov.cmds.sessions',
  },
}

export interface OverviewTallyProps {
  kind: TallyCardKind
  stats: TallyStat[]
  day?: string | null
  selected?: string | null
  onSelect?: (name: string | null) => void
}

export function makeOverviewTally(kit: ViewKit): (props: OverviewTallyProps) => ReactElement {
  const { t, fmt } = kit
  return function OverviewTally(props: OverviewTallyProps): ReactElement {
    const face = FACES[props.kind]
    const stats = props.stats
    const total = stats.reduce((sum, s) => sum + s.n, 0)
    const max = stats.reduce((top, s) => Math.max(top, s.n), 0)
    const shown = stats.slice(0, MAX_ROWS)
    const hidden = stats.length - shown.length
    const title = t(face.title)
    const Icon = face.icon
    return (
      <TallyCard
        icon={<Icon size={14} />}
        title={title}
        day={props.day}
        summary={t(face.summary, { n: fmt(stats.length), runs: fmt(total) })}
      >
        {stats.length === 0 ? (
          <div className="lc-empty">{t(face.empty)}</div>
        ) : (
          <div className="lc-ov-tallies" role="group" aria-label={title}>
            {shown.map((s) => {
              const pinned = props.selected === s.name
              return (
                <TallyRow
                  key={s.name}
                  name={s.name}
                  count={fmt(s.n)}
                  share={shareOf(s.n, max)}
                  color={nameColorOf(s.name)}
                  selected={pinned}
                  title={`${t(face.count, { n: fmt(s.n) })} · ${t(face.sessions, { n: fmt(s.sessions) })}`}
                  onSelect={() => { props.onSelect?.(pinned ? null : s.name) }}
                />
              )
            })}
            {hidden > 0 && (
              <div className="lc-ov-tally-more">{t(face.more, { n: fmt(hidden) })}</div>
            )}
          </div>
        )}
      </TallyCard>
    )
  }
}
