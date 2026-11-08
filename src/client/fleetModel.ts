import { useEffect, useMemo, useRef, useState } from 'react'
import { readHeads, useSessionsSnapshot, type AgentHeads } from './agentHeads'
import type { AgentForest, AgentSelfStats } from './agentTree'
import { agentForestOf, sessionTitlesOf, sessionsFaceOf } from './agentTree'
import { detailBytes, FleetDetailCache, type FleetBatch } from './fleetDetail'
import { lruTrim } from './boundedCache'
import { teamOf, type FleetTeam } from './fleetTeam'
import { retentionOf } from './retention'
import { subscribeInvalidations } from './invalidation'
import { asRecord, type ClientCtx } from './services'
import type {
  ContextTimeline,
  FleetDelegation,
  FleetDetail,
  FleetDetailCounts,
  FleetMemberInfo,
  FleetSummary,
} from '../shared/types'

export interface FleetModel {
  forest: AgentForest | null
  team: FleetTeam | null
  titles: ReadonlyMap<string, string>
}

const HEADS_LANDED_MAX = 512

const PRIORITY_MAX = 64

const PREVIEW_POLICY = retentionOf('fleetPreview')
const HISTORY_POLICY = retentionOf('fleetHistory')
const FULL_POLICY = retentionOf('fleetFull')
const LANDED_MAX = PREVIEW_POLICY.maxEntries
/* v8 ignore next 1 */
const LANDED_BYTES_MAX = PREVIEW_POLICY.maxBytes ?? Number.POSITIVE_INFINITY
const HISTORY_LANDED_MAX = HISTORY_POLICY.maxEntries
/* v8 ignore next 1 */
const HISTORY_BYTES_MAX = HISTORY_POLICY.maxBytes ?? Number.POSITIVE_INFINITY
const FACTS_MAX = 1024
const FACTS_BYTES_MAX = 4 * 1024 * 1024
const FULL_STATE_MAX = FULL_POLICY.maxEntries
const BATCH_SIZE = 16
const MAX_ATTEMPTS = 3
const RETRY_BASE_MS = 150
const RETRY_MAX_MS = 2_000
const REFRESH_DELAY_MS = 750

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

function headNeedsRefresh(head: ContextTimeline): boolean {
  return head.costRead === undefined || !head.costRead.ready
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
  const requested = useRef(new Map<string, number>())
  const forced = useRef(new Set<string>())
  const [invalidationVersion, setInvalidationVersion] = useState(0)

  useEffect(() => subscribeInvalidations((event) => {
    if (event.kind !== 'pricing' && event.kind !== 'heads') return
    for (const [id, head] of landed) {
      if (event.kind === 'pricing' && !headNeedsRefresh(head)) continue
      if (event.kind === 'heads' && event.sessionId !== undefined && event.sessionId !== id) continue
      forced.current.add(id)
      requested.current.delete(id)
    }
    if (event.kind === 'heads' && event.sessionId === undefined) requested.current.clear()
    setInvalidationVersion(value => value + 1)
  }), [landed])

  const forest = useMemo(
    () => agentForestOf(snapshot, sessionId, self, landed),
    [snapshot, sessionId, self, landed],
  )

  useEffect(() => { requested.current.clear() }, [sessionId])

  useEffect(() => {
    if (forest === null) return
    const attach = (pending: Promise<ContextTimeline | null>, id: string): void => {
      void pending.then((head) => {
        if (head === null) return
        setLanded((prev) => {
          const next = new Map(prev)
          next.delete(id)
          next.set(id, head)
          lruTrim(next, HEADS_LANDED_MAX)
          return next
        })
      }, () => { requested.current.delete(id) })
    }
    const pending: { id: string; updatedAt: number }[] = []
    for (const n of forest.nodes) {
      if (n.isCurrent) continue
      const force = forced.current.delete(n.id)
      if (!force && n.head !== null && n.head.parts.length > 0) continue
      if (!force && (requested.current.get(n.id) ?? Number.NEGATIVE_INFINITY) >= n.updatedAt) continue
      requested.current.set(n.id, n.updatedAt)
      pending.push({ id: n.id, updatedAt: n.updatedAt })
    }
    if (pending.length === 0) return
    if (pending.length > 1) {
      void readHeads(heads, pending.map(entry => entry.id)).then((reads) => {
        for (const entry of pending) {
          const head = reads.get(entry.id)
          if (head !== undefined) attach(Promise.resolve(head), entry.id)
          else requested.current.delete(entry.id)
        }
      }, () => {
        for (const entry of pending) requested.current.delete(entry.id)
      })
      return
    }
    const [only] = pending
    attach(heads.headOf(only.id), only.id)
  }, [forest, heads, invalidationVersion])

  const team = useMemo(() => teamOfSnapshot(snapshot, forest), [snapshot, forest])
  const titles = useMemo(() => sessionTitlesOf(snapshot), [snapshot])

  return { forest, team, titles }
}

