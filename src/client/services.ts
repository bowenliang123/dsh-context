import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { AttachmentRef } from '../shared/attachment'
import { estimateSystemTokens } from '../shared/estimate'
import { PLUGIN_NAME } from './meta'
import type { ActivityDay, ActivityTally, ContextActivity, ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, CostModelUsage, HeaderEpochContent, SystemPromptNode, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
  subscribe?(listener: () => void): () => void
}

export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  key?: string
  locale?: string
  label?: () => string
  inject?: (sessionId?: string) => unknown
}

export interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(
    registration: SlotRegistration,
    component: (props: { sessionId?: string } & Record<string, unknown>) => unknown,
  ): unknown
  entries?(name: string): unknown
}

export function entrySeated(ctx: ClientCtx, name: string, id: string): boolean {
  try {
    const entries = ctx.slots.entries?.(name)
    if (!Array.isArray(entries)) return false
    for (const entry of entries) {
      const options = asRecord(asRecord(entry)?.options)
      if (options !== null && options.id === id) return true
    }
    return false
  } catch {
    return false
  }
}

export interface SidebarGuideEntryLike {
  order: number
  title: () => string
  description?: () => string
  icon?: ComponentType<{ size?: number }>
}

export interface SidebarTabDefinitionLike {
  id: string
  kind: string
  title: () => string
  guide?: readonly SidebarGuideEntryLike[]
}

export interface SidebarTabsFace {
  register(definition: SidebarTabDefinitionLike): () => void
}

export interface SidebarResourceOpenOptions {
  kind?: string
  preferNewPane?: boolean
}

export interface SidebarResourceFace {
  openResource(address: string, options?: SidebarResourceOpenOptions): void
}

export interface ConversationNodeLike {
  kind: string
  seq: number
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  subCalls?: readonly unknown[]
  meta?: unknown
}

export interface ImageRefLike {
  attachmentId: string
  name?: string
  bytes?: number
  width?: number
  height?: number
  originalDimensions?: { width: number; height: number }
}

export type ImageLoader = (attachment: ImageRefLike) => Promise<string>

export interface UiConversationFace {
  imageUrl?(sessionId: string, attachment: ImageRefLike): Promise<string>
}

export function imageLoaderOf(
  ctx: ClientCtx,
  sessionId: string | undefined,
): ImageLoader | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const conversation = ctx.get('uiConversation') as UiConversationFace | undefined
    if (conversation !== undefined && typeof conversation.imageUrl === 'function') {
      const imageUrl = conversation.imageUrl.bind(conversation)
      return attachment => imageUrl(sessionId, attachment)
    }
  } catch {}
  return undefined
}

export type AttachmentLocator = (attachment: AttachmentRef) => Promise<string | null>

export type AttachmentOpener = (attachment: AttachmentRef) => Promise<boolean>

export type UseChatLike = <T>(selector: (snapshot: unknown) => T) => T

export function conversationNodesOf(props: {
  useChat?: UseChatLike
}): readonly ConversationNodeLike[] | undefined {
  const useChat: unknown = props.useChat
  if (typeof useChat !== 'function') return undefined
  try {
    const slice = (useChat as UseChatLike)((s: unknown) =>
      s !== null && typeof s === 'object' ? (s as { legacy?: unknown }).legacy : undefined)
    const nodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes as readonly ConversationNodeLike[] : undefined
  } catch {}
  return undefined
}

export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  useChat?: UseChatLike
}

export interface ContextViewProps extends SessionStandardProps {
  host?: 'sidebar'
}

export function projectionOf<T>(props: SessionStandardProps, key: string, narrow: (value: unknown) => T | null): T | null {
  if (typeof props.useProjection !== 'function') return null
  return narrow(props.useProjection(key))
}

export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined || typeof value !== 'object') return null
  return value as Record<string, unknown>
}

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

