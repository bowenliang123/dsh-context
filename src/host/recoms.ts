import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, recomsOfPayload, type RecomsRead } from '../shared/recoms'
import { mountPostRoute, reply } from './postRoute'

export const RECOM_ROUTE = '/api/dsh-context/recom'

export const RECOM_TTL_MS = 60 * 60 * 1000

const RECOM_FAILURE_BACKOFF_MS = 30_000

const FETCH_TIMEOUT_MS = 5_000

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
}

export function watchRecomChannel(ctx: Context, options: RecomChannelOptions = {}): void {
  const now = options.now ?? (() => Date.now())
  const ttlMs = options.ttlMs ?? RECOM_TTL_MS
  let slot: { read: RecomsRead; at: number } | null = null
  let inflight: Promise<RecomsRead> | null = null
  const load = async (): Promise<RecomsRead> => {
    try {
      const read = await readRecoms()
      slot = { read, at: now() }
      return read
    } finally {
      inflight = null
    }
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
      inflight ??= load()
      const read = await inflight
      return reply({ ok: true, value: read.recoms, degraded: read.degraded })
    },
  })
}
