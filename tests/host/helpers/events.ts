// Durable session-event envelope builders for the fold specs. Shapes mirror
// the harness's durable vocabulary (`SessionEventMap` in @deepseek-ai/dsh-session,
// plus the dsh-compaction declaration-merged `compaction/*` family) — the same
// envelopes a real session log carries, minus fields the fold never reads.

import type { TimelineEvent } from '../../../src/host/fold'
import type { ContentBlock, MessageSource } from '../../../src/host/pricing'

let clock = 0

/** Monotonic timestamps, so folded records stay time-ordered without thinking. */
export function at(time?: number): number {
  clock += 1000
  return time ?? clock
}

export function header(seq: number, opts: {
  system?: unknown
  tools?: unknown[]
  model?: unknown
  provider?: unknown
  reason?: 'initial' | 'resume' | 'change'
  /** Override the whole config object (e.g. to omit model/provider). */
  config?: unknown
  time?: number
}): TimelineEvent {
  const h: Record<string, unknown> = { config: opts.config ?? { model: opts.model, provider: opts.provider } }
  if (opts.system !== undefined) h.system = opts.system
  if (opts.tools !== undefined) h.tools = opts.tools
  return { type: 'request/header', seq, time: at(opts.time), data: { header: h, reason: opts.reason ?? 'initial' } }
}

export function requestContext(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'request/context', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

/** user/message: the durable payload IS the message (deriveEventMessage returns data). */
export function userMessage(seq: number, content: ContentBlock[], source?: MessageSource | null, opts: {
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
} = {}): TimelineEvent {
  const data: Record<string, unknown> = { content }
  if (source !== undefined) data.source = source
  return { type: 'user/message', seq, time: at(opts.time), data, surfaceOp: opts.surfaceOp ?? 'append' }
}

export function toolCall(seq: number, opts: {
  callId?: unknown
  name?: unknown
  arguments?: string
  turn?: number
  step?: number
}): TimelineEvent {
  return { type: 'tool/call', seq, time: at(), data: { callId: opts.callId, name: opts.name, arguments: opts.arguments ?? '{}' } }
}

export function stepStart(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/start', seq, time: at(opts.time) }
}

export function stepEnd(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/end', seq, time: at(opts.time) }
}

/** tool/result: the model-visible message rides data.message with the tool source. */
export function toolResult(seq: number, opts: {
  callId: string
  content: ContentBlock[]
  error?: boolean
  /** Drop the durable source (a legacy/foreign envelope). */
  noSource?: boolean
  /** Drop the envelope callId (source carries it). */
  noEnvelopeId?: boolean
  time?: number
}): TimelineEvent {
  const message: Record<string, unknown> = {
    content: [{ type: 'tool-result', toolCallId: opts.callId, content: opts.content }],
  }
  if (opts.noSource !== true) message.source = { kind: 'tool', callId: opts.callId }
  const data: Record<string, unknown> = { message }
  if (opts.noEnvelopeId !== true) data.callId = opts.callId
  if (opts.error === true) data.error = true
  return { type: 'tool/result', seq, time: at(opts.time), data, surfaceOp: 'append' }
}

export function assistantMessage(seq: number, opts: {
  turn?: number
  step?: number
  content?: ContentBlock[]
  usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
}): TimelineEvent {
  const data: Record<string, unknown> = { message: { content: opts.content ?? [{ type: 'text', text: 'reply' }] } }
  if (opts.turn !== undefined) data.turn = opts.turn
  if (opts.step !== undefined) data.step = opts.step
  if (opts.usage !== undefined) data.usage = opts.usage
  return { type: 'assistant/message', seq, time: at(opts.time), data, surfaceOp: opts.surfaceOp ?? 'append' }
}

export function compaction(seq: number, kind: 'summary' | 'prune', data?: Record<string, unknown>): TimelineEvent {
  return { type: `compaction/${kind}`, seq, time: at(), ...(data === undefined ? {} : { data }) }
}

export function planMode(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'plan/mode', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

/** An event the fold does not care about (chunk, todo, …). */
export function foreign(seq: number, type = 'assistant/chunk'): TimelineEvent {
  return { type, seq, time: at(), data: {} }
}
