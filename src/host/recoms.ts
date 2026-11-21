import type { Context } from '@deepseek-ai/cordis'
import { homedir } from 'node:os'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, recomsOfPayload, type Recom, type RecomsRead } from '../shared/recoms'
import { mountPostRoute, reply } from './postRoute'
import { asRecord } from './record'
import { NODE_FILE_IO, storagePathOf, type FileIo } from './storage'

export const RECOM_ROUTE = '/api/dsh-context/recom'

export const RECOM_TTL_MS = 60 * 60 * 1000

export const RECOM_CACHE_FORMAT = 1

export const RECOM_CACHE_FILE = `recoms.v${RECOM_CACHE_FORMAT}.json`

const RECOM_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

const RECOM_FAILURE_BACKOFF_MS = 30_000

const CACHE_READ_ATTEMPTS = 2

const FETCH_TIMEOUT_MS = 5_000

export type RecomCacheIo = FileIo

export function recomCachePath(
  env: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  return storagePathOf(RECOM_CACHE_FILE, env, home)
}

interface CachedRecoms {
  recoms: Recom[]
  fetchedAt: number
}

function cachedRecomsOf(value: unknown): CachedRecoms | null {
  const data = asRecord(value)
  if (data === null || data.format !== RECOM_CACHE_FORMAT) return null
  const fetchedAt = data.fetchedAt
  if (typeof fetchedAt !== 'number' || !Number.isFinite(fetchedAt) || fetchedAt < 0) return null
  const recoms = recomsOfPayload(data.recoms)
  return recoms.length === 0 ? null : { recoms, fetchedAt }
}

type RecomFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: RecomFetcher = (url, init) => fetch(url, init)

let fetcher: RecomFetcher = defaultFetcher

export function setRecomFetcher(next: RecomFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

export async function readRecoms(): Promise<RecomsRead> {
  for (const url of [RECOM_DATA_URL, RECOM_DATA_MIRROR_URL]) {
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const recoms = recomsOfPayload(await response.json())
      if (recoms.length > 0) return { recoms, degraded: false }
    } catch {
    }
  }
  return { recoms: [DEFAULT_RECOM], degraded: true }
}

export interface RecomChannelOptions {
  ttlMs?: number
  now?: () => number
  cachePath?: string | null
  cacheIo?: RecomCacheIo
}

export function watchRecomChannel(ctx: Context, options: RecomChannelOptions = {}): void {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? RECOM_TTL_MS
  const cachePath = options.cachePath === undefined ? recomCachePath() : options.cachePath
  const cacheIo = options.cacheIo ?? NODE_FILE_IO
  let slot: { read: RecomsRead; at: number } | null = null
  let inflight: Promise<RecomsRead> | null = null
  let cached: CachedRecoms | null = null
  let cacheLoaded = false
  let cacheReads = 0

  const withinMaxAge = (entry: CachedRecoms): boolean => {
    const age = now() - entry.fetchedAt
    return age <= RECOM_MAX_AGE_MS && age >= -ttlMs
  }

  const loadCache = async (): Promise<CachedRecoms | null> => {
    cacheLoaded = true
    if (cachePath === null) return null
    let text: string
    try {
      cacheReads++
      text = await cacheIo.read(cachePath)
    } catch {
      if (cacheReads < CACHE_READ_ATTEMPTS) cacheLoaded = false
      return null
    }
    try {
      const entry = cachedRecomsOf(JSON.parse(text))
      if (entry === null || !withinMaxAge(entry)) return null
      if (cached === null || entry.fetchedAt > cached.fetchedAt) cached = entry
      return entry
    } catch {
      return null
    }
  }

  const saveCache = async (recoms: Recom[], fetchedAt: number): Promise<void> => {
    if (cachePath === null) return
    try {
      await cacheIo.write(cachePath, JSON.stringify({ format: RECOM_CACHE_FORMAT, fetchedAt, recoms }))
    } catch {
    }
  }

  const load = async (): Promise<RecomsRead> => {
    try {
      const read = await readRecoms()
      if (!read.degraded) {
        slot = { read, at: now() }
        cached = { recoms: read.recoms, fetchedAt: slot.at }
        void saveCache(read.recoms, slot.at)
        return read
      }
      const remembered = cached !== null && withinMaxAge(cached) ? cached : null
      const fallback: RecomsRead = remembered === null
        ? read
        : { recoms: remembered.recoms, degraded: true }
      slot = { read: fallback, at: now() }
      return fallback
    } finally {
      inflight = null
    }
  }

  const readCached = async (): Promise<RecomsRead | null> => {
    const entry = await loadCache()
    if (entry === null) return null
    const read: RecomsRead = { recoms: entry.recoms, degraded: now() - entry.fetchedAt >= ttlMs }
    if (slot === null) {
      slot = { read, at: now() }
      inflight ??= load()
    }
    return read
  }

  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: RECOM_ROUTE,
    label: 'dsh-context: recom route',
    handler: () => async (): Promise<Response> => {
      if (slot !== null && now() - slot.at < (slot.read.degraded ? RECOM_FAILURE_BACKOFF_MS : ttlMs)) {
        return reply({ ok: true, value: slot.read.recoms, degraded: slot.read.degraded })
      }
      if (!cacheLoaded) {
        const cachedRead = await readCached()
        if (cachedRead !== null) return reply({ ok: true, value: cachedRead.recoms, degraded: cachedRead.degraded })
      }
      inflight ??= load()
      const read = await inflight
      return reply({ ok: true, value: read.recoms, degraded: read.degraded })
    },
  })
}
