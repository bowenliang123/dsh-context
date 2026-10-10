/**
 * The Fleet detail route (`/api/dsh-context/fleet`) — per-session agent color that no projection
 * carries: the delegation prompt, the durable `subagent/descriptor` composition, and the
 * inter-agent traffic the session's own log attests (team relays addressed to it, historical
 * mailbox deliveries, and — in a parent's log — the runtime's accounts of children settling).
 *
 * Same transport and posture as the detail route (detail.ts): Connection's exact Fetch-route
 * registry behind the authenticated `/api` fence, the durable log read through
 * `ctx.sessionQuery.observeSession` (live-preferred, so one code path serves live and cold
 * sessions alike), and every read admitted by the shared cold-read gate. Extraction is
 * display-only and total: unknown event types and malformed payloads drop whole, never throw.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { FleetDescriptor, FleetDetail, FleetMemberInfo, FleetMessage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'

/** The plugin's fleet route, under the authenticated `/api` fence. */
export const FLEET_ROUTE = '/api/dsh-context/fleet'

/** Payload caps: the route serves inspector excerpts, not transcripts. */
const MESSAGES_MAX = 40
const MESSAGE_TEXT_MAX = 400
const PROMPT_TEXT_MAX = 1600
const REPLY_TEXT_MAX = 300

interface SessionQueryFace {
  observeSession?(id: string, options: unknown): Promise<unknown>
}

function reply(value: unknown): Response {
  return Response.json(value, { headers: { 'cache-control': 'no-store' } })
}

function failure(code: string, message: string): Response {
  return reply({ ok: false, error: { code, message } })
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    const text = asRecord(block)?.text
    if (typeof text === 'string') out += text
  }
  return out
}

/** A teammate briefing opens with an injected `<system-reminder>` framing block; the excerpt drops it. */
const REMINDER_PREFIX = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max) + '…', cut: true } : { text, cut: false }
}

/** The descriptor's display fields off one `subagent/descriptor` payload; null unless the mode reads clean. */
function descriptorOf(data: Record<string, unknown>): FleetDescriptor | null {
  const mode = data.mode
  if (mode !== 'one-shot' && mode !== 'continuable') return null
  const out: FleetDescriptor = { mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'persona'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

/** The mailbox generation stamps each delivery with a transport preamble; the excerpt drops it. */
const MAILBOX_PREFIX = /^Team message \S+ from [^:]{1,64}:\s*/
/** Relay deliveries open with a sender-framing block ("Agent <id> sent a message: " / "Team
 * message from <name>:"); the excerpt drops it — the UI labels the parties itself. */
const RELAY_PREFIX = /^(?:Agent \S+ sent a message: |Team message from [^:\n]{1,64}:\s*)/

/** One user/message event → one inter-agent message, or null when the event is none. */
function messageOf(seq: number, time: number, data: Record<string, unknown>): FleetMessage | null {
  const source = asRecord(data.source)
  const kind = source?.kind
  let message: FleetMessage | null = null
  if (kind === 'agent-message' || kind === 'team-message') {
    let text = textOfContent(data.content)
    text = text.replace(kind === 'team-message' ? MAILBOX_PREFIX : RELAY_PREFIX, '')
    if (text.trim() === '') return null
    message = {
      seq,
      time,
      kind: kind === 'agent-message' ? 'relay' : 'mailbox',
      text,
    }
    const from = kind === 'agent-message' ? source?.senderSessionId : source?.senderId
    if (typeof from === 'string' && from !== '') message.from = from
    const fromName = source?.senderName
    if (typeof fromName === 'string' && fromName !== '') message.fromName = fromName
  } else if (kind === 'subagent-settled') {
    const summary = source?.summary
    const text = typeof summary === 'string' && summary.trim() !== '' ? summary : textOfContent(data.content)
    if (text.trim() === '') return null
    message = { seq, time, kind: 'settled', text }
    const from = source?.senderSessionId
    if (typeof from === 'string' && from !== '') message.from = from
  }
  if (message === null) return null
  const cut = clip(message.text, MESSAGE_TEXT_MAX)
  message.text = cut.text
  return message
}

/** Whether a user/message is a plain prompt (human-typed or a delegation's initial delivery, both
 * attributed `kind: 'user'` or unattributed) rather than injected context or agent traffic. */
function isPlainPrompt(source: Record<string, unknown> | null): boolean {
  if (source === null) return true
  return source.kind === 'user'
}

/** The roster facts of one `team/member` record (a lead-log event), or null when unsound. */
function rosterMemberOf(data: Record<string, unknown>): FleetMemberInfo | null {
  const member = asRecord(data.member)
  if (member === null) return null
  if (typeof member.name !== 'string' || member.name === '') return null
  const out: FleetMemberInfo = {
    name: member.name,
    description: typeof member.description === 'string' ? member.description : '',
  }
  if (typeof member.provider === 'string' && member.provider !== '') out.provider = member.provider
  if (member.context === 'fresh' || member.context === 'fork') out.context = member.context
  return out
}

/** The newest assistant text of the log — the agent's latest report-back. */
function lastReplyOf(events: readonly unknown[]): { time: number; text: string; cut: boolean } | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = asRecord(events[i])
    if (ev === null || ev.type !== 'assistant/message') continue
    const message = asRecord(asRecord(ev.data)?.message)
    const content = message?.content
    if (!Array.isArray(content)) continue
    let text = ''
    for (const block of content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    }
    if (text.trim() === '') continue
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const cut = clip(text, REPLY_TEXT_MAX)
    return { time, text: cut.text, cut: cut.cut }
  }
  return null
}

