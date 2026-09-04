// The runtime harness-version probe (src/host/version.ts): both resolution
// anchors, both probe paths (manifest subpath / entry ascend), and every
// degradation arm — the gate's fail-open promise rests on ALL of these
// returning undefined instead of throwing.
//
// Two fixture roots:
//  - tests/host/fixtures/version/homes/* — committed homes whose packages
//    RESOLVE at the fixture level (no walk-up), shared with index.spec.ts.
//  - a per-run tree under os.tmpdir() — the FAILURE cases. They must sit
//    outside the repository: a failing probe inside the repo tree would walk
//    up into the repo's own node_modules and answer with the pinned
//    devDependencies instead of failing.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { detectHarnessVersion } from '../../src/host/version'

const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

/** A `dshHomePath`-shaped resolver rooted at one fixture home under `root`. */
const resolverIn = (root: string) => (...segments: string[]): string => join(root, ...segments)
const homeResolver = (home: string): (...segments: string[]) => string => resolverIn(join(HOMES, home))

/** A ctx carrying only the given `dshHomePath` service value. */
function ctxWithHome(homePath: unknown): Context {
  const ctx = new Context()
  ctx.provide('dshHomePath', homePath)
  return ctx
}

/** A selfUrl anchored inside the given fixture home's profiles dir. */
function selfUrlInto(home: string): string {
  return pathToFileURL(join(HOMES, home, 'profiles', 'probe.cjs')).href
}

const BOGUS_SELF_URL = 'file:///nonexistent/dsh-context-version-probe.cjs'

let scratch = ''

/**
 * Write one scratch probe home. `manifest` is the literal package.json
 * content of the given package; `entry` (when set) becomes the file the
 * manifest's `exports['.']` points at, with `decoy` an optional mismatched
 * manifest placed beside it.
 */
function writeScratchHome(
  home: string,
  packageName: string,
  manifest: string,
  entry?: { path: string; decoyManifest?: string },
): string {
  const dir = join(scratch, home, 'profiles', 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), manifest)
  if (entry !== undefined) {
    const entryPath = join(dir, entry.path)
    mkdirSync(dirname(entryPath), { recursive: true })
    writeFileSync(entryPath, '')
    if (entry.decoyManifest !== undefined) {
      writeFileSync(join(dirname(entryPath), 'package.json'), entry.decoyManifest)
    }
  }
  return join(scratch, home)
}

const scratchResolver = (home: string): (...segments: string[]) => string => resolverIn(join(scratch, home))

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'dsh-context-version-'))
  // The CLI-row-absent fall-through lives in scratch: inside the repo tree a
  // missing CLI package could resolve to an ambient install above the repo
  // (e.g. a global copy under ~/node_modules), making the answer machine-
  // dependent; outside it the walk-up is provably clean.
  writeScratchHome('library-only', '@deepseek-ai/dsh-session-projection',
    JSON.stringify({ name: '@deepseek-ai/dsh-session-projection', version: '0.1.1-rc.2' }))
  writeScratchHome('entry-only', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('entry-nested', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.4', exports: { '.': './a/b/index.js' } }),
    { path: 'a/b/index.js', decoyManifest: JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9' }) })
  // Odd manifests sit as DECOYS on the ascend path: only the direct
  // manifest read (not a resolve) ever surfaces them, and the probe must
  // skip each to reach the owning package's real version.
  writeScratchHome('entry-badjson', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.5', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'not json{' })
  writeScratchHome('entry-null', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.6', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: 'null' })
  writeScratchHome('entry-primitive', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.1-rc.7', exports: { '.': './a/index.js' } }),
    { path: 'a/index.js', decoyManifest: '"oops"' })
  writeScratchHome('entry-orphan', '@deepseek-ai/dsh',
    JSON.stringify({ name: '@deepseek-ai/dsh-orphan', version: '1.0.0', exports: { '.': './index.js' } }),
    { path: 'index.js' })
  writeScratchHome('nonstring-version', '@deepseek-ai/dsh', JSON.stringify({ name: '@deepseek-ai/dsh', version: 42 }))
  writeScratchHome('empty-version', '@deepseek-ai/dsh', JSON.stringify({ name: '@deepseek-ai/dsh', version: '' }))
  mkdirSync(join(scratch, 'empty', 'profiles'), { recursive: true })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectHarnessVersion — home anchor', () => {
  test('reads the CLI package manifest of the running installation', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('old'))), '0.1.1-rc.2')
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('baseline'))), '0.1.2-rc.1')
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('future'))), '0.2.0')
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('dev'))), '0.0.0-dev')
  })

  test('falls through to the library packages when the CLI row is absent', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('library-only'))), '0.1.1-rc.2')
  })

  test('ascends from the entry point when the manifest subpath is not exported', () => {
    const ctx = ctxWithHome(scratchResolver('entry-only'))
    assert.equal(detectHarnessVersion(ctx), '0.1.1-rc.1')
  })

  test('skips mismatched manifests while ascending to the owning package', () => {
    const ctx = ctxWithHome(scratchResolver('entry-nested'))
    assert.equal(detectHarnessVersion(ctx), '0.1.1-rc.4')
  })

  test('skips invalid, null, and primitive manifests met while ascending', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-badjson'))), '0.1.1-rc.5')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-null'))), '0.1.1-rc.6')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-primitive'))), '0.1.1-rc.7')
  })
})

