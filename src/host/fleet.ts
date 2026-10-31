import type { Context } from '@deepseek-ai/cordis'
import type { FleetDescriptor, FleetDetail, FleetMemberInfo, FleetMessage } from '../shared/types'
import { type ColdReadGate, makeColdReadGate } from './coldRead'
import { type ConnectionHostFace, registerPostRoute } from './connection'
import { disposeObservation, revisionOf } from './observation'

export const FLEET_ROUTE = '/api/dsh-context/fleet'

const MESSAGES_MAX = 80
const MESSAGE_TEXT_MAX = 400
const PROMPT_TEXT_MAX = 1600
const REPLY_TEXT_MAX = 300
const FULL_MESSAGES_MAX = 120
const FULL_MESSAGE_TEXT_MAX = 24_000
const FULL_TEXT_MAX = 100_000

function fullOf(body: unknown): boolean {
  return asRecord(body)?.full === true
}

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

const REMINDER_PREFIX = /^\s*<system-reminder>[\s\S]*?<\/system-reminder>\s*/

function clip(text: string, max: number): { text: string; cut: boolean } {
  return text.length > max ? { text: text.slice(0, max) + '…', cut: true } : { text, cut: false }
}

function descriptorOf(data: Record<string, unknown>): FleetDescriptor | null {
  const mode = data.mode
  if (mode !== 'one-shot' && mode !== 'continuable') return null
  const out: FleetDescriptor = { mode }
  for (const key of ['label', 'provider', 'agentProvider', 'agentModel', 'agentReasoningEffort', 'persona'] as const) {
    const value = data[key]
    if (typeof value === 'string' && value !== '') out[key] = value
  }
  return out
}

const MAILBOX_PREFIX = /^Team message \S+ from ([^:]{1,64}):\s*/
const RELAY_PREFIX = /^(?:Agent \S+ sent a message: |Team message from ([^:\n]{1,64}):\s*)/

const CLOSING_HEAD = 'Its closing message:'
const NO_CLOSING = 'It left no closing message.'
const CLOSING_OMITTED = 'It sent you a message just before finishing, so its closing message is omitted.'
const STRUCTURED_HEAD = 'Structured result: '

function jsonSpan(text: string): number {
  const first = text[0]
  if (first !== '{' && first !== '[') return 0
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return i + 1
    }
  }
  return text.length
}

interface SettledFields {
  summary: string
  report?: string
  structured?: string
  diagnostic?: string
  clipped: boolean
}

function settledFields(summary: string, text: string, max: number): SettledFields {
  let clipped = false
  const put = (value: string): string | undefined => {
    const trimmed = value.trim()
    if (trimmed === '') return undefined
    const cut = clip(trimmed, max)
    if (cut.cut) clipped = true
    return cut.text
  }
  const rest = text.slice(summary.length).trim()
  const structuredAt = rest.indexOf(STRUCTURED_HEAD)
  let before = structuredAt >= 0 ? rest.slice(0, structuredAt).trim() : rest
  if (before === NO_CLOSING || before === CLOSING_OMITTED) before = ''
  else if (before.startsWith(CLOSING_HEAD)) before = before.slice(CLOSING_HEAD.length).trim()
  let structured: string | undefined
  let diagnostic: string | undefined
  if (structuredAt >= 0) {
    const raw = rest.slice(structuredAt + STRUCTURED_HEAD.length).trim()
    const end = jsonSpan(raw)
    structured = put(end > 0 ? raw.slice(0, end) : raw)
    if (end > 0) diagnostic = put(raw.slice(end))
  }
  const summaryCut = clip(summary, max)
  if (summaryCut.cut) clipped = true
  const report = put(before)
  const out: SettledFields = { summary: summaryCut.text, clipped }
  if (report !== undefined) out.report = report
  if (structured !== undefined) out.structured = structured
  if (diagnostic !== undefined) out.diagnostic = diagnostic
  return out
}

