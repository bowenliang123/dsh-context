import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement, type UIEvent } from 'react'
import {
  IconChecklistOutlineRegular,
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
import { fmt, fmtTime } from '../format'
import { formatCost, type CostCurrency } from '../cost'
import { modelLabelOf } from '../agentTree'
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
  type PulseLaneStats,
  type PulseTimelineItem,
} from '../pulseModel'
import { containHorizontalOverscroll } from '../overscroll'
import { scrollToPos, settleReveal } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import { rowWindowFor, useColumnWindow, type RowRange } from './useRowWindow'
import { ClearableInput } from './clearableInput'
import { AgentAvatar, channelStyle } from './commsAgent'

interface PulseTimelineProps {
  lanes: PulseLaneInput[]
  links: readonly PulseLaneLink[]
  rows: readonly CommsRow[]
  delegations: readonly FleetDelegationRow[]
  scopedRows: readonly CommsRow[]
  scopedDelegations: readonly FleetDelegationRow[]
  team: FleetTeam | null
  hoveredTaskId: string | null
  hoveredAgent: string | null
  selectedAgent: string | null
  selectedEventKey: string | null
  selectedDelegationKey: string | null
  query: string
  currency: CostCurrency
  pending: boolean
  agentOf: (party: string) => CommsAgent
  onSelectAgent: (id: string) => void
  onSelectEvent: (row: CommsRow) => void
  onSelectDelegation: (delegation: FleetDelegationRow) => void
  onHoverTask: (id: string | null) => void
  onRevealTask: (id: string) => void
  onQuery: (query: string) => void
  onEnter: (id: string) => void
  t: ViewKit['t']
}

const LANE_OVERSCAN = 8
const LANE_WINDOW_INIT = 32
const LANE_FULL_MAX = 200
const RECORD_FULL_MAX = 240
const RECORD_OVERSCAN = 24

function laneWindowFor(scrollTop: number, viewport: number, count: number, offset: number): RowRange | null {
  if (viewport <= 0 || count <= 0) return null
  return rowWindowFor(scrollTop - offset, viewport, PULSE_LANE_HEIGHT, count, LANE_OVERSCAN)
}

function clampTop(el: HTMLDivElement, start: number, end: number): number | undefined {
  if (start < el.scrollTop) return start
  if (end > el.scrollTop + el.clientHeight) return end - el.clientHeight
  return undefined
}

