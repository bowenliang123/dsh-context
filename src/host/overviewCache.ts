import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { ActivityDay, ActivityTally, ContextActivity, SessionCostUsage, Snapshot, TimingTotals } from '../shared/types'
import type { HostSession, HostTimeline } from './overviewCorpus'
import { asRecord } from './record'

export const OVERVIEW_CACHE_FORMAT = 1

export const OVERVIEW_CACHE_FILE = 'overview-cache.v1.json'

const DEFAULT_DEBOUNCE_MS = 2_000

const DEFAULT_STAT_CONCURRENCY = 16

const DEFAULT_CAPTURE_CONCURRENCY = 4

const TIMING_OPTIONAL = [
  'reasoningMs', 'reasoningBlocks', 'textMs', 'textBlocks',
  'toolArgMs', 'toolArgBlocks', 'toolBusyMs', 'idleMs', 'speedTokens', 'speedMs',
] as const

interface CacheFileInfo {
  size: number
  mtimeMs: number
}

export interface CacheFs {
  stat(path: string): Promise<CacheFileInfo>
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm?(path: string): Promise<void>
}

const NODE_FS: CacheFs = {
  stat: async (path) => {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, data) => writeFile(path, data, 'utf8'),
  rename: (from, to) => rename(from, to),
  mkdir: async (path) => { await mkdir(path, { recursive: true }) },
  rm: async (path) => { await rm(path, { force: true }) },
}

export interface DurableIdentity {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export interface CachedSession {
  session: HostSession
  identity: DurableIdentity | null
}

export interface OverviewCacheLoad {
  sessions: Map<string, HostSession>
  identities: Map<string, DurableIdentity | null>
  rebuild: Set<string>
}

export interface OverviewCacheRefresh {
  identities: Map<string, DurableIdentity | null>
  changed: Set<string>
}

export interface StatHost {
  stat?(id: string): Promise<unknown>
}

export interface OverviewCacheOptions {
  path?: string
  fs?: CacheFs
  now?: () => number
  debounceMs?: number
  statConcurrency?: number
  captureConcurrency?: number
}

export interface OverviewCache {
  load(currentIds: ReadonlySet<string>, known?: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheLoad>
  refresh(currentIds: ReadonlySet<string>, known: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheRefresh>
  capture(ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>>
  save(records: readonly CachedSession[]): void
  flush(): Promise<void>
  dispose(): void
}

export function overviewCachePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== ''
    ? env.DSH_HOME
    : join(home, '.dsh')
  return join(root, 'storages', 'dsh-context', OVERVIEW_CACHE_FILE)
}

export function identityKey(identity: DurableIdentity | null | undefined): string {
  if (identity === null || identity === undefined) return '?'
  return `${identity.path}\u0000${String(identity.sizeBytes)}\u0000${String(identity.mtimeMs)}`
}

function sameIdentity(left: DurableIdentity | null, right: DurableIdentity | null): boolean {
  if (left === null || right === null) return left === right
  return left.path === right.path && left.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs
}

function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function optionalNumOf(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function usageOf(value: unknown): SessionCostUsage | undefined {
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

function activityOf(value: unknown): ContextActivity | null {
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

function currentOf(value: unknown): Snapshot['current'] | null {
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

function timingOf(value: unknown): TimingTotals | undefined {
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

function timelineOf(value: unknown): HostTimeline | null {
  if (value === null) return null
  const data = asRecord(value)
  if (data === null) return null
  const current = currentOf(data.current)
  const timeline: HostTimeline = { current, total: numOf(data.total), turns: numOf(data.turns) }
  const steps = optionalNumOf(data.steps)
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
  for (const field of ['generatedReasoning', 'generatedAnswerTokens', 'generatedCallTokens'] as const) {
    const figure = optionalNumOf(data[field])
    if (figure !== undefined) timeline[field] = figure
  }
  return timeline
}

function parseSession(value: unknown): HostSession | null {
  const data = asRecord(value)
  if (data === null) return null
  const id = data.id
  const title = data.title
  const updatedAt = data.updatedAt
  const blank = data.blank
  const signature = data.signature
  if (typeof id !== 'string' || id === '') return null
  if (typeof title !== 'string') return null
  if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) return null
  if (typeof blank !== 'boolean') return null
  if (typeof signature !== 'string') return null
  const session: HostSession = {
    id,
    title,
    updatedAt,
    blank,
    signature,
    timeline: timelineOf(data.timeline),
    activity: activityOf(data.activity),
  }
  if (typeof data.cwd === 'string' && data.cwd !== '') session.cwd = data.cwd
  if (typeof data.parentSession === 'string' && data.parentSession !== '') session.parentSession = data.parentSession
  if (data.origin === 'subagent') session.origin = 'subagent'
  return session
}

function identityOf(value: unknown): DurableIdentity | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.path !== 'string' || data.path === '') return null
  const sizeBytes = optionalNumOf(data.sizeBytes)
  const mtimeMs = optionalNumOf(data.mtimeMs)
  if (sizeBytes === undefined || mtimeMs === undefined) return null
  return { path: data.path, sizeBytes, mtimeMs }
}

function recordOf(value: unknown): CachedSession | null {
  const data = asRecord(value)
  if (data === null) return null
  const session = parseSession(data.session)
  if (session === null) return null
  const rawIdentity = data.identity
  const identity = rawIdentity === null || rawIdentity === undefined ? null : identityOf(rawIdentity)
  if (rawIdentity !== null && rawIdentity !== undefined && identity === null) return null
  return { session, identity }
}

function parsedRecords(value: unknown): CachedSession[] {
  const data = asRecord(value)
  if (data === null || data.format !== OVERVIEW_CACHE_FORMAT || !Array.isArray(data.sessions)) return []
  const records: CachedSession[] = []
  for (const entry of data.sessions) {
    const record = recordOf(entry)
    if (record !== null) records.push(record)
  }
  return records
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run))
    if (index + size < items.length) await new Promise(resolve => setImmediate(resolve))
  }
}

export function createOverviewCache(options: OverviewCacheOptions = {}): OverviewCache {
  const path = options.path ?? overviewCachePath()
  const fs = options.fs ?? NODE_FS
  const now = options.now ?? (() => Date.now())
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const statConcurrency = options.statConcurrency ?? DEFAULT_STAT_CONCURRENCY
  const captureConcurrency = options.captureConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending: CachedSession[] | null = null
  let disposed = false

  const write = async (records: readonly CachedSession[]): Promise<void> => {
    const body = JSON.stringify({ format: OVERVIEW_CACHE_FORMAT, savedAt: now(), sessions: records })
    const temp = `${path}.tmp`
    try {
      await fs.mkdir(dirname(path))
      await fs.writeFile(temp, body)
      await fs.rename(temp, path)
    } catch {
      try {
        await fs.rm?.(temp)
      } catch {}
    }
  }

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const records = pending
    pending = null
    if (records === null) return
    await write(records)
  }

