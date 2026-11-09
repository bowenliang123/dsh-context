import type { Context } from '@deepseek-ai/cordis'
import { workspaceTitleOf } from '@deepseek-ai/dsh-util-workspace-path'
import { billedTokensOf, mergeCostUsage } from '../shared/pricing'
import type {
  ActivityDay,
  ActivityTally,
  ContextActivity,
  SessionCostUsage,
  Snapshot,
  TimingTotals,
} from '../shared/types'
import type { CachedSnapshotFace, SnapshotProjectionsFace } from './faces'
import { asRecord } from './record'
import { activityOf, currentOf, numOf, optionalNumOf, timingOf, usageOf } from './overviewDecode'

const OVERVIEW_KEYS = new Set<string>(['contextTimeline', 'contextActivity', 'title', 'sessionListMetadata'])

export interface HeaderFacts {
  id: string
  createdAt: number
  cwd?: string
  parentSession?: string
  origin?: 'subagent'
}

export interface HostTimeline {
  current: Snapshot['current'] | null
  total: number
  contextWindow?: number
  maxOutputTokens?: number
  model?: string
  turns: number
  steps?: number
  cost?: SessionCostUsage
  timing?: TimingTotals
  lastUser?: string
  generatedReasoning?: number
  generatedAnswerTokens?: number
  generatedCallTokens?: number
}

export interface HostSession {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  blank: boolean
  parentSession?: string
  origin?: 'subagent'
  timeline: HostTimeline | null
  activity: ContextActivity | null
  signature: string
}

export interface HostRow {
  session: HostSession
  archived: boolean
  group?: string
  running: boolean
  activity: ContextActivity | null
  family: HostSession[]
  familyCost: SessionCostUsage | null
  tokens: number
  createdDay?: string
}

export interface ScanEntry {
  id: string
  header: Record<string, unknown>
  facts: HeaderFacts
  live: boolean
  session: unknown
  signature: string
}

export interface CorpusScan {
  entries: ScanEntry[]
  revision: string
}

export interface WorkspaceState {
  archived: Set<string>
  groups: Map<string, string>
  titles: string[]
  signature: string
}

export interface RowFeed {
  revision: string
  sessions: Map<string, HostSession>
  rows: HostRow[] | null
}

function safeGet(get: ((id: string) => unknown) | undefined, id: string): unknown {
  if (get === undefined) return undefined
  try {
    return get(id)
  } catch {
    return undefined
  }
}

export function headerFactsOf(header: Record<string, unknown>): HeaderFacts | null {
  if (typeof header.id !== 'string' || header.id === '') return null
  const createdAt = typeof header.createdAt === 'number' && Number.isFinite(header.createdAt) ? header.createdAt : 0
  return {
    id: header.id,
    createdAt,
    ...(typeof header.cwd === 'string' && header.cwd !== '' ? { cwd: header.cwd } : {}),
    ...(typeof header.parentSession === 'string' && header.parentSession !== '' ? { parentSession: header.parentSession } : {}),
    ...(header.origin === 'subagent' ? { origin: 'subagent' as const } : {}),
  }
}

