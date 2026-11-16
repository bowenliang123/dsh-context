import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { openDatabase } from '../../src/host/db/open'
import { createDb, metaSnapshot } from '../../src/host/db/db'
import { BackfillScheduler } from '../../src/host/db/scheduler'
import { LiveWriter } from '../../src/host/db/live'
import { resolveBounds } from '../../src/host/config'
import { requests, sessions, sessionTombstones, surfaceNodes, foldState } from '../../src/host/db/schema'
import { eq } from 'drizzle-orm'
import { fakeCtx } from './helpers/ctx'
import { assistantMessage, header, stepEnd, stepStart, userMessage } from './helpers/events'

const BOUNDS = resolveBounds({})
const text = (value: string) => [{ type: 'text', text: value }]

function logOf(id: string, seqBase = 0) {
  return [
    header(seqBase, { model: 'm', provider: 'p' }),
    userMessage(seqBase + 1, text(`hello ${id}`)),
    stepStart(seqBase + 2, { time: 1000 + seqBase }),
    assistantMessage(seqBase + 3, { turn: 1, step: 1, time: 2000 + seqBase, usage: { inputTokens: 10, outputTokens: 5 } }),
    stepEnd(seqBase + 4, { time: 3000 + seqBase }),
  ]
}

function harness() {
  const opened = openDatabase(':memory:')
  const db = createDb(opened.client)
  let now = 10_000
  const logs: Record<string, ReturnType<typeof logOf>> = { a: logOf('a'), b: logOf('b') }
  const stats: Record<string, { revision?: string; sizeBytes?: number; location?: { path: string } } | undefined> = {
    a: { revision: 'r1', sizeBytes: 1, location: { path: '/logs/a' } },
    b: { revision: 'r1', sizeBytes: 1, location: { path: '/logs/b' } },
  }
  let listed: string[] = ['a', 'b']
  let listFails = false
  let openError: unknown = null
  let statError: unknown = null
  const warnings: string[] = []
  const fake = fakeCtx({
    sessionProjections: { snapshot: () => ({ values: {} }) },
    sessionProjectionCache: { cachedSnapshot: () => ({ values: {} }) },
    workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    agents: { get: () => undefined },
    sessions: { get: () => undefined },
    sessionQuery: {
      listSessions: async () => {
        if (listFails) throw new Error('list failed')
        return listed.map(id => ({ header: { id, createdAt: 1, cwd: '/w' }, live: false }))
      },
      observeSession: async (id: string) => ({ events: logs[id] ?? [] }),
    },
    sessionPersistence: {
      stat: async (id: string) => {
        if (statError !== null) throw statError
        return stats[id]
      },
      open: async (id: string) => {
        if (openError !== null) throw openError
        return {
          header: { id, createdAt: 1, cwd: '/w' },
          read: async (offset: number) => ({ events: (logs[id] ?? []).filter(event => event.seq >= offset) }),
          close: async () => {},
        }
      },
    },
  }, { injectAll: true, logger: { warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')) } })
  const live = new LiveWriter(fake.ctx, db, BOUNDS)
  const scheduler = new BackfillScheduler(fake.ctx, db, BOUNDS, {
    live,
    now: () => now,
    sleep: async () => {},
    yieldTo: async () => {},
    hydrationDelayMs: 1,
    idleDelayMs: 1,
    reaperIntervalMs: 1,
    onGeneration: () => {},
  })
  return {
    opened, db, fake, live, scheduler, logs, stats, warnings,
    setListed(ids: string[]) { listed = ids },
    setListFails(value: boolean) { listFails = value },
    setOpenError(value: unknown) { openError = value },
    setStatError(value: unknown) { statError = value },
    advance(ms: number) { now += ms },
    now: () => now,
  }
}

describe('backfill scheduler', () => {
  test('folds listed cold sessions, then incrementally follows a revision change', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).all().length, 2)
    assert.equal(h.db.select().from(requests).all().length, 2)
    assert.equal(h.scheduler.coverage().complete, true)
    assert.equal(h.scheduler.coverage().covered, 2)
    h.logs.a.push(...[
      userMessage(5, text('more')),
      stepStart(6, { time: 6000 }),
      assistantMessage(7, { turn: 2, step: 1, time: 7000, usage: { inputTokens: 2, outputTokens: 1 } }),
      stepEnd(8, { time: 8000 }),
    ])
    h.stats.a = { revision: 'r2', sizeBytes: 2, location: { path: '/logs/a' } }
    h.advance(1000)
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(requests).where(eq(requests.sessionId, 'a')).all().length, 2)
    assert.equal(h.db.select().from(sessions).all().find(row => row.id === 'a')?.lastSeq, 8)
    h.opened.client.close()
  })

  test('a list failure leaves the corpus untouched', async () => {
    const h = harness()
    h.setListFails(true)
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).all().length, 0)
    assert.equal(h.scheduler.coverage().total, 0)
    h.opened.client.close()
  })

  test('reaps a vanished session after two misses and a grace window', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    h.setListed(['a'])
    h.stats.b = undefined
    h.advance(61_000)
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessionTombstones).all().length, 0)
    h.advance(61_000)
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessionTombstones).all().length, 1)
    assert.equal(h.db.select().from(sessions).all().some(row => row.id === 'b'), false)
    assert.equal(h.db.select().from(requests).all().some(row => row.sessionId === 'b'), false)
    assert.ok(h.scheduler.reaperStats().deletedSessions > 0)
    h.advance(8 * 86_400_000)
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessionTombstones).all().length, 0)
    h.opened.client.close()
  })

  test('reaper skips when persistence, list or candidates are unavailable', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    h.setListFails(true)
    await h.scheduler.reapOnce()
    h.setListFails(false)
    h.setListed(['a'])
    h.advance(1000)
    await h.scheduler.reapOnce()
    assert.equal(h.db.select().from(sessions).all().length, 2)
    h.opened.client.close()
  })

  test('hydrates after a delay and settles its phase; dispose stops timers', async () => {
    vi.useFakeTimers()
    const h = harness()
    h.scheduler.start()
    h.scheduler.noteRoute()
    h.scheduler.noteInteractive()
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(h.scheduler.isHydrating(), false)
    h.scheduler.setPhase('ready')
    assert.equal(h.scheduler.startupPhase(), 'ready')
    h.scheduler.setIntegrity('failed')
    assert.equal(h.scheduler.integrityState(), 'failed')
    h.scheduler.request()
    h.scheduler.request()
    await vi.advanceTimersByTimeAsync(100)
    h.scheduler.dispose()
    h.scheduler.dispose()
    vi.useRealTimers()
    h.opened.client.close()
  })
})

