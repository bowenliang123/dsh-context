import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import {
  catalogIndexOf,
  getModelCatalogSnap,
  modelRankOf,
  refreshModelCatalog,
  resetModelCatalog,
  scopedUsageOf,
  setModelCatalogLoader,
  subscribeModelCatalog,
  watchModelCatalog,
  type ModelCatalogIndex,
} from '../../src/client/modelRank'
import type { ClientCtx } from '../../src/client/services'
import type { ContextActivity, SessionCostUsage } from '../../src/shared/types'
import { rowOf } from './overview.fixtures'

const OPEN = { start: null, end: null }

const cost = (buckets: Partial<Record<'peak' | 'off', number>>): SessionCostUsage => {
  const usage: SessionCostUsage = { opencsg: { 'glm-5.1': {} } }
  for (const [period, uncached] of Object.entries(buckets)) {
    usage.opencsg['glm-5.1'][period as 'peak' | 'off'] = { uncached, cacheRead: 0, cacheWrite: 0, output: 0 }
  }
  return usage
}

const activityOf = (days: Record<string, SessionCostUsage | undefined>): ContextActivity => {
  const out: ContextActivity['days'] = {}
  for (const [key, dayCost] of Object.entries(days)) {
    out[key] = { tokens: 1, requests: 1, ...(dayCost === undefined ? {} : { cost: dayCost }) }
  }
  return { days: out }
}

const indexOf = (models: ModelCatalogIndex['models'], failed: string[] = [], names: Record<string, string> = { opencsg: 'OpenCSG' }): ModelCatalogIndex => ({
  models,
  providerNames: new Map(Object.entries(names)),
  failedProviders: new Set(failed),
})

const CATALOG = indexOf([
  { provider: 'opencsg', model: 'glm-5.1', name: 'GLM-5.1' },
  { provider: 'opencsg', model: 'glm-5.2', name: 'GLM-5.2' },
])

afterEach(() => { resetModelCatalog() })

describe('scopedUsageOf', () => {
  test('a dated activity folds the admitted days; the open range falls back to the family cost without activity', () => {
    const row = rowOf({ activity: activityOf({ '2026-09-20': cost({ peak: 10 }) }) })
    assert.equal(scopedUsageOf(row, { scope: OPEN, day: null })?.opencsg['glm-5.1'].peak?.uncached, 10)
    assert.equal(scopedUsageOf(row, { scope: OPEN, day: '2026-09-21' }), null)
    assert.equal(scopedUsageOf(rowOf({ familyCost: cost({ peak: 7 }) }), { scope: OPEN, day: null })?.opencsg['glm-5.1'].peak?.uncached, 7)
    assert.equal(scopedUsageOf(rowOf({ familyCost: cost({ peak: 7 }) }), { scope: { start: 1, end: null }, day: null }), null)
    assert.equal(scopedUsageOf(rowOf({ familyCost: cost({ peak: 7 }) }), { scope: OPEN, day: '2026-09-20' }), null)
  })

  test('a day pick reads only that ledger day', () => {
    const row = rowOf({ activity: activityOf({
      '2026-09-19': cost({ peak: 3 }),
      '2026-09-20': cost({ off: 5 }),
      '2026-09-21': undefined,
    }) })
    const usage = scopedUsageOf(row, { scope: OPEN, day: '2026-09-20' })
    assert.equal(usage?.opencsg['glm-5.1'].off?.uncached, 5)
    assert.equal(usage?.opencsg['glm-5.1'].peak, undefined)
    assert.equal(scopedUsageOf(row, { scope: OPEN, day: '2026-09-21' }), null)
  })
})

