import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { nextSliceSize, watchActivityBackfill, type FoldPool, BACKFILL_ROUTE as HOST_BACKFILL_ROUTE } from '../../src/host/backfill'
import { userMessage } from './helpers/events'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { createContextActivityDefinition } from '../../src/host/activity'
import { createContextHeadersDefinition } from '../../src/host/headers'
import { activityOf } from '../../src/host/overviewDecode'
import { type DurableIdentity, type OverviewCache } from '../../src/host/overviewCache'
import { type HostSession } from '../../src/host/overviewCorpus'
import { inProcessPool } from './helpers/foldWorker'
import { arm, captureLogs, connectionOf, fakeState, trigger, until, type RouteBox } from './helpers/backfill'
import { BALANCE_ROUTE as HOST_BALANCE_ROUTE } from '../../src/host/balance'
import { DETAIL_ROUTE as HOST_DETAIL_ROUTE } from '../../src/host/detail'
import { ATTACHMENT_ROUTE as HOST_ATTACHMENT_ROUTE } from '../../src/host/attachment'
import { COMMANDS_ROUTE as HOST_COMMANDS_ROUTE } from '../../src/host/commandPages'
import { FLEET_ROUTE as HOST_FLEET_ROUTE } from '../../src/host/fleet'
import { SKILLS_ROUTE as HOST_SKILLS_ROUTE } from '../../src/host/skills'
import { OVERVIEW_ROUTE as HOST_OVERVIEW_ROUTE } from '../../src/host/overview'
import { ATTACHMENT_ROUTE, BACKFILL_ROUTE, BALANCE_ROUTE, COMMANDS_ROUTE, DETAIL_ROUTE, FLEET_ROUTE, OVERVIEW_ROUTE, SKILLS_ROUTE } from '../../src/client/apiRoutes'
import { serviceIdentityOf } from '../../src/host/serviceIdentity'
import z from '@deepseek-ai/schemastery'
import { Config, DEFAULT_BOUNDS, resolveBounds, volatileField } from '../../src/host/config'

describe('backfill-sliced', () => {

interface SavedRecord {
  session: HostSession
  identity: DurableIdentity | null
}

function ownCacheStub(sessions: Map<string, HostSession> = new Map(), captureMissing: string[] = []): OverviewCache & { saved: SavedRecord[] } {
  const saved: SavedRecord[] = []
  return {
    load: async () => ({ sessions, identities: new Map(), rebuild: new Set() }),
    refresh: async () => ({ identities: new Map(), changed: new Set() }),
    capture: async (ids: readonly string[]) => new Map(ids
      .filter(id => !captureMissing.includes(id))
      .map(id => [id, { path: `/repo/${id}.jsonl`, sizeBytes: 10, mtimeMs: 3 }])),
    save: (records: readonly SavedRecord[]) => { saved.push(...records) },
    flush: async () => {},
    dispose: () => {},
    saved,
  } as unknown as OverviewCache & { saved: SavedRecord[] }
}

function activityReference(events: readonly SessionEvent[]): unknown {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => false) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  const values = registry.restore({}, events, 0 as never, { id: 'monster', version: 1, createdAt: 1, cwd: '/repo/monster', isSeeded: false } as never, 0 as never).snapshot.values
  return (values as { contextActivity: unknown }).contextActivity
}

function fakeEvents(length: number): SessionEvent[] {
  return Array.from({ length }, (_, seq) => ({ type: 'todo/write', seq, time: seq + 1, data: {} })) as unknown as SessionEvent[]
}

interface SliceRig {
  route: RouteBox
  writes: Map<string, unknown>
  prepares: string[]
  coldSnapshots: string[]
  restoreCalls: number[]
}

function referenceRows(events: SessionEvent[], id: string): unknown {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => true) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  return registry.restore({}, events, 0 as never, { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false } as never, 0 as never).checkpoint
}

