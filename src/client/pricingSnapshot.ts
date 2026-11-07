import type { ModelBook } from './cost'
import type { SessionCostUsage } from '../shared/types'
import { asRecord, numOf } from './services'
import { PRICING_SNAPSHOT_ROUTE } from './apiRoutes'
import { lruTouch } from './boundedCache'
const MAX_ENTRIES = 20_000
const MAX_CHARS = 1_000_000
const MAX_KEY = 20_000
const MAX_BODY_BYTES = 12 * 1024 * 1024
const MAX_BOOK_CHARS = 2_000_000

interface Snapshot {
  version: 1
  revision: string
  book?: { at: number; data: unknown }
  entries: [string, number | null][]
}

let state: Snapshot = { version: 1, revision: '', entries: [] }
let entries = new Map<string, number | null>()
let chars = 0
let loaded: Promise<unknown> | null = null
let enabled = false
let dirty = false
let writing = false
let timer: ReturnType<typeof setTimeout> | null = null
let generation = 0
const revisions = new WeakMap<ModelBook, string>()

function canonicalOf(book: ModelBook, provider: string, model: string): string | undefined {
  return book.canonical?.[provider]?.[model] ?? book.index.byModel.get(model.trim().toLowerCase())
    ?.find(candidate => candidate.pid === provider && candidate.mid === model)?.canonical
}

function bookDataOf(book: ModelBook): unknown {
  return Object.fromEntries(Object.keys(book.prices).map(provider => [provider, {
    models: Object.fromEntries(Object.keys(book.prices[provider]).map((model) => {
      const rate = book.prices[provider][model]
      return [model, {
        cost: { input: rate.miss, output: rate.out, cache_read: rate.hit, cache_write: rate.write },
        canonical_model_id: canonicalOf(book, provider, model),
      }]
    })),
  }]))
}

function revisionOf(book: ModelBook): string {
  let revision = revisions.get(book)
  if (revision === undefined) {
    revision = JSON.stringify(bookDataOf(book))
    revisions.set(book, revision)
  }
  return revision
}

function keyOf(usage: SessionCostUsage): string {
  return JSON.stringify(Object.keys(usage).sort().map((provider) => {
    const models = asRecord(usage[provider])
    return [provider, models === null ? null : Object.keys(models).sort().map((model) => {
      const periods = asRecord(models[model])
      return [model, periods === null ? null : ['peak', 'off'].map((period) => {
        const bucket = asRecord(periods[period])
        return bucket === null ? null : [numOf(bucket.uncached), numOf(bucket.cacheRead), numOf(bucket.cacheWrite), numOf(bucket.output)]
      })]
    })]
  }))
}

function put(key: string, value: number | null): void {
  if (key.length > MAX_KEY) return
  if (entries.delete(key)) chars -= key.length
  entries.set(key, value)
  chars += key.length
  while (entries.size > MAX_ENTRIES || chars > MAX_CHARS) {
    const oldest = entries.keys().next().value as string
    entries.delete(oldest)
    chars -= oldest.length
  }
}

function schedule(): void {
  dirty = true
  if (!enabled || timer !== null || writing) return
  timer = setTimeout(() => {
    timer = null
    void flushPricingSnapshot()
  }, 500)
}

export async function flushPricingSnapshot(): Promise<void> {
  if (!enabled || writing || !dirty || state.book === undefined) return
  writing = true
  dirty = false
  const current = generation
  try {
    let kept = [...entries]
    let body = JSON.stringify({ write: { ...state, entries: kept } })
    while (new TextEncoder().encode(body).length > MAX_BODY_BYTES && kept.length > 0) {
      kept = kept.slice(Math.ceil(kept.length / 2))
      body = JSON.stringify({ write: { ...state, entries: kept } })
    }
    if (new TextEncoder().encode(body).length > MAX_BODY_BYTES || state.revision.length > MAX_BOOK_CHARS) return
    const response = await fetch(PRICING_SNAPSHOT_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15_000),
      keepalive: false,
    })
    const result = asRecord(await response.json())
    if (!response.ok || result?.ok !== true) throw new Error('pricing snapshot write failed')
  } catch {
    if (current === generation) dirty = true
  } finally {
    if (current === generation) {
      writing = false
      if (dirty) {
        timer = setTimeout(() => {
          timer = null
          void flushPricingSnapshot()
        }, 30_000)
      }
    }
  }
}

export function loadPricingSnapshot(): Promise<unknown> {
  if (loaded !== null) return loaded
  const current = generation
  loaded = (async () => {
    try {
      const response = await fetch(PRICING_SNAPSHOT_ROUTE, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5_000),
      })
      const result = asRecord(await response.json())
      const value = asRecord(result?.value)
      if (!response.ok || result?.ok !== true || value?.version !== 1 || typeof value.revision !== 'string'
        || value.revision.length > MAX_BOOK_CHARS || !Array.isArray(value.entries) || current !== generation) return null
      const book = asRecord(value.book)
      if (book === null || typeof book.at !== 'number' || !Number.isFinite(book.at) || book.at < 0) return null
      state = { version: 1, revision: value.revision, book: { at: book.at, data: book.data }, entries: [] }
      entries.clear()
      chars = 0
      for (const row of value.entries as unknown[]) {
        if (!Array.isArray(row) || row.length !== 2) continue
        const [key, amount] = row as unknown[]
        if (typeof key === 'string' && (amount === null || (typeof amount === 'number' && Number.isFinite(amount) && amount >= 0))) put(key, amount)
      }
      return book.data
    } catch {
      return null
    } finally {
      if (current === generation) enabled = true
    }
  })()
  return loaded
}

export function rememberPricingBook(book: ModelBook, fresh = true): void {
  const revision = revisionOf(book)
  if (revision !== state.revision) {
    entries.clear()
    chars = 0
    state = { version: 1, revision, entries: [] }
  }
  if (fresh || state.book === undefined) {
    state.book = { at: Date.now(), data: bookDataOf(book) }
    schedule()
  }
}

export function cachedSessionCost(usage: SessionCostUsage, book: ModelBook, calculate: () => number | null): number | null {
  rememberPricingBook(book, false)
  const key = keyOf(usage)
  if (entries.has(key)) {
    const value = entries.get(key) as number | null
    lruTouch(entries, key)
    return value
  }
  const value = calculate()
  if (value === null || (Number.isFinite(value) && value >= 0)) {
    put(key, value)
    schedule()
  }
  return value
}

export function resetPricingSnapshot(): void {
  generation++
  if (timer !== null) clearTimeout(timer)
  timer = null
  state = { version: 1, revision: '', entries: [] }
  entries = new Map()
  chars = 0
  loaded = null
  enabled = false
  dirty = false
  writing = false
}
