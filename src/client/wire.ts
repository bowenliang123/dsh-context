import { estimateSystemTokens } from '../shared/estimate'
import type { ActivityDay, ActivityTally, ContextActivity, ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, CostModelUsage, SystemPromptNode, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

import { asRecord } from '../shared/decode'

export { asRecord }

export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function objectsOf<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is T => v !== null && typeof v === 'object')
}

export function collectionsOf(data: Record<string, unknown>): Pick<ContextTimeline,
  'requests' | 'events' | 'nodes' | 'droppedNodes' | 'archive'
  | 'surfaceFloor' | 'archiveFloor' | 'fileOps' | 'fileOpsFloor' | 'commands' | 'commandsFloor' | 'commandStats' | 'spans'> {
  const commandStats = commandStatsOf(data.commandStats)
  return {
    requests: objectsOf(data.requests),
    events: objectsOf(data.events),
    nodes: objectsOf(data.nodes),
    droppedNodes: numOf(data.droppedNodes),
    archive: objectsOf(data.archive),
    ...(typeof data.surfaceFloor === 'number' ? { surfaceFloor: data.surfaceFloor } : {}),
    ...(typeof data.archiveFloor === 'number' ? { archiveFloor: data.archiveFloor } : {}),
    ...(data.fileOps !== undefined ? { fileOps: objectsOf(data.fileOps) } : {}),
    ...(typeof data.fileOpsFloor === 'number' ? { fileOpsFloor: data.fileOpsFloor } : {}),
    ...(data.commands !== undefined ? { commands: objectsOf(data.commands) } : {}),
    ...(typeof data.commandsFloor === 'number' ? { commandsFloor: data.commandsFloor } : {}),
    ...(commandStats !== undefined ? { commandStats } : {}),
    ...(data.spans !== undefined ? { spans: objectsOf(data.spans) } : {}),
  }
}

function commandStatsOf(value: unknown): ContextTimeline['commandStats'] | undefined {
  const data = asRecord(value)
  if (data === null) return undefined
  return {
    runs: numOf(data.runs),
    failed: numOf(data.failed),
    ms: numOf(data.ms),
    bg: numOf(data.bg),
  }
}

function recordsOnly(value: unknown): boolean {
  return Array.isArray(value) && value.every(e => e !== null && typeof e === 'object')
}

export function unsupportedOf(value: unknown): { current: string; minimum: string } | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.current !== 'string' || typeof data.minimum !== 'string') return null
  return { current: data.current, minimum: data.minimum }
}

function costOf(value: unknown): ContextTimeline['cost'] | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const out: NonNullable<ContextTimeline['cost']> = {}
  for (const provider of Object.keys(data)) {
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) continue
    const branch: Record<string, CostModelUsage> = {}
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const copy: CostModelUsage = {}
      for (const period of ['peak', 'off'] as const) {
        const b = asRecord(periods[period])
        if (b === null || Array.isArray(b)) continue
        copy[period] = {
          uncached: numOf(b.uncached),
          cacheRead: numOf(b.cacheRead),
          cacheWrite: numOf(b.cacheWrite),
          output: numOf(b.output),
        }
      }
      branch[model] = copy
    }
    out[provider] = branch
  }
  return out
}

function costFastOk(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  return Object.keys(data).every((provider) => {
    const models = asRecord(data[provider])
    return models !== null && !Array.isArray(models)
  })
}

