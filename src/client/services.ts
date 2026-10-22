/** The harness web-half surface this plugin consumes, plus the sanitizers that re-prove every delivered value. */

import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { AttachmentRef } from '../shared/attachment'
import { estimateSystemTokens } from '../shared/estimate'
import { PLUGIN_NAME } from './meta'
import type { ActivityDay, ContextActivity, ContextBreakdown, ContextHeaders, ContextPressure, ContextTimeline, ContextTimelineDetail, CostModelUsage, HeaderEpochContent, SystemPromptNode, TimingTotals, TokenUsage, ToolTimingTotals } from '../shared/types'

export interface LocaleService {
  register(ns: string, dicts: Record<string, Record<string, string>>): () => void
  bind(ns: string): (key: string, params?: Record<string, string | number>) => string
  getLocale?(): { active: string }
}

export interface SlotRegistration {
  name: string
  id?: string
  order?: number
  key?: string
  /** Dictionary namespace; the framework synthesizes the `t` seat from it. */
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
  /** The slot ledger's raw entries view (`SlotCore.entries`); optional: an older face mounts without the second-mount guard
   * (docs/compatibility.md §5). */
  entries?(name: string): unknown
}

/** Fail-open: an absent, shape-shifted, or hostile ledger reports false, so the mount proceeds and never blanks a working one. */
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

/** The harness `SidebarRightGuideEntry` subset a right-Sidebar tab type contributes. */
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

/** `ctx.sidebarRightTabs` through a deferred inject: absent → composes fully (docs/compatibility.md §5). */
export interface SidebarTabsFace {
  register(definition: SidebarTabDefinitionLike): () => void
}

/** The harness's `SidebarRightOpenResourceOptions`: the opening type's name and the fresh-pane claim. */
export interface SidebarResourceOpenOptions {
  kind?: string
  preferNewPane?: boolean
}

/** `ctx.sidebarRight.openResource` claims a `dsh-resource://…` address; an absent or refusing face falls back. */
export interface SidebarResourceFace {
  openResource(address: string, options?: SidebarResourceOpenOptions): void
}

/** A finalized chat node carries its source surface event's `seq`; the browser joins nodes on it, never on projected content. */
export interface ConversationNodeLike {
  kind: string
  seq: number
  /** Durable message id; absent on synthetic/interrupted replies. */
  messageId?: unknown
  content?: readonly unknown[]
  blocks?: readonly unknown[]
  call?: { name: string; argsRaw: string } | null
  isError?: boolean
  summary?: string | null
  /** Nested dsh ToolCallBlock[] tree of a PTC `run_code` dispatch; re-proved structurally in fileActivity. */
  subCalls?: readonly unknown[]
  meta?: unknown
}

/** dsh's `ImageAttachmentRef`, re-typed to avoid an attachment-package dependency; the log never holds inline bytes. */
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
  } catch { /* absent or hostile service — metadata-only cards */ }
  return undefined
}

export type AttachmentLocator = (attachment: AttachmentRef) => Promise<string | null>

export type AttachmentOpener = (attachment: AttachmentRef) => Promise<boolean>

/** The `useChat` seat: the selector must return a reference-stable slice, or every event re-renders the view. */
export type UseChatLike = <T>(selector: (snapshot: unknown) => T) => T

export function conversationNodesOf(props: {
  useChat?: UseChatLike
}): readonly ConversationNodeLike[] | undefined {
  const useChat: unknown = props.useChat
  if (typeof useChat !== 'function') return undefined
  try {
    // `s.legacy` is a stable object; the array is read outside the selector.
    const slice = (useChat as UseChatLike)((s: unknown) =>
      s !== null && typeof s === 'object' ? (s as { legacy?: unknown }).legacy : undefined)
    const nodes = slice !== null && typeof slice === 'object' ? (slice as { nodes?: unknown }).nodes : undefined
    return Array.isArray(nodes) ? nodes as readonly ConversationNodeLike[] : undefined
  } catch { /* hostile seat — the join degrades to nothing */ }
  return undefined
}

/** The framework standard kit of a session-scope slot component. */
export interface SessionStandardProps {
  sessionId?: string
  useProjection?: (key: string) => unknown
  useChat?: UseChatLike
}

export interface ContextViewProps extends SessionStandardProps {
  /** Set only by the right-Sidebar registration, which drops the head cards a narrow column cannot serve. */
  host?: 'sidebar'
}

/** The seat is a hook: call it unconditionally, one call per key, in a stable order. */
export function projectionOf<T>(props: SessionStandardProps, key: string, narrow: (value: unknown) => T | null): T | null {
  if (typeof props.useProjection !== 'function') return null
  return narrow(props.useProjection(key))
}

