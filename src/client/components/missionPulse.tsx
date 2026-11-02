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
  type CommsAgent,
  type CommsKindFilter,
} from '../commsModel'
import { agentResolverOf } from '../fleetAgents'
import type { CommsRow, FleetDelegationRow } from '../fleetDetail'
import type { FleetDetailState } from '../fleetModel'
import type { FleetTeam } from '../fleetTeam'
import { fmtDateTime, fmtTime } from '../format'
import { IconChevronDown, IconChevronUp } from '../primitives'
import { pulseTaskBadgeOf, pulseWorkItemsOf, type PulseWorkItem } from '../pulseModel'
import { scrollIntoViewIfPossible } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import type { FleetDetail, FleetMessage } from '../../shared/types'
import { ClearableInput } from './clearableInput'
import { PulseTimeline } from './pulseTimeline'
import { useRowWindow } from './useRowWindow'
import { AgentAvatar, channelStyle } from './commsAgent'
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

interface PulseTasksProps {
  items: readonly PulseWorkItem[]
  teamFailure?: string
  visibleItems: readonly PulseWorkItem[]
  details: FleetDetailState
  selectedAgent: string | null
  focusedTaskKey: string | null
  hoveredTaskId: string | null
  agentOf: (party: string) => CommsAgent
  onFocus: (item: PulseWorkItem) => void
  onFocusDependency: (id: string) => void
  onHoverTask: (id: string | null) => void
  onSelectAgent: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

function PulseTasks(props: PulseTasksProps): ReactElement {
  const { t } = props
  const itemRefs = useRef(new Map<string, HTMLLIElement>())
  useEffect(() => {
    if (props.focusedTaskKey === null) return
    scrollIntoViewIfPossible(itemRefs.current.get(props.focusedTaskKey) ?? null, { block: 'nearest' })
  }, [props.focusedTaskKey, props.visibleItems])
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
                ref={(el) => {
                  if (el !== null) itemRefs.current.set(item.key, el)
                  else itemRefs.current.delete(item.key)
                }}
                className={'lc-pulse-work-item' + (focused ? ' lc-pulse-work-focused' : '')
                  + (item.ownerId !== undefined && item.ownerId === props.selectedAgent ? ' lc-pulse-work-related' : '')
                  + (item.kind === 'team' && props.hoveredTaskId === item.id ? ' lc-pulse-work-task-hover' : '')}
                data-task={item.id}
                onMouseEnter={() => { if (item.kind === 'team') props.onHoverTask(item.id) }}
                onMouseLeave={() => { if (item.kind === 'team') props.onHoverTask(null) }}
              >
                <div className="lc-pulse-work-row">
                  <button type="button" className="lc-pulse-work-focus" aria-expanded={focused} onClick={() => { props.onFocus(item) }}>
                    <StateDot state={dot} size={8} />
                    {item.kind === 'team' ? (
                      <span className="lc-pulse-work-id" title={`${item.id} · ${item.subject}`}>{pulseTaskBadgeOf(item.id)}</span>
                    ) : null}
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

interface PulseDelegationDetailProps {
  delegation: FleetDelegationRow
  agentOf: (party: string) => CommsAgent
  pinnedId: string | null
  onSelect: (id: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  onClose: () => void
  t: ViewKit['t']
}

function PulseDelegationDetail(props: PulseDelegationDetailProps): ReactElement {
  const { delegation, t } = props
  const from = props.agentOf(delegation.from)
  const to = props.agentOf(delegation.to)
  return (
    <div className="lc-comms-detail lc-pulse-delegation-detail" style={channelStyle(from.hue, to.hue)}>
      <div className="lc-comms-detail-meta">
        <span className="lc-agents-badge">{t('fleet.pulse.delegation')}</span>
        <span className="lc-comms-detail-time">{fmtDateTime(delegation.time)}</span>
        <span className="lc-comms-detail-seq">{t('fleet.comms.detail.seq', { n: delegation.seq })}</span>
        <span className="lc-comms-detail-actions">
          <button type="button" className="lc-inspector-btn lc-comms-detail-close" aria-label={t('fleet.collapse')} onClick={props.onClose}>×</button>
        </span>
      </div>
      <div className="lc-comms-detail-note">{t('fleet.pulse.delegationNote')}</div>
      <div className="lc-pulse-delegation-route">
        <span><AgentAvatar agent={from} size="lg" t={t} /><b>{from.name}</b></span>
        <i>→</i>
        <span><AgentAvatar agent={to} size="lg" t={t} /><b>{to.name}</b></span>
      </div>
      {delegation.label !== undefined ? (
        <section className="lc-comms-detail-section">
          <div className="lc-comms-detail-caption">{t('fleet.pulse.delegationDuty')}</div>
          <div className="lc-pulse-delegation-label">{delegation.label}</div>
        </section>
      ) : null}
      <section className="lc-comms-detail-section">
        <div className="lc-comms-detail-caption">{t('fleet.pulse.delegationMode')}</div>
        <div>{t(`fleet.pulse.mode.${delegation.mode}`)}</div>
      </section>
      <div className="lc-pulse-delegation-actions">
        <button type="button" className="lc-inspector-btn" onClick={() => { props.onSelect(to.id) }}>
          {t(props.pinnedId === to.id ? 'fleet.comms.detail.unfilter' : 'fleet.comms.detail.filter')}
        </button>
        {delegation.mode !== 'external' ? (
          <>
            <button type="button" className="lc-inspector-btn" aria-label={t('fleet.openSidebar')} onClick={() => { props.onOpen(to.id) }}>
              <IconPanelLeftOutlineRegular size={11} />
            </button>
            <button type="button" className="lc-inspector-btn" aria-label={t('fleet.open')} onClick={() => { props.onEnter(to.id) }}>
              <IconRightUpOutlineRegular size={11} />
            </button>
          </>
        ) : null}
      </div>
    </div>
  )
}

interface PulseEventsProps {
  rows: readonly CommsRow[]
  scopedRows: readonly CommsRow[]
  details: FleetDetailState
  kind: CommsKindFilter
  query: string
  selectedAgent: string | null
  selectedRow: CommsRow | undefined
  selectedDelegation: FleetDelegationRow | undefined
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
    if (props.selectedRow !== undefined || props.selectedDelegation !== undefined) {
      scrollIntoViewIfPossible(inspectorRef.current, { block: 'nearest' })
    }
  }, [props.selectedRow, props.selectedDelegation])
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
          {props.selectedDelegation !== undefined ? (
            <PulseDelegationDetail
              delegation={props.selectedDelegation}
              agentOf={props.agentOf}
              pinnedId={props.selectedAgent}
              onSelect={props.onSelectAgent}
              onOpen={props.onOpen}
              onEnter={props.onEnter}
              onClose={props.onClose}
              t={t}
            />
          ) : props.selectedRow !== undefined ? (
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
  delegations: readonly FleetDelegationRow[]
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
  const [selectedDelegationKey, setSelectedDelegationKey] = useState<string | null>(null)
  const [focusedTaskKey, setFocusedTaskKey] = useState<string | null>(null)
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)
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
  const scopedDelegations = useMemo(
    () => selectedAgent === null
      ? [...props.delegations]
      : props.delegations.filter(delegation => delegation.from === selectedAgent || delegation.to === selectedAgent),
    [props.delegations, selectedAgent],
  )
  const visibleDelegations = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return scopedDelegations
    return scopedDelegations.filter((delegation) => {
      const from = agentOf(delegation.from)
      const to = agentOf(delegation.to)
      return [delegation.label, from.name, to.name]
        .some(value => value !== undefined && value.toLowerCase().includes(needle))
    })
  }, [agentOf, query, scopedDelegations])
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
    const structural = new Set<string>()
    for (const delegation of props.delegations) {
      structural.add(delegation.from)
      structural.add(delegation.to)
      if (!map.has(delegation.from)) map.set(delegation.from, agentOf(delegation.from))
      if (!map.has(delegation.to)) map.set(delegation.to, agentOf(delegation.to))
    }
    const running = new Set((props.forest?.nodes ?? []).filter(node => node.running).map(node => node.id))
    return [...map.values()].map(agent => ({
      agent,
      active: running.has(agent.id) || communicating.has(agent.id) || structural.has(agent.id),
    }))
  }, [agentOf, props.agents, props.comms, props.delegations, props.forest])
  const visibleWork = useMemo(
    () => selectedAgent === null ? workItems : workItems.filter(item => item.ownerId === selectedAgent),
    [selectedAgent, workItems],
  )
  const selectedRow = selectedEventKey === null ? undefined : visibleRows.find(row => row.key === selectedEventKey)
  const selectedDelegation = selectedDelegationKey === null
    ? undefined
    : visibleDelegations.find(delegation => delegation.key === selectedDelegationKey)
  const selected = selectedAgent !== null ? agentOf(selectedAgent) : null
  const messageTotal = useMemo(() => {
    let total = 0
    for (const detail of props.landedDetails.values()) total += detail.messagesTotal ?? detail.messages.length
    return total
  }, [props.landedDetails])
  const latestRecordTime = useMemo(() => {
    const latestMessage = props.comms.length === 0 ? undefined : props.comms[0].time
    return props.delegations.reduce<number | undefined>(
      (latest, delegation) => Math.max(latest ?? delegation.time, delegation.time),
      latestMessage,
    )
  }, [props.comms, props.delegations])
  useEffect(() => {
    if (props.focusMember !== null) setSelectedAgent(props.focusMember)
  }, [props.focusMember])
  const selectAgent = (id: string): void => {
    setSelectedAgent(current => current === id ? null : id)
  }
  const selectEvent = (row: CommsRow): void => {
    const opening = selectedEventKey !== row.key
    setSelectedEventKey(opening ? row.key : null)
    setSelectedDelegationKey(null)
    if (opening && row.clipped === true) props.details.requestFull(row.to)
  }
  const selectDelegation = (delegation: FleetDelegationRow): void => {
    setSelectedDelegationKey(current => current === delegation.key ? null : delegation.key)
    setSelectedEventKey(null)
  }
  const focusTask = (item: PulseWorkItem): void => {
    const opening = focusedTaskKey !== item.key
    setFocusedTaskKey(opening ? item.key : null)
    if (opening && item.ownerId !== undefined) props.details.requestFull(item.ownerId)
  }
  const focusTaskId = (id: string): void => {
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
        latest={latestRecordTime}
        selected={selected}
        onClear={() => { setSelectedAgent(null) }}
        t={t}
      />
      <PulseTimeline
        lanes={lanes}
        rows={visibleRows}
        delegations={visibleDelegations}
        scopedRows={scopedRows}
        scopedDelegations={scopedDelegations}
        team={props.team}
        hoveredTaskId={hoveredTaskId}
        selectedAgent={selectedAgent}
        selectedEventKey={selectedEventKey}
        selectedDelegationKey={selectedDelegationKey}
        query={query}
        pending={props.details.pending.size > 0 || props.details.historyPending.size > 0}
        agentOf={agentOf}
        onSelectAgent={selectAgent}
        onSelectEvent={selectEvent}
        onSelectDelegation={selectDelegation}
        onHoverTask={setHoveredTaskId}
        onRevealTask={focusTaskId}
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
        hoveredTaskId={hoveredTaskId}
        agentOf={agentOf}
        onFocus={focusTask}
        onFocusDependency={focusTaskId}
        onHoverTask={setHoveredTaskId}
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
        selectedDelegation={selectedDelegation}
        agentOf={agentOf}
        onKind={setKind}
        onQuery={setQuery}
        onSelectEvent={selectEvent}
        onClose={() => { setSelectedEventKey(null); setSelectedDelegationKey(null) }}
        onSelectAgent={selectAgent}
        onOpen={props.onOpen}
        onEnter={props.onEnter}
        rich={props.rich}
        t={t}
      />
    </div>
  )
}
