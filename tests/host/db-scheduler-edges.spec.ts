import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { openDatabase } from '../../src/host/db/open'
import { createDb } from '../../src/host/db/db'
import { BackfillScheduler, type Coverage } from '../../src/host/db/scheduler'
import { LiveWriter } from '../../src/host/db/live'
import { resolveBounds } from '../../src/host/config'
import { foldState, requests, sessions, sessionTombstones } from '../../src/host/db/schema'
import { createTimelineState } from '../../src/host/foldState'
import { stateToJson } from '../../src/host/db/foldSession'
import { fakeCtx } from './helpers/ctx'
import { header, userMessage } from './helpers/events'

const BOUNDS = resolveBounds({})
const text = (value: string) => [{ type: 'text', text: value }]

interface EdgeOptions {
  list?: () => Promise<unknown> | unknown
  stat?: (id: string) => Promise<unknown>
  open?: ((id: string) => Promise<unknown>) | undefined
  sessionsGet?: (id: string) => unknown
  now?: () => number
  live?: LiveWriter
}

function edgeHarness(options: EdgeOptions = {}) {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  const fake = fakeCtx({
    sessionQuery: {
      listSessions: options.list ?? (() => []),
    },
    sessionPersistence: options.open === undefined && options.stat === undefined ? undefined : {
      ...(options.stat === undefined ? {} : { stat: options.stat }),
      ...(options.open === undefined ? {} : { open: options.open }),
    },
    sessions: { get: options.sessionsGet ?? (() => undefined) },
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: {} }) },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    agents: { get: () => undefined },
  }, { injectAll: true })
  const live = options.live ?? new LiveWriter(fake.ctx, db, BOUNDS)
  const scheduler = new BackfillScheduler(fake.ctx, db, BOUNDS, {
    live,
    ...(options.now === undefined ? {} : { now: options.now }),
    sleep: async () => {},
    yieldTo: async () => {},
  })
  return { opened, db, fake, live, scheduler }
}

function seedSession(db: ReturnType<typeof createDb>, id: string, over: Partial<typeof sessions.$inferInsert> = {}): void {
  db.insert(sessions).values({
    id, createdAt: 1, updatedAt: 2, title: id, familyRoot: id, foldStatus: 'pending', lastSeq: -1, ...over,
  }).run()
}