export type ClientCtx = Context & {
  locale: LocaleService
  slots: SlotsService
}

/** The type is `unknown` on purpose: every field read re-proves itself before borrowing a wire type. */
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

/** The collection/floor block shared by the full snapshot (timelineOf) and the split detail (timelineSource.ts). */
export function collectionsOf(data: Record<string, unknown>): Pick<ContextTimeline,
  'requests' | 'events' | 'nodes' | 'droppedNodes' | 'archive'
  | 'surfaceFloor' | 'archiveFloor' | 'fileOps' | 'fileOpsFloor' | 'spans'> {
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
    ...(data.spans !== undefined ? { spans: objectsOf(data.spans) } : {}),
  }
}

/** The slim head with the detail payload's collections in place; slim heads serve no floors, so the detail's land whole. */
export function withDetail(base: ContextTimeline, detail: ContextTimelineDetail): ContextTimeline {
  return {
    ...base,
    requests: detail.requests,
    events: detail.events,
    nodes: detail.nodes,
    droppedNodes: detail.droppedNodes,
    archive: detail.archive,
    ...(detail.surfaceFloor !== undefined ? { surfaceFloor: detail.surfaceFloor } : {}),
    ...(detail.archiveFloor !== undefined ? { archiveFloor: detail.archiveFloor } : {}),
    ...(detail.fileOps !== undefined ? { fileOps: detail.fileOps } : {}),
    ...(detail.fileOpsFloor !== undefined ? { fileOpsFloor: detail.fileOpsFloor } : {}),
    ...(detail.spans !== undefined ? { spans: detail.spans } : {}),
  }
}

/** A null/primitive entry passes a bare `Array.isArray` yet throws on the first property read, so it takes the sanitizing slow path. */
function recordsOnly(value: unknown): boolean {
  return Array.isArray(value) && value.every(e => e !== null && typeof e === 'object')
}

export function unsupportedOf(value: unknown): { current: string; minimum: string } | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.current !== 'string' || typeof data.minimum !== 'string') return null
  return { current: data.current, minimum: data.minimum }
}

/** An unproved branch drops whole and its buckets zero out, so garbage prices as zero, never NaN. */
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

/** Non-record → null (the loading screen); a malformed record is SANITIZED so render cannot throw and unmount the conversation view. */
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
    // The untouched pass-through keeps the value reference-stable for the selector equality.
    return data as unknown as ContextTimeline
  }
  const safeCurrent: Record<string, unknown> = current !== null && typeof current === 'object' ? current as Record<string, unknown> : {}
  const cost = costOf(data.cost)
  const timing = timingOf(data.timing)
  const unsupported = unsupportedOf(data.unsupported)
  const counts = countsOf(data.counts)
  const last = lastOf(data.last)
  const safe: ContextTimeline = {
    ok: true,
    ...(unsupported !== null ? { unsupported } : {}),
    ...(typeof data.model === 'string' ? { model: data.model } : {}),
    ...(typeof data.provider === 'string' ? { provider: data.provider } : {}),
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
      tool: numOf(safeCurrent.tool),
      total: numOf(safeCurrent.total),
    },
    ...collectionsOf(data),
    ...(typeof data.images === 'number' ? { images: data.images } : {}),
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

/** An absent value stays absent (legacy generation): callers then derive the counts from the collections. */
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

/** Each field is an independent last-wins record of a different moment (dsh's `ContextPressureProjection`); an absent one sends callers
 * to their derived anchor. */
export function contextPressureOf(value: unknown): ContextPressure | null {
  const data = asRecord(value)
  if (data === null) return null
  const out: ContextPressure = {}
  if (typeof data.pressureTokens === 'number' && Number.isFinite(data.pressureTokens)) out.pressureTokens = data.pressureTokens
  if (typeof data.projectedTokens === 'number' && Number.isFinite(data.projectedTokens)) out.projectedTokens = data.projectedTokens
  if (typeof data.contextWindow === 'number' && Number.isFinite(data.contextWindow)) out.contextWindow = data.contextWindow
  return out
}

/** A partial value degrades to null so the card uses the fold's own sums. */
export function contextBreakdownOf(value: unknown): ContextBreakdown | null {
  const data = asRecord(value)
  if (data === null) return null
  const { systemTokens, toolsTokens, messageTokens } = data
  if (typeof systemTokens !== 'number' || !Number.isFinite(systemTokens)) return null
  if (typeof toolsTokens !== 'number' || !Number.isFinite(toolsTokens)) return null
  if (typeof messageTokens !== 'number' || !Number.isFinite(messageTokens)) return null
  return { systemTokens, toolsTokens, messageTokens }
}