function armSliced(ctx: Context, eventsById: Map<string, SessionEvent[]>, opts: {
  liveOnPrepare?: Set<string>
  failPrepare?: Set<string>
  failWrite?: boolean
  noPrepare?: boolean
  hostileRestoreAt?: number
  stat?: boolean
} = {}): SliceRig {
  const route: RouteBox = {}
  const state = fakeState([...eventsById.keys()].map(id => ({ header: { id, cwd: `/repo/${id}` } })))
  const rig: SliceRig = {
    route,
    writes: new Map(),
    prepares: [],
    coldSnapshots: state.coldSnapshots,
    restoreCalls: [],
  }
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => true) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  const realRestore = registry.restore.bind(registry)
  registry.restore = ((...args: Parameters<typeof realRestore>) => {
    rig.restoreCalls.push((args[1] as SessionEvent[]).length)
    if (opts.hostileRestoreAt !== undefined && rig.restoreCalls.length === opts.hostileRestoreAt) return undefined
    return realRestore(...args)
  }) as typeof registry.restore
  ctx.provide('connection', connectionOf(route))
  ctx.provide('sessionQuery', { listSessions: async () => state.listed })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => undefined,
    coldSnapshot: (header: { id: string }) => {
      state.coldSnapshots.push(header.id)
      return { asOfSeq: 0, values: {} }
    },
    write: async (session: { id: string }) => {
      if (opts.failWrite === true) throw new Error('disk full')
      rig.writes.set(session.id, registry.checkpoint(session as never))
    },
  })
  ctx.provide('sessionPersistence', {
    ...(opts.stat === true ? { stat: async (id: string) => ({ path: `/repo/${id}.jsonl`, sizeBytes: 10, mtimeMs: 3 }) } : {}),
    open: async (id: string) => {
      state.coldReads.push(id)
      return {
        header: { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events: eventsById.get(id) ?? [] }),
        close: async () => {},
      }
    },
  })
  const threwPrepare = new Set<string>()
  const sessionsFace: Record<string, unknown> = {
    get: (id: string) => (state.live.has(id) || threwPrepare.has(id) ? { id } : undefined),
  }
  if (opts.noPrepare !== true) {
    sessionsFace.prepare = (id: string, o: { seed: SessionEvent[]; meta: unknown; inheritedEventCount: number }) => {
      rig.prepares.push(id)
      if (opts.liveOnPrepare?.has(id) === true) {
        threwPrepare.add(id)
        throw new Error(`session "${id}" already exists`)
      }
      if (opts.failPrepare?.has(id) === true) throw new Error(`session "${id}" has a corrupt header`)
      const marker = { type: 'session/end-seed', seq: o.seed.length, time: 1, data: {} } as SessionEvent
      const log = [...o.seed, marker]
      return {
        id,
        header: o.meta,
        inheritedEventCount: o.inheritedEventCount,
        seq: log.length,
        eventAt: (seq: number) => log[seq],
        snapshotEvents: () => log,
      }
    }
  }
  ctx.provide('sessions', sessionsFace)
  return rig
}

