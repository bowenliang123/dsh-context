import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, type ReactElement } from 'react'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import { displayCurrencyOf } from '../cost'
import { mergeComms, mergeDelegations } from '../fleetDetail'
import { attestedNamesOf, commsAgentsOf } from '../fleetAgents'
import { useFleetDetails, useFleetModel } from '../fleetModel'
import { teamOf } from '../fleetTeam'
import type { ClientCtx, SessionStandardProps } from '../services'
import { CONTEXT_VIEW_ID, openChildAsideVia, openSessionVia, projectionOf, seedConversationViewVia, unsupportedOf } from '../services'
import { useFleetMemberFocus } from '../viewFocus'
import { useContextSession } from '../sessionData'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import { makeAgentGraph } from './agentGraph'
import { makeDetailNote } from './detailNote'
import { makeRichText } from './richText'
import { makeErrorBoundary } from './errorBoundary'
import { MissionPulse } from './missionPulse'
import { makeUpgradeGate } from './upgradeGate'
import { useConversationSurface } from './useConversationSurface'

export function makeFleetView(
  ctx: ClientCtx,
  kit: ViewKit,
  heads: AgentHeads,
): (props: SessionStandardProps) => ReactElement {
  const { t } = kit
  const UpgradeGate = makeUpgradeGate(kit)
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)
  const rich = makeRichText(kit)

  function FleetBody(props: SessionStandardProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    const rootRef = useRef<HTMLDivElement | null>(null)
    useConversationSurface(rootRef)
    useLayoutEffect(() => {
      /* v8 ignore next 3 */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller !== null) scroller.scrollTop = 0
    }, [sessionId])
    const self = data !== null ? agentSelfOf(data, pressure, breakdown, usage) : undefined
    const { forest, team: rowTeam, titles } = useFleetModel(ctx, heads, sessionId, self, data !== null, 120)
    const teamDirect = projectionOf(props, 'agentTeam', teamOf)
    const team = teamDirect ?? rowTeam
    const details = useFleetDetails(undefined, { concurrency: 4, refreshDelayMs: 750, scopeKey: sessionId })
    const focusMember = useFleetMemberFocus(sessionId)
    const byId = useMemo(
      () => new Map((forest?.nodes ?? []).map(node => [node.id, node])),
      [forest],
    )
    const leadId = team?.members.find(member => member.role === 'lead')?.id ?? team?.members[0]?.id
    const detailNodes = useMemo(
      () => forest?.nodes ?? (team?.members ?? []).map(member => ({ id: member.id, updatedAt: 0 })),
      [forest, team],
    )
    const detailStamp = detailNodes.map(node => `${node.id}@${node.updatedAt}`).join(',')
    useEffect(() => {
      for (const node of detailNodes) details.request(node.id, node.updatedAt)
    }, [detailNodes, detailStamp])
    const landedDetails = useMemo(() => {
      const map = new Map<string, FleetDetail>()
      for (const node of detailNodes) {
        const history = details.historyLanded.get(node.id)?.detail
        if (history !== undefined && history !== null) {
          map.set(node.id, history)
          continue
        }
        const preview = details.landed.get(node.id)?.detail
        if (preview !== undefined && preview !== null) map.set(node.id, preview)
      }
      return map
    }, [detailNodes, details.landed, details.historyLanded])
    const comms = useMemo(() => mergeComms(landedDetails), [landedDetails])
    const delegations = useMemo(() => mergeDelegations(landedDetails), [landedDetails])
    const attestedNames = useMemo(() => attestedNamesOf(comms), [comms])
    const leadDetail = leadId !== undefined ? landedDetails.get(leadId) ?? null : null
    const agents = useMemo(
      () => commsAgentsOf(forest?.nodes ?? [], team, leadDetail?.roster, attestedNames, t),
      [attestedNames, forest, leadDetail, team, t],
    )
    const open = (id: string): void => {
      const node = byId.get(id)
      /* v8 ignore next 5 */
      if (openChildAsideVia(ctx, {
        childSessionId: id,
        parentSessionId: node?.parentId,
        mode: node?.identity?.mode,
      })) return
      openSessionVia(ctx, id)
    }
    const enter = (id: string): void => {
      seedConversationViewVia(id, CONTEXT_VIEW_ID)
      openSessionVia(ctx, id)
    }
    if (data === null) {
      return (
        <div className="lc-root" ref={rootRef}>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }
    const gate = unsupportedOf(data.unsupported)
    return (
      <div className="lc-root" ref={rootRef}>
        <MissionPulse
          key={sessionId ?? ''}
          sessionId={sessionId}
          graph={AgentGraph}
          forest={forest}
          team={team}
          details={details}
          landedDetails={landedDetails}
          comms={comms}
          delegations={delegations}
          agents={agents}
          titles={titles}
          attested={attestedNames}
          focusMember={focusMember}
          currency={displayCurrencyOf(ctx.locale)}
          onOpen={open}
          onEnter={enter}
          rich={rich}
          t={t}
        />
        {gate !== null ? <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} /> : null}
      </div>
    )
  }

  return function FleetView(props: SessionStandardProps): ReactElement {
    return h(ErrorBoundary, null, h(FleetBody, props))
  }
}