describe('scheduler edge paths', () => {
  test('list filtering rejects malformed records and survives hostile session lookups', async () => {
    const h = edgeHarness({
      list: () => [null, 1, {}, { header: { id: '' } }, { header: { id: 'cold' } }, { header: { id: 'live' }, live: true }, { header: { id: 'both', cwd: '/w' }, live: true }],
      sessionsGet: () => { throw new Error('get failed') },
    })
    await h.scheduler.runOnce()
    const ids = h.db.select().from(sessions).all().map(row => row.id).sort()
    assert.deepEqual(ids, ['both', 'live'])
    h.scheduler.dispose()
    h.opened.client.close()
  })

  test('default timing hooks, duplicate requests and hydration/dispose guards are exercised', async () => {
    vi.useFakeTimers()
    const h = edgeHarness()
    h.scheduler.start()
    h.scheduler.start()
    h.scheduler.noteRoute()
    h.scheduler.noteRoute()
    h.scheduler.request()
    await vi.advanceTimersByTimeAsync(10)
    h.scheduler.dispose()
    h.scheduler.noteRoute()
    h.scheduler.request()
    h.scheduler.scheduleHydration(1)
    h.scheduler.dispose()
    vi.useRealTimers()
    h.opened.client.close()
  })

  test('readLog degrades when persistence or its open face is absent', async () => {
    const noPersistence = edgeHarness()
    seedSession(noPersistence.db, 'a', { foldStatus: 'pending' })
    await noPersistence.scheduler.runOnce()
    assert.equal(noPersistence.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'ok')
    noPersistence.opened.client.close()

    const noOpen = edgeHarness({ stat: async () => undefined })
    seedSession(noOpen.db, 'a', { foldStatus: 'pending' })
    await noOpen.scheduler.runOnce()
    assert.equal(noOpen.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'ok')
    noOpen.opened.client.close()
  })

  test('tail verification detects a matching tail, a mismatch, a live session and a read failure', async () => {
    const logs: Record<string, ReturnType<typeof userMessage>[]> = {
      match: [userMessage(3, text('x'))],
      mismatch: [userMessage(4, text('x'))],
      empty: [],
    }
    let fail = false
    const h = edgeHarness({
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async (offset: number) => {
          if (fail) throw new Error('read failed')
          return { events: (logs[id] ?? []).filter(event => event.seq >= offset) }
        },
        close: async () => { throw new Error('close failed') },
      }),
      stat: async () => undefined,
    })
    for (const id of ['match', 'mismatch', 'empty', 'live']) {
      seedSession(h.db, id, { foldStatus: 'ok', lastSeq: 3 })
    }
    h.live.isLive = ((id: string) => id === 'live')
    await (h.scheduler as unknown as { verifyTails(): Promise<void> }).verifyTails()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'match')).get()?.foldStatus, 'ok')
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'mismatch')).get()?.foldStatus, 'pending')
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'empty')).get()?.foldStatus, 'pending')
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'live')).get()?.foldStatus, 'ok')
    fail = true
    const second = edgeHarness({
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async () => { throw new Error('read failed') },
        close: async () => {},
      }),
      stat: async () => undefined,
    })
    seedSession(second.db, 'x', { foldStatus: 'ok', lastSeq: 1 })
    await second.scheduler.runOnce()
    assert.equal(second.db.select().from(sessions).where(eq(sessions.id, 'x')).get()?.foldStatus, 'ok')
    second.opened.client.close()
    h.opened.client.close()
  })

  test('identity refresh handles absent, partial, throwing and changed stats', async () => {
    const stats: Record<string, unknown> = {
      rev: { revision: 'r2', sizeBytes: 2, location: { path: '/new' } },
      path: { location: { path: '/new' }, sizeBytes: 2, mtimeMs: 5 },
      size: { location: { path: '/old' }, sizeBytes: 9, mtimeMs: 5 },
      mtime: { location: { path: '/old', mtimeMs: 9 }, sizeBytes: 1 },
      same: { revision: 'r1', sizeBytes: 1, location: { path: '/old' } },
      none: undefined,
      throw: 'throw',
      empty: {},
    }
    const h = edgeHarness({
      stat: async (id: string) => {
        if (stats[id] === 'throw') throw new Error('stat failed')
        return stats[id]
      },
    })
    const base = { foldStatus: 'ok' as const, lastSeq: 1, logPath: '/old', logSize: 1, logMtime: 1, logRevision: 'r1' }
    for (const id of ['rev', 'path', 'size', 'mtime', 'same', 'none', 'throw', 'empty', 'gone']) {
      seedSession(h.db, id, base)
    }
    h.db.update(sessions).set({ logRevision: null }).where(eq(sessions.id, 'path')).run()
    h.db.update(sessions).set({ logRevision: null }).where(eq(sessions.id, 'size')).run()
    h.db.update(sessions).set({ logRevision: null }).where(eq(sessions.id, 'mtime')).run()
    h.db.update(sessions).set({ logRevision: null, foldStatus: 'pending' }).where(eq(sessions.id, 'gone')).run()
    const entries = ['rev', 'path', 'size', 'mtime', 'same', 'none', 'throw', 'empty', 'gone'].map(id => ({ id, header: { id }, live: false }))
    await (h.scheduler as unknown as { refreshIdentities(entries: unknown[]): Promise<void> }).refreshIdentities(entries)
    for (const id of ['rev', 'path', 'size', 'mtime']) {
      assert.equal(h.db.select().from(sessions).where(eq(sessions.id, id)).get()?.foldStatus, 'ok')
    }
    h.opened.client.close()
  })

  test('rest yields under interaction and a spent work budget', async () => {
    const h = edgeHarness()
    const sleeps: number[] = []
    const scheduler = new BackfillScheduler(h.fake.ctx, h.db, BOUNDS, {
      live: h.live,
      sleep: async (ms) => { sleeps.push(ms) },
      yieldTo: async () => {},
      onInteractive: () => true,
    })
    const rest = (scheduler as unknown as { rest(): Promise<void> }).rest.bind(scheduler)
    await rest()
    assert.deepEqual(sleeps.slice(-2), [50, 25])
    ;(scheduler as unknown as { workMs: number }).workMs = 8_000
    await rest()
    assert.equal(sleeps.includes(2_000), true)
    h.opened.client.close()
  })

  test('foldOne skips tombstones, missing rows, stat failures, missing files and unsupported formats', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dscx-sched-'))
    const logPath = join(dir, 'session.jsonl')
    writeFileSync(logPath, 'x')
    const h = edgeHarness({
      stat: async (id: string) => {
        if (id === 'throw') throw new Error('stat failed')
        if (id === 'file') return undefined
        return { revision: 'r', sizeBytes: 1, location: { path: logPath } }
      },
      open: async (id: string) => {
        if (id === 'unsupported') throw Object.assign(new Error('old'), { name: 'SessionFormatUnsupportedError' })
        return {
          header: { id, createdAt: 1, cwd: '/w' },
          read: async () => ({ events: [header(0, { model: 'm', provider: 'p' })] }),
          close: async () => {},
        }
      },
    })
    for (const id of ['tomb', 'throw', 'file', 'unsupported', 'ok', 'aborted']) seedSession(h.db, id, { foldStatus: 'pending' })
    h.db.insert(sessionTombstones).values({ id: 'tomb', deletedAt: 1, reason: 'missing-from-list' }).run()
    h.db.update(sessions).set({ logPath }).where(eq(sessions.id, 'file')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'tomb')).get()?.foldStatus, 'pending')
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'unsupported')).get()?.foldStatus, 'unsupported')
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'ok')).get()?.foldStatus, 'ok')
    rmSync(dir, { recursive: true, force: true })
    h.opened.client.close()
  })

  test('reaper guards, grace, missing log paths and sharded deletes', async () => {
    let now = 100_000
    const h = edgeHarness({
      now: () => now,
      stat: async (id: string) => {
        if (id === 'statthrow') throw new Error('stat')
        return undefined
      },
      list: () => [],
    })
    seedSession(h.db, 'deleting', { foldStatus: 'deleting', foldedAt: 0 })
    seedSession(h.db, 'folding', { foldStatus: 'folding', foldedAt: 0 })
    seedSession(h.db, 'young', { foldStatus: 'ok', foldedAt: now - 1, logPath: '/missing' })
    seedSession(h.db, 'old', { foldStatus: 'ok', foldedAt: 0, logPath: '/missing' })
    seedSession(h.db, 'nopath', { foldStatus: 'ok', foldedAt: 0, logPath: null })
    seedSession(h.db, 'statthrow', { foldStatus: 'ok', foldedAt: 0, logPath: '/missing' })
    for (let index = 0; index < 2_001; index++) h.db.insert(requests).values({ sessionId: 'old', seq: index, time: 1, day: 'd' }).run()
    now += 61_000
    await h.scheduler.reapOnce()
    now += 61_000
    h.db.update(sessions).set({ foldedAt: now }).where(eq(sessions.id, 'young')).run()
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'old')).get(), undefined)
    assert.equal(h.db.select().from(requests).all().filter(row => row.sessionId === 'old').length, 0)
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'nopath')).get() !== undefined, true)
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'young')).get() !== undefined, true)
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'statthrow')).get() !== undefined, true)
    h.scheduler.dispose()
    await h.scheduler.reapOnce()
    h.opened.client.close()
  })

  test('coverage and phase transitions report each fold status', () => {
    const h = edgeHarness()
    for (const status of ['ok', 'failed', 'unsupported', 'folding', 'deleting', 'pending'] as const) {
      seedSession(h.db, status, { foldStatus: status })
    }
    const coverage: Coverage = h.scheduler.coverage()
    assert.equal(coverage.total, 6)
    assert.equal(coverage.failed, 1)
    assert.equal(coverage.unsupported, 1)
    assert.equal(coverage.folding, 1)
    assert.equal(coverage.deleting, 1)
    assert.equal(coverage.remaining, 4)
    h.scheduler.setIntegrity('ok')
    h.scheduler.setPhase('rebuilding')
    assert.equal(h.scheduler.integrityState(), 'ok')
    assert.equal(h.scheduler.startupPhase(), 'rebuilding')
    h.opened.client.close()
  })
})