export const PulseTimeline = memo(function PulseTimeline(props: PulseTimelineProps): ReactElement {
  const { t } = props
  const [showQuiet, setShowQuiet] = useState(false)
  const [anchor, setAnchor] = useState<'first' | 'latest'>('first')
  const [hoveredKey, setHoveredKey] = useState<string | null>(null)
  const [taskFilterId, setTaskFilterId] = useState<string | null>(null)
  const [hoveredLane, setHoveredLane] = useState<string | null>(null)
  const [laneScopeState, setLaneScopeState] = useState<{ from: number; to: number } | null>(null)
  const laneHovered = (id: string): boolean => props.hoveredAgent === id || hoveredLane === id
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
  const laneIds = useMemo(() => new Set(visibleIds), [visibleIds])
  const laneRecords = useMemo(() => timelineItems.filter(item => laneIds.has(item.to)), [laneIds, timelineItems])
  const tasksByAgent = useMemo(() => pulseTasksByAgent(props.team), [props.team])
  const taskAt = useMemo(() => {
    const map = new Map<string, FleetTeamTask>()
    for (const item of laneRecords) {
      const task = pulseTaskOf(item, tasksByAgent)
      if (task !== null) map.set(item.key, task)
    }
    return map
  }, [laneRecords, tasksByAgent])
  const laneItems = useMemo(
    () => taskFilterId === null ? laneRecords : laneRecords.filter(item => taskAt.get(item.key)?.id === taskFilterId),
    [laneRecords, taskAt, taskFilterId],
  )
  const hasTaskLane = taskAt.size > 0
  const windowed = laneItems.length > RECORD_FULL_MAX
  const recordRange = useColumnWindow(scrollerRef, laneItems.length, PULSE_POINT_PITCH, windowed, RECORD_OVERSCAN)
  const lastRecord = Math.max(0, laneItems.length - 1)
  const windowFrom = Math.min(recordRange.from, lastRecord)
  const windowTo = Math.min(recordRange.to, lastRecord)
  const visibleItems = windowed ? laneItems.slice(windowFrom, windowTo + 1) : laneItems
  const layout = useMemo(
    () => layoutPulse(visibleItems, visibleIds, laneItems.length, windowFrom),
    [visibleItems, visibleIds, laneItems.length, windowFrom],
  )
  const laneAt = useMemo(() => new Map(layout.lanes.map(lane => [lane.id, lane])), [layout.lanes])
  const laneCount = layout.lanes.length
  const taskOffset = hasTaskLane ? PULSE_TASK_LANE_HEIGHT : 0
  const laneWrapped = laneCount > LANE_FULL_MAX
  const laneScope = !laneWrapped
    ? { from: 0, to: laneCount - 1 }
    : (laneScopeState ?? { from: 0, to: Math.min(LANE_WINDOW_INIT, laneCount) - 1 })
  const shownLanes = layout.lanes.slice(laneScope.from, laneScope.to + 1)
  const shownLaneIds = new Set(shownLanes.map(lane => lane.id))
  const laneTopPad = laneScope.from * PULSE_LANE_HEIGHT
  const laneBottomPad = Math.max(0, (laneCount - laneScope.to - 1) * PULSE_LANE_HEIGHT)
  useLayoutEffect(() => {
    if (!laneWrapped) return
    const el = scrollerRef.current as HTMLDivElement
    const sync = (): void => {
      const next = laneWindowFor(el.scrollTop, el.clientHeight, laneCount, taskOffset) ?? { from: 0, to: laneCount - 1 }
      setLaneScopeState(current => (current !== null && current.from === next.from && current.to === next.to ? current : next))
    }
    sync()
    /* v8 ignore start */
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(sync) : null
    observer?.observe(el)
    return () => { observer?.disconnect() }
    /* v8 ignore stop */
  }, [laneCount, laneWrapped, taskOffset])
  const agentAt = useMemo(() => new Map(props.lanes.map(lane => [lane.agent.id, lane.agent])), [props.lanes])
  const statsAt = useMemo(() => {
    const map = new Map<string, PulseLaneStats>()
    for (const lane of props.lanes) if (lane.stats !== undefined) map.set(lane.agent.id, lane.stats)
    return map
  }, [props.lanes])
  const hueOf = useCallback((id: string): string => {
    /* v8 ignore next 1 */
    return (agentAt.get(id) ?? props.agentOf(id)).hue
  }, [agentAt, props.agentOf])
  const taskHueAt = useMemo(() => {
    const map = new Map<string, string>()
    for (const [ownerId, tasks] of tasksByAgent) {
      for (const task of tasks) map.set(task.id, hueOf(ownerId))
    }
    return map
  }, [hueOf, tasksByAgent])
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
  const agentSelected = props.selectedAgent !== null
  const hidden = searching || agentSelected ? 0 : props.lanes.length - visibleIds.length
  const recordTotal = props.scopedRows.length + props.scopedDelegations.length
  const shownRecords = laneItems.length
  useEffect(() => {
    const el = scrollerRef.current
    if (el === null) return undefined
    return containHorizontalOverscroll(el)
  }, [])
  const followLabels = (ev: UIEvent<HTMLDivElement>): void => {
    const rows = labelRowsRef.current
    /* v8 ignore next */
    if (rows !== null) rows.style.transform = `translateY(${-ev.currentTarget.scrollTop}px)`
    const el = ev.currentTarget
    const next = laneWrapped ? laneWindowFor(el.scrollTop, el.clientHeight, laneCount, taskOffset) : null
    if (next !== null) {
      setLaneScopeState(current => (current !== null && current.from === next.from && current.to === next.to ? current : next))
    }
    const max = el.scrollWidth - el.clientWidth
    if (max <= 1) return
    if (el.scrollLeft <= 0) setAnchor('first')
    else if (el.scrollLeft >= max - 1) setAnchor('latest')
  }
  const revealRow = (top: number, height: number): void => {
    const el = scrollerRef.current
    /* v8 ignore next */
    if (el === null) return
    const start = top + taskOffset
    const adjusted = clampTop(el, start, start + height)
    if (adjusted !== undefined) scrollToPos(el, { top: adjusted })
  }
  useEffect(() => {
    const key = props.selectedEventKey ?? props.selectedDelegationKey
    if (key === null) return
    const index = laneItems.findIndex(item => item.key === key)
    if (index < 0) return
    const el = scrollerRef.current as HTMLDivElement
    const lane = layout.lanes[visibleIds.indexOf(laneItems[index].to)]
    const start = lane.top + taskOffset
    const end = start + lane.height
    const left = Math.max(0, PULSE_TRACK_PADDING + (index + 0.5) * PULSE_POINT_PITCH - el.clientWidth / 2)
    const align = (): boolean => {
      const pos: { top?: number; left?: number } = {}
      const adjusted = clampTop(el, start, end)
      if (adjusted !== undefined) pos.top = adjusted
      if (Math.abs(el.scrollLeft - left) > 1) pos.left = left
      const issued = pos.top !== undefined || pos.left !== undefined
      if (issued) scrollToPos(el, pos)
      return issued
    }
    settleReveal(el, align)
  }, [props.selectedEventKey, props.selectedDelegationKey, laneItems, taskOffset, visibleIds])
  const selectItem = (item: PulseTimelineItem): void => {
    if (item.kind === 'message') props.onSelectEvent(item.row)
    else props.onSelectDelegation(item.delegation)
  }
  const clearTaskFilter = (): void => {
    setTaskFilterId(null)
    const el = scrollerRef.current as HTMLDivElement
    el.focus()
  }
  const toggleTask = (id: string): void => {
    if (taskFilterId === id) {
      setTaskFilterId(null)
      return
    }
    setTaskFilterId(id)
    props.onRevealTask(id)
  }
  const hoverRecord = (item: PulseTimelineItem): void => {
    setHoveredKey(item.key)
    props.onHoverTask(taskAt.get(item.key)?.id ?? null)
  }
  const unhoverRecord = (item: PulseTimelineItem): void => {
    setHoveredKey(current => current === item.key ? null : current)
    props.onHoverTask(null)
  }
  const keySelect = (item: PulseTimelineItem, ev: KeyboardEvent<SVGGElement>): void => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    selectItem(item)
  }
  const jumpTo = (target: 'first' | 'latest'): void => {
    setAnchor(target)
    const el = scrollerRef.current as HTMLDivElement
    scrollToPos(el, { left: target === 'latest' ? el.scrollWidth : 0 })
  }
  return (
    <section className="lc-card lc-pulse-timeline" aria-busy={props.pending}>
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconWorkspaceTreeOutlineRegular size={14} />{t('fleet.pulse.timeline')}</span>
        <span className="lc-pulse-card-tools">
          <span className="lc-card-sub">
            {t('fleet.pulse.timelineSub', { shown: shownRecords, total: recordTotal, lanes: visibleIds.length })}
          </span>
          {taskFilterId !== null ? (
            <button
              type="button"
              className="lc-pulse-task-filter"
              style={{ '--lc-task-hue': taskHueAt.get(taskFilterId) } as CSSProperties}
              aria-label={t('fleet.pulse.clearTaskFilter')}
              title={t('fleet.pulse.clearTaskFilter')}
              onClick={clearTaskFilter}
            >
              {t('fleet.pulse.taskFilter', { id: pulseTaskBadgeOf(taskFilterId) })} ×
            </button>
          ) : null}
          <ClearableInput
            type="search"
            className="lc-fleet-search lc-pulse-search"
            placeholder={t('fleet.pulse.searchLanes')}
            clearLabel={t('field.clear')}
            value={props.query}
            onChange={props.onQuery}
          />
          <span className="lc-pulse-title-actions">
            {!searching && !agentSelected && props.lanes.length > 8 && (showQuiet || hidden > 0) ? (
              <button type="button" className="lc-pulse-quiet" aria-pressed={showQuiet} onClick={() => { setShowQuiet(value => !value) }}>
                {showQuiet ? t('fleet.pulse.hideQuiet') : t('fleet.pulse.showQuiet', { n: hidden })}
              </button>
            ) : null}
            <span className="lc-gran lc-pulse-sequence-actions" role="group">
              <button
                type="button"
                className={'lc-gran-btn' + (anchor === 'first' ? ' lc-gran-on' : '')}
                onClick={() => { jumpTo('first') }}
              >{t('fleet.pulse.first')}</button>
              <button
                type="button"
                className={'lc-gran-btn' + (anchor === 'latest' ? ' lc-gran-on' : '')}
                onClick={() => { jumpTo('latest') }}
              >{t('fleet.pulse.latestRecord')}</button>
            </span>
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
              {laneTopPad > 0 ? <div aria-hidden="true" style={{ height: laneTopPad }} /> : null}
              {shownLanes.map((lane) => {
                /* v8 ignore next 1 */
                const agent = agentAt.get(lane.id) ?? props.agentOf(lane.id)
                const count = trafficAt.get(lane.id) ?? 0
                const navigable = !agent.self && agent.role !== 'other'
                const stats = statsAt.get(lane.id)
                const model = stats?.model !== undefined ? modelLabelOf(stats.model, stats.effort) : undefined
                const usage = [
                  stats !== undefined && stats.tokens > 0 ? t('fleet.pulse.laneTokens', { n: fmt(stats.tokens) }) : null,
                  stats !== undefined && stats.cost !== null ? formatCost(stats.cost, props.currency) : null,
                ].filter((part): part is string => part !== null).join(' · ')
                const tasks = tasksByAgent.get(lane.id)?.length ?? 0
                const counts = t('fleet.pulse.laneTasks', { n: tasks }) + ' · ' + t('fleet.pulse.traffic', { n: count })
                return (
                  <div
                    key={lane.id}
                    className={'lc-pulse-lane-label' + (props.selectedAgent === lane.id ? ' lc-pulse-lane-selected' : '') + (laneHovered(lane.id) ? ' lc-pulse-lane-hover' : '') + (matchedIds.has(lane.id) ? ' lc-pulse-lane-match' : '')}
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
                      title={agent.name}
                      onClick={() => { props.onSelectAgent(lane.id) }}
                    >
                      <AgentAvatar agent={agent} size="md" t={t} />
                      <span className="lc-pulse-lane-copy">
                        <span className="lc-pulse-lane-head">
                          <span className="lc-pulse-lane-name">{agent.name}</span>
                          {searching && !matchedIds.has(lane.id)
                            ? <span className="lc-pulse-lane-linked">{t('fleet.pulse.linked')}</span>
                            : null}
                        </span>
                        {model !== undefined ? <span className="lc-pulse-lane-model" title={model}>{model}</span> : null}
                        {usage !== '' ? <span className="lc-pulse-lane-usage" title={usage}>{usage}</span> : null}
                        <span className="lc-pulse-lane-counts" title={counts}>{counts}</span>
                      </span>
                    </button>
                    {navigable ? (
                      <button
                        type="button"
                        className="lc-pulse-lane-open"
                        aria-label={t('fleet.open')}
                        title={t('fleet.open')}
                        onClick={() => { props.onEnter(lane.id) }}
                      >
                        <IconRightUpOutlineRegular size={11} />
                      </button>
                    ) : null}
                  </div>
                )
              })}
              {laneBottomPad > 0 ? <div aria-hidden="true" style={{ height: laneBottomPad }} /> : null}
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
                          className={'lc-pulse-task-chip' + (props.hoveredTaskId === task.id ? ' lc-pulse-task-chip-hover' : '') + (hoveredKey === point.item.key ? ' lc-pulse-task-chip-current' : '') + (taskFilterId === task.id ? ' lc-pulse-task-chip-selected' : '')}
                          style={{ left: point.x, '--lc-task-hue': taskHueAt.get(task.id) } as CSSProperties}
                          title={tip}
                          aria-label={tip}
                          data-task-chip={task.id}
                          aria-pressed={taskFilterId === task.id}
                          onClick={() => { toggleTask(task.id) }}
                          onMouseEnter={() => { hoverRecord(point.item) }}
                          onMouseLeave={() => { unhoverRecord(point.item) }}
                          onFocus={() => { hoverRecord(point.item) }}
                          onBlur={() => { unhoverRecord(point.item) }}
                        >
                          <span>{pulseTaskBadgeOf(task.id)}</span>
                        </button>
                      )
                    })}
                  </div>
                ) : null}
                <div className="lc-pulse-lane-tracks" style={{ height: layout.height }}>
                  {laneTopPad > 0 ? <div aria-hidden="true" style={{ height: laneTopPad }} /> : null}
                  <svg
                    className="lc-pulse-arrows"
                    style={{ width: '100%' }}
                  >
                    <defs>
                      <pattern id="lc-pulse-slot-pattern" width={PULSE_POINT_PITCH} height={PULSE_LANE_HEIGHT} patternUnits="userSpaceOnUse">
                        <circle cx={PULSE_TRACK_PADDING + PULSE_POINT_PITCH / 2} cy={PULSE_LANE_HEIGHT / 2} r="3" className="lc-pulse-slot" />
                      </pattern>
                    </defs>
                    {shownLanes.map(lane => (
                      <g key={lane.id}>
                        <rect x="0" y={lane.top} width={layout.width} height={lane.height} fill="url(#lc-pulse-slot-pattern)" />
                        <line className="lc-pulse-lane-baseline" x1="0" x2="100%" y1={lane.center} y2={lane.center} />
                      </g>
                    ))}
                    {layout.points.filter(point => shownLaneIds.has(point.item.to)).map((point) => {
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
                          onMouseEnter={() => { hoverRecord(item) }}
                          onMouseLeave={() => { unhoverRecord(item) }}
                          onFocus={() => { hoverRecord(item) }}
                          onBlur={() => { unhoverRecord(item) }}
                        >
                          <line className="lc-pulse-edge-line" x1={x} y1={source.center} x2={x} y2={baseY} stroke={from.hue} vectorEffect="non-scaling-stroke" />
                          <path d={`M ${x} ${tipY} L ${x - 5} ${baseY} L ${x + 5} ${baseY} Z`} fill={from.hue} vectorEffect="non-scaling-stroke" />
                          <line className="lc-pulse-edge-hit" x1={x} y1={source.center} x2={x} y2={point.y} stroke="transparent" vectorEffect="non-scaling-stroke" />
                        </g>
                      )
                    })}
                  </svg>
                  {layout.points.filter(point => shownLaneIds.has(point.item.to)).map((point) => {
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
                  {shownLanes.map(lane => (
                    <div
                      key={lane.id}
                      className={'lc-pulse-lane-track' + (laneHovered(lane.id) ? ' lc-pulse-lane-hover' : '') + (matchedIds.has(lane.id) ? ' lc-pulse-lane-track-match' : '')}
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
                            onMouseEnter={() => { hoverRecord(item) }}
                            onMouseLeave={() => { unhoverRecord(item) }}
                            onFocus={() => { hoverRecord(item) }}
                            onBlur={() => { unhoverRecord(item) }}
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
      {visibleIds.length === 0 || laneItems.length === 0 ? (
        <div className="lc-empty lc-pulse-timeline-empty">
          {searching && visibleIds.length === 0
            ? t('fleet.pulse.noLaneMatch')
            : recordTotal === 0 && props.pending
              ? t('fleet.comms.loading')
              : recordTotal > 0 || agentSelected ? t('fleet.pulse.emptyTimeline') : t('fleet.comms.empty')}
        </div>
      ) : null}
    </section>
  )
})
