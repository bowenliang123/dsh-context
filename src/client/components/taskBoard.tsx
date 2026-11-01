import { memo, useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent, type ReactElement } from 'react'
import { IconChecklistOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest, AgentNode } from '../agentTree'
import { BRAND_HUE, familyHue } from '../agentTree'
import { avatarNameOf } from '../commsModel'
import { fmtTime } from '../format'
import { boardAvatarLabelsOf } from '../fleetAgents'
import { familyOthersOf, memberIdByName, type FleetTeam, type FleetTeamTask } from '../fleetTeam'
import type { FleetDetail } from '../../shared/types'
import { alignRowInCard, scrollIntoViewIfPossible } from '../revealScroll'
import { ClearableInput } from './clearableInput'
import { AgentAvatar } from './commsAgent'
import { Section } from './section'
import { memberStyle, runMetaOf } from './memberBoard'
import type { RichKit } from './richText'
import type { ViewKit } from '../viewkit'
import { IconChevronDown } from '../primitives'

export interface TaskBoardProps {
  team: FleetTeam | null
  forest: AgentForest | null
  detailOf: (id: string) => { detail: FleetDetail | null } | undefined
  fullOf: (id: string) => { detail: FleetDetail | null; pending: boolean }
  onOpenOwner: (id: string) => void
  ownerFilter: string | null
  onOwnerFilter: (key: string | null) => void
  focusTaskId: string | null
  onFocusTask: (id: string | null) => void
  pinnedId?: string | null
  hoverId?: string | null
  onPinMember: (id: string | null) => void
  onHoverMember: (id: string | null) => void
  rich: RichKit
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

type TaskStatus = 'in_progress' | 'pending' | 'completed'
type StatusFilter = 'all' | TaskStatus

const STATUS_ORDER: readonly TaskStatus[] = ['in_progress', 'pending', 'completed']

interface WorkRow {
  key: string
  kind: 'team' | 'agent'
  subject: string
  status: TaskStatus
  dot: 'done' | 'ongoing' | 'idle' | 'warning'
  ownerKey?: string
  ownerLabel?: string
  teamTask?: FleetTeamTask
  node?: AgentNode
}

function rowOfTask(task: FleetTeamTask): WorkRow {
  return {
    key: task.id,
    kind: 'team',
    subject: task.subject,
    status: task.status,
    dot: task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'ongoing' : task.ready ? 'idle' : 'warning',
    ...(task.ownerName !== undefined ? { ownerKey: task.ownerName, ownerLabel: task.ownerName } : {}),
    teamTask: task,
  }
}

function rowOfAgent(node: AgentNode): WorkRow {
  const status: TaskStatus = node.running ? 'in_progress' : node.completed ? 'completed' : 'pending'
  return {
    key: node.id,
    kind: 'agent',
    subject: node.label,
    status,
    dot: status === 'in_progress' ? 'ongoing' : status === 'completed' ? 'done' : 'idle',
    ownerKey: node.id,
    ownerLabel: node.label,
    node,
  }
}

function orderRows(rows: WorkRow[]): WorkRow[] {
  return STATUS_ORDER.flatMap(key =>
    key === 'pending'
      ? rows.filter(row => row.status === 'pending').sort((a, b) => Number(b.teamTask?.ready === true) - Number(a.teamTask?.ready === true))
      : rows.filter(row => row.status === key))
}

const MarkdownBody = memo(function MarkdownBody(props: { rich: RichKit; text: string }): ReactElement {
  return <props.rich.RichText text={props.text} mode="md" />
})

function TaskTextSection(props: { label: string; text: string; rich: RichKit; meta?: ReactElement }): ReactElement {
  const [mode, setMode, json] = props.rich.useRichMode(props.text)
  return (
    <Section
      label={props.label}
      actions={<props.rich.RichSwitch mode={mode} json={json} onPick={setMode} />}
      meta={props.meta}
    >
      <props.rich.RichText text={props.text} mode={mode} />
    </Section>
  )
}

interface OwnerGroup {
  key: string
  label: string | null
  hue: string
  role: 'lead' | 'teammate' | 'agent' | 'stray' | 'unowned'
  nodeId?: string
  rows: WorkRow[]
}

export function TaskBoard(props: TaskBoardProps): ReactElement {
  const { team, forest, rich, t, fmt } = props
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(new Set())
  const [scrollTask, setScrollTask] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<StatusFilter>('all')
  const boardRef = useRef<HTMLDivElement | null>(null)
  const rowOf = useCallback((id: string): HTMLElement | null => {
    /* v8 ignore next 1 */
    return boardRef.current?.querySelector<HTMLElement>(`[data-task="${CSS.escape(id)}"]`) ?? null
  }, [])

  const teamTasks = useMemo(() => team?.tasks ?? [], [team])
  const byId = useMemo(() => new Map(teamTasks.map(task => [task.id, task])), [teamTasks])
  const agentNodes = useMemo(() => familyOthersOf(forest, team), [forest, team])
  const avatarLabels = useMemo(() => boardAvatarLabelsOf(team, agentNodes, t), [team, agentNodes, t])
  const rows = useMemo(() => [...teamTasks.map(rowOfTask), ...agentNodes.map(rowOfAgent)], [teamTasks, agentNodes])

  const focused = props.focusTaskId
  useEffect(() => {
    if (focused === null) return
    scrollIntoViewIfPossible(rowOf(focused), { block: 'nearest' })
  }, [focused, rowOf])

  useEffect(() => {
    if (scrollTask === null) return
    const card = boardRef.current
    scrollIntoViewIfPossible(card, { block: 'start', behavior: 'smooth' })
    const row = rowOf(scrollTask)
    /* v8 ignore start */
    if (row === null) {
      setScrollTask(null)
      return
    }
    /* v8 ignore stop */
    const head = (row.closest('.lc-tasks-group') as HTMLElement).querySelector<HTMLElement>('.lc-tasks-group-head')
    alignRowInCard(card, row, head !== null ? head.getBoundingClientRect().height : 0)
    setScrollTask(null)
  }, [rowOf, scrollTask])

  const chain = useMemo(() => {
    if (focused === null) return null
    const out = new Set<string>()
    const queue = [focused]
    while (queue.length > 0) {
      /* v8 ignore next 1 */
      const id = queue.pop() ?? ''
      for (const dep of byId.get(id)?.blockedBy ?? []) {
        if (!out.has(dep)) {
          out.add(dep)
          queue.push(dep)
        }
      }
    }
    out.delete(focused)
    return out
  }, [focused, byId])

  const ownerVisible = useMemo(
    () => props.ownerFilter === null ? rows : rows.filter(row => row.ownerKey === props.ownerFilter),
    [rows, props.ownerFilter],
  )

  const filterLabel = useMemo(() => {
    const key = props.ownerFilter
    if (key === null) return null
    return rows.find(row => row.ownerKey === key)?.ownerLabel ?? key
  }, [props.ownerFilter, rows])

  const counts = useMemo(() => {
    const c: Record<StatusFilter, number> = { all: ownerVisible.length, in_progress: 0, pending: 0, completed: 0 }
    for (const row of ownerVisible) c[row.status]++
    return c
  }, [ownerVisible])

  const needle = query.trim().toLowerCase()
  const matches = (row: WorkRow): boolean => {
    if (status !== 'all' && row.status !== status) return false
    if (needle === '') return true
    return row.subject.toLowerCase().includes(needle)
      || (row.ownerLabel ?? '').toLowerCase().includes(needle)
      || row.key.toLowerCase().includes(needle)
  }

  const groups = useMemo((): OwnerGroup[] => {
    const out: OwnerGroup[] = []
    const strays: string[] = []
    if (team !== null) {
      team.members.forEach((member, index) => {
        const groupRows = ownerVisible.filter(row => row.ownerKey === member.name && matches(row))
        if (groupRows.length > 0) {
          out.push({
            key: member.name,
            label: member.name,
            hue: member.role === 'lead' ? BRAND_HUE : familyHue(index),
            role: member.role,
            nodeId: member.id,
            rows: orderRows(groupRows),
          })
        }
      })
      for (const row of ownerVisible) {
        if (row.kind !== 'team' || row.ownerKey === undefined || strays.includes(row.ownerKey)) continue
        if (!team.members.some(member => member.name === row.ownerKey)) strays.push(row.ownerKey)
      }
      for (const name of strays) {
        const groupRows = ownerVisible.filter(row => row.ownerKey === name && matches(row))
        if (groupRows.length > 0) {
          out.push({ key: name, label: name, hue: '', role: 'stray', rows: orderRows(groupRows) })
        }
      }
    }
    for (const node of agentNodes) {
      const groupRows = ownerVisible.filter(row => row.ownerKey === node.id && matches(row))
      if (groupRows.length > 0) {
        out.push({
          key: node.id,
          label: node.label,
          hue: familyHue(node.family),
          role: 'agent',
          nodeId: node.id,
          rows: orderRows(groupRows),
        })
      }
    }
    const unowned = ownerVisible.filter(row => row.ownerKey === undefined && matches(row))
    if (unowned.length > 0) {
      out.push({ key: 'unowned', label: null, hue: '', role: 'unowned', rows: orderRows(unowned) })
    }
    return out
  }, [team, agentNodes, ownerVisible, needle, status, props.ownerFilter])

  const visibleCount = groups.reduce((n, group) => n + group.rows.length, 0)

  const toggleOpen = (row: WorkRow): void => {
    const opening = !openTasks.has(row.key)
    setOpenTasks((prev) => {
      const next = new Set(prev)
      if (opening) next.add(row.key)
      else next.delete(row.key)
      return next
    })
    if (opening) {
      setScrollTask(row.key)
      const ownerId = ownerSessionId(row)
      if (ownerId !== undefined) props.onOpenOwner(ownerId)
    }
  }

  const flashTask = (id: string): void => {
    props.onFocusTask(props.focusTaskId === id ? null : id)
  }

  const ownerSessionId = (row: WorkRow): string | undefined =>
    row.kind === 'team' ? memberIdByName(team, row.ownerKey) : row.node?.id

  const pickOwner = (row: WorkRow): void => {
    const id = ownerSessionId(row)
    if (id !== undefined) props.onPinMember(id)
  }

  const rowClass = (row: WorkRow): string => {
    const ownerId = ownerSessionId(row)
    return 'lc-team-task'
      + (props.focusTaskId === row.key ? ' lc-team-task-focus' : '')
      + (chain?.has(row.key) === true ? ' lc-team-task-chain' : '')
      + (openTasks.has(row.key) ? ' lc-team-task-open' : '')
      + (ownerId !== undefined && ownerId === props.hoverId ? ' lc-team-task-hover' : '')
      + (ownerId !== undefined && ownerId === props.pinnedId ? ' lc-team-task-related' : '')
  }

  const hoverOwner = (row: WorkRow | null): void => {
    if (row === null) {
      props.onHoverMember(null)
      return
    }
    props.onHoverMember(ownerSessionId(row) ?? null)
  }

  const rowClick = (row: WorkRow) => (ev: MouseEvent) => {
    const target = ev.target as HTMLElement
    if (target.closest('button') !== null || target.closest('a') !== null) return
    toggleOpen(row)
  }

  const rowKeyDown = (row: WorkRow) => (ev: ReactKeyboardEvent) => {
    if (ev.target !== ev.currentTarget) return
    if (ev.key !== 'Enter' && ev.key !== ' ') return
    ev.preventDefault()
    toggleOpen(row)
  }

  const renderOpenSections = (row: WorkRow, hue: string, desc: string | undefined): ReactElement => {
    const ownerId = ownerSessionId(row)
    const detail = ownerId !== undefined ? props.detailOf(ownerId)?.detail : undefined
    const reply = detail?.lastReply
    const full = ownerId !== undefined ? props.fullOf(ownerId) : undefined
    const landed = full?.pending === true ? undefined : full?.detail ?? undefined
    const shown = landed?.lastReply ?? reply
    const stillExcerpt = landed?.lastReply === undefined && shown !== undefined
    const replyMeta = full?.pending === true ? (
      <span className="lc-ts-card-meta">{t('fleet.tasks.replyFull')}</span>
    ) : stillExcerpt && detail?.truncated === true ? (
      <span className="lc-ts-card-meta">{t('fleet.tasks.replyExcerpt')}</span>
    ) : shown !== undefined ? (
      <span className="lc-ts-card-meta">{fmtTime(shown.time)}</span>
    ) : undefined
    return (
      <>
        {desc !== undefined && desc !== '' ? (
          <TaskTextSection label={t('fleet.tasks.desc')} text={desc} rich={rich} />
        ) : null}
        {renderAgentBox(row, hue)}
        {shown !== undefined ? (
          <TaskTextSection label={t('fleet.tasks.reply')} text={shown.text} rich={rich} meta={replyMeta} />
        ) : null}
      </>
    )
  }

  const renderAgentBox = (row: WorkRow, hue: string): ReactElement | null => {
    const id = ownerSessionId(row)
    if (id === undefined) return null
    const node = forest?.nodes.find(n => n.id === id)
    const owner = team?.members.find(member => member.id === id)
    return (
      <Section label={t('fleet.tasks.agent')}>
        <div className="lc-team-task-box-agent">
          <AgentAvatar
            agent={{
              id,
              name: avatarNameOf(owner?.name ?? row.subject, owner?.role ?? 'subagent', t),
              role: owner?.role ?? 'subagent',
              self: false,
              hue,
              initials: avatarLabels.get(id),
            }}
            size="md"
            t={t}
          />
          <button
            type="button"
            className="lc-team-task-owner"
            title={t('fleet.tasks.ownerTip')}
            onClick={() => { props.onPinMember(id) }}
          >
            {row.ownerLabel}
          </button>
          {node?.model !== undefined ? <span className="lc-member-model">{node.model}</span> : null}
          {node !== undefined ? (
            <span className="lc-agents-badge">
              {node.running ? t('agents.running') : node.completed ? t('fleet.filter.done') : t('fleet.memberInactive')}
            </span>
          ) : null}
        </div>
      </Section>
    )
  }

  const renderAgentRow = (row: WorkRow, hue: string): ReactElement => {
    const node = row.node as AgentNode
    const bits = runMetaOf(node, t)
    const prompt = props.detailOf(node.id)?.detail?.initialPrompt
    const fullBrief = props.fullOf(node.id)
    const brief = !fullBrief.pending ? fullBrief.detail?.initialPrompt ?? prompt : prompt
    const open = openTasks.has(row.key)
    return (
      <li
        key={row.key}
        className={rowClass(row)}
        style={memberStyle(hue)}
        data-task={row.key}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={rowClick(row)}
        onKeyDown={rowKeyDown(row)}
        onMouseEnter={() => { hoverOwner(row) }}
        onMouseLeave={() => { hoverOwner(null) }}
      >
        <div className="lc-team-task-head">
          <AgentAvatar
            agent={{
              id: node.id,
              name: node.label,
              role: 'subagent',
              self: false,
              hue,
              initials: avatarLabels.get(node.id),
            }}
            size="md"
            t={t}
          />
          <StateDot state={row.dot} size={9} />
          <b className="lc-team-task-subject lc-team-task-subject-clamp" title={`${row.subject} · ${node.id}`}>{row.subject}</b>
          <span className="lc-agents-badge">{t(`fleet.task.${row.status}`)}</span>
          <span className="lc-team-task-chevron"><IconChevronDown size={11} /></span>
        </div>
        {open ? (
          renderOpenSections(row, hue, brief)
        ) : prompt !== undefined && prompt !== '' ? (
          <div className="lc-team-task-desc">
            <MarkdownBody rich={rich} text={prompt} />
          </div>
        ) : null}
        {bits.length > 0 ? (
          <div className="lc-team-task-run">
            <span className="lc-team-task-run-text" title={bits.join(' · ')}>{bits.join(' · ')}</span>
          </div>
        ) : null}
      </li>
    )
  }

  const renderTeamRow = (row: WorkRow, hue: string): ReactElement => {
    const task = row.teamTask as FleetTeamTask
    const open = openTasks.has(task.id)
    return (
      <li
        key={row.key}
        className={rowClass(row)}
        style={hue !== '' ? memberStyle(hue) : undefined}
        data-task={task.id}
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={rowClick(row)}
        onKeyDown={rowKeyDown(row)}
        onMouseEnter={() => { hoverOwner(row) }}
        onMouseLeave={() => { hoverOwner(null) }}
      >
        <div className="lc-team-task-head">
          <StateDot state={row.dot} size={9} />
          <b className="lc-team-task-subject">{task.subject}</b>
          {task.status === 'pending'
            ? (
              <span className={'lc-agents-badge' + (task.ready ? ' lc-agents-badge-on' : '')}>
                {t(task.ready ? 'fleet.taskReady' : 'fleet.taskBlocked')}
              </span>
            )
            : null}
          {task.ownerName !== undefined ? (
            <button
              type="button"
              className="lc-team-task-owner"
              title={t('fleet.tasks.ownerTip')}
              onClick={() => { pickOwner(row) }}
            >
              {task.ownerName}
            </button>
          ) : <span className="lc-agents-badge">{t('fleet.taskUnowned')}</span>}
          <span className="lc-team-task-chevron"><IconChevronDown size={11} /></span>
        </div>
        {open ? (
          renderOpenSections(row, hue, task.description === '' ? undefined : task.description)
        ) : task.description !== '' ? (
          <div className="lc-team-task-desc">
            <MarkdownBody rich={rich} text={task.description} />
          </div>
        ) : null}
        {task.blockedBy.length > 0 ? (
          <div className="lc-team-task-deps">
            {t('fleet.tasks.dependsOn')}
            {task.blockedBy.map((dep) => {
              const blocker = byId.get(dep)
              return (
                <button
                  key={dep}
                  type="button"
                  className="lc-team-task-dep"
                  title={t('fleet.tasks.depTip', { id: dep })}
                  onClick={() => { flashTask(dep) }}
                >
                  {blocker !== undefined ? <StateDot state={rowOfTask(blocker).dot} size={7} /> : null}
                  {dep}
                </button>
              )
            })}
          </div>
        ) : null}
        <div className="lc-team-task-meta">
          <span className="lc-team-task-id">{task.id}</span>
          {task.writeScopes.length > 0 ? (
            <span className="lc-team-task-scopes">{t('fleet.taskScopes')} {task.writeScopes.join(', ')}</span>
          ) : null}
        </div>
        {task.warnings.length > 0 ? (
          <div className="lc-team-task-warning">{task.warnings.join(' · ')}</div>
        ) : null}
      </li>
    )
  }

  const renderGroup = (group: OwnerGroup): ReactElement => {
    const avatarRole = group.role === 'lead' ? 'lead' : 'teammate'
    return (
      <div key={group.key} className="lc-tasks-group lc-tasks-group-owner">
        {group.role !== 'agent' ? (
          <div className="lc-tasks-group-head">
            {group.label !== null ? (
              <>
                {group.role !== 'stray' && group.nodeId !== undefined ? (
                  <AgentAvatar
                    agent={{
                      id: group.nodeId,
                      name: avatarNameOf(group.label, avatarRole, t),
                      role: avatarRole,
                      self: false,
                      hue: group.hue,
                      initials: avatarLabels.get(group.nodeId),
                    }}
                    size="md"
                    t={t}
                  />
                ) : null}
                <button
                  type="button"
                  className="lc-team-task-owner"
                  title={t('fleet.tasks.ownerTip')}
                  onClick={() => {
                    if (group.nodeId !== undefined) props.onPinMember(group.nodeId)
                  }}
                >
                  {group.label}
                </button>
              </>
            ) : (
              <span className="lc-agents-badge">{t('fleet.taskUnowned')}</span>
            )}
            <span className="lc-kind-n">{group.rows.length}</span>
          </div>
        ) : null}
        <ul className="lc-tasks-rows">
          {group.rows.map(row => (row.kind === 'team' ? renderTeamRow(row, group.hue) : renderAgentRow(row, group.hue)))}
        </ul>
      </div>
    )
  }

  const bare = query === '' && status === 'all'
  const showToolbar = rows.length > 1 || !bare

  return (
    <div className="lc-card lc-tasks flex-1 min-w-[min(360px,100%)]" ref={boardRef}>
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          <IconChecklistOutlineRegular size={14} />
          {t('fleet.tasks.title')}
        </span>
        <span className="lc-card-sub">{t('fleet.tasks.sub')}</span>
        {filterLabel !== null ? (
          <button type="button" className="lc-agents-badge lc-tasks-filter" title={filterLabel} onClick={() => { props.onOwnerFilter(null) }}>
            {filterLabel} ×
          </button>
        ) : null}
      </div>

      {showToolbar ? (
        <div className="lc-fleet-toolbar">
          <ClearableInput
            type="search"
            className="lc-fleet-search"
            placeholder={t('fleet.tasks.search')}
            clearLabel={t('field.clear')}
            value={query}
            onChange={setQuery}
          />
          <div className="lc-fleet-filters" role="group" aria-label={t('fleet.tasks.filter')}>
            {(['all', 'in_progress', 'pending', 'completed'] as const).map(key => (
              <button
                key={key}
                type="button"
                className={'lc-gran-btn' + (status === key ? ' lc-gran-on' : '')}
                onClick={() => { setStatus(key) }}
              >
                {key === 'all' ? t('fleet.filter.all') : t(`fleet.taskCol.${key}`)}
                <span className="lc-kind-n">{fmt(counts[key])}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="lc-tasks-body">
        {groups.map(renderGroup)}

        {rows.length === 0 ? (
          <div className="lc-empty">{team === null ? t('fleet.tasks.noTeam') : t('fleet.team.empty')}</div>
        ) : visibleCount === 0 ? (
          <div className="lc-empty">{t('fleet.tasks.noMatch')}</div>
        ) : null}
      </div>
    </div>
  )
}
