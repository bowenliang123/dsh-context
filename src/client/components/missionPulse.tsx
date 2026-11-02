import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import {
  IconChecklistOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconRightUpOutlineRegular,
  IconSendOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest } from '../agentTree'
import {
  fromPartyOf,
  includesAgent,
  kindGroupOf,
  previewOf,
  settledToneOf,
  type CommsAgent,
  type CommsKindFilter,
} from '../commsModel'
import { agentResolverOf } from '../fleetAgents'
import { settledVariantOf, type CommsRow } from '../fleetDetail'
import type { FleetDetailState } from '../fleetModel'
import type { FleetTeam } from '../fleetTeam'
import { fmtDateTime, fmtTime } from '../format'
import { IconChevronDown, IconChevronUp, IconClock } from '../primitives'
import {
  layoutPulse,
  pulseTimelineRowsOf,
  pulseVisibleLaneIds,
  pulseWorkItemsOf,
  type PulseLaneInput,
  type PulseWorkItem,
} from '../pulseModel'
import { scrollIntoViewIfPossible } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import type { FleetDetail, FleetMessage } from '../../shared/types'
import { ClearableInput } from './clearableInput'
import { useRowWindow } from './useRowWindow'
import { AgentAvatar, channelStyle, roleTextOf } from './commsAgent'
import { CommsEvent, CommsEventDetail } from './commsEvent'
import type { RichKit } from './richText'

interface PulseHeaderProps {
  agentCount: number
  running: number | null
  tasks: number
  messages: number
  latest: number | undefined
  selected: CommsAgent | null
  onClear: () => void
  t: ViewKit['t']
}

function PulseHeader(props: PulseHeaderProps): ReactElement {
  const { t } = props
  const stats = [
    ['agents', props.agentCount, t('fleet.pulse.agents')],
    ['running', props.running, t('fleet.pulse.running')],
    ['tasks', props.tasks, t('fleet.pulse.tasks')],
    ['messages', props.messages, t('fleet.pulse.messages')],
  ] as const
  return (
    <header className="lc-pulse-header">
      <div className="lc-pulse-heading">
        <div className="lc-pulse-eyebrow">{t('fleet.pulse.eyebrow')}</div>
        <div className="lc-pulse-title-row">
          <span className="lc-pulse-beacon" aria-hidden="true"><i /><i /><i /></span>
          <h2>{t('fleet.pulse.title')}</h2>
        </div>
        <p>{t('fleet.pulse.subtitle')}</p>
      </div>
      <dl className="lc-pulse-stats">
        {stats.map(([key, value, label]) => (
          <div key={key} className={`lc-pulse-stat lc-pulse-stat-${key}`}>
            <dt>{label}</dt>
            <dd data-pulse-stat={key}>{value ?? '—'}</dd>
          </div>
        ))}
      </dl>
      <div className="lc-pulse-latest">
        <span>{t('fleet.pulse.latest')}</span>
        {props.latest !== undefined
          ? <time data-pulse-latest={props.latest}>{fmtDateTime(props.latest)}</time>
          : <span className="lc-pulse-latest-empty">{t('fleet.pulse.noActivity')}</span>}
      </div>
      {props.selected !== null ? (
        <button
          type="button"
          className="lc-pulse-selection"
          aria-label={t('fleet.pulse.clearSelection')}
          title={t('fleet.pulse.clearSelection')}
          onClick={props.onClear}
        >
          <AgentAvatar agent={props.selected} size="sm" t={t} />
          <span>{t('fleet.pulse.selected', { name: props.selected.name })}</span>
          <b aria-hidden="true">×</b>
        </button>
      ) : null}
    </header>
  )
}

interface PulseTimelineProps {
  lanes: PulseLaneInput[]
  rows: readonly CommsRow[]
  scopedRows: readonly CommsRow[]
  selectedAgent: string | null
  selectedEventKey: string | null
  query: string
  pending: boolean
  agentOf: (party: string) => CommsAgent
  onSelectAgent: (id: string) => void
  onSelectEvent: (row: CommsRow) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  t: ViewKit['t']
}