describe('scheduler deeper edges', () => {
  test('default hooks and service-absence guards', async () => {
    const h = edgeHarness()
    const scheduler = new BackfillScheduler(h.fake.ctx, h.db, BOUNDS, { live: h.live })
    await (scheduler as unknown as { sleep(ms: number): Promise<void> }).sleep(0)
    await (scheduler as unknown as { yieldTo(): Promise<void> }).yieldTo()
    ;(scheduler as unknown as { scheduleReaper(): void }).scheduleReaper()
    scheduler.dispose()
    ;(scheduler as unknown as { scheduleReaper(): void }).scheduleReaper()
    await scheduler.runOnce()
    await scheduler.reapOnce()
    h.opened.client.close()
  })

  test('a non-array event payload folds as an empty log and a session face is stored', async () => {
    const h = edgeHarness({
      list: () => [{ header: { id: 'a', cwd: '/w' }, live: false }],
      sessionsGet: () => ({}),
      open: async () => ({ header: { id: 'a', createdAt: 1 }, read: async () => ({ events: 'nope' }), close: async () => {} }),
      stat: async () => ({ revision: 'r', sizeBytes: 1, location: { path: '/w' } }),
    })
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).all().length, 1)
    h.opened.client.close()
  })

  test('hydration and reaper timers stop after disposal', async () => {
    vi.useFakeTimers()
    const h = edgeHarness()
    const scheduler = new BackfillScheduler(h.fake.ctx, h.db, BOUNDS, { live: h.live, hydrationDelayMs: 5, reaperIntervalMs: 5 })
    scheduler.start()
    ;(scheduler as unknown as { scheduleReaper(): void }).scheduleReaper()
    ;(scheduler as unknown as { scheduleReaper(): void }).scheduleReaper()
    scheduler.dispose()
    await vi.advanceTimersByTimeAsync(20)
    vi.useRealTimers()
    h.opened.client.close()
  })

  test('a pass aborts at the queue boundary and skips live rows', async () => {
    const h = edgeHarness({ list: () => [{ header: { id: 'live', cwd: '/w' }, live: true }] })
    seedSession(h.db, 'live', { foldStatus: 'pending' })
    seedSession(h.db, 'other', { foldStatus: 'pending' })
    const scheduler = h.scheduler as unknown as { abort: AbortController; runPass(): Promise<void> }
    scheduler.abort.abort()
    await scheduler.runPass()
    h.opened.client.close()
  })

  test('foldOne tolerates a vanished row and the incremental decision tree', async () => {
    const h = edgeHarness({
      stat: async () => ({ revision: 'r1', sizeBytes: 1, location: { path: '/old' } }),
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async (offset: number) => ({ events: offset === 0 ? [header(0, { model: 'm', provider: 'p' })] : [] }),
        close: async () => {},
      }),
    })
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('missing')
    seedSession(h.db, 'incremental', { foldStatus: 'ok', lastSeq: 0, logRevision: 'r1', logPath: '/old' })
    h.db.insert(foldState).values({ sessionId: 'incremental', lastSeq: 0, stateJson: '{}', updatedAt: 1 }).run()
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('incremental')
    seedSession(h.db, 'nofoldstate', { foldStatus: 'ok', lastSeq: 0, logRevision: 'r1', logPath: '/old' })
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('nofoldstate')
    seedSession(h.db, 'revision', { foldStatus: 'ok', lastSeq: 0, logRevision: 'other', logPath: '/old' })
    h.db.insert(foldState).values({ sessionId: 'revision', lastSeq: 0, stateJson: '{}', updatedAt: 1 }).run()
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('revision')
    h.opened.client.close()
  })
})

