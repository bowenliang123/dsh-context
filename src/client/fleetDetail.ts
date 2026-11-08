import type {
  FleetDelegation,
  FleetDetail,
  FleetDetailCounts,
  FleetDescriptor,
  FleetMemberInfo,
  FleetMessage,
  FleetSummary,
  FleetSummaryMember,
} from '../shared/types'
import { stringOf } from '../shared/decode'
import { FLEET_ROUTE } from './apiRoutes'
import { postRoute } from './route'
import { asRecord, numOf } from './services'

function descriptorOf(value: unknown): FleetDescriptor | undefined {
  const rec = asRecord(value)
  if (rec === null) return undefined
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return undefined
  const out: FleetDescriptor = { mode: rec.mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    const v = stringOf(rec[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

function messageOf(value: unknown): FleetMessage | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (rec.kind !== 'relay' && rec.kind !== 'mailbox' && rec.kind !== 'settled') return null
  const text = stringOf(rec.text)
  if (text === undefined) return null
  const from = stringOf(rec.from)
  const fromName = stringOf(rec.fromName)
  const summary = stringOf(rec.summary)
  const report = stringOf(rec.report)
  const structured = stringOf(rec.structured)
  const diagnostic = stringOf(rec.diagnostic)
  return {
    seq: numOf(rec.seq),
    time: numOf(rec.time),
    kind: rec.kind,
    ...(from !== undefined ? { from } : {}),
    ...(fromName !== undefined ? { fromName } : {}),
    text,
    ...(rec.clipped === true ? { clipped: true } : {}),
    ...(summary !== undefined ? { summary } : {}),
    ...(report !== undefined ? { report } : {}),
    ...(structured !== undefined ? { structured } : {}),
    ...(diagnostic !== undefined ? { diagnostic } : {}),
  }
}

function rosterMemberOf(value: unknown): FleetMemberInfo | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const name = stringOf(rec.name)
  if (name === undefined) return null
  const provider = stringOf(rec.provider)
  return {
    name,
    description: typeof rec.description === 'string' ? rec.description : '',
    ...(provider !== undefined ? { provider } : {}),
    ...(rec.context === 'fresh' || rec.context === 'fork' ? { context: rec.context } : {}),
  }
}

function delegationOf(value: unknown): FleetDelegation | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const to = stringOf(rec.to)
  if (to === undefined) return null
  const mode = rec.mode
  if (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'external' && mode !== 'unknown') return null
  const label = stringOf(rec.label)
  return {
    seq: numOf(rec.seq),
    time: numOf(rec.time),
    to,
    mode,
    ...(label !== undefined ? { label } : {}),
  }
}

export function fleetDetailOf(value: unknown): FleetDetail | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const messages: FleetMessage[] = []
  if (Array.isArray(rec.messages)) {
    for (const entry of rec.messages) {
      const message = messageOf(entry)
      if (message !== null) messages.push(message)
    }
  }
  const descriptor = descriptorOf(rec.descriptor)
  const initialPrompt = stringOf(rec.initialPrompt)
  const reply = asRecord(rec.lastReply)
  const replyText = reply === null ? undefined : stringOf(reply.text)
  const roster: FleetMemberInfo[] = []
  if (Array.isArray(rec.roster)) {
    for (const entry of rec.roster) {
      const member = rosterMemberOf(entry)
      if (member !== null) roster.push(member)
    }
  }
  const delegations: FleetDelegation[] = []
  if (Array.isArray(rec.delegations)) {
    for (const entry of rec.delegations) {
      const delegation = delegationOf(entry)
      if (delegation !== null) delegations.push(delegation)
    }
  }
  return {
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(replyText !== undefined ? { lastReply: { time: numOf(reply?.time), text: replyText } } : {}),
    ...(roster.length > 0 ? { roster } : {}),
    ...(delegations.length > 0 ? { delegations } : {}),
    messages,
    ...(numOf(rec.messagesTotal) > messages.length ? { messagesTotal: numOf(rec.messagesTotal) } : {}),
    truncated: rec.truncated === true,
  }
}

