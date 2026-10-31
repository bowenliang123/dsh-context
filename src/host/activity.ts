import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { WiredProjection } from './projection'
import { skillNameOf } from './fold'
import { addBilledUsage, copyCostUsage, durOf, tokenCountOf } from './foldMetering'
import type { BilledUsage, UsageLike } from './foldMetering'
import { costUsageSchema } from './timeline'
import { commandProgramOf } from '../shared/commands'
import { dayKeyOf } from '../shared/days'
import type { ActivityDay, ActivityTally, ContextActivity } from '../shared/types'

const MAX_KEPT_DAYS = 400

const MAX_SKILLS_PER_DAY = 100

const MAX_TOOLS_PER_DAY = 64

const MAX_PROGRAMS_PER_DAY = 64

const MAX_PENDING_SKILL_CALLS = 100

const MAX_PENDING_TOOL_CALLS = 100

interface ToolStart {
  start: number
  day: string
  name?: string
}

export interface ActivityState {
  days: Record<string, ActivityDay>
  model?: string
  provider?: string
  stepStart?: number
  lastTurn?: number
  toolStarts?: Record<string, ToolStart | undefined>
  skillCalls?: string[]
}

const activityTallySchema = z.object({
  n: z.number().int().nonnegative(),
  last: z.number(),
}).strict()

const toolStartSchema = z.object({
  start: z.number().nonnegative(),
  day: z.string(),
  name: z.string().optional(),
}).strict()

const activityDaySchema = z.object({
  tokens: z.number().int().nonnegative(),
  requests: z.number().int().nonnegative(),
  cost: costUsageSchema.optional(),
  turns: z.number().int().nonnegative().optional(),
  toolCalls: z.number().int().nonnegative().optional(),
  toolsMs: z.number().nonnegative().optional(),
  wallMs: z.number().nonnegative().optional(),
  skills: z.record(z.string(), activityTallySchema).optional(),
  tools: z.record(z.string(), activityTallySchema).optional(),
  cmds: z.record(z.string(), activityTallySchema).optional(),
}).strict()
export const contextActivitySchema = z.object({
  days: z.record(z.string(), activityDaySchema),
}).strict() as unknown as z.ZodType<ContextActivity>

const activityStateSchema = z.object({
  days: z.record(z.string(), activityDaySchema),
  model: z.string().optional(),
  provider: z.string().optional(),
  stepStart: z.number().optional(),
  lastTurn: z.number().optional(),
  toolStarts: z.record(z.string(), toolStartSchema).optional(),
  skillCalls: z.array(z.string()).optional(),
}) as unknown as z.ZodType<ActivityState>

function billedBucketsOf(value: unknown): BilledUsage | null {
  if (value === null || typeof value !== 'object') return null
  const usage = value as UsageLike
  const input = tokenCountOf(usage.inputTokens)
  const cacheRead = tokenCountOf(usage.cacheReadTokens)
  const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
  const output = tokenCountOf(usage.outputTokens)
  if (input === null && cacheRead === null && cacheWrite === null && output === null) return null
  return { uncached: input ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0, output: output ?? 0 }
}

function withDayEntry(state: ActivityState, key: string, entry: ActivityDay): ActivityState {
  let days = { ...state.days, [key]: entry }
  const keys = Object.keys(days)
  if (keys.length > MAX_KEPT_DAYS) {
    keys.sort()
    const drop = new Set(keys.slice(0, keys.length - MAX_KEPT_DAYS))
    days = Object.fromEntries(Object.entries(days).filter(([k]) => !drop.has(k)))
  }
  return { ...state, days }
}

function copyDay(prev: ActivityDay | undefined): ActivityDay {
  return {
    tokens: prev?.tokens ?? 0,
    requests: prev?.requests ?? 0,
    ...(prev?.cost !== undefined ? { cost: prev.cost } : {}),
    ...(prev?.turns !== undefined ? { turns: prev.turns } : {}),
    ...(prev?.toolCalls !== undefined ? { toolCalls: prev.toolCalls } : {}),
    ...(prev?.toolsMs !== undefined ? { toolsMs: prev.toolsMs } : {}),
    ...(prev?.wallMs !== undefined ? { wallMs: prev.wallMs } : {}),
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
    ...(prev?.tools !== undefined ? { tools: prev.tools } : {}),
    ...(prev?.cmds !== undefined ? { cmds: prev.cmds } : {}),
  }
}

function withDayPatch(state: ActivityState, key: string, patch: Partial<ActivityDay>): ActivityState {
  return withDayEntry(state, key, { ...copyDay(state.days[key]), ...patch })
}

function bumpTally(
  table: Record<string, ActivityTally> | undefined,
  name: string,
  time: number,
  cap: number,
): Record<string, ActivityTally> | null {
  const prev = table?.[name]
  if (prev !== undefined) {
    return { ...table, [name]: { n: prev.n + 1, last: Math.max(prev.last, time) } }
  }
  if (table !== undefined && Object.keys(table).length >= cap) return null
  return { ...(table ?? {}), [name]: { n: 1, last: time } }
}

