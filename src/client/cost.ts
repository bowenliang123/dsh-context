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

/** Resolve a model id book-wide. An org segment that is itself a price-book
 * provider (`google-vertex/gemini-4-argon` on a gateway) prices from that
 * provider's own branch first: an aggregator can file the full id as its model
 * key and would otherwise win as the lone carrier (issue #174). The org rule
 * inside one key cannot do this — `google` also matches `google-vertex` — so
 * the branch lookup is exact. Otherwise the full id, then its last `/`-segment. */
function resolveRate(book: ModelBook, model: string): PriceCandidate | null {
  const lower = model.toLowerCase()
  const slash = lower.lastIndexOf('/')
  const org = slash > 0 ? lower.slice(0, slash) : null
  if (org !== null) {
    const own = branchOf(book.prices, org)
    const hit = own === null ? null : lookupFace(own, model.slice(slash + 1))
    // lookupFace accepts entries the index dropped, so only an indexed candidate is a rate.
    const listed = hit === null ? undefined : book.index.byModel.get(hit.mid.toLowerCase())?.find(c => c.pid === org)
    if (listed !== undefined) return listed
  }
  for (const key of slash > 0 ? [lower, lower.slice(slash + 1)] : [lower]) {
    const cands = book.index.byModel.get(key)
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
 * short (`k3`) where the registry namespaces them (`kimi-k3`). Several suffix candidates are ambiguous and price nothing. */
function lookupFace(models: Record<string, PriceTriple>, model: string): { mid: string; rate: PriceTriple } | null {
  if (Object.hasOwn(models, model)) return { mid: model, rate: models[model] }
  const m = model.toLowerCase()
  let found: { mid: string; rate: PriceTriple } | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = { mid: id, rate: models[id] }
  }
  return found
}

/**
 * One billed model's price and registry face. The dsh provider id prices by
 * model id (exact, case-insensitive, or suffix); a provider the book does not
 * carry falls back to the model-side index.
 *
 * The one vendor-level seam: a `deepseek-` model id prices from DeepSeek's own
 * branch first, since its listing is the first-party book with cache rates,
 * while the model-side tiers can hand the same id to a self-named host that
 * bills cache hits as plain input (azure's `deepseek-v4-pro`, issue #93).
 */
export function priceFaceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceFace | null {
  if (book === null || book === undefined) return null
  const registryPid = modelsDevProviderOf(provider)
  const direct = branchOf(book.prices, registryPid)
  // A carried provider's own branch is final: an unknown model there prices null.
  if (direct !== null) {
    const found = lookupFace(direct, model)
    return found === null ? null : { pid: registryPid, mid: found.mid, rate: found.rate }
  }
  if (model.toLowerCase().startsWith('deepseek-')) {
    const firstParty = branchOf(book.prices, 'deepseek')
    if (firstParty !== null) {
      const official = lookupFace(firstParty, model)
      if (official !== null) return { pid: 'deepseek', mid: official.mid, rate: official.rate }
    }
  }
  const cand = resolveRate(book, model)
  return cand === null ? null : { pid: cand.pid, mid: cand.mid, rate: cand.rate }
}

export function priceOf(book: ModelBook | null | undefined, provider: string, model: string): PriceTriple | null {
  return priceFaceOf(book, provider, model)?.rate ?? null
}

/** Price the session's cumulative billed totals; `peak` buckets double for
 * DeepSeek only. Null when nothing was priced, so the cell can show a dash. */
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
    // The doubled peak period is DeepSeek's alone.
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
