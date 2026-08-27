/// <reference types="node" />
/**
 * Live tool→plugin attribution layered on the static recovery in
 * toolSources.ts.
 *
 * The session log records tools as plain `ToolSchema` entries (name /
 * description / parameters) — the registering plugin is not in there.
 * toolSources.ts derives the deterministic sources (harness-logged field,
 * `mcp:<server>` naming, pinned first-party map). This module additionally
 * watches RUNTIME registrations: cordis fires the `internal/get` waterfall on
 * every context read of a service property, passing the READING context as the
 * first argument, so `reader.fiber.name` identifies the plugin that is about
 * to call `register()`.
 *
 * - The `internal/get` handler records who last read the `tools` service and
 *   wraps that instance's `register` (once, tracked by a WeakSet) to capture
 *   the reader at registration time into a live map.
 * - When the reader slot is missing, root-named, or this plugin's own (e.g.
 *   LOCAL-LINK plugins — dev installs via `dsh plugin add <path>` or
 *   npm/pnpm link — whose anonymous entrypoints make cordis fall back to the
 *   root name), the wrapped `register` falls back to the call stack: the first
 *   frame outside this package is resolved to its nearest `package.json`
 *   `name`. That covers both npm installs (`node_modules/<pkg>`) and local
 *   links (any directory carrying a package.json), which never pass through
 *   node_modules. Frames that resolve back to this package are skipped.
 * - `ownerOf(name)` keeps the static chain authoritative, then consults the
 *   live map, and finally tags tools that were ALREADY registered when the
 *   hook installed (the boot snapshot — third-party bundles, e.g. local
 *   links like dsh-file-claim, that applied before dsh-context) with the
 *   `UNKNOWN_TOOL_SOURCE` sentinel: their registering plugin is unknowable,
 *   and a bare gap would read as "no plugin" instead of "unknown plugin".
 *
 * Best-effort by design: a read separated from `register()` by an `await` can
 * be overwritten by another plugin's read (misattribution) and the stack
 * fallback needs a resolvable package.json — both degrade to the static chain;
 * registrations that predate the hook degrade to the unknown tag. The hook
 * costs roughly +1.4us per service-property read and is negligible on the
 * rare register path (the stack walk only runs when the reader slot is
 * unusable, and its package lookups are cached per directory).
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../shared/types'
import { resolveToolSource } from './toolSources'

export interface ToolAttribution {
  /** Best-effort label of the plugin that registered `name`, if any is known. */
  ownerOf(name: string): string | undefined
}

/** This module's own file URL — the stack walk skips its own frames. */
const selfUrl = normalize(fileURLToPath(import.meta.url))

/** Directory → package-name cache for the synchronous walk below. */
const packageCache = new Map<string, string | undefined>()

/**
 * Best-effort package name for a module file: walk up to the nearest
 * `package.json` carrying a `name`. Works for dependencies installed under
 * `node_modules` as well as local links whose package root is any on-disk
 * directory. The per-directory results are cached.
 * @param file - absolute path of a module file.
 */
export function packageNameFrom(file: string): string | undefined {
  let dir = dirname(file)
  for (let depth = 0; depth < 12; depth++) {
    const cached = packageCache.get(dir)
    if (cached !== undefined) return cached
    const packageFile = join(dir, 'package.json')
    if (existsSync(packageFile)) {
      try {
        const name = (JSON.parse(readFileSync(packageFile, 'utf8')) as { name?: unknown }).name
        if (typeof name === 'string' && name) {
          packageCache.set(dir, name)
          return name
        }
      } catch {
        // Malformed or unreadable package.json — keep walking up.
      }
    }
    const parent = dirname(dir)
    packageCache.set(dir, undefined)
    if (parent === dir) return undefined
    dir = parent
  }
  return undefined
}

const FRAME_POSITION = /:\d+:\d+$/

/** Package name of this module's own package (self-fallbacks are filtered). */
const selfPackage = packageNameFrom(selfUrl)

/**
 * Resolve the registering package from a stack trace: walk frames from the
 * innermost out, skipping this module's own frames and frames that resolve to
 * this package, and return the package name of the first frame that resolves
 * elsewhere. Works with both `file://` URLs and bare absolute paths
 * (transpiled modules render without a scheme), with optional `fn (...)` and
 * `async` wrappers.
 * @param stack - `Error().stack`, or undefined when no fallback is desired.
 */