describe('the sliced cold fold (issue #145)', () => {
  test('a monster session folds in slices (a dropped restore answer refolds from init) and lands one-shot rows plus the resume marker', async () => {
    const ctx = new Context()
    const events = fakeEvents(4_001)
    const rig = armSliced(ctx, new Map([['monster', events]]), { hostileRestoreAt: 2 })
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(rig.coldSnapshots, [], 'the sliced path never calls coldSnapshot')
    assert.deepEqual(rig.prepares, ['monster'])
    assert.ok(rig.restoreCalls.length >= 3, `expected ≥3 sliced restores, got ${rig.restoreCalls.join(',')}`)
    const marker = { type: 'session/end-seed', seq: events.length, time: 1, data: {} } as SessionEvent
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows([...events, marker], 'monster'), 'sliced rows equal the single-shot rows at the resume-marker cut')
  })

  test('a session at or under the slice threshold, or one without the slice faces, stays on the single-shot coldSnapshot path', async () => {
    const smallCtx = new Context()
    const small = armSliced(smallCtx, new Map([['small', fakeEvents(2_000)]]))
    const disposeSmall = watchActivityBackfill(smallCtx)
    await trigger(small.route)
    await until(() => (small.coldSnapshots.length === 1 ? true : undefined), 'the coldSnapshot ran')
    disposeSmall()
    assert.deepEqual(small.coldSnapshots, ['small'])
    assert.deepEqual(small.prepares, [], 'no prepare for a session at or under the slice threshold')
    assert.deepEqual([...small.writes.keys()], [])

    const bareCtx = new Context()
    const bare = armSliced(bareCtx, new Map([['monster', fakeEvents(4_001)]]), { noPrepare: true })
    const disposeBare = watchActivityBackfill(bareCtx)
    await trigger(bare.route)
    await until(() => (bare.coldSnapshots.length === 1 ? true : undefined), 'the fallback ran')
    disposeBare()
    assert.deepEqual(bare.coldSnapshots, ['monster'], 'no prepare face → single-shot path')
    assert.deepEqual([...bare.writes.keys()], [])
  })

  test('a session going live mid-fold is skipped silently (no write, no warn)', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['racer', fakeEvents(4_001)]]), { liveOnPrepare: new Set(['racer']) })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await new Promise(resolve => setTimeout(resolve, 250))
    dispose()
    assert.deepEqual(rig.prepares, ['racer'])
    assert.deepEqual([...rig.writes.keys()], [], 'no write over a session that went live')
    assert.deepEqual(lines.filter(l => l.level === 'warn'), [], 'a live race never warns')
  })

  test('a prepare failure with the session still cold warns and the run continues', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['broken', fakeEvents(4_001)], ['good', fakeEvents(10)]]), { failPrepare: new Set(['broken']) })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.coldSnapshots.length === 1 ? true : undefined), 'the small session folded')
    dispose()
    assert.deepEqual([...rig.writes.keys()], [])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1, 'the genuine prepare failure keeps the per-session warn')
    assert.match(warns[0].text, /"broken"/)
    assert.match(warns[0].text, /corrupt header/)
    assert.deepEqual(rig.coldSnapshots, ['good'], 'the next session still folds')
  })

  test('a rejecting write-back warns (fail-soft) and the session still counts as folded', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(4_001)]]), { failWrite: true })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (lines.some(l => l.level === 'info' && l.text.includes('backfilled for 1 session(s)')) ? true : undefined), 'the folded count landed')
    dispose()
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0].text, /write-back for "monster" failed/)
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('backfilled for 1 session(s)')), 'the fold itself succeeded')
  })

  test('dispose mid-fold aborts between slices: no write, no completion line', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(6_001)]]) )
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.restoreCalls.length >= 1 ? true : undefined), 'the first slice folded')
    dispose()
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.deepEqual([...rig.writes.keys()], [], 'nothing durable lands mid-fold')
    assert.deepEqual(lines.filter(l => l.level === 'info' && l.text.includes('backfilled')), [], 'the pass stopped quietly')
  })

  test('pacing rests proportionally to measured work and takes a logged recovery pause at the round budget', async () => {
    const ctx = new Context()
    const state = fakeState([1, 2, 3, 4].map(i => ({ header: { id: `s${i}`, cwd: `/repo/s${i}` } })))
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 1_000,
      roundPauseMs: 1_000,
    })
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 4 ? true : undefined), 'all four sessions folded')
    await new Promise(resolve => setTimeout(resolve, 30))
    dispose()
    assert.deepEqual(state.coldSnapshots.sort(), ['s1', 's2', 's3', 's4'])
    assert.deepEqual(sleeps, [400, 400, 1_000, 400])
    const pauses = lines.filter(l => l.level === 'info' && l.text.includes('pausing after'))
    assert.equal(pauses.length, 1, 'the budget pause reports once')
    assert.match(pauses[0].text, /pausing after 1s of fold work; resuming in 1s/)

    const floorCtx = new Context()
    const floorState = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const floorRoute = arm(floorCtx, floorState)
    const floorSleeps: number[] = []
    const disposeFloor = watchActivityBackfill(floorCtx, undefined, {
      now: () => 0,
      sleep: async (ms) => { floorSleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(floorRoute)
    await until(() => (floorState.coldSnapshots.length === 2 ? true : undefined), 'both sessions folded')
    disposeFloor()
    assert.deepEqual(floorSleeps, [25, 25], 'a zero-cost session rests exactly the floor')
  })

  test('sliced folds rest proportionally between slices, billed once across both granularities', async () => {
    const ctx = new Context()
    const rig = armSliced(ctx, new Map([['monster', fakeEvents(4_001)]]) )
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
      sliceBudgetMs: 10_000,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(sleeps, [400, 400, 1_600])
  })

  test('dispose wakes a pending rest early (the pass never waits out a pause); a rest armed after dispose returns at once', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const route = arm(ctx, state)
    let sleeping = false
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => 0,
      sleep: async () => { sleeping = true; await new Promise(() => {}) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(route)
    await until(() => (sleeping ? true : undefined), 'the first rest is pending')
    dispose()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(state.coldSnapshots, ['a'], 'the abort woke the pending rest; the pass stopped without hanging')

    const laterCtx = new Context()
    const laterState = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }, { header: { id: 'b', cwd: '/repo/b' } }])
    const laterRoute = arm(laterCtx, laterState)
    let disposeLater: () => void = () => {}
    let folds = 0
    const gate = {
      admit: <T>(read: () => Promise<T>): Promise<T | undefined> => {
        const p = read()
        folds++
        if (folds === 2) disposeLater()
        return p
      },
    }
    const laterSleeps: number[] = []
    disposeLater = watchActivityBackfill(laterCtx, gate, {
      now: () => 0,
      sleep: async (ms) => { laterSleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
    })
    await trigger(laterRoute)
    await until(() => (laterState.coldSnapshots.length === 2 ? true : undefined), 'both sessions folded')
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(laterSleeps, [25], 'a rest armed after dispose returns at once')
  })

  test('a budget trip inside one monster session pauses mid-fold and still completes the exact rows', async () => {
    const ctx = new Context()
    const events = fakeEvents(4_001)
    const rig = armSliced(ctx, new Map([['monster', events]]))
    const lines = captureLogs(ctx)
    const sleeps: number[] = []
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async (ms) => { sleeps.push(ms) },
      minRestMs: 25,
      workBudgetMs: 800,
      roundPauseMs: 2_000,
      sliceBudgetMs: 10_000,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(sleeps, [400, 2_000, 2_000])
    const pauses = lines.filter(l => l.level === 'info' && l.text.includes('pausing after'))
    assert.equal(pauses.length, 2)
    assert.match(pauses[0].text, /pausing after 1s of fold work; resuming in 2s/)
    const marker = { type: 'session/end-seed', seq: events.length, time: 1, data: {} } as SessionEvent
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows([...events, marker], 'monster'), 'pauses never change the rows')
  })

  test('the slice size adapts to the measured cost and still lands the exact rows', async () => {
    const ctx = new Context()
    const events = fakeEvents(4_001)
    const rig = armSliced(ctx, new Map([['monster', events]]))
    let clock = 0
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => (clock += 400),
      sleep: async () => {},
      minRestMs: 25,
      workBudgetMs: 60_000,
      roundPauseMs: 2_000,
      sliceBudgetMs: 150,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(rig.restoreCalls.slice(0, 11), [2_000, 2_750, 3_031, 3_159, 3_287, 3_415, 3_543, 3_671, 3_799, 3_927, 4_001])
    const marker = { type: 'session/end-seed', seq: events.length, time: 1, data: {} } as SessionEvent
    assert.deepStrictEqual(rig.writes.get('monster'), referenceRows([...events, marker], 'monster'), 'shrunk slices never change the rows')
  })

  test('nextSliceSize shrinks over budget, floors, grows when cheap, and holds in band', () => {
    assert.equal(nextSliceSize(2_000, 400, 150), 750)
    assert.equal(nextSliceSize(200, 1_000, 150), 128)
    assert.equal(nextSliceSize(500, 10, 150), 1_000)
    assert.equal(nextSliceSize(500, 50, 150), 500)
    assert.equal(nextSliceSize(500, 0, 150), 1_000)
    assert.equal(nextSliceSize(4_000, 10, 150), 2_000)
  })

  test('a session over the worker threshold folds off-thread and lands only in the plugin cache', async () => {
    const ctx = new Context()
    const events = [...fakeEvents(30_001), userMessage(30_001, [{ type: 'text', text: 'prompt' }], { kind: 'user' }, { time: 500 }) as unknown as SessionEvent]
    const rig = armSliced(ctx, new Map([['monster', events]]), { stat: true })
    const ownCache = ownCacheStub()
    const pool = inProcessPool()
    const dispose = watchActivityBackfill(ctx, undefined, undefined, { ownCache, config: {}, pool })
    await trigger(rig.route)
    await until(() => (ownCache.saved.length === 1 ? true : undefined), 'the plugin-cache row landed')
    dispose()
    assert.deepEqual([...rig.writes.keys()], [], 'the harness projection cache stays untouched')
    assert.deepEqual(rig.restoreCalls, [], 'the host thread never folds')
    const record = ownCache.saved[0]
    assert.equal(record.session.id, 'monster')
    assert.equal(record.session.blank, false, 'the prompt marks the session non-blank')
    assert.equal(record.session.updatedAt, 500)
    assert.equal(record.identity?.path, '/repo/monster.jsonl')
    assert.deepStrictEqual(record.session.activity, activityOf(activityReference(events)))
    assert.ok(record.session.timeline !== null)
    pool.dispose()
  })

  test('a missing durable identity still lands the worker row with an identity-less signature', async () => {
    const ctx = new Context()
    const events = fakeEvents(30_001)
    const rig = armSliced(ctx, new Map([['monster', events]]), { stat: true })
    const ownCache = ownCacheStub(new Map(), ['monster'])
    const pool = inProcessPool()
    const dispose = watchActivityBackfill(ctx, undefined, undefined, { ownCache, config: {}, pool })
    await trigger(rig.route)
    await until(() => (ownCache.saved.length === 1 ? true : undefined), 'the plugin-cache row landed')
    dispose()
    assert.equal(ownCache.saved[0].identity, null)
    assert.ok(ownCache.saved[0].session.signature.startsWith('C'))
    assert.equal(ownCache.saved[0].session.blank, true, 'a promptless session lands blank')
    pool.dispose()
  })

  test('oversize sessions without the worker seam fold on the host thread', async () => {
    const ctx = new Context()
    const events = fakeEvents(30_001)
    const rig = armSliced(ctx, new Map([['monster', events]]))
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => performance.now(),
      sleep: async () => {},
      minRestMs: 0,
      workBudgetMs: 600_000,
      roundPauseMs: 1_000,
    })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the host-thread fold landed')
    dispose()
    assert.ok(rig.restoreCalls.length > 1, 'the sliced fold ran')
  })

  test('an abort during a worker fold lands nothing', async () => {
    const ctx = new Context()
    const events = fakeEvents(30_001)
    const rig = armSliced(ctx, new Map([['monster', events]]), { stat: true })
    const ownCache = ownCacheStub()
    let rejectFold!: (error: Error) => void
    const pool = {
      fold: () => new Promise((_resolve, reject) => { rejectFold = reject }),
      dispose: () => {},
    } as unknown as FoldPool
    const handle = watchActivityBackfill(ctx, undefined, undefined, { ownCache, config: {}, pool })
    await trigger(rig.route)
    await until(() => (rejectFold !== undefined ? true : undefined), 'the worker fold started')
    handle()
    rejectFold(new Error('worker died'))
    await new Promise(resolve => setTimeout(resolve, 40))
    assert.deepEqual(ownCache.saved, [], 'the aborted fold left no plugin-cache row')
    assert.deepEqual([...rig.writes.keys()], [], 'the aborted fold left no write-back')
  })

  test('a worker fold failure falls back to the host-thread sliced fold', async () => {
    const ctx = new Context()
    const events = fakeEvents(30_001)
    const rig = armSliced(ctx, new Map([['monster', events]]), { stat: true })
    const lines = captureLogs(ctx)
    const ownCache = ownCacheStub()
    const dispose = watchActivityBackfill(ctx, undefined, {
      now: () => performance.now(),
      sleep: async () => {},
      minRestMs: 0,
      workBudgetMs: 600_000,
      roundPauseMs: 1_000,
    }, { ownCache, config: {} })
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the sliced fallback landed')
    dispose()
    assert.deepEqual(ownCache.saved, [], 'the failed worker left no plugin-cache row')
    const warns = lines.filter(l => l.level === 'warn' && l.text.includes('worker fold for "monster" failed'))
    assert.equal(warns.length, 1)
  })

  test('a session already warm in the plugin cache skips the read entirely', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'warm', cwd: '/repo/warm' } },
      { header: { id: 'cold', cwd: '/repo/cold' } },
      { header: { id: 'nocwd' } },
    ])
    const route = arm(ctx, state)
    const warm = { id: 'warm', title: 'Warm', updatedAt: 1, blank: false, timeline: null, activity: null, signature: '' }
    const ownCache = ownCacheStub(new Map([['warm', warm]]))
    const dispose = watchActivityBackfill(ctx, undefined, undefined, { ownCache })
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'only the cold session folded')
    dispose()
    assert.deepEqual(state.coldReads, ['cold'])
    assert.deepEqual(state.coldSnapshots, ['cold'])
  })
})
})

