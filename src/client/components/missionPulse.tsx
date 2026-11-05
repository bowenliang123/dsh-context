import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement } from 'react'
import {
  IconChecklistOutlineRegular,
  IconPanelLeftOutlineRegular,
  IconRightUpOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest } from '../agentTree'
import {
  fromPartyOf,
  includesAgent,
  kindGroupOf,
  previewOf,
  type CommsAgent,
  type CommsKindFilter,
} from '../commsModel'
import { billedTokensOf, estimateSessionCost, type CostCurrency } from '../cost'
import { agentResolverOf } from '../fleetAgents'
import type { CommsRow, FleetDelegationRow } from '../fleetDetail'
import type { FleetDetailState } from '../fleetModel'
import type { FleetTeam } from '../fleetTeam'
import { fmtTime } from '../format'
import { useModelPrices } from '../modelPrices'
import { IconChevronDown, IconChevronUp } from '../primitives'
import { pulseDependencyChainOf, pulseTaskBadgeOf, pulseWorkGroupsOf, pulseWorkItemsOf, pulseWorkPhaseOf, type PulseLaneLink, type PulseLaneStats, type PulseWorkGroup, type PulseWorkItem, type PulseWorkPhase } from '../pulseModel'
import { scrollIntoViewIfPossible } from '../revealScroll'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import type { AgentGraphProps } from './agentGraph'
import { ClearableInput } from './clearableInput'
import { PulseTimeline } from './pulseTimeline'
import { PulseSelectionPill } from './pulseSelection'
import { PulseEvents } from './pulseEvents'
import { useMeasuredWindow } from './useRowWindow'
import { AgentAvatar, roleTextOf } from './commsAgent'
import type { RichKit } from './richText'
import { Section } from './section'

interface PulseHeaderProps {
  agentCount: number
  running: number | null
  tasks: number
  messages: number
  selected: CommsAgent | null
  onClearSelection: () => void
  t: ViewKit['t']
}

const PulseHeader = memo(function PulseHeader(props: PulseHeaderProps): ReactElement {
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
          {props.selected !== null ? <PulseSelectionPill agent={props.selected} onClear={props.onClearSelection} t={t} /> : null}
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
    </header>
  )
})

const WORK_SUBJECT_MAX = 60

function agentPromptOf(details: FleetDetailState, id: string): string | undefined {
  const entry = details.landed.get(id)?.detail
  return (!details.fullPending.has(id)
    ? details.fullLanded.get(id)?.initialPrompt ?? entry?.initialPrompt
    : entry?.initialPrompt)
}

function workSubjectOf(prompt: string | undefined, fallback: string): string {
  return prompt !== undefined && prompt !== ''
    ? previewOf(prompt.length > WORK_SUBJECT_MAX ? prompt.slice(0, WORK_SUBJECT_MAX) + '…' : prompt)
    : fallback
}

const WORK_PHASES: readonly PulseWorkPhase[] = ['in_progress', 'pending', 'completed']

function taskDotOf(item: PulseWorkItem): 'done' | 'ongoing' | 'idle' | 'warning' {
  if (item.status === 'completed' || item.status === 'latest_complete') return 'done'
  if (item.status === 'in_progress') return 'ongoing'
  return item.status === 'idle' || item.ready ? 'idle' : 'warning'
}

function phaseLabelOf(phase: PulseWorkPhase, t: ViewKit['t']): string {
  return t(phase === 'in_progress' ? 'fleet.tasks.filterInProgress'
    : phase === 'pending' ? 'fleet.tasks.filterPending' : 'fleet.tasks.filterCompleted')
}

function agentStateDotOf(state: NonNullable<PulseWorkItem['ownerState']>): 'ongoing' | 'done' | 'idle' {
  return state === 'running' ? 'ongoing' : state === 'latest_complete' ? 'done' : 'idle'
}

function agentStateLabelOf(state: NonNullable<PulseWorkItem['ownerState']>, t: ViewKit['t']): string {
  return t(state === 'running' ? 'agents.running' : state === 'latest_complete' ? 'fleet.pulse.latestTurn' : 'fleet.pulse.idle')
}