function withTally(
  state: ActivityState,
  key: string,
  field: 'skills' | 'tools' | 'cmds',
  name: string,
  time: number,
  cap: number,
): ActivityState {
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  const table = bumpTally(prev?.[field], name, time, cap)
  return table === null ? state : withDayEntry(state, key, { ...copyDay(prev), [field]: table })
}

function withToolStart(state: ActivityState, callId: string, name: string | undefined, start: number): ActivityState {
  if (!Number.isFinite(start) || start < 0) return state
  const day = dayKeyOf(state.stepStart ?? start)
  if (day === null) return state
  const prev = state.toolStarts?.[callId]
  if (prev !== undefined && prev.start === start && prev.day === day && prev.name === name) return state
  const starts: Record<string, ToolStart | undefined> = {
    ...state.toolStarts,
    [callId]: { start, day, ...(name !== undefined ? { name } : {}) },
  }
  const entries = Object.entries(starts)
  const toolStarts = entries.length > MAX_PENDING_TOOL_CALLS
    ? Object.fromEntries(entries.slice(entries.length - MAX_PENDING_TOOL_CALLS))
    : starts
  return { ...state, toolStarts }
}

function bookToolResult(state: ActivityState, callId: string, end: number): ActivityState {
  const starts = state.toolStarts
  const start = starts?.[callId]
  if (starts === undefined || start === undefined) return state
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const day = byKey[start.day]
  const timed = withDayPatch(state, start.day, {
    toolCalls: (day?.toolCalls ?? 0) + 1,
    toolsMs: (day?.toolsMs ?? 0) + durOf(start.start, end),
  })
  const kept = Object.fromEntries(Object.entries(starts).filter(([id]) => id !== callId))
  const next = { ...timed }
  if (Object.keys(kept).length > 0) next.toolStarts = kept
  else delete next.toolStarts
  if (start.name === undefined) return next
  return withTally(next, start.day, 'tools', start.name, Number.isFinite(end) ? end : start.start, MAX_TOOLS_PER_DAY)
}

function bookSkillLoad(state: ActivityState, name: string, time: number): ActivityState {
  const key = dayKeyOf(time)
  return key === null ? state : withTally(state, key, 'skills', name, time, MAX_SKILLS_PER_DAY)
}

function bookCommandRun(state: ActivityState, tool: string | undefined, raw: unknown, time: number): ActivityState {
  const program = commandProgramOf(tool, raw)
  const key = dayKeyOf(state.stepStart ?? time)
  if (program === null || key === null) return state
  return withTally(state, key, 'cmds', program, time, MAX_PROGRAMS_PER_DAY)
}

function invokedSkillOf(event: SessionEvent): string {
  const data = event.data as { source?: unknown; message?: unknown } | null | undefined
  const carrier = event.type === 'developer/message' ? data?.message : data
  const source = carrier !== null && typeof carrier === 'object'
    ? (carrier as { source?: unknown }).source
    : undefined
  if (source === null || typeof source !== 'object') return ''
  const rec = source as { kind?: unknown; name?: unknown }
  return rec.kind === 'skill-invocation' && typeof rec.name === 'string' ? rec.name : ''
}

