import type { TimelineEvent } from '../../../src/host/fold'
import type { ContentBlock, MessageSource } from '../../../src/host/pricing'

let clock = 0

export function at(time?: number): number {
  clock += 1000
  return time ?? clock
}

export function header(seq: number, opts: {
  tools?: unknown[]
  model?: unknown
  provider?: unknown
  reason?: 'initial' | 'resume' | 'change'
  config?: unknown
  time?: number
} = {}): TimelineEvent {
  const h: Record<string, unknown> = { config: opts.config ?? { model: opts.model, provider: opts.provider } }
  if (opts.tools !== undefined) h.tools = opts.tools
  return { type: 'request/header', seq, time: at(opts.time), data: { header: h, reason: opts.reason ?? 'initial' } }
}

export function requestContext(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'request/context', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

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
  time?: number
}): TimelineEvent {
  return {
    type: 'tool/call',
    seq,
    time: at(opts.time),
    data: {
      callId: opts.callId,
      name: opts.name,
      arguments: opts.arguments ?? '{}',
      ...(opts.turn !== undefined ? { turn: opts.turn } : {}),
      ...(opts.step !== undefined ? { step: opts.step } : {}),
    },
  }
}

export function stepStart(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/start', seq, time: at(opts.time) }
}

export function stepEnd(seq: number, opts: { time?: number } = {}): TimelineEvent {
  return { type: 'step/end', seq, time: at(opts.time) }
}

export function toolResult(seq: number, opts: {
  callId: string
  content: ContentBlock[]
  error?: boolean
  meta?: unknown
  time?: number
}): TimelineEvent {
  const message: Record<string, unknown> = {
    role: 'tool',
    toolCallId: opts.callId,
    source: { kind: 'tool', callId: opts.callId },
    content: opts.content,
  }
  if (opts.error === true) message.isError = true
  const data: Record<string, unknown> = { message }
  if (opts.meta !== undefined) data.meta = opts.meta
  return { type: 'tool/result', seq, time: at(opts.time), data, surfaceOp: 'append' }
}

export function assistantMessage(seq: number, opts: {
  turn?: number
  step?: number
  content?: ContentBlock[]
  usage?: Record<string, unknown>
  stream?: unknown
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
}): TimelineEvent {
  const data: Record<string, unknown> = { message: { content: opts.content ?? [{ type: 'text', text: 'reply' }] } }
  if (opts.turn !== undefined) data.turn = opts.turn
  if (opts.step !== undefined) data.step = opts.step
  if (opts.usage !== undefined) data.usage = opts.usage
  if (opts.stream !== undefined) data.stream = opts.stream
  return { type: 'assistant/message', seq, time: at(opts.time), data, surfaceOp: opts.surfaceOp ?? 'append' }
}

export function assistantAttempt(seq: number, opts: {
  turn?: number
  step?: number
  stream?: unknown
  time?: number
}): TimelineEvent {
  return {
    type: 'assistant/attempt',
    seq,
    time: at(opts.time),
    data: { turn: opts.turn, step: opts.step, stream: opts.stream },
  }
}

export function systemMessage(seq: number, opts: {
  turn?: number
  step?: number
  content?: unknown
  time?: number
  surfaceOp?: TimelineEvent['surfaceOp']
} = {}): TimelineEvent {
  return {
    type: 'system/message',
    seq,
    time: at(opts.time),
    data: {
      turn: opts.turn,
      step: opts.step,
      message: {
        role: 'system',
        source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' },
        content: opts.content ?? [{ type: 'text', text: 'You are an agent.' }],
      },
    },
    surfaceOp: opts.surfaceOp ?? 'append',
  }
}

export function compaction(seq: number, kind: 'summary' | 'prune', data?: Record<string, unknown>): TimelineEvent {
  return { type: `compaction/${kind}`, seq, time: at(), ...(data === undefined ? {} : { data }) }
}