describe('apiRoutes', () => {

describe('apiRoutePairing', () => {
  test('each client fetch route is its host registration minus the leading slash', () => {
    for (const [host, client] of [
      [HOST_DETAIL_ROUTE, DETAIL_ROUTE],
      [HOST_COMMANDS_ROUTE, COMMANDS_ROUTE],
      [HOST_BALANCE_ROUTE, BALANCE_ROUTE],
      [HOST_FLEET_ROUTE, FLEET_ROUTE],
      [HOST_SKILLS_ROUTE, SKILLS_ROUTE],
      [HOST_BACKFILL_ROUTE, BACKFILL_ROUTE],
      [HOST_ATTACHMENT_ROUTE, ATTACHMENT_ROUTE],
      [HOST_OVERVIEW_ROUTE, OVERVIEW_ROUTE],
    ]) {
      assert.equal(client, host.slice(1), `${host} and ${client} lost their pairing`)
    }
  })
})
})

describe('serviceIdentity', () => {

describe('serviceIdentityOf', () => {
  test('uses the stable identity of a re-bound service wrapper', () => {
    assert.equal(serviceIdentityOf({ identity: 'persistence-1', generation: 1 }), 'persistence-1')
    assert.equal(serviceIdentityOf({ identity: 'persistence-1', generation: 2 }), 'persistence-1')
  })

  test('falls back to the value itself when no identity is exposed', () => {
    const service = { id: 'persistence' }
    assert.equal(serviceIdentityOf(service), service)
    assert.equal(serviceIdentityOf(undefined), undefined)
    assert.equal(serviceIdentityOf('persistence'), 'persistence')
  })
})
})