function summaryMemberOf(value: unknown): FleetSummaryMember | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const id = stringOf(rec.id)
  if (id === undefined) return null
  const createdAt = typeof rec.createdAt === 'number' && Number.isFinite(rec.createdAt) ? rec.createdAt : undefined
  const mode = rec.mode
  const label = stringOf(rec.label)
  const name = stringOf(rec.name)
  const description = stringOf(rec.description)
  const phase = stringOf(rec.phase)
  return {
    id,
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(mode === 'one-shot' || mode === 'continuable' || mode === 'external' || mode === 'unknown' ? { mode } : {}),
    ...(label !== undefined ? { label } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    ...(phase !== undefined ? { phase } : {}),
  }
}

function countsOf(value: unknown): FleetDetailCounts | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const readAt = rec.readAt
  const messagesTotal = rec.messagesTotal
  const delegationsCount = rec.delegationsCount
  if (typeof readAt !== 'number' || !Number.isFinite(readAt)) return null
  if (typeof messagesTotal !== 'number' || !Number.isFinite(messagesTotal) || messagesTotal < 0) return null
  if (typeof delegationsCount !== 'number' || !Number.isFinite(delegationsCount) || delegationsCount < 0) return null
  return { readAt, messagesTotal, delegationsCount }
}

export function fleetSummaryOf(value: unknown): FleetSummary | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const rootId = stringOf(rec.rootId)
  const detail = fleetDetailOf(rec.detail)
  if (rootId === undefined || detail === null) return null
  const members: FleetSummaryMember[] = []
  if (Array.isArray(rec.members)) {
    for (const entry of rec.members) {
      const member = summaryMemberOf(entry)
      if (member !== null) members.push(member)
    }
  }
  const counts: Record<string, FleetDetailCounts> = {}
  const rawCounts = asRecord(rec.counts)
  if (rawCounts !== null) {
    for (const id of Object.keys(rawCounts)) {
      const known = countsOf(rawCounts[id])
      if (known !== null) counts[id] = known
    }
  }
  const rootCreatedAt = typeof rec.rootCreatedAt === 'number' && Number.isFinite(rec.rootCreatedAt) ? rec.rootCreatedAt : undefined
  const familySize = typeof rec.familySize === 'number' && Number.isFinite(rec.familySize) ? rec.familySize : members.length + 1
  return {
    rootId,
    ...(rootCreatedAt === undefined ? {} : { rootCreatedAt }),
    detail,
    members,
    familySize,
    counts,
  }
}

export interface FleetBatch {
  rows: ReadonlyMap<string, FleetDetail>
  missing: readonly string[]
  total: number
}

export function fleetBatchOf(value: unknown): FleetBatch | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const rawRows = asRecord(rec.rows)
  if (rawRows === null) return null
  const rows = new Map<string, FleetDetail>()
  for (const id of Object.keys(rawRows)) {
    if (id === '') continue
    const detail = fleetDetailOf(rawRows[id])
    if (detail !== null) rows.set(id, detail)
  }
  const missing: string[] = []
  if (Array.isArray(rec.missing)) {
    for (const entry of rec.missing) {
      const id = stringOf(entry)
      if (id !== undefined) missing.push(id)
    }
  }
  const total = typeof rec.total === 'number' && Number.isFinite(rec.total) ? rec.total : rows.size + missing.length
  return { rows, missing, total }
}

export function makeFleetDetailFetcher(
  sessionId: string,
  full = false,
  history = false,
): (() => Promise<FleetDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(
    FLEET_ROUTE,
    { ...(full ? { full: true } : {}), ...(history ? { history: true } : {}), sessionId },
    fleetDetailOf,
    { label: 'fleet' },
  )
}

export function makeFleetSummaryFetcher(
  sessionId: string,
  signal?: AbortSignal,
): (() => Promise<FleetSummary | null>) | undefined {
  if (sessionId === '') return undefined
  return () => postRoute(
    FLEET_ROUTE,
    { sessionId, summary: true },
    fleetSummaryOf,
    { label: 'fleet-summary', ...(signal === undefined ? {} : { signal }) },
  )
}

export function makeFleetBatchFetcher(
  ids: readonly string[],
  mode: 'preview' | 'history',
  rootId?: string,
  signal?: AbortSignal,
): (() => Promise<FleetBatch | null>) | undefined {
  if (ids.length === 0) return undefined
  return () => postRoute(
    FLEET_ROUTE,
    { batch: { ids: [...ids], mode, ...(rootId === undefined ? {} : { rootId }) } },
    fleetBatchOf,
    { label: 'fleet-batch', ...(signal === undefined ? {} : { signal }) },
  )
}

