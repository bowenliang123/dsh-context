/**
 * Session-cost estimate: prices the host-folded cumulative billed totals from
 * the client's models.dev price book. Rates are USD per 1M tokens, converted
 * for the CNY display at 1 CNY = 0.15 USD.
 *
 * DeepSeek's book figures are the official OFF-peak rates, so only its `peak`
 * buckets double here; a provider id the registry does not know prices through
 * the model-side index, whose vendor comes from registry data.
 */

import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf } from '../shared/providers'
import { asRecord, numOf, type LocaleService } from './services'

export type CostCurrency = 'usd' | 'cny'

const USD_PER_CNY = 0.15

const PEAK_FACTOR = 2

/** Display-preference pricing inputs (the volatile cost settings); {@link OFFICIAL_PREFS} prices the book as published. */
export interface CostPrefs {
  /** USD per CNY for the CNY display (the book's official conversion is 0.15). */
  usdPerCny: number
  /** The DeepSeek peak-bucket multiplier (the book's list prices are off-peak). */
  peakFactor: number
  /** Global display multiplier for actual-paid estimates; 1 prices officially. */
  multiplier: number
}

export const OFFICIAL_PREFS: CostPrefs = { usdPerCny: USD_PER_CNY, peakFactor: PEAK_FACTOR, multiplier: 1 }

/** Per-1M-token rates (USD); an absent registry cache field falls back to the input rate. */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** One cross-provider candidate: the carrying provider (models.dev id) with its
 * rates, plus whether it is the model's own vendor (`primary`). `mid` is the
 * registry's model id spelling, the tooltip's listing face. */
export interface PriceCandidate { pid: string; mid: string; rate: PriceTriple; primary: boolean }

/** Model-side index over the book: lowercased model id (exact ids plus their
 * `-`suffix tails, e.g. `k3` under `kimi-k3`) → the providers carrying it. */
export interface PriceIndex { byModel: Map<string, PriceCandidate[]> }

export interface ModelBook { prices: ModelPrices; index: PriceIndex }

export interface PriceFace { pid: string; mid: string; rate: PriceTriple }

export function toCurrency(usd: number, currency: CostCurrency, prefs: CostPrefs = OFFICIAL_PREFS): number {
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

/** Build the resolution index over a proven book. `npmOf` carries each
 * provider's registry `npm` package (null when absent): `@ai-sdk/<its own id>`
 * marks a first-party provider, while mirrors and gateways ride a generic or foreign package. */
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

/** The candidate whose rate the most candidates share, or null on a tie. */
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
    // `vendor/model` catalogs: the org segment names the vendor, exactly or as
    // the registry id behind a variant org (`deepseek-ai` → `deepseek`).
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

/** Resolve a model id book-wide: the full id, then its last `/`-segment. */
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

/** One branch's lookup hit: exact own key first (the book is untrusted wire
 * data), then case-insensitively, then by id suffix — dsh spells some models
 * short (`k3`) where the registry namespaces them (`kimi-k3`). Several suffix
 * candidates are ambiguous and price nothing. */
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

/** Why a model prices nothing: no book at all, an id the book never carries, or several suffix candidates competing. */
export type UnpricedReason = 'no-book' | 'unknown-model' | 'ambiguous'

/** A face hunt's outcome: the face, or the single reason nothing priced. */
export type PriceResolution = { face: PriceFace } | { face: null; reason: UnpricedReason }

/**
 * One billed model's price and registry face, with the unpriced verdict. The
 * dsh provider id prices by model id (exact, case-insensitive, or suffix); a
 * provider the book does not carry falls back to the model-side index.
 *
 * The one vendor-level seam: a `deepseek-` model id prices from DeepSeek's own
 * branch first, since its listing is the first-party book with cache rates,
 * while the model-side tiers can hand the same id to a self-named host that
 * bills cache hits as plain input (azure's `deepseek-v4-pro`, issue #93).
 */
export function priceFaceDetailedOf(book: ModelBook | null | undefined, provider: string, model: string): PriceResolution {
  if (book === null || book === undefined) return { face: null, reason: 'no-book' }
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

export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  return priceFaceDetailedOf(book, provider, model).face
}

export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
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

/** Price the session's cumulative billed totals; `peak` buckets double for
 * DeepSeek only. Null when nothing was priced, so the cell can show a dash. */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  book: ModelBook | null | undefined,
  currency: CostCurrency,
  prefs: CostPrefs = OFFICIAL_PREFS,
): number | null {
  if (usage === null || usage === undefined || book === null || book === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    // The doubled peak period is DeepSeek's alone.
    const deepseek = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(book, provider, model)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      total += priceBuckets(periods, rate, deepseek, prefs)
      any = true
    }
  }
  return any ? toCurrency(total * prefs.multiplier, currency, prefs) : null
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

/** Accumulate one usage's buckets into `out`. True when any bucket record
 * merged, even an all-zero one, so the estimator prices it as $0 not a dash. */
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

/** Deep-merge session-cost usages into one — the stats board's total-cost scope
 * and the subagent fold. Null when no side carried a bucket record. */
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

/** Price-list figure: always two decimals (the tooltip's `¥ XX.XX` rate format). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return (currency === 'cny' ? '¥' : '$') + amount.toFixed(2)
}

/** One billed model's breakdown line: its tokens, priced cost, and where the
 * price came from — or why nothing priced. The two shapes split on `cost` so a
 * null-cost line always carries its verdict. */
interface CostModelPricedLine {
  provider: string
  model: string
  /** The line's billed tokens over all buckets and periods. */
  tokens: number
  /** The line's priced cost in the display currency. */
  cost: number
  /** The price face's registry ids — the book's mapping source. */
  pid: string
  mid: string
  /** The book's per-1M rates at the face (unmultiplied). */
  rate: PriceTriple
}

interface CostModelUnpricedLine {
  provider: string
  model: string
  tokens: number
  cost: null
  pid: null
  mid: null
  rate: null
  /** Why nothing priced. */
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
  prefs: CostPrefs = OFFICIAL_PREFS,
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
      let tokens = 0
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        tokens += numOf(bucket.uncached) + numOf(bucket.cacheRead) + numOf(bucket.cacheWrite) + numOf(bucket.output)
      }
      const found = priceFaceDetailedOf(book, provider, model)
      if (found.face === null) {
        lines.push({ provider, model, tokens, cost: null, pid: null, mid: null, rate: null, reason: found.reason })
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
