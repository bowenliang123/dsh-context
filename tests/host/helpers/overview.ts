import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { watchOverviewRoute, OVERVIEW_ROUTE } from '../../../src/host/overview'
import type { BackfillHandle } from '../../../src/host/backfill'
import type { CachedSession, DurableIdentity, OverviewCache, StatHost } from '../../../src/host/overviewCache'
import type { HostSession } from '../../../src/host/overviewCorpus'
import type { CostSource } from '../../../src/host/cost'
import { asRecord } from '../../../src/shared/decode'
import { billedParts, RING_ORDER } from '../../../src/shared/categories'
import type {
  ActivityDay,
  BackfillCoverage,
  ContextTimeline,
  OverviewPage,
  OverviewSummary,
  OverviewTally,
  OverviewValue,
  SessionCostUsage,
  Snapshot,
  TimingTotals,
  TokenUsage,
} from '../../../src/shared/types'

export interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

export interface RouteReply {
  ok: boolean
  value?: OverviewValue
  error?: { code: string; message?: string }
}

export interface CallResult {
  reply: RouteReply
  bytes: number
}

export type CallOutcome = CallResult | RouteReply

export interface FakeOverviewCache extends OverviewCache {
  loadCalls: number
  refreshCalls: number
  captureCalls: { ids: string[]; host: StatHost }[]
  saveCalls: number
  flushCalls: number
  disposeCalls: number
}

export interface Harness {
  ctx: Context
  routes: Map<string, RouteBox>
  dispose: () => void
  cache: FakeOverviewCache
  calls: { list: number; snapshot: string[]; cached: string[] }
  cacheMode: {
    throwCached: boolean
    throwSnapshot: boolean
    values: Record<string, Record<string, unknown>>
    liveValues: Record<string, Record<string, unknown>>
  }
  state: {
    records: unknown
    liveSeq: Record<string, number>
    workspace: unknown
    agents: unknown
    coverage: BackfillCoverage
    backfillVersion: number
    costReady: boolean
    foldedAvailable: boolean
    foldedVersion: number
    foldedIds: string[] | null
    workerFoldedIds: string[] | null
    foldCalls: number[]
    savedRecords: CachedSession[]
    cachedSessions: Map<string, HostSession>
    cachedIdentities: Map<string, DurableIdentity | null>
    captureIdentities: Map<string, DurableIdentity | null>
    refreshChanged: string[]
    refreshSkip: string[]
    captureMissing: string[]
    captureThrows: boolean
    diskRebuild: string[]
  }
}

export interface BootOptions {
  records?: unknown
  values?: Record<string, Record<string, unknown>>
  liveValues?: Record<string, Record<string, unknown>>
  liveSeq?: Record<string, number>
  workspace?: unknown
  agents?: unknown
  coverage?: BackfillCoverage
  backfillVersion?: number
  costReady?: boolean
  scanTtlMs?: number
  servedKeysMax?: number
  listSessions?: () => Promise<unknown>
  sessionsWithoutGet?: boolean
  sessionsGetThrows?: boolean
  cacheUndefined?: boolean
  liveNoSeq?: boolean
  persistence?: unknown
  cache?: OverviewCache
  idleMs?: number
  captureDelayMs?: number
  capturePollMs?: number
  yieldEvery?: number
  yieldTo?: () => Promise<void>
  cachePath?: string
  foldedAvailable?: boolean
  noCache?: boolean
}

export const OPEN_COVERAGE: BackfillCoverage = {
  complete: true,
  remaining: 0,
  failed: 0,
  running: false,
  total: 0,
  covered: 0,
  unsupported: 0,
}

export function costOfUsage(usage: SessionCostUsage | null | undefined): number | null {
  if (usage === null || usage === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        total += (numOf(bucket.cacheRead) * 0.1 + numOf(bucket.uncached) * 1
          + numOf(bucket.cacheWrite) * 1.25 + numOf(bucket.output) * 2) / 1_000_000
        any = true
      }
    }
  }
  return any ? total : null
}

export function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export function fakeCost(ready: boolean): CostSource {
  return {
    ready: () => ready,
    read: (usage) => ({ usd: ready ? costOfUsage(usage) : null, ready }),
    usd: (usage) => (ready ? costOfUsage(usage) : null),
    complete: (usage) => ready && usage !== null && costOfUsage(usage) !== null,
  }
}

