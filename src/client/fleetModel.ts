import { useEffect, useMemo, useRef, useState } from 'react'
import type { AgentHeads } from './agentHeads'
import { useSessionsSnapshot } from './agentHeads'
import type { AgentForest, AgentSelfStats } from './agentTree'
import { agentForestOf, sessionTitlesOf, sessionsFaceOf } from './agentTree'
import { FleetDetailCache } from './fleetDetail'
import { lruTrim } from './lru'
import { teamOf, type FleetTeam } from './fleetTeam'
import { asRecord, type ClientCtx } from './services'
import type { ContextTimeline, FleetDetail } from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  team: FleetTeam | null
  titles: ReadonlyMap<string, string>
}

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

export function useFleetModel(
  ctx: ClientCtx,
  heads: AgentHeads,
  sessionId: string | undefined,
  self: AgentSelfStats | undefined,
  active: boolean,
  coalesceMs = 0,
): FleetModel {
  const face = useMemo(() => (active ? sessionsFaceOf(ctx) : null), [ctx, active])
  const snapshot = useSessionsSnapshot(face, coalesceMs)

  useEffect(() => {
    if (face === null || typeof sessionId !== 'string' || sessionId === '') return
    if (typeof face.refreshSubagents !== 'function') return
    face.refreshSubagents(sessionId).catch(() => {})
  }, [face, sessionId])

  const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())

  const forest = useMemo(
    () => agentForestOf(snapshot, sessionId, self, landed),
    [snapshot, sessionId, self, landed],
  )

  useEffect(() => {
    if (forest === null) return
    const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
      void pending.then((head) => {
        if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
      }).catch(() => {})
    }
    for (const n of forest.nodes) {
      if (n.isCurrent || (n.head !== null && n.head.parts.length > 0)) continue
      attach(heads.headOf(n.id), n.id)
    }
  }, [forest, heads])

  const team = useMemo(() => teamOfSnapshot(snapshot, forest), [snapshot, forest])
  const titles = useMemo(() => sessionTitlesOf(snapshot), [snapshot])

  return { forest, team, titles }
}

export interface FleetDetailState {
  landed: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  historyLanded: ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  historyPending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  request(id: string, updatedAt: number): void
  requestHistory(id: string, updatedAt: number): void
  requestFull(id: string): void
}

export interface FleetDetailOptions {
  concurrency?: number
  refreshDelayMs?: number
  scopeKey?: string
}

export function agentPromptOf(details: FleetDetailState, id: string): string | undefined {
  const entry = details.landed.get(id)?.detail
  return (!details.fullPending.has(id)
    ? details.fullLanded.get(id)?.initialPrompt ?? entry?.initialPrompt
    : entry?.initialPrompt)
}

interface QueueTask {
  id: string
  stamp: number
  history: boolean
}

const FULL_STATE_MAX = 8

