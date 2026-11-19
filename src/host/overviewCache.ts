import { readFile, rm, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { NODE_ATOMIC_FS, storagePathOf, writeFileAtomic } from './storage'
import type { HostSession, SessionMaterialization } from './overviewCorpus'
import { hostSessionFromMaterialization, parseSessionMaterialization, stableHashOf } from './overviewCorpus'
import { asRecord } from './record'
import { optionalNumOf } from './overviewDecode'
import { ACTIVITY_STATE_VERSION } from './activity'
import { TIMELINE_STATE_VERSION } from './timeline'
import { resolveBounds, type Config } from './config'

export const OVERVIEW_CACHE_FORMAT = 3
export const OVERVIEW_CACHE_FILE = 'overview-cache.v3'

const LEGACY_CACHE_FILES = ['overview-cache.v1.json', 'overview-cache.v2.json']
const SHARD_COUNT = 64
const DEFAULT_DEBOUNCE_MS = 2_000
const DEFAULT_STAT_CONCURRENCY = 16
const DEFAULT_CAPTURE_CONCURRENCY = 4
const DEFAULT_SHARD_CONCURRENCY = 4
const DEFAULT_MAX_PENDING_RECORDS = 256
const DEFAULT_MAX_PENDING_BYTES = 8 * 1024 * 1024
const DEFAULT_CAPACITY_WAIT_MS = 5_000

export interface OverviewFoldVersions {
  timeline: number
  activity: number
  config: string
}

export function overviewFoldVersions(config?: Config): OverviewFoldVersions {
  return {
    timeline: TIMELINE_STATE_VERSION,
    activity: ACTIVITY_STATE_VERSION,
    config: JSON.stringify(resolveBounds(config)),
  }
}

function sameVersions(left: OverviewFoldVersions | undefined, right: OverviewFoldVersions): boolean {
  return left !== undefined && left.timeline === right.timeline && left.activity === right.activity && left.config === right.config
}

function parseVersions(value: unknown): OverviewFoldVersions | undefined {
  const data = asRecord(value)
  if (data === null || typeof data.timeline !== 'number' || !Number.isSafeInteger(data.timeline)
    || typeof data.activity !== 'number' || !Number.isSafeInteger(data.activity)
    || typeof data.config !== 'string') return undefined
  return { timeline: data.timeline, activity: data.activity, config: data.config }
}

interface CacheFileInfo {
  size: number
  mtimeMs: number
}

export interface CacheFs {
  stat(path: string): Promise<CacheFileInfo>
  readFile(path: string): Promise<string>
  writeFile(path: string, data: string): Promise<void>
  rename(from: string, to: string): Promise<void>
  mkdir(path: string): Promise<void>
  rm?(path: string): Promise<void>
}

const NODE_FS: CacheFs = {
  stat: async (path) => {
    const info = await stat(path)
    return { size: info.size, mtimeMs: info.mtimeMs }
  },
  readFile: path => readFile(path, 'utf8'),
  writeFile: (path, data) => NODE_ATOMIC_FS.writeFile(path, data),
  rename: (from, to) => NODE_ATOMIC_FS.rename(from, to),
  mkdir: path => NODE_ATOMIC_FS.mkdir(path),
  rm: async (path) => { await rm(path, { force: true }) },
}

export interface DurableIdentity {
  path: string
  sizeBytes: number
  mtimeMs: number
}

export interface CachedSession {
  session: HostSession
  identity: DurableIdentity | null
  versions?: OverviewFoldVersions
}

interface CanonicalRecord {
  materialization: SessionMaterialization
  identity: DurableIdentity | null
  versions?: OverviewFoldVersions
}

interface Descriptor {
  id: string
  shard: number
  json: string
  bytes: number
  sequence: number
}

interface Batch {
  records: Map<string, Descriptor>
  bytes: number
  retain: ReadonlySet<string> | null
  retainOrder: number
}

export interface OverviewCacheLoad {
  sessions: Map<string, HostSession>
  identities: Map<string, DurableIdentity | null>
  rebuild: Set<string>
}

export interface OverviewCacheProbe {
  warm: Set<string>
  identities: Map<string, DurableIdentity | null>
  rebuild: Set<string>
}

interface ValidatedRecords extends OverviewCacheProbe {
  records: Map<string, CanonicalRecord>
}

export interface OverviewCacheRefresh {
  identities: Map<string, DurableIdentity | null>
  changed: Set<string>
}

export interface StatHost {
  stat?(id: string): Promise<unknown>
}

export interface OverviewCacheOptions {
  path?: string
  fs?: CacheFs
  now?: () => number
  debounceMs?: number
  statConcurrency?: number
  captureConcurrency?: number
  maxPendingRecords?: number
  maxPendingBytes?: number
  capacityWaitMs?: number
  config?: Config
}

export interface OverviewCache {
  load(currentIds: ReadonlySet<string>, known?: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheLoad>
  probe(currentIds: ReadonlySet<string>): Promise<OverviewCacheProbe>
  refresh(currentIds: ReadonlySet<string>, known: ReadonlyMap<string, DurableIdentity | null>): Promise<OverviewCacheRefresh>
  capture(ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>>
  save(records: readonly CachedSession[], retain?: ReadonlySet<string>): Promise<boolean>
  flush(): Promise<void>
  dispose(): Promise<void>
}

export function overviewCachePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return storagePathOf(OVERVIEW_CACHE_FILE, env, home)
}

export function identityKey(identity: DurableIdentity | null | undefined): string {
  if (identity === null || identity === undefined) return '?'
  return `${identity.path}\u0000${String(identity.sizeBytes)}\u0000${String(identity.mtimeMs)}`
}

function sameIdentity(left: DurableIdentity | null, right: DurableIdentity | null): boolean {
  if (left === null || right === null) return left === right
  return left.path === right.path && left.sizeBytes === right.sizeBytes && left.mtimeMs === right.mtimeMs
}

function identityOf(value: unknown): DurableIdentity | null {
  const data = asRecord(value)
  if (data === null) return null
  if (typeof data.path !== 'string' || data.path === '') return null
  const sizeBytes = optionalNumOf(data.sizeBytes)
  const mtimeMs = optionalNumOf(data.mtimeMs)
  if (sizeBytes === undefined || mtimeMs === undefined) return null
  return { path: data.path, sizeBytes, mtimeMs }
}

function recordOf(value: unknown): CanonicalRecord | undefined {
  const data = asRecord(value)
  const materialization = parseSessionMaterialization(data?.materialization)
  if (materialization === undefined) return undefined
  const rawIdentity = data?.identity
  const identity = rawIdentity === null || rawIdentity === undefined ? null : identityOf(rawIdentity)
  if (rawIdentity !== null && rawIdentity !== undefined && identity === null) return undefined
  return { materialization, identity, versions: parseVersions(data?.versions) }
}

function shardOf(id: string): number {
  return stableHashOf([id]) & (SHARD_COUNT - 1)
}

function shardPath(root: string, shard: number): string {
  return join(root, `shard-${String(shard).padStart(2, '0')}.json`)
}

function emptyBatch(): Batch {
  return { records: new Map(), bytes: 0, retain: null, retainOrder: 0 }
}

function hasWork(batch: Batch): boolean {
  return batch.records.size > 0 || batch.retain !== null
}

function prunedBy(batch: Batch, descriptor: Descriptor): boolean {
  return batch.retain !== null && descriptor.sequence <= batch.retainOrder && !batch.retain.has(descriptor.id)
}

async function inBatches<T>(items: readonly T[], size: number, run: (item: T) => Promise<void>): Promise<void> {
  for (let index = 0; index < items.length; index += size) {
    await Promise.all(items.slice(index, index + size).map(run))
    if (index + size < items.length) await new Promise(resolve => setImmediate(resolve))
  }
}

export function createOverviewCache(options: OverviewCacheOptions = {}): OverviewCache {
  const path = options.path ?? overviewCachePath()
  const fs = options.fs ?? NODE_FS
  const now = options.now ?? (() => Date.now())
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS
  const statConcurrency = options.statConcurrency ?? DEFAULT_STAT_CONCURRENCY
  const captureConcurrency = options.captureConcurrency ?? DEFAULT_CAPTURE_CONCURRENCY
  const maxPendingRecords = options.maxPendingRecords ?? DEFAULT_MAX_PENDING_RECORDS
  const maxPendingBytes = options.maxPendingBytes ?? DEFAULT_MAX_PENDING_BYTES
  const capacityWaitMs = options.capacityWaitMs ?? DEFAULT_CAPACITY_WAIT_MS
  const versions = overviewFoldVersions(options.config)
  let timer: ReturnType<typeof setTimeout> | null = null
  let pending = emptyBatch()
  let active: Batch | null = null
  let disposed = false
  let batchEpoch = 0
  let drainPromise: Promise<boolean> | null = null
  let saveSequence = 0
  let activeSaves = 0
  let pruneSequence = 0
  let latestRetain: ReadonlySet<string> | null = null
  const acceptedSequences = new Map<string, number>()
  const capacityWaiters = new Set<() => void>()

  const clearTimer = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  const notifyCapacity = (): void => {
    const waiters = [...capacityWaiters]
    capacityWaiters.clear()
    for (const resolve of waiters) resolve()
  }

  const readShard = async (shard: number): Promise<Map<string, CanonicalRecord>> => {
    const records = new Map<string, CanonicalRecord>()
    try {
      const data = asRecord(JSON.parse(await fs.readFile(shardPath(path, shard))))
      if (data === null || data.format !== OVERVIEW_CACHE_FORMAT || !Array.isArray(data.sessions)) return records
      for (const entry of data.sessions) {
        const record = recordOf(entry)
        if (record !== undefined) records.set(record.materialization.facts.id, record)
      }
    } catch {}
    return records
  }

  const writeShard = async (batch: Batch, shard: number): Promise<boolean> => {
    const target = shardPath(path, shard)
    const temp = `${target}.tmp`
    try {
      const merged = await readShard(shard)
      let changed = false
      if (batch.retain !== null) {
        for (const id of merged.keys()) {
          if (batch.retain.has(id)) continue
          merged.delete(id)
          changed = true
        }
      }
      for (const descriptor of batch.records.values()) {
        if (descriptor.shard !== shard || prunedBy(batch, descriptor)) continue
        const incoming = JSON.parse(descriptor.json) as CanonicalRecord
        merged.set(descriptor.id, incoming)
        changed = true
      }
      if (!changed) return true
      const body = JSON.stringify({ format: OVERVIEW_CACHE_FORMAT, savedAt: now(), sessions: [...merged.values()] })
      await writeFileAtomic(fs, target, body)
      return true
    } catch {
      try {
        await fs.rm?.(temp)
      } catch {}
      return false
    }
  }

  const removeLegacy = async (): Promise<void> => {
    if (fs.rm === undefined) return
    await Promise.all(LEGACY_CACHE_FILES.map(async (file) => {
      try {
        await fs.rm?.(join(dirname(path), file))
      } catch {}
    }))
  }

  const drain = async (): Promise<boolean> => {
    let batches = 0
    let success = true
    while (active !== null || hasWork(pending)) {
      if (active === null) {
        active = pending
        pending = emptyBatch()
        batchEpoch++
        clearTimer()
        notifyCapacity()
      }
      const batch = active
      const shards = new Set<number>()
      if (batch.retain !== null) {
        for (let shard = 0; shard < SHARD_COUNT; shard++) shards.add(shard)
      } else {
        for (const descriptor of batch.records.values()) shards.add(descriptor.shard)
      }
      const results = await inBatchesSet(shards, async shard => writeShard(batch, shard))
      batches++
      if (!results) {
        success = false
        break
      }
      active = null
      notifyCapacity()
    }
    if (batches > 0 && success) await removeLegacy()
    return success
  }

  const clearHistory = (): void => {
    if (activeSaves > 0 || active !== null || hasWork(pending) || drainPromise !== null) return
    acceptedSequences.clear()
    latestRetain = null
    pruneSequence = 0
  }

  const requestDrain = (): Promise<boolean> => {
    if (drainPromise === null) {
      drainPromise = drain().finally(() => {
        drainPromise = null
        if (active === null && hasWork(pending)) void requestDrain()
        else if (active === null) clearHistory()
      })
    }
    return drainPromise
  }

  const scheduleDrain = (): void => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      void requestDrain()
    }, debounceMs)
    ;(timer as { unref?: () => void }).unref?.()
  }

  const waitForCapacity = async (): Promise<boolean> => {
    return await new Promise<boolean>((resolve) => {
      const ready = (): void => {
        clearTimeout(timeout)
        resolve(!disposed)
      }
      const timeout = setTimeout(() => {
        capacityWaiters.delete(ready)
        resolve(false)
      }, capacityWaitMs)
      ;(timeout as { unref?: () => void }).unref?.()
      capacityWaiters.add(ready)
    })
  }

  const accept = async (descriptor: Descriptor): Promise<boolean> => {
    for (;;) {
      if (disposed) return false
      if (descriptor.sequence <= pruneSequence && latestRetain !== null && !latestRetain.has(descriptor.id)) return true
      if ((acceptedSequences.get(descriptor.id) ?? -1) > descriptor.sequence) return true
      const previous = pending.records.get(descriptor.id)
      const bytes = pending.bytes - (previous?.bytes ?? 0) + descriptor.bytes
      const records = pending.records.size - (previous === undefined ? 0 : 1) + 1
      const oversizedAlone = descriptor.bytes > maxPendingBytes && pending.records.size === 0
      if ((records <= maxPendingRecords && bytes <= maxPendingBytes) || oversizedAlone) {
        pending.records.set(descriptor.id, descriptor)
        acceptedSequences.set(descriptor.id, descriptor.sequence)
        pending.bytes = bytes
        scheduleDrain()
        if (records >= maxPendingRecords || bytes >= maxPendingBytes || oversizedAlone) void requestDrain()
        return true
      }
      void requestDrain()
      if (!await waitForCapacity()) return false
    }
  }

  const applyOverlay = (records: Map<string, CanonicalRecord>, batch: Batch | null, ids: ReadonlySet<string>): void => {
    if (batch === null) return
    if (batch.retain !== null) {
      for (const id of records.keys()) {
        if (!batch.retain.has(id)) records.delete(id)
      }
    }
    for (const descriptor of batch.records.values()) {
      if (!ids.has(descriptor.id) || prunedBy(batch, descriptor)) continue
      const record = JSON.parse(descriptor.json) as CanonicalRecord
      records.set(descriptor.id, record)
    }
  }

  const readRecords = async (ids: ReadonlySet<string>): Promise<Map<string, CanonicalRecord>> => {
    for (;;) {
      const epoch = batchEpoch
      const activeOverlay = active
      const pendingOverlay = pending
      const records = new Map<string, CanonicalRecord>()
      const shards = new Set<number>()
      for (const id of ids) shards.add(shardOf(id))
      await inBatches([...shards], statConcurrency, async (shard) => {
        const stored = await readShard(shard)
        for (const [id, record] of stored) {
          if (ids.has(id)) records.set(id, record)
        }
      })
      if (epoch !== batchEpoch) continue
      applyOverlay(records, activeOverlay, ids)
      applyOverlay(records, pendingOverlay, ids)
      return records
    }
  }

  const validate = async (
    ids: ReadonlySet<string>,
    known?: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<ValidatedRecords> => {
    const records = await readRecords(ids)
    const warm = new Set<string>()
    const identities = new Map<string, DurableIdentity | null>()
    const rebuild = new Set<string>()
    await inBatches([...records.values()], statConcurrency, async (record) => {
      const id = record.materialization.facts.id
      const complete = sameVersions(record.versions, versions)
      if (known !== undefined) {
        const expected = known.get(id) ?? null
        identities.set(id, expected)
        if (complete && record.identity !== null && sameIdentity(record.identity, expected)) warm.add(id)
        else rebuild.add(id)
        return
      }
      if (record.identity === null) {
        identities.set(id, null)
        rebuild.add(id)
        return
      }
      try {
        const info = await fs.stat(record.identity.path)
        if (info.size === record.identity.sizeBytes && info.mtimeMs === record.identity.mtimeMs) {
          identities.set(id, record.identity)
          if (complete) warm.add(id)
          else rebuild.add(id)
          return
        }
        identities.set(id, { path: record.identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
        rebuild.add(id)
      } catch {
        identities.set(id, null)
        rebuild.add(id)
      }
    })
    return { records, warm, identities, rebuild }
  }

  const load = async (
    currentIds: ReadonlySet<string>,
    known?: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<OverviewCacheLoad> => {
    const validated = await validate(currentIds, known)
    const sessions = new Map<string, HostSession>()
    for (const [id, record] of validated.records) {
      if (validated.warm.has(id)) sessions.set(id, hostSessionFromMaterialization(record.materialization))
    }
    return { sessions, identities: validated.identities, rebuild: validated.rebuild }
  }

  const probe = async (currentIds: ReadonlySet<string>): Promise<OverviewCacheProbe> => {
    const validated = await validate(currentIds)
    return { warm: validated.warm, identities: validated.identities, rebuild: validated.rebuild }
  }

  const refresh = async (
    currentIds: ReadonlySet<string>,
    known: ReadonlyMap<string, DurableIdentity | null>,
  ): Promise<OverviewCacheRefresh> => {
    const identities = new Map<string, DurableIdentity | null>()
    const changed = new Set<string>()
    const targets: { id: string; identity: DurableIdentity }[] = []
    for (const id of currentIds) {
      const identity = known.get(id)
      if (identity === null || identity === undefined) continue
      targets.push({ id, identity })
    }
    await inBatches(targets, statConcurrency, async ({ id, identity }) => {
      try {
        const info = await fs.stat(identity.path)
        if (info.size === identity.sizeBytes && info.mtimeMs === identity.mtimeMs) {
          identities.set(id, identity)
          return
        }
        identities.set(id, { path: identity.path, sizeBytes: info.size, mtimeMs: info.mtimeMs })
        changed.add(id)
      } catch {
        identities.set(id, null)
        changed.add(id)
      }
    })
    return { identities, changed }
  }

  const capture = async (ids: readonly string[], host: StatHost): Promise<Map<string, DurableIdentity | null>> => {
    const identities = new Map<string, DurableIdentity | null>()
    const statOf = typeof host.stat === 'function' ? host.stat.bind(host) : undefined
    await inBatches(ids, captureConcurrency, async (id) => {
      identities.set(id, await captureOne(id, statOf, fs))
    })
    return identities
  }

  const save = async (records: readonly CachedSession[], currentIds?: ReadonlySet<string>): Promise<boolean> => {
    if (disposed) return false
    activeSaves++
    const sequence = ++saveSequence
    try {
      if (currentIds !== undefined) {
        latestRetain = new Set(currentIds)
        pruneSequence = sequence
        pending.retain = latestRetain
        pending.retainOrder = sequence
        for (const [id, descriptor] of pending.records) {
          if (descriptor.sequence > sequence || currentIds.has(id)) continue
          pending.records.delete(id)
          pending.bytes -= descriptor.bytes
        }
        scheduleDrain()
      }
      for (const record of records) {
        if (record.session.materialization === undefined) continue
        try {
          const canonical: CanonicalRecord = {
            materialization: record.session.materialization,
            identity: record.identity,
            versions: record.versions ?? versions,
          }
          const json = JSON.stringify(canonical)
          const accepted = await accept({
            id: record.session.id,
            shard: shardOf(record.session.id),
            json,
            bytes: Buffer.byteLength(json),
            sequence,
          })
          if (!accepted) return false
        } catch {
          return false
        }
      }
      return !disposed
    } finally {
      activeSaves--
      clearHistory()
    }
  }

  const flush = async (): Promise<void> => {
    while (active !== null || hasWork(pending) || drainPromise !== null) {
      clearTimer()
      if (!await requestDrain()) return
    }
  }

  const dispose = (): Promise<void> => {
    if (!disposed) {
      disposed = true
      notifyCapacity()
    }
    return flush()
  }

  return { load, probe, refresh, capture, save, flush, dispose }
}

async function inBatchesSet(values: ReadonlySet<number>, run: (value: number) => Promise<boolean>): Promise<boolean> {
  let success = true
  await inBatches([...values], DEFAULT_SHARD_CONCURRENCY, async (value) => {
    if (!await run(value)) success = false
  })
  return success
}

async function captureOne(
  id: string,
  statOf: ((id: string) => Promise<unknown>) | undefined,
  fs: CacheFs,
): Promise<DurableIdentity | null> {
  if (statOf === undefined) return null
  let snapshot: unknown
  try {
    snapshot = await statOf(id)
  } catch {
    return null
  }
  const data = asRecord(snapshot)
  const location = asRecord(data?.location)
  const path = typeof location?.path === 'string' && location.path !== '' ? location.path : undefined
  const sizeBytes = optionalNumOf(data?.sizeBytes)
  if (path === undefined || sizeBytes === undefined) return null
  try {
    const info = await fs.stat(path)
    return { path, sizeBytes, mtimeMs: info.mtimeMs }
  } catch {
    return null
  }
}