export function planMode(seq: number, data?: Record<string, unknown>): TimelineEvent {
  return { type: 'plan/mode', seq, time: at(), ...(data === undefined ? {} : { data }) }
}

export function endSeed(seq: number, data?: unknown): TimelineEvent {
  return { type: 'session/end-seed', seq, time: at(), ...(data === undefined ? {} : { data }) as Record<string, unknown> }
}

export function foreign(seq: number, type = 'todo/write'): TimelineEvent {
  return { type, seq, time: at(), data: {} }
}

export function codeDispatchStart(seq: number, opts: {
  rootCallId?: unknown
  parentCallId?: unknown
  subCallId?: unknown
  name?: unknown
  arguments?: unknown
  time?: number
}): TimelineEvent {
  return {
    type: 'tool/ptc-dispatch-start',
    seq,
    time: at(opts.time),
    data: {
      rootCallId: opts.rootCallId,
      parentCallId: opts.parentCallId ?? opts.rootCallId,
      subCallId: opts.subCallId ?? `${String(opts.rootCallId)}:code:0`,
      name: opts.name,
      arguments: opts.arguments,
    },
  }
}

export function jobRegistered(seq: number, opts: {
  jobId?: unknown
  callId?: unknown
  startedAt?: unknown
  time?: number
}): TimelineEvent {
  return {
    type: 'job/registered',
    seq,
    time: at(opts.time),
    data: {
      jobId: opts.jobId ?? 'job-1',
      owner: 'session',
      kind: 'bash',
      label: 'cmd',
      startedAt: opts.startedAt,
      toolCall: { callId: opts.callId, rootCallId: opts.callId },
    },
  }
}

export function jobSettled(seq: number, opts: {
  jobId?: unknown
  callId?: unknown
  finishedAt?: unknown
  status?: unknown
  detail?: unknown
  time?: number
}): TimelineEvent {
  return {
    type: 'job/settled',
    seq,
    time: at(opts.time),
    data: {
      jobId: opts.jobId ?? 'job-1',
      owner: 'session',
      kind: 'bash',
      label: 'cmd',
      startedAt: 0,
      toolCall: { callId: opts.callId, rootCallId: opts.callId },
      finishedAt: opts.finishedAt,
      status: opts.status ?? 'completed',
      cause: 'producer',
      producerReported: true,
      detail: opts.detail,
    },
  }
}

export function codeDispatch(seq: number, opts: {
  rootCallId?: unknown
  parentCallId?: unknown
  subCallId?: unknown
  name?: unknown
  arguments?: unknown
  isError?: unknown
  content?: unknown
  time?: number
}): TimelineEvent {
  return {
    type: 'tool/ptc-dispatch',
    seq,
    time: at(opts.time),
    data: {
      rootCallId: opts.rootCallId,
      parentCallId: opts.parentCallId ?? opts.rootCallId,
      subCallId: opts.subCallId ?? `${String(opts.rootCallId)}:code:0`,
      name: opts.name,
      arguments: opts.arguments,
      isError: opts.isError ?? false,
      content: opts.content ?? [],
    },
  }
}

export function canonicalLog(): TimelineEvent[] {
  return [
    header(1, {
      tools: [{ name: 'bash', description: 'run a command' }],
      config: { model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max' },
    }),
    systemMessage(2),
    requestContext(3, { contextWindow: 128000 }),
    stepStart(4),
    userMessage(5, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(6, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(7, { callId: 'c1', name: 'bash' }),
    toolResult(8, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(9),
    assistantMessage(10, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(11, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5] }),
    planMode(12, { active: true }),
  ]
}

export function manyEvents(count: number): TimelineEvent[] {
  const events: TimelineEvent[] = [header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' })]
  for (let seq = 2; seq <= count; seq++) {
    events.push(seq % 2 === 0
      ? userMessage(seq, [{ type: 'text', text: `question ${seq}` }], { kind: 'user' })
      : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 10, outputTokens: 5 } }))
  }
  return events
}