export function timelineOf(value: unknown): ContextTimeline | null {
  const data = asRecord(value)
  if (data === null) return null
  const current = data.current
  const numericBreakdown = current !== null && typeof current === 'object'
    && ['system', 'tools', 'user', 'inject', 'skill', 'assistant', 'tool', 'total']
      .every(k => typeof (current as Record<string, unknown>)[k] === 'number')
  if (numericBreakdown
    && recordsOnly(data.requests)
    && recordsOnly(data.events)
    && recordsOnly(data.nodes)
    && recordsOnly(data.archive)
    && systemsFastOk(data.systems)
    && timingFastOk(data.timing)
    && costFastOk(data.cost)) {
    return data as unknown as ContextTimeline
  }
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current as Record<string, unknown> : {}
  const cost = costOf(data.cost)
  const timing = timingOf(data.timing)
  const unsupported = unsupportedOf(data.unsupported)
  const counts = countsOf(data.counts)
  const last = lastOf(data.last)
  const generatedReasoning = optNumOf(data.generatedReasoning)
  const generatedAnswerTokens = optNumOf(data.generatedAnswerTokens)
  const generatedCallTokens = optNumOf(data.generatedCallTokens)
  const safe: ContextTimeline = {
    ok: true,
    ...(unsupported !== null ? { unsupported } : {}),
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
    ...(typeof data.reasoningEffort === 'string' ? { reasoningEffort: data.reasoningEffort } : {}),
    ...(typeof data.contextWindow === 'number' ? { contextWindow: data.contextWindow } : {}),
    ...(typeof data.maxOutputTokens === 'number' && Number.isFinite(data.maxOutputTokens) && data.maxOutputTokens > 0
      ? { maxOutputTokens: data.maxOutputTokens }
      : {}),
    current: {
      system: numOf(safeCurrent.system),
      tools: numOf(safeCurrent.tools),
      user: numOf(safeCurrent.user),
      inject: numOf(safeCurrent.inject),
      skill: numOf(safeCurrent.skill),
      assistant: numOf(safeCurrent.assistant),
      assistantReasoning: numOf(safeCurrent.assistantReasoning),
      assistantAnswerTokens: numOf(safeCurrent.assistantAnswerTokens),
      assistantCallTokens: numOf(safeCurrent.assistantCallTokens),
      tool: numOf(safeCurrent.tool),
      total: numOf(safeCurrent.total),
    },
    ...collectionsOf(data),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
    ...(generatedReasoning !== undefined ? { generatedReasoning } : {}),
    ...(generatedAnswerTokens !== undefined ? { generatedAnswerTokens } : {}),
    ...(generatedCallTokens !== undefined ? { generatedCallTokens } : {}),
    ...(typeof data.toolCalls === 'number' ? { toolCalls: data.toolCalls } : {}),
    ...(typeof data.humanInputs === 'number' ? { humanInputs: data.humanInputs } : {}),
    ...(typeof data.answers === 'number' && Number.isFinite(data.answers) ? { answers: data.answers } : {}),
    ...(typeof data.lastUser === 'string' && data.lastUser !== '' ? { lastUser: data.lastUser.slice(0, 200) } : {}),
    ...(counts !== undefined ? { counts } : {}),
    ...(last !== undefined ? { last } : {}),
    ...(typeof data.detailRev === 'number' && Number.isFinite(data.detailRev) ? { detailRev: data.detailRev } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(timing !== null ? { timing } : {}),
    ...(data.systems !== undefined ? { systems: systemsOf(data.systems) } : {}),
  }
  return safe
}

function systemsOf(value: unknown): ContextTimeline['systems'] {
  const list = objectsOf<Record<string, unknown>>(value)
  const out: SystemPromptNode[] = []
  for (const entry of list) {
    const { seq, time, tokens } = entry
    if (typeof seq !== 'number' || !Number.isFinite(seq)) continue
    if (typeof time !== 'number' || !Number.isFinite(time)) continue
    if (typeof tokens !== 'number' || !Number.isFinite(tokens)) continue
    out.push({ seq, time, tokens })
  }
  return out.sort((a, b) => a.seq - b.seq)
}

function systemsFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (!Array.isArray(value)) return false
  return value.every((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    const { seq, time, tokens } = entry as Record<string, unknown>
    return typeof seq === 'number' && Number.isFinite(seq)
      && typeof time === 'number' && Number.isFinite(time)
      && typeof tokens === 'number' && Number.isFinite(tokens)
  })
}

function countsOf(value: unknown): ContextTimeline['counts'] {
  const data = asRecord(value)
  if (data === null) return undefined
  return {
    turns: numOf(data.turns),
    steps: numOf(data.steps),
    injects: numOf(data.injects),
    compactions: numOf(data.compactions),
    prunes: numOf(data.prunes),
    skills: numOf(data.skills),
  }
}

