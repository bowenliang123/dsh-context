import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type UIEvent } from 'react'
import {
  IconChecklistOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconRightUpOutlineRegular,
  IconWorkspaceTreeOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import {
  fromPartyOf,
  previewOf,
  settledToneOf,
  type CommsAgent,
} from '../commsModel'
import { settledVariantOf, type CommsRow, type FleetDelegationRow } from '../fleetDetail'
import type { FleetTeam, FleetTeamTask } from '../fleetTeam'
import { fmtTime } from '../format'
import { IconChevronDown } from '../primitives'
import {
  layoutPulse,
  PULSE_LANE_HEIGHT,
  PULSE_POINT_PITCH,
  PULSE_TASK_LANE_HEIGHT,
  PULSE_TRACK_PADDING,
  pulseLaneVisibility,
  pulseTaskBadgeOf,
  pulseTaskOf,
  pulseTasksByAgent,
  pulseTimelineItemsOf,
  type PulseLaneInput,
  type PulseLaneLink,
  type PulseTimelineItem,
} from '../pulseModel'
import { containHorizontalOverscroll } from '../overscroll'
import { scrollIntoViewIfPossible } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import { useColumnWindow } from './useRowWindow'
import { ClearableInput } from './clearableInput'
import { AgentAvatar, channelStyle, roleTextOf } from './commsAgent'

interface PulseTimelineProps {
  lanes: PulseLaneInput[]
  links: readonly PulseLaneLink[]
  rows: readonly CommsRow[]
  delegations: readonly FleetDelegationRow[]
  scopedRows: readonly CommsRow[]
  scopedDelegations: readonly FleetDelegationRow[]
  team: FleetTeam | null
  hoveredTaskId: string | null
  selectedAgent: string | null
  selectedEventKey: string | null
  selectedDelegationKey: string | null
  query: string
  pending: boolean
  agentOf: (party: string) => CommsAgent
  onSelectAgent: (id: string) => void
  onSelectEvent: (row: CommsRow) => void
  onSelectDelegation: (delegation: FleetDelegationRow) => void
  onHoverTask: (id: string | null) => void
  onRevealTask: (id: string) => void
  onQuery: (query: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  t: ViewKit['t']
}

export function PulseTimeline(props: PulseTimelineProps): ReactElement {
  const { t } = props
  const [showQuiet, setShowQuiet] = useState(false)
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [hoveredLane, setHoveredLane] = useState<string | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const labelRowsRef = useRef<HTMLDivElement | null>(null)
  const laneView = useMemo(
    () => pulseLaneVisibility(props.lanes, props.scopedRows, props.links, props.selectedAgent, props.query, showQuiet),
    [props.lanes, props.links, props.query, props.scopedRows, props.selectedAgent, showQuiet],
  )
  const visibleIds = laneView.visible
  const matchedIds = laneView.matched
  const timelineItems = useMemo(
    () => pulseTimelineItemsOf(props.rows, props.delegations),
    [props.rows, props.delegations],
  )
  const tasksByAgent = useMemo(() => pulseTasksByAgent(props.team), [props.team])
  const taskAt = useMemo(() => {
    const map = new Map<string, FleetTeamTask>()
    for (const item of timelineItems) {
      const task = pulseTaskOf(item, tasksByAgent)
      if (task !== null) map.set(item.key, task)
    }
    return map
  }, [timelineItems, tasksByAgent])
  const hasTaskLane = taskAt.size > 0
  const windowed = timelineItems.length >= 60
  const recordRange = useColumnWindow(scrollerRef, timelineItems.length, PULSE_POINT_PITCH, windowed, 12)
  const lastRecord = Math.max(0, timelineItems.length - 1)
  const windowFrom = Math.min(recordRange.from, lastRecord)
  const windowTo = Math.min(recordRange.to, lastRecord)
  const visibleItems = windowed ? timelineItems.slice(windowFrom, windowTo + 1) : timelineItems
  const layout = useMemo(
    () => layoutPulse(visibleItems, visibleIds, timelineItems.length, windowFrom),
    [visibleItems, visibleIds, timelineItems.length, windowFrom],
  )
  const laneAt = useMemo(() => new Map(layout.lanes.map(lane => [lane.id, lane])), [layout.lanes])
  const agentAt = useMemo(() => new Map(props.lanes.map(lane => [lane.agent.id, lane.agent])), [props.lanes])
  const hueOf = (id: string): string => {
    /* v8 ignore next 1 */
    return (agentAt.get(id) ?? props.agentOf(id)).hue
  }
  const pointsAt = useMemo(() => {
    const map = new Map<string, typeof layout.points>()
    for (const point of layout.points) {
      const points = map.get(point.item.to)
      if (points === undefined) map.set(point.item.to, [point])
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
  const searching = props.query.trim() !== ''
  const hidden = searching ? 0 : props.lanes.length - visibleIds.length
  const recordTotal = props.scopedRows.length + props.scopedDelegations.length
  const shownRecords = useMemo(() => {
    if (visibleIds.length === props.lanes.length) return timelineItems.length
    const ids = new Set(visibleIds)
    return timelineItems.reduce((count, item) => count + (ids.has(item.to) ? 1 : 0), 0)
  }, [props.lanes.length, timelineItems, visibleIds])
  useEffect(() => {
    const el = scrollerRef.current
    if (el === null) return undefined
    return containHorizontalOverscroll(el)
  }, [])
  const followLabels = (ev: UIEvent<HTMLDivElement>): void => {
    const rows = labelRowsRef.current
    /* v8 ignore next */
    if (rows !== null) rows.style.transform = `translateY(${-ev.currentTarget.scrollTop}px)`
  }
  const taskOffset = hasTaskLane ? PULSE_TASK_LANE_HEIGHT : 0
  const revealRow = (top: number, height: number): void => {
    const el = scrollerRef.current
    /* v8 ignore next */
    if (el === null) return
    const start = top + taskOffset
    const end = start + height
    if (start < el.scrollTop) el.scrollTop = start
    else if (end > el.scrollTop + el.clientHeight) el.scrollTop = end - el.clientHeight
  }
  useEffect(() => {
    const key = props.selectedEventKey ?? props.selectedDelegationKey
    if (key === null) return
    const index = timelineItems.findIndex(item => item.key === key)
    if (index < 0) return
    const el = scrollerRef.current as HTMLDivElement
    el.scrollLeft = Math.max(0, PULSE_TRACK_PADDING + index * PULSE_POINT_PITCH - el.clientWidth / 2)
    const target = el.querySelector(`[data-event-key="${CSS.escape(key)}"]`)
    scrollIntoViewIfPossible(target ?? null, { block: 'nearest', inline: 'center' })
  }, [props.selectedEventKey, props.selectedDelegationKey, timelineItems, layout.points])
  const selectItem = (item: PulseTimelineItem): void => {
    if (item.kind === 'message') props.onSelectEvent(item.row)
    else props.onSelectDelegation(item.delegation)
  }
  const keySelect = (item: PulseTimelineItem, ev: KeyboardEvent<SVGGElement>): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    selectItem(item)
  }
  const jumpTo = (latest: boolean): void => {
    const el = scrollerRef.current as HTMLDivElement
    el.scrollLeft = latest ? el.scrollWidth : 0
  }
  return (
    <section className="lc-card lc-pulse-timeline" aria-busy={props.pending}>
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconWorkspaceTreeOutlineRegular size={14} />{t('fleet.pulse.timeline')}</span>
        <span className="lc-card-sub">
          {t('fleet.pulse.timelineSub', { shown: shownRecords, total: recordTotal, lanes: visibleIds.length })}
        </span>
        <ClearableInput
          type="search"
          className="lc-fleet-search lc-pulse-search"
          placeholder={t('fleet.pulse.searchLanes')}
          clearLabel={t('field.clear')}
          value={props.query}
          onChange={props.onQuery}
        />
        <span className="lc-pulse-title-actions">
          {!searching && props.lanes.length > 8 && (showQuiet || hidden > 0) ? (
            <button type="button" className="lc-pulse-quiet" aria-pressed={showQuiet} onClick={() => { setShowQuiet(value => !value) }}>
              {showQuiet ? t('fleet.pulse.hideQuiet') : t('fleet.pulse.showQuiet', { n: hidden })}
            </button>
          ) : null}
          <span className="lc-pulse-sequence-actions">
            <button type="button" onClick={() => { jumpTo(false) }}>{t('fleet.pulse.first')}</button>
            <button type="button" onClick={() => { jumpTo(true) }}>{t('fleet.pulse.latestRecord')}</button>
          </span>
        </span>
      </div>
      {visibleIds.length > 0 || hidden > 0 ? (
        <div className="lc-pulse-waterfall">
          <div className="lc-pulse-lane-labels">
            <div className="lc-pulse-lane-labels-rows" ref={labelRowsRef}>
              {hasTaskLane ? (
                <div className="lc-pulse-task-lane-label" title={t('fleet.pulse.taskLaneTip')}>
                  <IconChecklistOutlineRegular size={12} />
                  <span>{t('fleet.pulse.taskLane')}</span>
                </div>
              ) : null}
              {layout.lanes.map((lane) => {
                /* v8 ignore next 1 */
                const agent = agentAt.get(lane.id) ?? props.agentOf(lane.id)
                const count = trafficAt.get(lane.id) ?? 0
                const role = roleTextOf(agent, t)
                const navigable = !agent.self && agent.role !== 'other'
                return (
                  <div
                    key={lane.id}
                    className={'lc-pulse-lane-label' + (props.selectedAgent === lane.id ? ' lc-pulse-lane-selected' : '') + (hoveredLane === lane.id ? ' lc-pulse-lane-hover' : '') + (matchedIds.has(lane.id) ? ' lc-pulse-lane-match' : '')}
                    style={{ height: lane.height, '--lc-lane-hue': agent.hue } as CSSProperties}
                    data-lane-label={lane.id}
                    onMouseEnter={() => { setHoveredLane(lane.id) }}
                    onMouseLeave={() => { setHoveredLane(current => current === lane.id ? null : current) }}
                    onFocus={() => { revealRow(lane.top, lane.height) }}
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
                      {searching && !matchedIds.has(lane.id)
                        ? <span className="lc-pulse-lane-linked">{t('fleet.pulse.linked')}</span>
                        : null}
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
                <div
                  className="lc-pulse-lane-label lc-pulse-quiet-lane"
                  style={{ height: PULSE_LANE_HEIGHT }}
                  data-quiet-lane
                  onFocus={() => { revealRow(layout.height, PULSE_LANE_HEIGHT) }}
                >
                  <button type="button" onClick={() => { setShowQuiet(true) }}>
                    <span>{t('fleet.pulse.quietGroup', { n: hidden })}</span>
                    <IconChevronDown size={11} />
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          <div className="lc-pulse-sequence-column">
            <div className="lc-pulse-sequence-scroller" ref={scrollerRef} data-sequence-scroller tabIndex={0} aria-label={t('fleet.pulse.timeline')} onScroll={followLabels}>
              <div className="lc-pulse-track-stack" style={{ height: (hasTaskLane ? PULSE_TASK_LANE_HEIGHT : 0) + layout.height, width: `max(100%, ${layout.width}px)` }}>
                {hasTaskLane ? (
                  <div className="lc-pulse-task-track" style={{ height: PULSE_TASK_LANE_HEIGHT }}>
                    {layout.points.map((point) => {
                      const task = taskAt.get(point.item.key)
                      if (task === undefined) return null
                      const tip = `${task.id} · ${task.subject}`
                      return (
                        <button
                          key={`task-${point.key}`}
                          type="button"
                          className={'lc-pulse-task-chip' + (props.hoveredTaskId === task.id ? ' lc-pulse-task-chip-hover' : '')}
                          style={{ left: point.x }}
                          title={tip}
                          aria-label={tip}
                          data-task-chip={task.id}
                          onClick={() => { props.onRevealTask(task.id) }}
                          onMouseEnter={() => { props.onHoverTask(task.id) }}
                          onMouseLeave={() => { props.onHoverTask(null) }}
                          onFocus={() => { props.onHoverTask(task.id) }}
                          onBlur={() => { props.onHoverTask(null) }}
                        >
                          {pulseTaskBadgeOf(task.id)}
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                <div className="lc-pulse-lane-tracks" style={{ height: layout.height }}>
                  <svg
                    className="lc-pulse-arrows"
                    style={{ width: '100%' }}
                  >
                    <defs>
                      <pattern id="lc-pulse-slot-pattern" width={PULSE_POINT_PITCH} height={PULSE_LANE_HEIGHT} patternUnits="userSpaceOnUse">
                        <circle cx={PULSE_TRACK_PADDING + PULSE_POINT_PITCH / 2} cy={PULSE_LANE_HEIGHT / 2} r="3" className="lc-pulse-slot" />
                      </pattern>
                    </defs>
                    {layout.lanes.map(lane => (
                      <g key={lane.id}>
                        <rect x="0" y={lane.top} width={layout.width} height={lane.height} fill="url(#lc-pulse-slot-pattern)" />
                        <line className="lc-pulse-lane-baseline" x1="0" x2="100%" y1={lane.center} y2={lane.center} />
                      </g>
                    ))}
                    {layout.points.map((point) => {
                      const item = point.item
                      const source = laneAt.get(item.from)
                      if (source === undefined || item.from === item.to || (item.kind === 'message' && item.row.kind === 'settled')) return null
                      const from = props.agentOf(item.from)
                      const to = props.agentOf(item.to)
                      const x = point.x
                      const direction = point.y >= source.center ? 1 : -1
                      const tipY = point.y - direction * 10
                      const baseY = tipY - direction * 7
                      const label = item.kind === 'delegation'
                        ? t('fleet.pulse.delegationLabel', { time: fmtTime(item.time), from: from.name, to: to.name })
                        : t('fleet.pulse.eventLabel', {
                          time: fmtTime(item.time),
                          from: from.name,
                          to: to.name,
                          kind: t(`fleet.kind.${item.row.kind}`),
                        })
                      return (
                        <g
                          key={point.key}
                          className={`lc-pulse-arrow lc-pulse-record-${item.kind}` + (hoveredKey === item.key ? ' lc-pulse-arrow-hover' : '')}
                          data-edge-key={item.key}
                          role="button"
                          tabIndex={0}
                          aria-label={label}
                          onClick={() => { selectItem(item) }}
                          onKeyDown={(ev) => { keySelect(item, ev) }}
                          onMouseEnter={() => { setHoveredKey(item.key) }}
                          onMouseLeave={() => { setHoveredKey(current => current === item.key ? null : current) }}
                          onFocus={() => { setHoveredKey(item.key) }}
                          onBlur={() => { setHoveredKey(current => current === item.key ? null : current) }}
                        >
                          <line className="lc-pulse-edge-line" x1={x} y1={source.center} x2={x} y2={baseY} stroke={from.hue} vectorEffect="non-scaling-stroke" />
                          <path d={`M ${x} ${tipY} L ${x - 5} ${baseY} L ${x + 5} ${baseY} Z`} fill={from.hue} vectorEffect="non-scaling-stroke" />
                          <line className="lc-pulse-edge-hit" x1={x} y1={source.center} x2={x} y2={point.y} stroke="transparent" vectorEffect="non-scaling-stroke" />
                        </g>
                      )
                    })}
                  </svg>
                  {layout.points.map((point) => {
                    const item = point.item
                    const source = laneAt.get(item.from)
                    if (source === undefined || item.from === item.to || (item.kind === 'message' && item.row.kind === 'settled')) return null
                    return (
                      <i
                        key={`source-${point.key}`}
                        className={`lc-pulse-source lc-pulse-record-${item.kind}` + (hoveredKey === item.key ? ' lc-pulse-source-hover' : '')}
                        style={{ left: point.x, top: source.center, background: props.agentOf(item.from).hue }}
                        aria-hidden="true"
                      />
                    )
                  })}
                  {layout.lanes.map(lane => (
                    <div
                      key={lane.id}
                      className={'lc-pulse-lane-track' + (hoveredLane === lane.id ? ' lc-pulse-lane-hover' : '') + (matchedIds.has(lane.id) ? ' lc-pulse-lane-track-match' : '')}
                      style={{ height: lane.height, '--lc-lane-hue': hueOf(lane.id) } as CSSProperties}
                      data-lane={lane.id}
                      onMouseEnter={() => { setHoveredLane(lane.id) }}
                      onMouseLeave={() => { setHoveredLane(current => current === lane.id ? null : current) }}
                    >
                      {(pointsAt.get(lane.id) ?? []).map((point) => {
                        const item = point.item
                        const from = props.agentOf(item.from)
                        const to = props.agentOf(item.to)
                        const selected = item.kind === 'message'
                          ? props.selectedEventKey === item.key
                          : props.selectedDelegationKey === item.key
                        const variant = item.kind === 'message' && item.row.kind === 'settled' && item.row.summary !== undefined
                          ? settledVariantOf(item.row.summary)
                          : null
                        const tone = item.kind === 'delegation' ? 'done' : settledToneOf(variant)
                        const kind = item.kind === 'message' ? item.row.kind : 'delegation'
                        return (
                          <button
                            key={point.key}
                            type="button"
                            className={`lc-pulse-event lc-pulse-kind-${kind} lc-pulse-tone-${tone}` + (point.x > layout.width * 0.65 ? ' lc-pulse-event-late' : '') + (selected ? ' lc-pulse-event-selected' : '') + (hoveredKey === item.key ? ' lc-pulse-event-hover' : '')}
                            style={{ ...channelStyle(from.hue, to.hue), left: point.x, top: point.y - lane.top }}
                            data-event-key={item.key}
                            data-record={item.kind}
                            data-time={item.time}
                            data-from={item.from}
                            data-to={item.to}
                            aria-label={item.kind === 'delegation'
                              ? t('fleet.pulse.delegationLabel', { time: fmtTime(item.time), from: from.name, to: to.name })
                              : item.row.kind === 'settled'
                                ? t('fleet.pulse.settledLabel', { time: fmtTime(item.time), name: to.name })
                                : t('fleet.pulse.eventLabel', {
                                  time: fmtTime(item.time),
                                  from: from.name,
                                  to: to.name,
                                  kind: t(`fleet.kind.${item.row.kind}`),
                                })}
                            aria-pressed={selected}
                            onClick={() => { selectItem(item) }}
                          >
                            <span className="lc-pulse-event-dot" aria-hidden="true">{item.kind === 'delegation' ? '+' : item.row.kind === 'settled' ? '✓' : ''}</span>
                            <span className="lc-pulse-event-label">
                              {item.kind === 'delegation'
                                ? `${to.name} · ${item.delegation.label ?? t('fleet.pulse.delegation')}`
                                : `${fmtTime(item.time)} · ${previewOf(item.row.report ?? item.row.text)}`}
                            </span>
                          </button>
                        )
                      })}
                    </div>
                  ))}
                  {hidden > 0 ? <div className="lc-pulse-lane-track lc-pulse-quiet-track" style={{ height: PULSE_LANE_HEIGHT }} data-quiet-track /> : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      {visibleIds.length === 0 || timelineItems.length === 0 ? (
        <div className="lc-empty lc-pulse-timeline-empty">
          {searching && visibleIds.length === 0
            ? t('fleet.pulse.noLaneMatch')
            : recordTotal === 0 && props.pending
              ? t('fleet.comms.loading')
              : recordTotal === 0 ? t('fleet.comms.empty') : t('fleet.pulse.emptyTimeline')}
        </div>
      ) : null}
    </section>
  )
}
