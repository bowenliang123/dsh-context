/** Session-cost estimate from the models.dev book (USD per 1M tokens; CNY at 1 CNY = 0.15 USD); DeepSeek's
 * OFF-peak figures, so only its `peak` buckets double. */

import type { DisplayCurrency, SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf } from '../shared/providers'
import { asRecord, numOf, type LocaleService } from './services'
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

export type CostCurrency = 'usd' | 'cny'

const USD_PER_CNY = 0.15

const PEAK_FACTOR = 2

/** Per-1M-token rates (USD); an absent registry cache field falls back to the input rate. */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** The rule that resolved one provider/model pair. */
export type PriceVia =
  | 'direct'
  | 'branch-suffix'
  | 'branch-normalized'
  | 'provider-alias'
  | 'org-branch'
  | 'canonical-maker'
  | 'family'
  | 'index'

export type PriceConfidence = 'high' | 'medium' | 'low'

/** A cross-provider candidate: provider id, registry model-id spelling (`mid`), rates, vendor flag, and maker hints. */
export interface PriceCandidate {
  pid: string
  mid: string
  rate: PriceTriple
  canonical?: string
  lab?: string
}

/** Why one provider/model pair could not be priced. */
export type PriceMissReason = 'book-unavailable' | 'model-unknown' | 'ambiguous' | 'no-entry'

export type PriceMiss =
  | { reason: 'ambiguous'; candidates: number }
  | { reason: 'book-unavailable' | 'model-unknown' | 'no-entry' }

/** One resolved listing face, with the rule and confidence that selected it. */
export interface PriceFace {
  pid: string
  mid: string
  rate: PriceTriple
  via: PriceVia
  confidence: PriceConfidence
  canonical?: string
}

export type PriceResolution =
  | { kind: 'priced'; face: PriceFace }
  | { kind: 'unpriced'; miss: PriceMiss }

/** One provider branch's indexes: exact, suffix, normalized, and the labs it carries. */
export interface PriceBranch {
  pid: string
  byExact: Map<string, PriceCandidate[]>
  bySuffix: Map<string, PriceCandidate[]>
  byNormalized: Map<string, PriceCandidate[]>
  byNormalizedSuffix: Map<string, PriceCandidate[]>
  labs: Set<string>
  multiVendor: boolean
}

/** Exact lowercased model id → its providers; short suffix aliases live only inside provider branches. */
export interface PriceIndex {
  byModel: Map<string, PriceCandidate[]>
  byNormalized: Map<string, PriceCandidate[]>
  branches: Map<string, PriceBranch>
}

export interface ModelBook { prices: ModelPrices; index: PriceIndex }

/** One folded usage face and its resolution, or the reason it stayed unpriced. */
export type PriceLookup =
  | { provider: string; model: string; face: PriceFace; miss?: undefined }
  | { provider: string; model: string; face: null; miss: PriceMiss }

export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** Rate equality within the registry's float noise (sync drift prints 0.125000…003). */
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

function pushCandidate(map: Map<string, PriceCandidate[]>, key: string, candidate: PriceCandidate): void {
  const list = map.get(key)
  if (list === undefined) map.set(key, [candidate])
  else if (!list.some(existing => existing.pid === candidate.pid && sameRate(existing.rate, candidate.rate))) list.push(candidate)
}

function pushForms(map: Map<string, PriceCandidate[]>, forms: readonly string[], candidate: PriceCandidate): void {
  for (const key of forms) pushCandidate(map, key, candidate)
}