export function useFleetDetails(cache?: FleetDetailCache, options: FleetDetailOptions = {}): FleetDetailState {
  const owned = useMemo(() => (cache === undefined ? new FleetDetailCache() : null), [cache])
  const ledger = cache ?? owned as FleetDetailCache
  const maxInflight = options.concurrency ?? Number.POSITIVE_INFINITY
  const refreshDelay = options.refreshDelayMs ?? 0
  const scopeKey = options.scopeKey
  const [landed, setLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [historyLanded, setHistoryLanded] = useState<ReadonlyMap<string, { detail: FleetDetail | null; updatedAt: number }>>(new Map())
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [historyPending, setHistoryPending] = useState<ReadonlySet<string>>(new Set())
  const requested = useRef(new Map<string, number>())
  const historyRequested = useRef(new Map<string, number>())
  const mounted = useRef(true)
  const active = useRef(0)
  const queue = useRef<QueueTask[]>([])
  const refreshTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const drain = (): void => {
    while (active.current < maxInflight && queue.current.length > 0) {
      const task = queue.current.shift() as QueueTask
      const valid = task.history ? historyRequested.current.get(task.id) === task.stamp : requested.current.get(task.id) === task.stamp
      /* v8 ignore next 1 */
      if (!valid) continue
      active.current++
      const pending = task.history ? ledger.fetchHistory(task.id, task.stamp) : ledger.fetch(task.id, task.stamp)
      void pending.then((detail) => {
        const currentValid = task.history
          ? historyRequested.current.get(task.id) === task.stamp
          : requested.current.get(task.id) === task.stamp
        if (!mounted.current || !currentValid) return
        if (task.history) setHistoryLanded(prev => new Map(prev).set(task.id, { detail, updatedAt: task.stamp }))
        else {
          setLanded(prev => new Map(prev).set(task.id, { detail, updatedAt: task.stamp }))
          /* v8 ignore next 1 */
          if (detail !== null && detail.messagesTotal !== undefined) requestHistory(task.id, task.stamp)
        }
        const clear = task.history ? setHistoryPending : setPending
        clear((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).catch(() => {
        const currentValid = task.history
          ? historyRequested.current.get(task.id) === task.stamp
          : requested.current.get(task.id) === task.stamp
        /* v8 ignore next 1 */
        if (!mounted.current || !currentValid) return
        const clear = task.history ? setHistoryPending : setPending
        clear((prev) => {
          const next = new Set(prev)
          next.delete(task.id)
          return next
        })
      }).finally(() => {
        active.current--
        drain()
      })
    }
  }

  const enqueue = (id: string, stamp: number, silent: boolean, history: boolean): void => {
    if (!silent) {
      const set = history ? setHistoryPending : setPending
      set(prev => prev.has(id) ? prev : new Set(prev).add(id))
    }
    const at = queue.current.findIndex(task => task.id === id && task.history === history)
    if (at >= 0) queue.current[at] = { id, stamp, history }
    else queue.current.push({ id, stamp, history })
    drain()
  }

  const request = (id: string, updatedAt: number): void => {
    const known = requested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    requested.current.set(id, updatedAt)
    if (refreshDelay > 0 && landed.has(id)) {
      const key = `preview:${id}`
      const armed = refreshTimers.current.get(key)
      if (armed !== undefined) clearTimeout(armed)
      refreshTimers.current.set(key, setTimeout(() => {
        refreshTimers.current.delete(key)
        /* v8 ignore next 1 */
        if (!mounted.current) return
        const target = requested.current.get(id)
        /* v8 ignore next 1 */
        if (target !== undefined) enqueue(id, target, true, false)
      }, refreshDelay))
      return
    }
    enqueue(id, updatedAt, false, false)
  }

  const requestHistory = (id: string, updatedAt: number): void => {
    const known = historyRequested.current.get(id)
    if (known !== undefined && known >= updatedAt) return
    historyRequested.current.set(id, updatedAt)
    if (refreshDelay > 0 && historyLanded.has(id)) {
      const key = `history:${id}`
      const armed = refreshTimers.current.get(key)
      if (armed !== undefined) clearTimeout(armed)
      refreshTimers.current.set(key, setTimeout(() => {
        refreshTimers.current.delete(key)
        /* v8 ignore next 1 */
        if (!mounted.current) return
        /* v8 ignore next 1 */
        enqueue(id, historyRequested.current.get(id) ?? 0, true, true)
      }, refreshDelay))
      return
    }
    enqueue(id, updatedAt, false, true)
  }

  useEffect(() => {
    queue.current = []
    requested.current.clear()
    historyRequested.current.clear()
    owned?.clear()
    fullRequested.current.clear()
    fullKnown.current = new Set()
    fullInFlight.current.clear()
    for (const timer of refreshTimers.current.values()) clearTimeout(timer)
    refreshTimers.current.clear()
    setLanded(new Map())
    setHistoryLanded(new Map())
    setPending(new Set())
    setHistoryPending(new Set())
    setFullLanded(new Map())
    setFullPending(new Set())
  }, [scopeKey])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      queue.current = []
      for (const timer of refreshTimers.current.values()) clearTimeout(timer)
      refreshTimers.current.clear()
    }
  }, [])

  const [fullLanded, setFullLanded] = useState<ReadonlyMap<string, FleetDetail | null>>(new Map())
  const [fullPending, setFullPending] = useState<ReadonlySet<string>>(new Set())
  const fullRequested = useRef(new Map<string, number>())
  const fullKnown = useRef<ReadonlySet<string>>(new Set())
  const fullInFlight = useRef<Set<string>>(new Set())

  const requestFull = (id: string): void => {
    const stamp = requested.current.get(id) ?? 0
    const known = fullRequested.current.get(id)
    if (known !== undefined && known >= stamp && (fullKnown.current.has(id) || fullInFlight.current.has(id))) return
    fullRequested.current.set(id, stamp)
    fullInFlight.current.add(id)
    setFullPending(prev => prev.has(id) ? prev : new Set(prev).add(id))
    void ledger.fetch(id, stamp, true).then((detail) => {
      if (!mounted.current || fullRequested.current.get(id) !== stamp) return
      fullInFlight.current.delete(id)
      setFullLanded((prev) => {
        const next = new Map(prev)
        next.delete(id)
        next.set(id, detail)
        lruTrim(next, FULL_STATE_MAX)
        fullKnown.current = new Set(next.keys())
        return next
      })
      setFullPending((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    })
  }

  return { landed, historyLanded, fullLanded, pending, historyPending, fullPending, request, requestHistory, requestFull }
}
