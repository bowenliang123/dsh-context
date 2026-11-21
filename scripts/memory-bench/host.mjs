import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { scheduler } from 'node:timers/promises'
import { filesOf } from './hashing.mjs'

const required = name => {
  const value = process.env[name]
  if (value === undefined || value === '') throw new Error(`missing ${name}`)
  return value
}

const dshRoot = required('DSH_BENCH_DSH_ROOT')
const corpusRoot = required('DSH_BENCH_CORPUS')
const workRoot = required('DSH_BENCH_WORK')
const pluginPath = required('DSH_BENCH_PLUGIN')
const expectedCount = Number(required('DSH_BENCH_COUNT'))
const mode = required('DSH_BENCH_MODE')
const idleMs = Number(process.env.DSH_BENCH_IDLE_MS ?? '22000')
const requireDsh = createRequire(join(dshRoot, 'benchmarks', 'package.json'))
const loadDsh = name => import(pathToFileURL(requireDsh.resolve(name)).href)
const { Context } = await loadDsh('@deepseek-ai/cordis')
const { mountAgentLoopTestDependencies } = await loadDsh('@deepseek-ai/dsh-agent-loop-testkit')
const AgentLoop = (await loadDsh('@deepseek-ai/dsh-agent-loop')).default
const { agentPresetProjectionDefinition } = await loadDsh('@deepseek-ai/dsh-agent-preset-registry')
const JsonlSessionPersistence = await loadDsh('@deepseek-ai/dsh-session-persistence-jsonl')
const SessionProjectionCache = (await loadDsh('@deepseek-ai/dsh-session-projection-cache')).default
const SqliteSessionQueryEngine = (await loadDsh('@deepseek-ai/dsh-session-query-sqlite')).default
const SessionStatsPlugin = await loadDsh('@deepseek-ai/dsh-session-stats')
const SessionTitleService = (await loadDsh('@deepseek-ai/dsh-session-title')).default
const SessionTurnOutlinePlugin = await loadDsh('@deepseek-ai/dsh-session-turn-outline')
const Storage = (await loadDsh('@deepseek-ai/dsh-storage')).default
const StorageDomain = await loadDsh('@deepseek-ai/dsh-storage-domain')
const StorageJson = await loadDsh('@deepseek-ai/dsh-storage-json')
const TokenMeter = (await loadDsh('@deepseek-ai/dsh-token-meter')).default
const plugin = await import(pathToFileURL(resolve(pluginPath)).href)
process.env.DSH_HOME = workRoot

const routes = new Map()
const ctx = new Context()
const started = performance.now()
const loop = monitorEventLoopDelay({ resolution: 1 })
loop.enable()
await mountAgentLoopTestDependencies(ctx)
await ctx.plugin(JsonlSessionPersistence, { root: join(corpusRoot, 'sessions'), compression: 'zstd' })
await ctx.plugin(Storage)
await ctx.plugin(StorageJson, { root: join(workRoot, 'projection-storages') })
await ctx.plugin(StorageDomain, { backend: 'json' })
await ctx.plugin(SessionProjectionCache, { writeEveryEvents: 200, writeIntervalMs: 5000 })
await ctx.plugin(SqliteSessionQueryEngine, { path: ':memory:', openAt: 'first-search' })
await ctx.sessionProjections.register(agentPresetProjectionDefinition)
await ctx.plugin(SessionTitleService, { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80 })
await ctx.plugin(SessionStatsPlugin)
await ctx.plugin(SessionTurnOutlinePlugin)
await ctx.plugin(TokenMeter)
await ctx.plugin(AgentLoop, { agents: [] })
const dispose = () => {}
ctx.provide('typert', {
  lookups: { configure: () => dispose },
  contexts: { configureHost: () => dispose },
  resources: { register: () => dispose },
})
ctx.provide('fileUploads', { registerAgentResolver: () => dispose })
ctx.provide('agentDefaultModel', { currentSelection: () => ({ provider: 'bench', model: 'bench' }) })
ctx.provide('workspaceRegistry', { list: () => [], archivedSessionIds: [] })
ctx.provide('connection', {
  fetch: {
    register: route => {
      routes.set(route.path, route)
      return () => { routes.delete(route.path) }
    },
  },
})
if (process.env.DSH_BENCH_DEBUG === '1') {
  const query = ctx.get('sessionQuery')
  const listSessions = query.listSessions.bind(query)
  query.listSessions = async (...args) => {
    const before = performance.now()
    console.error('sessionQuery.listSessions start')
    try {
      const result = await listSessions(...args)
      console.error(`sessionQuery.listSessions end ${Array.isArray(result) ? result.length : 'unknown'} ${Math.round(performance.now() - before)}ms`)
      return result
    } catch (error) {
      console.error(`sessionQuery.listSessions failed ${Math.round(performance.now() - before)}ms ${String(error)}`)
      throw error
    }
  }
  const persistence = ctx.get('sessionPersistence')
  const open = persistence.open.bind(persistence)
  let opens = 0
  persistence.open = async (...args) => {
    opens++
    if (opens <= 5 || opens % 100 === 0) console.error(`sessionPersistence.open start ${opens} ${String(args[0])}`)
    const result = await open(...args)
    if (opens <= 5 || opens % 100 === 0) console.error(`sessionPersistence.open end ${opens}`)
    return result
  }
}
await ctx.plugin(plugin, {})
const bootMs = performance.now() - started

