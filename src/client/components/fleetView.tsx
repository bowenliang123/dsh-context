/**
 * The Fleet tab — the standalone home of the agent family (agentGraph.tsx), split out of the Context tab.
 * It reads the session through the same `useContextSession` path the Context tab does and folds the current
 * agent's figures with the same `agentSelfOf`, so the card cannot disagree with its sidebar mount. The right
 * Sidebar keeps that card inline, in its Context panel; this view is the only purely agent-scoped mount.
 */

import { createElement as h, type ReactElement } from 'react'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import type { ClientCtx, SessionStandardProps } from '../services'
import { unsupportedOf } from '../services'
import { useContextSession } from '../sessionData'
import type { ViewKit } from '../viewkit'
import { makeAgentGraph } from './agentGraph'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { makeUpgradeGate } from './upgradeGate'

export function makeFleetView(
  ctx: ClientCtx,
  kit: ViewKit,
  heads: AgentHeads,
): (props: SessionStandardProps) => ReactElement {
  const { t } = kit
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  function FleetBody(props: SessionStandardProps): ReactElement {
    const sessionId = props.sessionId
    const { source, data, pressure, breakdown, usage } = useContextSession(props)

    if (data === null) {
      return (
        <div className="lc-root">
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    // The baseline gate must not hide behind whichever tab the reader opened: the dismissal ledger is keyed by
    // session, so one dismissal holds across the Context tab and this one.
    const gate = unsupportedOf(data.unsupported)
    return (
      <div className="lc-root">
        <AgentGraph
          sessionId={typeof sessionId === 'string' ? sessionId : undefined}
          self={agentSelfOf(data, pressure, breakdown, usage)}
        />
        <div className="lc-foot">{t('footer')}</div>
        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  return function FleetView(props: SessionStandardProps): ReactElement {
    return h(ErrorBoundary, null, h(FleetBody, props))
  }
}