describe('scheduler branch completions', () => {
  test('absent query, non-array list and a live pending row', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    }, { injectAll: true })
    const originalGet = fake.ctx.get.bind(fake.ctx)
    fake.ctx.get = (name: string) => name === 'sessionQuery' ? undefined : originalGet(name)
    const live = new LiveWriter(fake.ctx, db, BOUNDS)
    const scheduler = new BackfillScheduler(fake.ctx, db, BOUNDS, { live, sleep: async () => {}, yieldTo: async () => {} })
    await scheduler.runOnce()
    fake.ctx.get = () => ({ listSessions: async () => ({}) })
    await scheduler.runOnce()
    fake.ctx.get = () => ({ listSessions: async () => [{ header: { id: 'live', cwd: '/w' }, live: true }] })
    seedSession(db, 'live', { foldStatus: 'pending' })
    await scheduler.runOnce()
    assert.equal(db.select().from(sessions).where(eq(sessions.id, 'live')).get()?.foldStatus, 'pending')
    live.dispose()
    opened.client.close()
  })

  test('a pass aborts on a queued row and the phase stays hydrating after disposal', async () => {
    let resolve: ((value: unknown) => void) | undefined
    const h = edgeHarness({
      list: () => new Promise((done) => { resolve = done }),
    })
    seedSession(h.db, 'pending', { foldStatus: 'pending' })
    h.scheduler.request()
    h.scheduler.dispose()
    resolve?.([{ header: { id: 'pending', cwd: '/w' }, live: false }])
    await new Promise(done => setTimeout(done, 10))
    h.scheduler.request()
    h.opened.client.close()
  })

  test('incremental fold rejects a log whose first seq skips past the offset and aborts mid-slice', async () => {
    const h = edgeHarness({
      stat: async () => ({ revision: 'r1', sizeBytes: 1, location: { path: '/old' } }),
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async (offset: number) => ({ events: offset === 0 ? [header(0, { model: 'm', provider: 'p' })] : [{ type: 'user/message', seq: id === 'same-first' ? 1 : offset + 5, time: 1, data: { content: [] } }] }),
        close: async () => {},
      }),
    })
    seedSession(h.db, 'skip', { foldStatus: 'ok', lastSeq: 0, logRevision: 'r1', logPath: '/old' })
    h.db.insert(foldState).values({ sessionId: 'skip', lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('skip')
    const abortScheduler = h.scheduler as unknown as { abort: AbortController; foldOne(id: string): Promise<void> }
    seedSession(h.db, 'aborted2', { foldStatus: 'pending' })
    abortScheduler.abort.abort()
    await abortScheduler.foldOne('aborted2')
    h.opened.client.close()
  })

  test('a long log yields between slices and drives the span cursor', async () => {
    const events = Array.from({ length: 2_001 }, (_, index) => userMessage(index, text('x')))
    const h = edgeHarness({
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async () => ({ events }),
        close: async () => {},
      }),
      stat: async () => ({ revision: 'r', sizeBytes: 1, location: { path: '/w' } }),
    })
    seedSession(h.db, 'long', { foldStatus: 'pending' })
    await (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne('long')
    assert.equal(h.db.select().from(requests).all().length, 0)
    h.opened.client.close()
  })

  test('reaper skips listed, live, young, stat-present, existing-log and null-path-24h rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dscx-reap-'))
    const exists = join(dir, 'exists.jsonl')
    writeFileSync(exists, 'x')
    let now = 100_000
    let statValue: unknown
    const h = edgeHarness({
      now: () => now,
      list: () => [
        { header: { id: 'listed', cwd: '/w' }, live: false },
        { header: { id: 'live', cwd: '/w' }, live: true },
      ],
      stat: async () => statValue,
    })
    for (const id of ['listed', 'live', 'young', 'stat', 'exists', 'nulllong']) {
      seedSession(h.db, id, { foldStatus: 'ok', foldedAt: 0, logPath: id === 'exists' ? exists : id === 'nulllong' ? null : '/missing' })
    }
    now += 61_000
    h.db.update(sessions).set({ foldedAt: now }).where(eq(sessions.id, 'young')).run()
    await h.scheduler.reapOnce()
    statValue = { revision: 'r' }
    now += 61_000
    h.db.update(sessions).set({ foldedAt: now }).where(eq(sessions.id, 'young')).run()
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'stat')).get() !== undefined, true)
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'exists')).get() !== undefined, true)
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'nulllong')).get() !== undefined, true)
    now += 86_400_000
    h.db.update(sessions).set({ foldedAt: now }).where(eq(sessions.id, 'young')).run()
    statValue = undefined
    const abortScheduler = h.scheduler as unknown as { abort: AbortController; reapOnce(): Promise<void> }
    abortScheduler.abort.abort()
    await abortScheduler.reapOnce()
    rmSync(dir, { recursive: true, force: true })
    h.opened.client.close()
  })

  test('reaping an old parent re-roots its surviving child', async () => {
    let now = 100_000
    const h = edgeHarness({ now: () => now, list: () => [], stat: async () => undefined })
    seedSession(h.db, 'parent', { foldStatus: 'ok', foldedAt: 0, logPath: '/missing' })
    seedSession(h.db, 'child', { foldStatus: 'ok', foldedAt: 0, logPath: '/missing', parentSession: 'parent', origin: 'subagent', familyRoot: 'parent' })
    now += 61_000
    await h.scheduler.reapOnce()
    now += 61_000
    h.db.update(sessions).set({ foldedAt: now }).where(eq(sessions.id, 'child')).run()
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'child')).get()?.familyRoot, 'child')
    h.opened.client.close()
  })

  test('reaper returns without persistence and while disposed or running', async () => {
    const h = edgeHarness()
    seedSession(h.db, 'a', { foldStatus: 'ok', foldedAt: 0 })
    await h.scheduler.reapOnce()
    ;(h.scheduler as unknown as { running: boolean }).running = true
    await h.scheduler.reapOnce()
    h.scheduler.dispose()
    await h.scheduler.reapOnce()
    h.opened.client.close()
  })
})