describe('backfill failure paths', () => {
  test('falls back to statSync and leaves the session pending when the log is gone', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    h.stats.a = undefined
    h.db.update(sessions).set({ foldStatus: 'pending', logPath: '/missing/a.log' }).where(eq(sessions.id, 'a')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'pending')
    h.opened.client.close()
  })

  test('records unprintable and unreadable failures', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    h.setOpenError({ toString: () => { throw new Error('unprintable') } })
    h.db.update(sessions).set({ foldStatus: 'pending' }).where(eq(sessions.id, 'a')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldError, 'unprintable error')
    h.setOpenError({ get name(): string { throw new Error('unreadable') } })
    h.db.update(sessions).set({ foldStatus: 'pending' }).where(eq(sessions.id, 'a')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'failed')
    h.opened.client.close()
  })

  test('warns when a pass rejects', async () => {
    const h = harness()
    h.opened.client.close()
    h.scheduler.request()
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(h.warnings.some(line => line.includes('storage backfill stopped')), true)
  })

  test('a log that starts past the stored cursor refolds from scratch', async () => {
    const h = harness()
    await h.scheduler.runOnce()
    h.logs.a.splice(0, 2)
    h.stats.a = { sizeBytes: 2, location: { path: '/logs/a' } }
    h.db.update(foldState).set({ lastSeq: 1 }).where(eq(foldState.sessionId, 'a')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'ok')
    h.stats.a = { sizeBytes: 3, location: { path: '/logs/a' } }
    h.db.update(foldState).set({ lastSeq: 0 }).where(eq(foldState.sessionId, 'a')).run()
    await h.scheduler.runOnce()
    assert.equal(h.db.select().from(sessions).where(eq(sessions.id, 'a')).get()?.foldStatus, 'ok')
    h.opened.client.close()
  })

  test('records a reaper failure without leaving it running', async () => {    const h = harness()
    await h.scheduler.runOnce()
    h.setListed(['a'])
    h.stats.b = undefined
    h.advance(61_000)
    await h.scheduler.reapOnce()
    const broken = h.scheduler as unknown as { deleteSession(id: string, now: number): number }
    broken.deleteSession = () => { throw new Error('delete failed') }
    h.advance(61_000)
    await h.scheduler.reapOnce()
    assert.equal(h.scheduler.reaperStats().failed, 1)
    assert.equal(h.scheduler.reaperStats().running, false)
    assert.equal(h.warnings.some(line => line.includes('reaper failed')), true)
    h.opened.client.close()
  })
})

