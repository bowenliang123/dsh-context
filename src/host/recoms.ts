import type { Context } from '@deepseek-ai/cordis'
import { DEFAULT_RECOM, RECOM_DATA_MIRROR_URL, RECOM_DATA_URL, recomsOfPayload, type RecomsRead } from '../shared/recoms'
import { mountPostRoute, reply } from './postRoute'

export const RECOM_ROUTE = '/api/dsh-context/recom'

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

export function watchRecomChannel(ctx: Context): void {
  mountPostRoute({
    ctx,
    deps: ['connection'],
    path: RECOM_ROUTE,
    label: 'dsh-context: recom route',
    handler: () => async (): Promise<Response> => {
      const read = await readRecoms()
      return reply({ ok: true, value: read.recoms, degraded: read.degraded })
    },
  })
}