export function revisionOf(parts: readonly string[]): string {
  let hash = 0x811c9dc5
  for (const part of parts) {
    for (let index = 0; index < part.length; index++) {
      hash ^= part.charCodeAt(index)
      hash = Math.imul(hash, 0x01000193) >>> 0
    }
    hash ^= 0x1d
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return `r1-${hash.toString(36)}`
}

function sessionSeqOf(session: unknown): number {
  const seq = asRecord(session)?.seq
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : -1
}

export function corpusRevisionOf(
  listed: unknown,
  getSession: ((id: string) => unknown) | undefined,
  backfillVersion: number,
): string {
  return corpusOf(listed, getSession, backfillVersion).revision
}

export function scanEntriesOf(
  listed: unknown,
  getSession: ((id: string) => unknown) | undefined,
): ScanEntry[] {
  if (!Array.isArray(listed)) return []
  const entries: ScanEntry[] = []
  for (const record of listed) {
    const data = asRecord(record)
    if (data === null) continue
    const rawHeader = asRecord(data.header)
    if (rawHeader === null) continue
    const facts = headerFactsOf(rawHeader)
    if (facts === null) continue
    const session = safeGet(getSession, facts.id)
    const declaredLive = data.live === true
    const live = declaredLive && session !== undefined
    if (!live && facts.cwd === undefined) continue
    entries.push({ id: facts.id, header: rawHeader, facts, live, session, signature: '' })
  }
  entries.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  return entries
}

export function signaturesOf(
  entries: readonly ScanEntry[],
  coldSignatureOf: (entry: ScanEntry) => string,
): string {
  for (const entry of entries) {
    entry.signature = `${entry.id}\u0000${entry.facts.createdAt}\u0000${entry.facts.origin ?? ''}\u0000`
      + (entry.live ? `L${sessionSeqOf(entry.session)}` : coldSignatureOf(entry))
  }
  return revisionOf(entries.map(entry => entry.signature))
}

export function corpusOf(
  listed: unknown,
  getSession: ((id: string) => unknown) | undefined,
  backfillVersion: number,
): CorpusScan {
  const entries = scanEntriesOf(listed, getSession)
  return { entries, revision: signaturesOf(entries, () => `C${backfillVersion}`) }
}

export function workspaceOf(ctx: Context): WorkspaceState {
  const empty: WorkspaceState = { archived: new Set(), groups: new Map(), titles: [], signature: '' }
  const registry = asRecord(ctx.get('workspaceRegistry'))
  if (registry === null) return empty
  const titles: string[] = []
  const groups = new Map<string, string>()
  try {
    const list = typeof registry.list === 'function' ? (registry.list as () => unknown).bind(registry) : undefined
    const listed: unknown = list === undefined ? [] : list()
    if (Array.isArray(listed)) {
      for (const item of listed) {
        const workspace = asRecord(item)
        const title = typeof workspace?.title === 'string' && workspace.title !== '' ? workspace.title : undefined
        if (title === undefined || !Array.isArray(workspace?.sessionIds)) continue
        titles.push(title)
        for (const id of workspace.sessionIds) {
          if (typeof id === 'string' && id !== '' && !groups.has(id)) groups.set(id, title)
        }
      }
    }
  } catch {
    return empty
  }
  const archived = new Set<string>()
  try {
    const value: unknown = registry.archivedSessionIds
    if (Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === 'string' && id !== '') archived.add(id)
      }
    }
  } catch {
    return { archived, groups, titles, signature: revisionOf([titles.join('\u0001'), [...groups].map(([id, title]) => `${id}\u0000${title}`).join('\u0001')]) }
  }
  const signature = revisionOf([
    titles.join('\u0001'),
    [...groups].map(([id, title]) => `${id}\u0000${title}`).join('\u0001'),
    [...archived].sort().join('\u0001'),
  ])
  return { archived, groups, titles, signature }
}

function timelineOf(value: unknown): HostTimeline | null {
  const data = asRecord(value)
  if (data === null) return null
  const current = currentOf(data.current)
  const counts = asRecord(data.counts)
  const timeline: HostTimeline = {
    current,
    total: current?.total ?? 0,
    turns: counts === null ? 0 : numOf(counts.turns),
  }
  const steps = counts === null ? undefined : optionalNumOf(counts.steps)
  if (steps !== undefined) timeline.steps = steps
  const contextWindow = optionalNumOf(data.contextWindow)
  if (contextWindow !== undefined) timeline.contextWindow = contextWindow
  const maxOutputTokens = optionalNumOf(data.maxOutputTokens)
  if (maxOutputTokens !== undefined) timeline.maxOutputTokens = maxOutputTokens
  if (typeof data.model === 'string' && data.model !== '') timeline.model = data.model
  if (typeof data.lastUser === 'string' && data.lastUser !== '') timeline.lastUser = data.lastUser
  const cost = usageOf(data.cost)
  if (cost !== undefined) timeline.cost = cost
  const timing = timingOf(data.timing)
  if (timing !== undefined) timeline.timing = timing
  const reasoning = optionalNumOf(data.generatedReasoning)
  const answers = optionalNumOf(data.generatedAnswerTokens)
  const calls = optionalNumOf(data.generatedCallTokens)
  if (reasoning !== undefined) timeline.generatedReasoning = reasoning
  if (answers !== undefined) timeline.generatedAnswerTokens = answers
  if (calls !== undefined) timeline.generatedCallTokens = calls
  return timeline
}

