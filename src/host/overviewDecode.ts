import type {
  ActivityDay,
  ActivityTally,
  ContextActivity,
  SessionCostUsage,
  Snapshot,
  TimingTotals,
} from '../shared/types'
import { asRecord } from './record'

export const TIMING_OPTIONAL = [
  'reasoningMs', 'reasoningBlocks', 'textMs', 'textBlocks',
  'toolArgMs', 'toolArgBlocks', 'toolBusyMs', 'idleMs', 'speedTokens', 'speedMs',
] as const

export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function optionalNumOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function usageOf(value: unknown): SessionCostUsage | undefined {
  const data = asRecord(value)
  return data === null ? undefined : data as SessionCostUsage
}

function tallyTableOf(value: unknown): Record<string, ActivityTally> | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const table: Record<string, ActivityTally> = {}
  for (const key of Object.keys(data)) {
    const entry = asRecord(data[key])
    const n = optionalNumOf(entry?.n)
    const last = optionalNumOf(entry?.last)
    if (n === undefined || last === undefined) continue
    table[key] = { n, last }
  }
  return Object.keys(table).length > 0 ? table : undefined
}

export function activityOf(value: unknown): ContextActivity | null {
  if (value === null) return null
  const data = asRecord(value)
  const rawDays = asRecord(data?.days)
  if (data === null || rawDays === null) return null
  const days: Record<string, ActivityDay> = {}
  for (const key of Object.keys(rawDays)) {
    const entry = asRecord(rawDays[key])
    if (entry === null) continue
    const day: ActivityDay = { tokens: numOf(entry.tokens), requests: numOf(entry.requests) }
    const cost = usageOf(entry.cost)
    if (cost !== undefined) day.cost = cost
    for (const field of ['turns', 'toolCalls', 'toolsMs', 'wallMs'] as const) {
      const figure = optionalNumOf(entry[field])
      if (figure !== undefined) day[field] = figure
    }
    for (const field of ['skills', 'tools', 'cmds'] as const) {
      const table = tallyTableOf(entry[field])
      if (table !== undefined) day[field] = table
    }
    days[key] = day
  }
  return { days }
}

export function currentOf(value: unknown): Snapshot['current'] | null {
  if (value === null) return null
  const data = asRecord(value)
  if (data === null) return null
  const current: Snapshot['current'] = {
    system: numOf(data.system),
    tools: numOf(data.tools),
    user: numOf(data.user),
    inject: numOf(data.inject),
    skill: numOf(data.skill),
    assistant: numOf(data.assistant),
    tool: numOf(data.tool),
    total: numOf(data.total),
  }
  const reasoning = optionalNumOf(data.assistantReasoning)
  const answers = optionalNumOf(data.assistantAnswerTokens)
  const calls = optionalNumOf(data.assistantCallTokens)
  if (reasoning !== undefined) current.assistantReasoning = reasoning
  if (answers !== undefined) current.assistantAnswerTokens = answers
  if (calls !== undefined) current.assistantCallTokens = calls
  return current
}

export function timingOf(value: unknown): TimingTotals | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  const wallMs = optionalNumOf(data.wallMs)
  const ttftMs = optionalNumOf(data.ttftMs)
  const genMs = optionalNumOf(data.genMs)
  const calls = optionalNumOf(data.calls)
  const toolsMs = optionalNumOf(data.toolsMs)
  const toolCalls = optionalNumOf(data.toolCalls)
  const rawTools = asRecord(data.tools)
  if (wallMs === undefined || ttftMs === undefined || genMs === undefined
    || calls === undefined || toolsMs === undefined || toolCalls === undefined
    || rawTools === null) return undefined
  const timing: TimingTotals = { wallMs, ttftMs, genMs, calls, toolsMs, toolCalls, tools: {} }
  for (const key of Object.keys(rawTools)) {
    const entry = asRecord(rawTools[key])
    const toolCallCount = optionalNumOf(entry?.calls)
    const ms = optionalNumOf(entry?.ms)
    if (toolCallCount === undefined || ms === undefined) continue
    timing.tools[key] = { calls: toolCallCount, ms }
  }
  for (const field of TIMING_OPTIONAL) {
    const figure = optionalNumOf(data[field])
    if (figure !== undefined) timing[field] = figure
  }
  return timing
}