/** dsh token-meter's `projectionSchema` requires all four buckets, so a partial value degrades whole to null rather than undercount. */
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

/** NaN or negative degrades to 0 instead of leaking into donut shares. */
function msNumOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/** Anything but a non-negative number stays undefined, so the field never materializes as a zero. */
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
  // Optional split/block scalars must pass the same non-negative gate the slow path applies.
  for (const k of ['reasoningMs', 'textMs', 'toolArgMs', 'reasoningBlocks', 'textBlocks', 'toolArgBlocks']) {
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

/** One row failing the shape drops alone, so it never blanks the ranking. */
export function timingOf(value: unknown): TimingTotals | null {
  const data = asRecord(value)
  if (data === null) return null
  const tools: Record<string, ToolTimingTotals> = {}
  const rawTools = data.tools
  if (rawTools !== null && typeof rawTools === 'object' && !Array.isArray(rawTools)) {
    for (const k in rawTools) {
      // An own '__proto__' key would set the prototype instead of a row.
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
  // Optional scalars stay absent when the host served none, so the card renders the un-split shape instead of meaningless zeros.
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
  return totals
}

/** The `contextHeaders` projection: epoch METADATA only (CONTENT is fetched on demand, historyPage.ts). A pre-#37 host
 * serving from its cache carries the system TEXT in place of the token price, so the legacy arm estimates it; one
 * malformed epoch degrades the WHOLE projection to null because downstream reads index blindly. */
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

/** Absent stays null (an older host serves no such key); per-day re-proof drops just the bad entry or fee. */
export function activityOf(value: unknown): ContextActivity | null {
  const data = asRecord(value)
  if (data === null) return null
  const rawDays = asRecord(data.days)
  if (rawDays === null || Array.isArray(rawDays)) return null
  const days: Record<string, ActivityDay> = {}
  let dirty = false
  for (const key of Object.keys(rawDays)) {
    const entry = asRecord(rawDays[key])
    const tokens = entry?.tokens
    const requests = entry?.requests
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)
      || entry === null || Array.isArray(entry)
      || typeof tokens !== 'number' || !Number.isFinite(tokens) || tokens < 0
      || typeof requests !== 'number' || !Number.isFinite(requests) || requests < 0) {
      dirty = true
      continue
    }
    const proved = costOf(entry.cost)
    const cost = proved !== undefined && Object.keys(proved).length > 0 ? proved : undefined
    if (entry.cost !== undefined && cost === undefined) dirty = true
    const skills = skillTalliesOf(entry.skills)
    if (entry.skills !== undefined && skills === undefined) dirty = true
    const turns = nonNegativeOf(entry.turns)
    const toolCalls = nonNegativeOf(entry.toolCalls)
    const toolsMs = nonNegativeOf(entry.toolsMs)
    const wallMs = nonNegativeOf(entry.wallMs)
    if ((entry.turns !== undefined && turns === undefined)
      || (entry.toolCalls !== undefined && toolCalls === undefined)
      || (entry.toolsMs !== undefined && toolsMs === undefined)
      || (entry.wallMs !== undefined && wallMs === undefined)) dirty = true
    days[key] = {
      tokens,
      requests,
      ...(cost !== undefined ? { cost } : {}),
      ...(turns !== undefined ? { turns } : {}),
      ...(toolCalls !== undefined ? { toolCalls } : {}),
      ...(toolsMs !== undefined ? { toolsMs } : {}),
      ...(wallMs !== undefined ? { wallMs } : {}),
      ...(skills !== undefined ? { skills } : {}),
    }
  }
  return dirty ? { days } : data as unknown as ContextActivity
}

function nonNegativeOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function skillTalliesOf(value: unknown): ActivityDay['skills'] | undefined {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return undefined
  const skills: Record<string, { n: number; last: number }> = {}
  let any = false
  for (const name of Object.keys(data)) {
    const tally = asRecord(data[name])
    const n = tally?.n
    const last = tally?.last
    if (typeof n !== 'number' || !Number.isFinite(n) || n < 0
      || typeof last !== 'number' || !Number.isFinite(last)) continue
    skills[name] = { n, last }
    any = true
  }
  return any ? skills : undefined
}

export interface TriggerCandidate {
  name: string
  /** Display title; absent = the name itself (a differing title renders the name as a trailing alias). */
  label?: string
  /** Visual heading of this candidate's group; its presence suppresses the menu's source-title row. */
  section?: string
  description?: string
  icon?: ComponentType<{ size?: number }>
}

/** Pick-moment snapshot of the trigger token span (draftRev CAS). */
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

/** The harness input-trigger service (`ctx.inputTriggers`): one '/' source whose candidates, picks, and enter stay client-side. */
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

/** The session scope (`ctx.sessions.scope`), used to dispatch the scoped consume-token event. */
export interface SessionScopeFace {
  bail(subject: unknown, event: string, payload: unknown): unknown
}

export interface SessionsFace {
  scope(id: string): SessionScopeFace | undefined
  refresh?(): Promise<unknown>
}

export interface HistoryEntryLike {
  event?: unknown
}

/** The gateway's `remote.session.page`: `throughSeq` inclusive and must exist in the log, `beforeSeq` exclusive; packed `chunks` runs are
 * skipped. */
export interface SessionPageFace {
  page(request: {
    address: { kind: 'session'; sessionId: string }
    throughSeq: number
    beforeSeq?: number
    maxMessages?: number
  }, signal?: AbortSignal): Promise<unknown>
}

/** The connection service face: the generic RPC caller and the loopback fact the harness's own open affordances gate on. */
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
  } catch { /* absent or hostile connection — the caller degrades off */ }
  return undefined
}

