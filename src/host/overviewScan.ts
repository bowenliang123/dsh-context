import { performance } from 'node:perf_hooks'
import type { ScanEntry } from './overviewCorpus'

export interface ScanResult {
  entries: ScanEntry[]
  coldIds: ReadonlySet<string>
  identitiesSynced: boolean
}

export interface ScanWindow {
  read(load: () => Promise<ScanResult>, versionOf: () => number): Promise<ScanResult>
  reset(): void
}

export function makeScanWindow(ttlMs: number, now: () => number = () => performance.now()): ScanWindow {
  let cached: ScanResult | null = null
  let cachedVersion = -1
  let at = 0
  let generation = 0
  let inflight: Promise<ScanResult> | null = null
  const clear = (): void => {
    cached = null
    cachedVersion = -1
    at = 0
  }
  return {
    read(load, versionOf) {
      const version = versionOf()
      if (cached !== null && cachedVersion === version && now() - at < ttlMs) return Promise.resolve(cached)
      if (inflight !== null) return inflight
      const run = generation
      const promise = (async (): Promise<ScanResult> => {
        const next = await load()
        if (run === generation) {
          cached = next
          cachedVersion = versionOf()
          at = now()
        }
        return next
      })()
      inflight = promise
      return promise.finally(() => {
        inflight = null
      })
    },
    reset() {
      generation++
      clear()
    },
  }
}
