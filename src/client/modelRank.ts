import { useSyncExternalStore } from 'react'
import { mergeCostUsage } from './cost'
import { windowTotalsOf, type OverviewRow, type RangeWindow } from './overview'
import { asRecord, type ClientCtx } from './services'
import type { CostBucketTotals, SessionCostUsage } from '../shared/types'

export interface CatalogModel {
  provider: string
  model: string
  name: string
}

export interface ModelCatalogIndex {
  models: readonly CatalogModel[]
  providerNames: ReadonlyMap<string, string>
  failedProviders: ReadonlySet<string>
}

export interface ModelRankStat {
  provider: string
  providerName: string
  model: string
  name: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
  sessions: number
  active: boolean
}

interface Bucket {
  provider: string
  model: string
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  total: number
  sessions: number
}

function keyOf(provider: string, model: string): string {
  return JSON.stringify([provider, model])
}

function forModels(usage: SessionCostUsage | null, visit: (provider: string, model: string, bucket: CostBucketTotals) => void): void {
  if (usage === null) return
  for (const [provider, models] of Object.entries(usage)) {
    for (const [model, periods] of Object.entries(models)) {
      for (const bucket of [periods.peak, periods.off]) {
        if (bucket !== undefined) visit(provider, model, bucket)
      }
    }
  }
}

function addBucket(target: Bucket, bucket: CostBucketTotals): void {
  target.input += bucket.uncached
  target.cacheRead += bucket.cacheRead
  target.cacheWrite += bucket.cacheWrite
  target.output += bucket.output
  target.total += bucket.uncached + bucket.cacheRead + bucket.cacheWrite + bucket.output
}

export function scopedUsageOf(row: OverviewRow, opts: { scope: RangeWindow; day: string | null }): SessionCostUsage | null {
  if (row.activity !== null) {
    if (opts.day !== null) return mergeCostUsage(row.activity.days[opts.day]?.cost)
    return windowTotalsOf(row.activity, opts.scope).usage
  }
  return opts.day === null && opts.scope.start === null && opts.scope.end === null ? row.familyCost : null
}

export function modelRankOf(
  rows: readonly OverviewRow[],
  opts: { scope: RangeWindow; day: string | null },
  catalog: ModelCatalogIndex | null,
): ModelRankStat[] {
  const stats = new Map<string, Bucket>()
  for (const row of rows) {
    const seen = new Set<string>()
    forModels(scopedUsageOf(row, opts), (provider, model, bucket) => {
      const key = keyOf(provider, model)
      let entry = stats.get(key)
      if (entry === undefined) {
        entry = { provider, model, input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, sessions: 0 }
        stats.set(key, entry)
      }
      addBucket(entry, bucket)
      if (!seen.has(key)) {
        seen.add(key)
        entry.sessions += 1
      }
    })
  }
  const names = new Map<string, string>()
  if (catalog !== null) {
    for (const configured of catalog.models) {
      const key = keyOf(configured.provider, configured.model)
      names.set(key, configured.name)
      if (!stats.has(key)) {
        stats.set(key, {
          provider: configured.provider,
          model: configured.model,
          input: 0,
          cacheRead: 0,
          cacheWrite: 0,
          output: 0,
          total: 0,
          sessions: 0,
        })
      }
    }
  }
  return [...stats.entries()]
    .map(([key, entry]) => ({
      ...entry,
      providerName: catalog?.providerNames.get(entry.provider) ?? entry.provider,
      name: names.get(key) ?? entry.model,
      active: catalog === null || names.has(key) || catalog.failedProviders.has(entry.provider),
    }))
    .sort((a, b) => (b.total - a.total) || a.model.localeCompare(b.model))
}

export function catalogIndexOf(value: unknown): ModelCatalogIndex | null {
  const outer = asRecord(value)
  if (outer === null) return null
  const body = Array.isArray(outer.groups) ? outer : asRecord(outer.value)
  const groups = body?.groups
  if (!Array.isArray(groups)) return null
  const models: CatalogModel[] = []
  const providerNames = new Map<string, string>()
  for (const rawGroup of groups) {
    const group = asRecord(rawGroup)
    const provider = typeof group?.id === 'string' ? group.id : ''
    if (!Array.isArray(group?.models)) continue
    if (provider !== '') providerNames.set(provider, typeof group.name === 'string' && group.name !== '' ? group.name : provider)
    for (const rawModel of group.models) {
      const model = asRecord(rawModel)
      const id = typeof model?.id === 'string' ? model.id : ''
      if (provider === '' || id === '') continue
      models.push({ provider, model: id, name: typeof model?.name === 'string' && model.name !== '' ? model.name : id })
    }
  }
  return { models, providerNames, failedProviders: failedProvidersOf(body?.failures) }
}

function failedProvidersOf(value: unknown): ReadonlySet<string> {
  const failed = new Set<string>()
  if (!Array.isArray(value)) return failed
  for (const raw of value) {
    const id = asRecord(raw)?.id
    if (typeof id === 'string' && id !== '') failed.add(id)
  }
  return failed
}

type CatalogLoader = () => Promise<unknown>

let loader: CatalogLoader | null = null
let snap: ModelCatalogIndex | null = null
let started = false
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()

function load(): Promise<void> {
  if (inflight !== null) return inflight
  const current = loader
  if (current === null) return Promise.resolve()
  const run = (async () => {
    try {
      snap = catalogIndexOf(await current())
    } catch {
      snap = null
    }
    for (const fn of listeners) fn()
  })()
  inflight = run.finally(() => {
    inflight = null
  })
  return inflight
}

export const subscribeModelCatalog = (fn: () => void): (() => void) => {
  listeners.add(fn)
  if (!started) {
    started = true
    void load()
  }
  return () => {
    listeners.delete(fn)
  }
}

export const getModelCatalogSnap = (): ModelCatalogIndex | null => snap

export function refreshModelCatalog(): void {
  void load()
}

export function useModelCatalog(): ModelCatalogIndex | null {
  return useSyncExternalStore(subscribeModelCatalog, getModelCatalogSnap, getModelCatalogSnap)
}

export function setModelCatalogLoader(next: CatalogLoader | null): void {
  loader = next
  snap = null
  started = false
  if (next !== null && listeners.size > 0) {
    started = true
    void load()
  }
}

export function resetModelCatalog(): void {
  setModelCatalogLoader(null)
  listeners.clear()
}

interface ModelCatalogRemote {
  modelCatalog?: () => Promise<unknown>
}

export function watchModelCatalog(ctx: ClientCtx): void {
  ctx.inject(['remote', 'remote.session'], (raw) => {
    const session = (raw as ClientCtx & { remote?: { session?: ModelCatalogRemote } }).remote?.session
    const call = typeof session?.modelCatalog === 'function' ? session.modelCatalog.bind(session) : null
    setModelCatalogLoader(call)
    return () => {
      setModelCatalogLoader(null)
    }
  })
}