/** The SESSION's cwd from its session-list row, not the host process's launch directory. */
export function workspaceOf(ctx: ClientCtx, sessionId: string | undefined): string | undefined {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  // Host data: a hostile object may throw on the call or on property access.
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

/** Loopback AND the session controller's opener capability over an RPC round-trip; every absence, hostility, or transport failure
 * resolves false. */
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
      // `args` is keyed by the remote's declared parameter names; the gateway rejects an array.
      void call(OPEN_CHANNEL, OPEN_ENDPOINT, { args: { request: { path } } })
        .catch(() => { /* the open is best-effort; a failure stays silent */ })
    } catch { /* same contract, for a synchronously throwing transport */ }
  }
}

/** `openResource` throws for an unclaimed address or with no session surface, so the boolean says whether it was taken. */
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

/** Jump through the view owner's own selection verb (`uiWorkspace.openSession`); the sessions service carries no selection verb. */
export function openSessionVia(ctx: ClientCtx, id: string): void {
  try {
    const workspace = asRecord(ctx.get('uiWorkspace'))
    const open = workspace?.openSession
    if (typeof open === 'function') open.call(workspace, id)
  } catch { /* absent or hostile face — the jump is best-effort */ }
}

/** Jump to this bundle's page on the Plugins panel through the panel's own navigator: it selects the panel and resets the
 * remembered tab, so a contributed `plugins.tab` left selected cannot swallow the jump (docs/compatibility.md §5.5). */
export function openPluginSettings(ctx: ClientCtx): void {
  try {
    const navigation = asRecord(ctx.get('pluginNavigation'))
    const open = navigation?.openBundle
    if (typeof open === 'function') open.call(navigation, PLUGIN_NAME)
  } catch { /* absent or hostile face — the jump is best-effort */ }
}

/** Replicated verbatim from the shipped subagent catalog's "open in sidebar" verb (the host publishes no helper): its parser accepts only
 * this form. */
export function subagentChatAddressOf(address: { parentSessionId: string; childSessionId: string; mode: string }): string {
  const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
  return `dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`
}

/** The direct parent is the row's own edge; a row without its subagent projection rides the harness's own `unknown` mode. */
export interface SubagentAddressLike {
  parentSessionId?: string
  childSessionId: string
  mode?: 'one-shot' | 'continuable' | 'unknown'
}

/** The shipped catalog's aside verb (kind `subagentchat`, a new pane); false keeps the caller's whole-view jump. */
export function openChildAsideVia(ctx: ClientCtx, address: SubagentAddressLike): boolean {
  const { parentSessionId, childSessionId, mode } = address
  if (parentSessionId === undefined) return false
  const open = openResourceVia(ctx)
  return open !== undefined && open(
    subagentChatAddressOf({ parentSessionId, childSessionId, mode: mode ?? 'unknown' }),
    { kind: 'subagentchat', preferNewPane: true },
  )
}

/** On-demand content for one surface-node seq: `null` when the durable log lacks the seq, rejects on transport failure. */
export type ContentFetcher = (seq: number) => Promise<ConversationNodeLike | null>

/** On-demand system prompt and tool schemas for one `contextHeaders` epoch seq (historyPage.ts); `null` when the log lacks the epoch. */
export type HeaderFetcher = (seq: number) => Promise<HeaderEpochContent | null>
