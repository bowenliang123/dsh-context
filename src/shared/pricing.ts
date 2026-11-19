import type { SessionCostUsage } from './types'
import { isDeepSeekProvider, modelsDevProviderOf } from './providers'
import { asRecord } from './decode'
import {
  bareModelOf,
  familyVendorOf,
  isSubscriptionPlanProvider,
  labOf,
  lowerModelId,
  normalizeModelId,
  orgOf,
  suffixKeys,
} from './priceIdentity'

function numOf(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

export type CostCurrency = 'usd' | 'cny'

const USD_PER_CNY = 0.15

const PEAK_FACTOR = 2

export interface PriceTriple { hit: number; miss: number; write: number; out: number }

export type ModelPrices = Record<string, Record<string, PriceTriple>>

type PriceVia =
  | 'direct'
  | 'branch-suffix'
  | 'branch-normalized'
  | 'provider-alias'
  | 'org-branch'
  | 'canonical-maker'
  | 'family'
  | 'index'

type PriceConfidence = 'high' | 'medium' | 'low'

interface PriceCandidate {
  pid: string
  mid: string
  rate: PriceTriple
  canonical?: string
  lab?: string
}

type PriceMissReason = 'book-unavailable' | 'model-unknown' | 'ambiguous' | 'no-entry'

export type PriceMiss =
  | { reason: 'ambiguous'; candidates: number }
  | { reason: 'book-unavailable' | 'model-unknown' | 'no-entry' }

export interface PriceFace {
  pid: string
  mid: string
  rate: PriceTriple
  via: PriceVia
  confidence: PriceConfidence
  canonical?: string
}

type PriceResolution =
  | { kind: 'priced'; face: PriceFace }
  | { kind: 'unpriced'; miss: PriceMiss }

interface Branch {
  pid: string
  rates: Record<string, PriceTriple>
  canonical: Record<string, string> | undefined
}

export interface ModelBook {
  prices: ModelPrices
  canonicalIds: Record<string, Record<string, string>>
}

type PriceLookup =
  | { provider: string; model: string; face: PriceFace; miss?: undefined }
  | { provider: string; model: string; face: null; miss: PriceMiss }

export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

function sameRate(a: PriceTriple, b: PriceTriple): boolean {
  const close = (x: number, y: number): boolean => Math.abs(x - y) <= 1e-9 * Math.max(1, Math.abs(x))
  return close(a.hit, b.hit) && close(a.miss, b.miss) && close(a.write, b.write) && close(a.out, b.out)
}

function rateOfEntry(value: unknown): PriceTriple | null {
  const v: unknown = value
  if (v === null || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const num = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x)
  return num(r.hit) && num(r.miss) && num(r.write) && num(r.out)
    ? { hit: r.hit, miss: r.miss, write: r.write, out: r.out }
    : null
}

function unsafeKey(id: string): boolean {
  return id === '__proto__' || id === 'constructor' || id === 'prototype'
}

function pushUnique(list: PriceCandidate[], candidate: PriceCandidate): void {
  if (!list.some(existing => existing.pid === candidate.pid && sameRate(existing.rate, candidate.rate))) list.push(candidate)
}

function branchOf(book: ModelBook, pid: string): Branch | null {
  if (isSubscriptionPlanProvider(pid) || !Object.hasOwn(book.prices, pid)) return null
  const rates: unknown = book.prices[pid]
  if (rates === null || typeof rates !== 'object' || Array.isArray(rates)) return null
  const canonical: unknown = Object.hasOwn(book.canonicalIds, pid) ? book.canonicalIds[pid] : undefined
  return {
    pid,
    rates: rates as Record<string, PriceTriple>,
    canonical: canonical !== null && typeof canonical === 'object' && !Array.isArray(canonical)
      ? canonical as Record<string, string>
      : undefined,
  }
}

function canonicalOf(branch: Branch, mid: string): string | undefined {
  if (branch.canonical === undefined || !Object.hasOwn(branch.canonical, mid)) return undefined
  const value = branch.canonical[mid]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function candidateOf(branch: Branch, mid: string): PriceCandidate | null {
  const rate = branch.rates[mid]
  if (rateOfEntry(rate) === null) return null
  const canonical = canonicalOf(branch, mid)
  const lab = canonical === undefined ? undefined : labOf(canonical)
  return {
    pid: branch.pid,
    mid,
    rate,
    ...canonical === undefined ? {} : { canonical },
    ...lab === undefined ? {} : { lab },
  }
}

function memoOf<K, V>(store: WeakMap<ModelBook, Map<K, V>>, book: ModelBook): Map<K, V> {
  let memo = store.get(book)
  if (memo === undefined) {
    memo = new Map()
    store.set(book, memo)
  }
  return memo
}

const multiVendorMemo = new WeakMap<ModelBook, Map<string, boolean>>()

function multiVendorOf(book: ModelBook, branch: Branch): boolean {
  const memo = memoOf(multiVendorMemo, book)
  const known = memo.get(branch.pid)
  if (known !== undefined) return known
  const labs = new Set<string>()
  for (const mid of Object.keys(branch.rates)) {
    const canonical = canonicalOf(branch, mid)
    const lab = canonical === undefined ? undefined : labOf(canonical)
    if (lab !== undefined) labs.add(lab)
  }
  const multiVendor = labs.size > 1
  memo.set(branch.pid, multiVendor)
  return multiVendor
}

type CandidatePick =
  | { kind: 'hit'; candidate: PriceCandidate }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'miss' }

function pickCandidates(candidates: readonly PriceCandidate[]): CandidatePick {
  if (candidates.length === 0) return { kind: 'miss' }
  const first = candidates[0]
  return candidates.every(candidate => sameRate(candidate.rate, first.rate))
    ? { kind: 'hit', candidate: first }
    : { kind: 'ambiguous', count: candidates.length }
}

type BranchLookup =
  | { kind: 'hit'; face: PriceFace }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'miss' }

