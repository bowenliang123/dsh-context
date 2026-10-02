// Staging + probe helpers for the compat matrix (matrix.spec.ts): stage the
// REAL harness sources at a baseline tag, boot the plugin's BUILT host entry
// on the tag's real registry + vendored cordis, and read the tag's client
// seams straight from its sources.
//
// The registry probe runs as a small spawned driver INSIDE the staging dir,
// so the bare `@deepseek-ai/cordis` import resolves to the cordis release
// that harness line vendors (not this repo's) — one process per baseline,
// reported as one JSON line.

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Baseline } from '../baselines'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DSH_REPO = process.env.DSH_REPO || join(process.env.HOME, 'dev', 'deepseek-harness')
export const STAGE = join(REPO, '.tmp', 'compat')

/** Whether the dsh checkout with the baseline tags is available. */
export function checkoutMissing(): boolean {
  return !existsSync(join(DSH_REPO, '.git'))
}

/** Whether the BUILT plugin artifacts are available. */
export function artifactsMissing(): boolean {
  return !existsSync(join(REPO, 'lib', 'index.js')) || !existsSync(join(REPO, 'lib', 'client.js'))
}

/** Why the registry matrix cannot run here (empty = it can). */
export function skipReasons(): string[] {
  const reasons: string[] = []
  if (checkoutMissing()) {
    reasons.push(`no dsh checkout at ${DSH_REPO} (set DSH_REPO to a deepseek-harness clone with the baseline tags)`)
  }
  if (artifactsMissing()) {
    reasons.push('lib/ is not built — the matrix exercises the BUILT plugin, run `pnpm run build` first')
  }
  return reasons
}

/** `git show <tag>:<path>` from the dsh checkout, as a string. */
export function dshShow(tag: string, path: string): string {
  const run = spawnSync('git', ['-C', DSH_REPO, 'show', `${tag}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`git show ${tag}:${path} failed: ${(run.stderr ?? '').trim().slice(0, 300)}`)
  return run.stdout
}

/** `git grep -l <pattern> <tag> -- <pathspec>`: whether the tag's sources carry the string. */
export function dshHasString(tag: string, pattern: string, pathspec: string): boolean {
  const run = spawnSync('git', ['-C', DSH_REPO, 'grep', '-l', pattern, tag, '--', pathspec], { encoding: 'utf8' })
  return run.status === 0 && run.stdout.trim() !== ''
}

/** Stage one file from the tag under .tmp/compat/<id>/ and return its path. */
export function stageFile(baseline: Baseline, tagPath: string, localName: string): string {
  const dir = join(STAGE, baseline.id, dirname(localName))
  mkdirSync(dir, { recursive: true })
  const file = join(STAGE, baseline.id, localName)
  writeFileSync(file, dshShow(baseline.tag, tagPath))
  return file
}

/** The host packages the tag's staged sources import at runtime, at this line's own versions. */
function hostDepsOf(baseline: Baseline): Record<string, string> {
  return {
    '@deepseek-ai/cordis': baseline.cordis,
    '@deepseek-ai/dsh-session': baseline.session,
  }
}

/** The baseline's host deps, installed once per baseline (npm-cached afterwards). */
export function ensureHostDeps(baseline: Baseline): void {
  const dir = join(STAGE, baseline.id)
  const deps = hostDepsOf(baseline)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-context-compat-${baseline.id}`, private: true, type: 'module',
    dependencies: deps,
  }, null, 2))
  const missing = Object.keys(deps).filter(name => !existsSync(join(dir, 'node_modules', ...name.split('/'))))
  if (missing.length === 0) return
  const run = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], { cwd: dir, encoding: 'utf8' })
  if (run.status !== 0) throw new Error(`npm install ${JSON.stringify(deps)} failed: ${(run.stderr ?? '').trim().slice(0, 300)}`)
}

/** The tag's settings namespace pattern, read off the file the baseline names (null when absent). */
export function namespacePatternOf(baseline: Baseline, file: string): RegExp | null {
  const source = dshShow(baseline.tag, file)
  const match = /^const NAMESPACE_PATTERN = \/(.+)\/([gimsuy]*)$/m.exec(source)
  return match === null ? null : new RegExp(match[1], match[2])
}