describe('modelRankOf', () => {
  test('ranks every model by its billed total, counting the sessions that used it', () => {
    const rows = [
      rowOf({ id: 'a', activity: activityOf({ '2026-09-20': cost({ peak: 100, off: 50 }) }) }),
      rowOf({ id: 'b', activity: activityOf({ '2026-09-19': cost({ peak: 30 }) }) }),
    ]
    const stats = modelRankOf(rows, { scope: OPEN, day: null }, null)
    assert.equal(stats.length, 1)
    assert.deepEqual(
      { provider: stats[0].provider, model: stats[0].model, total: stats[0].total, sessions: stats[0].sessions, active: stats[0].active },
      { provider: 'opencsg', model: 'glm-5.1', total: 180, sessions: 2, active: true },
    )
    assert.equal(stats[0].input, 180)
    assert.equal(stats[0].name, 'glm-5.1')
  })

  test('sorts by total, then by model id, names configured routes, and appends unused configured models at zero', () => {
    const rows = [
      rowOf({ activity: activityOf({ '2026-09-20': cost({ peak: 10 }) }) }),
      rowOf({ activity: activityOf({ '2026-09-20': { opencsg: { 'glm-5.0': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } } } }) }),
    ]
    const stats = modelRankOf(rows, { scope: OPEN, day: null }, CATALOG)
    assert.deepEqual(stats.map(s => [s.model, s.total]), [['glm-5.1', 10], ['glm-5.0', 5], ['glm-5.2', 0]])
    assert.equal(stats[0].name, 'GLM-5.1')
    assert.equal(stats[0].providerName, 'OpenCSG')
    assert.equal(stats[1].active, false, 'usage outside the configured catalog is retired')
    assert.deepEqual(
      { sessions: stats[2].sessions, active: stats[2].active, name: stats[2].name, providerName: stats[2].providerName },
      { sessions: 0, active: true, name: 'GLM-5.2', providerName: 'OpenCSG' },
      'an unused configured model joins the ranking at zero',
    )
  })

  test('a failing provider is unknown rather than retired, and a missing catalog never retires a route', () => {
    const rows = [rowOf({ activity: activityOf({ '2026-09-20': cost({ peak: 10 }) }) })]
    const unknown = indexOf([{ provider: 'other', model: 'x', name: 'X' }], ['opencsg'])
    assert.deepEqual(modelRankOf(rows, { scope: OPEN, day: null }, unknown).map(s => [s.model, s.active]), [['glm-5.1', true], ['x', true]])
    assert.equal(modelRankOf(rows, { scope: OPEN, day: null }, unknown)[1].providerName, 'other', 'an unlisted route keeps its id')
    assert.deepEqual(modelRankOf(rows, { scope: OPEN, day: null }, null).map(s => s.active), [true])
  })

  test('a day pick narrows every model total to that day', () => {
    const rows = [rowOf({ activity: activityOf({
      '2026-09-19': cost({ peak: 9 }),
      '2026-09-20': cost({ peak: 2 }),
    }) })]
    assert.equal(modelRankOf(rows, { scope: OPEN, day: '2026-09-20' }, null)[0].total, 2)
    assert.equal(modelRankOf(rows, { scope: OPEN, day: null }, null)[0].total, 11)
  })

  test('the same model id under two providers sorts stably when their totals tie', () => {
    const usage: SessionCostUsage = {
      p1: { m: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } },
      p2: { m: { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } } },
    }
    const stats = modelRankOf([rowOf({ activity: activityOf({ '2026-09-20': usage }) })], { scope: OPEN, day: null }, null)
    assert.deepEqual(stats.map(s => [s.provider, s.providerName, s.model, s.total]), [['p1', 'p1', 'm', 5], ['p2', 'p2', 'm', 5]])
  })

  test('models with tied totals sort by id whichever direction the comparator sees them', () => {
    const usage: SessionCostUsage = {
      opencsg: {
        'glm-5.2': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } },
        'glm-5.1': { peak: { uncached: 5, cacheRead: 0, cacheWrite: 0, output: 0 } },
      },
    }
    const stats = modelRankOf([rowOf({ activity: activityOf({ '2026-09-20': usage }) })], { scope: OPEN, day: null }, null)
    assert.deepEqual(stats.map(s => s.model), ['glm-5.1', 'glm-5.2'])
  })
})

