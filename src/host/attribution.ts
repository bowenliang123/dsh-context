/// <reference types="node" />

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { UNKNOWN_TOOL_SOURCE } from '../shared/types'
import { mcpSourceOf, pinnedSourceOf } from './toolSources'

export interface ToolAttribution {
  ownerOf(name: string): string | undefined
}

const selfUrl = normalize(fileURLToPath(import.meta.url))

const packageCache = new Map<string, string | undefined>()

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

const CORDIS_ORIGINAL = Symbol.for('cordis.original')

function rawInstanceOf(tools: unknown): unknown {
  const raw = (tools as { [key: symbol]: unknown } | undefined | null)?.[CORDIS_ORIGINAL]
  return raw ?? tools
}

const selfPackage = packageNameFrom(selfUrl)

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

interface ToolServiceLike {
  layers?: {
    global?: {
      tools?: {
        entries?: () => Iterable<[string, unknown]>
      }
    }
  }
}

export function createToolAttribution(ctx: Context, harnessVersion?: string): ToolAttribution {
  const live = new Map<string, string>()
  const wrapped = new WeakSet()
  const self = ctx.fiber.name
  let lastReader: string | undefined
  const patched: (() => void)[] = []

  const wrapInstance = (tools: unknown) => {
    if (!tools || typeof tools !== 'object' || wrapped.has(tools)) return
    const register = (tools as { register?: unknown }).register
    if (typeof register !== 'function') return
    wrapped.add(tools)
    const original = (register as { attributedOriginal?: unknown }).attributedOriginal ?? register
    if (typeof original !== 'function') return
    const instance = tools as { register: (this: unknown, definition?: { name?: unknown }, ...args: unknown[]) => unknown }
    const wrappedRegister = function (this: unknown, definition?: { name?: unknown }, ...args: unknown[]) {
      const toolName = definition?.name
      let owner = lastReader
      if (!owner || owner === 'root' || owner === self) {
        owner = callerPackageFrom(new Error().stack)
      }
      const dispose: unknown = Reflect.apply(original, this, [definition, ...args])
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
    ;(wrappedRegister as { attributedOriginal?: unknown }).attributedOriginal = original
    instance.register = wrappedRegister
    patched.push(() => {
      if (instance.register === wrappedRegister) instance.register = original as typeof instance.register
    })
  }

  ctx.on('internal/get', (reader, name, _error, next) => {
    if (name !== 'tools') return next() as unknown
    const tools = next() as unknown
    lastReader = reader.fiber.name
    wrapInstance(rawInstanceOf(tools))
    return tools
  })

  ctx.effect(() => () => {
    for (const restore of patched.splice(0)) restore()
  }, 'tools.register attribution')

  const toolsService = rawInstanceOf(ctx.get('tools', false)) as ToolServiceLike | undefined
  wrapInstance(toolsService)
  const boot = new Set<string>()
  try {
    const toolEntries = toolsService?.layers?.global?.tools
    if (toolEntries !== undefined && typeof toolEntries.entries === 'function') {
      for (const [name] of toolEntries.entries()) boot.add(name)
    }
  } catch {
  }
  return {
    ownerOf: name =>
      mcpSourceOf(name) ?? live.get(name) ?? pinnedSourceOf(name, harnessVersion)
        ?? (boot.has(name) ? UNKNOWN_TOOL_SOURCE : undefined),
  }
}
