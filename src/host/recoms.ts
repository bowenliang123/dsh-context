import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, recomsOfPayload, type RecomRead } from '../shared/recoms'
import { type ConnectionHostFace, registerPostRoute } from './connection'

export const RECOM_ROUTE = '/api/dsh-context/recom'

const FETCH_TIMEOUT_MS = 5_000

type RecomFetcher = (url: string, init: RequestInit) => Promise<Response>

const defaultFetcher: RecomFetcher = (url, init) => fetch(url, init)

let fetcher: RecomFetcher = defaultFetcher

export function setRecomFetcher(next: RecomFetcher | null): void {
  fetcher = next ?? defaultFetcher
}

let rotation = 0

export function resetRecomRotation(): void {
  rotation = 0
}

export async function readRecom(): Promise<RecomRead> {
  for (const url of [RECOM_DATA_URL, RECOM_DATA_MIRROR_URL]) {
    try {
      const response = await fetcher(url, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      })
      if (!response.ok) continue
      const recoms = recomsOfPayload(await response.json())
      if (recoms.length === 0) continue
      const picked = recoms[rotation % recoms.length]
      rotation++
      return { recom: picked, degraded: false }
    } catch {
    }
  }
  return { recom: DEFAULT_RECOM, degraded: true }
}

export function watchRecomChannel(ctx: Context): void {
  ctx.inject(['connection'], (c) => {
    const handler = async (): Promise<Response> => {
      const read = await readRecom()
      return Response.json(
        { ok: true, value: read.recom, degraded: read.degraded },
        { headers: { 'cache-control': 'no-store' } },
      )
    }
    registerPostRoute(c, c.get('connection') as ConnectionHostFace | undefined, RECOM_ROUTE, handler, 'dsh-context: recom route')
  })
}