function PulseTimeline(props: PulseTimelineProps): ReactElement {
  const { t } = props
  const [showQuiet, setShowQuiet] = useState(false)
  const [selectedBinStart, setSelectedBinStart] = useState<number | 'all' | null>(null)
  const visibleIds = useMemo(
    () => pulseVisibleLaneIds(props.lanes, props.scopedRows, props.selectedAgent, props.query, showQuiet),
    [props.lanes, props.query, props.scopedRows, props.selectedAgent, showQuiet],
  )
  const fullLayout = useMemo(() => layoutPulse(props.rows, visibleIds), [props.rows, visibleIds])
  const activeBin = typeof selectedBinStart === 'number'
    ? fullLayout.bins.find(bin => bin.start === selectedBinStart)
    : selectedBinStart === null && props.rows.length > 200 ? [...fullLayout.bins].reverse().find(bin => bin.count > 0) : undefined
  const timelineRows = useMemo(
    () => pulseTimelineRowsOf(props.rows, fullLayout.bins, selectedBinStart, props.selectedEventKey),
    [props.rows, fullLayout.bins, selectedBinStart, props.selectedEventKey],
  )
  const layout = useMemo(() => layoutPulse(timelineRows, visibleIds, 24, fullLayout.domain), [timelineRows, visibleIds, fullLayout.domain])
  const laneAt = useMemo(() => new Map(layout.lanes.map(lane => [lane.id, lane])), [layout.lanes])
  const agentAt = useMemo(() => new Map(props.lanes.map(lane => [lane.agent.id, lane.agent])), [props.lanes])
  const pointsAt = useMemo(() => {
    const map = new Map<string, typeof layout.points>()
    for (const point of layout.points) {
      const points = map.get(point.row.to)
      if (points === undefined) map.set(point.row.to, [point])
      else points.push(point)
    }
    return map
  }, [layout.points])
  const trafficAt = useMemo(() => {
    const map = new Map<string, number>()
    for (const row of props.scopedRows) {
      const from = fromPartyOf(row)
      map.set(from, (map.get(from) ?? 0) + 1)
      if (row.to !== from) map.set(row.to, (map.get(row.to) ?? 0) + 1)
    }
    return map
  }, [props.scopedRows])
  const hidden = props.lanes.length - visibleIds.length
  const maxBin = Math.max(1, ...fullLayout.bins.map(bin => bin.count))
  return (
    <section className="lc-card lc-pulse-timeline" aria-busy={props.pending}>
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconClock size={14} />{t('fleet.pulse.timeline')}</span>
        <span className="lc-card-sub">
          {t('fleet.pulse.timelineSub', { shown: timelineRows.length, total: props.scopedRows.length, lanes: visibleIds.length })}
        </span>
        {activeBin !== undefined ? (
          <button type="button" className="lc-pulse-quiet" onClick={() => { setSelectedBinStart('all') }}>{t('fleet.pulse.allActivity')}</button>
        ) : null}
        {props.lanes.length > 8 && (showQuiet || hidden > 0) ? (
          <button type="button" className="lc-pulse-quiet" aria-pressed={showQuiet} onClick={() => { setShowQuiet(value => !value) }}>
            {showQuiet ? t('fleet.pulse.hideQuiet') : t('fleet.pulse.showQuiet', { n: hidden })}
          </button>
        ) : null}
      </div>
      {visibleIds.length > 0 || hidden > 0 ? (
        <div className="lc-pulse-waterfall">
          <div className="lc-pulse-lane-labels">
            <div className="lc-pulse-lane-corner">{t('fleet.pulse.agentLane')}</div>
            {layout.lanes.map((lane) => {
              /* v8 ignore next 1 */
              const agent = agentAt.get(lane.id) ?? props.agentOf(lane.id)
              const count = trafficAt.get(lane.id) ?? 0
              const role = roleTextOf(agent, t)
              const navigable = !agent.self && agent.role !== 'other'
              return (
                <div
                  key={lane.id}
                  className={'lc-pulse-lane-label' + (props.selectedAgent === lane.id ? ' lc-pulse-lane-selected' : '')}
                  style={{ height: lane.height }}
                  data-lane-label={lane.id}
                >
                  <button
                    type="button"
                    className="lc-pulse-lane-agent"
                    data-agent={lane.id}
                    aria-pressed={props.selectedAgent === lane.id}
                    onClick={() => { props.onSelectAgent(lane.id) }}
                  >
                    <AgentAvatar agent={agent} size="md" t={t} />
                    <span className="lc-pulse-lane-name" title={agent.name}>{agent.name}</span>
                  </button>
                  <span className="lc-pulse-lane-meta">
                    {role !== '' ? <span>{role}</span> : null}
                    <span>{t('fleet.pulse.traffic', { n: count })}</span>
                  </span>
                  {navigable ? (
                    <span className="lc-pulse-lane-actions">
                      <button type="button" aria-label={t('fleet.openSidebar')} title={t('fleet.openSidebar')} onClick={() => { props.onOpen(lane.id) }}>
                        <IconPanelLeftOutlineRegular size={11} />
                      </button>
                      <button type="button" aria-label={t('fleet.open')} title={t('fleet.open')} onClick={() => { props.onEnter(lane.id) }}>
                        <IconRightUpOutlineRegular size={11} />
                      </button>
                    </span>
                  ) : null}
                </div>
              )
            })}
            {hidden > 0 ? (
              <div className="lc-pulse-lane-label lc-pulse-quiet-lane" style={{ height: 40 }} data-quiet-lane>
                <button type="button" onClick={() => { setShowQuiet(true) }}>
                  <span>{t('fleet.pulse.quietGroup', { n: hidden })}</span>
                  <IconChevronDown size={11} />
                </button>
              </div>
            ) : null}
          </div>
          <div className="lc-pulse-time-column">
            <div className="lc-pulse-ruler" data-start={layout.domain?.start} data-end={layout.domain?.end}>
              {layout.domain !== null ? (
                <>
                  <div className="lc-pulse-histogram" role="img" aria-label={t('fleet.pulse.histogram')}>
                    {fullLayout.bins.map(bin => (
                      <button
                        key={bin.index}
                        type="button"
                        className={activeBin?.start === bin.start ? 'lc-pulse-bin-on' : ''}
                        aria-pressed={activeBin?.start === bin.start}
                        data-count={bin.count}
                        title={t('fleet.pulse.bin', { n: bin.count })}
                        style={{ height: `${Math.max(4, (bin.count / maxBin) * 32)}px` }}
                        onClick={() => { setSelectedBinStart(activeBin?.start === bin.start ? 'all' : bin.start) }}
                      />
                    ))}
                  </div>
                  <div className="lc-pulse-ruler-times">
                    <time>{fmtTime(layout.domain.start)}</time>
                    {layout.domain.end !== layout.domain.start ? <time>{fmtTime(layout.domain.end)}</time> : null}
                  </div>
                </>
              ) : <span className="lc-pulse-awaiting">{t('fleet.pulse.noActivity')}</span>}
            </div>
            <div className="lc-pulse-track-stack" style={{ height: layout.height }}>
              <svg
                className="lc-pulse-arrows"
                viewBox={`0 0 1000 ${Math.max(1, layout.height)}`}
                preserveAspectRatio="none"
                aria-hidden="true"
              >
                {layout.points.map((point) => {
                  const from = fromPartyOf(point.row)
                  const source = laneAt.get(from)
                  if (point.row.kind === 'settled' || source === undefined || from === point.row.to) return null
                  const x = point.x * 10
                  const direction = point.y >= source.center ? 1 : -1
                  const tipY = point.y - direction * 5
                  const baseY = tipY - direction * 7
                  return (
                    <g key={point.key} className={`lc-pulse-arrow lc-pulse-kind-${point.row.kind}`}>
                      <line x1={x} y1={source.center} x2={x} y2={baseY} vectorEffect="non-scaling-stroke" />
                      <path d={`M ${x} ${tipY} L ${x - 4} ${baseY} L ${x + 4} ${baseY} Z`} vectorEffect="non-scaling-stroke" />
                    </g>
                  )
                })}
              </svg>
              {layout.points.map((point) => {
                const from = fromPartyOf(point.row)
                const source = laneAt.get(from)
                if (point.row.kind === 'settled' || source === undefined || from === point.row.to) return null
                return (
                  <i
                    key={`source-${point.key}`}
                    className={`lc-pulse-source lc-pulse-kind-${point.row.kind}`}
                    style={{ left: `${point.x}%`, top: source.center }}
                    aria-hidden="true"
                  />
                )
              })}
              {layout.lanes.map(lane => (
                <div key={lane.id} className="lc-pulse-lane-track" style={{ height: lane.height }} data-lane={lane.id}>
                  {(pointsAt.get(lane.id) ?? []).map((point) => {
                    const row = point.row
                    const from = props.agentOf(fromPartyOf(row))
                    const to = props.agentOf(row.to)
                    const selected = props.selectedEventKey === row.key
                    const variant = row.kind === 'settled' && row.summary !== undefined ? settledVariantOf(row.summary) : null
                    const tone = settledToneOf(variant)
                    return (
                      <button
                        key={point.key}
                        type="button"
                        className={`lc-pulse-event lc-pulse-kind-${row.kind} lc-pulse-tone-${tone}` + (point.x > 50 ? ' lc-pulse-event-late' : '') + (point.x === 0 ? ' lc-pulse-event-start' : point.x === 100 ? ' lc-pulse-event-end' : '') + (selected ? ' lc-pulse-event-selected' : '')}
                        style={{ ...channelStyle(from.hue, to.hue), left: `${point.x}%`, top: point.y - lane.top }}
                        data-event-key={row.key}
                        data-time={row.time}
                        data-from={fromPartyOf(row)}
                        data-to={row.to}
                        aria-label={row.kind === 'settled'
                          ? t('fleet.pulse.settledLabel', { time: fmtTime(row.time), name: to.name })
                          : t('fleet.pulse.eventLabel', {
                            time: fmtTime(row.time),
                            from: from.name,
                            to: to.name,
                            kind: t(`fleet.kind.${row.kind}`),
                          })}
                        aria-pressed={selected}
                        onClick={() => { props.onSelectEvent(row) }}
                      >
                        <span className="lc-pulse-event-dot" aria-hidden="true" />
                        <span className="lc-pulse-event-label">{fmtTime(row.time)} · {previewOf(row.report ?? row.text)}</span>
                      </button>
                    )
                  })}
                </div>
              ))}
              {hidden > 0 ? <div className="lc-pulse-lane-track lc-pulse-quiet-track" style={{ height: 40 }} data-quiet-track /> : null}
            </div>
          </div>
        </div>
      ) : null}
      {visibleIds.length === 0 || props.rows.length === 0 ? (
        <div className="lc-empty lc-pulse-timeline-empty">
          {props.scopedRows.length === 0 && props.pending
            ? t('fleet.comms.loading')
            : props.scopedRows.length === 0 ? t('fleet.comms.empty') : t('fleet.pulse.emptyTimeline')}
        </div>
      ) : null}
    </section>
  )
}