describe('scheduler final branches', () => {
  test('dirty queue includes ok rows and skips already queued ids', async () => {
    const h = edgeHarness()
    seedSession(h.db, 'ok', { foldStatus: 'ok' })
    seedSession(h.db, 'pending', { foldStatus: 'pending' })
    ;(h.scheduler as unknown as { dirty: Set<string> }).dirty.add('ok')
    ;(h.scheduler as unknown as { dirty: Set<string> }).dirty.add('pending')
    ;(h.scheduler as unknown as { dirty: Set<string> }).dirty.add('gone')
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'ok')).get()?.foldStatus, 'ok')
    h.opened.client.close()
  })

  test('incremental path matching and a skipping first event', async () => {
    const h = edgeHarness({
      stat: async () => ({ revision: undefined, sizeBytes: 1, location: { path: '/old' } }),
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async (offset: number) => ({ events: offset === 0 ? [header(0, { model: 'm', provider: 'p' })] : [{ type: 'user/message', seq: offset + 5, time: 1, data: { content: [] } }] }),
        close: async () => {},
      }),
    })
    const fold = (id: string): Promise<void> => (h.scheduler as unknown as { foldOne(id: string): Promise<void> }).foldOne(id)
    for (const [id, over] of [
      ['null-null', { logRevision: null, logPath: null }],
      ['null-match', { logRevision: null, logPath: '/old' }],
      ['null-miss', { logRevision: null, logPath: '/new' }],
      ['bad-state', { logRevision: 'r', logPath: '/old' }],
    ] as const) {
      seedSession(h.db, id, { foldStatus: 'ok', lastSeq: 0, ...over })
      h.db.insert(foldState).values({ sessionId: id, lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
      await fold(id)
    }
    seedSession(h.db, 'same-first', { foldStatus: 'ok', lastSeq: 0, logRevision: 'r', logPath: '/old' })
    h.db.insert(foldState).values({ sessionId: 'same-first', lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
    await fold('same-first')
    seedSession(h.db, 'badjson', { foldStatus: 'ok', lastSeq: 0, logRevision: 'r', logPath: '/old' })
    h.db.insert(foldState).values({ sessionId: 'badjson', lastSeq: 0, stateJson: 'bad', updatedAt: 1 }).run()
    await fold('badjson')
    h.opened.client.close()
  })

  test('a catch with an aborted signal exits quietly', async () => {
    const h = edgeHarness({ open: async () => { throw new Error('read') }, stat: async () => undefined })
    seedSession(h.db, 'a', { foldStatus: 'pending' })
    const scheduler = h.scheduler as unknown as { abort: AbortController; foldOne(id: string): Promise<void> }
    scheduler.abort.abort()
    await scheduler.foldOne('a')
    h.opened.client.close()
  })

  test('a second miss inside the grace window is skipped', async () => {
    let now = 100_000
    const h = edgeHarness({ now: () => now, list: () => [], stat: async () => undefined })
    seedSession(h.db, 'a', { foldStatus: 'ok', foldedAt: 0, logPath: '/missing' })
    now += 61_000
    await h.scheduler.reapOnce()
    now += 1
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get() !== undefined, true)
    h.opened.client.close()
  })
})

