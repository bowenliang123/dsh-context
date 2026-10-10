/**
 * The Fleet tab — the agent family's standalone home. Five panels over ONE shared derivation
 * (fleetModel.ts): the network card (graph + cursor-following inspector), the members board and
 * the task board (the harness's Agent Teams projection, when the family leads one), then the
 * roster list and the comms timeline as a two-up row. Hover, pin, owner filter, and task focus are
 * all lifted here, so a roster row, a member card, a task owner chip, a blocker chip, and a comms
 * party all steer the same inspector and each other.
 */

import { createElement as h, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import { mergeComms, type CommsRow } from '../fleetDetail'
import { useFleetDetails, useFleetModel } from '../fleetModel'
import { teamOf } from '../fleetTeam'
import type { ClientCtx, SessionStandardProps } from '../services'
import { openSessionVia, projectionOf, unsupportedOf } from '../services'
import { useContextSession } from '../sessionData'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import { makeAgentGraph } from './agentGraph'
import { CommsPanel } from './commsPanel'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { FleetList } from './fleetList'
import { MemberBoard } from './memberBoard'
import { TaskBoard } from './taskBoard'
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
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    const self = data !== null ? agentSelfOf(data, pressure, breakdown, usage) : undefined
    // The model arms only once the tab's own timeline landed: while the loading/failure screen
    // stands, no snapshot subscription and no fleet-detail read fire.
    const { forest, team: rowTeam } = useFleetModel(ctx, heads, sessionId, self, data !== null)
    // The freshest team value is the tab's OWN projection when the viewed session leads the team;
    // a teammate's view falls back to the lead row's list-block copy.
    const teamDirect = projectionOf(props, 'agentTeam', teamOf)
    const team = teamDirect ?? rowTeam
    const details = useFleetDetails()
    const [hoverId, setHoverId] = useState<string | null>(null)
    const [pinnedId, setPinnedId] = useState<string | null>(null)
    /** The task board's owner filter and focus flash, shared with the members board and inspector. */
    const [ownerFilter, setOwnerFilter] = useState<string | null>(null)
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null)

    const byId = useMemo(
      () => new Map((forest?.nodes ?? []).map(n => [n.id, n])),
      [forest],
    )
    const currentId = forest?.nodes.find(n => n.isCurrent)?.id

    // A pinned agent that left the family releases the pin instead of haunting the inspector.
    useEffect(() => {
      if (pinnedId !== null && !byId.has(pinnedId)) setPinnedId(null)
    }, [pinnedId, byId])

    const focusId = pinnedId ?? hoverId ?? currentId ?? null
    const focusNode = focusId !== null ? byId.get(focusId) : undefined

    // The inspector's fleet-detail read follows the focus (hover or pin), fresh-stamped by the
    // row's updatedAt: a focused agent that keeps working re-reads on each list-snapshot tick.
    const focusUpdatedAt = focusNode?.updatedAt
    useEffect(() => {
      if (focusId === null || focusUpdatedAt === undefined) return
      details.request(focusId, focusUpdatedAt)
    }, [focusId, focusUpdatedAt])

    // The lead's own detail feeds the members board's roster facts; the read dedupes with the
    // inspector's whenever the lead IS the focus. Every member's detail rides too, so the member
    // cards' model and latest reply fill in on first paint instead of after a hover.
    const leadId = team !== null ? team.members[0]?.id : undefined
    const memberStamp = team === null ? ''
      : team.members.map(m => `${m.id}@${byId.get(m.id)?.updatedAt ?? 0}`).join(',')
    useEffect(() => {
      if (team === null) return
      for (const m of team.members) {
        const node = byId.get(m.id)
        if (node !== undefined) details.request(m.id, node.updatedAt)
      }
    }, [team, memberStamp])

    const landedDetails = useMemo(() => {
      const map = new Map<string, FleetDetail>()
      for (const [id, entry] of details.landed) {
        if (entry.detail !== null) map.set(id, entry.detail)
      }
      return map
    }, [details.landed])
    const comms = useMemo(() => mergeComms(landedDetails), [landedDetails])
    const commsByAgent = useMemo(() => {
      const map = new Map<string, CommsRow[]>()
      for (const row of comms) {
        if (row.from !== undefined) {
          const list = map.get(row.from) ?? []
          list.push(row)
          map.set(row.from, list)
        }
        const list = map.get(row.to) ?? []
        if (row.from !== row.to) list.push(row)
        map.set(row.to, list)
      }
      return map
    }, [comms])

    const labelOf = (id: string): string => {
      const node = byId.get(id)
      if (node !== undefined) return node.label
      const member = team?.members.find(m => m.id === id)
      return member?.name ?? id
    }

    const open = (id: string): void => {
      openSessionVia(ctx, id)
    }

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
    const leadDetail = leadId !== undefined ? landedDetails.get(leadId) ?? null : null
    return (
      <div className="lc-root">
        <AgentGraph
          sessionId={sessionId}
          forest={forest}
          hoverId={hoverId}
          onHover={setHoverId}
          extras={{
            team,
            pinnedId,
            onPin: setPinnedId,
            detailOf: id => details.landed.get(id),
            commsOf: id => commsByAgent.get(id) ?? [],
            labelOf,
            roster: leadDetail?.roster ?? [],
            onFocusTask: setFocusTaskId,
          }}
        />
        {team !== null && forest !== null
          ? (
            <MemberBoard
              team={team}
              forest={forest}
              leadDetail={leadDetail}
              detailOf={id => details.landed.get(id)}
              pinnedId={pinnedId}
              onPin={setPinnedId}
              onHover={setHoverId}
              onOpen={open}
              ownerFilter={ownerFilter}
              onOwnerFilter={setOwnerFilter}
              t={t}
            />
          )
          : null}
        {team !== null
          ? (
            <TaskBoard
              team={team}
              ownerFilter={ownerFilter}
              onOwnerFilter={setOwnerFilter}
              focusTaskId={focusTaskId}
              onFocusTask={setFocusTaskId}
              onPinMember={setPinnedId}
              t={t}
            />
          )
          : null}
        {forest !== null && !forest.solo
          ? (
            <FleetList
              forest={forest}
              team={team}
              pinnedId={pinnedId}
              onPin={setPinnedId}
              onHover={setHoverId}
              onOpen={open}
              t={t}
              fmt={kit.fmt}
            />
          )
          : null}
        {forest !== null && !forest.solo
          ? (
            <CommsPanel
              nodes={forest.nodes}
              details={details}
              comms={comms}
              labelOf={labelOf}
              onPin={setPinnedId}
              t={t}
              fmt={kit.fmt}
            />
          )
          : null}
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
