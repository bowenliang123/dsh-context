/**
 * Session-cost estimate — prices the host-folded cumulative billed-token
 * totals (SessionCostUsage) from the client's model-price book
 * (client/modelPrices.ts): the models.dev registry, fetched through
 * @opencode-ai/models. Book rates are USD per 1M tokens; the CNY display
 * converts at the fixed 1 CNY = 0.15 USD, and the total and the tooltip's
 * rates both go through `toCurrency`, so the printed figures can never
 * drift from the math that prices the session. DeepSeek's period-based list
 * prices off-peak at half: the Host already split those buckets (peak =
 * list price), so DeepSeek's `off` buckets simply price at half here —
 * never any other provider's.
 */

import type { SessionCostUsage } from '../shared/types'
import { isDeepSeekProvider, modelsDevProviderOf } from '../shared/providers'
import { asRecord, numOf } from './services'

/** The display currencies the stats board ships; the locale picks one. */
export type CostCurrency = 'usd' | 'cny'

/** 1 CNY = 0.15 USD — the fixed CNY-display conversion rate. */
const USD_PER_CNY = 0.15

/** Off-peak DeepSeek rates are half the peak rates (the official list). */
const OFF_PEAK_FACTOR = 0.5

/**
 * Per-1M-token rates (USD): cache-hit input, cache-miss input, cache
 * write, output (reasoning included). Absent registry fields fall back to
 * the input rate (a provider that publishes no cache prices bills those
 * buckets as plain input).
 */
export interface PriceTriple { hit: number; miss: number; write: number; out: number }

/**
 * The client's price book: models.dev provider id → model id → USD rates,
 * extracted from the registry (modelPrices.ts). The fold keys the cost
 * totals by the dsh provider id; `priceOf` resolves the two via
 * modelsDevProviderOf (unmapped ids pass through verbatim).
 */
export type ModelPrices = Record<string, Record<string, PriceTriple>>

/** A USD amount in the display currency (CNY divides the fixed rate). */
export function toCurrency(usd: number, currency: CostCurrency): number {
  return currency === 'cny' ? usd / USD_PER_CNY : usd
}

/** One rate triple at the half-price off-peak rate (the tooltip's `peak | off` pair). */
export function offPeakOf(rate: PriceTriple): PriceTriple {
  return {
    hit: rate.hit * OFF_PEAK_FACTOR,
    miss: rate.miss * OFF_PEAK_FACTOR,
    write: rate.write * OFF_PEAK_FACTOR,
    out: rate.out * OFF_PEAK_FACTOR,
  }
}

/** One book branch (a provider's models), as far as runtime can prove it. */
function branchOf(book: ModelPrices, id: string): Record<string, PriceTriple> | null {
  const v: unknown = book[id]
  return v !== null && typeof v === 'object' ? (v as Record<string, PriceTriple>) : null
}

/**
 * One branch's model id → rates, as far as runtime can prove it: exact own
 * key first (the book is untrusted wire data), then case-insensitively, then
 * by id SUFFIX — dsh spells some models short (`k3`) where the registry
 * namespaces them (`kimi-k3`). Several suffix candidates (e.g. `k3` vs a
 * hypothetical `other-k3`) are ambiguous and price nothing.
 */
function lookup(models: Record<string, PriceTriple>, model: string): PriceTriple | null {
  if (Object.hasOwn(models, model)) return models[model]
  const m = model.toLowerCase()
  let found: PriceTriple | null = null
  let seen: string | null = null
  for (const id in models) {
    const lower = id.toLowerCase()
    if (lower !== m && !lower.endsWith('-' + m)) continue
    if (seen !== null && seen !== lower) return null
    seen = lower
    found = models[id]
  }
  return found
}

/**
 * The book's rates for one folded (provider, model) bucket, or null when
 * the book cannot price it: the dsh provider id resolves through
 * modelsDevProviderOf (unmapped ids pass through) and prices by model id —
 * exact, case-insensitive, or suffix; a provider the book does not carry
 * falls back to a cross-provider scan, priced only when exactly one branch
 * carries the model id.
 */
export function priceOf(prices: ModelPrices | null | undefined, provider: string, model: string): PriceTriple | null {
  if (prices === null || prices === undefined) return null
  const direct = branchOf(prices, modelsDevProviderOf(provider))
  if (direct !== null) return lookup(direct, model)
  let found: PriceTriple | null = null
  for (const models of Object.values(prices)) {
    const rate = lookup(models, model)
    if (rate === null) continue
    if (found !== null) return null
    found = rate
  }
  return found
}

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate, uncached input at the miss rate, cache writes at the write
 * rate, output (reasoning included) at the out rate; `off` buckets (the
 * Host splits DeepSeek's period-based list at fold time) price at half.
 * Null when nothing was priced (no usage folded, no book yet, or no model
 * the book prices), so the cell can show a dash.
 */
export function estimateSessionCost(
  usage: SessionCostUsage | null | undefined,
  prices: ModelPrices | null | undefined,
  currency: CostCurrency,
): number | null {
  if (usage === null || usage === undefined || prices === null || prices === undefined) return null
  let total = 0
  let any = false
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    if (models === null) continue
    // The half-price off-peak period is DeepSeek's alone (shared/providers):
    // every other provider bills every bucket at list price.
    const offPeak = isDeepSeekProvider(provider)
    for (const model of Object.keys(models)) {
      const rate = priceOf(prices, provider, model)
      const periods = asRecord(models[model])
      if (rate === null || periods === null) continue
      for (const period of ['peak', 'off'] as const) {
        const bucket = asRecord(periods[period])
        if (bucket === null) continue
        const price = (numOf(bucket.cacheRead) * rate.hit + numOf(bucket.uncached) * rate.miss
          + numOf(bucket.cacheWrite) * rate.write + numOf(bucket.output) * rate.out) / 1e6
        total += offPeak && period === 'off' ? price * OFF_PEAK_FACTOR : price
        any = true
      }
    }
  }
  return any ? toCurrency(total, currency) : null
}

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/** Price-list figure: the same money format as formatCost, trailing zeros trimmed (¥3.00 → ¥3, $0.0070 → $0.007). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return formatCost(amount, currency).replace(/0+$/, '').replace(/\.$/, '')
}