function messageOf(seq: number, time: number, data: Record<string, unknown>, max: number): FleetMessage | null {
  const source = asRecord(data.source)
  const kind = source?.kind
  let message: FleetMessage | null = null
  if (kind === 'agent-message' || kind === 'team-message') {
    const raw = textOfContent(data.content)
    const prefix = kind === 'team-message' ? MAILBOX_PREFIX : RELAY_PREFIX
    const framed = prefix.exec(raw)
    const text = raw.replace(prefix, '')
    if (text.trim() === '') return null
    message = {
      seq,
      time,
      kind: kind === 'agent-message' ? 'relay' : 'mailbox',
      text,
    }
    const from = kind === 'agent-message' ? source?.senderSessionId : source?.senderId
    if (typeof from === 'string' && from !== '') message.from = from
    const fromName = typeof source?.senderName === 'string' && source.senderName !== ''
      ? source.senderName
      : framed?.[1]
    if (fromName !== undefined && fromName !== '') message.fromName = fromName
  } else if (kind === 'subagent-settled') {
    const summary = typeof source?.summary === 'string' ? source.summary.trim() : ''
    const content = textOfContent(data.content).trim()
    const text = summary !== '' && !content.startsWith(summary)
      ? summary
      : content !== '' ? content : summary
    if (text.trim() === '') return null
    message = { seq, time, kind: 'settled', text }
    const from = source?.senderSessionId
    if (typeof from === 'string' && from !== '') message.from = from
    if (summary !== '') {
      const fields = settledFields(summary, text, max)
      message.summary = fields.summary
      if (fields.clipped) message.clipped = true
      if (fields.report !== undefined) message.report = fields.report
      if (fields.structured !== undefined) message.structured = fields.structured
      if (fields.diagnostic !== undefined) message.diagnostic = fields.diagnostic
    }
  }
  if (message === null) return null
  const cut = clip(message.text, max)
  message.text = cut.text
  if (cut.cut) message.clipped = true
  return message
}

function isPlainPrompt(source: Record<string, unknown> | null): boolean {
  if (source === null) return true
  return source.kind === 'user'
}

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

interface FleetCaps {
  promptMax: number
  replyMax: number
  messageMax: number
  listMax: number
}

function capsOf(full: boolean): FleetCaps {
  return full
    ? { promptMax: FULL_TEXT_MAX, replyMax: FULL_TEXT_MAX, messageMax: FULL_MESSAGE_TEXT_MAX, listMax: FULL_MESSAGES_MAX }
    : { promptMax: PROMPT_TEXT_MAX, replyMax: REPLY_TEXT_MAX, messageMax: MESSAGE_TEXT_MAX, listMax: MESSAGES_MAX }
}

export class FleetFold {
  private descriptor: FleetDescriptor | undefined
  private initialPrompt: string | undefined
  private truncated = false
  private total = 0
  private readonly messages: FleetMessage[] = []
  private readonly roster = new Map<string, FleetMemberInfo>()
  private lastReply: { time: number; text: string } | null = null

  constructor(private readonly caps: FleetCaps) {}

  apply(events: readonly unknown[]): void {
    for (const entry of events) this.applyEvent(entry)
  }

  private applyEvent(entry: unknown): void {
    const ev = asRecord(entry)
    if (ev === null) return
    const type = ev.type
    if (typeof type !== 'string') return
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0
    const time = typeof ev.time === 'number' && Number.isFinite(ev.time) ? ev.time : 0
    const data = asRecord(ev.data)
    if (data === null) return
    if (type === 'subagent/descriptor') {
      const next = descriptorOf(data)
      if (next !== null) this.descriptor = next
      return
    }
    if (type === 'team/member') {
      const member = rosterMemberOf(data)
      if (member !== null) this.roster.set(member.name, member)
      return
    }
    if (type === 'assistant/message') {
      this.replyOf(seq, time, data)
      return
    }
    if (type !== 'user/message') return
    const message = messageOf(seq, time, data, this.caps.messageMax)
    if (message !== null) {
      this.total += 1
      this.insert(message)
      return
    }
    if (this.initialPrompt !== undefined || !isPlainPrompt(asRecord(data.source))) return
    const text = textOfContent(data.content).replace(REMINDER_PREFIX, '')
    if (text.trim() === '') return
    const cut = clip(text, this.caps.promptMax)
    this.initialPrompt = cut.text
    if (cut.cut) this.truncated = true
  }

  private replyOf(seq: number, time: number, data: Record<string, unknown>): void {
    const message = asRecord(data.message)
    const content = message?.content
    if (!Array.isArray(content)) return
    let text = ''
    for (const block of content) {
      const b = asRecord(block)
      if (b?.type === 'text' && typeof b.text === 'string') text += b.text
    }
    if (text.trim() === '') return
    const cut = clip(text, this.caps.replyMax)
    this.lastReply = { time, text: cut.text }
    if (cut.cut) this.truncated = true
  }