export function callerPackageFrom(stack: string | undefined): string | undefined {
  if (!stack) return undefined
  for (const raw of stack.split('\n').slice(1)) {
    let line = raw.trim()
    if (!line.startsWith('at ')) continue
    line = line.slice(3)
    if (line.startsWith('async ')) line = line.slice(6)
    line = line.replace(/\)\s*$/, '')
    const position = FRAME_POSITION.exec(line)
    if (!position) continue
    let target = line.slice(0, -position[0].length)
    if (target.includes('(')) {
      target = target.slice(target.lastIndexOf('(') + 1)
    }
    if (target.startsWith('file://')) {
      try {
        target = normalize(fileURLToPath(target))
      } catch {
        // Unparseable file URL — try the next frame.
        continue
      }
    } else if (!/^[A-Za-z]:[\\/]/.test(target) && !target.startsWith('/') && !target.startsWith('\\\\')) {
      continue
    } else {
      target = normalize(target)
    }
    if (target === selfUrl) continue
    const name = packageNameFrom(target)
    if (name !== undefined && name !== selfPackage) return name
  }
  return undefined
}

/** The tool service's boot-time surface this module reads: the global layer's name→∞ entries. */
interface ToolServiceLike {
  layers?: {
    global?: {
      tools?: {
        entries?: () => Iterable<[string, unknown]>
      }
    }
  }
}

/**
 * Install the runtime-attribution hook on a cordis app context. The hook
 * rides the calling fiber's lifetime (`ctx.on` / `ctx.get`), so it is
 * disposed with the plugin.
 * @param ctx - the context the dsh-context plugin runs in; its fiber name is
 * excluded from attributions.
 */
export function createToolAttribution(ctx: Context): ToolAttribution {
  const live = new Map<string, string>()
  const wrapped = new WeakSet()
  const self = ctx.fiber.name
  let lastReader: Context | undefined

  const wrapInstance = (tools: unknown) => {
    if (!tools || typeof tools !== 'object' || wrapped.has(tools)) return
    const register = (tools as { register?: unknown }).register
    if (typeof register !== 'function') return
    wrapped.add(tools)
    const instance = tools as { register: (this: unknown, definition?: { name?: unknown }) => unknown }
    instance.register = function (definition?) {
      const toolName = definition?.name
      let owner = lastReader?.fiber.name
      if (!owner || owner === 'root' || owner === self) {
        owner = callerPackageFrom(new Error().stack)
      }
      const dispose = (register as (this: unknown, definition?: unknown) => unknown).call(this, definition)
      if (typeof toolName === 'string' && owner && owner !== 'root' && owner !== self && owner !== selfPackage) {
        live.set(toolName, owner)
        if (typeof dispose === 'function') {
          return () => {
            try {
              return (dispose as () => unknown)()
            } finally {
              live.delete(toolName)
            }
          }
        }
      }
      return dispose
    }
  }

  ctx.on('internal/get', (reader, name, _error, next) => {
    if (name !== 'tools') return next() as unknown
    const tools = next() as unknown
    lastReader = reader
    wrapInstance(tools)
    return tools
  })

  // An instance provided before this plugin started is still wrapped so later
  // registrations on it are captured. The tools it already holds were
  // registered before this hook could observe them (boot-time third-party
  // bundles that applied first — e.g. local links like dsh-file-claim), so
  // their provider is unknowable; the boot snapshot lets ownerOf tag them
  // with UNKNOWN_TOOL_SOURCE instead of silently showing nothing.
  const toolsService = ctx.get('tools', false) as ToolServiceLike | undefined
  wrapInstance(toolsService)
  const boot = new Set<string>()
  try {
    const toolEntries = toolsService?.layers?.global?.tools
    // Method-style call: NamedEntries.entries() reads `this.data`, so the
    // receiver must be preserved. Any shape surprise just leaves the boot
    // snapshot empty (static chain + live map still rule); attribution must
    // never take the caller's startup down.
    if (toolEntries !== undefined && typeof toolEntries.entries === 'function') {
      for (const [name] of toolEntries.entries()) boot.add(name)
    }
  } catch {
    // Unsupported tool-service internals — degrade to no boot snapshot.
  }

  return {
    ownerOf: name =>
      resolveToolSource(name) ?? live.get(name) ?? (boot.has(name) ? UNKNOWN_TOOL_SOURCE : undefined),
  }
}
