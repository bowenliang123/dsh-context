/**
 * The client half of the Fleet detail route (`/api/dsh-context/fleet`, host/fleet.ts): a
 * sanitizing fetcher, a page-scope promise ledger keyed by session id, and the cross-session
 * merge that turns per-session message lists into the comms panel's timeline.
 *
 * One in-flight-or-settled read per session at the row's latest `updatedAt`: a session that
 * moved since its read landed refetches once, so a pinned agent's inspector tracks its live log
 * without polling, and a broken session never retries per render.
 */

import type { FleetDetail, FleetDescriptor, FleetMemberInfo, FleetMessage } from '../shared/types'
import { asRecord, numOf } from './services'

// The route of host/fleet.ts, re-declared here: the client bundle inlines every import and the
// host module must never reach it.
const FLEET_ROUTE = '/api/dsh-context/fleet'

function strings(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function descriptorOf(value: unknown): FleetDescriptor | undefined {
  const rec = asRecord(value)
  if (rec === null) return undefined
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return undefined
  const out: FleetDescriptor = { mode: rec.mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'persona'] as const) {
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
  return {
    seq: numOf(rec.seq),
    time: numOf(rec.time),
    kind: rec.kind,
    ...(from !== undefined ? { from } : {}),
    ...(fromName !== undefined ? { fromName } : {}),
    text,
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

/** Narrow the route's payload; a record failing the wire shape degrades to null (the caller's
 * absence path), and malformed entries drop alone. */
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
  return {
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(replyText !== undefined ? { lastReply: { time: numOf(reply?.time), text: replyText } } : {}),
    ...(roster.length > 0 ? { roster } : {}),
    messages,
    truncated: rec.truncated === true,
  }
}

/** The route reader; failures and malformed payloads reject so the caller arms its retry. */
export function makeFleetDetailFetcher(
  sessionId: string,
): (() => Promise<FleetDetail | null>) | undefined {
  if (sessionId === '') return undefined
  return async () => {
    const response = await fetch(FLEET_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId }),
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
}

/** The page-scope read ledger. `fetch` dedupes per (id, updatedAt): same stamp returns the same
 * promise, a NEWER stamp refetches once, and a settled failure stays cached so a broken session
 * never hammers the route per render. */
export class FleetDetailCache {
  private readonly entries = new Map<string, FleetDetailEntry>()

  fetch(id: string, updatedAt: number): Promise<FleetDetail | null> {
    const known = this.entries.get(id)
    if (known !== undefined && known.updatedAt >= updatedAt) return known.pending
    const fetcher = makeFleetDetailFetcher(id)
    const pending = fetcher !== undefined
      ? fetcher().catch((): FleetDetail | null => null)
      : Promise.resolve(null)
    this.entries.set(id, { updatedAt, pending })
    return pending
  }

  /** Drop one session's ledger line so the next `fetch` reads again (the comms panel's refresh). */
  invalidate(id: string): void {
    this.entries.delete(id)
  }
}

/** One merged comms row: a message lifted from session `to`'s log, attributed to `from`. */
export interface CommsRow {
  /** seq is per-session, so the key pairs it with the log owner. */
  key: string
  to: string
  time: number
  kind: FleetMessage['kind']
  from?: string
  fromName?: string
  text: string
}

/** The runtime's settled-notice vocabulary (dsh's settlementSummary), for localized rendering. */
export type SettledVariant = 'finished' | 'finishedFinal' | 'stopped' | 'outOfRoom' | 'declined' | 'failed'

/** Classify a `subagent-settled` notice's English summary; null = an unrecognized (future) phrasing. */
export function settledVariantOf(text: string): SettledVariant | null {
  if (text.endsWith('finished and will do no further work unless you send it more.')) return 'finished'
  if (text.endsWith('finished. It cannot receive follow-up messages.')) return 'finishedFinal'
  if (text.endsWith('was stopped before it finished.')) return 'stopped'
  if (text.endsWith('ran out of room before it finished.')) return 'outOfRoom'
  if (text.endsWith('declined the task.')) return 'declined'
  if (text.endsWith('failed before it finished.')) return 'failed'
  return null
}

/** Merge every landed session detail's messages into one newest-first timeline. */
export function mergeComms(details: ReadonlyMap<string, FleetDetail>): CommsRow[] {
  const rows: CommsRow[] = []
  for (const [to, detail] of details) {
    for (const message of detail.messages) {
      rows.push({
        key: `${to}:${message.seq}`,
        to,
        time: message.time,
        kind: message.kind,
        ...(message.from !== undefined ? { from: message.from } : {}),
        ...(message.fromName !== undefined ? { fromName: message.fromName } : {}),
        text: message.text,
      })
    }
  }
  rows.sort((a, b) => (b.time - a.time) || (a.key < b.key ? -1 : 1))
  return rows
}
