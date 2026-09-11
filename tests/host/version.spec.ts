// The runtime harness-version probe (src/host/version.ts): the running-module
// anchor and its own-closure guard, the home-mirror anchor, both probe paths
// (manifest subpath / entry ascend), and every degradation arm — the gate's
// fail-open promise rests on ALL of these returning undefined instead of
// throwing.
//
// Fixture roots:
//  - tests/host/fixtures/version/homes/* — committed homes whose packages
//    RESOLVE at the fixture level (no walk-up), shared with index.spec.ts.
//  - a per-run tree under os.tmpdir() — the FAILURE cases and the
//    running-tree fixtures. They must sit outside the repository: a failing
//    probe inside the repo tree would walk up into the repo's own node_modules
//    and answer with the pinned devDependencies instead of failing, and a
//    running-tree witness inside the repo would read as this package's own
//    dependency closure.
//
// The running anchor is injected as a URL resolver, and the plugin root as a
// path, so both the trusted and the own-closure arms are exercised hermetically
// (the repo's real defaults are covered by the last case of the degradation
// block).

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
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

/**
 * The running anchor's URL resolver for one fixture home under `root`: real
 * Node resolution from that home's profiles dir, as an installed plugin's own
 * module pipeline would perform it.
 */
function runningResolver(home: string, root: string = HOMES): (specifier: string) => string {
  const anchor = join(root, home, 'profiles', 'running-probe.cjs')
  return specifier => pathToFileURL(createRequire(anchor).resolve(specifier)).href
}

/** A running anchor that never answers, forcing the home anchor. */
const NO_RUNNING = (): string => { throw new Error('no running module tree') }

/**
 * A plugin root that contains no fixture tree — the trusted-witness case.
 * It sits in os.tmpdir() beside (never above) the scratch root.
 */
const ELSEWHERE = join(tmpdir(), 'dsh-context-plugin-root')

/** A running anchor that always answers with one fixed URL. */
const fixedUrl = (url: string) => (): string => url

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
  writeScratchHome('entry-orphan', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-orphan', version: '1.0.0', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('nonstring-version', '@deepseek-ai/dsh', JSON.stringify({ name: '@deepseek-ai/dsh', version: 42 }))
  writeScratchHome('empty-version', '@deepseek-ai/dsh', JSON.stringify({ name: '@deepseek-ai/dsh', version: '' }))
  mkdirSync(join(scratch, 'empty', 'profiles'), { recursive: true })
  // Running-anchor trees: a supported release (the Desktop fix), a below-
  // baseline release (the gate must still trip from the running anchor), and
  // a resolving-but-unreadable library (the trusted witness with no answer).
  writeScratchHome('running-supported', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.5-rc.1', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-old', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-session', version: '0.1.1-rc.2', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
  writeScratchHome('running-decoy', '@deepseek-ai/dsh-session',
    JSON.stringify({ name: '@deepseek-ai/dsh-decoy', version: '9.9.9', exports: { '.': './lib/index.js' } }),
    { path: 'lib/index.js' })
})

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true })
})

describe('detectHarnessVersion — running anchor', () => {
  test('outranks a stale home mirror (issue #59: a healthy Desktop harness)', () => {
    // The mirror names an old global CLI while the running tree is a supported
    // release: the running anchor wins, so the gate never trips.
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('old')), runningResolver('running-supported', scratch), ELSEWHERE), '0.1.5-rc.1')
  })

  test('a below-baseline running tree still trips the gate over a newer mirror', () => {
    // The reverse direction must hold too: a genuinely old harness is reported
    // even when the mirror names something newer.
    assert.equal(detectHarnessVersion(ctxWithHome(homeResolver('future')), runningResolver('running-old', scratch), ELSEWHERE), '0.1.1-rc.2')
  })

  test('discards a witness inside this package own closure for the home anchor', () => {
    // A `link:`-installed dev checkout resolves its own pinned devDependencies:
    // that closure is not the harness, so the home mirror answers instead. The
    // default package root (the real one, which contains the repo's
    // node_modules) performs the discard.
    const ctx = ctxWithHome(homeResolver('old'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli')), '0.1.1-rc.2')
  })

  test('never probes the CLI package from the running anchor', () => {
    // The fixture pins the CLI at 0.0.1 but the library at the baseline: only
    // the library answer may come back.
    const ctx = ctxWithHome(scratchResolver('empty'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('module-skips-cli'), ELSEWHERE), '0.1.2-rc.1')
  })

  test('a resolving witness with no readable version falls through to home', () => {
    // The library resolves, so the witness is trusted, but its manifest name
    // never matches: the anchor yields nothing and home answers.
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, runningResolver('running-decoy', scratch), ELSEWHERE), '0.2.0')
  })

  test('a non-file running URL is no answer', () => {
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, fixedUrl('data:text/javascript,'), ELSEWHERE), '0.2.0')
  })

  test('classifies the plugin root and its parent correctly', () => {
    // A witness equal to the plugin root is inside it (the `relative` result is
    // empty); a witness one level above is reached through `..`.
    const ctx = ctxWithHome(homeResolver('future'))
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), ELSEWHERE), '0.2.0')
    assert.equal(detectHarnessVersion(ctx, fixedUrl(pathToFileURL(ELSEWHERE).href), join(ELSEWHERE, 'inner')), '0.2.0')
  })
})