function lastOf(value: unknown): ContextTimeline['last'] {
  const data = asRecord(value)
  if (data === null) return undefined
  if (typeof data.seq !== 'number' || !Number.isFinite(data.seq)) return undefined
  if (typeof data.total !== 'number' || !Number.isFinite(data.total)) return undefined
  return {
    seq: data.seq,
    total: data.total,
    ...(typeof data.prompt === 'number' && Number.isFinite(data.prompt) ? { prompt: data.prompt } : {}),
  }
}

export function contextPressureOf(value: unknown): ContextPressure | null {
  const data = asRecord(value)
  if (data === null) return null
  const out: ContextPressure = {}
  if (typeof data.pressureTokens === 'number' && Number.isFinite(data.pressureTokens)) out.pressureTokens = data.pressureTokens
  if (typeof data.projectedTokens === 'number' && Number.isFinite(data.projectedTokens)) out.projectedTokens = data.projectedTokens
  if (typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)) out.contextWindow = data.contextWindow
  return out
}

export function contextBreakdownOf(value: unknown): ContextBreakdown | null {
  const data = asRecord(value)
  if (data === null) return null
  const { systemTokens, toolsTokens, messageTokens } = data
  if (typeof systemTokens !== 'number' || !Number.isFinite(systemTokens)) return null
  if (typeof toolsTokens !== 'number' || !Number.isFinite(toolsTokens)) return null
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens)) return null
  return { systemTokens, toolsTokens, messageTokens }
}

export function tokenUsageOf(value: unknown): TokenUsage | null {
  const data = asRecord(value)
  if (data === null) return null
  const { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = data
  if (typeof uncachedInputTokens !== 'number' || !Number.isFinite(uncachedInputTokens)) return null
  if (typeof outputTokens !== 'number' || !Number.isFinite(outputTokens)) return null
  if (typeof cacheReadTokens !== 'number' || !Number.isFinite(cacheReadTokens)) return null
  if (typeof cacheWriteTokens !== 'number' || !Number.isFinite(cacheWriteTokens)) return null
  return { uncachedInputTokens, outputTokens, cacheReadTokens, cacheWriteTokens }
}

function msNumOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

function optNumOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function timingFastOk(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const t = value as Record<string, unknown>
  for (const k of ['wallMs', 'ttftMs', 'genMs', 'calls', 'toolsMs', 'toolCalls']) {
    if (typeof t[k] !== 'number') return false
  }
  for (const k of ['reasoningMs', 'textMs', 'toolArgMs', 'reasoningBlocks', 'textBlocks', 'toolArgBlocks', 'toolBusyMs', 'idleMs']) {
    const v = t[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) return false
  }
  const tools = t.tools
  if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) return false
  for (const k in tools) {
    const row = (tools as Record<string, unknown>)[k]
    if (row === null || typeof row !== 'object') return false
    if (typeof (row as Record<string, unknown>).calls !== 'number') return false
    if (typeof (row as Record<string, unknown>).ms !== 'number') return false
  }
  return true
}