export interface TriggerCandidate {
  name: string
  label?: string
  section?: string
  description?: string
  icon?: ComponentType<{ size?: number }>
}

export interface TokenSpan {
  start: number
  end: number
  draftRev: number
}

export interface TriggerPick {
  candidate: TriggerCandidate
  session: { sessionId: string }
  position: string
  via: string
  span: TokenSpan
}

export type SourcePickOutcome = 'handled' | undefined

export interface InputTriggersFace {
  registerSource(src: {
    trigger: '/'
    name: string
    order?: number
    candidates(
      session: { sessionId: string },
      req: { query: string; position: string; signal: AbortSignal },
    ): Promise<readonly TriggerCandidate[]>
    onPick(pick: TriggerPick): SourcePickOutcome
    matchEnter?(
      session: { sessionId: string },
      line: string,
      signal: AbortSignal,
    ): Promise<SourcePickOutcome>
  }): () => void
}

export interface SessionScopeFace {
  bail(subject: unknown, event: string, payload: unknown): unknown
}

export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
  refresh?(): Promise<unknown>
  subagentAddress?(id: string): unknown
}

export interface HistoryEntryLike {
  event?: unknown
}

export type SessionAddressLike =
  | { kind: 'session'; sessionId: string }
  | {
    kind: 'subagent'
    parentSessionId: string
    childSessionId: string
    mode: 'one-shot' | 'continuable' | 'unknown'
  }