  const load = async (
    currentIds: ReadonlySet<string>,
    known?: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<OverviewCacheLoad> => {
    const sessions = new Map<string, HostSession>()
    const identities = new Map<string, DurableIdentity | null>()
    const rebuild = new Set<string>()
    let file: unknown
    try {
      file = JSON.parse(await fs.readFile(path))
    } catch {
      return { sessions, identities, rebuild }
    }
    const records = parsedRecords(file).filter(record => currentIds.has(record.session.id))
    await inBatches(records, statConcurrency, async (record) => {
      const id = record.session.id
      if (known !== undefined) {
        const expected = known.get(id) ?? null
        identities.set(id, expected)
        if (record.identity !== null && sameIdentity(record.identity, expected)) sessions.set(id, record.session)
        else rebuild.add(id)
        return
      }
      if (record.identity === null) {
        identities.set(id, null)
        rebuild.add(id)
        return
      }
      try {
        const info = await fs.stat(record.identity.path)
        if (info.size === record.identity.sizeBytes && info.mtimeMs === record.identity.mtimeMs) {
          identities.set(id, record.identity)
          sessions.set(id, record.session)
          return
        }
        identities.set(id, { path: record.identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
        rebuild.add(id)
      } catch {
        identities.set(id, null)
        rebuild.add(id)
      }
    })
    return { sessions, identities, rebuild }
  }

  const refresh = async (
    currentIds: ReadonlySet<string>,
    known: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<OverviewCacheRefresh> => {
    const identities = new Map<string, DurableIdentity | null>()
    const changed = new Set<string>()
    const targets: { id: string; identity: DurableIdentity }[] = []
    for (const id of currentIds) {
      const identity = known.get(id)
      if (identity === null || identity === undefined) continue
      targets.push({ id, identity })
    }
    await inBatches(targets, statConcurrency, async ({ id, identity }) => {
      try {
        const info = await fs.stat(identity.path)
        if (info.size === identity.sizeBytes && info.mtimeMs === identity.mtimeMs) {
          identities.set(id, identity)
          return
        }
        identities.set(id, { path: identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
        changed.add(id)
      } catch {
        identities.set(id, null)
        changed.add(id)
      }
    })
    return { identities, changed }
  }

  const capture = async (ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>> => {
    const identities = new Map<string, DurableIdentity | null>()
    const statOf = typeof host.stat === 'function' ? host.stat.bind(host) : undefined
    await inBatches(ids, captureConcurrency, async (id) => {
      identities.set(id, await captureOne(id, statOf, fs))
    })
    return identities
  }

  const save = (records: readonly CachedSession[]): void => {
    if (disposed) return
    pending = [...records]
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      const recordsToWrite = pending
      pending = null
      /* v8 ignore next 1 */
      if (recordsToWrite !== null) void write(recordsToWrite)
    }, debounceMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  const dispose = (): void => {
    if (disposed) return
    disposed = true
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    const records = pending
    pending = null
    if (records !== null) void write(records)
  }

  return { load, refresh, capture, save, flush, dispose }
}

async function captureOne(
  id: string,
  statOf: ((id: string) => Promise<unknown>) | undefined,
  fs: CacheFs,
): Promise<DurableIdentity | null> {
  if (statOf === undefined) return null
  let snapshot: unknown
  try {
    snapshot = await statOf(id)
  } catch {
    return null
  }
  const data = asRecord(snapshot)
  const location = asRecord(data?.location)
  const path = typeof location?.path === 'string' && location.path !== '' ? location.path : undefined
  const sizeBytes = optionalNumOf(data?.sizeBytes)
  if (path === undefined || sizeBytes === undefined) return null
  try {
    const info = await fs.stat(path)
    return { path, sizeBytes, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}
