import type { Context } from '@deepseek-ai/cordis'

export type FoldCacheOptions<V> = {
  maxEntries: number
  idleMs?: number
  onSweep?: () => void
} & (
  | { maxBytes?: undefined; bytesOf?: undefined }
  | { maxBytes: number; bytesOf: (value: V) => number }
)

export interface FoldCache<V> {
  get(key: string, accept: (value: V) => boolean): V | undefined
  set(key: string, value: V): void
  touch(): void
}

const DEFAULT_IDLE_MS = 20_000

export function makeFoldCache<V>(ctx: Context, options: FoldCacheOptions<V>): FoldCache<V> {
  const store = new Map<string, V>()
  const bytesOf = options.bytesOf
  let timer: ReturnType<typeof setTimeout> | null = null
  const sweep = (): void => {
    store.clear()
    options.onSweep?.()
  }
  const touch = (): void => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      sweep()
    }, options.idleMs ?? DEFAULT_IDLE_MS)
    ;(timer as { unref?: () => void }).unref?.()
  }
  const trim = (keep: string): void => {
    let bytes = 0
    if (options.maxBytes !== undefined && bytesOf !== undefined) {
      for (const value of store.values()) bytes += bytesOf(value)
    }
    for (const key of store.keys()) {
      if (store.size <= options.maxEntries && (options.maxBytes === undefined || bytes <= options.maxBytes)) break
      if (key === keep) continue
      const value = store.get(key) as V
      store.delete(key)
      if (bytesOf !== undefined) bytes -= bytesOf(value)
    }
  }
  ctx.effect(() => () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
    store.clear()
  }, 'dsh-context: fold cache sweep')
  return {
    get(key, accept) {
      const value = store.get(key)
      if (value === undefined || !accept(value)) return undefined
      store.delete(key)
      store.set(key, value)
      return value
    },
    set(key, value) {
      store.delete(key)
      store.set(key, value)
      trim(key)
    },
    touch,
  }
}
