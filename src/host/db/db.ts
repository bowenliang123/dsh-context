import type { DatabaseSync } from 'node:sqlite'
import { drizzle } from 'drizzle-orm/node-sqlite'
import { eq, sql } from 'drizzle-orm'
import { meta } from './schema'

export function createDb(client: DatabaseSync) {
  return drizzle({ client })
}

export type Db = ReturnType<typeof createDb>

export interface MetaSnapshot {
  epoch: string
  generation: number
  pricingVersion: number
  cleanShutdown: boolean
  harnessVersion?: string
  pluginVersion?: string
}

export function metaValue(db: Db, key: string): string | undefined {
  return db.select({ value: meta.value }).from(meta).where(eq(meta.key, key)).get()?.value
}

export function setMeta(db: Db, key: string, value: string): void {
  db.insert(meta).values({ key, value }).onConflictDoUpdate({ target: meta.key, set: { value } }).run()
}

export function metaInt(db: Db, key: string, fallback = 0): number {
  const value = metaValue(db, key)
  if (value === undefined) return fallback
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function metaSnapshot(db: Db): MetaSnapshot {
  const epoch = metaValue(db, 'db_epoch') ?? '0'
  return {
    epoch,
    generation: metaInt(db, 'data_generation'),
    pricingVersion: metaInt(db, 'pricing_version'),
    cleanShutdown: metaValue(db, 'clean_shutdown') === '1',
    ...(metaValue(db, 'harness_version') === undefined ? {} : { harnessVersion: metaValue(db, 'harness_version') }),
    ...(metaValue(db, 'plugin_version') === undefined ? {} : { pluginVersion: metaValue(db, 'plugin_version') }),
  }
}

export function bumpGeneration(db: Db): void {
  db.update(meta).set({ value: sql`cast(cast(${meta.value} as integer) + 1 as text)` })
    .where(eq(meta.key, 'data_generation')).run()
}

export function setCleanShutdown(db: Db, clean: boolean): void {
  setMeta(db, 'clean_shutdown', clean ? '1' : '0')
}

export function setVersions(db: Db, harnessVersion: string | undefined, pluginVersion: string): void {
  if (harnessVersion !== undefined) setMeta(db, 'harness_version', harnessVersion)
  setMeta(db, 'plugin_version', pluginVersion)
}
