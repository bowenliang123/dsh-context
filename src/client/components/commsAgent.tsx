import type { CSSProperties, ReactElement } from 'react'
import { avatarLabelOf, initialsOf, type CommsAgent, type CommsRole } from '../commsModel'
import type { ViewKit } from '../viewkit'

export function roleKeyOf(role: CommsRole): string {
  if (role === 'lead') return 'fleet.role.lead'
  if (role === 'teammate') return 'fleet.role.teammate'
  if (role === 'subagent') return 'fleet.role.subagent'
  if (role === 'agent') return 'fleet.role.agent'
  return 'fleet.role.other'
}

export function roleLabelOf(agent: CommsAgent, t: ViewKit['t']): string {
  return t(roleKeyOf(agent.role))
}

export function roleTextOf(agent: CommsAgent, t: ViewKit['t']): string {
  const label = roleLabelOf(agent, t)
  return label === agent.name ? '' : label
}

export function channelStyle(a: string, b: string): CSSProperties {
  return { '--lc-ch-a': a, '--lc-ch-b': b } as CSSProperties
}

export function AgentAvatar(props: {
  agent: CommsAgent
  size?: 'sm' | 'md' | 'lg'
  t: ViewKit['t']
}): ReactElement {
  const size = props.size ?? 'sm'
  const label = avatarLabelOf(props.agent.initials ?? initialsOf(props.agent.name))
  const modifier = label.lines.length > 1 ? ' lc-comms-avatar-stack' : label.condensed ? ' lc-comms-avatar-condensed' : ''
  return (
    <span
      className={`lc-comms-avatar lc-comms-avatar-${size}${props.agent.self ? ' lc-comms-avatar-self' : ''}${modifier}`}
      style={{ '--lc-comms-hue': props.agent.hue } as CSSProperties}
      title={`${props.agent.name} · ${roleLabelOf(props.agent, props.t)}`}
      aria-hidden="true"
    >
      {label.lines.map((line, index) => (
        <span key={index} className={'lc-comms-avatar-text' + (index > 0 ? ' lc-comms-avatar-num' : '')}>{line}</span>
      ))}
    </span>
  )
}