  private insert(message: FleetMessage): void {
    let at = 0
    while (at < this.messages.length && this.messages[at].seq >= message.seq) at++
    this.messages.splice(at, 0, message)
    if (this.messages.length > this.caps.listMax) {
      this.messages.pop()
      this.truncated = true
    }
    if (message.clipped === true) this.truncated = true
  }

  serve(): FleetDetail {
    const messages = this.messages.slice()
    return {
      ...(this.descriptor !== undefined ? { descriptor: this.descriptor } : {}),
      ...(this.initialPrompt !== undefined ? { initialPrompt: this.initialPrompt } : {}),
      ...(this.lastReply !== null ? { lastReply: this.lastReply } : {}),
      ...(this.roster.size > 0 ? { roster: [...this.roster.values()] } : {}),
      messages,
      ...(this.total > messages.length ? { messagesTotal: this.total } : {}),
      truncated: this.truncated,
    }
  }
}

export function fleetDetailOfEvents(events: readonly unknown[], full = false): FleetDetail {
  const fold = new FleetFold(capsOf(full))
  fold.apply(events)
  return fold.serve()
}

interface FoldEntry {
  live: boolean
  persistence?: unknown
  revision?: string
  cursor: number
  count: number
  fold: FleetFold
}

const FOLD_CACHE_MAX = 8

interface ObservationLike {
  source?: unknown
  revision?: unknown
  events?: unknown
  [Symbol.dispose]?: unknown
}

function reusable(
  entry: FoldEntry,
  live: boolean,
  revision: string | undefined,
  persistence: unknown,
  events: readonly unknown[],
  cursor: number,
): boolean {
  if (live) {
    if (!entry.live || events.length < entry.count) return false
    return entry.count === 0 || ((events[entry.count - 1] as { seq?: unknown } | null)?.seq === entry.cursor)
  }
  return !entry.live && entry.revision === revision && entry.persistence === persistence && entry.cursor <= cursor
}

function foldOf(
  cache: Map<string, FoldEntry>,
  sessionId: string,
  events: readonly unknown[],
  live: boolean,
  revision: string | undefined,
  persistence: unknown,
  cursor: number,
): FleetFold {
  const entry = cache.get(sessionId)
  if (entry !== undefined && reusable(entry, live, revision, persistence, events, cursor)) {
    const from = live ? entry.count : events.length
    if (from < events.length) entry.fold.apply(events.slice(from))
    entry.count = events.length
    entry.cursor = cursor
    cache.delete(sessionId)
    cache.set(sessionId, entry)
    return entry.fold
  }
  const fold = new FleetFold(capsOf(false))
  fold.apply(events)
  if (!live && revision === undefined) return fold
  cache.set(sessionId, {
    live,
    ...(revision !== undefined ? { revision } : {}),
    ...(persistence === undefined ? {} : { persistence }),
    cursor,
    count: events.length,
    fold,
  })
  for (const oldest of cache.keys()) {
    if (cache.size <= FOLD_CACHE_MAX) break
    cache.delete(oldest)
  }
  return fold
}

export function watchFleetChannel(ctx: Context, coldReads: ColdReadGate = makeColdReadGate()): void {
  const cache = new Map<string, FoldEntry>()
  ctx.inject(['connection'], (c) => {
    const handler = async (request: Request): Promise<Response> => {
      let sessionId: unknown
      let full = false
      try {
        const body: unknown = await request.json()
        sessionId = asRecord(body)?.sessionId
        full = fullOf(body)
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
        const persistence = c.get('sessionPersistence') as unknown
        const value = await coldReads.admit(async () => {
          const observation = await observe(sessionId, { projectionMode: 'none' }) as ObservationLike | null
          const events = observation?.events
          if (!Array.isArray(events)) return null
          try {
            if (full) return fleetDetailOfEvents(events, true)
            const isLive = observation?.source === 'live'
            return foldOf(
              cache,
              sessionId,
              events,
              isLive,
              isLive ? undefined : revisionOf(observation),
              persistence,
              cursorOfEvents(events),
            ).serve()
          } finally {
            disposeObservation(observation)
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

function cursorOfEvents(events: readonly unknown[]): number {
  for (let i = events.length - 1; i >= 0; i--) {
    const seq = (events[i] as { seq?: unknown } | null)?.seq
    if (typeof seq === 'number' && Number.isFinite(seq)) return seq
  }
  return -1
}
