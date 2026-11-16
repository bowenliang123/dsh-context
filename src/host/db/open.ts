import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { getTableName } from 'drizzle-orm'
import type { Context } from '@deepseek-ai/cordis'
import { CREATE_SCHEMA_SQL } from './schema.generated'
import { APPLICATION_ID, DROP_ORDER, SCHEMA_VERSION, TABLES } from './schema'

const REBUILD_RENAME_BYTES = 8 * 1024 * 1024

const USER_TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"

const KNOWN_TABLES = new Set<string>(TABLES.map(table => getTableName(table)))

export type OpenFailureReason =
  | 'foreign-database'
  | 'unowned-database'
  | 'unknown-tables'
  | 'corrupt'
  | 'open-failed'

export class DatabaseOpenError extends Error {
  readonly refused: boolean

  constructor(readonly reason: OpenFailureReason, message: string, refused: boolean) {
    super(message)
    this.name = 'DatabaseOpenError'
    this.refused = refused
  }
}

export type StartupPhase = 'open' | 'hydrating' | 'ready' | 'degraded' | 'rebuilding'

export interface OpenedDatabase {
  client: DatabaseSync
  mode: 'file' | 'memory'
  rebuilt: boolean
  discardPath?: string
  epoch: string
}

export interface OpenDatabaseOptions {
  now?: () => number
  epoch?: () => string
  renameThresholdBytes?: number
}

interface GateResult {
  rebuild: boolean
  reason?: string
}

function userTables(client: DatabaseSync): string[] {
  const rows = client.prepare(USER_TABLES_SQL).all() as { name?: unknown }[]
  return rows.map(row => String(row.name)).filter(name => name !== '')
}

function scalar(client: DatabaseSync, pragma: string): number {
  const row = client.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>
  return Number(Object.values(row)[0])
}

function gate(client: DatabaseSync): GateResult {
  const applicationId = scalar(client, 'application_id')
  const version = scalar(client, 'user_version')
  const tables = userTables(client)
  if (applicationId !== 0 && applicationId !== APPLICATION_ID) {
    throw new DatabaseOpenError('foreign-database', 'index.sqlite belongs to another application', true)
  }
  if (applicationId === 0 && tables.length > 0) {
    throw new DatabaseOpenError('unowned-database', 'index.sqlite has tables but no dsh-context application id', true)
  }
  if (applicationId === 0) return { rebuild: false }
  if (version !== SCHEMA_VERSION) return { rebuild: true }
  const unknown = tables.filter(name => !KNOWN_TABLES.has(name))
  if (unknown.length > 0) {
    throw new DatabaseOpenError('unknown-tables', `index.sqlite has unknown tables: ${unknown.join(', ')}`, true)
  }
  const missing = [...KNOWN_TABLES].filter(name => !tables.includes(name))
  if (missing.length > 0) return { rebuild: true }
  return { rebuild: false, reason: 'ready' }
}

function applyPragmas(client: DatabaseSync): void {
  try {
    client.exec('PRAGMA journal_mode = WAL')
  } catch {}
  client.exec('PRAGMA foreign_keys = ON')
  client.exec('PRAGMA busy_timeout = 5000')
  client.exec('PRAGMA synchronous = NORMAL')
  client.exec('PRAGMA cache_size = -8000')
}

function dropAll(client: DatabaseSync): void {
  client.exec('PRAGMA foreign_keys = OFF')
  for (const name of DROP_ORDER) client.exec(`DROP TABLE IF EXISTS "${name}"`)
  client.exec('PRAGMA user_version = 0')
}