export function fakeBackfill(state: Harness['state']): BackfillHandle {
  const handle = (() => {}) as BackfillHandle
  const base = {
    coverage: (): BackfillCoverage => ({ ...state.coverage }),
    version: (): number => state.backfillVersion,
  }
  if (!state.foldedAvailable) return Object.assign(handle, base)
  return Object.assign(handle, base, {
    foldedSince: (marker: number): { version: number; ids: string[] | null; workerIds: string[] | null } => {
      state.foldCalls.push(marker)
      if (marker === state.foldedVersion) return { version: state.foldedVersion, ids: [], workerIds: [] }
      const ids = state.foldedIds
      const workerIds = state.workerFoldedIds
      state.foldedIds = []
      state.workerFoldedIds = []
      return { version: state.foldedVersion, ids, workerIds }
    },
  })
}

export function fakeState(overrides: Partial<Harness['state']> = {}): Harness['state'] {
  return {
    records: [],
    liveSeq: {},
    workspace: undefined,
    agents: undefined,
    coverage: { ...OPEN_COVERAGE },
    backfillVersion: 0,
    costReady: true,
    foldedAvailable: true,
    foldedVersion: 0,
    foldedIds: [],
    workerFoldedIds: [],
    foldCalls: [],
    savedRecords: [],
    cachedSessions: new Map(),
    cachedIdentities: new Map(),
    captureIdentities: new Map(),
    captureThrows: false,
    refreshChanged: [],
    refreshSkip: [],
    captureMissing: [],
    diskRebuild: [],
    ...overrides,
  }
}

export function fakeOverviewCache(state: Harness['state']): FakeOverviewCache {
  const cache: FakeOverviewCache = {
    loadCalls: 0,
    refreshCalls: 0,
    captureCalls: [],
    saveCalls: 0,
    flushCalls: 0,
    disposeCalls: 0,
    load: async (ids) => {
      cache.loadCalls++
      const sessions = new Map<string, HostSession>()
      const identities = new Map<string, DurableIdentity | null>()
      const rebuild = new Set(state.diskRebuild)
      for (const id of ids) {
        const session = state.cachedSessions.get(id)
        if (session === undefined) continue
        sessions.set(id, session)
        const identity = state.cachedIdentities.get(id)
        if (identity !== undefined) identities.set(id, identity)
      }
      return { sessions, identities, rebuild }
    },
    refresh: async (ids, known) => {
      cache.refreshCalls++
      const identities = new Map<string, DurableIdentity | null>()
      for (const id of ids) {
        const current = known.get(id)
        if (current === undefined || state.refreshSkip.includes(id)) continue
        identities.set(id, state.refreshChanged.includes(id) ? state.captureIdentities.get(id) ?? null : current)
      }
      return { identities, changed: new Set(state.refreshChanged) }
    },
    capture: async (ids, host) => {
      cache.captureCalls.push({ ids: [...ids], host })
      const out = new Map<string, DurableIdentity | null>()
      for (const id of ids) {
        if (state.captureMissing.includes(id)) continue
        out.set(id, state.captureIdentities.get(id) ?? null)
      }
      return out
    },
    save: (records) => {
      cache.saveCalls++
      state.savedRecords = [...records]
    },
    flush: async () => {
      cache.flushCalls++
    },
    dispose: () => {
      cache.disposeCalls++
    },
  }
  return cache
}

export function recordOf(id: string, options: { live?: boolean; cwd?: string; noCwd?: boolean; createdAt?: unknown; parentSession?: string; origin?: 'subagent'; version?: number } = {}): unknown {
  return {
    header: {
      id,
      version: options.version ?? 4,
      createdAt: options.createdAt ?? 1,
      ...(options.noCwd === true ? {} : { cwd: options.cwd ?? `/repo/${id}` }),
      isSeeded: false,
      ...(options.parentSession === undefined ? {} : { parentSession: options.parentSession }),
      ...(options.origin === undefined ? {} : { origin: options.origin }),
    },
    live: options.live === true,
    persisted: true,
  }
}

export function usageOf(uncached: number, cacheRead = 0, cacheWrite = 0, output = 0): SessionCostUsage {
  return { deepseek: { 'deepseek-v4-flash': { off: { uncached, cacheRead, cacheWrite, output } } } }
}

export function currentOf(total: number): Snapshot['current'] {
  return {
    system: Math.round(total * 0.2),
    tools: Math.round(total * 0.1),
    user: Math.round(total * 0.2),
    inject: 0,
    skill: 0,
    assistant: Math.round(total * 0.4),
    tool: total - Math.round(total * 0.2) - Math.round(total * 0.1) - Math.round(total * 0.2) - Math.round(total * 0.4),
    total,
  }
}

