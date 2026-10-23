/** Session-cost estimate from the models.dev book (USD per 1M tokens; CNY at 1 CNY = 0.15 USD); DeepSeek's
 * OFF-peak figures, so only its `peak` buckets double. */

import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf } from '../shared/providers'
import { officialFaceOf } from './officialPrices'
import { asRecord, numOf, type LocaleService } from './services'

export type CostCurrency = 'usd' | 'cny'

const USD_PER_CNY = 0.15

const PEAK_FACTOR = 2

/** Which listing prices a call the billed provider renamed: its own branch, or the vendor's. */
export type PriceBasis = 'book' | 'official'

/** Display-preference pricing inputs (the volatile cost settings); {@link BOOK_PREFS} prices the book as published. */
export interface CostPrefs {
  /** USD per CNY for the CNY display (the book's official conversion is 0.15). */
  usdPerCny: number
  /** The DeepSeek peak-bucket multiplier (the book's list prices are off-peak). */
  peakFactor: number
  /** Global display multiplier for actual-paid estimates; 1 prices officially. */
  multiplier: number
  /** `official` prices a renamed model from its vendor's listing, not the reseller's. */
  priceBasis: PriceBasis
}

export const BOOK_PREFS: CostPrefs = { usdPerCny: USD_PER_CNY, peakFactor: PEAK_FACTOR, multiplier: 1, priceBasis: 'book' }

/** Per-1M-token rates (USD); an absent registry cache field falls back to the input rate. */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** A cross-provider candidate: provider id, registry model-id spelling (`mid`), rates, vendor flag. */
export interface PriceCandidate { pid: string; mid: string; rate: PriceTriple; primary: boolean }

/** Lowercased model id (exact plus its `-` suffix tails, e.g. `k3` under `kimi-k3`) → its providers. */
export interface PriceIndex { byModel: Map<string, PriceCandidate[]> }

export interface ModelBook { prices: ModelPrices; index: PriceIndex }

export interface PriceFace { pid: string; mid: string; rate: PriceTriple }

export function toCurrency(usd: number, currency: CostCurrency, prefs: CostPrefs = BOOK_PREFS): number {
  return currency === 'cny' ? usd / prefs.usdPerCny : usd
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

/** `npmOf` is each provider's registry `npm`; `@ai-sdk/<its own id>` marks a first-party provider. */
export function priceIndexOf(prices: ModelPrices, npmOf: Record<string, string | null>): PriceIndex {
  const byModel = new Map<string, PriceCandidate[]>()
  const push = (key: string, cand: PriceCandidate): void => {
    const list = byModel.get(key)
    if (list === undefined) byModel.set(key, [cand])
    else if (!list.some(c => c.pid === cand.pid && sameRate(c.rate, cand.rate))) list.push(cand)
  }
  for (const pid of Object.keys(prices)) {
    const branch = branchOf(prices, pid)
    if (branch === null) continue
    const npm: unknown = npmOf[pid]
    const primary = typeof npm === 'string' && npm.startsWith('@ai-sdk/') && npm.slice('@ai-sdk/'.length) === pid
    for (const mid of Object.keys(branch)) {
      const rate = rateOfEntry(branch[mid])
      if (rate === null) continue
      const lower = mid.toLowerCase()
      const cand: PriceCandidate = { pid, mid, rate, primary }
      push(lower, cand)
      const parts = lower.split('-')
      for (let i = 1; i < parts.length; i++) push(parts.slice(i).join('-'), cand)
    }
  }
  return { byModel }
}

function majorityCandidate(cands: PriceCandidate[]): PriceCandidate | null {
  const groups: { cand: PriceCandidate; n: number }[] = []
  for (const c of cands) {
    const g = groups.find(g => sameRate(g.cand.rate, c.rate))
    if (g === undefined) groups.push({ cand: c, n: 1 })
    else g.n++
  }
  groups.sort((a, b) => b.n - a.n)
  return groups.length > 1 && groups[0].n === groups[1].n ? null : groups[0].cand
}

function resolveCandidates(lower: string, cands: PriceCandidate[], org: string | null): PriceCandidate | null {
  if (org !== null) {
    // `vendor/model` catalogs: the org names the vendor — exactly, or as the registry id behind a variant org.
    const named = cands.filter(c => c.pid === org || org.startsWith(c.pid + '-') || (org.length >= 4 && org.startsWith(c.pid)))
    if (named.length > 0) {
      const cand = majorityCandidate(named)
      if (cand !== null) return cand
    }
  }
  const primaries = cands.filter(c => c.primary)
  if (primaries.length > 0) {
    const cand = majorityCandidate(primaries)
    if (cand !== null) return cand
  }
  const prefixed = cands.filter(c => lower.startsWith(c.pid + '-') || lower.startsWith(c.pid + '/'))
  if (prefixed.length > 0) {
    const cand = majorityCandidate(prefixed)
    if (cand !== null) return cand
  }
  return cands.length === 1 ? cands[0] : null
}

function resolveRate(index: PriceIndex, model: string): PriceCandidate | null {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : null
  for (const key of slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]) {
    const cands = index.byModel.get(key)
    if (cands === undefined) continue
    const cand = resolveCandidates(key, cands, org)
    if (cand !== null) return cand
  }
  return null
}