describe('live writer', () => {
  test('seeds from the observed log, follows events, flushes and retires', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const logs: Record<string, ReturnType<typeof logOf>> = { live: logOf('live') }
    const fake = fakeCtx({
      sessionQuery: { observeSession: async (id: string) => ({ events: logs[id] ?? [] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'live', header: { id: 'live', createdAt: 1, cwd: '/w', isSeeded: false } }
    fake.emit('session/created', session)
    for (const event of logs.live) fake.emit('session/event', session, event)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(db.select().from(requests).all().length, 1)
    assert.equal(db.select().from(sessions).all()[0]?.foldStatus, 'ok')
    const next = [
      userMessage(5, text('second')),
      stepStart(6, { time: 6000 }),
      assistantMessage(7, { turn: 2, step: 1, time: 7000, usage: { inputTokens: 1, outputTokens: 1 } }),
      stepEnd(8, { time: 8000 }),
    ]
    logs.live.push(...next)
    for (const event of next) fake.emit('session/event', session, event)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(db.select().from(requests).all().length, 2)
    fake.emit('session/disposed', session)
    assert.equal(writer.isLive('live'), false)
    writer.dispose()
    assert.equal(metaSnapshot(db).cleanShutdown, true)
    opened.client.close()
  })

  test('buffers before a seed, ignores duplicates, and survives a gap by reseeding', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    let events = [header(0, { model: 'm', provider: 'p' })]
    const fake = fakeCtx({
      sessionQuery: { observeSession: async () => ({ events }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1, bufferMax: 2 })
    const session = { id: 'live', header: { id: 'live', createdAt: 1, cwd: '/w' } }
    fake.emit('session/created', session)
    fake.emit('session/event', session, events[0])
    fake.emit('session/event', session, events[0])
    await new Promise(resolve => setTimeout(resolve, 20))
    events = [header(0, { model: 'm', provider: 'p' }), userMessage(1, text('gap'))]
    fake.emit('session/event', session, events[1])
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(db.select().from(surfaceNodes).all().length >= 1, true)
    writer.flushAll()
    writer.dispose()
    opened.client.close()
  })

  test('does not wipe rows when the observer is unavailable', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const fake = fakeCtx({
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1 })
    const session = { id: 'live', header: { id: 'live', createdAt: 1, cwd: '/w' } }
    fake.emit('session/created', session)
    fake.emit('session/event', session, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(db.select().from(sessions).all()[0]?.foldStatus, 'pending')
    writer.dispose()
    opened.client.close()
  })
})

describe('live writer branches', () => {
  test('ignores malformed lifecycle signals and seeds from a stored continuation', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const events = [header(0, { model: 'm', provider: 'p' }), userMessage(1, text('one'))]
    let failObserve = false
    const fake = fakeCtx({
      sessionQuery: {
        observeSession: async () => {
          if (failObserve) throw new Error('observe failed')
          return { events: [...events] }
        },
      },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1, entriesMax: 1, eventFlush: 1 })
    fake.emit('session/created', { id: 7 })
    fake.emit('session/created', { id: 'no-header' })
    fake.emit('session/event', { id: 7 }, events[0])
    fake.emit('session/event', { id: 'live' }, { type: 7 })
    const session = { id: 'live', header: { id: 'live', createdAt: 1, cwd: '/w' } }
    fake.emit('session/created', session)
    failObserve = true
    fake.emit('session/event', session, events[0])
    await new Promise(resolve => setTimeout(resolve, 20))
    failObserve = false
    fake.emit('session/event', session, events[0])
    await new Promise(resolve => setTimeout(resolve, 20))
    fake.emit('session/event', session, userMessage(1, text('one')))
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(db.select().from(sessions).all()[0]?.foldStatus, 'ok')
    fake.emit('session/disposed', { id: 7 })
    fake.emit('session/disposed', session)
    writer.flushAll()
    writer.dispose()
    fake.emit('session/created', session)
    fake.emit('session/event', session, events[0])
    fake.emit('session/disposed', session)
    assert.equal(writer.isLive('live'), false)
    opened.client.close()
  })

  test('evicts the oldest entry, caps the seed buffer and reseeds on a gap', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    const logs: Record<string, ReturnType<typeof logOf>> = { one: logOf('one'), two: logOf('two') }
    const fake = fakeCtx({
      sessionQuery: { observeSession: async (id: string) => ({ events: logs[id] ?? [] }) },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archiveSessionIds: [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1, entriesMax: 1, bufferMax: 0 })
    const one = { id: 'one', header: { id: 'one', createdAt: 1 } }
    const two = { id: 'two', header: { id: 'two', createdAt: 2 } }
    fake.emit('session/created', one)
    fake.emit('session/event', one, logs.one[0])
    fake.emit('session/created', two)
    fake.emit('session/event', two, logs.two[0])
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(writer.isLive('two'), true)
    fake.emit('session/event', two, header(9, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 30))
    writer.dispose()
    opened.client.close()
  })
})

describe('live writer edge branches', () => {
  test('handles malformed events, eviction timers, early disposal and retire races', async () => {
    const opened = openDatabase(':memory:')
    const db = createDb(opened.client)
    let failObserve = true
    let events: unknown[] = []
    const fake = fakeCtx({
      sessionQuery: {
        observeSession: async () => {
          if (failObserve) throw new Error('observe')
          return { events }
        },
      },
      sessionProjections: { snapshot: () => ({ values: {} }) },
      workspaceRegistry: { list: () => [], archivedSessionIds: [] },
      agents: { get: () => undefined },
    }, { injectAll: true })
    const writer = new LiveWriter(fake.ctx, db, BOUNDS, { debounceMs: 1, entriesMax: 1, bufferMax: 1 })
    const session = { id: 'live', header: { id: 'live', createdAt: 1, cwd: 1 } }
    fake.emit('session/created', session)
    fake.emit('session/event', session, { type: 'inject', seq: 'bad', time: 1 })
    fake.emit('session/event', session, header(0, { model: 'm', provider: 'p' }))
    fake.emit('session/event', { id: 'bad' }, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 10))
    failObserve = false
    events = [header(0, { model: 'm', provider: 'p' })]
    fake.emit('session/event', session, userMessage(1, text('one')))
    await new Promise(resolve => setTimeout(resolve, 10))
    fake.emit('session/disposed', { id: 'ghost' })
    fake.emit('session/disposed', session)
    const two = { id: 'two', header: { id: 'two', createdAt: 2 } }
    fake.emit('session/created', two)
    fake.emit('session/event', two, header(0, { model: 'm', provider: 'p' }))
    await new Promise(resolve => setTimeout(resolve, 5))
    writer.flushAll()
    writer.dispose()
    writer.dispose()
    opened.client.close()
  })
})