interface PulseTasksProps {
  items: readonly PulseWorkItem[]
  teamFailure?: string
  visibleItems: readonly PulseWorkItem[]
  details: FleetDetailState
  selectedAgent: string | null
  focusedTaskKey: string | null
  agentOf: (party: string) => CommsAgent
  onFocus: (item: PulseWorkItem) => void
  onFocusDependency: (id: string) => void
  onSelectAgent: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

function PulseTasks(props: PulseTasksProps): ReactElement {
  const { t } = props
  return (
    <section className="lc-card lc-pulse-tasks">
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconChecklistOutlineRegular size={14} />{t('fleet.pulse.work')}</span>
        <span className="lc-card-sub">{t('fleet.pulse.workSub', { shown: props.visibleItems.length, total: props.items.length })}</span>
      </div>
      {props.teamFailure !== undefined ? <div className="lc-pulse-work-warning">{t('fleet.team.failureShort')} · {props.teamFailure}</div> : null}
      {props.visibleItems.length > 0 ? (
        <ol className="lc-pulse-work-list">
          {props.visibleItems.map((item) => {
            const focused = props.focusedTaskKey === item.key
            const owner = item.ownerId !== undefined ? props.agentOf(item.ownerId) : null
            const entry = item.ownerId !== undefined ? props.details.landed.get(item.ownerId)?.detail : null
            const full = item.ownerId !== undefined ? props.details.fullLanded.get(item.ownerId) : null
            const fullPending = item.ownerId !== undefined && props.details.fullPending.has(item.ownerId)
            const prompt = item.kind === 'agent'
              ? (!fullPending ? full?.initialPrompt ?? entry?.initialPrompt : entry?.initialPrompt)
              : item.description
            const reply = !fullPending ? full?.lastReply ?? entry?.lastReply : entry?.lastReply
            const dot = item.status === 'completed' || item.status === 'latest_complete'
              ? 'done'
              : item.status === 'in_progress' ? 'ongoing' : item.status === 'idle' || item.ready ? 'idle' : 'warning'
            return (
              <li
                key={item.key}
                className={'lc-pulse-work-item' + (focused ? ' lc-pulse-work-focused' : '')
                  + (item.ownerId !== undefined && item.ownerId === props.selectedAgent ? ' lc-pulse-work-related' : '')}
                data-task={item.id}
              >
                <div className="lc-pulse-work-row">
                  <button type="button" className="lc-pulse-work-focus" aria-expanded={focused} onClick={() => { props.onFocus(item) }}>
                    <StateDot state={dot} size={8} />
                    <span className="lc-pulse-work-subject" title={item.subject}>{item.subject}</span>
                    <span className="lc-pulse-work-status">
                      {item.kind === 'agent'
                        ? t(item.status === 'in_progress' ? 'agents.running' : item.status === 'latest_complete' ? 'fleet.pulse.latestTurn' : 'fleet.pulse.idle')
                        : t(`fleet.task.${item.status}`)}
                    </span>
                    {focused ? <IconChevronUp size={11} /> : <IconChevronDown size={11} />}
                  </button>
                  {owner !== null ? (
                    <button
                      type="button"
                      className="lc-pulse-work-owner"
                      data-owner={owner.id}
                      aria-pressed={props.selectedAgent === owner.id}
                      title={t('fleet.tasks.ownerTip')}
                      onClick={() => { props.onSelectAgent(owner.id) }}
                    >
                      <AgentAvatar agent={owner} size="sm" t={t} />
                      <span>{item.ownerName}</span>
                    </button>
                  ) : <span className="lc-pulse-work-unowned">{t('fleet.taskUnowned')}</span>}
                </div>
                {item.kind === 'team' && item.status === 'pending' ? (
                  <div className="lc-pulse-work-readiness">{t(item.ready ? 'fleet.taskReady' : 'fleet.taskBlocked')}</div>
                ) : null}
                {item.blockedBy.length > 0 ? (
                  <div className="lc-pulse-work-deps">
                    <span>{t('fleet.tasks.dependsOn')}</span>
                    {item.blockedBy.map(id => (
                      <button key={id} type="button" data-dependency={id} onClick={() => { props.onFocusDependency(id) }}>{id}</button>
                    ))}
                  </div>
                ) : null}
                {focused ? (
                  <div className="lc-pulse-work-detail">
                    <span className="lc-pulse-work-kind">{t(item.kind === 'team' ? 'fleet.pulse.teamTask' : 'fleet.pulse.delegation')}</span>
                    {fullPending ? <span className="lc-pulse-work-loading">{t('fleet.tasks.replyFull')}</span> : null}
                    {prompt !== undefined && prompt !== '' ? <props.rich.RichText text={prompt} mode="md" /> : null}
                    {reply !== undefined ? (
                      <div className="lc-pulse-work-reply">
                        <span>{t('fleet.tasks.reply')} · {fmtTime(reply.time)}</span>
                        <props.rich.RichText text={reply.text} mode="md" />
                      </div>
                    ) : null}
                    {item.writeScopes.length > 0 ? <div>{t('fleet.taskScopes')} {item.writeScopes.join(' · ')}</div> : null}
                    {item.warnings.map(warning => <div className="lc-pulse-work-warning" key={warning}>{warning}</div>)}
                    {owner !== null && !owner.self && owner.role !== 'other' ? (
                      <div className="lc-pulse-work-actions">
                        <button type="button" onClick={() => { props.onOpen(owner.id) }}><IconPanelLeftOutlineRegular size={11} />{t('fleet.openSidebar')}</button>
                        <button type="button" onClick={() => { props.onEnter(owner.id) }}><IconRightUpOutlineRegular size={11} />{t('fleet.open')}</button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </li>
            )
          })}
        </ol>
      ) : <div className="lc-empty">{t(props.items.length === 0 ? 'fleet.tasks.noTeam' : 'fleet.tasks.noMatch')}</div>}
    </section>
  )
}

function fullMessageOf(details: FleetDetailState, row: CommsRow | undefined): FleetMessage | null {
  if (row === undefined) return null
  const detail = details.fullLanded.get(row.to)
  if (detail === null || detail === undefined) return null
  return detail.messages.find(message => message.seq === row.seq && message.kind === row.kind) ?? null
}

function hiddenMessagesOf(details: FleetDetailState, rows: readonly CommsRow[]): number {
  let hidden = 0
  for (const id of new Set(rows.map(row => row.to))) {
    const detail = details.historyLanded.get(id)?.detail ?? details.landed.get(id)?.detail
    if (detail?.messagesTotal !== undefined) hidden += Math.max(0, detail.messagesTotal - detail.messages.length)
  }
  return hidden
}

interface PulseEventsProps {
  rows: readonly CommsRow[]
  scopedRows: readonly CommsRow[]
  details: FleetDetailState
  kind: CommsKindFilter
  query: string
  selectedAgent: string | null
  selectedRow: CommsRow | undefined
  agentOf: (party: string) => CommsAgent
  onKind: (kind: CommsKindFilter) => void
  onQuery: (query: string) => void
  onSelectEvent: (row: CommsRow) => void
  onClose: () => void
  onSelectAgent: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

function PulseEvents(props: PulseEventsProps): ReactElement {
  const { t } = props
  const inspectorRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const counts = { all: props.scopedRows.length, message: 0, report: 0 }
  for (const row of props.scopedRows) counts[kindGroupOf(row)] += 1
  const full = fullMessageOf(props.details, props.selectedRow)
  const windowed = props.rows.length >= 60
  const rowRange = useRowWindow(listRef, props.rows.length, 64, windowed)
  const lastRow = Math.max(0, props.rows.length - 1)
  const windowFrom = Math.min(rowRange.from, lastRow)
  const windowTo = Math.min(rowRange.to, lastRow)
  const shownRows = windowed ? props.rows.slice(windowFrom, windowTo + 1) : props.rows
  const clipped = props.scopedRows.filter(row => row.clipped === true).length
  const hidden = hiddenMessagesOf(props.details, props.scopedRows)
  useEffect(() => {
    if (props.selectedRow !== undefined) scrollIntoViewIfPossible(inspectorRef.current, { block: 'nearest' })
  }, [props.selectedRow])
  return (
    <section className="lc-card lc-pulse-events">
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconSendOutlineRegular size={14} />{t('fleet.pulse.events')}</span>
        <span className="lc-card-sub">{t('fleet.comms.filtered', { n: props.rows.length, total: props.scopedRows.length })}</span>
      </div>
      <div className="lc-fleet-toolbar lc-pulse-event-tools">
        <div className="lc-fleet-filters" role="group" aria-label={t('fleet.comms.kindGroup')}>
          {(['all', 'message', 'report'] as const).map(kind => (
            <button
              key={kind}
              type="button"
              className={'lc-gran-btn' + (props.kind === kind ? ' lc-gran-on' : '')}
              aria-pressed={props.kind === kind}
              onClick={() => { props.onKind(kind) }}
            >
              {t(`fleet.comms.kind.${kind}`)}<span className="lc-kind-n">{counts[kind]}</span>
            </button>
          ))}
        </div>
        <ClearableInput
          type="search"
          className="lc-fleet-search lc-pulse-search"
          placeholder={t('fleet.comms.search')}
          clearLabel={t('field.clear')}
          value={props.query}
          onChange={props.onQuery}
        />
      </div>
      <div className="lc-pulse-event-layout">
        <div className="lc-pulse-event-stream">
          {props.rows.length === 0 ? <div className="lc-empty">{t(props.scopedRows.length === 0 ? 'fleet.comms.empty' : 'fleet.comms.noMatch')}</div> : null}
          <ul className="lc-comms-list lc-pulse-event-list" ref={listRef} hidden={props.rows.length === 0}>
            {windowed && windowFrom > 0 ? <li aria-hidden="true" style={{ height: windowFrom * 64 }} /> : null}
            {shownRows.map(row => (
              <CommsEvent
                key={row.key}
                row={row}
                agentOf={props.agentOf}
                open={props.selectedRow?.key === row.key}
                onToggle={() => { props.onSelectEvent(row) }}
                full={props.selectedRow?.key === row.key ? full : null}
                t={t}
              />
            ))}
            {windowed && windowTo < lastRow ? <li aria-hidden="true" style={{ height: (lastRow - windowTo) * 64 }} /> : null}
          </ul>
        </div>
        <div className="lc-pulse-inspector" ref={inspectorRef}>
          {props.selectedRow !== undefined ? (
            <CommsEventDetail
              row={props.selectedRow}
              agentOf={props.agentOf}
              full={full}
              fullPending={props.details.fullPending.has(props.selectedRow.to)}
              pinnedId={props.selectedAgent}
              onSelect={props.onSelectAgent}
              onOpen={props.onOpen}
              onEnter={props.onEnter}
              onClose={props.onClose}
              rich={props.rich}
              t={t}
            />
          ) : <div className="lc-pulse-inspector-empty">{t('fleet.pulse.selectEvent')}</div>}
        </div>
      </div>
      {props.rows.length < props.scopedRows.length || clipped > 0 || hidden > 0 ? (
        <div className="lc-comms-notes">
          {props.rows.length < props.scopedRows.length
            ? <span>{t('fleet.comms.filtered', { n: props.rows.length, total: props.scopedRows.length })}</span> : null}
          {clipped > 0 ? <span>{t('fleet.comms.clipped', { n: clipped })}</span> : null}
          {hidden > 0 ? <span>{t('fleet.comms.hidden', { n: hidden })}</span> : null}
        </div>
      ) : null}
    </section>
  )
}

export interface MissionPulseProps {
  forest: AgentForest | null
  team: FleetTeam | null
  details: FleetDetailState
  landedDetails: ReadonlyMap<string, FleetDetail>
  comms: readonly CommsRow[]
  agents: ReadonlyMap<string, CommsAgent>
  titles: ReadonlyMap<string, string>
  attested: ReadonlyMap<string, string>
  focusMember: string | null
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

export function MissionPulse(props: MissionPulseProps): ReactElement {
  const { t } = props
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null)
  const [focusedTaskKey, setFocusedTaskKey] = useState<string | null>(null)
  const [kind, setKind] = useState<CommsKindFilter>('all')
  const [query, setQuery] = useState('')
  const agentOf = useMemo(
    () => agentResolverOf(props.agents, props.titles, props.attested, t),
    [props.agents, props.attested, props.titles, t],
  )
  const workItems = useMemo(() => pulseWorkItemsOf(props.forest, props.team), [props.forest, props.team])
  const scopedRows = useMemo(
    () => selectedAgent === null ? [...props.comms] : props.comms.filter(row => includesAgent(row, selectedAgent)),
    [props.comms, selectedAgent],
  )
  const visibleRows = useMemo(() => {
    const needle = query.trim().toLowerCase()
    return scopedRows.filter((row) => {
      if (kind !== 'all' && kindGroupOf(row) !== kind) return false
      if (needle === '') return true
      const from = agentOf(fromPartyOf(row))
      const to = agentOf(row.to)
      return [row.text, row.summary, row.report, from.name, to.name]
        .some(value => value !== undefined && value.toLowerCase().includes(needle))
    })
  }, [agentOf, kind, query, scopedRows])
  const lanes = useMemo(() => {
    const map = new Map(props.agents)
    const communicating = new Set<string>()
    for (const row of props.comms) {
      const from = fromPartyOf(row)
      communicating.add(from)
      communicating.add(row.to)
      if (!map.has(from)) map.set(from, agentOf(from))
      if (!map.has(row.to)) map.set(row.to, agentOf(row.to))
    }
    const running = new Set((props.forest?.nodes ?? []).filter(node => node.running).map(node => node.id))
    return [...map.values()].map(agent => ({
      agent,
      active: running.has(agent.id) || communicating.has(agent.id),
    }))
  }, [agentOf, props.agents, props.comms, props.forest])
  const visibleWork = useMemo(
    () => selectedAgent === null ? workItems : workItems.filter(item => item.ownerId === selectedAgent),
    [selectedAgent, workItems],
  )
  const selectedRow = selectedEventKey === null ? undefined : visibleRows.find(row => row.key === selectedEventKey)
  const selected = selectedAgent !== null ? agentOf(selectedAgent) : null
  const messageTotal = useMemo(() => {
    let total = 0
    for (const detail of props.landedDetails.values()) total += detail.messagesTotal ?? detail.messages.length
    return total
  }, [props.landedDetails])
  useEffect(() => {
    if (props.focusMember !== null) setSelectedAgent(props.focusMember)
  }, [props.focusMember])
  const selectAgent = (id: string): void => {
    setSelectedAgent(current => current === id ? null : id)
  }
  const selectEvent = (row: CommsRow): void => {
    const opening = selectedEventKey !== row.key
    setSelectedEventKey(opening ? row.key : null)
    if (opening && row.clipped === true) props.details.requestFull(row.to)
  }
  const focusTask = (item: PulseWorkItem): void => {
    const opening = focusedTaskKey !== item.key
    setFocusedTaskKey(opening ? item.key : null)
    if (opening && item.ownerId !== undefined) props.details.requestFull(item.ownerId)
  }
  const focusDependency = (id: string): void => {
    const item = workItems.find(work => work.key === `team:${id}`)
    if (item === undefined) return
    setSelectedAgent(null)
    setFocusedTaskKey(item.key)
    if (item.ownerId !== undefined) props.details.requestFull(item.ownerId)
  }
  return (
    <div className="lc-pulse">
      <PulseHeader
        agentCount={lanes.length}
        running={props.forest === null ? null : props.forest.nodes.filter(node => node.running).length}
        tasks={workItems.length}
        messages={messageTotal}
        latest={props.comms[0]?.time}
        selected={selected}
        onClear={() => { setSelectedAgent(null) }}
        t={t}
      />
      <PulseTimeline
        lanes={lanes}
        rows={visibleRows}
        scopedRows={scopedRows}
        selectedAgent={selectedAgent}
        selectedEventKey={selectedEventKey}
        query={query}
        pending={props.details.pending.size > 0 || props.details.historyPending.size > 0}
        agentOf={agentOf}
        onSelectAgent={selectAgent}
        onSelectEvent={selectEvent}
        onOpen={props.onOpen}
        onEnter={props.onEnter}
        t={t}
      />
      <PulseTasks
        items={workItems}
        teamFailure={props.team?.failure}
        visibleItems={visibleWork}
        details={props.details}
        selectedAgent={selectedAgent}
        focusedTaskKey={focusedTaskKey}
        agentOf={agentOf}
        onFocus={focusTask}
        onFocusDependency={focusDependency}
        onSelectAgent={selectAgent}
        onOpen={props.onOpen}
        onEnter={props.onEnter}
        rich={props.rich}
        t={t}
      />
      <PulseEvents
        rows={visibleRows}
        scopedRows={scopedRows}
        details={props.details}
        kind={kind}
        query={query}
        selectedAgent={selectedAgent}
        selectedRow={selectedRow}
        agentOf={agentOf}
        onKind={setKind}
        onQuery={setQuery}
        onSelectEvent={selectEvent}
        onClose={() => { setSelectedEventKey(null) }}
        onSelectAgent={selectAgent}
        onOpen={props.onOpen}
        onEnter={props.onEnter}
        rich={props.rich}
        t={t}
      />
    </div>
  )
}
