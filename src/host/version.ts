/**
 * Runtime harness-version probe behind the baseline gate (host/index.ts).
 *
 * The probe never imports a harness package for its version; it reads
 * manifests through Node resolution from two anchors, in order:
 *
 *  1. This module's own ESM resolution of the library packages the Host half
 *     imports at runtime. That is the very pipeline the process resolves those
 *     imports through, so an embedding shell that redirects plugin imports —
 *     the packaged Desktop's ASAR resolver bridge does exactly this — redirects
 *     the probe identically, and the answer names the module instances the
 *     harness is actually running. A witness that lands inside this package's
 *     own tree is the plugin's dependency closure (a `link:`-installed dev
 *     checkout's pinned devDependencies), never the harness, so it is discarded
 *     for the home anchor.
 *  2. The harness home's healed `profiles/node_modules` mirror (located via
 *     the app-boot `dshHomePath` service). It names the installation that last
 *     healed it: authoritative for a dev checkout, whose own tree holds pinned
 *     devDependencies, but only as fresh as the last CLI profile boot. A
 *     packaged Desktop never heals it, so a stale global-CLI mirror can outlive
 *     the CLI and misname the running harness — that is why it answers only
 *     when the running anchor has nothing it can trust.
 *
 * The `@deepseek-ai/dsh` CLI package is probed ONLY through the home anchor:
 * the plugin never imports it, so a hit from the running anchor can only be an
 * ambient install above the plugin's tree (e.g. a global copy under
 * ~/node_modules) — not necessarily the RUNNING harness.
 *
 * Every step is guarded: any failure (absent service, unresolvable package,
 * non-file URL, unreadable/invalid manifest, non-string version) degrades to
 * `undefined`, and the gate treats an unknown version as SATISFIED — a probe
 * misfire must never blank a working deployment.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Library packages whose manifest version IS the harness release version (the
 * dsh monorepo versions every package in lockstep). The home anchor probes
 * them after the CLI package; the running anchor probes the two first- and
 * second-ordered.
 */
const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

/**
 * Running-anchor probe order: the package the Host half genuinely imports at
 * runtime first (host/fold.ts imports it, so it MUST resolve whenever this
 * plugin runs), then its co-versioned sibling.
 */
const RUNNING_PROBE_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection'] as const

/** Home-anchor probe order: the user-facing CLI version first, then the libraries. */
const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

/**
 * This package's root. A running-anchor witness under it belongs to the
 * plugin's own dependency closure, not to the harness.
 *
 * Located through the package's own `./package.json` self-reference: Node
 * resolves that against the nearest package.json, so the answer is the package
 * root in the source tree and in the bundled profile install alike — a fixed
 * number of `..` steps cannot be, since `src/host/` and `lib/` differ by a
 * level. A loader that cannot self-resolve (an exotic loader, or a fork renamed
 * without a matching `exports`) falls back to this module's own directory: the
 * guard then covers less of the package, but it still can never mistake the
 * plugin's own `node_modules` for the harness.
 */
function ownPackageRoot(): string {
  try {
    return dirname(fileURLToPath(import.meta.resolve('dsh-context/package.json')))
  } catch {
    /* v8 ignore next -- a loader that cannot resolve one of its own package's
       published subpaths is out of the suite's reach; the fallback keeps one
       probe path (an unanswered probe fails open either way). */
    return dirname(fileURLToPath(import.meta.url))
  }
}
const PLUGIN_ROOT = ownPackageRoot()

type Resolve = (specifier: string) => string
/** Resolve a specifier to its module URL through this module's own pipeline. */
type ResolveUrl = (specifier: string) => string

/** One manifest's `version`, or undefined on any read/shape failure. */
function versionOfManifest(manifestPath: string, expectedName?: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return undefined
    const record = parsed as { name?: unknown; version?: unknown }
    if (expectedName !== undefined && record.name !== expectedName) return undefined
    return typeof record.version === 'string' && record.version !== '' ? record.version : undefined
  } catch {
    return undefined
  }
}

/** Probe the package's published `./package.json` subpath. */
function versionViaManifest(resolve: Resolve, packageName: string): string | undefined {
  try {
    return versionOfManifest(resolve(packageName + '/package.json'))
  } catch {
    // The export map publishes no such subpath (or the package is absent).
    return undefined
  }
}

/**
 * Probe via the package's entry point, ascending to its owning manifest.
 * Covers the packaged-executable module proxies: their generated manifests
 * carry the real version but export only entry stubs, and Node's exports
 * gate refuses the direct `./package.json` subpath.
 */
function versionViaEntry(resolve: Resolve, packageName: string): string | undefined {
  let dir: string
  try {
    dir = dirname(resolve(packageName))
  } catch {
    return undefined
  }
  for (;;) {
    const version = versionOfManifest(join(dir, 'package.json'), packageName)
    if (version !== undefined) return version
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/** One anchor's answer: the first probe package that yields a version. */
function probeAnchor(resolve: Resolve, packageNames: readonly string[]): string | undefined {
  for (const packageName of packageNames) {
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/**
 * Whether `candidate` lies inside `root`'s tree. A `..`-prefixed relative path
 * escapes it; a sibling such as `dsh-context-extra` is reached through `..` too,
 * so it never counts as a child. A pathological child literally named `..foo`
 * would degrade to the home anchor, which is the safe direction.
 */
function isInside(root: string, candidate: string): boolean {
  return !relative(root, candidate).startsWith('..')
}

/**
 * The running module tree's answer, or undefined when it cannot be trusted.
 * Each probe package is checked on its own: a witness inside the plugin's own
 * closure is the plugin's dependency, not the harness, and a trusted witness
 * whose manifest cannot be read is no answer either — the next package may
 * still resolve to one.
 */
function probeRunningTree(resolve: Resolve, pluginRoot: string): string | undefined {
  for (const packageName of RUNNING_PROBE_PACKAGES) {
    let witness: string
    try {
      witness = resolve(packageName)
    } catch {
      // Absent from this anchor; the next package may still answer.
      continue
    }
    if (isInside(pluginRoot, witness)) continue
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

/** The default running anchor: this module's own ESM resolution. */
function resolveRunningModule(specifier: string): string {
  return import.meta.resolve(specifier)
}

/**
 * The running harness's version string, or undefined when nothing answers
 * (the gate fails open on it — see the header note).
 * @param resolveUrl - the running anchor's URL resolver (injectable for hermetic tests).
 * @param pluginRoot - this package's root for the own-closure check (injectable for hermetic tests).
 */
export function detectHarnessVersion(
  ctx: Context,
  resolveUrl: ResolveUrl = resolveRunningModule,
  pluginRoot: string = PLUGIN_ROOT,
): string | undefined {
  // The running anchor. A non-file URL (an exotic loader) cannot name a
  // manifest on disk, so it counts as no answer and the home anchor answers.
  const running = probeRunningTree((specifier) => {
    const url = resolveUrl(specifier)
    if (!url.startsWith('file:')) throw new Error(`dsh-context: non-file module URL for ${specifier}`)
    return fileURLToPath(url)
  }, pluginRoot)
  if (running !== undefined) return running
  try {
    // The app-boot home resolver (`dshHomePath(...segments)`); an absent or
    // hostile service leaves the probe without an answer (the gate fails open).
    const homePath = ctx.get('dshHomePath') as unknown
    if (typeof homePath === 'function') {
      const req = createRequire((homePath as (...segments: string[]) => string)('profiles', 'dsh-context-version-probe.cjs'))
      const home = probeAnchor(specifier => req.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch { /* nothing answered; the gate fails open */ }
  return undefined
}