export function timingOf(value: unknown): TimingTotals | null {
  const data = asRecord(value)
  if (data === null) return null
  const tools: Record<string, ToolTimingTotals> = {}
  const rawTools = data.tools
  if (rawTools !== null && typeof rawTools === 'object' && !Array.isArray(rawTools)) {
    for (const k in rawTools) {
      if (k === '__proto__' || !Object.hasOwn(rawTools, k)) continue
      const row = (rawTools as Record<string, unknown>)[k]
      if (row === null || typeof row !== 'object') continue
      const calls = (row as Record<string, unknown>).calls
      const ms = (row as Record<string, unknown>).ms
      if (typeof calls !== 'number' || !(calls >= 0) || typeof ms !== 'number' || !(ms >= 0)) continue
      tools[k] = { calls, ms }
    }
  }
  const totals: TimingTotals = {
    wallMs: msNumOf(data.wallMs),
    ttftMs: msNumOf(data.ttftMs),
    genMs: msNumOf(data.genMs),
    calls: msNumOf(data.calls),
    toolsMs: msNumOf(data.toolsMs),
    toolCalls: msNumOf(data.toolCalls),
    tools,
  }
  const reasoning = optNumOf(data.reasoningMs)
  if (reasoning !== undefined) totals.reasoningMs = reasoning
  const reasoningBlocks = optNumOf(data.reasoningBlocks)
  if (reasoningBlocks !== undefined) totals.reasoningBlocks = reasoningBlocks
  const textMs = optNumOf(data.textMs)
  if (textMs !== undefined) totals.textMs = textMs
  const textBlocks = optNumOf(data.textBlocks)
  if (textBlocks !== undefined) totals.textBlocks = textBlocks
  const toolArgMs = optNumOf(data.toolArgMs)
  if (toolArgMs !== undefined) totals.toolArgMs = toolArgMs
  const toolArgBlocks = optNumOf(data.toolArgBlocks)
  if (toolArgBlocks !== undefined) totals.toolArgBlocks = toolArgBlocks
  const toolBusyMs = optNumOf(data.toolBusyMs)
  if (toolBusyMs !== undefined) totals.toolBusyMs = toolBusyMs
  const idleMs = optNumOf(data.idleMs)
  if (idleMs !== undefined) totals.idleMs = idleMs
  return totals
}

export function activeMsOf(timing: TimingTotals | null | undefined): number {
  const wall = timing !== null && timing !== undefined && Number.isFinite(timing.wallMs) && timing.wallMs > 0
    ? timing.wallMs
    : 0
  const idle = timing?.idleMs
  const carved = idle !== undefined && Number.isFinite(idle) && idle > 0 ? Math.min(idle, wall) : 0
  return wall - carved
}

export function headersOf(value: unknown): ContextHeaders | null {
  const headers = asRecord(value)
  if (headers === null || !Array.isArray(headers.headers)) return null
  for (const h of headers.headers as unknown[]) {
    if (h === null || typeof h !== 'object') return null
    const entry = h as { tools?: unknown; systemTokens?: unknown }
    if (!Array.isArray(entry.tools)) return null
    if (entry.systemTokens !== undefined && (typeof entry.systemTokens !== 'number' || !Number.isFinite(entry.systemTokens))) return null
    for (const t of entry.tools as unknown[]) {
      if (t === null || typeof t !== 'object') return null
      const tool = t as { name?: unknown; tokens?: unknown; plugin?: unknown }
      if (typeof tool.name !== 'string') return null
      if (typeof tool.tokens !== 'number' || !Number.isFinite(tool.tokens)) return null
      if (tool.plugin !== undefined && typeof tool.plugin !== 'string') return null
    }
  }
  let legacy = false
  for (const entry of headers.headers as { systemTokens?: unknown; system?: unknown }[]) {
    if (entry.systemTokens === undefined && typeof entry.system === 'string' && entry.system !== '') {
      legacy = true
      break
    }
  }
  if (!legacy) return headers as unknown as ContextHeaders
  return {
    headers: (headers.headers as { systemTokens?: number; system?: unknown }[]).map((entry) => {
      if (entry.systemTokens !== undefined) return entry
      return { ...entry, systemTokens: estimateSystemTokens(entry.system) || undefined }
    }),
  } as unknown as ContextHeaders
}

export function activityOf(value: unknown): ContextActivity | null {
  const data = asRecord(value)
  if (data === null) return null
  const rawDays = asRecord(data.days)
  if (rawDays === null || Array.isArray(rawDays)) return null
  let drops: Set<string> | null = null
  let fixes: Map<string, ActivityDay> | null = null
  for (const key in rawDays) {
    if (!Object.hasOwn(rawDays, key)) continue
    const repaired = dayEntryOf(key, rawDays[key])
    if (repaired === undefined) (drops ??= new Set()).add(key)
    else if (repaired !== rawDays[key]) (fixes ??= new Map()).set(key, repaired)
  }
  if (drops === null && fixes === null) return data as unknown as ContextActivity
  const days: Record<string, ActivityDay> = {}
  for (const key of Object.keys(rawDays)) {
    if (drops?.has(key) === true) continue
    days[key] = fixes?.get(key) ?? rawDays[key] as ActivityDay
  }
  return { days }
}