describe('config', () => {

function deref(value: unknown): unknown {
  return value !== null && typeof value === 'object' && typeof (value as { get?: unknown }).get === 'function'
    ? (value as { get: () => unknown }).get()
    : value
}

describe('Config validator (cordis Standard Schema face)', () => {
  test('an absent config resolves to defaults; each bounds field overrides independently', () => {
    const resolved = Config(undefined) as unknown as Record<string, unknown>
    const resolvedPrefs = Object.fromEntries(
      Object.entries(resolved).map(([key, value]) => [key, deref(value)]),
    )
    assert.deepEqual(resolvedPrefs, {
      ...DEFAULT_BOUNDS,
      defaultPlacement: 'all',
      defaultGranularity: 'step',
      defaultTrendMode: 'total',
      defaultDeltaBase: 'step',
      defaultToolSort: 'count',
      defaultFileSort: 'lines',
      insightsEntry: 'show',
      defaultDurationCurve: 'show',
      overviewAutoSteps: '100',
      defaultOverviewRange: '30d',
      fleetTab: 'show',
      promptPrefix: '',
      promptSuffix: '',
    })
    assert.deepEqual(resolveBounds(undefined), DEFAULT_BOUNDS)
    assert.deepEqual(resolveBounds({}), DEFAULT_BOUNDS)
    assert.equal(resolveBounds({ maxRequestSteps: 7 }).maxRequestSteps, 7)
    assert.equal(resolveBounds({ maxKeptTurns: 7 }).maxKeptTurns, 7)
    assert.equal(resolveBounds({ maxEvents: 7 }).maxEvents, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxNodes, 7)
    assert.equal(resolveBounds({ maxArchiveNodes: 7 }).maxArchiveNodes, 7)
    assert.equal(resolveBounds({ maxNodes: 7 }).maxEvents, DEFAULT_BOUNDS.maxEvents)
  })

  test('rejects bounds below 1, non-integers, and non-numbers', () => {
    assert.throws(() => Config({ maxRequestSteps: 0 }))
    assert.throws(() => Config({ maxNodes: -1 }))
    assert.throws(() => Config({ maxEvents: 1.5 }))
    assert.throws(() => Config({ maxKeptTurns: '300' } as unknown as Config))
  })

  test('unknown keys merge through (schemastery objects are not key-strict)', () => {
    assert.equal(deref(Config({ unknown: 1 } as unknown as Config).maxEvents), DEFAULT_BOUNDS.maxEvents)
  })
})

describe('preference fields (the Config-form generation surface)', () => {
  test('every preference is volatile-marked; the bounds are not', () => {
    const dict = Config.dict ?? {}
    for (const pref of ['defaultPlacement', 'defaultGranularity', 'defaultTrendMode', 'defaultDeltaBase', 'defaultToolSort', 'defaultFileSort', 'insightsEntry', 'defaultDurationCurve', 'overviewAutoSteps', 'defaultOverviewRange', 'fleetTab', 'promptPrefix', 'promptSuffix']) {
      assert.equal((dict[pref] as z['dict'] extends undefined ? never : { meta?: { volatile?: boolean } }).meta?.volatile, true, pref)
    }
    for (const bound of ['maxRequestSteps', 'maxKeptTurns', 'maxEvents', 'maxNodes', 'maxArchiveNodes', 'maxFileOps']) {
      assert.notEqual((dict[bound] as { meta?: { volatile?: boolean } }).meta?.volatile, true, bound)
    }
  })

  test('preferences resolve to defaults, stale values degrade, and stored values survive', () => {
    const resolved = Config({ defaultGranularity: 'bogus', overviewAutoSteps: '50', defaultOverviewRange: 'bogus', promptPrefix: 7, promptSuffix: {} } as unknown as Config)
    assert.equal(deref(resolved.defaultGranularity), 'step')
    assert.equal(deref(resolved.overviewAutoSteps), '100')
    assert.equal(deref(resolved.defaultOverviewRange), '30d')
    assert.equal(deref(resolved.promptPrefix), '', 'a non-string prompt value degrades to the empty default')
    assert.equal(deref(resolved.promptSuffix), '')
    const stored = Config({ defaultPlacement: 'hide', defaultFileSort: 'count', insightsEntry: 'hide', overviewAutoSteps: 'off', defaultOverviewRange: '7d', fleetTab: 'hide', promptPrefix: 'Be terse.', promptSuffix: 'Sign as Atlas.' }) as unknown as Record<string, unknown>
    assert.deepEqual(
      ['defaultPlacement', 'defaultFileSort', 'insightsEntry', 'overviewAutoSteps', 'defaultOverviewRange', 'fleetTab', 'promptPrefix', 'promptSuffix'].map(key => deref(stored[key])),
      ['hide', 'count', 'hide', 'off', '7d', 'hide', 'Be terse.', 'Sign as Atlas.'],
    )
  })
})

describe('volatileField', () => {
  test('marks the field where schemastery ships the modifier; returns it unchanged on an older schemastery', () => {
    assert.equal(volatileField(z.union(['a', 'b']).default('a')).meta?.volatile, true)
    const plain = z.union(['a', 'b']).default('a')
    const legacy = { meta: plain.meta } as typeof plain
    assert.equal(volatileField(legacy), legacy)
    assert.equal(legacy.meta?.volatile, undefined)
  })
})
})
