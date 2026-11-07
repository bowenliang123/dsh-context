import type { FleetDelegation, FleetDetail, FleetDescriptor, FleetMemberInfo, FleetMessage } from '../shared/types'
import { FLEET_ROUTE } from './apiRoutes'
import { BoundedCache } from './boundedCache'
import { postRoute } from './route'
import { asRecord, numOf } from './services'
import { stringOf } from '../shared/decode'

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

function ledgerOf(maxEntries: number): BoundedCache<string, FleetDetailEntry> {
  return new BoundedCache<string, FleetDetailEntry>({
    maxEntries,
    maxBytes: LEDGER_BYTES_MAX,
    minEntries: 1,
    sizeOf: entry => entry.size,
  })
}

export class FleetDetailCache {
  private readonly entries = ledgerOf(FLEET_LEDGER_MAX)
  private readonly fullEntries = ledgerOf(FULL_LEDGER_MAX)
  private readonly historyEntries = ledgerOf(FLEET_LEDGER_MAX)

  clear(): void {
    this.entries.clear()
    this.fullEntries.clear()
    this.historyEntries.clear()
  }

  fetch(id: string, updatedAt: number, full = false): Promise<FleetDetail | null> {
    const ledger = full ? this.fullEntries : this.entries
    const known = ledger.get(id)
    if (known !== undefined && known.updatedAt >= updatedAt) return known.pending
    const fetcher = makeFleetDetailFetcher(id, full)
    const pending = fetcher !== undefined
      ? fetcher().catch((): FleetDetail | null => null)
      : Promise.resolve(null)
    const entry: FleetDetailEntry = { updatedAt, pending, size: 0 }
    ledger.set(id, entry)
    void pending.then((detail) => {
      entry.size = detailBytes(detail)
      ledger.trim()
    })
    return pending
  }

  fetchHistory(id: string, updatedAt: number): Promise<FleetDetail | null> {
    const known = this.historyEntries.get(id)
    if (known !== undefined && known.updatedAt >= updatedAt) return known.pending
    const fetcher = makeFleetDetailFetcher(id, false, true)
    const pending = fetcher !== undefined
      ? fetcher().catch((): FleetDetail | null => null)
      : Promise.resolve(null)
    const entry: FleetDetailEntry = { updatedAt, pending, size: 0 }
    this.historyEntries.set(id, entry)
    void pending.then((detail) => {
      entry.size = detailBytes(detail)
      this.historyEntries.trim()
    })
    return pending
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
