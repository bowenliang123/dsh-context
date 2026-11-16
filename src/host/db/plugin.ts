import type { Context } from '@deepseek-ai/cordis'
import { existsSync, renameSync } from 'node:fs'
import type { Config } from '../config'
import { resolveBounds } from '../config'
import type { CostSource } from '../cost'
import { detectPluginVersion } from '../version'
import { meetsBaseline } from '../../shared/version'
import { createDb, setCleanShutdown, setVersions, type Db } from './db'
import { DatabaseOpenError, openDatabase, quickCheck, removeDiscard, resolveDatabasePath, type OpenedDatabase } from './open'
import { LiveWriter } from './live'
import { BackfillScheduler } from './scheduler'
import { mountQueryRoutes } from './routes'

export interface StorageHandle {
  scheduler: BackfillScheduler
  live: LiveWriter
  db: Db
  mode: 'file' | 'memory' | 'degraded'
  path: string
  dispose(): void
}

export interface StorageStartOptions {
  cost: CostSource
  harnessVersion?: string
  attribution?: (name: string) => string | undefined
  now?: () => number
}

function quarantine(path: string, now: number): boolean {
  if (!existsSync(path)) return false
  try {
    const target = `${path}.corrupt-${now}`
    renameSync(path, target)
    for (const extension of ['-wal', '-shm']) {
      if (existsSync(`${path}${extension}`)) {
        try {
          renameSync(`${path}${extension}`, `${target}${extension}`)
        } catch {}
      }
    }
    return true
  } catch {
    return false
  }
}

function openOrFallback(ctx: Context, path: string, now: () => number): { opened: OpenedDatabase; mode: 'file' | 'memory' | 'degraded' } {
  try {
    return { opened: openDatabase(path), mode: 'file' }
  } catch (error: unknown) {
    if (error instanceof DatabaseOpenError && error.refused) {
      ctx.logger.warn(`dsh-context: refusing to use ${path}: ${error.message}; storage is degraded`)
      return { opened: openDatabase(':memory:'), mode: 'degraded' }
    }
    ctx.logger.warn(`dsh-context: cannot open ${path}: ${String(error)}; trying a fresh database`)
    if (quarantine(path, now())) {
      try {
        return { opened: openDatabase(path), mode: 'file' }
      } catch (retry: unknown) {
        /* v8 ignore next 1 */
        ctx.logger.warn(`dsh-context: fresh database open failed: ${String(retry)}; falling back to memory`)
      }
    }
    return { opened: openDatabase(':memory:'), mode: 'memory' }
  }
}

export function startStorage(ctx: Context, config: Config, options: StorageStartOptions): StorageHandle {
  const now = options.now ?? Date.now
  const path = resolveDatabasePath(ctx)
  const { opened, mode } = openOrFallback(ctx, path, now)
  const db = createDb(opened.client)
  const bounds = resolveBounds(config)
  const live = new LiveWriter(ctx, db, bounds, {
    pluginOf: options.attribution,
    onFlush: () => {},
  })
  const scheduler = new BackfillScheduler(ctx, db, bounds, {
    live,
    now,
    pluginOf: options.attribution,
    onGeneration: () => {},
  })
  const pluginVersion = detectPluginVersion()
  setVersions(db, options.harnessVersion, pluginVersion)
  setCleanShutdown(db, false)
  scheduler.setPhase(mode === 'degraded' ? 'degraded' : 'open')
  if (mode === 'degraded') scheduler.setDegraded()
  mountQueryRoutes({
    ctx,
    db,
    cost: options.cost,
    scheduler,
    path,
    harnessSupported: options.harnessVersion === undefined || meetsBaseline(options.harnessVersion),
    ...(options.attribution === undefined ? {} : { attribution: options.attribution }),
    mode: mode === 'file' ? 'file' : mode === 'memory' ? 'memory' : 'degraded',
  })
  if (mode !== 'degraded') scheduler.start()
  setImmediate(() => {
    const result = quickCheck(opened.client)
    if (result.ok) {
      scheduler.setIntegrity('ok')
      return
    }
    scheduler.setIntegrity('failed')
    scheduler.setDegraded()
    ctx.logger.warn(`dsh-context: quick_check failed: ${result.detail}`)
  })
  removeDiscard(opened.discardPath)
  if (mode === 'degraded') setCleanShutdown(db, true)
  return {
    scheduler,
    live,
    db,
    mode,
    path,
    dispose(): void {
      scheduler.dispose()
      live.dispose()
      try {
        opened.client.close()
      } catch {}
    },
  }
}