export function timelineOf(options: {
  total?: number
  turns?: number
  steps?: number
  cost?: SessionCostUsage
  lastUser?: string
  contextWindow?: number
  maxOutputTokens?: number
  model?: string
  timing?: TimingTotals
} = {}): Record<string, unknown> {
  return {
    ok: true,
    current: currentOf(options.total ?? 100),
    contextWindow: options.contextWindow ?? 128_000,
    ...(options.maxOutputTokens === undefined ? {} : { maxOutputTokens: options.maxOutputTokens }),
    ...(options.model === undefined ? {} : { model: options.model }),
    counts: { turns: options.turns ?? 2, steps: options.steps ?? 3 },
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    ...(options.timing === undefined ? {} : { timing: options.timing }),
    ...(options.lastUser === undefined ? {} : { lastUser: options.lastUser }),
    generatedReasoning: 5,
    generatedAnswerTokens: 7,
    generatedCallTokens: 2,
  }
}

export function timingOf(wallMs: number, toolCalls: number, toolsMs: number): TimingTotals {
  return {
    wallMs,
    ttftMs: Math.round(wallMs / 10),
    genMs: Math.round(wallMs * 0.8),
    calls: 2,
    toolsMs,
    toolCalls,
    tools: { bash: { calls: toolCalls, ms: toolsMs } },
    toolBusyMs: wallMs - toolsMs,
    speedTokens: 100,
    speedMs: 500,
  }
}

export function dayOf(tokens: number, requests: number, options: { cost?: SessionCostUsage; turns?: number; toolCalls?: number; toolsMs?: number; wallMs?: number; skills?: string[]; tools?: string[]; cmds?: string[] } = {}): ActivityDay {
  return {
    tokens,
    requests,
    ...(options.cost === undefined ? {} : { cost: options.cost }),
    ...(options.turns === undefined ? {} : { turns: options.turns }),
    ...(options.toolCalls === undefined ? {} : { toolCalls: options.toolCalls }),
    ...(options.toolsMs === undefined ? {} : { toolsMs: options.toolsMs }),
    ...(options.wallMs === undefined ? {} : { wallMs: options.wallMs }),
    ...(options.skills === undefined ? {} : { skills: Object.fromEntries(options.skills.map(name => [name, { n: 1, last: 10 }])) }),
    ...(options.tools === undefined ? {} : { tools: Object.fromEntries(options.tools.map(name => [name, { n: 1, last: 20 }])) }),
    ...(options.cmds === undefined ? {} : { cmds: Object.fromEntries(options.cmds.map(name => [name, { n: 1, last: 30 }])) }),
  }
}

export function boot(options: BootOptions = {}): Promise<Harness> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  const calls = { list: 0, snapshot: [] as string[], cached: [] as string[] }
  const cacheMode = {
    throwCached: false,
    throwSnapshot: false,
    values: options.values ?? {},
    liveValues: options.liveValues ?? {},
  }
  const state: Harness['state'] = {
    records: options.records ?? [],
    liveSeq: options.liveSeq ?? {},
    workspace: options.workspace,
    agents: options.agents,
    coverage: options.coverage ?? { ...OPEN_COVERAGE },
    backfillVersion: options.backfillVersion ?? 0,
    costReady: options.costReady ?? true,
    foldedAvailable: options.foldedAvailable ?? true,
    foldedVersion: 0,
    foldedIds: [],
    workerFoldedIds: [],
    foldCalls: [],
    savedRecords: [],
    cachedSessions: new Map(),
    cachedIdentities: new Map(),
    captureIdentities: new Map(),
    captureThrows: false,
    refreshChanged: [],
    refreshSkip: [],
    captureMissing: [],
    diskRebuild: [],
  }
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch?: RouteBox['fetch'] }) => {
        routes.set(route.path, route)
        return () => { routes.delete(route.path) }
      },
    },
  })
  ctx.provide('sessionQuery', {
    listSessions: async () => {
      calls.list++
      return options.listSessions === undefined ? state.records : options.listSessions()
    },
  })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: { id?: string }) => {
      if (cacheMode.throwCached) throw new Error('cache read failed')
      const id = typeof header?.id === 'string' ? header.id : ''
      calls.cached.push(id)
      if (options.cacheUndefined === true) return undefined
      return { asOfSeq: 5, values: cacheMode.values[id] ?? {} }
    },
  })
  if (options.sessionsWithoutGet === true) {
    ctx.provide('sessions', {})
  } else if (options.sessionsGetThrows === true) {
    ctx.provide('sessions', { get: () => { throw new Error('registry broke') } })
  } else {
    ctx.provide('sessions', {
      get: (id: string) => (state.liveSeq[id] === undefined
        ? undefined
        : options.liveNoSeq === true ? { id } : { id, seq: state.liveSeq[id] }),
    })
  }
  ctx.provide('sessionProjections', {
    snapshot: (session: unknown) => {
      if (cacheMode.throwSnapshot) throw new Error('snapshot read failed')
      const id = asRecord(session)?.id
      if (typeof id !== 'string') return undefined
      calls.snapshot.push(id)
      return { asOfSeq: 1, values: cacheMode.liveValues[id] ?? {} }
    },
  })
  if (state.workspace !== undefined) ctx.provide('workspaceRegistry', state.workspace as never)
  if (state.agents !== undefined) ctx.provide('agents', state.agents as never)
  if (options.persistence !== undefined) ctx.provide('sessionPersistence', options.persistence as never)
  const cache = options.noCache === true
    ? null
    : (options.cache as FakeOverviewCache | undefined) ?? fakeOverviewCache(state)
  const routeOptions = {
    scanTtlMs: options.scanTtlMs ?? 0,
    ...(options.servedKeysMax === undefined ? {} : { servedKeysMax: options.servedKeysMax }),
    ...(options.idleMs === undefined ? {} : { idleMs: options.idleMs }),
    ...(options.captureDelayMs === undefined ? {} : { captureDelayMs: options.captureDelayMs }),
    ...(options.capturePollMs === undefined ? {} : { capturePollMs: options.capturePollMs }),
    ...(options.yieldEvery === undefined ? {} : { yieldEvery: options.yieldEvery }),
    ...(options.yieldTo === undefined ? {} : { yieldTo: options.yieldTo }),
    ...(options.cachePath === undefined ? {} : { cachePath: options.cachePath }),
    ...(cache === null ? {} : { cache }),
  }
  const dispose = watchOverviewRoute(ctx, fakeCost(state.costReady), fakeBackfill(state), routeOptions)
  return (async () => {
    for (let index = 0; index < 300 && !routes.has(OVERVIEW_ROUTE); index++) {
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    assert.ok(routes.has(OVERVIEW_ROUTE), 'the overview route registered')
    return { ctx, routes, dispose, cache: cache as FakeOverviewCache, calls, cacheMode, state }
  })()
}