function createSchema(client: DatabaseSync, epoch: string, now: number): void {
  client.exec(`PRAGMA application_id = ${APPLICATION_ID}`)
  client.exec(CREATE_SCHEMA_SQL)
  client.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`)
  const insert = client.prepare('INSERT INTO meta(key, value) VALUES (?, ?)')
  const values: [string, string][] = [
    ['db_epoch', epoch],
    ['data_generation', '0'],
    ['pricing_version', '0'],
    ['seeded_at', String(now)],
    ['clean_shutdown', '0'],
  ]
  client.exec('BEGIN IMMEDIATE')
  for (const [key, value] of values) insert.run(key, value)
  client.exec('COMMIT')
}

function renameAside(path: string, suffix: string, now: number): string {
  const target = `${path}.${suffix}-${now}`
  renameSync(path, target)
  for (const extension of ['-wal', '-shm']) {
    if (existsSync(`${path}${extension}`)) {
      try {
        renameSync(`${path}${extension}`, `${target}${extension}`)
      } catch {}
    }
  }
  return target
}

function openFile(client: DatabaseSync, path: string, epoch: string, now: number, options: OpenDatabaseOptions): OpenedDatabase {
  const result = gate(client)
  if (result.rebuild) {
    const size = (() => {
      try {
        return statSync(path).size
      } catch {
        return 0
      }
    })()
    if (size > (options.renameThresholdBytes ?? REBUILD_RENAME_BYTES)) {
      client.close()
      try {
        const discardPath = renameAside(path, 'rebuild', now)
        const fresh = new DatabaseSync(path)
        applyPragmas(fresh)
        createSchema(fresh, epoch, now)
        return { client: fresh, mode: 'file', rebuilt: true, discardPath, epoch }
      } catch (error) {
        throw new DatabaseOpenError('open-failed', `cannot replace index.sqlite: ${String(error)}`, false)
      }
    }
    dropAll(client)
  }
  createSchemaIfNeeded(client, epoch, now)
  applyPragmas(client)
  return { client, mode: 'file', rebuilt: result.rebuild, epoch }
}

function createSchemaIfNeeded(client: DatabaseSync, epoch: string, now: number): void {
  const applicationId = scalar(client, 'application_id')
  const version = scalar(client, 'user_version')
  if (applicationId === APPLICATION_ID && version === SCHEMA_VERSION) return
  dropAll(client)
  createSchema(client, epoch, now)
}

export function defaultEpoch(now: number): string {
  return `${now.toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export function databasePath(home: string): string {
  return `${home}/storages/dsh-context/index.sqlite`
}

export function resolveDatabasePath(
  ctx: Context,
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  try {
    const dshHomePath: unknown = ctx.get('dshHomePath')
    if (typeof dshHomePath === 'function') {
      const path = (dshHomePath as (...segments: string[]) => unknown)('storages', 'dsh-context', 'index.sqlite')
      if (typeof path === 'string' && path !== '') return path
    }
  } catch {}
  const root = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME : join(home, '.dsh')
  return join(root, 'storages', 'dsh-context', 'index.sqlite')
}

function ensureDirectory(path: string): void {
  const directory = dirname(path)
  mkdirSync(directory, { recursive: true, mode: 0o700 })
}

export function openDatabase(path: string, options: OpenDatabaseOptions = {}): OpenedDatabase {
  const now = options.now ?? Date.now
  const at = now()
  const epoch = options.epoch?.() ?? defaultEpoch(at)
  if (path === ':memory:') {
    const client = new DatabaseSync(':memory:')
    createSchema(client, epoch, at)
    applyPragmas(client)
    return { client, mode: 'memory', rebuilt: false, epoch }
  }
  try {
    ensureDirectory(path)
  } catch (error) {
    throw new DatabaseOpenError('open-failed', `cannot create the database directory: ${String(error)}`, false)
  }
  let client: DatabaseSync
  try {
    client = new DatabaseSync(path)
  } catch (error) {
    throw new DatabaseOpenError('open-failed', `cannot open index.sqlite: ${String(error)}`, false)
  }
  try {
    return openFile(client, path, epoch, at, options)
  } catch (error) {
    try {
      client.close()
    } catch {}
    if (error instanceof DatabaseOpenError) throw error
    throw new DatabaseOpenError('open-failed', String(error), false)
  }
}

export function quickCheck(client: DatabaseSync): { ok: boolean; detail: string } {
  try {
    const rows = client.prepare('PRAGMA quick_check').all() as Record<string, unknown>[]
    const details = rows.map(row => String(Object.values(row)[0]))
    const ok = details.length === 1 && details[0] === 'ok'
    return { ok, detail: details.join('; ') }
  } catch (error) {
    return { ok: false, detail: String(error) }
  }
}

export function quarantine(client: DatabaseSync, path: string, now: number): string | null {
  try {
    client.close()
  } catch {}
  try {
    const target = renameAside(path, 'corrupt', now)
    return target
  } catch {
    return null
  }
}

export function removeDiscard(path: string | undefined): void {
  if (path === undefined) return
  for (const candidate of [path, `${path}-wal`, `${path}-shm`]) {
    try {
      rmSync(candidate, { force: true })
    } catch {}
  }
}

export function tableNames(client: DatabaseSync): string[] {
  return userTables(client)
}
