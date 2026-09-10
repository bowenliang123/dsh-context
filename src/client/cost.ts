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

import type { CostBucketTotals, SessionCostUsage } from '../shared/types'
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

export type CostCurrency = keyof typeof PRICES

/**
 * Price the session's cumulative billed-token totals. Cache reads bill at
 * the hit rate; uncached input AND cache writes bill at the miss rate;
 * output (reasoning included) bills at the out rate. Null when nothing was
 * priced (no DeepSeek V4 usage folded yet), so the cell can show a dash.
 */
export function estimateSessionCost(usage: SessionCostUsage | null | undefined, currency: CostCurrency): number | null {
  if (usage === null || usage === undefined) return null
  let total = 0
  let any = false
  for (const family of ['flash', 'pro'] as const) {
    const fam = usage[family]
    if (fam === undefined) continue
    for (const period of ['peak', 'off'] as const) {
      const b: CostBucketTotals | undefined = fam[period]
      if (b === undefined) continue
      const p: PriceTriple = PRICES[currency][family][period]
      total += (numOf(b.cacheRead) * p.hit + (numOf(b.uncached) + numOf(b.cacheWrite)) * p.miss + numOf(b.output) * p.out) / 1e6
      any = true
    }
  }
  return any ? total : null
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
  return (['flash', 'pro'] as const).map(id => ({
    family: id === 'flash' ? 'deepseek-v4.1-flash / deepseek-flash' : 'deepseek-v4-pro',
    peak: PRICES[currency][id].peak,
    off: PRICES[currency][id].off,
  }))
}

/** Price-list figure: the same money format as formatCost, trailing zeros trimmed (¥3.00 → ¥3, $0.0070 → $0.007). */
export function formatPriceRate(amount: number, currency: CostCurrency): string {
  return formatCost(amount, currency).replace(/0+$/, '').replace(/\.$/, '')
}