function titleOf(value: unknown, cwd: string | undefined, id: string): string {
  if (typeof value === 'string' && value !== '') return value
  if (cwd !== undefined) {
    const base = workspaceTitleOf(cwd)
    if (base !== '') return base
  }
  return id
}

function sessionOf(
  entry: ScanEntry,
  cache: CachedSnapshotFace,
  projections: SnapshotProjectionsFace,
): { session: HostSession; cacheable: boolean } {
  let values: Record<string, unknown> | null = null
  let cacheable = true
  try {
    const block = entry.live
      ? projections.snapshot(entry.session, OVERVIEW_KEYS)
      : cache.cachedSnapshot(entry.header, OVERVIEW_KEYS)
    const served = asRecord(block?.values)
    values = served ?? {}
    cacheable = served !== null && (served.contextTimeline !== undefined || served.contextActivity !== undefined)
  } catch {
    values = null
    cacheable = false
  }
  return { session: hostSessionOf(entry.id, entry.facts, entry.signature, values), cacheable }
}

export function hostSessionOf(
  id: string,
  facts: HeaderFacts,
  signature: string,
  values: Record<string, unknown> | null,
): HostSession {
  const metadata = asRecord(values?.sessionListMetadata)
  const lastPromptAt = optionalNumOf(metadata?.lastPromptAt)
  const updatedAt = Math.max(facts.createdAt, lastPromptAt ?? 0)
  return {
    id,
    title: titleOf(values?.title, facts.cwd, id),
    updatedAt,
    blank: metadata?.blank === true,
    timeline: values === null ? null : timelineOf(values.contextTimeline),
    activity: values === null ? null : activityOf(values.contextActivity),
    signature,
    ...(facts.cwd === undefined ? {} : { cwd: facts.cwd }),
    ...(facts.parentSession === undefined ? {} : { parentSession: facts.parentSession }),
    ...(facts.origin === undefined ? {} : { origin: facts.origin }),
  }
}

function mergeActivity(members: readonly (ContextActivity | null)[]): ContextActivity | null {
  const days: Record<string, ActivityDay> = {}
  let any = false
  for (const activity of members) {
    if (activity === null) continue
    any = true
    for (const key of Object.keys(activity.days)) {
      const entry = activity.days[key]
      if (!Object.hasOwn(days, key)) {
        days[key] = {
          tokens: entry.tokens,
          requests: entry.requests,
          ...(entry.cost === undefined ? {} : { cost: entry.cost }),
          ...(entry.turns === undefined ? {} : { turns: entry.turns }),
          ...(entry.toolCalls === undefined ? {} : { toolCalls: entry.toolCalls }),
          ...(entry.toolsMs === undefined ? {} : { toolsMs: entry.toolsMs }),
          ...(entry.wallMs === undefined ? {} : { wallMs: entry.wallMs }),
          ...(entry.skills === undefined ? {} : { skills: entry.skills }),
          ...(entry.tools === undefined ? {} : { tools: entry.tools }),
          ...(entry.cmds === undefined ? {} : { cmds: entry.cmds }),
        }
        continue
      }
      const prev = days[key]
      prev.tokens += entry.tokens
      prev.requests += entry.requests
      for (const field of ['turns', 'toolCalls', 'toolsMs', 'wallMs'] as const) {
        if (entry[field] === undefined && prev[field] === undefined) continue
        prev[field] = (prev[field] ?? 0) + (entry[field] ?? 0)
      }
      if (entry.cost !== undefined) {
        prev.cost = mergeCostUsage(prev.cost, entry.cost) ?? entry.cost
      }
      if (entry.skills !== undefined) prev.skills = mergeTallies(prev.skills, entry.skills)
      if (entry.tools !== undefined) prev.tools = mergeTallies(prev.tools, entry.tools)
      if (entry.cmds !== undefined) prev.cmds = mergeTallies(prev.cmds, entry.cmds)
    }
  }
  if (!any) return null
  return { days }
}

