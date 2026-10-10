/**
 * The Fleet inspector — the network card's right column, following the cursor (hover), the pin
 * (list/team/comms picks), or falling back to the current session. It stacks everything the tab
 * knows about one agent: identity badges, live figures, composition, team membership and owned
 * tasks, the descriptor composition and delegation prompt off the fleet-detail route, and the
 * inter-agent messages the landed details attest.
 */

import { useEffect, useRef, useState, type ReactElement } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { AgentNode } from '../agentTree'
import { fmtDurationCompact } from '../agentTree'
import { type CommsRow } from '../fleetDetail'
import { CommsParties, commsTextOf } from './commsRow'
import { tasksOfOwner, teamMemberOf, type FleetTeam } from '../fleetTeam'
import { fmtTime } from '../format'
import type { FleetDetail, FleetMemberInfo } from '../../shared/types'
import type { ViewKit } from '../viewkit'

export interface AgentInspectorProps {
  node: AgentNode
  /** The pin (list/member/comms pick) this inspector is stuck to; null = hover-follow/current. */
  pinned: boolean
  team: FleetTeam | null
  /** The node's fleet-detail read: undefined while in flight, null detail = the route served nothing. */
  detail: { detail: FleetDetail | null } | undefined
  /** The lead's roster facts (duty descriptions ride these, not the projection). */
  roster: readonly FleetMemberInfo[]
  /** Merged comms rows involving this node (sender or recipient). */
  comms: CommsRow[]
  /** Display label of any session id (forest label, else the roster name, else the raw id). */
  labelOf: (id: string) => string
  onOpen: (id: string) => void
  onPin: (id: string | null) => void
  /** An owned-task chip flashes the task on the task board. */
  onFocusTask: (id: string | null) => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
  catLabel: ViewKit['catLabel']
}