function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const v: unknown = book[id]
  return v !== null && typeof v === 'object' ? (v as Record<string, PriceTriple>) : null
}

/** Exact own key first (the book is untrusted wire data), then case-insensitive suffix; suffix candidates from
 * different keys are ambiguous and price nothing. */
function lookupFaceOf(models: Record<string, PriceTriple>, model: string): { mid: string; rate: PriceTriple } | { reason: 'unknown-model' | 'ambiguous' } {
  if (Object.hasOwn(models, model)) return { mid: model, rate: models[model] }
  const m = model.toLowerCase()
  let found: { mid: string; rate: PriceTriple } | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return { reason: 'ambiguous' }
    seen = lower
    found = { mid: id, rate: models[id] }
  }
  return found ?? { reason: 'unknown-model' }
}

/** Why a model prices nothing: no book, an id the book never carries, or competing suffix candidates. */
export type UnpricedReason = 'no-book' | 'unknown-model' | 'ambiguous'

/** A face hunt's outcome: the face, or the single reason nothing priced. */
export type PriceResolution = { face: PriceFace } | { face: null; reason: UnpricedReason }

/** One billed model's price, registry face, and unpriced verdict: the dsh provider id prices by model id, else
 * the model-side index. An `official` basis tries the alias's vendor listing first. */
export function priceFaceDetailedOf(
  book: ModelBook | null | undefined,
  provider: string,
  model: string,
  prefs: CostPrefs = BOOK_PREFS,
): PriceResolution {
  if (book === null || book === undefined) return { face: null, reason: 'no-book' }
  if (prefs.priceBasis === 'official') {
    const official = officialFaceOf(model)
    if (official !== null) {
      const branch = branchOf(book.prices, official.pid)
      const found = branch === null ? null : lookupFaceOf(branch, official.mid)
      if (found !== null && !('reason' in found)) return { face: { pid: official.pid, mid: found.mid, rate: found.rate } }
    }
  }
  const registryPid = modelsDevProviderOf(provider)
  const direct = branchOf(book.prices, registryPid)
  // A carried provider's own branch is final: an unknown model there prices null.
  if (direct !== null) {
    const found = lookupFaceOf(direct, model)
    return 'reason' in found ? { face: null, reason: found.reason } : { face: { pid: registryPid, mid: found.mid, rate: found.rate } }
  }
  if (model.toLowerCase().startsWith('deepseek-')) {
    const firstParty = branchOf(book.prices, 'deepseek')
    if (firstParty !== null) {
      const official = lookupFaceOf(firstParty, model)
      if (!('reason' in official)) return { face: { pid: 'deepseek', mid: official.mid, rate: official.rate } }
    }
  }
  const cand = resolveRate(book.index, model)
  if (cand !== null) return { face: { pid: cand.pid, mid: cand.mid, rate: cand.rate } }
  // The index searched the full id then the last `/` segment; a key it found
  // but could not resolve was a candidate tie — ambiguity, not absence.
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const keys = slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]
  return { face: null, reason: keys.some(key => book.index.byModel.has(key)) ? 'ambiguous' : 'unknown-model' }
}

export function priceFaceOf(
  book: ModelBook | null | undefined,
  provider: string,
  model: string,
  prefs: CostPrefs = BOOK_PREFS,
): PriceFace | null {
  return priceFaceDetailedOf(book, provider, model, prefs).face
}

