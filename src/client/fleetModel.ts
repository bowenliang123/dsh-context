/**
 * The Fleet tab's shared model seats. `useFleetModel` owns the session-list subscription, the
 * cold-head backfill, the forest derivation, and the team projection read — the one derivation
 * every Fleet panel (graph, inspector, list, team, comms) and the right Sidebar's inline mount
 * share, so no two panels can disagree on the family. `useFleetDetails` owns the fleet-detail
 * route reads: per-session freshness-stamped fetches behind a page-scope ledger, with the comms
 * scan's progress and staleness derived from the same state.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHeads } from './agentHeads'
import { useSessionsSnapshot } from './agentHeads'
import { agentForestOf, sessionsFaceOf, type AgentForest, type AgentNode, type AgentSelfStats } from './agentTree'
import { FleetDetailCache } from './fleetDetail'
import { teamOf, type FleetTeam } from './fleetTeam'
import type { ClientCtx } from './services'
import { asRecord } from './services'
import type { ContextTimeline, FleetDetail } from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  /** The family's team projection off the root row's list block; null when no family row carries one. */
  team: FleetTeam | null
}

/** The family's `agentTeam` projection off the list rows: DFS pre-order starts at the root (the
 * team lives on the lead), so the first carrying row wins — a teammate never carries one, but a
 * hostile or partial snapshot costs nothing to sweep. */
export function teamOfSnapshot(snapshot: unknown, forest: AgentForest | null): FleetTeam | null {
  if (forest === null) return null
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null) return null
  for (const n of forest.nodes) {
    const row = asRecord(byId[n.id])
    const team = teamOf(asRecord(row?.projectionValues)?.agentTeam)
    if (team !== null) return team
  }
  return null
}

/**
 * The family model behind the Agent network card and the Fleet tab's panels. `active` gates every
 * subscription and fetch: the Context tab's main mount never renders the graph, so it passes false
 * and the model stays inert (no snapshot subscription, no cold-head reads).
 */
export function useFleetModel(
  ctx: ClientCtx,
  heads: AgentHeads,
  sessionId: string | undefined,
  self: AgentSelfStats | undefined,
  active: boolean,
): FleetModel {
  // Resolved lazily at mount (not at apply): the outward sessions service belongs to the client
  // runtime's composition, and a deployment without it keeps the card hidden.
  const face = useMemo(() => (active ? sessionsFaceOf(ctx) : null), [ctx, active])
  const snapshot = useSessionsSnapshot(face)

  // Discover the current session's direct-child catalog once per session: catalog-derived
  // children join the list rows (and gain navigation addresses). Fire-and-forget — the panels
  // render from list rows alone.
  useEffect(() => {
    if (face === null || typeof sessionId !== 'string' || sessionId === '') return
    if (typeof face.refreshSubagents !== 'function') return
    face.refreshSubagents(sessionId).catch(() => {})
  }, [face, sessionId])

  // Composition heads fetched for cold relatives (see the effect below): landed values re-fold
  // the forest with the row's missing `contextTimeline` injected.
  const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())

  const forest = useMemo(
    () => agentForestOf(snapshot, sessionId, self, landed),
    [snapshot, sessionId, self, landed],
  )

  // Nodes with no composition (occupancy-only, or nothing listed at all — the projection cache
  // holds no timeline row for either) fetch their slim head off the detail route (the shared
  // page-scope cache) and re-render composed. The current node is excluded: the tab's own
  // projections already feed it live. A remount (tab switch) resets this state but not the cache,
  // so a cached read REPLAYS into the fresh instance — otherwise a fetched relative would fall
  // back to green on every remount, forever.
  useEffect(() => {
    if (forest === null) return
    const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
      void pending.then((head) => {
        // Same value → same state: the identity bail-out keeps a settled replay on every snapshot tick from looping.
        if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
      }).catch(() => {})
    }
    for (const n of forest.nodes) {
      if (n.isCurrent || (n.head !== null && n.head.parts.length > 0)) continue
      attach(heads.headOf(n.id), n.id)
    }
  }, [forest, heads])

  const team = useMemo(() => teamOfSnapshot(snapshot, forest), [snapshot, forest])

  return { forest, team }
}

export interface FleetDetailState {
  /** Landed reads keyed by session id; a null detail means the route served nothing (absent or failed). */
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  /** Reads requested but not yet landed. */
  pending: ReadonlySet<string>
  /** Sessions the comms panel's scan/refresh claimed — inspector reads alone never join this set. */
  scanned: ReadonlySet<string>
  request(id: string, updatedAt: number): void
  /** Read every node's detail (the comms panel's scan). */
  scan(nodes: readonly AgentNode[]): void
  /** Drop every requested entry's cache line and read again. */
  refresh(nodes: readonly AgentNode[]): void
}

/** True when any node with a landed read has since moved its list-row stamp — the comms panel's
 * "new activity since the scan" hint. */
export function commsStaleOf(
  nodes: readonly AgentNode[],
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>,
): boolean {
  for (const n of nodes) {
    const entry = landed.get(n.id)
    if (entry !== undefined && n.updatedAt > entry.updatedAt) return true
  }
  return false
}

/** The page-scope ledger every mount shares (the agentHeads pattern): a remount replays settled reads. */
const sharedCache = new FleetDetailCache()

/** The Fleet-detail read ledger behind the inspector and the comms panel. */
export function useFleetDetails(cache: FleetDetailCache = sharedCache): FleetDetailState {
  const [landed, setLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [scanned, setScanned] = useState<ReadonlySet<string>>(new Set())
  /** Requested stamps, for synchronous dedupe decisions (the cache dedupes the network read too). */
  const requested = useRef(new Map<string, number>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  const request = (id: string, updatedAt: number): void => {
    const known = requested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    requested.current.set(id, updatedAt)
    setPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void cache.fetch(id, updatedAt).then((detail) => {
      if (!mounted.current) return
      setLanded(prev => new Map(prev).set(id, { detail, updatedAt }))
      setPending((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  const claim = (nodes: readonly AgentNode[]): void => {
    setScanned((prev) => {
      const next = new Set(prev)
      for (const n of nodes) next.add(n.id)
      return next.size === prev.size ? prev : next
    })
  }

  const scan = (nodes: readonly AgentNode[]): void => {
    claim(nodes)
    for (const n of nodes) request(n.id, n.updatedAt)
  }

  const refresh = (nodes: readonly AgentNode[]): void => {
    claim(nodes)
    for (const n of nodes) {
      cache.invalidate(n.id)
      requested.current.delete(n.id)
      request(n.id, n.updatedAt)
    }
  }

  return { landed, pending, scanned, request, scan, refresh }
}
