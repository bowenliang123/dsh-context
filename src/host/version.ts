/**
 * Runtime harness-version probe behind the baseline gate (host/index.ts).
 *
 * The probe never imports a harness package for its version; it reads
 * manifests through Node resolution from two anchors, in order:
 *
 *  1. The harness home's healed `profiles/node_modules` mirror (located via
 *     the app-boot `dshHomePath` service) — it symlinks/proxies the running
 *     installation's dependency closure, so it names the true release even
 *     when this plugin is a `link:`-installed dev checkout.
 *  2. This module itself — in a real profile install the plugin sits inside
 *     the profile's node_modules and walk-up resolution reaches the same
 *     mirror; this anchor also covers harnesses too old to provide the home
 *     service.
 *
 * The `@deepseek-ai/dsh` CLI package is probed ONLY through the home anchor:
 * the plugin never depends on it, so a hit from the module anchor can only
 * be an ambient install above the plugin's tree (e.g. a global copy under
 * ~/node_modules) — not necessarily the RUNNING harness.
 *
 * Every step is guarded: any failure (absent service, unresolvable package,
 * unreadable/invalid manifest, non-string version) degrades to `undefined`,
 * and the gate treats an unknown version as SATISFIED — a probe misfire must
 * never blank a working deployment.
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

/**
 * Library packages whose manifest version IS the harness release version
 * (the dsh monorepo versions every package in lockstep). From the plugin's
 * own tree they resolve to its pinned devDependencies in dev and to the
 * healed profiles mirror in real installs — both correct — so they are safe
 * to probe from either anchor.
 */
const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

/** Home-anchor probe order: the user-facing CLI version first, then the libraries. */
const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

type Resolve = (specifier: string) => string

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
 * The running harness's version string, or undefined when nothing answers
 * (the gate fails open on it — see the header note).
 * @param selfUrl - the module anchor (injectable for hermetic tests).
 */
export function detectHarnessVersion(ctx: Context, selfUrl: string = import.meta.url): string | undefined {
  try {
    // The app-boot home resolver (`dshHomePath(...segments)`); an absent or
    // hostile service leaves the module anchor as the only probe.
    const homePath = ctx.get('dshHomePath') as unknown
    if (typeof homePath === 'function') {
      const req = createRequire((homePath as (...segments: string[]) => string)('profiles', 'dsh-context-version-probe.cjs'))
      const home = probeAnchor(specifier => req.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch { /* the module anchor below still answers */ }
  try {
    const req = createRequire(selfUrl)
    return probeAnchor(specifier => req.resolve(specifier), LIBRARY_PROBE_PACKAGES)
  } catch {
    // A non-file self URL: no anchor answered.
    return undefined
  }
}