/** Fold one session's durable events into its Fleet detail. Total over hostile input: any
 * malformed entry drops alone. */
export function fleetDetailOfEvents(events: readonly unknown[]): FleetDetail {
  let descriptor: FleetDescriptor | undefined
  let initialPrompt: string | undefined
  let truncated = false
  const messages: FleetMessage[] = []
  const roster = new Map<string, FleetMemberInfo>()
  for (const entry of events) {
    const ev = asRecord(entry)
    if (ev === null) continue
    const type = ev.type
    if (typeof type !== 'string') continue
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const data = asRecord(ev.data)
    if (data === null) continue
    if (type === 'subagent/descriptor') {
      // Last wins: a fork seed replays the ancestor's descriptor before the child's own.
      const next = descriptorOf(data)
      if (next !== null) descriptor = next
      continue
    }
    if (type === 'team/member') {
      // The whole roster row rewrites per lifecycle step; the latest record's facts stand.
      const member = rosterMemberOf(data)
      if (member !== null) roster.set(member.name, member)
      continue
    }
    if (type !== 'user/message') continue
    const message = messageOf(seq, time, data)
    if (message !== null) {
      if (message.text.endsWith('…')) truncated = true
      messages.push(message)
      continue
    }
    if (initialPrompt === undefined && isPlainPrompt(asRecord(data.source))) {
      const text = textOfContent(data.content).replace(REMINDER_PREFIX, '')
      if (text.trim() !== '') {
        const cut = clip(text, PROMPT_TEXT_MAX)
        initialPrompt = cut.text
        if (cut.cut) truncated = true
      }
    }
  }
  // Newest first; the cap keeps the payload an excerpt.
  messages.sort((a, b) => b.seq - a.seq)
  if (messages.length > MESSAGES_MAX) {
    messages.length = MESSAGES_MAX
    truncated = true
  }
  const reply = lastReplyOf(events)
  if (reply !== null && reply.cut) truncated = true
  return {
    ...(descriptor !== undefined ? { descriptor } : {}),
    ...(initialPrompt !== undefined ? { initialPrompt } : {}),
    ...(reply !== null ? { lastReply: { time: reply.time, text: reply.text } } : {}),
    ...(roster.size > 0 ? { roster: [...roster.values()] } : {}),
    messages,
    truncated,
  }
}

/** Serve the fleet route whenever the connection service is composed (the detail route's own
 * posture); sessionQuery is re-read per request so a late-arriving query service still arms. */
export function watchFleetChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      try {
        const body: unknown = await request.json()
        sessionId = asRecord(body)?.sessionId
      } catch {
        return failure('dsh-context/bad-request', 'body is not JSON')
      }
      if (typeof sessionId !== 'string' || sessionId === '') {
        return failure('dsh-context/bad-request', 'missing sessionId')
      }
      try {
        const query = ctx.get('sessionQuery') as SessionQueryFace | undefined
        const observe = typeof query?.observeSession === 'function'
          ? query.observeSession.bind(query)
          : undefined
        if (observe === undefined) return reply({ ok: true, value: null })
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' })
          const events = (observation as { events?: unknown } | null)?.events
          if (!Array.isArray(events)) return null
          try {
            return fleetDetailOfEvents(events)
          } finally {
            const dispose = (observation as { [Symbol.dispose]?: unknown } | null)?.[Symbol.dispose]
            if (typeof dispose === 'function') dispose.call(observation)
          }
        })
        return reply({ ok: true, value: value ?? null })
      } catch (err) {
        return failure('gateway/internal', err instanceof Error ? err.message : String(err))
      }
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, FLEET_ROUTE, handler, 'dsh-context: fleet route')
  })
}
