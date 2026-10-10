/**
 * The Fleet task board — the team's shared task DAG as one grouped list: in-flight work first,
 * then the pending pool (ready ahead of blocked), then done. Dependencies read inline: every
 * blocker chip carries the blocker's own status dot, so "who waits on whom, and is it done yet"
 * never needs a second look; a chip click flashes the blocker's row. The owner chip pins the
 * member into the network inspector, and the owner filter interlocks with the members board's
 * task counts.
 */

import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { IconChecklistOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { memberIdByName, type FleetTeam, type FleetTeamTask } from '../fleetTeam'
import type { ViewKit } from '../viewkit'

export interface TaskBoardProps {
  team: FleetTeam
  /** The members board's owner filter (null = every owner). */
  ownerFilter: string | null
  onOwnerFilter: (name: string | null) => void
  /** The flashed task (blocker picks and inspector task chips land here). */
  focusTaskId: string | null
  onFocusTask: (id: string | null) => void
  onPinMember: (id: string | null) => void
  t: ViewKit['t']
}

type GroupKey = 'in_progress' | 'pending' | 'completed'

const GROUPS: readonly GroupKey[] = ['in_progress', 'pending', 'completed']

function taskDot(task: FleetTeamTask): 'done' | 'ongoing' | 'idle' | 'warning' {
  if (task.status === 'completed') return 'done'
  if (task.status === 'in_progress') return 'ongoing'
  return task.ready ? 'idle' : 'warning'
}

export function TaskBoard(props: TaskBoardProps): ReactElement {
  const { team, t } = props
  /** Task ids with their description unfolded. */
  const [openTasks, setOpenTasks] = useState<ReadonlySet<string>>(new Set())
  const byId = useMemo(() => new Map(team.tasks.map(task => [task.id, task])), [team])
  const boardRef = useRef<HTMLDivElement | null>(null)

  // A blocker pick (or an inspector task chip) flashes the row and scrolls it into view.
  const focused = props.focusTaskId
  useEffect(() => {
    if (focused === null) return
    /* v8 ignore next 2 -- jsdom has no layout; the browser path is the visual one. */
    const row = boardRef.current?.querySelector(`[data-task="${focused}"]`)
    if (typeof row?.scrollIntoView === 'function') row.scrollIntoView({ block: 'nearest' })
  }, [focused])

  const visible = props.ownerFilter === null
    ? team.tasks
    : team.tasks.filter(task => task.ownerName === props.ownerFilter)
  const grouped = GROUPS.map(key => ({
    key,
    // The pending pool reads ready-first: what can start now outranks what waits.
    tasks: key === 'pending'
      ? visible.filter(task => task.status === 'pending').sort((a, b) => Number(b.ready) - Number(a.ready))
      : visible.filter(task => task.status === key),
  }))

  const toggleOpen = (id: string): void => {
    setOpenTasks((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const flashTask = (id: string): void => {
    // Toggle semantics: a second click on the same blocker releases the focus ring.
    props.onFocusTask(props.focusTaskId === id ? null : id)
  }

  return (
    <div className="lc-card lc-tasks" ref={boardRef}>
      <div className="lc-card-title">
        <span className="lc-card-title-text">
          <IconChecklistOutlineRegular size={14} />
          {t('fleet.tasks.title')}
        </span>
        <span className="lc-card-sub">{t('fleet.tasks.sub')}</span>
        {props.ownerFilter !== null ? (
          <button type="button" className="lc-agents-badge lc-tasks-filter" onClick={() => { props.onOwnerFilter(null) }}>
            {props.ownerFilter} ×
          </button>
        ) : null}
      </div>

      {team.tasks.length === 0 ? (
        <div className="lc-empty">{t('fleet.team.empty')}</div>
      ) : (
        grouped.map(({ key, tasks }) => {
          if (tasks.length === 0) return null
          return (
            <div key={key} className={`lc-tasks-group lc-tasks-group-${key}`}>
              <div className="lc-tasks-group-head">
                {t(`fleet.taskCol.${key}`)}
                <span className="lc-kind-n">{tasks.length}</span>
              </div>
              <ul className="lc-tasks-rows">
                {tasks.map(task => (
                  <li
                    key={task.id}
                    className={'lc-team-task' + (props.focusTaskId === task.id ? ' lc-team-task-focus' : '')}
                    data-task={task.id}
                  >
                    <div className="lc-team-task-head">
                      <StateDot state={taskDot(task)} size={9} />
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
                          onClick={() => {
                            const owner = memberIdByName(team, task.ownerName)
                            if (owner !== undefined) props.onPinMember(owner)
                          }}
                        >
                          {task.ownerName}
                        </button>
                      ) : <span className="lc-agents-badge">{t('fleet.taskUnowned')}</span>}
                    </div>
                    {task.description !== '' ? (
                      <div className={'lc-team-task-desc' + (openTasks.has(task.id) ? ' lc-team-task-desc-open' : '')}>
                        {task.description}
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
                              {blocker !== undefined ? <StateDot state={taskDot(blocker)} size={7} /> : null}
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
                      {task.description !== '' ? (
                        <button type="button" className="lc-inspector-btn" onClick={() => { toggleOpen(task.id) }}>
                          {t(openTasks.has(task.id) ? 'fleet.collapse' : 'fleet.expand')}
                        </button>
                      ) : null}
                    </div>
                    {task.warnings.length > 0 ? (
                      <div className="lc-team-task-warning">{task.warnings.join(' · ')}</div>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          )
        })
      )}
      {team.tasks.length > 0 && visible.length === 0 ? (
        <div className="lc-empty">{t('fleet.tasks.noMatch')}</div>
      ) : null}
    </div>
  )
}
