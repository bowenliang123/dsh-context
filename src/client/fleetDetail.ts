import type { FleetDelegation, FleetDetail, FleetDescriptor, FleetMemberInfo, FleetMessage } from '../shared/types'
import { FLEET_ROUTE } from './apiRoutes'
import { asRecord, numOf } from './services'
import { lruTouch, lruTrim } from './lru'

function strings(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function descriptorOf(value: unknown): FleetDescriptor | undefined {
  const rec = asRecord(value)
  if (rec === null) return undefined
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return undefined
  const out: FleetDescriptor = { mode: rec.mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    const v = strings(rec[key])
    if (v !== undefined) out[key] = v
  }
  return out
}

function messageOf(value: unknown): FleetMessage | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (rec.kind !== 'relay' && rec.kind !== 'mailbox' && rec.kind !== 'settled') return null
  const text = strings(rec.text)
  if (text === undefined) return null
  const from = strings(rec.from)
  const fromName = strings(rec.fromName)
  const summary = strings(rec.summary)
  const report = strings(rec.report)
  const structured = strings(rec.structured)
  const diagnostic = strings(rec.diagnostic)
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
  const name = strings(rec.name)
  if (name === undefined) return null
  const provider = strings(rec.provider)
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
  const to = strings(rec.to)
  if (to === undefined) return null
  const mode = rec.mode
  if (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'external') return null
  const label = strings(rec.label)
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
  const initialPrompt = strings(rec.initialPrompt)
  const reply = asRecord(rec.lastReply)
  const replyText = reply === null ? undefined : strings(reply.text)
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

export function makeFleetDetailFetcher(
  sessionId: string,
  full = false,
  history = false,
): (() => Promise<FleetDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(FLEET_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...(full ? { full: true } : {}), ...(history ? { history: true } : {}), sessionId }),
    })
    if (!response.ok) throw new Error(`dsh-context: fleet route HTTP ${response.status}`)
    const r = asRecord(await response.json())
    if (r === null || r.ok !== true) throw new Error('dsh-context: fleet read failed')
    if (r.value === null) return null
    const detail = fleetDetailOf(r.value)
    if (detail === null) throw new Error('dsh-context: fleet read malformed')
    return detail
  }
}

interface FleetDetailEntry {
  updatedAt: number
  pending: Promise<FleetDetail | null>
  size: number
}

const FLEET_LEDGER_MAX = 64
const FULL_LEDGER_MAX = 4
const LEDGER_BYTES_MAX = 4 * 1024 * 1024

function detailBytes(detail: FleetDetail | null): number {
  if (detail === null) return 0
  let bytes = (detail.initialPrompt?.length ?? 0) + (detail.lastReply?.text.length ?? 0)
  for (const message of detail.messages) bytes += message.text.length + (message.report?.length ?? 0) + (message.summary?.length ?? 0)
  return bytes
}

export class FleetDetailCache {
  private readonly entries = new Map<string, FleetDetailEntry>()
  private readonly fullEntries = new Map<string, FleetDetailEntry>()
  private readonly historyEntries = new Map<string, FleetDetailEntry>()

  clear(): void {
    this.entries.clear()
    this.fullEntries.clear()
    this.historyEntries.clear()
  }

  fetch(id: string, updatedAt: number, full = false): Promise<FleetDetail | null> {
    const ledger = full ? this.fullEntries : this.entries
    const known = ledger.get(id)
    if (known !== undefined && known.updatedAt >= updatedAt) {
      lruTouch(ledger, id)
      return known.pending
    }
    const fetcher = makeFleetDetailFetcher(id, full)
    const pending = fetcher !== undefined
      ? fetcher().catch((): FleetDetail | null => null)
      : Promise.resolve(null)
    const entry: FleetDetailEntry = { updatedAt, pending, size: 0 }
    ledger.set(id, entry)
    void pending.then((detail) => {
      entry.size = detailBytes(detail)
      this.trim(ledger, full ? FULL_LEDGER_MAX : FLEET_LEDGER_MAX)
    })
    this.trim(ledger, full ? FULL_LEDGER_MAX : FLEET_LEDGER_MAX)
    return pending
  }

  fetchHistory(id: string, updatedAt: number): Promise<FleetDetail | null> {
    const known = this.historyEntries.get(id)
    if (known !== undefined && known.updatedAt >= updatedAt) {
      lruTouch(this.historyEntries, id)
      return known.pending
    }
    const fetcher = makeFleetDetailFetcher(id, false, true)
    const pending = fetcher !== undefined
      ? fetcher().catch((): FleetDetail | null => null)
      : Promise.resolve(null)
    const entry: FleetDetailEntry = { updatedAt, pending, size: 0 }
    this.historyEntries.set(id, entry)
    void pending.then((detail) => {
      entry.size = detailBytes(detail)
      this.trim(this.historyEntries, FLEET_LEDGER_MAX)
    })
    this.trim(this.historyEntries, FLEET_LEDGER_MAX)
    return pending
  }

  private trim(ledger: Map<string, FleetDetailEntry>, max: number): void {
    lruTrim(ledger, max)
    let total = 0
    for (const entry of ledger.values()) total += entry.size
    if (total <= LEDGER_BYTES_MAX) return
    for (const [key, entry] of ledger) {
      if (total <= LEDGER_BYTES_MAX || ledger.size <= 1) return
      ledger.delete(key)
      total -= entry.size
    }
  }
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