export interface DriverReport {
  registered: boolean
  keys: string[]
  gateOk: boolean
  coldMatches: boolean
  /** V4 tool-registry changes survive the real registry's cache/read paths. */
  developerTokens: number | null
  developerRequestTokens: number | null
  developerRestoreMatches: boolean
  /** Issue #44: hostile gateway usage keeps the served values schema-valid on the REAL registry. */
  hostileSnapshotOk: boolean
  hostilePrompt: number | null
  hostileCacheRead: number | null
  /** The registry-side containment gap: throws escaping drive() per poisoned event. */
  poisonedEscapedDrive: number
  /** …while downstream units starve (no change notification for the poisoned event) … */
  poisonedStarves: boolean
  /** …and the whole snapshot (every reconnect baseline) throws. */
  poisonedSnapshotThrows: boolean
}

/**
 * The staged host driver: runs INSIDE the baseline's staging dir, applies the
 * plugin's real host entry into the tag's real registry, drives a canonical
 * log through the registry's own snapshot / checkpoint / restore paths, and
 * reports as one JSON line.
 */
function driverSource(pluginUrl: string, developerMessages: boolean): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from './registry/index.ts'
import { snapshotJsonValue } from './dsh/json-values.ts'
const plugin = await import(${JSON.stringify(pluginUrl)})
const ctx = new Context()
const registry = new SessionProjectionRegistry(ctx)
ctx.sessionProjections = registry
plugin.apply(ctx, {})
const session = { seq: 0, header: { id: 'compat-session', cwd: '/tmp' }, events: [] }
ctx.emit('session/created', session)
const ev = (seq, type, data = {}) => ({ seq, time: 1700000000000 + seq * 1000, type, data })
const drive = (context, target, events) => {
  for (const event of events) {
    target.events[event.seq] = event
    target.seq = event.seq + 1
    context.emit('session/event', target, event)
  }
}
const log = [
  ev(0, 'session/created'),
  ev(1, 'request/header', { header: { tools: [{ name: 'bash', description: 'run' }], config: { model: 'deepseek-v4-flash', provider: 'deepseek' } }, reason: 'initial' }),
  ev(2, 'system/message', { turn: 0, step: 0, message: { content: [{ type: 'text', text: 'You are an agent.' }] } }),
  ev(3, 'request/context', { contextWindow: 128000 }),
  ev(4, 'step/start'),
  ev(5, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
  ev(6, 'assistant/message', { message: { content: [{ type: 'text', text: 'hi' }] } }),
  ev(7, 'tool/call', { callId: 'c1', name: 'bash', arguments: '{}' }),
  ev(8, 'tool/result', { message: { source: { callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] } }),
  ev(9, 'step/end'),
  ev(10, 'plan/mode', { active: true }),
  ev(11, 'compaction/summary', { summary: [{ type: 'text', text: 'so far' }], shadowedSeqs: [5] }),
]
drive(ctx, session, log)
const snapshot = registry.snapshot(session)
const gate = snapshotJsonValue(registry.checkpoint(session))
const cold = registry.restore({}, log, 0, session.header)

// Tool-registry messages exist only in the supported V4 baselines.
let developerTokens = null
let developerRequestTokens = null
let developerRestoreMatches = false
if (${developerMessages}) {
  const ctxC = new Context()
  const registryC = new SessionProjectionRegistry(ctxC)
  ctxC.sessionProjections = registryC
  plugin.apply(ctxC, {})
  const sessionC = { seq: 0, header: { id: 'registry-change-session', cwd: '/tmp' }, events: [] }
  ctxC.emit('session/created', sessionC)
  const registryLog = [
    ev(0, 'request/header', { header: { tools: [{ name: 'read_file', description: 'read a file', parameters: { type: 'object' } }] }, reason: 'change' }),
    ev(1, 'user/message', { content: [{ type: 'text', text: 'hello' }] }),
    ev(2, 'developer/message', { turn: 1, step: 1, headerSeq: 0, message: { role: 'developer', source: { kind: 'tool-registry' }, content: [{ type: 'tool-addition', toolName: 'read_file' }, { type: 'tool-removal', toolName: 'shell' }] } }),
    ev(3, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'reply' }] } }),
  ]
  drive(ctxC, sessionC, registryLog)
  const values = registryC.snapshot(sessionC).values
  const node = values.contextTimeline.nodes.find(n => n.seq === 2)
  developerTokens = node ? node.tokens : null
  developerRequestTokens = values.contextTimeline.requests[0].inject
  const rows = snapshotJsonValue(registryC.checkpoint(sessionC))
  const warm = registryC.restore(rows, registryLog, 0, sessionC.header)
  // Preserve log offsets while reproducing the old fold's ignored event.
  const oldLog = registryLog.map(e => e.type === 'developer/message' ? { ...e, type: 'todo/write' } : e)
  const oldRows = registryC.restore({}, oldLog, 0, sessionC.header).checkpoint
  oldRows.contextTimeline.ver = 24
  const rebuilt = registryC.restore(oldRows, registryLog, 0, sessionC.header)
  developerRestoreMatches = JSON.stringify(warm.snapshot.values) === JSON.stringify(values)
    && JSON.stringify(rebuilt.snapshot.values) === JSON.stringify(values)
}

