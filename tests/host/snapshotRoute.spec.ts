import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { watchSnapshotRoute, SNAPSHOT_IDS_MAX, SNAPSHOT_ROUTE } from '../../src/host/snapshotRoute'
import type {} from '../../src/shared/types'

const plugin = { name, inject, apply } as never
const noConfig = {} as never

interface RouteBox {
  fetch?: (request: Request) => Promise<Response>
}

async function bootWithRoutes(): Promise<{
  ctx: Context
  routes: Map<string, RouteBox>
  listed: { header: unknown }[]
  cacheMode: { throws: boolean; empty: boolean; requested: string[]; values?: Record<string, unknown> }
  createSession: () => Session
}> {
  const ctx = new Context()
  const routes = new Map<string, RouteBox>()
  ctx.provide('connection', {
    fetch: {
      register: (r: never) => {
        const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
        routes.set(route.path, route)
        return () => {}
      },
    },
  })
  const listed: { header: unknown }[] = []
  ctx.provide('sessionQuery', {
    listSessions: () => Promise.resolve(listed),
  })
  const cacheMode: { throws: boolean; empty: boolean; requested: string[]; values?: Record<string, unknown> } = { throws: false, empty: false, requested: [] }
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: (header: unknown, keys: unknown) => {
      if (cacheMode.throws) throw new Error('cache read failed')
      assert.ok((keys as Set<string>).has('contextActivity'))
      assert.ok((keys as Set<string>).has('contextTimeline'))
      if (cacheMode.empty) return { values: {} }
      if (cacheMode.values !== undefined) return { asOfSeq: 5, values: cacheMode.values }
      return { asOfSeq: 5, values: { contextActivity: { days: {} } } }
    },
  })
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(plugin, noConfig)
  return {
    ctx,
    routes,
    listed,
    cacheMode,
    createSession: () => {
      const session = ctx.sessions.create()
      listed.push({ header: session.header })
      return session
    },
  }
}

function appendRealEnvelopes(session: Session): void {
  session.append('request/header', {
    header: {
      config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
    },
    reason: 'initial',
  })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 0,
    message: { content: [{ type: 'text', text: 'hello' }] },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as never, { surfaceOp: 'append' })
}

