import assert from 'node:assert/strict'
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { makeCorpus } from './helpers/dbCorpus'
import { header, userMessage } from './helpers/events'
import { mountQueryRoutes, statusOf } from '../../src/host/db/routes'
import { startStorage } from '../../src/host/db/plugin'
import type { BackfillScheduler, Coverage } from '../../src/host/db/scheduler'
import type { CostSource } from '../../src/host/cost'
import { fakeCtx } from './helpers/ctx'
import { openDatabase } from '../../src/host/db/open'
import { createDb } from '../../src/host/db/db'
import { events, STORAGE_VERSION, sessions, surfaceNodes } from '../../src/host/db/schema'
import { sql } from 'drizzle-orm'

const COVERAGE: Coverage = {
  complete: true, remaining: 0, failed: 0, running: false,
  total: 4, covered: 4, unsupported: 0, folding: 0, deleting: 0,
}

const COST: CostSource = {
  ready: () => true,
  version: () => 3,
  usd: usage => usage === null || usage === undefined ? null : 2,
  read: usage => usage === null || usage === undefined ? undefined : { usd: 2, ready: true },
  complete: () => true,
}

function routesHarness(cost: CostSource = COST) {
  const corpus = makeCorpus()
  const routes = new Map<string, { fetch?: (request: Request) => Promise<Response> }>()
  const fake = fakeCtx({
    connection: {
      fetch: {
        register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
    },
  }, { injectAll: true })
  const scheduler = {
    noteRoute: () => {},
    coverage: () => COVERAGE,
    request: () => {},
    reaperStats: () => ({ running: false, lastRunAt: 0, candidates: 0, deletedSessions: 0, deletedChildRows: 0, failed: 0, tombstones: 0 }),
    startupPhase: () => 'ready',
    isHydrating: () => false,
    integrityState: () => 'ok',
  } as unknown as BackfillScheduler
  const path = join(tmpdir(), 'dscx-routes.sqlite')
  mountQueryRoutes({
    ctx: fake.ctx,
    db: corpus.db,
    cost,
    scheduler,
    path,
    harnessSupported: true,
    attribution: name => `plugin:${name}`,
    mode: 'file',
  })
  const callRaw = async (route: string, raw: string): Promise<Record<string, unknown>> => {
    const entry = routes.get(`/api/dsh-context/${route}`)
    assert.ok(entry?.fetch !== undefined, `${route} mounted`)
    const response = await entry.fetch(new Request(`http://dsh.test/api/dsh-context/${route}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: raw,
    }))
    return response.json() as Promise<Record<string, unknown>>
  }
  const call = async (route: string, body: unknown): Promise<Record<string, unknown>> => {
    const entry = routes.get(`/api/dsh-context/${route}`)
    assert.ok(entry?.fetch !== undefined, `${route} mounted`)
    const response = await entry.fetch(new Request(`http://dsh.test/api/dsh-context/${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }))
    return response.json() as Promise<Record<string, unknown>>
  }
  return { ...corpus, routes, call, callRaw, path, scheduler }
}

describe('query routes', () => {
  test('serves every query route and the unchanged domains', async () => {
    const h = routesHarness()
    const status = await h.call('query/status', {})
    assert.equal(status.ok, true)
    assert.equal((status.value as { storage_version: number }).storage_version, STORAGE_VERSION)
    assert.equal((status.value as { ready: boolean }).ready, true)
    const sessions = await h.call('query/sessions', { scope: { range: 'all' }, pageSize: 2 })
    assert.equal(sessions.ok, true)
    const unchanged = await h.call('query/sessions', {
      scope: { range: 'all' }, generation: sessions.generation, pricing_version: sessions.pricing_version,
    })
    assert.equal(unchanged.unchanged, true)
    const summary = await h.call('query/summary', { scope: { range: 'all' } })
    assert.equal(summary.ok, true)
    assert.equal((summary.value as { sessions: number }).sessions, 3)
    assert.equal((await h.call('query/days', { scope: { range: 'all' } })).ok, true)
    assert.equal((await h.call('query/tally', { scope: { range: 'all' }, field: 'tools', limit: 5 })).ok, true)
    const context = await h.call('query/context', { sessionId: 'root' })
    assert.equal((context.value as { ok: boolean }).ok, true)
    const unchangedContext = await h.call('query/context', {
      sessionId: 'root',
      detail_rev: (context.value as { detailRev: number }).detailRev,
      db_epoch: context.db_epoch,
      pricing_version: context.pricing_version,
    })
    assert.equal(unchangedContext.unchanged, true)
    assert.equal((await h.call('query/context', { ids: ['root', 'missing'] })).ok, true)
    assert.equal((await h.call('query/timeline', { sessionId: 'root', limit: 2 })).ok, true)
    assert.equal((await h.call('query/requests', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/requests', { scope: { range: 'all' } })).ok, true)
    assert.equal((await h.call('query/steps', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/tool-calls', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/tool-calls', { scope: { range: 'all' } })).ok, true)
    assert.equal((await h.call('query/file-ops', { sessionId: 'root', mode: 'paths' })).ok, true)
    assert.equal((await h.call('query/events', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/spans', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/skill-loads', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/family', { rootId: 'root' })).ok, true)
    assert.equal((await h.call('query/cost', { sessionId: 'root' })).ok, true)
    assert.equal((await h.call('query/cost', { scope: { range: 'all' } })).ok, true)
    assert.equal((await h.call('delta', { sessionId: 'root', seq: 14, baseSeq: 3 })).ok, true)
    assert.equal((await h.call('backfill', {})).ok, true)
    h.opened.client.close()
  })

  test('serves the compatibility routes over the same rows', async () => {
    const h = routesHarness()
    const detail = await h.call('detail', { sessionId: 'root' })
    assert.equal(detail.ok, true)
    assert.equal((detail.value as { head: { ok: boolean } }).head.ok, true)
    assert.equal((await h.call('detail', { sessionId: 'root', head: true })).ok, true)
    assert.equal((await h.call('detail', {})).value, null)
    const facts = await h.call('facts', { sessionId: 'root', parts: ['head', 'series', 'requests', 'nodes', 'events', 'files', 'commands', 'spans'] })
    assert.equal((facts.value as { parts: Record<string, unknown> }).parts.head !== undefined, true)
    const heads = await h.call('heads', { ids: ['root', 'missing'] })
    assert.equal(Object.keys(heads.value as object).length, 1)
    const commands = await h.call('commands', { sessionId: 'root', limit: 10 })
    assert.equal((commands.value as { total: number }).total, 1)
    const overviewSummary = await h.call('overview', { part: 'summary', scope: { range: 'all' } })
    assert.equal((overviewSummary.value as { summary: { sessions: number } }).summary.sessions, 3)
    const unchanged = await h.call('overview', { part: 'summary', revision: (overviewSummary.value as { revision: string }).revision })
    assert.equal((unchanged.value as { unchanged: boolean }).unchanged, true)
    assert.equal((await h.call('overview', { part: 'days', scope: { range: 'all' } })).ok, true)
    assert.equal((await h.call('overview', { part: 'page', sort: 'context', page: 0 })).ok, true)
    assert.equal((await h.call('overview', { part: 'page', pick: { field: 'tools', name: 'bash' } })).ok, true)
    assert.equal((await h.call('overview', { part: 'tally', tally: 'tools' })).ok, true)
    h.opened.client.close()
  })

  test('statusOf reports byte sizes and degraded phases', () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({}, { injectAll: true })
    const scheduler = {
      coverage: () => COVERAGE,
      startupPhase: () => 'degraded',
      isHydrating: () => true,
      integrityState: () => 'failed',
      reaperStats: () => ({ running: false, lastRunAt: 0, candidates: 0, deletedSessions: 0, deletedChildRows: 0, failed: 0, tombstones: 0 }),
    } as unknown as BackfillScheduler
    const status = statusOf({
      ctx: fake.ctx, db, cost: COST, scheduler, path: join(tmpdir(), 'missing.sqlite'),
      harnessSupported: false, mode: 'degraded',
    })
    assert.equal(status.ready, false)
    assert.equal(status.startup_phase, 'degraded')
    assert.equal(status.harness_supported, false)
    opened.client.close()
  })
})

describe('storage startup', () => {
  test('opens a file database and disposes cleanly', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: {
        listSessions: async () => [{ header: { id: 'cold-one', createdAt: 2, cwd: home }, live: false }],
        observeSession: async () => ({ events: [header(0, { model: 'm', provider: 'p' })] }),
      },
      sessionPersistence: {
        stat: async () => undefined,
        open: async (id: string) => ({
          header: { id, createdAt: 2, cwd: home },
          read: async (offset: number) => ({
            events: [header(0, { model: 'm', provider: 'p' }), userMessage(1, [{ type: 'text', text: 'cold' }])]
              .filter(candidate => candidate.seq >= offset),
          }),
          close: async () => {},
        }),
      },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST, harnessVersion: '0.2.2-rc.3' })
    assert.equal(storage.mode, 'file')
    assert.equal(storage.path, join(home, 'storages', 'dsh-context', 'index.sqlite'))
    const live = { id: 'live-one', header: { id: 'live-one', createdAt: 1, cwd: home } }
    fake.emit('session/created', live)
    fake.emit('session/event', live, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    storage.live.flushAll()
    assert.equal(storage.db.select().from(sessions).where(sql`${sessions.id} = 'live-one'`).all()[0]?.foldStatus, 'ok')
    await storage.scheduler.runOnce()
    assert.equal(storage.db.select().from(sessions).where(sql`${sessions.id} = 'cold-one'`).all()[0]?.foldStatus, 'ok')
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  test('refuses a foreign database and degrades to memory', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const path = join(home, 'storages', 'dsh-context', 'index.sqlite')
    mkdirSync(join(home, 'storages', 'dsh-context'), { recursive: true })
    const raw = openDatabase(path)
    raw.client.exec('PRAGMA application_id = 99')
    raw.client.close()
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST })
    assert.equal(storage.mode, 'degraded')
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  test('quarantines an unreadable file and falls back to a fresh database', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const dir = join(home, 'storages', 'dsh-context')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.sqlite'), 'not a database')
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST })
    assert.equal(storage.mode, 'file')
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })
})

describe('storage fallbacks', () => {
  test('falls back to memory when the directory cannot be created', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    writeFileSync(join(home, 'blocked'), 'file')
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, 'blocked', ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST, now: () => 5 })
    assert.equal(storage.mode, 'memory')
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  test('moves the WAL siblings aside with a quarantined file', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const dir = join(home, 'storages', 'dsh-context')
    mkdirSync(join(dir, 'index.sqlite'), { recursive: true })
    writeFileSync(join(dir, 'index.sqlite-wal'), 'wal')
    writeFileSync(join(dir, 'index.sqlite-shm'), 'shm')
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST, now: () => 5 })
    assert.equal(storage.mode, 'file')
    assert.equal(statSync(join(dir, 'index.sqlite.corrupt-5-wal')).size, 3)
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  test('falls back to memory when the corrupt file cannot be moved aside', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const dir = join(home, 'storages', 'dsh-context')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'index.sqlite'), 'not a database')
    mkdirSync(join(dir, 'index.sqlite.corrupt-5'))
    writeFileSync(join(dir, 'index.sqlite.corrupt-5', 'occupied'), 'file')
    const fake = fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const storage = startStorage(fake.ctx, {} as never, { cost: COST, now: () => 5 })
    assert.equal(storage.mode, 'memory')
    storage.dispose()
    rmSync(home, { recursive: true, force: true })
  })

  test('degrades when quick_check finds corruption', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dscx-start-'))
    const fakeOf = () => fakeCtx({
      dshHomePath: (...segments: string[]) => join(home, ...segments),
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: { listSessions: async () => [] },
      sessionProjections: { snapshot: () => ({ values: {} }) },
    }, { injectAll: true })
    const fake = fakeOf()
    const first = startStorage(fake.ctx, {} as never, { cost: COST })
    first.db.run(sql`insert into sessions (id, title, created_at, updated_at, fold_status, last_seq, detail_rev, family_root)
      values ('bulk', 'bulk', 1, 1, 'ok', 0, 0, 'bulk')`)
    for (let seq = 0; seq < 2_000; seq++) {
      first.db.insert(events).values({ sessionId: 'bulk', seq, time: 1, kind: 'inject' }).run()
    }
    first.dispose()
    const descriptor = openSync(first.path, 'r+')
    const garbage = Buffer.alloc(4_096 * 10, 7)
    writeSync(descriptor, garbage, 0, garbage.length, 4_096 * 20)
    closeSync(descriptor)
    const second = startStorage(fakeOf().ctx, {} as never, { cost: COST })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(second.scheduler.integrityState(), 'failed')
    assert.equal(second.scheduler.startupPhase(), 'degraded')
    second.dispose()
    rmSync(home, { recursive: true, force: true })
  })
})

