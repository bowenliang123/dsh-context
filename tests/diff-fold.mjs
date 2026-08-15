#!/usr/bin/env bun
/**
 * Differential fold check — proves the plugin's provider-anchored occupancy
 * equals the official chat ring's `contextPressure.projectedTokens` on real
 * session logs.
 *
 * The official projection is imported from a dsh SOURCE checkout (env
 * DSH_REPO, default ~/dev/deepseek-harness). The checkout needs no install:
 * the needed token-meter/session sources are copied to a temp dir with their
 * bare imports rewritten (zod is only used for persistence schemas, stubbed).
 *
 * Usage:
 *   bun tests/diff-fold.mjs <session.jsonl> [more.jsonl...]
 *   zstd -dc ~/.dsh/sessions/<ws>/<sid>/session.jsonl.zstd > /tmp/s.jsonl
 *
 * Exit code 0 when every log matches, 1 otherwise.
 */
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { apply } from '../lib/index.js'

const DSH_REPO = process.env.DSH_REPO || `${process.env.HOME}/dev/deepseek-harness`

// Stage the official sources with rewritten imports (no pnpm install needed).
const dir = mkdtempSync(join(tmpdir(), 'dsh-diff-fold-'))
const TM = join(DSH_REPO, 'packages/llm/token-meter/src')
const SESS = join(DSH_REPO, 'packages/core/session/src')
const rewrite = (file, fn) => writeFileSync(join(dir, file), fn(String(readFileSync(file.startsWith('/') ? file : join(TM, file)))))
rewrite('usage-projection.ts', s => s
  .replace("import { z } from 'zod'", "import { z } from './zod-stub.ts'"))
rewrite('surface-projection.ts', s => s
  .replace("from '@deepseek-ai/dsh-session'", "from './surface.ts'"))
rewrite('estimate.ts', s => s)
rewrite('projection.ts', s => s)
writeFileSync(join(dir, 'surface.ts'), String(readFileSync(join(SESS, 'surface.ts'))))
// zod stub: the persistence schemas are built at module top level but never
// exercised by init/apply/view — a chainable no-op satisfies construction.
writeFileSync(join(dir, 'zod-stub.ts'), `
const stub: any = new Proxy(() => stub, { get: () => stub, apply: () => stub })
export const z = stub
`)
const { contextPressureProjectionDefinition } = await import(pathToFileURL(join(dir, 'usage-projection.ts')).href)

const files = process.argv.slice(2)
if (files.length === 0) {
  console.error('usage: bun tests/diff-fold.mjs <session.jsonl> [...]')
  process.exit(2)
}

let failed = 0
for (const file of files) {
  const lines = readFileSync(file, 'utf8').split('\n').filter(l => l.trim() !== '')
  const events = []
  for (const line of lines) {
    let ev
    try { ev = JSON.parse(line) } catch { continue }
    if (ev !== null && typeof ev === 'object' && typeof ev.seq === 'number') events.push(ev)
  }

  // Official fold: token-meter's contextPressure projection, verbatim.
  let st = contextPressureProjectionDefinition.init()
  for (const ev of events) st = contextPressureProjectionDefinition.apply(st, ev)
  const pressure = contextPressureProjectionDefinition.view(st)

  // Plugin fold through its public RPC handler (same mounting as host.test).
  let handler = null
  const sessionsMap = new Map([['s1', { events }]])
  apply({
    get(name) {
      if (name === 'sessions') return { get: id => sessionsMap.get(id) }
      if (name === 'sessionQuery') return { listEvents: async () => [], readSession: async () => ({ events: [] }) }
      return undefined
    },
    effect(fn) { fn(); return () => {} },
    connection: { rpc: { handle(_ch, fn) { handler = fn; return async () => {} } } },
  })
  const snap = (await handler('snapshot', { sessionId: 's1' })).value
  const occ = snap.occupancy ?? {}

  const match = occ.projectedTokens === pressure.projectedTokens && occ.contextWindow === pressure.contextWindow
  if (!match) failed = 1
  console.log(
    (match ? 'MATCH    ' : 'MISMATCH ')
    + file
    + ' official=' + String(pressure.projectedTokens) + '/' + String(pressure.contextWindow)
    + ' plugin=' + String(occ.projectedTokens) + '/' + String(occ.contextWindow),
  )
}
process.exit(failed)