function stateJson(): string {
  return JSON.stringify({
    surface: [], sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    requests: [], events: [], commands: [], callNames: {}, nextSpanSeq: 0,
  })
}

describe('live writer completion', () => {
  test('evicts a settled entry, handles a malformed seq and default debounce', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async (_id: string) => ({ events: [header(0, { model: 'm', provider: 'p' })] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { entriesMax: 1 })
    const one = { id: 'one', header: { id: 'one', createdAt: 1 } }
    fake.emit('session/created', one)
    fake.emit('session/event', one, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    const two = { id: 'two', header: { id: 'two', createdAt: 2 } }
    fake.emit('session/created', two)
    fake.emit('session/event', two, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(writer.isLive('one'), false)
    fake.emit('session/event', two, { type: 'todo/write', seq: 'bad', time: 1 })
    writer.flushAll()
    writer.dispose()
    opened.client.close()
  })

  test('a seed removed by retire stops before writing, and a gap waits for a reseed', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    let release: (() => void) | undefined
    let defer = true
    const fake = fakeCtx({
      sessionQuery: {
        observeSession: async (_id: string) => {
          if (defer) await new Promise<void>((resolve) => { release = resolve })
          return { events: [header(0, { model: 'm', provider: 'p' })] }
        },
      },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'gone', header: { id: 'gone', createdAt: 1 } }
    fake.emit('session/created', session)
    fake.emit('session/event', session, header(0, { model: 'm', provider: 'p' }))
    fake.emit('session/disposed', session)
    release?.()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(writer.isLive('gone'), false)

    const gap = { id: 'gap', header: { id: 'gap', createdAt: 2 } }
    defer = false
    fake.emit('session/created', gap)
    db.update(sessions).set({ foldStatus: 'ok', lastSeq: 0 }).where(eq(sessions.id, 'gap')).run()
    db.insert(foldState).values({ sessionId: 'gap', lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
    fake.emit('session/event', gap, userMessage(10, text('gap')))
    await new Promise(resolve => setTimeout(resolve, 10))
    writer.flushAll()
    writer.dispose()
    opened.client.close()
  })

  test('retire and flushAll clear scheduled debounce timers', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [header(0, { model: 'm', provider: 'p' })] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 10_000 })
    const session = { id: 'timer', header: { id: 'timer', createdAt: 1 } }
    fake.emit('session/created', session)
    fake.emit('session/event', session, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    fake.emit('session/event', session, userMessage(1, text('x')))
    fake.emit('session/disposed', session)
    const second = { id: 'timer2', header: { id: 'timer2', createdAt: 2 } }
    fake.emit('session/created', second)
    fake.emit('session/event', second, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    fake.emit('session/event', second, userMessage(1, text('x')))
    writer.flushAll()
    writer.dispose()
    opened.client.close()
  })
})

describe('live writer last branches', () => {
  test('evicts an entry that still owns a debounce timer', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [header(0, { model: 'm', provider: 'p' })] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 10_000, entriesMax: 1 })
    const one = { id: 'one', header: { id: 'one', createdAt: 1 } }
    fake.emit('session/created', one)
    fake.emit('session/event', one, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    fake.emit('session/event', one, userMessage(1, text('x')))
    const two = { id: 'two', header: { id: 'two', createdAt: 2 } }
    fake.emit('session/created', two)
    fake.emit('session/event', two, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    writer.dispose()
    opened.client.close()
  })

  test('a stored base with an empty observation and a gap leaves the entry unseeded', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'gap', header: { id: 'gap', createdAt: 1 } }
    fake.emit('session/created', session)
    db.update(sessions).set({ foldStatus: 'ok', lastSeq: 0 }).where(eq(sessions.id, 'gap')).run()
    db.insert(foldState).values({ sessionId: 'gap', lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
    fake.emit('session/event', session, userMessage(10, text('gap')))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(writer.isLive('gap'), true)
    writer.dispose()
    opened.client.close()
  })

  test('an empty seeded tail with a non-emitting buffered event writes no batch', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'quiet', header: { id: 'quiet', createdAt: 1 } }
    fake.emit('session/created', session)
    db.update(sessions).set({ foldStatus: 'ok', lastSeq: 0 }).where(eq(sessions.id, 'quiet')).run()
    db.insert(foldState).values({ sessionId: 'quiet', lastSeq: 0, stateJson: stateJson(), updatedAt: 1 }).run()
    fake.emit('session/event', session, { type: 'todo/write', seq: 1, time: 1, data: {} })
    await new Promise(resolve => setTimeout(resolve, 10))
    writer.dispose()
    opened.client.close()
  })
})