// ---- Probe A (issue #44): hostile provider usage on the REAL registry. ----
// A mis-accounting gateway's figures (negative uncached input from
// cached_tokens > prompt_tokens, fractional counts, string buckets, a NaN a
// hostile direct-drive could supply) ride the durable log legally; the
// plugin's served values must stay schema-valid through the registry's own
// strict parse on every later delivery.
const hostile = [
  ev(12, 'step/start'),
  ev(13, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'h1' }] }, usage: { inputTokens: -80, cacheReadTokens: 150.7, cacheWriteTokens: '10', outputTokens: 22.4 } }),
  ev(14, 'assistant/message', { turn: 1, step: 3, message: { content: [] }, usage: { inputTokens: NaN, outputTokens: null } },
)]
drive(ctx, session, hostile)
let hostileSnapshotOk = true
let hostilePrompt = null
let hostileCacheRead = null
try {
  const hostileSnap = registry.snapshot(session)
  const rec = hostileSnap.values.contextTimeline.requests.find(r => r.seq === 13)
  hostilePrompt = rec ? rec.prompt : null
  hostileCacheRead = rec ? rec.cacheRead : null
} catch {
  hostileSnapshotOk = false
}

// ---- Probe B (issue #44): the registry-side containment gap. ----
// One upstream wire unit whose view goes schema-invalid on the same gateway
// data (mimicking an official usage-gated unit; official rows register
// BEFORE user plugins) starves every unit registered after it and kills the
// whole snapshot — while the session itself survives (the real Session.append
// contains per-listener throws, which this raw emit mimics with try/catch).
const ctxB = new Context()
const registryB = new SessionProjectionRegistry(ctxB)
ctxB.sessionProjections = registryB
registryB.register({
  key: 'gatewayPoison',
  stateVersion: 1,
  stateSchema: { parse: (v) => v },
  init: () => ({ uncached: 0 }),
  apply: (state, event) => {
    if (event.type !== 'assistant/message' || !event.data || event.data.usage === undefined) return state
    return { uncached: event.data.usage.inputTokens }
  },
  wire: {
    viewSchema: { parse: (v) => { if (typeof v.uncached !== 'number' || !Number.isInteger(v.uncached) || v.uncached < 0) throw new Error('nonconforming gateway figure fails the integer/nonnegative gate'); return v } },
    view: (state) => ({ uncached: state.uncached }),
  },
})
plugin.apply(ctxB, {})
const sessionB = { seq: 0, header: { id: 'poison-session', cwd: '/tmp' }, events: [] }
ctxB.emit('session/created', sessionB)
const notified = []
registryB.onChanged((s, key) => { if (s === sessionB && key === 'contextTimeline') notified.push(key) })
const poisonLog = [
  ev(0, 'request/header', { header: { tools: [], config: { model: 'deepseek-v4-flash', provider: 'p' } }, reason: 'initial' }),
  ev(1, 'assistant/message', { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'ok' }] }, usage: { inputTokens: 10, cacheReadTokens: 20, outputTokens: 5 } }),
]
drive(ctxB, sessionB, poisonLog)
const beforePoison = notified.length
let poisonedEscapedDrive = 0
const gatewayStep = ev(2, 'assistant/message', { turn: 1, step: 2, message: { content: [{ type: 'text', text: 'bad gateway step' }] }, usage: { inputTokens: -80, cacheReadTokens: 150, outputTokens: 22 } })
sessionB.events[2] = gatewayStep
sessionB.seq = 3
try {
  ctxB.emit('session/event', sessionB, gatewayStep)
} catch {
  poisonedEscapedDrive += 1
}
let poisonedSnapshotThrows = false
try { registryB.snapshot(sessionB) } catch { poisonedSnapshotThrows = true }