export function AgentInspector(props: AgentInspectorProps): ReactElement {
  const { node, team, t, fmt, catLabel } = props
  const [promptOpen, setPromptOpen] = useState(false)
  const promptRef = useRef<HTMLDivElement | null>(null)
  const [promptClamped, setPromptClamped] = useState(false)
  const prompt = props.detail?.detail?.initialPrompt
  // The expand toggle only earns its place when the clamp actually cut the prompt.
  useEffect(() => {
    setPromptOpen(false)
    const el = promptRef.current
    setPromptClamped(el !== null && el.scrollHeight > el.clientHeight + 1)
  }, [prompt])
  const member = teamMemberOf(team, node.id)
  const owned = member !== null ? tasksOfOwner(team, member.name) : []
  const detail = props.detail?.detail ?? null
  // The member's duty description rides the lead's roster facts, not the projection.
  const memberInfo = member !== null ? props.roster.find(r => r.name === member.name) : undefined

  const bits: string[] = []
  if (node.head !== null) {
    const head = node.head
    const window = head.window !== undefined ? ` / ${fmt(head.window)}` : ''
    const pct = head.pct !== null ? ` · ${head.pct}%` : ''
    bits.push(`${fmt(head.tokens)}${window}${pct}`)
  }
  if (node.requests > 0) bits.push(t('agents.steps', { n: node.requests }))
  if (node.billed !== null && node.billed > 0) bits.push(t('agents.billed', { n: fmt(node.billed) }))
  if (node.durationMs !== null) bits.push(fmtDurationCompact(node.durationMs))
  const parts = node.head !== null ? node.head.parts.filter(p => (p.raw ?? p.value) > 0) : []
  let rawTotal = 0
  for (const p of parts) rawTotal += p.raw ?? p.value

  const descriptor = detail?.descriptor
  const descriptorBits: string[] = []
  if (node.model !== undefined) descriptorBits.push(node.model)
  if (descriptor !== undefined) {
    if (descriptor.provider !== undefined) descriptorBits.push(descriptor.provider)
    if (descriptor.agentModel !== undefined && descriptor.agentModel !== node.model) descriptorBits.push(descriptor.agentModel)
    if (descriptor.persona !== undefined) descriptorBits.push(descriptor.persona)
  }

  return (
    <div className="lc-agents-inspector lc-inspector" data-pinned={props.pinned || undefined}>
      <div className="lc-inspector-head">
        {node.running || node.completed
          ? <StateDot state={node.running ? 'ongoing' : 'done'} size={11} className="lc-agent-state" />
          : null}
        <b className="lc-agents-inspector-name">{node.label}</b>
        {node.isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
        {node.running ? <span className="lc-agents-badge lc-agents-badge-on">{t('agents.running')}</span> : null}
        {node.identity !== null
          ? <span className="lc-agents-badge">{t(node.identity.mode === 'one-shot' ? 'agents.oneshot' : 'agents.continuable')}</span>
          : null}
        <span className="lc-inspector-actions">
          {props.pinned
            ? (
              <button type="button" className="lc-inspector-btn" onClick={() => { props.onPin(null) }}>
                {t('fleet.unpin')}
              </button>
            )
            : null}
          {!node.isCurrent
            ? (
              <button type="button" className="lc-inspector-btn lc-inspector-open" onClick={() => { props.onOpen(node.id) }}>
                {t('fleet.open')}
              </button>
            )
            : null}
        </span>
      </div>

      <div className="lc-agents-inspector-stats">{bits.length > 0 ? bits.join(' · ') : '—'}</div>

      {parts.length > 0 ? (
        <div className="lc-agents-inspector-parts">
          {parts.map((p) => {
            const count = p.raw ?? p.value
            return (
              <span key={p.key} className="lc-agents-part">
                <i style={{ background: p.color }} />
                {catLabel(p.key)}
                <em>{`≈${fmt(count)} (${Math.round(count / rawTotal * 100)}%)`}</em>
              </span>
            )
          })}
        </div>
      ) : null}

      {member !== null ? (
        <div className="lc-inspector-section">
          <div className="lc-inspector-caption">{t('fleet.membership')}</div>
          <div className="lc-inspector-member">
            <span className="lc-agents-badge lc-inspector-member-name">{member.name}</span>
            <span className="lc-agents-badge">{t(member.role === 'lead' ? 'fleet.role.lead' : 'fleet.role.teammate')}</span>
            {member.phase !== 'active'
              ? (
                <span className={'lc-agents-badge' + (member.phase === 'failed' ? ' lc-agents-badge-err' : '')}>
                  {t(member.phase === 'failed' ? 'fleet.phase.failed' : 'fleet.phase.provisioning')}
                </span>
              )
              : null}
            {member.error !== undefined ? <span className="lc-inspector-error">{member.error}</span> : null}
          </div>
          {memberInfo !== undefined && memberInfo.description !== '' ? (
            <div className="lc-inspector-member-desc">{memberInfo.description}</div>
          ) : null}
          {owned.length > 0 ? (
            <ul className="lc-inspector-tasks">
              {owned.map(task => (
                <li key={task.id} className="lc-inspector-task">
                  <StateDot
                    state={task.status === 'completed' ? 'done' : task.status === 'in_progress' ? 'ongoing' : task.ready ? 'idle' : 'warning'}
                    size={8}
                  />
                  <button
                    type="button"
                    className="lc-inspector-task-subject lc-inspector-task-link"
                    title={t('fleet.tasks.focusTip')}
                    onClick={() => { props.onFocusTask(task.id) }}
                  >
                    {task.subject}
                  </button>
                  <span className="lc-agents-badge">{t(`fleet.task.${task.status}`)}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {detail?.lastReply !== undefined ? (
        <div className="lc-inspector-section">
          <div className="lc-inspector-caption">
            {t('fleet.members.reply')}
            <span className="lc-inspector-reply-time">{fmtTime(detail.lastReply.time)}</span>
          </div>
          <div className="lc-inspector-reply">{detail.lastReply.text}</div>
        </div>
      ) : null}

      {descriptorBits.length > 0 ? (
        <div className="lc-inspector-section">
          <div className="lc-inspector-caption">{t('fleet.config')}</div>
          <div className="lc-inspector-config">{descriptorBits.join(' · ')}</div>
        </div>
      ) : null}

      {prompt !== undefined ? (
        <div className="lc-inspector-section">
          <div className="lc-inspector-caption">{t('fleet.prompt')}</div>
          <div ref={promptRef} className={'lc-inspector-prompt' + (promptOpen ? ' lc-inspector-prompt-open' : '')}>
            {prompt}
          </div>
          {promptClamped || promptOpen ? (
            <button type="button" className="lc-inspector-btn" onClick={() => { setPromptOpen(!promptOpen) }}>
              {t(promptOpen ? 'fleet.collapse' : 'fleet.expand')}
            </button>
          ) : null}
        </div>
      ) : null}

      {props.detail === undefined ? <div className="lc-inspector-loading">{t('fleet.detailLoading')}</div> : null}

      {props.comms.length > 0 ? (
        <div className="lc-inspector-section">
          <div className="lc-inspector-caption">{t('fleet.messages')}</div>
          <ul className="lc-inspector-comms">
            {props.comms.slice(0, 6).map((row) => {
              const text = commsTextOf(row, t)
              return (
                <li key={row.key} className="lc-inspector-comm">
                  <span className="lc-agents-badge">{t(`fleet.kind.${row.kind}`)}</span>
                  <CommsParties
                    row={row}
                    selfId={node.id}
                    labelOf={props.labelOf}
                    onPin={props.onPin}
                    peerClass="lc-inspector-comm-peer"
                  />
                  <span className="lc-inspector-comm-text" title={row.text}>{text}</span>
                </li>
              )
            })}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