function faceOf(candidate: PriceCandidate, via: PriceVia, confidence: PriceConfidence): PriceFace {
  return {
    pid: candidate.pid,
    mid: candidate.mid,
    rate: candidate.rate,
    via,
    confidence,
    ...candidate.canonical === undefined ? {} : { canonical: candidate.canonical },
  }
}

function collectBranch(branch: Branch, match: (mid: string) => boolean): PriceCandidate[] {
  const out: PriceCandidate[] = []
  for (const mid of Object.keys(branch.rates)) {
    if (!match(mid)) continue
    const candidate = candidateOf(branch, mid)
    if (candidate !== null) pushUnique(out, candidate)
  }
  return out
}

function hasSuffixKey(mid: string, key: string): boolean {
  return suffixKeys(mid).includes(key)
}

function lookupBranch(branch: Branch, model: string): BranchLookup {
  const lower = lowerModelId(model)
  const normalized = normalizeModelId(model)
  const stages: ReadonlyArray<{
    match: (mid: string) => boolean
    via: PriceVia
    confidence: PriceConfidence
  }> = [
    { match: mid => lowerModelId(mid) === lower, via: 'direct', confidence: 'high' },
    { match: mid => hasSuffixKey(lowerModelId(mid), lower), via: 'branch-suffix', confidence: 'high' },
    { match: mid => normalizeModelId(mid) === normalized, via: 'branch-normalized', confidence: 'medium' },
    { match: mid => hasSuffixKey(normalizeModelId(mid), normalized), via: 'branch-normalized', confidence: 'medium' },
  ]
  for (const stage of stages) {
    const picked = pickCandidates(collectBranch(branch, stage.match))
    if (picked.kind === 'miss') continue
    if (picked.kind === 'ambiguous') return picked
    return { kind: 'hit', face: faceOf(picked.candidate, stage.via, stage.confidence) }
  }
  return { kind: 'miss' }
}

function lookupModel(branch: Branch, model: string): BranchLookup {
  const direct = lookupBranch(branch, model)
  if (direct.kind !== 'miss') return direct
  const bare = bareModelOf(model)
  return bare === model ? direct : lookupBranch(branch, bare)
}

function collectCatalog(book: ModelBook, match: (mid: string) => boolean): PriceCandidate[] {
  const out: PriceCandidate[] = []
  for (const pid of Object.keys(book.prices)) {
    const branch = branchOf(book, pid)
    if (branch === null) continue
    for (const candidate of collectBranch(branch, match)) pushUnique(out, candidate)
  }
  return out
}

function catalogCandidates(book: ModelBook, model: string): PriceCandidate[] {
  const lower = lowerModelId(model)
  const exact = collectCatalog(book, mid => lowerModelId(mid) === lower)
  if (exact.length > 0) return exact
  const bare = bareModelOf(lower)
  if (bare !== lower) {
    const bareExact = collectCatalog(book, mid => lowerModelId(mid) === bare)
    if (bareExact.length > 0) return bareExact
  }
  const normalized = normalizeModelId(model)
  const normalizedExact = collectCatalog(book, mid => normalizeModelId(mid) === normalized)
  if (normalizedExact.length > 0) return normalizedExact
  return bare === lower ? [] : collectCatalog(book, mid => normalizeModelId(mid) === normalizeModelId(bare))
}

