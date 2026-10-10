/**
 * The Fleet members board — the team's roster as full cards, one per member: an identity block
 * (icon keyed to the member's family hue, name, role/phase badges), the spawn-time duty
 * description off the lead's durable roster records, the model it runs, its latest reply, and its
 * live task count. A card click pins the member into the network inspector; the task chip filters
 * the task board to that owner; the open button jumps to the member's session.
 */

import type { CSSProperties, ReactElement } from 'react'
import { IconUserOutlineRegular, IconUsersOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentForest } from '../agentTree'
import { familyHue } from '../agentTree'
import { tasksOfOwner, type FleetTeam } from '../fleetTeam'
import type { FleetDetail, FleetMemberInfo } from '../../shared/types'
import type { ViewKit } from '../viewkit'

export interface MemberBoardProps {
  team: FleetTeam
  forest: AgentForest
  /** The lead session's landed fleet detail — the roster facts (duty descriptions) live there. */
  leadDetail: FleetDetail | null
  /** Landed details keyed by session id (latest replies ride them). */
  detailOf: (id: string) => { detail: FleetDetail | null } | undefined
  pinnedId: string | null
  onPin: (id: string | null) => void
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  /** The task board's owner filter, owned by the view so the boards interlock. */
  ownerFilter: string | null
  onOwnerFilter: (name: string | null) => void
  t: ViewKit['t']
}

/** One member's card hue: the lead carries the brand color, teammates their golden-angled roster
 * hue (the graph's family-hue idiom). */
function memberStyle(index: number, lead: boolean): CSSProperties {
  return {
    '--lc-member-hue': lead ? 'var(--dsw-alias-brand-primary, var(--color-blue-500))' : familyHue(index),
  } as CSSProperties
}

export function MemberBoard(props: MemberBoardProps): ReactElement {
  const { team, forest, t } = props
  const nodeById = new Map(forest.nodes.map(n => [n.id, n]))
  const roster = new Map<string, FleetMemberInfo>()
  for (const info of props.leadDetail?.roster ?? []) roster.set(info.name, info)

  return (
    <div className="lc-card lc-members">      <div className="lc-card-title">
      <span className="lc-card-title-text">
        <IconUsersOutlineRegular size={14} />
        {t('fleet.members.title')}
      </span>
      <span className="lc-agents-chip">{t('fleet.members.count', { n: team.members.length })}</span>
      {team.failure !== undefined ? (
        <span className="lc-agents-badge lc-agents-badge-err" title={team.failure}>{t('fleet.team.failureShort')}</span>
      ) : null}
    </div>

    <div className="lc-members-grid">
      {team.members.map((member, index) => {
        const node = nodeById.get(member.id)
        const running = node?.running === true
        const info = roster.get(member.name)
        const detail = props.detailOf(member.id)?.detail ?? null
        const model = node?.model ?? detail?.descriptor?.agentModel
        const owned = tasksOfOwner(team, member.name)
        const activeTasks = owned.filter(task => task.status !== 'completed')
        const isCurrent = node?.isCurrent === true
        return (
          <div
            key={member.id}
            className={
              'lc-member-card'
                + (props.pinnedId === member.id ? ' lc-member-pinned' : '')
                + (member.phase === 'failed' ? ' lc-member-failed' : '')
            }
            style={memberStyle(index, member.role === 'lead')}
            role="button"
            tabIndex={0}
            onClick={() => { props.onPin(props.pinnedId === member.id ? null : member.id) }}
            onKeyDown={(ev) => {
              if (ev.key !== 'Enter' && ev.key !== ' ') return
              ev.preventDefault()
              props.onPin(props.pinnedId === member.id ? null : member.id)
            }}
            onMouseEnter={() => { props.onHover(member.id) }}
            onMouseLeave={() => { props.onHover(null) }}
          >
            <div className="lc-member-head">
              <span className="lc-member-icon">
                {member.role === 'lead' ? <IconUsersOutlineRegular size={15} /> : <IconUserOutlineRegular size={15} />}
              </span>
              <b className="lc-member-name">{member.name}</b>
              {isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
              <span className="lc-agents-badge">{t(member.role === 'lead' ? 'fleet.role.lead' : 'fleet.role.teammate')}</span>
              <StateDot
                state={member.phase === 'failed' ? 'error' : member.phase === 'provisioning' || running ? 'ongoing' : 'idle'}
                size={9}
                className="lc-member-dot"
              />
            </div>
            <div className="lc-member-status">
              {member.phase === 'failed'
                ? t('fleet.phase.failed')
                : member.phase === 'provisioning'
                  ? t('fleet.phase.provisioning')
                  : running ? t('agents.running') : t('fleet.memberInactive')}
              {model !== undefined ? <span className="lc-member-model">{model}</span> : null}
            </div>
            {member.error !== undefined ? <div className="lc-inspector-error">{member.error}</div> : null}
            {info !== undefined && info.description !== '' ? (
              <div className="lc-member-desc" title={info.description}>{info.description}</div>
            ) : null}
            {detail?.lastReply !== undefined ? (
              <div className="lc-member-reply" title={detail.lastReply.text}>
                {t('fleet.members.reply')} {detail.lastReply.text}
              </div>
            ) : null}
            <div className="lc-member-foot">
              {activeTasks.length > 0 ? (
                <button
                  type="button"
                  className={'lc-member-tasks' + (props.ownerFilter === member.name ? ' lc-member-tasks-on' : '')}
                  title={t('fleet.members.tasksTip')}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    props.onOwnerFilter(props.ownerFilter === member.name ? null : member.name)
                  }}
                >
                  {t('fleet.members.tasks', { n: activeTasks.length })}
                </button>
              ) : <span className="lc-member-tasks-none">{t('fleet.members.noTasks')}</span>}
              {!isCurrent && node !== undefined ? (
                <button
                  type="button"
                  className="lc-inspector-btn lc-member-open"
                  title={t('fleet.open')}
                  onClick={(ev) => {
                    ev.stopPropagation()
                    props.onOpen(member.id)
                  }}
                >
                  →
                </button>
              ) : null}
            </div>
          </div>
        )
      })}
    </div>
    </div>
  )
}
