import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'

const LIBRARY_PROBE_PACKAGES = ['@deepseek-ai/dsh-session-projection', '@deepseek-ai/dsh-session'] as const

const RUNNING_PROBE_PACKAGES = ['@deepseek-ai/dsh-session', '@deepseek-ai/dsh-session-projection'] as const

const HOME_PROBE_PACKAGES = ['@deepseek-ai/dsh', ...LIBRARY_PROBE_PACKAGES] as const

function ownPackageRoot(): string {
  try {
    return dirname(fileURLToPath(import.meta.resolve('dsh-context/package.json')))
  } catch {
    /* v8 ignore next */
    return dirname(fileURLToPath(import.meta.url))
  }
}
const PLUGIN_ROOT = ownPackageRoot()

export function detectPluginVersion(root: string = PLUGIN_ROOT): string {
  return versionOfManifest(join(root, 'package.json'), 'dsh-context') ?? '0.0.0'
}

type Resolve = (specifier: string) => string
type ResolveUrl = (specifier: string) => string

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

function versionViaManifest(resolve: Resolve, packageName: string): string | undefined {
  try {
    return versionOfManifest(resolve(packageName + '/package.json'))
  } catch {
    return undefined
  }
}

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

function probeAnchor(resolve: Resolve, packageNames: readonly string[]): string | undefined {
  for (const packageName of packageNames) {
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate)
  return !rel.startsWith('..') && !isAbsolute(rel)
}

function probeRunningTree(resolve: Resolve, pluginRoot: string): string | undefined {
  for (const packageName of RUNNING_PROBE_PACKAGES) {
    let witness: string
    try {
      witness = resolve(packageName)
    } catch {
      continue
    }
    if (isInside(pluginRoot, witness)) continue
    const version = versionViaManifest(resolve, packageName) ?? versionViaEntry(resolve, packageName)
    if (version !== undefined) return version
  }
  return undefined
}

function resolveRunningModule(specifier: string): string {
  return import.meta.resolve(specifier)
}

export function detectHarnessVersion(
  ctx: Context,
  resolveUrl: ResolveUrl = resolveRunningModule,
  pluginRoot: string = PLUGIN_ROOT,
): string | undefined {
  const running = probeRunningTree((specifier) => {
    const url = resolveUrl(specifier)
    if (!url.startsWith('file:')) throw new Error(`dsh-context: non-file module URL for ${specifier}`)
    return fileURLToPath(url)
  }, pluginRoot)
  if (running !== undefined) return running
  try {
    const homePath = ctx.get('dshHomePath') as unknown
    if (typeof homePath === 'function') {
      const req = createRequire((homePath as (...segments: string[]) => string)('profiles', 'dsh-context-version-probe.cjs'))
      const home = probeAnchor(specifier => req.resolve(specifier), HOME_PROBE_PACKAGES)
      if (home !== undefined) return home
    }
  } catch {}
  return undefined
}