function labsOf(candidates: readonly PriceCandidate[]): Set<string> {
  const labs = new Set<string>()
  for (const candidate of candidates) {
    if (candidate.lab !== undefined) labs.add(candidate.lab)
  }
  return labs
}

function labHint(model: string, labs: ReadonlySet<string>): string | undefined {
  const org = orgOf(model)
  if (org !== undefined && labs.has(org)) return org
  const vendor = familyVendorOf(model)
  return vendor !== undefined && labs.has(vendor) ? vendor : undefined
}

function routedBranch(book: ModelBook, provider: string): { branch: Branch; aliased: boolean } | null {
  const exact = branchOf(book, provider)
  if (exact !== null) return { branch: exact, aliased: false }
  const alias = modelsDevProviderOf(provider)
  if (alias === provider) return null
  const target = branchOf(book, alias)
  return target === null ? null : { branch: target, aliased: true }
}

function makerLookup(book: ModelBook, lab: string, model: string): BranchLookup {
  const branch = branchOf(book, lab)
  return branch === null ? { kind: 'miss' } : lookupModel(branch, model)
}

function priced(face: PriceFace): PriceResolution {
  return { kind: 'priced', face }
}

function unpriced(reason: Exclude<PriceMissReason, 'ambiguous'>): PriceResolution {
  return { kind: 'unpriced', miss: { reason } }
}

function ambiguous(count: number): PriceResolution {
  return { kind: 'unpriced', miss: { reason: 'ambiguous', candidates: count } }
}

const resolutionMemo = new WeakMap<ModelBook, Map<string, PriceResolution>>()

export function priceResolutionOf(book: ModelBook | null | undefined, provider: string, model: string): PriceResolution {
  if (book === null || book === undefined) return unpriced('book-unavailable')
  const key = `${provider}\u0000${model}`
  const memo = memoOf(resolutionMemo, book)
  const hit = memo.get(key)
  if (hit !== undefined) return hit
  const resolution = resolvePriceOf(book, provider, model)
  memo.set(key, resolution)
  return resolution
}

function resolvePriceOf(book: ModelBook, provider: string, model: string): PriceResolution {
  const routed = routedBranch(book, provider)
  if (routed !== null) {
    const match = lookupModel(routed.branch, model)
    if (match.kind === 'hit') return priced(routed.aliased ? { ...match.face, via: 'provider-alias' } : match.face)
    if (match.kind === 'ambiguous') return ambiguous(match.count)
    if (!multiVendorOf(book, routed.branch)) return unpriced('model-unknown')
  }
  const org = orgOf(model)
  if (org !== undefined) {
    const branch = branchOf(book, org)
    if (branch !== null) {
      const match = lookupBranch(branch, bareModelOf(model))
      if (match.kind === 'hit') return priced({ ...match.face, via: 'org-branch', confidence: 'high' })
      if (match.kind === 'ambiguous') return ambiguous(match.count)
    }
  }
  const candidates = catalogCandidates(book, model)
  const labs = labsOf(candidates)
  if (labs.size === 1) {
    const lab = [...labs][0]
    const match = makerLookup(book, lab, model)
    if (match.kind === 'hit') return priced({ ...match.face, via: 'canonical-maker', confidence: 'high' })
    if (match.kind === 'ambiguous') return ambiguous(match.count)
  } else if (labs.size > 1) {
    const hint = labHint(model, labs)
    if (hint === undefined) return ambiguous(candidates.length)
    const match = makerLookup(book, hint, model)
    if (match.kind === 'hit') return priced({ ...match.face, via: 'canonical-maker', confidence: 'high' })
    return ambiguous(match.kind === 'ambiguous' ? match.count : candidates.length)
  } else {
    const vendor = familyVendorOf(model)
    if (vendor !== undefined) {
      const branch = branchOf(book, vendor)
      if (branch !== null) {
        const match = lookupModel(branch, model)
        if (match.kind === 'hit') return priced({ ...match.face, via: 'family', confidence: 'medium' })
        if (match.kind === 'ambiguous') return ambiguous(match.count)
      }
    }
  }
  const picked = pickCandidates(candidates)
  if (picked.kind === 'hit') return priced(faceOf(picked.candidate, 'index', 'low'))
  if (picked.kind === 'ambiguous') return ambiguous(picked.count)
  return unpriced('no-entry')
}

export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  const resolution = priceResolutionOf(book, provider, model)
  return resolution.kind === 'priced' ? resolution.face : null
}

export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