export interface FleetDetailEntry {
  detail: FleetDetail | null
  updatedAt: number
}

interface PayloadEntry extends FleetDetailEntry {
  bytes: number
}

export interface FleetFact {
  updatedAt: number
  messagesTotal: number
  needsHistory: boolean
  delegations: readonly FleetDelegation[]
  initialPrompt?: string
  lastReply?: { time: number; text: string }
  roster?: readonly FleetMemberInfo[]
}

export interface FleetFamily {
  total: number
  loaded: number
  pending: number
  failed: number
  messages: number | null
  delegations: number | null
}

export interface FleetFamilyRequest {
  rootId: string
  rootStamp: number
  entries: readonly { id: string; updatedAt: number }[]
  priority?: ReadonlySet<string>
}

export interface FleetDetailState {
  summary: FleetSummary | null
  landed: ReadonlyMap<string, FleetDetailEntry>
  historyLanded: ReadonlyMap<string, FleetDetailEntry>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  historyPending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  facts: ReadonlyMap<string, FleetFact>
  family: FleetFamily
  requestFamily(request: FleetFamilyRequest): void
  requestFull(id: string): void
  prioritize(id: string): void
  retryFamily(): void
}

interface DetailStore {
  summary: FleetSummary | null
  landed: ReadonlyMap<string, PayloadEntry>
  historyLanded: ReadonlyMap<string, PayloadEntry>
  fullLanded: ReadonlyMap<string, FleetDetail | null>
  pending: ReadonlySet<string>
  historyPending: ReadonlySet<string>
  fullPending: ReadonlySet<string>
  facts: ReadonlyMap<string, FleetFact>
  family: FleetFamily
}

const EMPTY_FAMILY: FleetFamily = { total: 0, loaded: 0, pending: 0, failed: 0, messages: null, delegations: null }

const INITIAL_STORE: DetailStore = {
  summary: null,
  landed: new Map(),
  historyLanded: new Map(),
  fullLanded: new Map(),
  pending: new Set(),
  historyPending: new Set(),
  fullPending: new Set(),
  facts: new Map(),
  family: EMPTY_FAMILY,
}

function factOf(detail: FleetDetail, updatedAt: number): FleetFact {
  return {
    updatedAt,
    messagesTotal: detail.messagesTotal ?? detail.messages.length,
    needsHistory: detail.messagesTotal !== undefined && detail.messagesTotal > detail.messages.length,
    delegations: detail.delegations ?? [],
    ...(detail.initialPrompt !== undefined ? { initialPrompt: detail.initialPrompt } : {}),
    ...(detail.lastReply !== undefined ? { lastReply: detail.lastReply } : {}),
    ...(detail.roster !== undefined ? { roster: detail.roster } : {}),
  }
}

function factBytes(fact: FleetFact): number {
  let bytes = (fact.initialPrompt?.length ?? 0) + (fact.lastReply?.text.length ?? 0)
  for (const delegation of fact.delegations) bytes += delegation.label?.length ?? 0
  for (const member of fact.roster ?? []) bytes += member.name.length + member.description.length
  return bytes
}

