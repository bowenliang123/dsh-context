import assert from 'node:assert/strict'
import { test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SNAPSHOT_ROUTE, watchSnapshotRoute } from '../../src/host/snapshotRoute'
import type { OverviewCache } from '../../src/host/overviewCache'
import type { HostSession } from '../../src/host/overviewCorpus'
import { materializedCache } from './helpers/materialized'

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

function sessionOf(): HostSession {
  return {
    id: 'cold-a', title: 'Cached', updatedAt: 1, blank: false, signature: '',
    timeline: null, activity: { days: {} },
    materialization: {
      asOfSeq: 9,
      facts: { id: 'cold-a', createdAt: 1 },
      signature: '',
      values: {
        contextTimeline: {
          ok: true,
          current: { system: 1, total: 2 },
          counts: { turns: 3, steps: 1 },
        },
        contextActivity: { days: { '2026-11-01': { tokens: 5, requests: 1 } } },
      },
    },
  }
}

function boot(cache: OverviewCache, cost?: unknown): Map<string, RouteBox> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  ctx.provide('connection', {
    fetch: {
      register: (route: { path: string; fetch?: (request: Request) => Promise<Response> }) => {
        routes.set(route.path, route)
        return () => {}
      },
    },
  })
  ctx.provide('sessionQuery', {
    listSessions: async () => [{ header: { id: 'cold-a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }],
  })
  ctx.provide('sessions', { get: () => undefined })
  ctx.provide('sessionProjections', { snapshot: () => undefined })
  ctx.provide('sessionProjectionCache', { cachedSnapshot: () => { throw new Error('projection cache should not be read') } })
  watchSnapshotRoute(ctx, undefined, cache, cost as never)
  return routes
}

async function call(routes: Map<string, RouteBox>, revision?: string) {
  for (let index = 0; index < 300 && !routes.has(SNAPSHOT_ROUTE); index++) await new Promise(resolve => setTimeout(resolve, 1))
  const route = routes.get(SNAPSHOT_ROUTE)
  assert.ok(route?.fetch !== undefined)
  const response = await route.fetch(new Request(`http://dsh.test${SNAPSHOT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ids: ['cold-a'], ...(revision === undefined ? {} : { revision }) }),
  }))
  return await response.json() as { value: Record<string, Record<string, unknown>>; revision?: string; unchanged?: boolean }
}

test('a materialized cold row serves its compact snapshot without the projection cache', async () => {
  const read = await call(boot(materializedCache(sessionOf())))
  const timeline = read.value['cold-a'].contextTimeline as Record<string, unknown>
  assert.deepEqual(timeline.current, { system: 1, total: 2 })
  assert.deepEqual(timeline.counts, { turns: 3, steps: 1 })
  assert.deepEqual(read.value['cold-a'].contextActivity, { days: { '2026-11-01': { tokens: 5, requests: 1 } } })
})

test('a stale materialized identity joins the revision and suppresses the projection fallback', async () => {
  const cache = materializedCache(sessionOf())
  cache.load = async () => ({
    sessions: new Map(),
    identities: new Map([['cold-a', { path: '/logs/cold-a', sizeBytes: 10, mtimeMs: 2 }]]),
    rebuild: new Set(['cold-a']),
  })
  const read = await call(boot(cache))
  assert.deepEqual(read.value, {})
  assert.equal(typeof read.revision, 'string')
})

test('a materialization without a timeline still serves its activity digest', async () => {
  const session = sessionOf()
  session.materialization!.values.contextTimeline = null
  const read = await call(boot(materializedCache(session)))
  assert.equal(read.value['cold-a'].contextTimeline, undefined)
  assert.ok(read.value['cold-a'].contextActivity !== undefined)
})

test('a price-book change invalidates a held materialized snapshot revision', async () => {
  let ready = false
  let version = 0
  const cost = {
    ready: () => ready,
    version: () => version,
    read: () => ({ usd: ready ? 1 : null, ready }),
    usd: () => (ready ? 1 : null),
    complete: () => ready,
  }
  const routes = boot(materializedCache(sessionOf()), cost)
  const first = await call(routes)
  ready = true
  version++
  const next = await call(routes, first.revision)
  assert.equal(next.unchanged, undefined)
  assert.ok(next.value['cold-a'] !== undefined)
  delete (cost as { version?: () => number }).version
  const withoutPriceVersion = await call(routes, next.revision)
  assert.equal(withoutPriceVersion.unchanged, undefined)
})