async function callRoute(routes: Map<string, RouteBox>, body: unknown): Promise<{ ok: boolean; value?: Record<string, Record<string, unknown>>; error?: { code: string; message?: string }; revision?: string; unchanged?: boolean }> {
  const route = routes.get(SNAPSHOT_ROUTE)
  assert.ok(route !== undefined && route.fetch !== undefined, 'the snapshot route registered')
  const response = await route.fetch(new Request(`http://dsh.test${SNAPSHOT_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }))
  return await response.json() as never
}

describe('dsh-context snapshot route', () => {
test('without the connection face the route never registers, and the watcher disposes cleanly', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {} as never)
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve([]) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    watchSnapshotRoute(ctx)
    await ctx.plugin(plugin, noConfig)
    await new Promise(resolve => setTimeout(resolve, 1))
    assert.equal(routes.has(SNAPSHOT_ROUTE), false, 'no registrar, no route')
  })
  test('serves a live session from the registry, honors the ids filter, and drops unknown ids', async () => {
    const { routes, createSession } = await bootWithRoutes()
    const session = createSession()
    appendRealEnvelopes(session)

    const all = await callRoute(routes, {})
    assert.equal(all.ok, true)
    const row = all.value?.[session.header.id]
    assert.ok(row !== undefined, 'the live session serves its summary-excluded values on demand')
    const compact = row.contextTimeline as Record<string, unknown>
    assert.ok(compact !== undefined, 'the timeline digest rides the snapshot route')
    assert.ok(compact.current !== undefined, 'the digest carries the composition')
    assert.deepEqual(Object.keys(compact.counts as Record<string, unknown>).sort(), ['steps', 'turns'])
    assert.equal('last' in compact, false, 'the digest drops the pressure cursor')
    assert.equal('nodes' in compact, false, 'the digest never carries the surface')
    assert.equal('requests' in compact, false, 'the digest never carries the request window')
    assert.equal('events' in compact, false, 'the digest never carries the event window')
    assert.ok(row.contextActivity !== undefined, 'the activity ledger rides the snapshot route')

    const filtered = await callRoute(routes, { ids: [session.header.id, 'missing-session'] })
    assert.deepEqual(Object.keys(filtered.value ?? {}), [session.header.id], 'the ids filter drops unknown sessions')
  })

  test('a non-live session serves from the cache face, and a failed row is skipped whole', async () => {
    const { routes, listed, cacheMode } = await bootWithRoutes()
    listed.push({ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })

    const ok = await callRoute(routes, {})
    assert.equal(ok.ok, true)
    assert.deepEqual(ok.value?.['cold-session-id'], { contextActivity: { days: {} } }, 'the cold row serves its cached values only')

    cacheMode.throws = true
    const degraded = await callRoute(routes, {})
    assert.equal(degraded.ok, true, 'a failed cache row skips whole and the route still serves')
    assert.equal(degraded.value?.['cold-session-id'], undefined)
  })

  test('compacts the served timeline to the overview fields and drops hostile members', async () => {
    const h = await bootWithRoutes()
    h.listed.push({ header: { id: 'digest-1', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } })
    h.cacheMode.values = {
      contextTimeline: {
        ok: 'yes',
        current: { system: 1, total: 2 },
        contextWindow: 128000,
        counts: { turns: 3, steps: 'bad', injects: 9 },
        cost: { p: { m: { peak: { uncached: 1, cacheRead: 2, cacheWrite: 0, output: 3 } } } },
        timing: { wallMs: 10, ttftMs: 'bad', tools: { bash: { calls: 1, ms: 2 } }, calls: 4 },
        lastUser: 'hi',
        systems: [{ seq: 1, time: 1, tokens: 1 }],
        generatedReasoning: 3,
        generatedAnswerTokens: 4,
        generatedCallTokens: 5,
        costRead: { usd: 1.5, ready: true },
      },
      contextActivity: { days: { '2026-11-01': { tokens: 5, requests: 1 } } },
    }
    const read = await callRoute(h.routes, { ids: ['digest-1'] })
    const row = read.value?.['digest-1'] as Record<string, unknown>
    const digest = row.contextTimeline as Record<string, unknown>
    assert.equal(digest.ok, 'yes')
    assert.deepEqual(digest.current, { system: 1, total: 2 })
    assert.equal(digest.contextWindow, 128000)
    assert.deepEqual(digest.counts, { turns: 3 })
    assert.equal('injects' in (digest.counts as object), false)
    assert.equal('systems' in digest, false)
    assert.deepEqual(digest.timing, { tools: {}, wallMs: 10, calls: 4 })
    assert.equal(digest.lastUser, 'hi')
    assert.equal(digest.generatedReasoning, 3)
    assert.equal(digest.generatedAnswerTokens, 4)
    assert.equal(digest.generatedCallTokens, 5)
    assert.deepEqual(digest.costRead, { usd: 1.5, ready: true })
    assert.deepEqual(row.contextActivity, { days: { '2026-11-01': { tokens: 5, requests: 1 } } })
    const bare = { ...h.cacheMode }
    bare.values = { contextTimeline: {} }
    h.cacheMode.values = bare.values
    const empty = await callRoute(h.routes, { ids: ['digest-1'] })
    const emptyRow = empty.value?.['digest-1'] as Record<string, unknown>
    assert.deepEqual(emptyRow.contextTimeline, { ok: true })
    h.cacheMode.values = { contextTimeline: { timing: { bogus: 1 } } }
    const noTiming = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.deepEqual((noTiming.value?.['digest-1'] as Record<string, unknown>).contextTimeline, { ok: true }, 'a timing without figures is omitted')
    h.cacheMode.values = { contextTimeline: { counts: { injects: 4 } } }
    const noCounts = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.deepEqual((noCounts.value?.['digest-1'] as Record<string, unknown>).contextTimeline, { ok: true })
    h.cacheMode.values = { contextTimeline: 'nope' }
    const dropped = await callRoute(h.routes, { ids: ['digest-1'] })
    assert.equal(dropped.value?.['digest-1'], undefined, 'a non-object timeline yields no row')
  })

  test('a listing failure fails with the internal code', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    ctx.provide('sessionQuery', { listSessions: () => Promise.reject(new Error('scan failed')) })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    await new Promise(resolve => setTimeout(resolve, 1))
    const result = await callRoute(routes, {})
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'gateway/internal')
  })

  test('empty ids mean all sessions; a hostile listing result or row reads as absence; non-Error failures stringify', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    let listing: unknown = [{ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }]
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(listing) })
    let cacheResult: unknown = { asOfSeq: 5, values: { contextActivity: { days: {} } } }
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => cacheResult })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)

    const all = await callRoute(routes, { ids: [] })
    assert.deepEqual(Object.keys(all.value ?? {}), ['cold-session-id'], 'empty ids mean all sessions')
    const typed = await callRoute(routes, { ids: [7, '', 'cold-session-id'] })
    assert.deepEqual(Object.keys(typed.value ?? {}), ['cold-session-id'], 'non-string ids drop')

    cacheResult = undefined
    const absent = await callRoute(routes, {})
    assert.deepEqual(absent.value?.['cold-session-id'], undefined, 'an unreadable cache row reads as absence')

    cacheResult = 42
    const junk = await callRoute(routes, {})
    assert.deepEqual(junk.value?.['cold-session-id'], undefined, 'a junk cache block reads as absence')

    listing = [null, { header: null }, { nope: true }, ...listing as unknown as { header: unknown }[]]
    cacheResult = { asOfSeq: 5, values: { contextActivity: { days: {} } } }
    const hostileRows = await callRoute(routes, {})
    assert.equal(hostileRows.ok, true, 'null entries and headerless rows skip whole')
    assert.deepEqual(Object.keys(hostileRows.value ?? {}), ['cold-session-id'])

    listing = 'not-a-listing'
    const flat = await callRoute(routes, {})
    assert.deepEqual(flat.value, {}, 'a non-array listing reads as an empty block')

    listing = Promise.reject('plain-string failure')
    const failed = await callRoute(routes, {})
    assert.equal(failed.ok, false)
    assert.equal(failed.error?.code, 'gateway/internal')
    assert.ok((failed.error?.message ?? '').includes('plain-string failure'), 'non-Error failures stringify')

    listing = [{ header: { id: 'cold-session-id', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } }]
    const nullBody = await callRoute(routes, null)
    assert.equal(nullBody.ok, true, 'a JSON-null body reads as an unfiltered listing')

    cacheResult = { asOfSeq: 1, values: {} }
    const emptyValues = await callRoute(routes, 42)
    assert.deepEqual(emptyValues.value, {}, 'a non-object body reads as an unfiltered listing; empty served values drop the row')
  })

  test('a matching revision skips the rows and replies tiny; another ids set still gets its rows', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    const listed = [
      { header: { id: 'a', version: 4, createdAt: 1, cwd: '/tmp', isSeeded: false } },
      { header: { id: 'b', version: 4, createdAt: 2, cwd: '/tmp', isSeeded: false } },
    ]
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve(listed) })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionProjections', { snapshot: () => undefined })
    ctx.provide('sessionProjectionCache', {
      cachedSnapshot: (header: { id: string }) => ({ asOfSeq: 5, values: { contextTimeline: { ok: true, model: header.id } } }),
    })
    let version = 0
    const backfill = Object.assign(() => {}, {
      coverage: () => ({ complete: true, remaining: 0, failed: 0, running: false, total: 0, covered: 0, unsupported: 0 }),
      version: () => version,
      foldedSince: (marker: number) => ({ version: marker, ids: [] }),
    })
    watchSnapshotRoute(ctx, backfill)
    await new Promise(resolve => setTimeout(resolve, 2))
    const first = await callRoute(routes, {}) as { ok: boolean; value: Record<string, unknown>; revision?: string }
    assert.ok(typeof first.revision === 'string', 'a full reply carries its revision')
    const revision = first.revision as string
    const unchanged = await callRoute(routes, { revision }) as { ok: boolean; value: unknown; revision?: string; unchanged?: boolean }
    assert.deepEqual(unchanged, { ok: true, value: {}, revision, unchanged: true })
    const subset = await callRoute(routes, { revision, ids: ['a'] }) as { value: Record<string, unknown>; revision?: string }
    assert.deepEqual(Object.keys(subset.value), ['a'], 'a never-served ids set gets its rows even at the current revision')
    const repeated = await callRoute(routes, { revision, ids: ['a'] }) as { value: unknown; unchanged?: boolean }
    assert.deepEqual(repeated, { ok: true, value: {}, revision, unchanged: true })
    version = 1
    const moved = await callRoute(routes, { revision, ids: ['a'] }) as { value: Record<string, unknown>; revision?: string; unchanged?: boolean }
    assert.equal(moved.unchanged, undefined, 'a backfill write invalidates the revision')
    assert.notEqual(moved.revision, revision)
    assert.deepEqual(Object.keys(moved.value), ['a'])
  })

  test('without a backfill handle the route still carries a revision and skips on a match', async () => {
    const ctx = new Context()
    const routes = new Map<string, RouteBox>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    ctx.provide('sessionQuery', { listSessions: () => Promise.resolve([]) })
    ctx.provide('sessions', { get: () => undefined })
    ctx.provide('sessionProjections', { snapshot: () => undefined })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    watchSnapshotRoute(ctx)
    await new Promise(resolve => setTimeout(resolve, 2))
    const first = await callRoute(routes, {}) as { revision?: string }
    assert.ok(typeof first.revision === 'string')
    const second = await callRoute(routes, { revision: first.revision }) as { unchanged?: boolean }
    assert.equal(second.unchanged, true)
  })

  test('a malformed body fails with the bad-request code', async () => {
    const { routes } = await bootWithRoutes()
    const result = await callRoute(routes, 'not json')
    assert.equal(result.ok, false)
    assert.equal(result.error?.code, 'dsh-context/bad-request')
  })
})



describe('snapshot ids cap', () => {
  test('an oversized ids list is refused rather than silently truncated', async () => {
    const h = await bootWithRoutes()
    const sessions: Session[] = []
    for (let i = 0; i < SNAPSHOT_IDS_MAX; i++) {
      const session = h.createSession()
      appendRealEnvelopes(session)
      sessions.push(session)
    }
    const exact = await callRoute(h.routes, { ids: sessions.map(session => session.header.id) })
    assert.equal(exact.ok, true, 'exactly the cap still serves')
    const over = await callRoute(h.routes, { ids: [...sessions.map(session => session.header.id), 'one-too-many'] })
    assert.equal(over.ok, false)
    assert.equal(over.error?.code, 'dsh-context/bad-request')
  })
})