function trimPayloads(
  map: Map<string, PayloadEntry>,
  maxEntries: number,
  maxBytes: number,
  keep: ReadonlySet<string>,
): void {
  let bytes = 0
  for (const entry of map.values()) bytes += entry.bytes
  for (const key of [...map.keys()]) {
    if (map.size <= maxEntries && bytes <= maxBytes) return
    if (map.size <= 1 || keep.has(key)) continue
    const entry = map.get(key) as PayloadEntry
    map.delete(key)
    bytes -= entry.bytes
  }
}

function slimFact(fact: FleetFact): FleetFact {
  return {
    updatedAt: fact.updatedAt,
    messagesTotal: fact.messagesTotal,
    needsHistory: fact.needsHistory,
    delegations: fact.delegations,
  }
}

function trimFacts(map: Map<string, FleetFact>): void {
  let bytes = 0
  for (const fact of map.values()) bytes += factBytes(fact)
  for (const key of [...map.keys()]) {
    if (map.size <= FACTS_MAX && bytes <= FACTS_BYTES_MAX) return
    const fact = map.get(key) as FleetFact
    const slim = slimFact(fact)
    bytes -= factBytes(fact) - factBytes(slim)
    map.set(key, slim)
  }
  while (map.size > FACTS_MAX) map.delete(map.keys().next().value as string)
}

function markPending(pending: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(pending)
  for (const id of ids) next.add(id)
  return next
}

function stampKey(kind: 'preview' | 'history', id: string, stamp: number): string {
  return `${kind}:${id}:${stamp}`
}

function staleStampKey(key: string, desired: ReadonlyMap<string, number>): boolean {
  const parts = key.split(':')
  const id = parts[1]
  const stamp = Number(parts[2])
  return desired.get(id) !== stamp
}

function familyOf(
  desired: ReadonlyMap<string, number>,
  landedStamp: ReadonlyMap<string, number>,
  facts: ReadonlyMap<string, FleetFact>,
  counts: ReadonlyMap<string, FleetDetailCounts>,
  failed: ReadonlySet<string>,
): FleetFamily {
  let loaded = 0
  let failedCount = 0
  let messages = 0
  let delegations = 0
  let complete = true
  for (const [id, stamp] of desired) {
    if ((landedStamp.get(id) ?? Number.NEGATIVE_INFINITY) >= stamp) loaded += 1
    else if (failed.has(previewFailedKey(id, stamp))) failedCount += 1
    const fact = facts.get(id)
    if (fact !== undefined && fact.updatedAt >= stamp) {
      messages += fact.messagesTotal
      delegations += fact.delegations.length
      continue
    }
    const known = counts.get(id)
    if (known !== undefined && known.readAt >= stamp) {
      messages += known.messagesTotal
      delegations += known.delegationsCount
      continue
    }
    complete = false
  }
  const total = desired.size
  return {
    total,
    loaded,
    pending: Math.max(0, total - loaded - failedCount),
    failed: failedCount,
    messages: complete ? messages : null,
    delegations: complete ? delegations : null,
  }
}

export function mergedDetailOf(details: FleetDetailState, id: string): FleetDetail | null {
  const preview = details.landed.get(id)
  const history = details.historyLanded.get(id)
  if (history !== undefined && (preview === undefined || history.updatedAt >= preview.updatedAt)) return history.detail
  return preview?.detail ?? null
}

export function agentPromptOf(details: FleetDetailState, id: string): string | undefined {
  const fact = details.facts.get(id)
  if (!details.fullPending.has(id)) {
    const full = details.fullLanded.get(id)
    if (full !== undefined && full !== null) return full.initialPrompt ?? fact?.initialPrompt
  }
  return fact?.initialPrompt ?? mergedDetailOf(details, id)?.initialPrompt
}