process.stdout.write('DRIVER-JSON ' + JSON.stringify({
  registered: true,
  keys: Object.keys(snapshot.values).sort(),
  gateOk: gate !== undefined,
  coldMatches: JSON.stringify(cold.snapshot.values) === JSON.stringify(snapshot.values),
  developerTokens,
  developerRequestTokens,
  developerRestoreMatches,
  hostileSnapshotOk,
  hostilePrompt,
  hostileCacheRead,
  poisonedEscapedDrive,
  poisonedStarves: beforePoison > 0 && notified.length === beforePoison,
  poisonedSnapshotThrows,
}) + '\\n')
`
}

/** Stage the registry sources + the lossless-JSON probe and run the driver for one baseline. */
export function runDriver(baseline: Baseline): DriverReport {
  ensureHostDeps(baseline)
  stageFile(baseline, 'packages/session/session-projection/src/index.ts', join('registry', 'index.ts'))
  stageFile(baseline, 'packages/session/session-projection/src/types.ts', join('registry', 'types.ts'))
  stageFile(baseline, 'packages/util/values/src/index.ts', join('dsh', 'json-values.ts'))
  const driver = join(STAGE, baseline.id, 'driver.mjs')
  writeFileSync(driver, driverSource(`file://${join(REPO, 'lib', 'index.js')}`, baseline.foldEventTypes.includes('developer/message')))
  const run = spawnSync(process.execPath, [driver], { cwd: STAGE, encoding: 'utf8', timeout: 60_000 })
  const line = (run.stdout ?? '').split('\n').find(l => l.startsWith('DRIVER-JSON '))
  if (line === undefined) {
    throw new Error(`driver failed: ${(run.stderr ?? run.stdout ?? '').trim().slice(0, 400)}`)
  }
  return JSON.parse(line.slice('DRIVER-JSON '.length)) as DriverReport
}

/** The platform specifiers the built client bundle requires at runtime. */
export function bundleRequires(): string[] {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  return [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))]
}

/**
 * The slot registrations the client half mounts on EVERY baseline (identical
 * spellings in each generation's sources). The preferences card seat and the
 * settings transport are asserted separately, per generation — the matrix
 * spec pins them to the baseline's `settings` seam (`settings.plugin.item` +
 * `settingsScope` through V3, the Plugins page's `plugins.bundle.config` +
 * `configForms` from the Config-form generation on).
 */
export const SLOT_SEAMS = [
  'conversation.view',
  'conversation.chat.assistant-actions',
  'conversation.input.overlay',
] as const

/**
 * The ui-primitives icon seams the client bundle renders, as [modern, legacy]
 * name pairs: the vocabulary renamed across the range (`…Outline16`/`…14`
 * through 0.1.5, `…OutlineRegular`/`…OutlineMedium` from 0.1.6), and a
 * missing name is `undefined` at the browser's runtime — React error #130.
 * `src/client/primitives.ts` resolves whichever spelling the running
 * generation serves; each pair must exist in at least one spelling per tag.
 */
export const ICON_SEAMS = [
  ['IconBranchOutlineRegular', 'IconBranchOutline16'],
  ['IconPlusOutlineRegular', 'IconPlusOutline16'],
  ['IconCheckOutlineRegular', 'IconCheckOutline16'],
  ['IconCopyOutlineRegular', 'IconCopyOutline16'],
  ['IconCloseOutlineRegular', 'IconCloseOutline16'],
  ['IconSettingsOutlineMedium', 'IconSettingsOutline14'],
  ['IconChevronDownOutlineMedium', 'IconChevronDownOutline14'],
] as const

/**
 * The event families the host fold switches on (src/host/fold.ts) — the UNION
 * over every supported generation (developer/message is V4-only). The
 * per-baseline probe asserts the baseline's own `foldEventTypes` subset, and
 * a matrix test asserts this union equals the baselines' union — a fold case
 * added without a baseline list fails loudly instead of going unprobed.
 */
export const FOLD_EVENT_TYPES = [
  'request/header', 'request/context', 'step/start', 'step/end',
  'user/message', 'developer/message', 'tool/call', 'tool/result', 'assistant/message',
  'assistant/attempt', 'tool/ptc-dispatch',
  'plan/mode', 'compaction/summary', 'compaction/prune', 'system/message',
] as const

/** The tag's durable-event vocabulary (packages/core/session/src/known-event-types.ts). */
export async function knownEventTypesOf(baseline: Baseline): Promise<ReadonlySet<string>> {
  const file = stageFile(baseline, 'packages/core/session/src/known-event-types.ts', join('dsh', 'known-event-types.ts'))
  const mod = await import(file)
  return mod.KNOWN_SESSION_EVENT_TYPES as ReadonlySet<string>
}

/** The module-table keys the tag's web shell seeds (packages/client/web/src/platform.ts). */
export async function platformModulesOf(baseline: Baseline): Promise<readonly string[]> {
  const file = stageFile(baseline, 'packages/client/web/src/platform.ts', join('dsh', 'platform.ts'))
  const mod = await import(file)
  return mod.PLATFORM_MODULES as readonly string[]
}
