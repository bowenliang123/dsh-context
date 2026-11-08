import type { SessionCostRead } from '../shared/types'
import { invalidate } from './invalidation'

const RETRY_MS: readonly number[] = [1_500, 4_000, 10_000]

let attempt = 0

let timer: ReturnType<typeof setTimeout> | null = null

let refreshHook: (() => void) | null = null

function clearTimer(): void {
  if (timer === null) return
  clearTimeout(timer)
  timer = null
}

function schedule(): void {
  if (timer !== null || attempt >= RETRY_MS.length) return
  timer = setTimeout(() => {
    timer = null
    attempt++
    invalidate('pricing')
    refreshHook?.()
  }, RETRY_MS[attempt])
}

export function noteCostPending(read: SessionCostRead | null | undefined): void {
  if (read === null || read === undefined) return
  if (read.ready) {
    attempt = 0
    return
  }
  schedule()
}

export function notePricingPending(ready: boolean | undefined): void {
  if (ready === undefined) return
  if (ready) {
    attempt = 0
    return
  }
  schedule()
}

export function registerCostRefresh(hook: (() => void) | null): () => void {
  refreshHook = hook
  return () => {
    if (refreshHook === hook) refreshHook = null
  }
}

export function resetCostRefresh(): void {
  attempt = 0
  clearTimer()
}