const deadline = performance.now() + 30000
while ((!routes.has('/api/dsh-context/overview') || !routes.has('/api/dsh-context/heads')
  || !routes.has('/api/dsh-context/snapshot')) && performance.now() < deadline) {
  await scheduler.wait(5)
}
for (const path of ['/api/dsh-context/overview', '/api/dsh-context/heads', '/api/dsh-context/snapshot']) {
  if (!routes.has(path)) throw new Error(`route ${path} did not register`)
}

const call = async (path, body) => {
  const route = routes.get(path)
  const before = performance.now()
  const response = await route.fetch(new Request(`http://bench.local${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
  const text = await response.text()
  const elapsed = performance.now() - before
  const parsed = JSON.parse(text)
  if (parsed.ok !== true) throw new Error(`${path}: ${JSON.stringify(parsed)}`)
  return { value: parsed.value, revision: parsed.revision, ms: elapsed, bytes: Buffer.byteLength(text) }
}

const scope = { range: { start: 0, end: Date.UTC(2100, 0, 1) } }
const overviewStarted = performance.now()
let summary
let firstCompleteOverviewMs
const coverageDeadline = performance.now() + Number(process.env.DSH_BENCH_COVERAGE_TIMEOUT_MS ?? '900000')
for (;;) {
  const result = await call('/api/dsh-context/overview', { part: 'summary', scope, sort: 'recent', page: 0 })
  summary = result.value.summary
  if (summary.coverage.complete && summary.coverage.total === expectedCount
    && summary.coverage.covered + summary.coverage.unsupported === expectedCount
    && summary.sessionsTotal > 0) {
    firstCompleteOverviewMs = performance.now() - overviewStarted
    break
  }
  if (performance.now() > coverageDeadline) throw new Error(`incomplete coverage ${JSON.stringify(summary.coverage)}`)
  await scheduler.wait(50)
}

const semantic = createHash('sha256')
const canonical = value => {
  if (Array.isArray(value)) return value.map(canonical)
  if (value === null || typeof value !== 'object') return value
  return Object.fromEntries(Object.keys(value).filter(key => key !== 'revision').sort()
    .map(key => [key, canonical(value[key])]))
}
const digestOf = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
semantic.update(JSON.stringify(canonical(summary)))
const semanticParts = { summary: digestOf(summary), days: '', tally: '', pages: '', heads: '', snapshot: '' }
const daysResult = await call('/api/dsh-context/overview', { part: 'days', scope, sort: 'recent', page: 0 })
semantic.update(JSON.stringify(canonical(daysResult.value)))
semanticParts.days = digestOf(daysResult.value)
const tallyResult = await call('/api/dsh-context/overview', { part: 'tally', scope, sort: 'recent', page: 0, tally: 'tools' })
semantic.update(JSON.stringify(canonical(tallyResult.value)))
semanticParts.tally = digestOf(tallyResult.value)
const pageIds = []
const pageSemantic = createHash('sha256')
let pageMs = 0
let pageBytes = 0
let pageIndex = 0
let expectedRows = 0
for (;;) {
  const result = await call('/api/dsh-context/overview', { part: 'page', scope, sort: 'recent', page: pageIndex })
  const page = result.value.page
  pageMs += result.ms
  pageBytes += result.bytes
  semantic.update(JSON.stringify(canonical(page)))
  pageSemantic.update(JSON.stringify(canonical(page)))
  for (const row of page.items) pageIds.push(row.id)
  expectedRows = page.total
  pageIndex++
  if (pageIndex >= page.count) break
  if (pageIndex > 1000) throw new Error('page iteration did not terminate')
}
semanticParts.pages = pageSemantic.digest('hex')
if (pageIds.length !== expectedRows || new Set(pageIds).size !== expectedRows) {
  throw new Error(`overview returned ${pageIds.length} unique rows of ${expectedRows}`)
}

const ids = Array.from({ length: expectedCount }, (_, rank) => `bench-${String(rank).padStart(5, '0')}`)
const mandatoryRanks = new Set([0, 1, 30, Math.min(500, expectedCount - 1), Math.min(1000, expectedCount - 1),
  Math.min(1100, expectedCount - 1), expectedCount - 1])
for (let rank = 0; mandatoryRanks.size < 64; rank++) mandatoryRanks.add(rank)
const selectedRanks = [...mandatoryRanks].slice(0, 64)
if (selectedRanks.length !== 64) throw new Error(`selected ${selectedRanks.length} of 64 head ids`)
const selected = selectedRanks.map(rank => ids[rank])
const { sessionShape } = await import(pathToFileURL(join(dshRoot, 'benchmarks/session-corpus/corpus-shape.ts')).href)
const foldClasses = new Set(selectedRanks.map(rank => sessionShape(rank, expectedCount).events > 30000
  ? 'worker'
  : sessionShape(rank, expectedCount).events > 2000 ? 'sliced' : 'small'))
for (const expected of ['small', 'sliced', 'worker']) {
  if (!foldClasses.has(expected)) throw new Error(`missing ${expected} head class`)
}
const headsResult = await call('/api/dsh-context/heads', { ids: selected })
const heads = headsResult.value
if (Object.keys(heads).length !== selected.length) throw new Error(`heads returned ${Object.keys(heads).length} of ${selected.length}`)
for (const [index, id] of selected.entries()) {
  if (heads[id]?.head?.counts === undefined) throw new Error(`missing head ${id}`)
  const expectedTurns = sessionShape(selectedRanks[index], expectedCount).turns
  if (heads[id].head.counts.turns !== expectedTurns) {
    throw new Error(`head ${id} returned ${heads[id].head.counts.turns} turns, expected ${expectedTurns}`)
  }
}
semantic.update(JSON.stringify(heads))
semanticParts.heads = digestOf(heads)
const snapshotResult = await call('/api/dsh-context/snapshot', { ids: selected })
if (Object.keys(snapshotResult.value).length !== selected.length) {
  throw new Error(`snapshot returned ${Object.keys(snapshotResult.value).length} of ${selected.length}`)
}
semantic.update(JSON.stringify(snapshotResult.value))
semanticParts.snapshot = digestOf(snapshotResult.value)

let history = null
if (routes.has('/api/dsh-context/history')) {
  const workerIndex = selectedRanks.findIndex(rank => sessionShape(rank, expectedCount).events > 30000)
  const historyId = selected[workerIndex >= 0 ? workerIndex : selected.length - 1]
  const report = {}
  for (const part of ['requests', 'events', 'milestones']) {
    let beforeSeq
    let pages = 0
    let rows = 0
    let bytes = 0
    let ms = 0
    let total = 0
    const samples = []
    const seen = new Set()
    for (;;) {
      const result = await call('/api/dsh-context/history', {
        sessionId: historyId,
        part,
        limit: 1_000,
        ...(beforeSeq === undefined ? {} : { beforeSeq }),
      })
      const value = result.value
      if (value === null || value === undefined || Array.isArray(value.rows) !== true) {
        throw new Error(`history ${part} returned no rows`)
      }
      pages++
      rows += value.rows.length
      bytes += result.bytes
      ms += result.ms
      samples.push(result.ms)
      total = value.total
      for (const row of value.rows) {
        const key = part === 'requests' ? String(row.seq) : String(row.kind) + ':' + String(row.seq) + ':' + String(row.ord)
        if (seen.has(key)) throw new Error(`history ${part} returned duplicate ${key}`)
        seen.add(key)
      }
      beforeSeq = value.beforeSeq
      if (beforeSeq === undefined) break
      if (pages > 2_000) throw new Error(`history ${part} page walk did not terminate`)
    }
    if (rows !== total) throw new Error(`history ${part} walked ${rows} of ${total}`)
    samples.sort((a, b) => a - b)
    report[part] = {
      pages,
      rows,
      total,
      bytes,
      ms,
      p50Ms: samples[Math.floor(samples.length / 2)] ?? 0,
      p95Ms: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))] ?? 0,
      maxMs: samples[samples.length - 1] ?? 0,
    }
  }
  report.sessionId = historyId
  history = report
}

const collect = async () => {
  globalThis.gc()
  await scheduler.yield()
  globalThis.gc()
  const memory = process.memoryUsage()
  return { rssBytes: memory.rss, heapUsedBytes: memory.heapUsed, heapTotalBytes: memory.heapTotal, externalBytes: memory.external }
}
const activeMemory = await collect()
const loopStats = () => ({
  p95Ms: loop.percentile(95) / 1e6,
  p99Ms: loop.percentile(99) / 1e6,
  maxMs: loop.max / 1e6,
  meanMs: loop.mean / 1e6,
})
const activeLoop = loopStats()
loop.reset()
await scheduler.wait(idleMs)
const idleMemory = await collect()
const idleLoop = loopStats()
await ctx.fiber.dispose()

const files = await Promise.all((await filesOf(join(workRoot, 'storages', 'dsh-context'), true))
  .map(async path => ({ path, bytes: (await stat(path)).size })))
const peakWorkingSetBytes = process.platform === 'win32'
  ? Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `(Get-CimInstance Win32_Process -Filter "ProcessId = ${process.pid}").PeakWorkingSetSize`], { encoding: 'utf8' }).trim()) * 1024
  : process.resourceUsage().maxRSS * 1024
const report = {
  mode,
  node: process.version,
  dshCommit: process.env.DSH_BENCH_DSH_COMMIT ?? '',
  pluginSha256: process.env.DSH_BENCH_PLUGIN_SHA256 ?? '',
  corpusSha256: process.env.DSH_BENCH_CORPUS_SHA256 ?? '',
  config: JSON.parse(process.env.DSH_BENCH_CONFIG ?? '{}'),
  pid: process.pid,
  count: expectedCount,
  bootMs,
  firstCompleteOverviewMs,
  pageMs,
  pageBytes,
  pages: pageIndex,
  rows: expectedRows,
  headsMs: headsResult.ms,
  headsBytes: headsResult.bytes,
  snapshotMs: snapshotResult.ms,
  snapshotBytes: snapshotResult.bytes,
  semanticSha256: semantic.digest('hex'),
  semanticParts,
  history,
  pageIdsSha256: createHash('sha256').update([...pageIds].sort().join('\n')).digest('hex'),
  coverage: summary.coverage,
  summary: {
    sessions: summary.sessions,
    sessionsTotal: summary.sessionsTotal,
    tokens: summary.tokens,
    turns: summary.turns,
  },
  activeMemory,
  idleMemory,
  activeLoop,
  idleLoop,
  peakWorkingSetBytes,
  cache: {
    files: files.length,
    bytes: files.reduce((total, file) => total + file.bytes, 0),
    maxFileBytes: Math.max(0, ...files.map(file => file.bytes)),
    names: files.map(file => file.path.slice(workRoot.length + 1)).sort(),
  },
}
process.stdout.write(`${JSON.stringify(report)}\n`)