describe('detectHarnessVersion — module anchor', () => {
  test('never probes the CLI package from the module anchor', () => {
    // The fixture pins the CLI at 0.0.1 but the library at the baseline:
    // only the library answer may come back.
    assert.equal(detectHarnessVersion(new Context(), selfUrlInto('module-skips-cli')), '0.1.2-rc.1')
  })

  test('the default self anchor answers with the plugin’s own pinned peers', () => {
    const version = detectHarnessVersion(new Context())
    assert.match(version ?? '', /^\d+\.\d+\.\d+/, 'the repo’s pinned devDependencies answer in tests')
  })
})

describe('detectHarnessVersion — degradation arms (fail open)', () => {
  test('no home service and an unresolvable module anchor → undefined', () => {
    assert.equal(detectHarnessVersion(new Context(), BOGUS_SELF_URL), undefined)
  })

  test('a non-function dshHomePath is ignored', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(42), BOGUS_SELF_URL), undefined)
  })

  test('a home resolver that throws falls through to the module anchor', () => {
    const ctx = ctxWithHome(() => { throw new Error('hostile home') })
    const selfUrl = pathToFileURL(join(scratch, 'library-only', 'profiles', 'probe.cjs')).href
    assert.equal(detectHarnessVersion(ctx, selfUrl), '0.1.1-rc.2')
  })

  test('a hostile ctx.get falls through to the module anchor', () => {
    const hostile = { get() { throw new Error('hostile ctx') } } as unknown as Context
    const selfUrl = pathToFileURL(join(scratch, 'library-only', 'profiles', 'probe.cjs')).href
    assert.equal(detectHarnessVersion(hostile, selfUrl), '0.1.1-rc.2')
  })

  test('a non-file self URL leaves the probe without anchors', () => {
    const ctx = ctxWithHome(scratchResolver('empty'))
    assert.equal(detectHarnessVersion(ctx, 'https://example.invalid/probe.js'), undefined)
  })

  test('a package whose manifest never matches while ascending → undefined', () => {
    const ctx = ctxWithHome(scratchResolver('entry-orphan'))
    assert.equal(detectHarnessVersion(ctx, BOGUS_SELF_URL), undefined)
  })

  test('unreadable/invalid/odd manifests all degrade to undefined', () => {
    for (const home of ['nonstring-version', 'empty-version', 'empty']) {
      const ctx = ctxWithHome(scratchResolver(home))
      assert.equal(detectHarnessVersion(ctx, BOGUS_SELF_URL), undefined, home)
    }
  })
})