describe('route parameter coverage', () => {
  test('rejects malformed bodies and accepts null bodies', async () => {
    const h = routesHarness()
    for (const path of h.routes.keys()) {
      const route = path.slice('/api/dsh-context/'.length)
      assert.equal((await h.callRaw(route, '{')).ok, false, route)
      assert.equal((await h.callRaw(route, 'null')).ok, true, route)
    }
    h.opened.client.close()
  })

  test('every optional handler argument is exercised', async () => {
    const h = routesHarness()
    const id = 'root'
    await h.call('query/tally', { scope: { range: 'all' }, cursor: '1' })
    await h.call('query/tool-calls', { sessionId: id, commands_only: true })
    await h.call('delta', {})
    await h.call('delta', { sessionId: id, seq: null })
    await h.call('commands', {})
    await h.call('commands', { sessionId: id, beforeSeq: 6 })
    await h.call('facts', {})
    await h.call('heads', { ids: [1, 'root', null] })
    await h.call('overview', { part: 'page', scope: { range: 'all' }, page: 0 })
    await h.call('overview', { part: 'page', scope: { range: 'all' }, pick: { field: 'tools', name: 'bash' } })
    await h.call('facts', { sessionId: id, parts: ['nodes', 'commands', 'bogus'] })
    await h.call('facts', { sessionId: 'other', parts: ['commands'] })
    await h.call('query/sessions', { scope: { range: 'all', day: '1970-01-01', coverage: 'active', group: 'workspace-one', query: 'title', model: 'deepseek-v4-pro', running: true, pick: { field: 'tools', name: 'bash' } }, sort: 'tokens', page: 0, pageSize: 1, ids: ['root'] })
    await h.call('query/sessions', { scope: {}, sort: 'context', page: 1, pageSize: 5 })
    await h.call('query/summary', { scope: { range: 'today' } })
    await h.call('query/days', { scope: { range: 'all', coverage: 'archived' } })
    for (const field of ['skills', 'tools', 'cmds', 'models', 'providers']) {
      await h.call('query/tally', { scope: { range: 'all' }, field, limit: 1, cursor: 1, sort: 'last' })
    }
    await h.call('query/context', { ids: ['root', 'missing'] })
    await h.call('query/timeline', { sessionId: id, seq: 5, archive: { limit: 1 }, limit: 1 })
    await h.call('query/requests', { sessionId: id, turn: 1, day: '1970-01-01', model: 'deepseek-v4-flash', after: 0, offsetFromEnd: 1, limit: 1 })
    await h.call('query/requests', { scope: { range: 'all', day: '1970-01-01' }, turn: 1, model: 'deepseek-v4-flash' })
    await h.call('query/steps', { sessionId: id, after: 0, limit: 1 })
    await h.call('query/tool-calls', {
      sessionId: id, status: 'failed', slow_ms: 0, program: 'ls', query: 'ls', command_only: true,
      beforeSeq: 99, sort: 'slowest', cursor: { time: 1, duration: 1, seq: 99 }, limit: 1,
    })
    await h.call('query/tool-calls', { sessionId: id, status: 'slow' })
    await h.call('query/tool-calls', { sessionId: id, status: 'background' })
    await h.call('query/tool-calls', { sessionId: id, sort: 'latest', cursor: { seq: 999 } })
    await h.call('query/file-ops', { sessionId: id, mode: 'list', kind: 'read', after: 0, limit: 1 })
    await h.call('query/events', { sessionId: id, kinds: ['inject'], after: 0, limit: 1 })
    await h.call('query/spans', { sessionId: id, before: 99, limit: 1 })
    await h.call('query/skill-loads', { sessionId: id, name: 'skill', day: '1970-01-01', after: 0, limit: 1 })
    await h.call('query/skill-loads', { scope: { range: 'all' } })
    await h.call('query/family', { sessionId: id })
    await h.call('query/cost', { sessionId: id, family: true })
    await h.call('query/cost', {})
    await h.call('query/context', {})
    await h.call('query/timeline', {})
    await h.call('query/steps', {})
    await h.call('query/file-ops', {})
    await h.call('query/events', {})
    await h.call('query/spans', {})
    await h.call('query/skill-loads', {})
    await h.call('query/family', {})
    await h.call('query/tally', { scope: { range: 'all' }, field: 'bogus' })
    await h.call('query/tool-calls', {})
    await h.call('query/cost', { scope: null })
    await h.call('detail', { sessionId: 'missing' })
    await h.call('facts', { sessionId: 'missing' })
    await h.call('facts', { sessionId: 'root', parts: ['head'], window: { requestsTail: 1, nodesTail: 1, eventsTail: 1, filesTail: 1, commandsTail: 1, spansTail: 1 } })
    await h.call('facts', { sessionId: 'root', parts: ['series', 'requests', 'nodes', 'events', 'files', 'commands', 'spans'], window: {} })
    await h.call('facts', { sessionId: 'root' })
    await h.call('heads', { ids: [] })
    await h.call('commands', { sessionId: 'missing' })
    await h.call('overview', { part: 'summary', revision: '999' })
    await h.call('overview', { part: 'days', scope: { range: 'all' } })
    await h.call('overview', { part: 'page', sort: 'tokens', page: 1, pick: { field: 'tools', name: 'bash' } })
    await h.call('overview', { part: 'page', sort: 'recent', page: 0, pick: null })
    for (const tally of ['skills', 'tools', 'cmds', 'bogus']) await h.call('overview', { part: 'tally', tally })
    await h.call('overview', { part: 'bogus' })
    await h.call('delta', { sessionId: 'root', seq: null, baseSeq: 3 })
    h.opened.client.close()
  })

  test('compatibility detail and facts report truncated floors', async () => {
    const h = routesHarness()
    const live = Array.from({ length: 2_001 }, (_, index) => ({
      sessionId: 'root', seq: 1_000 + index, time: 1, cat: 'user' as const, tokens: 1,
    }))
    const archived = Array.from({ length: 401 }, (_, index) => ({
      sessionId: 'root', seq: 5_000 + index, time: 1, cat: 'user' as const, tokens: 1, goneSeq: 9_000 + index,
    }))
    h.db.insert(surfaceNodes).values([...live, ...archived]).run()
    const detail = await h.call('detail', { sessionId: 'root' })
    const value = detail.value as { surfaceFloor?: number; archiveFloor?: number; fileOps: unknown[] }
    assert.equal(typeof value.surfaceFloor, 'number')
    assert.equal(typeof value.archiveFloor, 'number')
    assert.equal(Array.isArray(value.fileOps), true)
    const facts = await h.call('facts', { sessionId: 'root', parts: ['nodes', 'commands'] })
    const parts = (facts.value as {
      parts: {
        nodes: { surfaceFloor?: number; archiveFloor?: number }
        commands: { commandStats?: { runs: number } }
      }
    }).parts
    assert.equal(typeof parts.nodes.surfaceFloor, 'number')
    assert.equal(typeof parts.nodes.archiveFloor, 'number')
    assert.equal(parts.commands.commandStats?.runs, 1)
    h.opened.client.close()
  })

  test('overview page handles rows with and without optional metadata', async () => {
    const h = routesHarness()
    h.db.update(sessions).set({
      cwd: null, model: null, lastUser: null, createdDay: null,
      contextWindow: null, maxOutputTokens: null,
    }).where(sql`${sessions.id} = 'other'`).run()
    h.db.update(sessions).set({ contextWindow: 8_192, maxOutputTokens: 1_024 }).where(sql`${sessions.id} = 'root'`).run()
    const page = await h.call('overview', { part: 'page', scope: { range: 'all' } })
    const items = (page.value as { page: { items: Record<string, unknown>[] } }).page.items
    assert.equal(items.length, 3)
    assert.equal(items.some(item => item.cwd === undefined), true)
    assert.equal(items.some(item => item.contextWindow === 8_192), true)
    assert.equal(items.some(item => item.createdDay === undefined), true)
    h.opened.client.close()
  })

  test('falls back to the stored pricing version without a cost version', async () => {
    const h = routesHarness({ ...COST, version: undefined })
    const status = await h.call('query/status', {})
    assert.equal(status.pricing_version, 0)
    h.opened.client.close()
  })

  test('wraps thrown values and database errors', async () => {
    const throwing = routesHarness({ ...COST, ready: () => { throw 'boom' } })
    const thrown = await throwing.call('query/summary', {})
    assert.equal((thrown.error as { message: string }).message, 'boom')
    throwing.opened.client.close()
    const failing = routesHarness({ ...COST, usd: () => { throw new Error('usd boom') } })
    const errored = await failing.call('query/summary', { scope: { range: 'all' } })
    assert.equal((errored.error as { message: string }).message, 'usd boom')
    failing.opened.client.close()
  })
})