export interface SessionPageFace {
  page(request: {
    address: SessionAddressLike
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}

export interface ConnectionFace {
  isLoopback?: boolean
  rpc?: {
    call?(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<unknown>
  }
}

const OPEN_CHANNEL = '/api'
const CAN_OPEN_ENDPOINT = 'session/canOpenWorkspacePath'
const OPEN_ENDPOINT = 'session/openWorkspacePath'

function rpcCallOf(ctx: ClientCtx): ((channel: string, endpoint: string, payload: unknown) => Promise<unknown>) | undefined {
  try {
    const rpc = asRecord((ctx.get('connection') as ConnectionFace | undefined)?.rpc)
    const fn = rpc?.call
    if (rpc !== null && typeof fn === 'function') {
      return (fn as (channel: string, endpoint: string, payload: unknown) => Promise<unknown>).bind(rpc)
    }
  } catch {}
  return undefined
}

export function workspaceOf(ctx: ClientCtx, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const sessions = ctx.get('sessions') as { list?: { getSnapshot(): unknown } } | undefined
    const snapshot = typeof sessions?.list?.getSnapshot === 'function' ? sessions.list.getSnapshot() : undefined
    const byId = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { byId?: unknown }).byId : undefined
    const row: unknown = byId !== null && typeof byId === 'object' ? (byId as Record<string, unknown>)[sessionId] : undefined
    const cwd = row !== null && typeof row === 'object' ? (row as { cwd?: unknown }).cwd : undefined
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
  } catch {
    return undefined
  }
}

export function sessionAddressOf(ctx: ClientCtx, sessionId: string): SessionAddressLike {
  const plain: SessionAddressLike = { kind: 'session', sessionId }
  if (typeof sessionId !== 'string' || sessionId === '') return plain
  try {
    const sessions = asRecord(ctx.get('sessions'))
    if (sessions === null) return plain
    const resolve = sessions.subagentAddress
    const address = asRecord(typeof resolve === 'function' ? resolve.call(sessions, sessionId) : undefined)
    const parentSessionId = address?.parentSessionId
    if (typeof parentSessionId === 'string' && parentSessionId !== '' && parentSessionId !== sessionId) {
      const mode = address?.mode
      return {
        kind: 'subagent',
        parentSessionId,
        childSessionId: sessionId,
        mode: mode === 'one-shot' || mode === 'continuable' ? mode : 'unknown',
      }
    }
    const list = asRecord(sessions.list)
    const getSnapshot = list?.getSnapshot
    const snapshot = typeof getSnapshot === 'function' ? asRecord((getSnapshot as () => unknown).call(list)) : null
    const row = asRecord(asRecord(snapshot?.byId)?.[sessionId])
    const parentId = row?.parentId
    if (row?.origin === 'subagent' && typeof parentId === 'string' && parentId !== '' && parentId !== sessionId) {
      return { kind: 'subagent', parentSessionId: parentId, childSessionId: sessionId, mode: 'unknown' }
    }
  } catch {}
  return plain
}

export async function canOpenPathsOf(ctx: ClientCtx): Promise<boolean> {
  const call = rpcCallOf(ctx)
  if (call === undefined) return false
  try {
    const connection = ctx.get('connection') as ConnectionFace | undefined
    if (connection?.isLoopback !== true) return false
    const result = await call(OPEN_CHANNEL, CAN_OPEN_ENDPOINT, { args: {} })
    const r = asRecord(result)
    return r !== null && r.ok === true && r.value === true
  } catch {
    return false
  }
}

export function openPathVia(ctx: ClientCtx): ((path: string) => void) | undefined {
  const call = rpcCallOf(ctx)
  if (call === undefined) return undefined
  return (path: string): void => {
    try {
      void call(OPEN_CHANNEL, OPEN_ENDPOINT, { args: { request: { path } } })
        .catch(() => {})
    } catch {}
  }
}

export function openResourceVia(ctx: ClientCtx): ((address: string, options?: SidebarResourceOpenOptions) => boolean) | undefined {
  const faceOf = (): SidebarResourceFace | undefined => {
    try {
      const face = asRecord(ctx.get('sidebarRight'))
      return face !== null && typeof face.openResource === 'function'
        ? face as unknown as SidebarResourceFace
        : undefined
    } catch {
      return undefined
    }
  }
  if (faceOf() === undefined) return undefined
  return (address: string, options?: SidebarResourceOpenOptions): boolean => {
    const face = faceOf()
    if (face === undefined) return false
    try {
      face.openResource(address, options)
      return true
    } catch {
      return false
    }
  }
}

export function openSessionVia(ctx: ClientCtx, id: string): void {
  try {
    const workspace = asRecord(ctx.get('uiWorkspace'))
    const open = workspace?.openSession
    if (typeof open === 'function') open.call(workspace, id)
  } catch {}
}

export const CONTEXT_VIEW_ID = 'context'

export function seedConversationViewVia(sessionId: string, view: string): void {
  try {
    const key = `dsh.conversation.${sessionId}`
    let stored: Record<string, unknown> = {}
    try {
      const raw = localStorage.getItem(key)
      const parsed: unknown = raw !== null ? JSON.parse(raw) : null
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) stored = parsed as Record<string, unknown>
    } catch {}
    stored.view = view
    localStorage.setItem(key, JSON.stringify(stored))
  } catch {}
}

export function openPluginSettings(ctx: ClientCtx): void {
  try {
    const navigation = asRecord(ctx.get('pluginNavigation'))
    const open = navigation?.openBundle
    if (typeof open === 'function') open.call(navigation, PLUGIN_NAME)
  } catch {}
}

export function subagentChatAddressOf(address: { parentSessionId: string; childSessionId: string; mode: string }): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`
}

export interface SubagentAddressLike {
  parentSessionId?: string
  childSessionId: string
  mode?: 'one-shot' | 'continuable' | 'unknown'
}

export function openChildAsideVia(ctx: ClientCtx, address: SubagentAddressLike): boolean {
  const { parentSessionId, childSessionId, mode } = address
  if (parentSessionId === undefined) return false
  const open = openResourceVia(ctx)
  return open !== undefined && open(
    subagentChatAddressOf({ parentSessionId, childSessionId, mode: mode ?? 'unknown' }),
    { kind: 'subagentchat', preferNewPane: true },
  )
}

export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>

export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>