export function agentReplyOf(details: FleetDetailState, id: string): { time: number; text: string } | undefined {
  if (!details.fullPending.has(id)) {
    const full = details.fullLanded.get(id)
    if (full !== undefined && full !== null) return full.lastReply ?? details.facts.get(id)?.lastReply
  }
  return details.facts.get(id)?.lastReply ?? mergedDetailOf(details, id)?.lastReply
}

interface Task {
  kind: 'preview' | 'history'
  ids: readonly string[]
  stamps: ReadonlyMap<string, number>
}

export function useFleetDetails(cache?: FleetDetailCache, options: { scopeKey?: string } = {}): FleetDetailState {
  const owned = useMemo(() => (cache === undefined ? new FleetDetailCache() : null), [cache])
  const ledger = cache ?? owned as FleetDetailCache
  const scopeKey = options.scopeKey
  const [store, setStore] = useState<DetailStore>(INITIAL_STORE)
  const desired = useRef(new Map<string, number>())
  const landedStamp = useRef(new Map<string, number>())
  const historyRequested = useRef(new Map<string, number>())
  const factsRef = useRef(new Map<string, FleetFact>())
  const countsRef = useRef(new Map<string, FleetDetailCounts>())
  const attempts = useRef(new Map<string, number>())
  const retryAt = useRef(new Map<string, number>())
  const failed = useRef(new Set<string>())
  const refreshDue = useRef(new Map<string, number>())
  const priority = useRef<ReadonlySet<string>>(new Set())
  const root = useRef<{ id: string; stamp: number } | null>(null)
  const summaryStamp = useRef(Number.NEGATIVE_INFINITY)
  const fullRequested = useRef(new Map<string, number>())
  const fullKnown = useRef(new Set<string>())
  const fullInFlight = useRef(new Set<string>())
  const mounted = useRef(true)
  const active = useRef<'preview' | 'history' | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const summaryTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const aborts = useRef(new Set<AbortController>())
  const legacy = useRef(false)

  const publish = (): void => {
    setStore(prev => ({
      summary: prev.summary,
      landed: prev.landed,
      historyLanded: prev.historyLanded,
      fullLanded: prev.fullLanded,
      pending: prev.pending,
      historyPending: prev.historyPending,
      fullPending: prev.fullPending,
      facts: prev.facts,
      family: familyOf(desired.current, landedStamp.current, factsRef.current, countsRef.current, failed.current),
    }))
  }

  const update = (change: (prev: DetailStore) => Partial<DetailStore>): void => {
    setStore((prev) => {
      const next = { ...prev, ...change(prev) }
      next.family = familyOf(desired.current, landedStamp.current, factsRef.current, countsRef.current, failed.current)
      return next
    })
  }

  const clearTimer = (): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current)
      timer.current = null
    }
  }

  const clearSummaryTimer = (): void => {
    if (summaryTimer.current !== null) {
      clearTimeout(summaryTimer.current)
      summaryTimer.current = null
    }
  }

  const arm = (delay: number): void => {
    clearTimer()
    timer.current = setTimeout(() => {
      timer.current = null
      void tick()
    }, Math.max(0, delay))
  }

  const dueOf = (kind: 'preview' | 'history', id: string): number => {
    const retry = retryAt.current.get(stampKey(kind, id, desired.current.get(id) as number))
    const refresh = refreshDue.current.get(id) ?? 0
    return Math.max(retry ?? 0, refresh)
  }

  const previewCandidates = (now: number): { id: string; stamp: number; rank: number }[] => {
    const rows: { id: string; stamp: number; rank: number }[] = []
    for (const [id, stamp] of desired.current) {
      if (id === root.current?.id) continue
      if ((landedStamp.current.get(id) ?? Number.NEGATIVE_INFINITY) >= stamp) continue
      if (failed.current.has(previewFailedKey(id, stamp))) continue
      if (dueOf('preview', id) > now) continue
      rows.push({ id, stamp, rank: priority.current.has(id) ? 0 : 1 })
    }
    rows.sort((a, b) => a.rank - b.rank || b.stamp - a.stamp || (a.id < b.id ? -1 : 1))
    return rows
  }

  const historyCandidates = (now: number): { id: string; stamp: number; rank: number }[] => {
    const rows: { id: string; stamp: number; rank: number }[] = []
    for (const [id, stamp] of desired.current) {
      const settled = landedStamp.current.get(id)
      if (settled === undefined || settled < stamp) continue
      if ((historyRequested.current.get(id) ?? Number.NEGATIVE_INFINITY) >= stamp) continue
      const fact = factsRef.current.get(id)
      if (fact === undefined || fact.updatedAt !== stamp || !fact.needsHistory) continue
      if (failed.current.has(historyFailedKey(id, stamp))) continue
      if (dueOf('history', id) > now) continue
      rows.push({ id, stamp, rank: priority.current.has(id) ? 0 : 1 })
    }
    rows.sort((a, b) => a.rank - b.rank || b.stamp - a.stamp || (a.id < b.id ? -1 : 1))
    return rows
  }

  const taskOf = (kind: 'preview' | 'history', rows: { id: string; stamp: number }[]): Task => ({
    kind,
    ids: rows.map(row => row.id),
    stamps: new Map(rows.map(row => [row.id, row.stamp])),
  })

  const nextTask = (): Task | null => {
    const now = Date.now()
    const preview = previewCandidates(now)
    if (preview.length > 0) return taskOf('preview', preview.slice(0, BATCH_SIZE))
    const history = historyCandidates(now)
    if (history.length > 0) return taskOf('history', history.slice(0, BATCH_SIZE))
    return null
  }

  const pendingWake = (): number | null => {
    const now = Date.now()
    let earliest: number | null = null
    const consider = (due: number): void => {
      const target = Math.max(due, now)
      if (earliest === null || target < earliest) earliest = target
    }
    for (const [id, stamp] of desired.current) {
      if ((landedStamp.current.get(id) ?? Number.NEGATIVE_INFINITY) >= stamp) {
        const fact = factsRef.current.get(id)
        if (fact === undefined || fact.updatedAt !== stamp || !fact.needsHistory) continue
        if ((historyRequested.current.get(id) ?? Number.NEGATIVE_INFINITY) >= stamp) continue
        if (failed.current.has(historyFailedKey(id, stamp))) continue
        consider(dueOf('history', id))
        continue
      }
      if (failed.current.has(previewFailedKey(id, stamp))) continue
      consider(dueOf('preview', id))
    }
    return earliest
  }

  const retryDelayOf = (attempt: number): number => {
    const scaled = RETRY_BASE_MS * 2 ** (attempt - 1)
    return Math.min(RETRY_MAX_MS, scaled)
  }

  const failOrRetry = (kind: 'preview' | 'history', id: string, stamp: number): void => {
    const key = stampKey(kind, id, stamp)
    const attempt = (attempts.current.get(key) ?? 0) + 1
    attempts.current.set(key, attempt)
    if (attempt >= MAX_ATTEMPTS) {
      failed.current.add(kind === 'preview' ? previewFailedKey(id, stamp) : historyFailedKey(id, stamp))
      retryAt.current.delete(key)
      return
    }
    retryAt.current.set(key, Date.now() + retryDelayOf(attempt))
  }

  const landPreview = (task: Task, batch: FleetBatch | null): void => {
    const landed = new Map<string, PayloadEntry>()
    for (const id of task.ids) {
      if (!desired.current.has(id) && id !== root.current?.id) continue
      const detail = batch?.rows.get(id)
      if (detail === undefined) continue
      landed.set(id, { detail, updatedAt: task.stamps.get(id) as number, bytes: detailBytes(detail) })
    }
    for (const [id, entry] of landed) {
      landedStamp.current.set(id, entry.updatedAt)
      attempts.current.delete(stampKey('preview', id, entry.updatedAt))
      retryAt.current.delete(stampKey('preview', id, entry.updatedAt))
      refreshDue.current.delete(id)
      const fact = factOf(entry.detail as FleetDetail, entry.updatedAt)
      factsRef.current.set(id, fact)
    }
    for (const id of task.ids) {
      if (landed.has(id)) continue
      failOrRetry('preview', id, task.stamps.get(id) as number)
    }
    trimFacts(factsRef.current)
    update((prev) => {
      const landedMap = new Map(prev.landed)
      for (const [id, entry] of landed) {
        landedMap.delete(id)
        landedMap.set(id, entry)
      }
      trimPayloads(landedMap, LANDED_MAX, LANDED_BYTES_MAX, priority.current)
      return {
        landed: landedMap,
        facts: new Map(factsRef.current),
        pending: withoutIds(prev.pending, task.ids),
      }
    })
  }

  const landHistory = (task: Task, batch: FleetBatch | null): void => {
    const landed = new Map<string, PayloadEntry>()
    for (const id of task.ids) {
      if (!desired.current.has(id) && id !== root.current?.id) continue
      const detail = batch?.rows.get(id)
      if (detail === undefined) continue
      landed.set(id, { detail, updatedAt: task.stamps.get(id) as number, bytes: detailBytes(detail) })
    }
    for (const [id, entry] of landed) {
      historyRequested.current.set(id, entry.updatedAt)
      attempts.current.delete(stampKey('history', id, entry.updatedAt))
      retryAt.current.delete(stampKey('history', id, entry.updatedAt))
    }
    for (const id of task.ids) {
      if (landed.has(id)) continue
      failOrRetry('history', id, task.stamps.get(id) as number)
    }
    update((prev) => {
      const historyMap = new Map(prev.historyLanded)
      for (const [id, entry] of landed) {
        historyMap.delete(id)
        historyMap.set(id, entry)
      }
      trimPayloads(historyMap, HISTORY_LANDED_MAX, HISTORY_BYTES_MAX, priority.current)
      return { historyLanded: historyMap, historyPending: withoutIds(prev.historyPending, task.ids) }
    })
  }

  const singlesOf = async (task: Task): Promise<FleetBatch> => {
    const rows = new Map<string, FleetDetail>()
    const missing: string[] = []
    for (let offset = 0; offset < task.ids.length; offset += 4) {
      const chunk = task.ids.slice(offset, offset + 4)
      const reads = await Promise.all(chunk.map(async (id): Promise<[string, FleetDetail | null]> => {
        const stamp = task.stamps.get(id) as number
        const detail = task.kind === 'preview' ? await ledger.fetch(id, stamp) : await ledger.fetchHistory(id, stamp)
        return [id, detail]
      }))
      for (const [id, detail] of reads) {
        if (detail === null) missing.push(id)
        else rows.set(id, detail)
      }
    }
    return { rows, missing, total: task.ids.length }
  }

  const run = async (task: Task): Promise<void> => {
    active.current = task.kind
    const controller = new AbortController()
    aborts.current.add(controller)
    update(prev => task.kind === 'preview'
      ? { pending: markPending(prev.pending, task.ids) }
      : { historyPending: markPending(prev.historyPending, task.ids) })
    let batch: FleetBatch | null
    if (legacy.current) {
      batch = await singlesOf(task)
    } else {
      try {
        batch = await ledger.fetchBatch(task.ids, task.kind, root.current?.id, controller.signal)
      } catch {
        if (controller.signal.aborted) {
          batch = null
        } else {
          legacy.current = true
          batch = await singlesOf(task)
        }
      }
    }
    aborts.current.delete(controller)
    active.current = null
    if (!mounted.current || controller.signal.aborted) return
    if (task.kind === 'preview') landPreview(task, batch)
    else landHistory(task, batch)
    schedule(0)
  }

  const tick = async (): Promise<void> => {
    /* v8 ignore next 1 */
    if (root.current === null) return
    const task = nextTask()
    /* v8 ignore next 1 */
    if (task === null) return
    await run(task)
  }

  const schedule = (delay: number): void => {
    if (!mounted.current || active.current !== null) return
    if (nextTask() !== null) {
      arm(delay)
      return
    }
    const wake = pendingWake()
    if (wake === null) {
      clearTimer()
      return
    }
    arm(Math.max(delay, wake - Date.now()))
  }

  const requestSummary = (rootId: string, rootStamp: number): void => {
    if (summaryStamp.current >= rootStamp) return
    summaryStamp.current = rootStamp
    const controller = new AbortController()
    aborts.current.add(controller)
    const landRoot = (detail: FleetDetail, summary: FleetSummary | null): void => {
      aborts.current.delete(controller)
      if (!mounted.current || controller.signal.aborted) return
      const rootEntry: PayloadEntry = { detail, updatedAt: rootStamp, bytes: detailBytes(detail) }
      landedStamp.current.set(rootId, rootStamp)
      factsRef.current.set(rootId, factOf(detail, rootStamp))
      if (summary !== null) {
        for (const id of Object.keys(summary.counts)) countsRef.current.set(id, summary.counts[id])
      }
      trimFacts(factsRef.current)
      update((prev) => {
        const landedMap = new Map(prev.landed)
        landedMap.delete(rootId)
        landedMap.set(rootId, rootEntry)
        trimPayloads(landedMap, LANDED_MAX, LANDED_BYTES_MAX, priority.current)
        return {
          ...(summary === null ? {} : { summary }),
          landed: landedMap,
          facts: new Map(factsRef.current),
          pending: withoutIds(prev.pending, [rootId]),
        }
      })
      schedule(0)
    }
    const fallback = (): void => {
      legacy.current = true
      void ledger.fetch(rootId, rootStamp).then((detail) => {
        if (!mounted.current || controller.signal.aborted) return
        if (detail === null) {
          aborts.current.delete(controller)
          summaryStamp.current = Number.NEGATIVE_INFINITY
          schedule(0)
          return
        }
        landRoot(detail, null)
      })
    }
    void ledger.fetchSummary(rootId, controller.signal).then((summary) => {
      if (summary === null) {
        fallback()
        return
      }
      landRoot(summary.detail, summary)
    }, fallback)
  }

  const requestFamily = (request: FleetFamilyRequest): void => {
    if (request.rootId === '') return
    root.current = { id: request.rootId, stamp: request.rootStamp }
    priority.current = request.priority ?? new Set()
    const next = new Map<string, number>()
    for (const entry of request.entries) next.set(entry.id, entry.updatedAt)
    let changed = desired.current.size !== next.size
    for (const [id, stamp] of next) {
      if (desired.current.get(id) !== stamp) {
        changed = true
        break
      }
    }
    for (const [id, stamp] of next) {
      const previous = desired.current.get(id)
      const settled = landedStamp.current.get(id)
      if (previous === undefined || stamp > previous) {
        if (settled !== undefined && settled < stamp) refreshDue.current.set(id, Date.now() + REFRESH_DELAY_MS)
        attempts.current.delete(stampKey('preview', id, stamp))
        failed.current.delete(previewFailedKey(id, stamp))
      }
    }
    desired.current = next
    for (const key of [...retryAt.current.keys()]) {
      if (staleStampKey(key, next)) retryAt.current.delete(key)
    }
    for (const key of [...attempts.current.keys()]) {
      if (staleStampKey(key, next)) attempts.current.delete(key)
    }
    for (const key of [...failed.current]) {
      if (staleStampKey(key.replace('@', ':'), next)) failed.current.delete(key)
    }
    recordCounts()
    if (summaryStamp.current > Number.NEGATIVE_INFINITY) {
      clearSummaryTimer()
      summaryTimer.current = setTimeout(() => {
        summaryTimer.current = null
        requestSummary(request.rootId, request.rootStamp)
      }, REFRESH_DELAY_MS)
    } else {
      requestSummary(request.rootId, request.rootStamp)
    }
    if (changed) publish()
    schedule(0)
  }

  const recordCounts = (): void => {
    const known = new Set([...factsRef.current.keys(), ...countsRef.current.keys()])
    for (const id of known) {
      if (desired.current.has(id) || id === root.current?.id) continue
      factsRef.current.delete(id)
      countsRef.current.delete(id)
    }
  }

  const requestFull = (id: string): void => {
    const stamp = desired.current.get(id) ?? 0
    const known = fullRequested.current.get(id)
    if (known !== undefined && known >= stamp && (fullKnown.current.has(id) || fullInFlight.current.has(id))) return
    fullRequested.current.set(id, stamp)
    fullInFlight.current.add(id)
    update(prev => ({ fullPending: markPending(prev.fullPending, [id]) }))
    void ledger.fetch(id, stamp, true).then((detail) => {
      if (!mounted.current || fullRequested.current.get(id) !== stamp) return
      fullInFlight.current.delete(id)
      if (detail === null) {
        fullRequested.current.delete(id)
        update(prev => ({ fullPending: withoutIds(prev.fullPending, [id]) }))
        return
      }
      update((prev) => {
        const fullLanded = new Map(prev.fullLanded)
        fullLanded.delete(id)
        fullLanded.set(id, detail)
        lruTrim(fullLanded, FULL_STATE_MAX)
        fullKnown.current = new Set([...fullLanded.keys()].filter(key => fullLanded.get(key) !== null))
        return {
          fullLanded,
          fullPending: withoutIds(prev.fullPending, [id]),
        }
      })
    })
  }

  const prioritize = (id: string): void => {
    const next = new Set(priority.current)
    next.delete(id)
    next.add(id)
    while (next.size > PRIORITY_MAX) next.delete(next.values().next().value as string)
    priority.current = next
    schedule(0)
  }

  const retryFamily = (): void => {
    for (const key of [...failed.current]) failed.current.delete(key)
    attempts.current.clear()
    retryAt.current.clear()
    summaryStamp.current = Number.NEGATIVE_INFINITY
    for (const id of landedStamp.current.keys()) refreshDue.current.delete(id)
    const currentRoot = root.current
    if (currentRoot !== null) requestSummary(currentRoot.id, currentRoot.stamp)
    schedule(0)
  }

  useEffect(() => subscribeInvalidations((event) => {
    if (event.kind !== 'fleet') return
    if (event.sessionId !== undefined && event.sessionId !== root.current?.id) return
    summaryStamp.current = Number.NEGATIVE_INFINITY
    for (const id of desired.current.keys()) landedStamp.current.delete(id)
    const currentRoot = root.current
    if (currentRoot !== null) requestSummary(currentRoot.id, currentRoot.stamp)
    schedule(0)
  }), [])

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimer()
      clearSummaryTimer()
      for (const controller of aborts.current) controller.abort()
      aborts.current.clear()
    }
  }, [])

  useEffect(() => {
    desired.current = new Map()
    landedStamp.current = new Map()
    historyRequested.current = new Map()
    factsRef.current = new Map()
    countsRef.current = new Map()
    attempts.current = new Map()
    retryAt.current = new Map()
    failed.current = new Set()
    refreshDue.current = new Map()
    priority.current = new Set()
    root.current = null
    legacy.current = false
    summaryStamp.current = Number.NEGATIVE_INFINITY
    fullRequested.current.clear()
    fullKnown.current = new Set()
    fullInFlight.current.clear()
    clearTimer()
    clearSummaryTimer()
    for (const controller of aborts.current) controller.abort()
    aborts.current.clear()
    owned?.clear()
    ledger.clear()
    setStore(INITIAL_STORE)
  }, [scopeKey])

  return {
    ...store,
    landed: store.landed,
    historyLanded: store.historyLanded,
    requestFamily,
    requestFull,
    prioritize,
    retryFamily,
  }
}

function withoutIds(set: ReadonlySet<string>, ids: readonly string[]): Set<string> {
  const next = new Set(set)
  for (const id of ids) next.delete(id)
  return next
}

function previewFailedKey(id: string, stamp: number): string {
  return `preview:${id}@${stamp}`
}

function historyFailedKey(id: string, stamp: number): string {
  return `history:${id}@${stamp}`
}