export async function call(harness: Harness, body: unknown): Promise<CallResult> {
  const route = harness.routes.get(OVERVIEW_ROUTE)
  assert.ok(route !== undefined && route.fetch !== undefined)
  const response = await route.fetch(new Request(`http://dsh.test${OVERVIEW_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  const text = await response.text()
  return { reply: JSON.parse(text) as RouteReply, bytes: new TextEncoder().encode(text).length }
}

export function unwrap(result: CallOutcome): RouteReply {
  return 'reply' in result ? result.reply : result
}

export function summaryOf(result: CallOutcome): OverviewSummary {
  const reply = unwrap(result)
  assert.equal(reply.ok, true)
  assert.ok(reply.value !== undefined && 'summary' in reply.value)
  return reply.value.summary
}

export function pageOf(result: CallOutcome): OverviewPage {
  const reply = unwrap(result)
  assert.equal(reply.ok, true)
  assert.ok(reply.value !== undefined && 'page' in reply.value)
  return reply.value.page
}

export function tallyOf(result: CallOutcome): OverviewTally {
  const reply = unwrap(result)
  assert.equal(reply.ok, true)
  assert.ok(reply.value !== undefined && 'tally' in reply.value)
  return reply.value.tally
}

export function revisionOf(result: CallOutcome): string {
  const reply = unwrap(result)
  assert.equal(reply.ok, true)
  assert.ok(reply.value !== undefined)
  return reply.value.revision
}

export function tokenPartsOf(timeline: ContextTimeline, usage: SessionCostUsage): { key: string; value: number }[] {
  const totals = usageTotalsOf(usage)
  return billedParts(timeline.current, null, totals, {
    reasoning: timeline.generatedReasoning,
    answers: timeline.generatedAnswerTokens,
    calls: timeline.generatedCallTokens,
  })
    .filter(part => Number.isFinite(part.value) && part.value > 0)
    .map(part => ({ key: part.key, value: part.value }))
}

export function usageTotalsOf(usage: SessionCostUsage): TokenUsage {
  const totals = { uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 }
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        totals.uncachedInputTokens += numOf(bucket.uncached)
        totals.cacheReadTokens += numOf(bucket.cacheRead)
        totals.cacheWriteTokens += numOf(bucket.cacheWrite)
        totals.outputTokens += numOf(bucket.output)
      }
    }
  }
  return totals
}

export function sortedParts(parts: readonly { key: string; value: number }[]): { key: string; value: number }[] {
  return [...parts].sort((left, right) => RING_ORDER.indexOf(left.key) - RING_ORDER.indexOf(right.key))
}

