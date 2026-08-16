#!/usr/bin/env bun
/**
 * Differential fold check — proves the plugin's heuristic context composition
 * equals the official token-meter `contextBreakdown` projection on real
 * session logs: `current.system`/`current.tools`/surface total vs
 * `systemTokens`/`toolsTokens`/`messageTokens`.
 *
 * Since 0.11 the plugin no longer folds provider-anchored occupancy (the
 * client reads the official `contextPressure` projection directly), but the
 * composition numbers still use the plugin's own fixed-density pricing
 * (`pricing.ts`, a mirror of the meter's estimator) — this check keeps that
 * mirror honest against the official projection over real event logs.
 *
 * The official projection is imported from a dsh SOURCE checkout (env
 * DSH_REPO, default ~/dev/deepseek-harness). The checkout needs no install:
 * the needed token-meter/session sources are copied to a temp dir with their
 * bare imports rewritten (zod is only used for persistence schemas, stubbed;
 * canonicalHeader is identity — stored headers are already canonical).
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
rewrite('breakdown-projection.ts', s => s
  .replace("import { z } from 'zod'", "import { z } from './zod-stub.ts'")
  .replace("from '@deepseek-ai/dsh-session'", "from './session-facade.ts'"))
rewrite('surface-projection.ts', s => s
  .replace("from '@deepseek-ai/dsh-session'", "from './surface.ts'"))
rewrite('estimate.ts', s => s)
rewrite('projection.ts', s => s)
writeFileSync(join(dir, 'surface.ts'), String(readFileSync(join(SESS, 'surface.ts'))))
// Stored headers are already canonical (the loop appends canonicalHeader
// output), so an identity is faithful for the pricing check.
writeFileSync(join(dir, 'session-facade.ts'), `export const canonicalHeader = (h) => h\n`)
// zod stub: the persistence schemas are built at module top level but never
// exercised by init/apply/view — a chainable no-op satisfies construction.
writeFileSync(join(dir, 'zod-stub.ts'), `
const stub: any = new Proxy(() => stub, { get: () => stub, apply: () => stub })
export const z = stub
`)
const { contextBreakdownProjectionDefinition } = await import(pathToFileURL(join(dir, 'breakdown-projection.ts')).href)

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

  // Official fold: token-meter's contextBreakdown projection, verbatim.
  let st = contextBreakdownProjectionDefinition.init()
  for (const ev of events) st = contextBreakdownProjectionDefinition.apply(st, ev)
  const breakdown = contextBreakdownProjectionDefinition.view(st)

  // Plugin fold through its public projection unit (same mounting as host.test).
  let def = null
  apply({
    inject(list, cb) { cb(this) },
    effect(fn) { fn(); return () => {} },
    sessionProjections: { register(d) { def = d; return () => {} } },
  })
  let mine = def.init()
  for (const ev of events) mine = def.apply(mine, ev)
  const view = def.view(mine)
  const surfaceTotal = view.current.total - view.current.system - view.current.tools

  const match = view.current.system === breakdown.systemTokens
    && view.current.tools === breakdown.toolsTokens
    && surfaceTotal === breakdown.messageTokens
  if (!match) failed = 1
  console.log(
    (match ? 'MATCH    ' : 'MISMATCH ')
    + file
    + ' official=' + String(breakdown.systemTokens) + '/' + String(breakdown.toolsTokens) + '/' + String(breakdown.messageTokens)
    + ' plugin=' + String(view.current.system) + '/' + String(view.current.tools) + '/' + String(surfaceTotal),
  )
}
process.exit(failed)