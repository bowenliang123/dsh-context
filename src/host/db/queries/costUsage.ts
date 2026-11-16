import { sql, type SQL } from 'drizzle-orm'
import type { CostBucketTotals, CostModelUsage, SessionCostUsage } from '../../../shared/types'
import type { Db } from '../db'
import { requests, sessions } from '../schema'

export interface UsageRow {
  key: string
  provider: string | null
  model: string | null
  period: string | null
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

function number(value: unknown): number {
  return Number(value)
}

function usageOf(row: UsageRow): SessionCostUsage {
  const provider = row.provider ?? ''
  const model = row.model ?? ''
  const totals: CostBucketTotals = {
    uncached: row.input,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    output: row.output,
  }
  const buckets: CostModelUsage = row.period === 'peak' ? { peak: totals } : { off: totals }
  return { [provider]: { [model]: buckets } }
}

function mergeUsage(out: Map<string, SessionCostUsage>, key: string, usage: SessionCostUsage): void {
  out.set(key, mergeCostUsage(out.get(key) ?? null, usage))
}

export function mergeCostUsage(target: SessionCostUsage | null, usage: SessionCostUsage): SessionCostUsage {
  if (target === null) return structuredClone(usage)
  for (const [provider, models] of Object.entries(usage)) {
    const providerTarget = target[provider] ?? {}
    for (const [model, buckets] of Object.entries(models)) {
      const current = providerTarget[model] ?? {}
      for (const period of ['peak', 'off'] as const) {
        const totals = buckets[period]
        if (totals === undefined) continue
        const prev = current[period]
        current[period] = prev === undefined
          ? { ...totals }
          : {
            uncached: prev.uncached + totals.uncached,
            cacheRead: prev.cacheRead + totals.cacheRead,
            cacheWrite: prev.cacheWrite + totals.cacheWrite,
            output: prev.output + totals.output,
          }
      }
      providerTarget[model] = current
    }
    target[provider] = providerTarget
  }
  return target
}

export function mergeUsageMap(map: Map<string, SessionCostUsage>): SessionCostUsage | null {
  let merged: SessionCostUsage | null = null
  for (const usage of map.values()) merged = mergeCostUsage(merged, usage)
  return merged
}

const COLUMNS = sql`sum(coalesce(input_tokens, 0)) as input,
  sum(coalesce(cache_read_tokens, 0)) as cache_read,
  sum(coalesce(cache_write_tokens, 0)) as cache_write,
  sum(coalesce(output_tokens, 0)) as output`

export function usageBySession(db: Db, ids: readonly string[], includeInherited = false): Map<string, SessionCostUsage> {
  const out = new Map<string, SessionCostUsage>()
  if (ids.length === 0) return out
  const rows = db.all(sql`
    select session_id as key, provider, model, period, ${COLUMNS}
    from ${requests}
    where session_id in (${sql.join(ids.map(id => sql`${id}`), sql`, `)})
      ${includeInherited ? sql`` : sql`and is_inherited = 0`}
    group by session_id, provider, model, period
  `)
  for (const raw of rows) {
    mergeUsage(out, String(raw.key), usageOf({
      key: String(raw.key),
      provider: typeof raw.provider === 'string' ? raw.provider : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      period: typeof raw.period === 'string' ? raw.period : null,
      input: number(raw.input),
      cacheRead: number(raw.cache_read),
      cacheWrite: number(raw.cache_write),
      output: number(raw.output),
    }))
  }
  return out
}

export function usageByFamily(db: Db, roots: readonly string[], filter?: SQL): Map<string, SessionCostUsage> {
  const out = new Map<string, SessionCostUsage>()
  if (roots.length === 0) return out
  const rows = db.all(sql`
    select s.family_root as key, r.provider, r.model, r.period, ${COLUMNS}
    from ${requests} r
    join ${sessions} s on s.id = r.session_id
    where s.family_root in (${sql.join(roots.map(id => sql`${id}`), sql`, `)})
      and r.is_inherited = 0
      ${filter === undefined ? sql`` : sql`and ${filter}`}
    group by s.family_root, r.provider, r.model, r.period
  `)
  for (const raw of rows) {
    mergeUsage(out, String(raw.key), usageOf({
      key: String(raw.key),
      provider: typeof raw.provider === 'string' ? raw.provider : null,
      model: typeof raw.model === 'string' ? raw.model : null,
      period: typeof raw.period === 'string' ? raw.period : null,
      input: number(raw.input),
      cacheRead: number(raw.cache_read),
      cacheWrite: number(raw.cache_write),
      output: number(raw.output),
    }))
  }
  return out
}