describe('catalogIndexOf', () => {
  test('reads a bare catalog, a RemoteResult envelope, and no catalog at all', () => {
    const bare = { groups: [{ id: 'opencsg', name: 'OpenCSG', models: [{ id: 'glm-5.1', name: 'GLM-5.1' }] }] }
    const parsed = catalogIndexOf(bare)
    assert.deepEqual(parsed?.models, [{ provider: 'opencsg', model: 'glm-5.1', name: 'GLM-5.1' }])
    assert.deepEqual([...(parsed?.providerNames ?? [])], [['opencsg', 'OpenCSG']])
    assert.deepEqual(catalogIndexOf({ ok: true, value: bare })?.models, parsed?.models)
    assert.equal(catalogIndexOf(null), null)
    assert.equal(catalogIndexOf({ value: 3 }), null)
    assert.equal(catalogIndexOf('nope'), null)
  })

  test('skips nameless ids, id-less groups, and non-object entries, and collects the failed providers', () => {
    const value = {
      groups: [
        { models: [{ id: 'x' }] },
        { id: 'p', models: [{ id: '' }, { name: 'nameless' }, null, { id: 'ok', name: '' }] },
        { id: 'q', name: '', models: [{ id: 'm2' }] },
        null,
      ],
      failures: [{ id: 'down' }, { id: '' }, null, { id: 3 }],
    }
    const parsed = catalogIndexOf(value)
    assert.deepEqual(parsed?.models, [{ provider: 'p', model: 'ok', name: 'ok' }, { provider: 'q', model: 'm2', name: 'm2' }])
    assert.deepEqual([...(parsed?.providerNames ?? [])], [['p', 'p'], ['q', 'q']])
    assert.deepEqual([...(parsed?.failedProviders ?? [])], ['down'])
  })

  test('a catalog without a failures list trusts every listed provider', () => {
    const parsed = catalogIndexOf({ groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] })
    assert.deepEqual([...(parsed?.providerNames ?? [])], [['p', 'p']], 'a nameless group falls back to its id')
    assert.deepEqual([...(parsed?.failedProviders ?? [])], [])
  })
})

describe('the model catalog store', () => {
  test('loads through the injected loader on the first subscription and refreshes on demand', async () => {
    let calls = 0
    setModelCatalogLoader(async () => {
      calls += 1
      return { groups: [{ id: 'opencsg', models: [{ id: 'glm-5.1', name: 'GLM-5.1' }] }] }
    })
    let ticks = 0
    const off = subscribeModelCatalog(() => { ticks += 1 })
    const second = subscribeModelCatalog(() => { ticks += 1 })
    refreshModelCatalog()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(calls, 1, 'one load serves the subscription and the mount refresh')
    assert.equal(ticks, 2)
    assert.deepEqual(getModelCatalogSnap()?.models, [{ provider: 'opencsg', model: 'glm-5.1', name: 'GLM-5.1' }])
    refreshModelCatalog()
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(calls, 2)
    off()
    second()
  })

  test('a failing or absent loader leaves the snapshot empty', async () => {
    setModelCatalogLoader(async () => { throw new Error('offline') })
    const off = subscribeModelCatalog(() => {})
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(getModelCatalogSnap(), null)
    off()
    setModelCatalogLoader(null)
    refreshModelCatalog()
    assert.equal(getModelCatalogSnap(), null)
  })

  test('a loader injected after the panel subscribed still loads without another mount', async () => {
    const off = subscribeModelCatalog(() => {})
    await Promise.resolve()
    assert.equal(getModelCatalogSnap(), null)
    setModelCatalogLoader(async () => ({ groups: [{ id: 'p', models: [{ id: 'm', name: 'M' }] }] }))
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(getModelCatalogSnap()?.models, [{ provider: 'p', model: 'm', name: 'M' }])
    off()
  })

  test('watching binds the remote face the client exposes; a missing face leaves the store unloaded', async () => {
    const disposers: (() => void)[] = []
    const ctx = {
      inject: (_names: string[], callback: (raw: unknown) => unknown) => {
        const dispose = callback({ remote: { session: { modelCatalog: async () => ({ ok: true, value: { groups: [{ id: 'p', models: [{ id: 'm' }] }] } }) } } })
        if (typeof dispose === 'function') disposers.push(dispose as () => void)
        return dispose
      },
    } as unknown as ClientCtx
    watchModelCatalog(ctx)
    const off = subscribeModelCatalog(() => {})
    await Promise.resolve()
    await Promise.resolve()
    assert.deepEqual(getModelCatalogSnap()?.models, [{ provider: 'p', model: 'm', name: 'm' }])
    off()
    for (const dispose of disposers) dispose()
    assert.equal(getModelCatalogSnap(), null)

    resetModelCatalog()
    const bare = {
      inject: (_names: string[], callback: (raw: unknown) => unknown) => {
        callback({ remote: {} })
        return () => {}
      },
    } as unknown as ClientCtx
    watchModelCatalog(bare)
    const none = subscribeModelCatalog(() => {})
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(getModelCatalogSnap(), null)
    none()
  })
})