function AgentStatePill(props: { state: PulseWorkItem['ownerState']; t: ViewKit['t'] }): ReactElement {
  const { state, t } = props
  return (
    <span className={'lc-pulse-work-agent-state lc-pulse-work-agent-state-' + (state ?? 'unknown')}>
      <StateDot state={state !== undefined ? agentStateDotOf(state) : 'idle'} size={8} />
      <span>{state !== undefined ? agentStateLabelOf(state, t) : t('fleet.pulse.statusUnknown')}</span>
    </span>
  )
}

interface PulseTasksProps {
  items: readonly PulseWorkItem[]
  teamFailure?: string
  visibleItems: readonly PulseWorkItem[]
  details: FleetDetailState
  selectedAgent: string | null
  focusedTaskKey: string | null
  revealVersion: number
  hoveredTaskId: string | null
  hoveredAgent: string | null
  query: string
  agentOf: (party: string) => CommsAgent
  onFocus: (item: PulseWorkItem) => void
  onFocusDependency: (id: string) => void
  onHoverTask: (id: string | null) => void
  onSelectAgent: (id: string) => void
  onQuery: (query: string) => void
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

const WORK_GROUP_HEAD_H = 34
const WORK_ROW_H = 74
const WORK_SEGMENT_MAX = 10

interface WorkSegment {
  key: string
  group: PulseWorkGroup
  from: number
  to: number
}

function workSegmentsOf(groups: readonly PulseWorkGroup[]): WorkSegment[] {
  const segments: WorkSegment[] = []
  for (const group of groups) {
    if (group.items.length <= WORK_SEGMENT_MAX) {
      segments.push({ key: group.key, group, from: 0, to: group.items.length - 1 })
      continue
    }
    for (let from = 0; from < group.items.length; from += WORK_SEGMENT_MAX) {
      segments.push({
        key: `${group.key}#${from}`,
        group,
        from,
        to: Math.min(from + WORK_SEGMENT_MAX, group.items.length) - 1,
      })
    }
  }
  return segments
}

const PulseTasks = memo(function PulseTasks(props: PulseTasksProps): ReactElement {
  const { t } = props
  const [phase, setPhase] = useState<'all' | PulseWorkPhase>('all')
  const itemRefs = useRef(new Map<string, HTMLLIElement>())
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const revealedRef = useRef<string | null>(null)
  const pendingRevealRef = useRef<string | null>(null)
  const shownItems = useMemo(
    () => (phase === 'all' ? props.visibleItems : props.visibleItems.filter(item => pulseWorkPhaseOf(item) === phase)),
    [phase, props.visibleItems],
  )
  const groups: readonly PulseWorkGroup[] = useMemo(() => pulseWorkGroupsOf(shownItems), [shownItems])
  const segments = useMemo(() => workSegmentsOf(groups), [groups])
  const segmentKeys = useMemo(() => segments.map(segment => segment.key), [segments])
  const estimateOf = useCallback((index: number): number => {
    const segment = segments[index]
    return (segment.from === 0 ? WORK_GROUP_HEAD_H : 0) + (segment.to - segment.from + 1) * WORK_ROW_H
  }, [segments])
  const scope = useMeasuredWindow(bodyRef, segmentKeys, estimateOf, shownItems.length)
  const shownSegments = segments.slice(scope.from, scope.to + 1)
  const taskById = new Map(props.items.filter(item => item.kind === 'team').map(item => [item.id, item]))
  const focusedItem = props.focusedTaskKey === null
    ? undefined
    : props.items.find(item => item.key === props.focusedTaskKey)
  const dependencyChain = focusedItem?.kind === 'team'
    ? pulseDependencyChainOf(props.items, focusedItem.id)
    : new Set<string>()
  const counts: Record<'all' | PulseWorkPhase, number> = {
    all: props.visibleItems.length,
    in_progress: 0,
    pending: 0,
    completed: 0,
  }
  for (const item of props.visibleItems) counts[pulseWorkPhaseOf(item)] += 1
  useEffect(() => {
    if (focusedItem === undefined || phase === 'all' || pulseWorkPhaseOf(focusedItem) === phase) return
    setPhase('all')
  }, [focusedItem, props.focusedTaskKey, props.revealVersion])
  useEffect(() => {
    const key = props.focusedTaskKey
    if (key === null) {
      revealedRef.current = null
      pendingRevealRef.current = null
      return
    }
    const el = itemRefs.current.get(key)
    if (el !== undefined) {
      if (revealedRef.current === key) return
      revealedRef.current = key
      pendingRevealRef.current = null
      scrollIntoViewIfPossible(el, { block: 'nearest', behavior: 'smooth' })
      return
    }
    if (revealedRef.current === key || pendingRevealRef.current === key) return
    const segment = segments.find(entry => entry.group.items.slice(entry.from, entry.to + 1).some(item => item.key === key))
    if (segment === undefined) return
    pendingRevealRef.current = key
    scope.scrollToKey(segment.key)
  }, [props.focusedTaskKey, scope, segments])
  return (
    <section className="lc-card lc-pulse-tasks">
      <div className="lc-card-title">
        <span className="lc-card-title-text"><IconChecklistOutlineRegular size={14} />{t('fleet.pulse.work')}</span>
        <span className="lc-pulse-card-tools">
          <span className="lc-card-sub">{t('fleet.pulse.workSub', { shown: shownItems.length, total: props.items.length })}</span>
          <ClearableInput
            type="search"
            className="lc-fleet-search lc-pulse-search"
            placeholder={t('fleet.pulse.searchTasks')}
            clearLabel={t('field.clear')}
            value={props.query}
            onChange={props.onQuery}
          />
        </span>
      </div>
      {props.teamFailure !== undefined ? <div className="lc-pulse-work-warning">{t('fleet.team.failureShort')} · {props.teamFailure}</div> : null}
      <div className="lc-pulse-work-filters" role="group" aria-label={t('fleet.tasks.filterLabel')}>
        <button
          type="button"
          className={'lc-gran-btn' + (phase === 'all' ? ' lc-gran-on' : '')}
          data-work-phase="all"
          aria-pressed={phase === 'all'}
          onClick={() => { setPhase('all') }}
        >
          {t('fleet.tasks.filterAll')}<span className="lc-kind-n">{counts.all}</span>
        </button>
        {WORK_PHASES.map((entry) => {
          const on = phase === entry
          return (
            <button
              key={entry}
              type="button"
              className={'lc-gran-btn' + (on ? ' lc-gran-on' : '')}
              data-work-phase={entry}
              aria-pressed={on}
              onClick={() => { setPhase(entry) }}
            >
              {phaseLabelOf(entry, t)}<span className="lc-kind-n">{counts[entry]}</span>
            </button>
          )
        })}
      </div>
      {shownItems.length > 0 ? (
        <div className="lc-pulse-work-body" ref={bodyRef}>
          {scope.topPad > 0 ? <div aria-hidden="true" style={{ height: scope.topPad }} /> : null}
          {shownSegments.map((segment) => {
            const group = segment.group
            const owner = group.ownerId !== undefined ? props.agentOf(group.ownerId) : null
            const ownerName = group.ownerName ?? owner?.name
            const ownerState = group.items.find(item => item.ownerState !== undefined)?.ownerState
            const agentOnly = group.items.every(item => item.kind === 'agent')
            const hue = owner?.hue ?? 'var(--dsw-alias-border-l2)'
            const headed = segment.from === 0
            return (
              <section
                key={segment.key}
                ref={scope.measure(segment.key)}
                className={'lc-pulse-work-group' + (agentOnly ? ' lc-pulse-work-group-agent' : '')}
                data-owner-group={group.key}
                style={{ '--lc-owner-hue': hue } as CSSProperties}
              >
                {agentOnly || !headed ? null : (
                  <div className="lc-pulse-work-group-head">
                    {owner !== null ? (
                      <button
                        type="button"
                        className="lc-pulse-work-group-owner"
                        data-owner={owner.id}
                        aria-pressed={props.selectedAgent === owner.id}
                        title={t('fleet.tasks.ownerTip')}
                        onClick={() => { props.onSelectAgent(owner.id) }}
                      >
                        <AgentAvatar agent={owner} size="sm" t={t} />
                        <span>{ownerName}</span>
                      </button>
                    ) : (
                      <span className="lc-pulse-work-group-name">{ownerName ?? t('fleet.taskUnowned')}</span>
                    )}
                    {ownerName !== undefined ? <AgentStatePill state={ownerState} t={t} /> : null}
                    <span className="lc-pulse-work-group-count">{t('fleet.tasks.groupCount', { n: group.items.length })}</span>
                  </div>
                )}
                <ol className="lc-pulse-work-list">
                  {group.items.slice(segment.from, segment.to + 1).map((item) => {
                    const focused = props.focusedTaskKey === item.key
                    const ownerSelected = item.ownerId !== undefined && item.ownerId === props.selectedAgent
                    const ownerLinked = item.ownerId !== undefined && item.ownerId === props.hoveredAgent
                    const owner = item.ownerId !== undefined ? props.agentOf(item.ownerId) : null
                    const ownerName = item.ownerName ?? owner?.name
                    const ownerRole = owner !== null ? roleTextOf(owner, t) : ''
                    const entry = item.ownerId !== undefined ? props.details.landed.get(item.ownerId)?.detail : null
                    const full = item.ownerId !== undefined ? props.details.fullLanded.get(item.ownerId) : null
                    const fullPending = item.ownerId !== undefined && props.details.fullPending.has(item.ownerId)
                    const prompt = item.kind === 'agent' && item.ownerId !== undefined
                      ? agentPromptOf(props.details, item.ownerId)
                      : item.description
                    const reply = !fullPending ? full?.lastReply ?? entry?.lastReply : entry?.lastReply
                    const subject = item.kind === 'agent' ? workSubjectOf(prompt, item.subject) : item.subject
                    const dot = taskDotOf(item)
                    const kindLabel = t(item.kind === 'team' ? 'fleet.pulse.teamTask' : 'fleet.pulse.delegation')
                    const showOwnerActions = owner !== null && !owner.self && owner.role !== 'other'
                    return (
                      <li
                        key={item.key}
                        ref={(el) => {
                          if (el !== null) itemRefs.current.set(item.key, el)
                          else itemRefs.current.delete(item.key)
                        }}
                        className={'lc-pulse-work-item' + (focused ? ' lc-pulse-work-focused' : '')
                          + (item.kind === 'team' && dependencyChain.has(item.id) ? ' lc-pulse-work-chain' : '')
                          + (ownerSelected ? ' lc-pulse-work-related' : '')
                          + (item.kind === 'team' && props.hoveredTaskId === item.id ? ' lc-pulse-work-task-hover' : '')
                          + (ownerLinked ? ' lc-pulse-work-linked' : '')}
                        data-task={item.id}
                        style={{ '--lc-owner-hue': owner?.hue ?? 'var(--dsw-alias-border-l2)' } as CSSProperties}
                        onMouseEnter={() => { if (item.kind === 'team') props.onHoverTask(item.id) }}
                        onMouseLeave={() => { if (item.kind === 'team') props.onHoverTask(null) }}
                      >
                        <div className="lc-pulse-work-identity">
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
                              <span title={item.ownerName}>{ownerName}</span>
                              {ownerRole !== '' ? <em>{ownerRole}</em> : null}
                            </button>
                          ) : ownerName !== undefined ? (
                            <span className="lc-pulse-work-owner-name">{ownerName}</span>
                          ) : <span className="lc-pulse-work-unowned">{t('fleet.taskUnowned')}</span>}
                          {ownerName !== undefined ? <AgentStatePill state={item.ownerState} t={t} /> : null}
                        </div>
                        <div className="lc-pulse-work-titleline">
                          <button type="button" className="lc-pulse-work-focus" aria-expanded={focused} onClick={() => { props.onFocus(item) }}>
                            {item.kind === 'team'
                              ? <span className="lc-pulse-work-id" title={`${item.id} · ${item.subject}`}>{pulseTaskBadgeOf(item.id)}</span>
                              : <span className="lc-pulse-work-kind-badge" title={item.id}>{t('fleet.pulse.delegationShort')}</span>}
                            <span
                              className={'lc-pulse-work-subject' + (item.kind === 'agent' ? ' lc-pulse-work-subject-agent' : '')}
                              title={subject}
                            >{subject}</span>
                          </button>
                          <span className="lc-pulse-work-tail">
                            {item.kind === 'team' ? (
                              <span className="lc-pulse-work-status">
                                <StateDot state={dot} size={8} />
                                <span>{t(`fleet.task.${item.status}`)}</span>
                              </span>
                            ) : null}
                            <button
                              type="button"
                              className="lc-pulse-work-chev"
                              aria-expanded={focused}
                              aria-label={t(focused ? 'fleet.collapse' : 'fleet.expand')}
                              onClick={() => { props.onFocus(item) }}
                            >
                              {focused ? <IconChevronUp size={11} /> : <IconChevronDown size={11} />}
                            </button>
                          </span>
                        </div>
                        {!focused && item.kind === 'team' && item.description !== undefined ? (
                          <div className="lc-pulse-work-desc">{item.description}</div>
                        ) : null}
                        {item.kind === 'team' && item.status === 'pending' ? (
                          <div className="lc-pulse-work-readiness">{t(item.ready ? 'fleet.taskReady' : 'fleet.taskBlocked')}</div>
                        ) : null}
                        {item.blockedBy.length > 0 ? (
                          <div className="lc-pulse-work-deps">
                            <span>{t('fleet.tasks.dependsOn')}</span>
                            {item.blockedBy.map((id) => {
                              const blocker = taskById.get(id)
                              return (
                                <button key={id} type="button" data-dependency={id} onClick={() => { props.onFocusDependency(id) }}>
                                  {blocker !== undefined ? <StateDot state={taskDotOf(blocker)} size={7} /> : null}
                                  {pulseTaskBadgeOf(id)}
                                </button>
                              )
                            })}
                          </div>
                        ) : null}
                        {item.kind === 'team' ? (
                          <div className="lc-pulse-work-meta">
                            <span className="lc-pulse-work-raw-id" title={item.id}>{item.id}</span>
                            {item.writeScopes.length > 0 ? <span>{t('fleet.taskScopes')} {item.writeScopes.join(' · ')}</span> : null}
                          </div>
                        ) : null}
                        {item.warnings.map(warning => <div className="lc-pulse-work-warning" key={warning}>{warning}</div>)}
                        {focused ? (
                          <div className="lc-pulse-work-detail">
                            <div className="lc-pulse-work-detail-kind">
                              <span className="lc-pulse-work-kind">{kindLabel}</span>
                              {fullPending ? <span className="lc-pulse-work-loading">{t('fleet.tasks.replyFull')}</span> : null}
                            </div>
                            {prompt !== undefined && prompt !== '' ? (
                              <Section label={t('fleet.tasks.brief')}>
                                <props.rich.RichText text={prompt} mode="md" />
                              </Section>
                            ) : null}
                            {ownerName !== undefined ? (
                              <Section
                                label={t('fleet.tasks.agentBox')}
                                actions={showOwnerActions ? (
                                  <div className="lc-pulse-work-actions">
                                    <button type="button" onClick={() => { props.onOpen(owner.id) }}><IconPanelLeftOutlineRegular size={11} />{t('fleet.openSidebar')}</button>
                                    <button type="button" onClick={() => { props.onEnter(owner.id) }}><IconRightUpOutlineRegular size={11} />{t('fleet.open')}</button>
                                  </div>
                                ) : undefined}
                              >
                                <div className="lc-pulse-work-agentbox">
                                  {owner !== null ? <AgentAvatar agent={owner} size="md" t={t} /> : null}
                                  <div className="lc-pulse-work-agent-copy">
                                    <b>{ownerName}</b>
                                    <div className="lc-pulse-work-agent-meta">
                                      {ownerRole !== '' ? <span>{ownerRole}</span> : null}
                                      <AgentStatePill state={item.ownerState} t={t} />
                                      {item.ownerModel !== undefined ? <span className="lc-pulse-work-agent-model">{item.ownerModel}</span> : null}
                                    </div>
                                  </div>
                                </div>
                              </Section>
                            ) : null}
                            {reply !== undefined ? (
                              <div className="lc-pulse-work-reply">
                                <Section
                                  label={t('fleet.tasks.reply')}
                                  meta={fullPending ? t('fleet.tasks.replyFull') : fmtTime(reply.time)}
                                >
                                  <props.rich.RichText text={reply.text} mode="md" />
                                </Section>
                              </div>
                            ) : fullPending ? (
                              <div className="lc-pulse-work-reply">
                                <Section label={t('fleet.tasks.reply')} meta={t('fleet.tasks.replyFull')}>
                                  {null}
                                </Section>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          })}
          {scope.bottomPad > 0 ? <div aria-hidden="true" style={{ height: scope.bottomPad }} /> : null}
        </div>
      ) : <div className="lc-empty">{t(props.items.length === 0 ? 'fleet.tasks.noTeam' : 'fleet.tasks.noMatch')}</div>}
    </section>
  )
})

export interface MissionPulseProps {
  sessionId?: string
  graph: (props: AgentGraphProps) => ReactElement | null
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
  currency: CostCurrency
  onOpen: (id: string) => void
  onEnter: (id: string) => void
  rich: RichKit
  t: ViewKit['t']
}

export function MissionPulse(props: MissionPulseProps): ReactElement {
  const { t } = props
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null)
  const [hoveredAgent, setHoveredAgent] = useState<string | null>(null)
  const [selectedEventKey, setSelectedEventKey] = useState<string | null>(null)
  const [selectedDelegationKey, setSelectedDelegationKey] = useState<string | null>(null)
  const [focusedTaskKey, setFocusedTaskKey] = useState<string | null>(null)
  const [taskRevealVersion, setTaskRevealVersion] = useState(0)
  const [hoveredTaskId, setHoveredTaskId] = useState<string | null>(null)
  const [kind, setKind] = useState<CommsKindFilter>('all')
  const [query, setQuery] = useState('')
  const [laneQuery, setLaneQuery] = useState('')
  const [workQuery, setWorkQuery] = useState('')
  const { book } = useModelPrices()
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
  const { lanes, links } = useMemo(() => {
    const map = new Map(props.agents)
    const links: PulseLaneLink[] = []
    const nodeAt = new Map((props.forest?.nodes ?? []).map(node => [node.id, node]))
    const statsOf = (id: string): PulseLaneStats | undefined => {
      const node = nodeAt.get(id)
      if (node === undefined) return undefined
      const billed = node.billed ?? 0
      return {
        model: node.model,
        effort: node.reasoningEffort,
        tokens: billed > 0 ? billed : billedTokensOf(node.costUsage),
        cost: estimateSessionCost(node.costUsage, book, props.currency),
      }
    }
    const communicating = new Set<string>()
    for (const row of props.comms) {
      const from = fromPartyOf(row)
      communicating.add(from)
      communicating.add(row.to)
      links.push({ from, to: row.to })
      if (!map.has(from)) map.set(from, agentOf(from))
      if (!map.has(row.to)) map.set(row.to, agentOf(row.to))
    }
    const structural = new Set<string>()
    for (const delegation of props.delegations) {
      structural.add(delegation.from)
      structural.add(delegation.to)
      links.push({ from: delegation.from, to: delegation.to })
      if (!map.has(delegation.from)) map.set(delegation.from, agentOf(delegation.from))
      if (!map.has(delegation.to)) map.set(delegation.to, agentOf(delegation.to))
    }
    const running = new Set((props.forest?.nodes ?? []).filter(node => node.running).map(node => node.id))
    return {
      lanes: [...map.values()].map((agent) => {
        const stats = statsOf(agent.id)
        return {
          agent,
          active: running.has(agent.id) || communicating.has(agent.id) || structural.has(agent.id),
          ...(stats !== undefined ? { stats } : {}),
        }
      }),
      links,
    }
  }, [agentOf, book, props.agents, props.comms, props.currency, props.delegations, props.forest])
  const visibleWork = useMemo(() => {
    const scoped = selectedAgent === null ? workItems : workItems.filter(item => item.ownerId === selectedAgent)
    const needle = workQuery.trim().toLowerCase()
    if (needle === '') return scoped
    return scoped.filter((item) => {
      const owner = item.ownerId !== undefined ? agentOf(item.ownerId).name : undefined
      const prompt = item.kind === 'agent' && item.ownerId !== undefined ? agentPromptOf(props.details, item.ownerId) : undefined
      return [item.id, item.subject, item.ownerName, owner, item.description, workSubjectOf(prompt, item.subject)]
        .some(value => value !== undefined && value.toLowerCase().includes(needle))
    })
  }, [agentOf, props.details, selectedAgent, workItems, workQuery])
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
  useEffect(() => {
    if (props.focusMember !== null) setSelectedAgent(props.focusMember)
  }, [props.focusMember])
  useEffect(() => {
    if (hoveredAgent === null) return
    if (props.forest !== null && props.forest.nodes.some(node => node.id === hoveredAgent)) return
    setHoveredAgent(null)
  }, [hoveredAgent, props.forest])
  const selectAgent = useCallback((id: string): void => {
    setSelectedAgent(current => current === id ? null : id)
  }, [])
  const selectEvent = useCallback((row: CommsRow): void => {
    const opening = selectedEventKey !== row.key
    setSelectedEventKey(opening ? row.key : null)
    setSelectedDelegationKey(null)
    if (opening && row.clipped === true) props.details.requestFull(row.to)
  }, [props.details, selectedEventKey])
  const selectDelegation = useCallback((delegation: FleetDelegationRow): void => {
    setSelectedDelegationKey(current => current === delegation.key ? null : delegation.key)
    setSelectedEventKey(null)
  }, [])
  const focusTask = useCallback((item: PulseWorkItem): void => {
    const opening = focusedTaskKey !== item.key
    setFocusedTaskKey(opening ? item.key : null)
    if (opening && item.ownerId !== undefined) props.details.requestFull(item.ownerId)
  }, [focusedTaskKey, props.details])
  const focusTaskId = useCallback((id: string): void => {
    const item = workItems.find(work => work.key === `team:${id}`)
    if (item === undefined) return
    setSelectedAgent(null)
    setWorkQuery('')
    setFocusedTaskKey(item.key)
    setTaskRevealVersion(current => current + 1)
    if (item.ownerId !== undefined) props.details.requestFull(item.ownerId)
  }, [props.details, workItems])
  const clearSelection = useCallback(() => { setSelectedAgent(null) }, [])
  const closeDetail = useCallback(() => { setSelectedEventKey(null); setSelectedDelegationKey(null) }, [])
  const Graph = useMemo(() => memo(props.graph), [props.graph])
  return (
    <div className="lc-pulse">
      <PulseHeader
        agentCount={lanes.length}
        running={props.forest === null ? null : props.forest.nodes.filter(node => node.running).length}
        tasks={workItems.length}
        messages={messageTotal}
        selected={selected}
        onClearSelection={clearSelection}
        t={t}
      />
      <div className={'lc-pulse-main' + (props.forest !== null ? ' lc-pulse-main-graph' : '')}>
        {props.forest !== null ? (
          <div className="lc-col-graph">
            <Graph
              compact
              sessionId={props.sessionId}
              forest={props.forest}
              team={props.team}
              pinnedId={selectedAgent}
              hoverId={hoveredAgent}
              focusId={props.focusMember}
              onHover={setHoveredAgent}
              onSelect={selectAgent}
              inspector={false}
            />
          </div>
        ) : null}
        <div className="lc-pulse-boards">
          <PulseTimeline
            lanes={lanes}
            links={links}
            rows={visibleRows}
            delegations={visibleDelegations}
            scopedRows={scopedRows}
            scopedDelegations={scopedDelegations}
            team={props.team}
            hoveredTaskId={hoveredTaskId}
            hoveredAgent={hoveredAgent}
            selectedAgent={selectedAgent}
            selectedEventKey={selectedEventKey}
            selectedDelegationKey={selectedDelegationKey}
            query={laneQuery}
            currency={props.currency}
            pending={props.details.pending.size > 0 || props.details.historyPending.size > 0}
            agentOf={agentOf}
            onSelectAgent={selectAgent}
            onSelectEvent={selectEvent}
            onSelectDelegation={selectDelegation}
            onHoverTask={setHoveredTaskId}
            onRevealTask={focusTaskId}
            onQuery={setLaneQuery}
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
            revealVersion={taskRevealVersion}
            hoveredTaskId={hoveredTaskId}
            hoveredAgent={hoveredAgent}
            query={workQuery}
            agentOf={agentOf}
            onFocus={focusTask}
            onFocusDependency={focusTaskId}
            onHoverTask={setHoveredTaskId}
            onSelectAgent={selectAgent}
            onQuery={setWorkQuery}
            onOpen={props.onOpen}
            onEnter={props.onEnter}
            rich={props.rich}
            t={t}
          />
        </div>
      </div>
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
        onClose={closeDetail}
        onSelectAgent={selectAgent}
        onClearSelection={clearSelection}
        onOpen={props.onOpen}
        onEnter={props.onEnter}
        rich={props.rich}
        t={t}
      />
    </div>
  )
}