const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/

function dayEntryOf(key: string, raw: unknown): ActivityDay | undefined {
  const entry = asRecord(raw)
  const tokens = entry?.tokens
  const requests = entry?.requests
  if (!DAY_KEY.test(key)
    || entry === null || Array.isArray(entry)
    || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
    || typeof requests !== 'number' || !Number.isFinite(requests) || requests < 0) {
    return undefined
  }
  const turns = nonNegativeOf(entry.turns)
  const toolCalls = nonNegativeOf(entry.toolCalls)
  const toolsMs = nonNegativeOf(entry.toolsMs)
  const wallMs = nonNegativeOf(entry.wallMs)
  const clean = costWellFormed(entry.cost)
    && talliesWellFormed(entry.skills)
    && talliesWellFormed(entry.tools)
    && talliesWellFormed(entry.cmds)
    && (entry.turns === undefined || turns !== undefined)
    && (entry.toolCalls === undefined || toolCalls !== undefined)
    && (entry.toolsMs === undefined || toolsMs !== undefined)
    && (entry.wallMs === undefined || wallMs !== undefined)
  if (clean) return entry as unknown as ActivityDay
  const costRaw = costOf(entry.cost)
  const cost = costRaw !== undefined && Object.keys(costRaw).length > 0 ? costRaw : undefined
  const skills = talliesOf(entry.skills)
  const tools = talliesOf(entry.tools)
  const cmds = talliesOf(entry.cmds)
  return {
    tokens,
    requests,
    ...(cost !== undefined ? { cost } : {}),
    ...(turns !== undefined ? { turns } : {}),
    ...(toolCalls !== undefined ? { toolCalls } : {}),
    ...(toolsMs !== undefined ? { toolsMs } : {}),
    ...(wallMs !== undefined ? { wallMs } : {}),
    ...(skills !== undefined ? { skills } : {}),
    ...(tools !== undefined ? { tools } : {}),
    ...(cmds !== undefined ? { cmds } : {}),
  }
}

function nonNegativeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function costWellFormed(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const provider in data) {
    if (!Object.hasOwn(data, provider)) continue
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) return false
    any = true
    for (const model in models) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) return false
      for (const period of ['peak', 'off'] as const) {
        const raw = periods[period]
        if (raw === undefined) continue
        const bucket = asRecord(raw)
        if (bucket === null || Array.isArray(bucket)) return false
        for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
          const v = bucket[k]
          if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v))) return false
        }
      }
    }
  }
  return any
}

function talliesWellFormed(value: unknown): boolean {
  if (value === undefined) return true
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const name in data) {
    if (!Object.hasOwn(data, name)) continue
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return false
    if (typeof last !== 'number' || !Number.isFinite(last)) return false
    any = true
  }
  return any
}

export function costFullyQuantified(value: unknown): boolean {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  let any = false
  for (const provider of Object.keys(data)) {
    if (provider === '__proto__') return false
    const models = asRecord(data[provider])
    if (models === null || Array.isArray(models)) return false
    for (const model of Object.keys(models)) {
      if (model === '__proto__') return false
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) return false
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        for (const k of ['uncached', 'cacheRead', 'cacheWrite', 'output']) {
          const v = bucket[k]
          if (typeof v !== 'number' || !Number.isFinite(v)) return false
        }
        any = true
      }
    }
  }
  return any
}

function talliesOf(value: unknown): Record<string, ActivityTally> | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const tallies: Record<string, ActivityTally> = {}
  let any = false
  for (const name of Object.keys(data)) {
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || typeof last !== 'number' || !Number.isFinite(last)) continue
    tallies[name] = { n, last }
    any = true
  }
  return any ? tallies : undefined
}