describe('detectHarnessVersion — home anchor', () => {
  test('reads the CLI package manifest of the running installation', () => {
    const ctx = (home: string) => ctxWithHome(homeResolver(home))
    assert.equal(detectHarnessVersion(ctx('old'), NO_RUNNING), '0.1.1-rc.2')
    assert.equal(detectHarnessVersion(ctx('baseline'), NO_RUNNING), '0.1.2-rc.1')
    assert.equal(detectHarnessVersion(ctx('future'), NO_RUNNING), '0.2.0')
    assert.equal(detectHarnessVersion(ctx('dev'), NO_RUNNING), '0.0.0-dev')
  })

  test('falls through to the library packages when the CLI row is absent', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('library-only')), NO_RUNNING), '0.1.1-rc.2')
  })

  test('ascends from the entry point when the manifest subpath is not exported', () => {
    const ctx = ctxWithHome(scratchResolver('entry-only'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), '0.1.1-rc.1')
  })

  test('skips mismatched manifests while ascending to the owning package', () => {
    const ctx = ctxWithHome(scratchResolver('entry-nested'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), '0.1.1-rc.4')
  })

  test('skips invalid, null, and primitive manifests met while ascending', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-badjson')), NO_RUNNING), '0.1.1-rc.5')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-null')), NO_RUNNING), '0.1.1-rc.6')
    assert.equal(detectHarnessVersion(ctxWithHome(scratchResolver('entry-primitive')), NO_RUNNING), '0.1.1-rc.7')
  })
})

describe('detectHarnessVersion — degradation arms (fail open)', () => {
  test('no running tree and no home service → undefined', () => {
    assert.equal(detectHarnessVersion(new Context(), NO_RUNNING), undefined)
  })

  test('a non-function dshHomePath is ignored', () => {
    assert.equal(detectHarnessVersion(ctxWithHome(42), NO_RUNNING), undefined)
  })

  test('a home resolver that throws yields undefined', () => {
    const ctx = ctxWithHome(() => { throw new Error('hostile home') })
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('a hostile ctx.get yields undefined', () => {
    const hostile = { get() { throw new Error('hostile ctx') } } as unknown as Context
    assert.equal(detectHarnessVersion(hostile, NO_RUNNING), undefined)
  })

  test('the default running anchor discards this package own devDependencies', () => {
    // In the repository the default anchor resolves the repo's pinned
    // devDependencies, which live inside this package's tree: nothing is
    // trusted and there is no home service, so the probe answers undefined
    // (the gate fails open) instead of reading the repo's devDependencies.
    assert.equal(detectHarnessVersion(new Context()), undefined)
  })

  test('a resolving package whose manifest never matches → undefined', () => {
    const ctx = ctxWithHome(scratchResolver('entry-orphan'))
    assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined)
  })

  test('unreadable/invalid/odd manifests all degrade to undefined', () => {
    for (const home of ['nonstring-version', 'empty-version', 'empty']) {
      const ctx = ctxWithHome(scratchResolver(home))
      assert.equal(detectHarnessVersion(ctx, NO_RUNNING), undefined, home)
    }
  })
})
