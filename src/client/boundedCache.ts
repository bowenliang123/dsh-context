interface BoundedCacheOptions<K, V> {
  maxEntries: number
  maxBytes?: number
  maxWeight?: number
  minEntries?: number
  sizeOf?: (value: V, key: K) => number
  weightOf?: (value: V, key: K) => number
  evictable?: (value: V, key: K) => boolean
  onEvict?: (value: V, key: K) => void
}

interface BoundedCacheTrim<K> {
  protect?: K
  reserveWeight?: number
}

export function byteSizeOf(value: unknown): number {
  try {
    return JSON.stringify(value).length
  } catch {
    return 0
  }
}

export class BoundedCache<K, V> {
  private readonly store = new Map<K, V>()

  constructor(private readonly options: BoundedCacheOptions<K, V>) {}

  get size(): number {
    return this.store.size
  }

  get bytes(): number {
    let total = 0
    for (const [key, value] of this.store) total += this.sizeOf(value, key)
    return total
  }

  get(key: K): V | undefined {
    const value = this.store.get(key)
    if (value === undefined) return undefined
    this.store.delete(key)
    this.store.set(key, value)
    return value
  }

  set(key: K, value: V): void {
    this.store.delete(key)
    this.store.set(key, value)
    this.trim({ protect: key })
  }

  clear(): void {
    this.store.clear()
  }

  trim(options: BoundedCacheTrim<K> = {}): void {
    const maxEntries = this.options.maxEntries
    const maxBytes = this.options.maxBytes ?? Number.POSITIVE_INFINITY
    const maxWeight = this.options.maxWeight ?? Number.POSITIVE_INFINITY
    const minEntries = this.options.minEntries ?? 0
    let bytes = 0
    let weight = 0
    for (const [key, value] of this.store) {
      bytes += this.sizeOf(value, key)
      weight += this.weightOf(value, key)
    }
    weight += options.reserveWeight ?? 0
    for (const [key, value] of this.store) {
      if (this.store.size <= minEntries) return
      if (this.store.size <= maxEntries && bytes <= maxBytes && weight <= maxWeight) return
      if (options.protect === key) continue
      if (this.options.evictable !== undefined && !this.options.evictable(value, key)) continue
      this.store.delete(key)
      bytes -= this.sizeOf(value, key)
      weight -= this.weightOf(value, key)
      this.options.onEvict?.(value, key)
    }
  }

  private sizeOf(value: V, key: K): number {
    return this.options.sizeOf !== undefined ? this.options.sizeOf(value, key) : 0
  }

  private weightOf(value: V, key: K): number {
    return this.options.weightOf !== undefined ? this.options.weightOf(value, key) : 1
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