/** `canonicalOf` maps each provider/model to the models.dev canonical id when the registry supplies one. */
export function priceIndexOf(
  prices: ModelPrices,
  canonicalOf: Record<string, Record<string, string> | undefined> = {},
): PriceIndex {
  const byModel = new Map<string, PriceCandidate[]>()
  const byNormalized = new Map<string, PriceCandidate[]>()
  const branches = new Map<string, PriceBranch>()
  for (const pid of Object.keys(prices)) {
    if (isSubscriptionPlanProvider(pid)) continue
    const branchPrices = branchOf(prices, pid)
    if (branchPrices === null) continue
    const exact = new Map<string, PriceCandidate[]>()
    const suffix = new Map<string, PriceCandidate[]>()
    const normalized = new Map<string, PriceCandidate[]>()
    const normalizedSuffix = new Map<string, PriceCandidate[]>()
    const labs = new Set<string>()
    for (const mid of Object.keys(branchPrices)) {
      const rate = branchPrices[mid]
      if (rateOfEntry(rate) === null) continue
      const canonical = canonicalOf[pid]?.[mid]
      const lab = canonical === undefined || canonical.length === 0 ? undefined : labOf(canonical)
      const candidate: PriceCandidate = {
        pid,
        mid,
        rate,
        ...canonical === undefined || canonical.length === 0 ? {} : { canonical },
        ...lab === undefined ? {} : { lab },
      }
      const lower = lowerModelId(mid)
      const normalizedKey = normalizeModelId(mid)
      const lowerSuffixes = suffixKeys(lower)
      const normalizedSuffixes = suffixKeys(normalizedKey)
      pushCandidate(exact, lower, candidate)
      pushForms(suffix, lowerSuffixes, candidate)
      pushCandidate(normalized, normalizedKey, candidate)
      pushForms(normalizedSuffix, normalizedSuffixes, candidate)
      pushCandidate(byModel, lower, candidate)
      pushCandidate(byNormalized, normalizedKey, candidate)
      if (lab !== undefined) labs.add(lab)
    }
    branches.set(pid, {
      pid,
      byExact: exact,
      bySuffix: suffix,
      byNormalized: normalized,
      byNormalizedSuffix: normalizedSuffix,
      labs,
      multiVendor: labs.size > 1,
    })
  }
  return { byModel, byNormalized, branches }
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

function collect(map: Map<string, PriceCandidate[]>, keys: readonly string[]): PriceCandidate[] {
  const out: PriceCandidate[] = []
  for (const key of keys) out.push(...map.get(key) ?? [])
  return out
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

function lookupBranch(branch: PriceBranch, model: string): BranchLookup {
  const exact = lowerModelId(model)
  const normalized = normalizeModelId(model)
  const stages: ReadonlyArray<{
    map: Map<string, PriceCandidate[]>
    keys: readonly string[]
    via: PriceVia
    confidence: PriceConfidence
  }> = [
    { map: branch.byExact, keys: [exact], via: 'direct', confidence: 'high' },
    { map: branch.bySuffix, keys: [exact], via: 'branch-suffix', confidence: 'high' },
    { map: branch.byNormalized, keys: [normalized], via: 'branch-normalized', confidence: 'medium' },
    { map: branch.byNormalizedSuffix, keys: [normalized], via: 'branch-normalized', confidence: 'medium' },
  ]
  for (const stage of stages) {
    const picked = pickCandidates(collect(stage.map, stage.keys))
    if (picked.kind === 'miss') continue
    if (picked.kind === 'ambiguous') return picked
    return { kind: 'hit', face: faceOf(picked.candidate, stage.via, stage.confidence) }
  }
  return { kind: 'miss' }
}

function lookupModel(branch: PriceBranch, model: string): BranchLookup {
  const direct = lookupBranch(branch, model)
  if (direct.kind !== 'miss') return direct
  const bare = bareModelOf(model)
  return bare === model ? direct : lookupBranch(branch, bare)
}

function indexCandidates(index: PriceIndex, model: string): PriceCandidate[] {
  const lower = lowerModelId(model)
  const exact = collect(index.byModel, [lower])
  if (exact.length > 0) return exact
  const bare = bareModelOf(lower)
  if (bare !== lower) {
    const bareExact = collect(index.byModel, [bare])
    if (bareExact.length > 0) return bareExact
  }
  const normalized = collect(index.byNormalized, [normalizeModelId(model)])
  if (normalized.length > 0) return normalized
  return bare === lower ? [] : collect(index.byNormalized, [normalizeModelId(bare)])
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

function routedBranch(book: ModelBook, provider: string): { branch: PriceBranch; aliased: boolean } | null {
  const exact = book.index.branches.get(provider)
  if (exact !== undefined) return { branch: exact, aliased: false }
  const alias = modelsDevProviderOf(provider)
  if (alias === provider) return null
  const target = book.index.branches.get(alias)
  return target === undefined ? null : { branch: target, aliased: true }
}

function makerLookup(book: ModelBook, lab: string, model: string): BranchLookup {
  const branch = book.index.branches.get(lab)
  return branch === undefined ? { kind: 'miss' } : lookupModel(branch, model)
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

/** Resolve one billed provider/model pair through the full authority chain. */
export function priceResolutionOf(book: ModelBook | null | undefined, provider: string, model: string): PriceResolution {
  if (book === null || book === undefined) return unpriced('book-unavailable')
  const routed = routedBranch(book, provider)
  if (routed !== null) {
    const match = lookupModel(routed.branch, model)
    if (match.kind === 'hit') return priced(routed.aliased ? { ...match.face, via: 'provider-alias' } : match.face)
    if (match.kind === 'ambiguous') return ambiguous(match.count)
    if (!routed.branch.multiVendor) return unpriced('model-unknown')
  }
  const org = orgOf(model)
  if (org !== undefined) {
    const branch = book.index.branches.get(org)
    if (branch !== undefined) {
      const match = lookupBranch(branch, bareModelOf(model))
      if (match.kind === 'hit') return priced({ ...match.face, via: 'org-branch', confidence: 'high' })
      if (match.kind === 'ambiguous') return ambiguous(match.count)
    }
  }
  const candidates = indexCandidates(book.index, model)
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
      const branch = book.index.branches.get(vendor)
      if (branch !== undefined) {
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

/** One billed model's price and registry face, or null when no authority resolves it. */
export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  const resolution = priceResolutionOf(book, provider, model)
  return resolution.kind === 'priced' ? resolution.face : null
}

export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

/** Every folded usage face with its price resolution, for the tooltip's priced rows and miss notes. */
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

/** Prices cumulative billed totals (`peak` doubles for DeepSeek only); null when nothing was priced. */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
): number | null {
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
  return any ? toCurrency(total, currency) : null
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

/** True when any bucket record merged — even an all-zero one — so the estimator prices it as $0. */
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

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** The active locale's code; the stats card carries it as a plain string, the panels as the service. */
function activeLocaleOf(locale: LocaleService | string): string {
  return typeof locale === 'string'
    ? locale
    : typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
}

/** The display currency for a preference over a locale; `auto` keeps the language rule (zh → CNY, else USD). */
export function resolveCurrency(preference: DisplayCurrency, locale: LocaleService | string): CostCurrency {
  if (preference !== 'auto') return preference
  return activeLocaleOf(locale) === 'zh' ? 'cny' : 'usd'
}

export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}

function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const value: unknown = book[id]
  return value !== null && typeof value === 'object' ? value as Record<string, PriceTriple> : null
}
