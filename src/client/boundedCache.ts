export type EvictReason = 'replace' | 'delete' | 'trim' | 'ttl' | 'clear' | 'dispose'

export interface BoundedCacheOptions<K, V> {
  maxEntries: number
  maxBytes?: number
  maxWeight?: number
  minEntries?: number
  ttlMs?: number
  now?: () => number
  sizeOf?: (value: V, key: K) => number
  weightOf?: (value: V, key: K) => number
  evictable?: (value: V, key: K) => boolean
  onEvict?: (value: V, key: K, reason: EvictReason) => void
}

interface BoundedCacheTrim<K> {
  protect?: K
  reserveWeight?: number
}

interface CacheEntry<V> {
  value: V
  expiresAt: number
}

const NO_EXPIRY = Number.POSITIVE_INFINITY

const NO_TIMER = Number.POSITIVE_INFINITY

export function byteSizeOf(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

function unrefTimer(timer: ReturnType<typeof setTimeout>): void {
  const handle = timer as unknown as { unref?: () => void }
  if (typeof handle.unref === 'function') handle.unref()
}

export class BoundedCache<K, V> {
  private readonly store = new Map<K, CacheEntry<V>>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private timerAt = 0

  constructor(private readonly options: BoundedCacheOptions<K, V>) {}

  get size(): number {
    return this.store.size
  }

  get bytes(): number {
    let total = 0
    for (const [key, entry] of this.store) total += this.sizeOf(entry.value, key)
    return total
  }

  get(key: K): V | undefined {
    const entry = this.store.get(key)
    if (entry === undefined) return undefined
    if (entry.expiresAt <= this.now()) {
      if (!this.evictableAt(entry.value, key)) return entry.value
      this.store.delete(key)
      this.options.onEvict?.(entry.value, key, 'ttl')
      this.schedule()
      return undefined
    }
    this.store.delete(key)
    this.store.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    const prev = this.store.get(key)
    if (prev !== undefined) {
      this.store.delete(key)
      this.options.onEvict?.(prev.value, key, 'replace')
    }
    this.store.set(key, { value, expiresAt: this.expiry() })
    this.trim({ protect: key })
    this.schedule()
  }

  delete(key: K): void {
    const entry = this.store.get(key)
    if (entry === undefined) return
    this.store.delete(key)
    this.options.onEvict?.(entry.value, key, 'delete')
    this.schedule()
  }

  clear(): void {
    this.clearTimer()
    const entries = [...this.store]
    this.store.clear()
    for (const [key, entry] of entries) this.options.onEvict?.(entry.value, key, 'clear')
  }

  dispose(): void {
    this.clearTimer()
    const entries = [...this.store]
    this.store.clear()
    for (const [key, entry] of entries) this.options.onEvict?.(entry.value, key, 'dispose')
  }

  reweight(key: K): void {
    if (!this.store.has(key)) return
    this.trim({ protect: key })
    this.schedule()
  }

  forEach(visit: (value: V, key: K) => void): void {
    for (const [key, entry] of this.store) visit(entry.value, key)
  }

  trim(options: BoundedCacheTrim<K> = {}): void {
    const maxEntries = this.options.maxEntries
    const maxBytes = this.options.maxBytes ?? Number.POSITIVE_INFINITY
    const maxWeight = this.options.maxWeight ?? Number.POSITIVE_INFINITY
    const minEntries = this.options.minEntries ?? 0
    let bytes = 0
    let weight = 0
    for (const [key, entry] of this.store) {
      bytes += this.sizeOf(entry.value, key)
      weight += this.weightOf(entry.value, key)
    }
    weight += options.reserveWeight ?? 0
    for (const [key, entry] of this.store) {
      if (this.store.size <= minEntries) return
      if (this.store.size <= maxEntries && bytes <= maxBytes && weight <= maxWeight) return
      if (options.protect === key) continue
      if (!this.evictableAt(entry.value, key)) continue
      this.store.delete(key)
      bytes -= this.sizeOf(entry.value, key)
      weight -= this.weightOf(entry.value, key)
      this.options.onEvict?.(entry.value, key, 'trim')
    }
  }

  private now(): number {
    return this.options.now !== undefined ? this.options.now() : Date.now()
  }

  private expiry(): number {
    return this.options.ttlMs === undefined ? NO_EXPIRY : this.now() + this.options.ttlMs
  }

  private evictableAt(value: V, key: K): boolean {
    return this.options.evictable === undefined ? true : this.options.evictable(value, key)
  }

  private sizeOf(value: V, key: K): number {
    return this.options.sizeOf !== undefined ? this.options.sizeOf(value, key) : 0
  }

  private weightOf(value: V, key: K): number {
    return this.options.weightOf !== undefined ? this.options.weightOf(value, key) : 1
  }

  private nextExpiry(): number {
    let next = NO_TIMER
    for (const [key, entry] of this.store) {
      if (entry.expiresAt < next && this.evictableAt(entry.value, key)) next = entry.expiresAt
    }
    return next
  }

  private schedule(): void {
    if (this.options.ttlMs === undefined) return
    const next = this.nextExpiry()
    if (next === NO_TIMER) {
      this.clearTimer()
      return
    }
    if (this.timer !== null && this.timerAt <= next) return
    this.clearTimer()
    this.timerAt = next
    this.timer = setTimeout(() => {
      this.timer = null
      this.expire()
    }, Math.max(0, next - this.now()))
    unrefTimer(this.timer)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }

  private expire(): void {
    const now = this.now()
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > now) continue
      if (!this.evictableAt(entry.value, key)) continue
      this.store.delete(key)
      this.options.onEvict?.(entry.value, key, 'ttl')
    }
    this.schedule()
  }
}

export function lruTouch<K, T>(map: Map<K, T>, key: K): void {
  const known = map.get(key)
  if (known === undefined) return
  map.delete(key)
  map.set(key, known)
}

export function lruTrim<K, T>(map: Map<K, T>, max: number): void {
  let excess = map.size - max
  if (excess <= 0) return
  for (const key of map.keys()) {
    if (excess <= 0) break
    map.delete(key)
    excess--
  }
}