export class FleetDetailCache {
  private readonly inflight = new Map<string, Promise<unknown>>()

  clear(): void {
    this.inflight.clear()
  }

  private track<T>(key: string, fetcher: (() => Promise<T | null>) | undefined): Promise<T | null> {
    const known = this.inflight.get(key) as Promise<T | null> | undefined
    if (known !== undefined) return known
    const pending: Promise<T | null> = fetcher !== undefined ? fetcher() : Promise.resolve(null)
    this.inflight.set(key, pending)
    void pending.finally(() => {
      if (this.inflight.get(key) === pending) this.inflight.delete(key)
    }).catch(() => {})
    return pending
  }

  fetch(id: string, updatedAt: number, full = false): Promise<FleetDetail | null> {
    return this.track(`${full ? 'full' : 'preview'}:${id}:${updatedAt}`, makeFleetDetailFetcher(id, full))
      .catch((): FleetDetail | null => null)
  }

  fetchHistory(id: string, updatedAt: number): Promise<FleetDetail | null> {
    return this.track(`history:${id}:${updatedAt}`, makeFleetDetailFetcher(id, false, true))
      .catch((): FleetDetail | null => null)
  }

  fetchSummary(sessionId: string, signal?: AbortSignal): Promise<FleetSummary | null> {
    return this.track(`summary:${sessionId}`, makeFleetSummaryFetcher(sessionId, signal))
  }

  fetchBatch(
    ids: readonly string[],
    mode: 'preview' | 'history',
    rootId?: string,
    signal?: AbortSignal,
  ): Promise<FleetBatch | null> {
    return this.track(`batch:${mode}:${ids.join(',')}`, makeFleetBatchFetcher(ids, mode, rootId, signal))
  }
}

export function detailBytes(detail: FleetDetail | null): number {
  if (detail === null) return 0
  let bytes = (detail.initialPrompt?.length ?? 0) + (detail.lastReply?.text.length ?? 0)
  for (const message of detail.messages) bytes += message.text.length + (message.report?.length ?? 0) + (message.summary?.length ?? 0)
  for (const delegation of detail.delegations ?? []) bytes += delegation.label?.length ?? 0
  for (const member of detail.roster ?? []) bytes += member.name.length + member.description.length
  return bytes
}

export interface CommsRow extends FleetMessage {
  key: string
  to: string
}

export interface FleetDelegationRow extends FleetDelegation {
  key: string
  from: string
}

export function mergeDelegations(details: ReadonlyMap<string, FleetDetail>): FleetDelegationRow[] {
  const rows: FleetDelegationRow[] = []
  for (const [from, detail] of details) {
    for (const delegation of detail.delegations ?? []) {
      rows.push({ ...delegation, key: `${from}:${delegation.seq}:${delegation.to}`, from })
    }
  }
  return rows
}

export type SettledVariant = 'finished' | 'finishedFinal' | 'stopped' | 'outOfRoom' | 'declined' | 'failed'

export function settledVariantOf(text: string): SettledVariant | null {
  const summary = text.trim()
  if (summary.endsWith('finished and will do no further work unless you send it more.')) return 'finished'
  if (summary.endsWith('finished. It cannot receive follow-up messages.')) return 'finishedFinal'
  if (summary.endsWith('was stopped before it finished.')) return 'stopped'
  if (summary.endsWith('ran out of room before it finished.')) return 'outOfRoom'
  if (summary.endsWith('declined the task.')) return 'declined'
  if (summary.endsWith('failed before it finished.')) return 'failed'
  return null
}

export function mergeComms(details: ReadonlyMap<string, FleetDetail>): CommsRow[] {
  const rows: CommsRow[] = []
  for (const [to, detail] of details) {
    for (const message of detail.messages) {
      rows.push({ ...message, key: `${to}:${message.seq}:${message.time}:${message.kind}`, to })
    }
  }
  rows.sort((a, b) => (b.time - a.time) || (a.key < b.key ? -1 : 1))
  return rows
}
