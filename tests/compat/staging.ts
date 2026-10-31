import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Baseline } from '../baselines'

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
export const DSH_REPO = process.env.DSH_REPO || join(process.env.HOME, 'dev', 'deepseek-harness')
export const STAGE = join(REPO, '.tmp', 'compat')

export function checkoutMissing(): boolean {
  return !existsSync(join(DSH_REPO, '.git'))
}

export function artifactsMissing(): boolean {
  return !existsSync(join(REPO, 'lib', 'index.js')) || !existsSync(join(REPO, 'lib', 'client.js'))
}

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

export function dshShow(tag: string, path: string): string {
  const run = spawnSync('git', ['-C', DSH_REPO, 'show', `${tag}:${path}`], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
  if (run.status !== 0) throw new Error(`git show ${tag}:${path} failed: ${(run.stderr ?? '').trim().slice(0, 300)}`)
  return run.stdout
}

export function dshHasString(tag: string, pattern: string, pathspec: string): boolean {
  const run = spawnSync('git', ['-C', DSH_REPO, 'grep', '-l', pattern, tag, '--', pathspec], { encoding: 'utf8' })
  return run.status === 0 && run.stdout.trim() !== ''
}

export function stageFile(baseline: Baseline, tagPath: string, localName: string): string {
  const dir = join(STAGE, baseline.id, dirname(localName))
  mkdirSync(dir, { recursive: true })
  const file = join(STAGE, baseline.id, localName)
  writeFileSync(file, dshShow(baseline.tag, tagPath))
  return file
}

function stageFileIfPresent(baseline: Baseline, tagPath: string, localName: string): boolean {
  const run = spawnSync('git', ['-C', DSH_REPO, 'cat-file', '-e', `${baseline.tag}:${tagPath}`], { encoding: 'utf8' })
  if (run.status !== 0) return false
  stageFile(baseline, tagPath, localName)
  return true
}

function hostDepsOf(baseline: Baseline): Record<string, string> {
  return {
    '@deepseek-ai/cordis': baseline.cordis,
    '@deepseek-ai/dsh-session': baseline.session,
    semver: '^7.8.5',
  }
}

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

export interface AdmissionReport {
  baseline: { admitted: boolean; requirements: Record<string, string> | null }
  dropped: { admitted: boolean; requirements: Record<string, string> | null }
}

function admissionSource(manifestUrl: string, supportedRuntime: string, droppedRuntime: string): string {
  return `
import { readFileSync } from 'node:fs'
import { evaluatePluginCompatibility } from './boot/plugin-compatibility.ts'
const manifest = JSON.parse(readFileSync(new URL(${JSON.stringify(manifestUrl)}), 'utf8'))
const evaluate = version => {
  const issue = evaluatePluginCompatibility(manifest, {}, version)
  return { admitted: issue === undefined, requirements: issue === undefined ? null : (issue.requirements ?? issue.peers) }
}
process.stdout.write('ADMISSION-JSON ' + JSON.stringify({
  baseline: evaluate(${JSON.stringify(supportedRuntime)}),
  dropped: evaluate(${JSON.stringify(droppedRuntime)}),
}) + '\\n')
`
}

export function evaluateAdmission(baseline: Baseline): AdmissionReport {
  ensureHostDeps(baseline)
  stageFile(baseline, 'packages/boot/app-boot/src/plugin-compatibility.ts', join('boot', 'plugin-compatibility.ts'))
  const driver = join(STAGE, baseline.id, 'admission.mjs')
  writeFileSync(driver, admissionSource(`file://${join(REPO, 'package.json')}`, baseline.version, '0.1.7-rc.2'))
  const run = spawnSync(process.execPath, [driver], { cwd: STAGE, encoding: 'utf8', timeout: 60_000 })
  const line = (run.stdout ?? '').split('\n').find(l => l.startsWith('ADMISSION-JSON '))
  if (line === undefined) throw new Error(`admission driver failed: ${(run.stderr ?? run.stdout ?? '').trim().slice(0, 400)}`)
  return JSON.parse(line.slice('ADMISSION-JSON '.length)) as AdmissionReport
}

export interface DriverReport {
  keys: string[]
  gateOk: boolean
  coldMatches: boolean
  developerTokens: number | null
  developerRequestTokens: number | null
  developerRestoreMatches: boolean
  hostileSnapshotOk: boolean
  hostilePrompt: number | null
  hostileCacheRead: number | null
  poisonedEscapedDrive: number
  poisonedStarves: boolean
  poisonedSnapshotThrows: boolean
}

function driverSource(pluginUrl: string): string {
  return `
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from './registry/index.ts'
import { snapshotJsonValue } from './dsh/index.ts'
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

let developerTokens = null
let developerRequestTokens = null
let developerRestoreMatches = false
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
const oldLog = registryLog.map(e => e.type === 'developer/message' ? { ...e, type: 'todo/write' } : e)
const oldRows = registryC.restore({}, oldLog, 0, sessionC.header).checkpoint
oldRows.contextTimeline.ver = 24
const rebuilt = registryC.restore(oldRows, registryLog, 0, sessionC.header)
developerRestoreMatches = JSON.stringify(warm.snapshot.values) === JSON.stringify(values)
  && JSON.stringify(rebuilt.snapshot.values) === JSON.stringify(values)

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

export function runDriver(baseline: Baseline): DriverReport {
  ensureHostDeps(baseline)
  stageFile(baseline, 'packages/session/session-projection/src/index.ts', join('registry', 'index.ts'))
  stageFile(baseline, 'packages/session/session-projection/src/types.ts', join('registry', 'types.ts'))
  stageFile(baseline, 'packages/util/values/src/index.ts', join('dsh', 'index.ts'))
  stageFileIfPresent(baseline, 'packages/util/values/src/partial-json.ts', join('dsh', 'partial-json.ts'))
  const driver = join(STAGE, baseline.id, 'driver.mjs')
  writeFileSync(driver, driverSource(`file://${join(REPO, 'lib', 'index.js')}`))
  const run = spawnSync(process.execPath, [driver], { cwd: STAGE, encoding: 'utf8', timeout: 60_000 })
  const line = (run.stdout ?? '').split('\n').find(l => l.startsWith('DRIVER-JSON '))
  if (line === undefined) {
    throw new Error(`driver failed: ${(run.stderr ?? run.stdout ?? '').trim().slice(0, 400)}`)
  }
  return JSON.parse(line.slice('DRIVER-JSON '.length)) as DriverReport
}

export function bundleRequires(): string[] {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  return [...new Set([...source.matchAll(/require\("([^"]+)"\)/g)].map(m => m[1]))]
}

export const SLOT_SEAMS = [
  'conversation.view',
  'conversation.chat.assistant-actions',
  'conversation.input.overlay',
] as const

export const ICON_SEAMS = [
  'IconBranchOutlineRegular',
  'IconPlusOutlineRegular',
  'IconCheckOutlineRegular',
  'IconCopyOutlineRegular',
  'IconCloseOutlineRegular',
  'IconSettingsOutlineMedium',
  'IconChevronDownOutlineMedium',
  'IconChevronUpOutlineMedium',
  'IconSearchOutlineRegular',
  'IconDataOutlineRegular',
  'IconDatabaseOutlineRegular',
  'IconClockOutlineRegular',
  'IconGaugeOutlineRegular',
  'IconCompareSplitOutlineRegular',
  'IconBrowseOutlineRegular',
  'IconContextInjectionOutlineRegular',
  'IconFolderOpenOutlineRegular',
  'IconApiOutlineRegular',
  'IconInspectOutlineRegular',
  'IconPluginPinwheelOutlineRegular',
  'FileTypeIcon',
] as const

export function foldEventTypesFromSource(): readonly string[] {
  const source = readFileSync(join(REPO, 'src', 'host', 'fold.ts'), 'utf8')
  const labels = [...source.matchAll(/^\s*case '([a-z-]+\/[a-z-]+)':/gm)].map(m => m[1])
  if (labels.length === 0) throw new Error('fold.ts: no event case labels found — the matrix cannot verify the baseline lists')
  return [...new Set(labels)].sort()
}

export async function knownEventTypesOf(baseline: Baseline): Promise<ReadonlySet<string>> {
  const file = stageFile(baseline, 'packages/core/session/src/known-event-types.ts', join('dsh', 'known-event-types.ts'))
  const mod = await import(file)
  return mod.KNOWN_SESSION_EVENT_TYPES as ReadonlySet<string>
}

export async function platformModulesOf(baseline: Baseline): Promise<readonly string[]> {
  const file = stageFile(baseline, 'packages/client/web/src/platform.ts', join('dsh', 'platform.ts'))
  const mod = await import(file)
  return mod.PLATFORM_MODULES as readonly string[]
}