function mergeTallies(
  left: Record<string, ActivityTally> | undefined,
  right: Record<string, ActivityTally>,
): Record<string, ActivityTally> {
  const out: Record<string, ActivityTally> = { ...left }
  for (const name of Object.keys(right)) {
    const tally = right[name]
    if (!Object.hasOwn(out, name)) {
      out[name] = tally
      continue
    }
    out[name] = { n: out[name].n + tally.n, last: Math.max(out[name].last, tally.last) }
  }
  return out
}

function childrenOf(sessions: readonly HostSession[]): Map<string, HostSession[]> {
  const children = new Map<string, HostSession[]>()
  for (const session of sessions) {
    if (session.origin !== 'subagent' || session.parentSession === undefined) continue
    const list = children.get(session.parentSession) ?? []
    list.push(session)
    children.set(session.parentSession, list)
  }
  return children
}

function createdDayOf(activity: ContextActivity | null): string | undefined {
  const days = activity?.days
  if (days === undefined) return undefined
  let first: string | undefined
  for (const key of Object.keys(days)) {
    if (first === undefined || key < first) first = key
  }
  return first
}

function runningOf(ctx: Context, id: string): boolean {
  const agents = asRecord(ctx.get('agents'))
  if (agents === null || typeof agents.get !== 'function') return false
  try {
    const agent = asRecord((agents.get as (id: string) => unknown)(id))
    return agent?.status === 'running'
  } catch {
    return false
  }
}

function rowsOf(
  sessions: readonly HostSession[],
  workspace: WorkspaceState,
  ctx: Context,
): HostRow[] {
  const byId = new Map<string, HostSession>()
  for (const session of sessions) {
    if (session.blank) continue
    byId.set(session.id, session)
  }
  const children = childrenOf([...byId.values()])
  const rows: HostRow[] = []
  for (const session of byId.values()) {
    if (session.origin === 'subagent') continue
    const family: HostSession[] = [session]
    const queue = [session.id]
    for (let index = 0; index < queue.length; index++) {
      for (const child of children.get(queue[index]) ?? []) {
        family.push(child)
        queue.push(child.id)
      }
    }
    const activity = family.length === 1
      ? session.activity
      : mergeActivity(family.map(member => member.activity))
    const familyCost = mergeCostUsage(...family.map(member => member.timeline?.cost))
    const group = workspace.groups.get(session.id)
    const createdDay = createdDayOf(activity)
    rows.push({
      session,
      archived: workspace.archived.has(session.id),
      ...(group === undefined ? {} : { group }),
      running: runningOf(ctx, session.id),
      activity,
      family,
      familyCost,
      tokens: billedTokensOf(familyCost),
      ...(createdDay === undefined ? {} : { createdDay }),
    })
  }
  return rows
}

export interface BuildRowsOptions {
  yieldEvery?: number
  yieldTo?: () => Promise<void>
}

const YIELD_EVERY = 64

export interface BuildRowsResult {
  rows: HostRow[]
  reusableSessions: Map<string, HostSession>
  rebuilt: number
  incomplete: number
}

export async function buildRows(
  sessions: Map<string, HostSession>,
  scan: CorpusScan | { entries: readonly ScanEntry[] },
  workspace: WorkspaceState,
  cache: CachedSnapshotFace,
  projections: SnapshotProjectionsFace,
  ctx: Context,
  options: BuildRowsOptions = {},
): Promise<BuildRowsResult> {
  const yieldEvery = options.yieldEvery ?? YIELD_EVERY
  const yieldTo = options.yieldTo ?? (() => new Promise<void>((resolve) => { setImmediate(resolve) }))
  const current = new Map<string, HostSession>()
  const reusable = new Map<string, HostSession>()
  let rebuilt = 0
  let incomplete = 0
  for (const entry of scan.entries) {
    const cached = sessions.get(entry.id)
    if (cached !== undefined && cached.signature === entry.signature) {
      current.set(entry.id, cached)
      reusable.set(entry.id, cached)
      continue
    }
    const built = sessionOf(entry, cache, projections)
    current.set(entry.id, built.session)
    if (built.cacheable) reusable.set(entry.id, built.session)
    else incomplete++
    rebuilt++
    if (yieldEvery > 0 && rebuilt % yieldEvery === 0) await yieldTo()
  }
  const rows = rowsOf([...current.values()], workspace, ctx)
  return { rows, reusableSessions: reusable, rebuilt, incomplete }
}