export function priceLookupsOf(usage: SessionCostUsage | null | undefined, book: ModelBook | null | undefined): PriceLookup[] {
  if (usage === null || usage === undefined || book === null || book === undefined) return []
  const lookups: PriceLookup[] = []
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const resolution = priceResolutionOf(book, provider, model)
      lookups.push(resolution.kind === 'priced'
        ? { provider, model, face: resolution.face }
        : { provider, model, face: null, miss: resolution.miss })
    }
  }
  return lookups
}

export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): number | null {
  const usd = calculateSessionCost(usage, book)
  return usd === null ? null : toCurrency(usd, currency)
}

export function billedTokensOf(usage: SessionCostUsage | null | undefined): number {
  if (usage === null || usage === undefined) return 0
  let total = 0
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        total += numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output)
      }
    }
  }
  return total
}

function mergeInto(out: SessionCostUsage, usage: SessionCostUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null || Array.isArray(models)) continue
    const branch = out[provider] ?? (out[provider] = {})
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null || Array.isArray(periods)) continue
      const target = branch[model] ?? (branch[model] = {})
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null || Array.isArray(bucket)) continue
        const prev = target[period] ?? { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 0 }
        target[period] = {
          uncached: prev.uncached + numOf(bucket.uncached),
          cacheRead: prev.cacheRead + numOf(bucket.cacheRead),
          cacheWrite: prev.cacheWrite + numOf(bucket.cacheWrite),
          output: prev.output + numOf(bucket.output),
        }
        any = true
      }
    }
  }
  return any
}

export function mergeCostUsage(...usages: (SessionCostUsage | null | undefined)[]): SessionCostUsage | null {
  const out: SessionCostUsage = {}
  let any = false
  for (const usage of usages) {
    if (mergeInto(out, usage)) any = true
  }
  return any ? out : null
}

interface PricedEntry {
  provider: string
  model: string
  cost: Record<string, unknown>
  canonical: string | undefined
}

function eachPricedEntry(value: unknown, visit: (entry: PricedEntry) => void): boolean {
  const data = asRecord(value)
  if (data === null || Array.isArray(data)) return false
  for (const provider of Object.keys(data)) {
    if (unsafeKey(provider)) continue
    const providerRecord = asRecord(data[provider])
    const models = providerRecord !== null ? asRecord(providerRecord.models) : null
    if (models === null) continue
    for (const model of Object.keys(models)) {
      if (unsafeKey(model)) continue
      const modelRecord = asRecord(models[model])
      const cost = modelRecord !== null ? asRecord(modelRecord.cost) : null
      if (cost === null) continue
      const canonical = modelRecord?.['canonical_model_id']
      visit({
        provider,
        model,
        cost,
        canonical: typeof canonical === 'string' && canonical.length > 0 ? canonical : undefined,
      })
    }
  }
  return true
}

export function priceSourceOf(value: unknown): Record<string, unknown> | null {
  const providers = new Map<string, Record<string, unknown>>()
  const walked = eachPricedEntry(value, ({ provider, model, cost, canonical }) => {
    let models = providers.get(provider)
    if (models === undefined) {
      models = {}
      providers.set(provider, models)
    }
    models[model] = {
      cost: { ...cost },
      ...canonical === undefined ? {} : { canonical_model_id: canonical },
    }
  })
  if (!walked) return null
  const out: Record<string, unknown> = {}
  for (const [provider, models] of providers) out[provider] = { models }
  return out
}

export function pricesBookOf(value: unknown): ModelBook | null {
  const prices: ModelPrices = {}
  const canonicalIds: Record<string, Record<string, string>> = {}
  const walked = eachPricedEntry(value, ({ provider, model, cost, canonical: canonicalId }) => {
    const miss = rateNum(cost.input)
    const out = rateNum(cost.output)
    if (miss === null || out === null) return
    const branch = prices[provider] ?? (prices[provider] = {})
    branch[model] = {
      hit: rateNum(cost.cache_read) ?? miss,
      miss,
      write: rateNum(cost.cache_write) ?? miss,
      out,
    }
    if (canonicalId !== undefined) (canonicalIds[provider] ??= {})[model] = canonicalId
  })
  return walked ? { prices, canonicalIds } : null
}

function rateNum(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
}

export function calculateSessionCost(usage: SessionCostUsage | null | undefined, book: ModelBook | null | undefined): number | null {
  if (usage === null || usage === undefined || book === null || book === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(book, provider, model)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const price = (numOf(bucket.cacheRead) * rate.hit + numOf(bucket.uncached) * rate.miss
          + numOf(bucket.cacheWrite) * rate.write + numOf(bucket.output) * rate.out) / 1e6
        total += deepseek && period === 'peak' ? price * PEAK_FACTOR : price
        any = true
      }
    }
  }
  return any ? total : null
}