describe('live reseed and tail abort guards', () => {
  test('a stored base with an observed gap reseeds from the observed log', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [header(0, { model: 'm', provider: 'p' }), userMessage(3, text('gap'))] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'gap', header: { id: 'gap', createdAt: 1, cwd: '/w' } }
    fake.emit('session/created', session)
    db.insert(foldState).values({ sessionId: 'gap', lastSeq: 0, stateJson: stateToJson(createTimelineState()), updatedAt: 1 }).run()
    fake.emit('session/event', session, userMessage(4, text('next')))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(writer.isLive('gap'), true)
    writer.dispose()
    opened.client.close()
  })

  test('a stored base with an empty observation continues from the base', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events: [] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'base', header: { id: 'base', createdAt: 1, cwd: '/w' } }
    fake.emit('session/created', session)
    db.insert(foldState).values({ sessionId: 'base', lastSeq: 0, stateJson: stateToJson(createTimelineState()), updatedAt: 1 }).run()
    fake.emit('session/event', session, userMessage(1, text('after')))
    await new Promise(resolve => setTimeout(resolve, 20))
    writer.dispose()
    opened.client.close()
  })

  test('tail verification stops before and after an aborted read', async () => {
    const before = edgeHarness({
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async () => ({ events: [] }),
        close: async () => {},
      }),
    })
    seedSession(before.db, 'a', { foldStatus: 'ok', lastSeq: 1 })
    before.scheduler.dispose()
    await (before.scheduler as unknown as { verifyTails(): Promise<void> }).verifyTails()
    before.opened.client.close()

    let release: ((value: { events: { seq: number }[] }) => void) | undefined
    const after = edgeHarness({
      open: async (id: string) => ({
        header: { id, createdAt: 1, cwd: '/w' },
        read: async () => new Promise((resolve) => { release = resolve }),
        close: async () => {},
      }),
    })
    seedSession(after.db, 'a', { foldStatus: 'ok', lastSeq: 1 })
    const pending = (after.scheduler as unknown as { verifyTails(): Promise<void> }).verifyTails()
    await new Promise(resolve => setTimeout(resolve, 10))
    after.scheduler.dispose()
    release?.({ events: [] })
    await pending
    after.opened.client.close()
  })
})
