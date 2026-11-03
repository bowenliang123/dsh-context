import type { ReactElement } from 'react'
import type { CommsAgent } from '../commsModel'
import type { ViewKit } from '../viewkit'
import { AgentAvatar } from './commsAgent'

export function PulseSelectionPill(props: { agent: CommsAgent; onClear: () => void; t: ViewKit['t'] }): ReactElement {
  const { agent, t } = props
  return (
    <button
      type="button"
      className="lc-pulse-selection"
      aria-label={t('fleet.pulse.clearSelection', { name: agent.name })}
      title={t('fleet.pulse.clearSelection', { name: agent.name })}
      onClick={props.onClear}
    >
      <AgentAvatar agent={agent} size="sm" t={t} />
      <span className="lc-pulse-selection-label" title={agent.name}>
        <span className="lc-pulse-selection-prefix">{t('fleet.pulse.selectedPrefix')}</span>
        <span className="lc-pulse-selection-name">{agent.name}</span>
      </span>
      <b aria-hidden="true">×</b>
    </button>
  )
}