function toolResultCallIdOf(message: unknown): string | null {
  if (message === null || typeof message !== 'object') return null
  const rec = message as { toolCallId?: unknown; source?: unknown }
  if (typeof rec.toolCallId === 'string' && rec.toolCallId !== '') return rec.toolCallId
  const source = rec.source
  if (source === null || typeof source !== 'object') return null
  const callId = (source as { callId?: unknown }).callId
  return typeof callId === 'string' && callId !== '' ? callId : null
}
export function applyActivity(state: ActivityState, event: SessionEvent): ActivityState {
  if (event.type === 'request/header') {
    const data = event.data as { header?: { config?: { model?: unknown; provider?: unknown } | null } | null } | undefined
    const config = data?.header?.config
    if (config === null || typeof config !== 'object') return state
    const model = typeof config.model === 'string' ? config.model : undefined
    const provider = typeof config.provider === 'string' ? config.provider : undefined
    const nextModel = model !== undefined ? model : state.model
    const nextProvider = provider !== undefined ? provider : state.provider
    if (nextModel === state.model && nextProvider === state.provider) return state
    return {
      ...state,
      ...(nextModel !== undefined ? { model: nextModel } : {}),
      ...(nextProvider !== undefined ? { provider: nextProvider } : {}),
    }
  }
  if (event.type === 'step/start') {
    if (!Number.isFinite(event.time)) return state
    return state.stepStart === event.time ? state : { ...state, stepStart: event.time }
  }
  if (event.type === 'step/end') {
    const start = state.stepStart
    if (start === undefined) return state
    const key = dayKeyOf(start)
    const dur = durOf(start, event.time)
    const timed = key === null || dur <= 0
      ? state
      : withDayPatch(state, key, { wallMs: (state.days[key]?.wallMs ?? 0) + dur })
    const next = { ...timed }
    delete next.stepStart
    return next
  }
  if (event.type === 'session/end-seed') {
    const data = event.data as { inherited?: unknown } | null | undefined
    if (data?.inherited !== true) return state
    return { days: {} }
  }
  if (event.type === 'user/message' || event.type === 'developer/message') {
    const name = invokedSkillOf(event)
    return name === '' ? state : bookSkillLoad(state, name, event.time)
  }
  if (event.type === 'tool/call') {
    const data = event.data as { callId?: unknown; name?: unknown; arguments?: unknown } | null | undefined
    const callId = data?.callId
    if (typeof callId !== 'string' || callId === '') return state
    const name = typeof data?.name === 'string' && data.name !== '' ? data.name : undefined
    const next = bookCommandRun(withToolStart(state, callId, name, event.time), name, data?.arguments, event.time)
    if (name !== 'skill') return next
    const pending = next.skillCalls ?? []
    if (pending.includes(callId)) return next
    return { ...next, skillCalls: [...pending, callId].slice(-MAX_PENDING_SKILL_CALLS) }
  }
  const eventType: string = event.type
  if (eventType === 'tool/ptc-dispatch-start') {
    const data = event.data as { name?: unknown; arguments?: unknown } | null | undefined
    return bookCommandRun(state, typeof data?.name === 'string' ? data.name : undefined, data?.arguments, event.time)
  }
  if (event.type === 'tool/result') {
    const message = (event.data as { message?: unknown } | null | undefined)?.message
    const callId = toolResultCallIdOf(message)
    const next = callId === null ? state : bookToolResult(state, callId, event.time)
    const pending = next.skillCalls
    if (callId === null || pending === undefined || !pending.includes(callId)) return next
    const skillCalls = pending.filter(id => id !== callId)
    const consumed: ActivityState = { ...next }
    if (skillCalls.length > 0) consumed.skillCalls = skillCalls
    else delete consumed.skillCalls
    const name = skillNameOf(message)
    return name === '' ? consumed : bookSkillLoad(consumed, name, event.time)
  }
  if (event.type !== 'assistant/message') return state
  const initiated = state.stepStart !== undefined ? state.stepStart : event.time
  const key = dayKeyOf(initiated)
  if (key === null) return state
  const data = event.data as { usage?: unknown; turn?: unknown } | undefined
  const buckets = billedBucketsOf(data?.usage)
  const byKey: Record<string, ActivityDay | undefined> = state.days
  const prev = byKey[key]
  let cost = prev?.cost
  if (buckets !== null && state.model !== undefined) {
    cost = addBilledUsage(cost, state.provider ?? '', state.model, initiated, buckets)
  }
  const turn = typeof data?.turn === 'number' && Number.isFinite(data.turn) ? data.turn : undefined
  const newTurn = turn !== undefined && turn !== state.lastTurn
  const turns = (prev?.turns ?? 0) + (newTurn ? 1 : 0)
  const entry: ActivityDay = {
    tokens: (prev === undefined ? 0 : prev.tokens)
      + (buckets === null ? 0 : buckets.uncached + buckets.cacheRead + buckets.cacheWrite + buckets.output),
    requests: (prev === undefined ? 0 : prev.requests) + 1,
    ...(cost !== undefined ? { cost } : {}),
    ...(turns > 0 ? { turns } : {}),
    ...(prev?.toolCalls !== undefined ? { toolCalls: prev.toolCalls } : {}),
    ...(prev?.toolsMs !== undefined ? { toolsMs: prev.toolsMs } : {}),
    ...(prev?.wallMs !== undefined ? { wallMs: prev.wallMs } : {}),
    ...(prev?.skills !== undefined ? { skills: prev.skills } : {}),
    ...(prev?.tools !== undefined ? { tools: prev.tools } : {}),
    ...(prev?.cmds !== undefined ? { cmds: prev.cmds } : {}),
  }
  const next = withDayEntry(state, key, entry)
  return newTurn ? { ...next, lastTurn: turn } : next
}

export function createContextActivityDefinition(): WiredProjection<'contextActivity', ActivityState> {
  return {
    key: 'contextActivity',
    stateSchema: activityStateSchema,
    init: (): ActivityState => ({ days: {} }),
    apply: (state: ActivityState, event: SessionEvent) => applyActivity(state, event),
    wire: {
      viewSchema: contextActivitySchema,
      view: state => ({
        days: Object.fromEntries(Object.entries(state.days).map(([k, v]) => [k, {
          ...v,
          ...(v.cost !== undefined ? { cost: copyCostUsage(v.cost) } : {}),
          ...(v.skills !== undefined ? { skills: copyTallies(v.skills) } : {}),
          ...(v.tools !== undefined ? { tools: copyTallies(v.tools) } : {}),
          ...(v.cmds !== undefined ? { cmds: copyTallies(v.cmds) } : {}),
        }])),
      }),
    },
    stateVersion: 6,
  }
}

function copyTallies(table: Record<string, ActivityTally>): Record<string, ActivityTally> {
  return Object.fromEntries(Object.entries(table).map(([name, tally]) => [name, { ...tally }]))
}
