import { Models } from '@opencode-ai/models'
import { useSyncExternalStore } from 'react'
import { asRecord } from './services'
import { priceIndexOf } from './cost'
import { loadPricingSnapshot, rememberPricingBook, resetPricingSnapshot } from './pricingSnapshot'
import type { ModelBook, ModelPrices, PriceTriple } from './cost'

function rateOf(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function pricesBookOf(value: unknown): ModelBook | null {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return null
  const book: ModelPrices = {}
  const canonicalOf: Record<string, Record<string, string>> = {}
  for (const providerId of Object.keys(data)) {
    if (['__proto__', 'constructor', 'prototype'].includes(providerId)) continue
    const provider = asRecord(data[providerId])
    if (provider === null) continue
    const modelList = asRecord(provider.models)
    if (modelList === null) continue
    const models: Record<string, PriceTriple> = {}
    for (const id of Object.keys(modelList)) {
      if (['__proto__', 'constructor', 'prototype'].includes(id)) continue
      const model = asRecord(modelList[id])
      const cost = model !== null ? asRecord(model.cost) : null
      if (cost === null) continue
      const miss = rateOf(cost.input)
      const out = rateOf(cost.output)
      if (miss === null || out === null) continue
      models[id] = {
        hit: rateOf(cost.cache_read) ?? miss,
        miss,
        write: rateOf(cost.cache_write) ?? miss,
        out,
      }
      const canonical = model?.['canonical_model_id']
      if (typeof canonical === 'string' && canonical.length > 0) {
        const branch = canonicalOf[providerId] ?? (canonicalOf[providerId] = {})
        branch[id] = canonical
      }
    }
    if (Object.keys(models).length > 0) book[providerId] = models
  }
  return { prices: book, index: priceIndexOf(book, canonicalOf), canonical: canonicalOf }
}

export interface ModelPricesSnap {
  book: ModelBook | null
  failed: boolean
}

type Loader = () => Promise<unknown>

const defaultLoader: Loader = () => Models.make().providers()

const RETRY_BASE_MS = 30_000

let loader: Loader = defaultLoader
let snap: ModelPricesSnap = { book: null, failed: false }
let inFlight = false
let generation = 0
let failures = 0
let timer: ReturnType<typeof setTimeout> | null = null
const listeners = new Set<() => void>()

function fail(): void {
  snap = { ...snap, failed: true }
  failures++
  timer = setTimeout(() => {
    timer = null
    if (listeners.size === 0) return
    void fire()
  }, RETRY_BASE_MS * 2 ** Math.min(failures - 1, 3))
}

async function fire(): Promise<void> {
  inFlight = true
  const current = generation
  const restored = await loadPricingSnapshot().then(pricesBookOf).catch(() => null)
  if (current !== generation) return
  if (snap.book === null && restored !== null) {
    rememberPricingBook(restored, false)
    snap = { book: restored, failed: false }
    for (const fn of listeners) fn()
  }
  try {
    const book = pricesBookOf(await loader())
    if (current !== generation) return
    if (book !== null) {
      rememberPricingBook(book)
      snap = { book, failed: false }
      failures = 0
    } else {
      fail()
    }
  } catch {
    if (current !== generation) return
    fail()
  }
  inFlight = false
  for (const fn of listeners) fn()
}

function kick(): void {
  if ((snap.book !== null && !snap.failed) || inFlight || timer !== null) return
  void fire()
}

export const subscribeModelPrices = (fn: () => void): (() => void) => {
  listeners.add(fn)
  kick()
  return () => {
    listeners.delete(fn)
  }
}

export const getModelPricesSnap = (): ModelPricesSnap => snap

export function useModelPrices(): ModelPricesSnap {
  return useSyncExternalStore(subscribeModelPrices, getModelPricesSnap)
}

export function resetModelPrices(): void {
  generation++
  resetPricingSnapshot()
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  snap = { book: null, failed: false }
  inFlight = false
  failures = 0
  listeners.clear()
}

export function setModelPricesLoader(next: Loader | null): void {
  loader = next ?? defaultLoader
}
