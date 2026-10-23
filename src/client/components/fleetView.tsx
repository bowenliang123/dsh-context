/** The Fleet tab: one shared derivation feeds the overview strip, the graph/members/task cockpit row and the comms
 * timeline. Both boards stay up with guidance notes when the session never formed a team, so the page's shape never
 * jumps between session kinds; hover, pin, owner filter and task focus are all lifted here so every board steers. */

import { createElement as h, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import { displayCurrencyOf } from '../cost'
import { mergeComms } from '../fleetDetail'
import { useFleetDetails, useFleetModel } from '../fleetModel'
import { teamMemberOf, teamOf } from '../fleetTeam'
import { useModelPrices } from '../modelPrices'
import type { ClientCtx, SessionStandardProps } from '../services'
import { openChildAsideVia, openSessionVia, projectionOf, unsupportedOf } from '../services'
import { useContextSession } from '../sessionData'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import { makeAgentGraph } from './agentGraph'
import { useCostPrefs, type ContextSettings } from '../settings'
import { CommsPanel } from './commsPanel'
import { makeDetailNote } from './detailNote'
import { makeRichText } from './richText'
import { makeErrorBoundary } from './errorBoundary'
import { FleetSummary } from './fleetSummary'
import { MemberBoard } from './memberBoard'
import { TaskBoard } from './taskBoard'
import { makeUpgradeGate } from './upgradeGate'

export function makeFleetView(
  ctx: ClientCtx,
  kit: ViewKit,
  heads: AgentHeads,
  /** The plugin settings the strip and the cards price with. */
  settings: ContextSettings | null = null,
): (props: SessionStandardProps) => ReactElement {
  const { t } = kit
  const AgentGraph = makeAgentGraph(ctx, kit, heads, settings)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)
  const rich = makeRichText(kit)

  function FleetBody(props: SessionStandardProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    const rootRef = useRef<HTMLDivElement | null>(null)
    // Re-claim the top per session in a layout effect: the harness carries the chat's bottom-anchored scrollTop across
    // tab switches, and no saved position would survive the page's late layout passes.
    useLayoutEffect(() => {
      /* v8 ignore next 3 -- a layout effect body only runs while mounted and
         both render paths attach rootRef, so the null arm cannot fire. */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller !== null) scroller.scrollTop = 0
    }, [sessionId])
    const self = data !== null ? agentSelfOf(data, pressure, breakdown, usage) : undefined
    // The model arms only once the tab's timeline landed: while the loading/failure screen stands, no subscription or read fires.
    const { forest, team: rowTeam } = useFleetModel(ctx, heads, sessionId, self, data !== null)
    // The freshest team value is the tab's OWN projection when the viewed session leads; a teammate falls back to the lead row's copy.
    const teamDirect = projectionOf(props, 'agentTeam', teamOf)
    const team = teamDirect ?? rowTeam
    const details = useFleetDetails()
    const [hoverId, setHoverId] = useState<string | null>(null)
    const [pinnedId, setPinnedId] = useState<string | null>(null)
    // The boards' cap rides the network card: the task card grows with the graph and bottoms out at its own default
    // otherwise. Measure the graph's NATURAL content height (last child's offset + card padding) — the stretched
    // column's height would self-fulfill the cap and never bind when the members card drives the row.
    const colsRef = useRef<HTMLDivElement | null>(null)
    useEffect(() => {
      const row = colsRef.current
      /* v8 ignore start -- jsdom has neither ResizeObserver nor layout; the caps are visual. */
      if (row === null || typeof ResizeObserver !== 'function') return
      const graph = row.querySelector<HTMLElement>('.lc-col-graph')
      const members = row.querySelector<HTMLElement>('.lc-members')
      const write = (): void => {
        let graphH = 0
        const card = graph?.firstElementChild as HTMLElement | undefined
        if (card !== undefined && card.lastElementChild !== null) {
          const pad = window.parseFloat(window.getComputedStyle(card).paddingBottom)
          graphH = card.lastElementChild.getBoundingClientRect().bottom - card.getBoundingClientRect().top + pad
        }
        row.style.setProperty('--lc-graph-h', `${Math.ceil(graphH)}px`)
        row.style.setProperty('--lc-members-h', members !== null ? `${Math.ceil(members.getBoundingClientRect().height)}px` : '0px')
      }
      write()
      const observer = new ResizeObserver(write)
      if (graph !== null) observer.observe(graph)
      if (members !== null) observer.observe(members)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [forest, team])
    /** The task board's owner filter and focus flash, shared with the members board. */
    const [ownerFilter, setOwnerFilter] = useState<string | null>(null)
    const [focusTaskId, setFocusTaskId] = useState<string | null>(null)
    const { book } = useModelPrices()
    const currency = displayCurrencyOf(ctx.locale)
    const prefs = useCostPrefs(settings)

    const byId = useMemo(
      () => new Map((forest?.nodes ?? []).map(n => [n.id, n])),
      [forest],
    )

    // A pinned agent that left the family releases the pin instead of ringing a ghost.
    useEffect(() => {
      if (pinnedId !== null && !byId.has(pinnedId)) setPinnedId(null)
    }, [pinnedId, byId])

    // The lead's detail feeds the members board's roster facts; every family node's detail rides too, so member/reply/
    // briefing/comms rows fill in on first paint instead of after a scan.
    const leadId = team !== null ? team.members[0]?.id : undefined
    const detailStamp = forest === null ? '' : forest.nodes.map(n => `${n.id}@${n.updatedAt}`).join(',')
    useEffect(() => {
      if (forest === null) return
      for (const node of forest.nodes) details.request(node.id, node.updatedAt)
    }, [forest, detailStamp])

    const landedDetails = useMemo(() => {
      const map = new Map<string, FleetDetail>()
      for (const [id, entry] of details.landed) {
        if (entry.detail !== null) map.set(id, entry.detail)
      }
      return map
    }, [details.landed])
    const comms = useMemo(() => mergeComms(landedDetails), [landedDetails])

    const labelOf = (id: string): string => {
      const node = byId.get(id)
      if (node !== undefined) return node.label
      const member = team?.members.find(m => m.id === id)
      return member?.name ?? id
    }

    /** A member card's open: the right Sidebar's subagent chat (the header catalog's own aside verb), addressed by the
     * node's direct parent; a column that cannot take the resource, or a node without its parent edge, keeps the
     * whole-view jump. */
    const open = (id: string): void => {
      const node = byId.get(id)
      /* v8 ignore next 5 -- defensive arms: the opener only fires from a family card on a
         session-scoped tab, so a family node always carries its direct parent edge. */
      if (openChildAsideVia(ctx, {
        childSessionId: id,
        parentSessionId: node?.parentId,
        mode: node?.identity?.mode,
      })) return
      openSessionVia(ctx, id)
    }

    /** A graph-node or member-card pick rings the node and narrows the task board to that agent's work — members by
     * roster name, plain subagents by their own session; picking again releases both. */
    const select = (id: string): void => {
      const next = pinnedId === id ? null : id
      setPinnedId(next)
      const member = teamMemberOf(team, id)
      if (next !== null) setOwnerFilter(member?.name ?? id)
      else if (ownerFilter === id || (member !== null && ownerFilter === member.name)) setOwnerFilter(null)
    }

    // The picked agent's session id: a roster member joins by name, a plain subagent by its own — the one key the task
    // board and the comms timeline both narrow by. A key neither can account for (a hostile snapshot's transient) rides
    // raw: both boards name it on their chips and empty together, and the next sound snapshot restores them.
    const pickId = useMemo(() => {
      if (ownerFilter === null) return null
      return team?.members.find(m => m.name === ownerFilter)?.id ?? ownerFilter
    }, [ownerFilter, team])

    if (data === null) {
      return (
        <div className="lc-root" ref={rootRef}>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    // The baseline gate must not hide behind whichever tab the reader opened: the dismissal ledger is keyed by session.
    const gate = unsupportedOf(data.unsupported)
    const leadDetail = leadId !== undefined ? landedDetails.get(leadId) ?? null : null
    /** A task-board row pick toggles the pin; a release also lets go of a task-board narrowing still pointing at that
     * agent (the same pair select() manages for graph and member picks). */
    const pinToggle = (id: string | null): void => {
      const releasing = pinnedId === id
      setPinnedId(releasing ? null : id)
      if (releasing && id !== null) {
        const member = teamMemberOf(team, id)
        const key = member?.name ?? id
        if (ownerFilter === key) setOwnerFilter(null)
      }
    }
    const taskBoard = (
      <TaskBoard
        team={team}
        forest={forest}
        detailOf={id => details.landed.get(id)}
        fullOf={id => ({ detail: details.fullLanded.get(id) ?? null, pending: details.fullPending.has(id) })}
        onOpenOwner={(id) => { details.requestFull(id) }}
        ownerFilter={ownerFilter}
        onOwnerFilter={setOwnerFilter}
        focusTaskId={focusTaskId}
        onFocusTask={setFocusTaskId}
        onPinMember={pinToggle}
        onHoverMember={setHoverId}
        rich={rich}
        t={t}
        fmt={kit.fmt}
      />
    )
    // The boards column's two cards stack; the network column is the graph alone, and either seat may be absent.
    const boardsColumn = forest !== null
      ? (
        <div className="lc-col flex-1 min-w-[min(360px,100%)]">
          <MemberBoard
            team={team}
            forest={forest}
            leadDetail={leadDetail}
            detailOf={id => details.landed.get(id)}
            pinnedId={pinnedId}
            hoverId={hoverId}
            onPin={select}
            onHover={setHoverId}
            onOpen={open}
            ownerFilter={ownerFilter}
            onOwnerFilter={setOwnerFilter}
            t={t}
            fmt={kit.fmt}
          />
          {taskBoard}
        </div>
      )
      : team !== null
        ? <div className="lc-col flex-1 min-w-[min(360px,100%)]">{taskBoard}</div>
        : null
    return (
      <div className="lc-root" ref={rootRef}>
        {forest !== null
          ? <FleetSummary forest={forest} team={team} book={book} currency={currency} prefs={prefs} t={t} fmt={kit.fmt} />
          : null}
        {forest !== null || boardsColumn !== null
          ? (
            <div className="lc-cols" ref={colsRef}>
              {forest !== null
                ? (
                  <div className="lc-col lc-col-graph flex-1 min-w-[min(420px,100%)]">
                    <AgentGraph
                      sessionId={sessionId}
                      forest={forest}
                      team={team}
                      pinnedId={pinnedId}
                      hoverId={hoverId}
                      onHover={setHoverId}
                      onSelect={select}
                      inspector={false}
                    />
                  </div>
                )
                : null}
              {boardsColumn}
            </div>
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
              pickId={pickId}
              onPickClear={() => { setOwnerFilter(null) }}
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