export function priceOf(
  book: ModelBook | null | undefined,
  provider: string,
  model: string,
  prefs: CostPrefs = BOOK_PREFS,
): PriceTriple | null {
  return priceFaceOf(book, provider, model, prefs)?.rate ?? null
}

/** One model's period buckets priced at `rate` (USD, unconverted). The doubled
 * peak period is DeepSeek's alone; `prefs.peakFactor` stands in for the book's 2. */
function priceBuckets(periods: Record<string, unknown>, rate: PriceTriple, deepseek: boolean, prefs: CostPrefs): number {
  let price = 0
  for (const period of ['peak', 'off'] as const) {
    const bucket = asRecord(periods[period])
    if (bucket === null) continue
    const p = (numOf(bucket.cacheRead) * rate.hit + numOf(bucket.uncached) * rate.miss
      + numOf(bucket.cacheWrite) * rate.write + numOf(bucket.output) * rate.out) / 1e6
    price += deepseek && period === 'peak' ? p * prefs.peakFactor : p
  }
  return price
}

/** Prices cumulative billed totals (`peak` doubles for DeepSeek only); null when nothing was priced. */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  prefs: CostPrefs = BOOK_PREFS,
): number | null {
  if (usage === null || usage === undefined || book === null || book === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(book, provider, model, prefs)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      total += priceBuckets(periods, rate, deepseek, prefs)
      any = true
    }
  }
  return any ? toCurrency(total * prefs.multiplier, currency, prefs) : null
}

/** One period bucket's billed tokens; a missing bucket bills nothing. */
function bucketTokensOf(bucket: unknown): number {
  const b = asRecord(bucket)
  if (b === null) return 0
  return numOf(b.uncached) + numOf(b.cacheRead) + numOf(b.cacheWrite) + numOf(b.output)
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
      for (const period of ['peak', 'off'] as const) total += bucketTokensOf(periods[period])
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

/** The display currency follows the active locale — read per render: slot outlets re-render on a locale switch. */
export function displayCurrencyOf(locale: LocaleService): CostCurrency {
  return typeof locale.getLocale === 'function' && locale.getLocale().active === 'zh' ? 'cny' : 'usd'
}

export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + (amount >= 0.1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** One billed model's breakdown line: its tokens, priced cost, and where the
 * price came from — or, for an unpriced line, the book branch to amend and why
 * nothing priced. The two shapes split on `cost`. */
interface CostModelPricedLine {
  provider: string
  model: string
  tokens: number
  cost: number
  pid: string
  mid: string
  rate: PriceTriple
}

interface CostModelUnpricedLine {
  provider: string
  model: string
  tokens: number
  cost: null
  /** The book branch the hunt checked first (null: no book loaded at all). */
  pid: string | null
  mid: null
  rate: null
  reason: UnpricedReason
}

export type CostModelLine = CostModelPricedLine | CostModelUnpricedLine

/** Price the usage model by model — the cost KPI's disclosure. Lines sort
 * priced-first by cost, then tokens; unpriced lines keep the face hunt's
 * verdict so the disclosure can say why nothing priced. */
export function costBreakdownOf(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  prefs: CostPrefs = BOOK_PREFS,
): CostModelLine[] {
  if (usage === null || usage === undefined) return []
  const lines: CostModelLine[] = []
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const periods = asRecord(models[model])
      if (periods === null) continue
      const tokens = bucketTokensOf(periods.peak) + bucketTokensOf(periods.off)
      const found = priceFaceDetailedOf(book, provider, model, prefs)
      if (found.face === null) {
        const branch = found.reason === 'no-book' ? null : modelsDevProviderOf(provider)
        lines.push({ provider, model, tokens, cost: null, pid: branch, mid: null, rate: null, reason: found.reason })
        continue
      }
      const cost = toCurrency(priceBuckets(periods, found.face.rate, deepseek, prefs) * prefs.multiplier, currency, prefs)
      lines.push({ provider, model, tokens, cost, pid: found.face.pid, mid: found.face.mid, rate: found.face.rate })
    }
  }
  return lines.sort((a, b) => {
    if (a.cost === null || b.cost === null) return a.cost === b.cost ? 0 : a.cost === null ? 1 : -1
    return b.cost - a.cost || b.tokens - a.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model)
  })
}
