/**
 * Session-cost estimate — prices the host-folded cumulative billed-token
 * totals (SessionCostUsage) with DeepSeek's list prices, HARDCODED for now
 * (per request; revisit when DeepSeek adjusts prices). Source:
 * https://api-docs.deepseek.com/quick_start/pricing/ (USD) and
 * https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ (CNY).
 *
 * Peak windows are 09:00-12:00 and 14:00-18:00 Beijing Time on weekdays
 * (off-peak is half the peak rate; weekends bill at off-peak all day); the
 * Host already split the totals by period, so pricing here
 * is a pure lookup. Both currencies the UI ships are tabulated — the locale
 * picks which one the stats board shows.
 */

import type { CostBucketTotals, CostFamilyUsage, SessionCostUsage } from '../shared/types'
import { numOf } from './services'

/** Per-1M-token rates: cache-hit input, cache-miss input, output. */
export interface PriceTriple { hit: number; miss: number; out: number }

/** The Flash-series rates (peak = 2× off-peak), per currency. */
const FLASH_RATES = {
  usd: { peak: { hit: 0.006, miss: 0.3, out: 1.2 }, off: { hit: 0.003, miss: 0.15, out: 0.6 } },
  cny: { peak: { hit: 0.04, miss: 2, out: 8 }, off: { hit: 0.02, miss: 1, out: 4 } },
} as const

/**
 * Pro rides the Flash triple: between the V4.1 Flash launch and the V4.1 Pro
 * release, DeepSeek routes every Pro request to V4.1 Flash and bills it at
 * the Flash rates — point `pro` at the new table once V4.1 Pro is priced.
 */
const PRICES = {
  usd: { flash: FLASH_RATES.usd, pro: FLASH_RATES.usd },
  cny: { flash: FLASH_RATES.cny, pro: FLASH_RATES.cny },
} as const

/**
 * The key space every bucket walk shares — model family × pricing period, in
 * display order. `PRICES` is indexed by it, so pricing, the subagent fold and
 * the tooltip's rate table all have to agree on it.
 */
const FAMILIES = ['flash', 'pro'] as const
const PERIODS = ['peak', 'off'] as const

export type CostCurrency = keyof typeof PRICES

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate; uncached input AND cache writes bill at the miss rate;
 * output (reasoning included) bills at the out rate. Null when nothing was
 * priced (no DeepSeek V4 usage folded yet), so the cell can show a dash.
 *
 * A bucket the payload spells as an explicit null prices as absent, exactly
 * as a missing key does: the delivery bound is a JSON value, not this
 * module's optional-member type (services.ts `timelineOf`).
 */
export function estimateSessionCost(usage: SessionCostUsage | null | undefined, currency: CostCurrency): number | null {
  if (usage === null || usage === undefined) return null
  let total = 0
  let any = false
  for (const family of FAMILIES) {
    const fam = usage[family] ?? undefined
    if (fam === undefined) continue
    for (const period of PERIODS) {
      const b: CostBucketTotals | undefined = fam[period] ?? undefined
      if (b === undefined) continue
      const p: PriceTriple = PRICES[currency][family][period]
      total += (numOf(b.cacheRead) * p.hit + (numOf(b.uncached) + numOf(b.cacheWrite)) * p.miss + numOf(b.output) * p.out) / 1e6
      any = true
    }
  }
  return any ? total : null
}

/**
 * Sum two sessions' cumulative billed-token totals, bucket by bucket (model
 * family × pricing period). Folding a session together with its subagents
 * needs this: each side keeps its OWN family split, so a subagent that ran on
 * a different model than its parent still prices at its own family's rates.
 *
 * Either side may be absent — a session with no priced usage yet, or a family
 * only one side used — and two absences stay absent, so nothing materialises a
 * zero-filled bucket that would price to ¥0 instead of the dash. A side the
 * payload spells as an explicit null reads as absent too, and never reaches the
 * caller as the fold's result: the caller merges the result into the NEXT
 * subagent's totals, and a null accumulator throws on that read.
 */
export function addCostUsage(a: SessionCostUsage | null | undefined, b: SessionCostUsage | null | undefined): SessionCostUsage | undefined {
  if (a === null || a === undefined) return b ?? undefined
  if (b === null || b === undefined) return a
  const sum: SessionCostUsage = {}
  for (const family of FAMILIES) {
    const one = a[family] ?? undefined
    const other = b[family] ?? undefined
    if (one === undefined && other === undefined) continue
    const merged: CostFamilyUsage = {}
    for (const period of PERIODS) {
      const x = one?.[period]
      const y = other?.[period]
      if (x === undefined && y === undefined) continue
      merged[period] = {
        uncached: numOf(x?.uncached) + numOf(y?.uncached),
        cacheRead: numOf(x?.cacheRead) + numOf(y?.cacheRead),
        cacheWrite: numOf(x?.cacheWrite) + numOf(y?.cacheWrite),
        output: numOf(x?.output) + numOf(y?.output),
      }
    }
    sum[family] = merged
  }
  return sum
}

/**
 * True when the usage carries at least one family × period bucket to price —
 * the same structural walk `estimateSessionCost` folds over, for callers that
 * have to ask "is this anything?" without a currency. A null member reads as
 * absent, as everywhere else in this module.
 */
export function hasCostBuckets(usage: SessionCostUsage | null | undefined): boolean {
  if (usage === null || usage === undefined) return false
  for (const family of FAMILIES) {
    const fam = usage[family] ?? undefined
    if (fam === undefined) continue
    for (const period of PERIODS) {
      if ((fam[period] ?? undefined) !== undefined) return true
    }
  }
  return false
}

export function formatCost(amount: number, currency: CostCurrency): string {
  const symbol = currency === 'cny' ? '¥' : '$'
  return symbol + (amount >= 1 ? amount.toFixed(2) : amount.toPrecision(2))
}

/**
 * All priced model families for one currency, in display order, with their
 * peak/off-peak rate triples — the raw material of the stats-board tooltip's
 * price list. The numbers stay hardcoded in PRICES above; this function only
 * reshapes the table for display, so what the tooltip prints can never drift
 * from the math that prices the session.
 */
export function sessionPrices(currency: CostCurrency): { family: string; peak: PriceTriple; off: PriceTriple }[] {
  return FAMILIES.map(id => ({
    family: id === 'flash' ? 'deepseek-v4.1-flash / deepseek-flash' : 'deepseek-v4-pro',
    peak: PRICES[currency][id].peak,
    off: PRICES[currency][id].off,
  }))
}

/** Price-list figure: the same money format as formatCost, trailing zeros trimmed (¥3.00 → ¥3, $0.0070 → $0.007). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return formatCost(amount, currency).replace(/0+$/, '').replace(/\.$/, '')
}
