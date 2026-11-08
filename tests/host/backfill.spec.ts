import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { interruptedTurnClosers } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { BACKFILL_ROUTE, watchActivityBackfill } from '../../src/host/backfill'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { createContextActivityDefinition } from '../../src/host/activity'
import { createContextHeadersDefinition } from '../../src/host/headers'
import { arm, captureLogs, coldFaces, connectionOf, fakeState, trigger, unsupportedFormatError, until } from './helpers/backfill'
import type { RouteBox } from './helpers/backfill'

const settle = (ms = 30): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const FAST_PACING = {
  now: () => performance.now(),
  sleep: () => Promise.resolve(),
  minRestMs: 1,
  workBudgetMs: 1_000_000,
  roundPauseMs: 1,
}

function crashTailEvents(filler: number): SessionEvent[] {
  const events: SessionEvent[] = Array.from({ length: filler }, (_, seq) => ({
    type: 'todo/write', seq, time: seq + 1, data: {},
  })) as unknown as SessionEvent[]
  const base = filler
  const tail = [
    { type: 'turn/start', seq: base, time: base + 1, data: { turn: 1 } },
    { type: 'step/start', seq: base + 1, time: base + 2, data: { turn: 1, step: 1 } },
    {
      type: 'user/message',
      seq: base + 2,
      time: base + 3,
      data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'run it' }], source: { kind: 'user' } },
      surfaceOp: 'append',
    },
    {
      type: 'assistant/message',
      seq: base + 3,
      time: base + 4,
      data: {
        turn: 1,
        step: 1,
        message: {
          id: 'a1',
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"true"}' }],
          source: { kind: 'model', provider: 'p', model: 'm' },
        },
        stream: [],
        usage: { inputTokens: 1, outputTokens: 1 },
      },
      surfaceOp: 'append',
    },
    {
      type: 'tool/call',
      seq: base + 4,
      time: base + 5,
      data: { turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"true"}' },
    },
  ]
  return [...events, ...tail as unknown as SessionEvent[]]
}

function fakePersistence(events: SessionEvent[], stat?: (id: string) => Promise<unknown>, opened?: string[]) {
  return {
    open: async (id: string) => {
      opened?.push(id)
      return {
        header: { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false },
        inheritedEventCount: 0,
        read: async () => ({ events }),
        close: async () => {},
      }
    },
    ...(stat === undefined ? {} : { stat }),
  }
}

interface SlicedRig {
  route: RouteBox
  writes: Map<string, Record<string, { seq: number }>>
  hydrateCuts: number[]
  prepareCuts: number[]
}

function slicedRig(ctx: Context, eventsById: Map<string, SessionEvent[]>): SlicedRig {
  const route: RouteBox = {}
  const state = fakeState([...eventsById.keys()].map(id => ({ header: { id, cwd: `/repo/${id}` } })))
  const rig: SlicedRig = { route, writes: new Map(), hydrateCuts: [], prepareCuts: [] }
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition({}, () => true) as never)
  registry.register(createContextActivityDefinition() as never)
  registry.register(createContextHeadersDefinition() as never)
  const hydrate = registry.hydrate.bind(registry)
  registry.hydrate = ((session: never, checkpoint: never, events: SessionEvent[], baseSeq: never) => {
    rig.hydrateCuts.push(events.at(-1)?.seq ?? -1)
    return hydrate(session, checkpoint, events, baseSeq)
  }) as typeof registry.hydrate
  ctx.provide('connection', connectionOf(route))
  ctx.provide('sessionQuery', { listSessions: async () => state.listed })
  ctx.provide('sessionProjectionCache', {
    cachedSnapshot: () => undefined,
    coldSnapshot: () => { throw new Error('the sliced path never calls coldSnapshot') },
    write: async (session: { id: string }) => {
      rig.writes.set(session.id, registry.checkpoint(session as never) as never)
    },
  })
  ctx.provide('sessionPersistence', {
    open: async (id: string) => ({
      header: { id, version: 1, createdAt: 1, cwd: `/repo/${id}`, isSeeded: false },
      inheritedEventCount: 0,
      read: async () => ({ events: eventsById.get(id) ?? [] }),
      close: async () => {},
    }),
    stat: async () => ({ eventCount: 0 }),
  })
  ctx.provide('sessions', {
    get: () => undefined,
    prepare: (id: string, o: { seed: SessionEvent[]; meta: unknown; inheritedEventCount: number }) => {
      rig.prepareCuts.push(o.seed.at(-1)?.seq ?? -1)
      const marker = { type: 'session/end-seed', seq: o.seed.length, time: Date.now(), data: {} } as SessionEvent
      const log = [...o.seed, marker]
      return {
        id,
        header: o.meta,
        inheritedEventCount: o.inheritedEventCount,
        seq: log.length,
        eventAt: (seq: number) => log[seq],
        snapshotEvents: () => log,
      }
    },
  })
  return rig
}

describe('watchActivityBackfill', () => {
  test('without a connection route, or with a half that never registers, the pass stays unarmed', async () => {
    const bare = new Context()
    const bareState = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    coldFaces(bare, bareState)
    const disposeBare = watchActivityBackfill(bare)
    await settle()
    disposeBare()
    assert.deepEqual(bareState.coldReads, [], 'no trigger route — no cold read')
    for (const connection of [
      { notFetch: true },
      { fetch: { notRegister: true } },
      { fetch: { register: () => { throw new Error('registry hostile') } } },
    ]) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      ctx.provide('connection', connection)
      coldFaces(ctx, state)
      const dispose = watchActivityBackfill(ctx)
      await settle()
      dispose()
      assert.deepEqual(state.coldReads, [], 'a route half that never registers leaves the pass unarmed')
    }
  })

  test('incomplete faces are re-proved away — an armed request waits, then never launches', async () => {
    for (const [label, overrides] of [
      ['query without listSessions', { sessionQuery: { notListSessions: true } }],
      ['cache without cachedSnapshot', { sessionProjectionCache: { coldSnapshot: () => ({}) } }],
      ['cache without coldSnapshot', { sessionProjectionCache: { cachedSnapshot: () => undefined } }],
      ['persistence without open', { sessionPersistence: { notOpen: true } }],
      ['non-record faces', { sessionQuery: 7, sessionProjectionCache: 7, sessionPersistence: 7 }],
    ] as const) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      const route: RouteBox = {}
      ctx.provide('connection', connectionOf(route))
      coldFaces(ctx, state, overrides)
      const dispose = watchActivityBackfill(ctx)
      await trigger(route)
      await settle(20)
      dispose()
      assert.deepEqual(state.coldReads, [], label)
    }
  })

  test('the probe passes its keys: a served row skips the cold read while a version-stale activity-only row refolds', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'stale', cwd: '/repo/stale' } },
    ])
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: (header: { id: string }, keys?: unknown) => {
          assert.ok(Array.isArray(keys), 'the probe passes the keys as the second argument')
          if (header.id === 'b') return { asOfSeq: 0, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
          if (header.id === 'stale') return { asOfSeq: 0, values: { contextActivity: { days: {} } } }
          return undefined
        },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the stale session refolded')
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, ['stale'], 'the served row skips the cold read; the version-stale timeline row does not')
    assert.deepEqual(state.coldSnapshots, ['stale'])
  })

  test('a non-array listing ends the run without work', async () => {
    const ctx = new Context()
    const state = fakeState({ not: 'an array' })
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: { listSessions: async () => { listed++; return state.listed } },
    })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed === 1 ? true : undefined), 'the corpus was listed')
    await settle()
    dispose()
    assert.deepEqual(state.coldReads, [])
    assert.deepEqual(state.coldSnapshots, [])
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'a non-list answer ends the pass without a fold line')
  })

  test('a fully-served corpus folds nothing and logs no backfilled line', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    state.served.add('a')
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: { listSessions: async () => { listed++; return state.listed } },
    })
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (listed === 1 ? true : undefined), 'the corpus was listed')
    await settle(60)
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing was read')
    assert.deepEqual(state.coldSnapshots, [], 'nothing was folded')
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'the served row suppresses the fold count line')
  })

  test('an admission refused from the first read folds nothing and logs exactly one heap-pressure line', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'b', cwd: '/repo/b' } },
    ])
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx, { admit: () => Promise.resolve(undefined) })
    await trigger(route)
    await until(() => (lines.some(l => l.text.includes('heap pressure')) ? true : undefined), 'the early-stop line')
    await settle(20)
    dispose()
    assert.deepEqual(state.coldReads, [], 'nothing was read')
    assert.deepEqual(state.coldSnapshots, [], 'nothing was folded')
    assert.equal(lines.filter(l => l.text.includes('heap pressure')).length, 1, 'one line, not one per session')
    assert.deepEqual(lines.filter(l => l.text.includes('backfilled')), [], 'no fold, no fold count line')
  })

  test('a throwing cachedSnapshot probe reads as not-served and backfills a hostile read answer', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: () => { throw new Error('identity mismatch') },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: 'garbage' }),
          close: async () => {},
        }),
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the fold ran')
    dispose()
    assert.deepEqual(state.coldSnapshots, ['a'])
  })

  test('sessions missing their row get one cold read each; served, live, and malformed ones skip', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'e' } },
      { header: { id: '' } },
      { header: 7 },
      null,
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'd', cwd: '/repo/d' } },
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    state.served.add('b')
    state.live.add('d')
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length >= 2 ? true : undefined), 'two cold folds')
    await settle(60)
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['a', 'c'])
    assert.deepEqual(state.coldSnapshots.sort(), ['a', 'c'])
  })

  test('failures stay per-session: a generic error and a hostile error warn, migration refusals drop to ONE debug summary', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'bad', cwd: '/repo/bad' } },
      { header: { id: 'legacy-1', cwd: '/repo/legacy-1' } },
      { header: { id: 'legacy-2', cwd: '/repo/legacy-2' } },
      { header: { id: 'hostile', cwd: '/repo/hostile' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    state.failReads.set('bad', new Error('no such session bad'))
    state.failReads.set('legacy-1', unsupportedFormatError('SessionFormatUnsupportedError'))
    state.failReads.set('legacy-2', unsupportedFormatError('SessionFormatUnsupportedMigrationError'))
    state.failReads.set('hostile', {
      get name(): string { throw new Error('no name for you') },
      toString(): string { throw new Error('no string for you') },
    })
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    await until(() => (lines.filter(l => l.level === 'info').length >= 2 ? true : undefined), 'the summary lines landed')
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['bad', 'good', 'hostile', 'legacy-1', 'legacy-2'])
    assert.deepEqual(state.coldSnapshots, ['good'])
    const warns = lines.filter(l => l.level === 'warn')
    assert.equal(warns.length, 2, 'the generic and the hostile failure each keep their own warn')
    assert.ok(warns.some(w => /"bad"/.test(w.text)))
    assert.ok(warns.some(w => /unprintable error/.test(w.text)))
    assert.deepEqual(lines.filter(l => l.level === 'warn').filter(l => /legacy/.test(l.text)), [], 'a migration refusal never warns')
    const debugs = lines.filter(l => l.level === 'debug')
    assert.equal(debugs.length, 2, 'each refused session keeps a debug detail')
    const infos = lines.filter(l => l.level === 'info')
    assert.equal(infos.length, 2, 'the folded count and ONE skip summary for the whole pass')
    assert.match(infos[0].text, /backfilled for 1 session\(s\)/)
    assert.match(infos[1].text, /skipped 2 session\(s\)/)
    assert.match(infos[1].text, /sources left unchanged/)
  })

  test('a mid-read failure closes the handle (a close failure adds nothing) and the run continues', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'torn', cwd: '/repo/torn' } },
      { header: { id: 'good', cwd: '/repo/good' } },
    ])
    let closes = 0
    const route = arm(ctx, state, {
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: id === 'torn'
            ? async () => { throw new Error('torn tail') }
            : async () => ({ events: [] }),
          close: async () => {
            closes++
            if (id === 'torn') throw new Error('close failed too')
          },
        }),
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the good session folded')
    dispose()
    assert.equal(closes, 2, 'both handles closed — the torn one before the error propagated')
    assert.deepEqual(state.coldSnapshots, ['good'])
  })

  test('the route answers ok with coverage, and a later POST reruns the pass over the warm corpus', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    let listed = 0
    const route = arm(ctx, state, {
      sessionQuery: {
        listSessions: async () => {
          listed++
          return state.listed
        },
      },
    })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    assert.deepEqual(handle.coverage(), { complete: false, remaining: 0, failed: 0, running: false, total: 0, covered: 0, unsupported: 0 })
    assert.equal(handle.version(), 0)
    const first = await trigger(route)
    assert.equal(route.path, BACKFILL_ROUTE)
    const firstBody = await first.json() as { ok: boolean; coverage: { running: boolean } }
    assert.equal(firstBody.ok, true)
    assert.equal(firstBody.coverage.running, true, 'the reply carries the running coverage')
    await until(() => (handle.coverage().complete ? true : undefined), 'the first pass finished')
    assert.deepEqual(handle.coverage(), { complete: true, remaining: 0, failed: 0, running: false, total: 1, covered: 1, unsupported: 0 })
    assert.equal(handle.version(), 1)
    state.served.add('a')
    const second = await trigger(route)
    const secondBody = await second.json() as { ok: boolean; coverage: { complete: boolean; running: boolean } }
    assert.equal(secondBody.ok, true)
    await until(() => (listed >= 2 ? true : undefined), 'the verified rerun listed the corpus')
    await until(() => (!handle.coverage().running ? true : undefined), 'the verified-warm rerun ends without probing')
    assert.deepEqual(handle.coverage(), { complete: true, remaining: 0, failed: 0, running: false, total: 1, covered: 1, unsupported: 0 })
    assert.deepEqual(state.coldReads, ['a'], 'the warm session is not read again')
    assert.equal(handle.version(), 1, 'a skipped pass keeps the revision')
    ;(state.listed as { header: Record<string, unknown> }[]).push({ header: { id: 'new', cwd: '/repo/new' } })
    await trigger(route)
    await until(() => (listed >= 3 ? true : undefined), 'a corpus change starts a new pass')
    await until(() => (!handle.coverage().running ? true : undefined), 'the corpus-change pass finished')
    assert.equal(handle.version(), 2, 'the new folded row bumped the version')
    assert.deepEqual(state.coldReads, ['a', 'new'], 'only the new session was folded')
    handle()
  })

  test('a POST during a running pass coalesces into exactly one rerun', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'slow', cwd: '/repo/slow' } }])
    let listed = 0
    let gate: (() => void) | null = null
    let opens = 0
    const route = arm(ctx, state, {
      sessionQuery: {
        listSessions: async () => {
          listed++
          return state.listed
        },
      },
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => {
            opens++
            if (opens > 1) return { events: [] }
            return new Promise((resolve) => {
              gate = () => resolve({ events: [] })
            })
          },
          close: async () => {},
        }),
      },
    })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    await until(() => (gate !== null ? true : undefined), 'the first pass opened its log')
    await trigger(route)
    await trigger(route)
    gate!()
    await until(() => (listed >= 2 ? true : undefined), 'the coalesced rerun listed the corpus')
    await settle()
    assert.equal(opens, 1, 'the verified-complete rerun never re-opens cold logs')
    assert.equal(listed, 2, 'two queued POSTs share one rerun')
    assert.equal(handle.version(), 1, 'the skipped rerun keeps the version')
    handle()
  })

  test('a route hit BEFORE the cold-path faces compose still launches the pass (either half first)', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    const route: RouteBox = {}
    ctx.provide('connection', connectionOf(route))
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    coldFaces(ctx, state)
    await until(() => (state.coldSnapshots.length === 1 ? true : undefined), 'the delayed pass ran')
    dispose()
    assert.deepEqual(state.coldReads, ['a'])
  })

  test('dispose aborts the pass mid-loop', async () => {
    const ctx = new Context()
    const many = Array.from({ length: 50 }, (_, i) => ({ header: { id: `s${i}`, cwd: '/repo' } }))
    const state = fakeState(many)
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldReads.length >= 1 ? true : undefined), 'the run started')
    dispose()
    const seen = state.coldReads.length
    await settle()
    assert.ok(state.coldReads.length <= seen + 1, 'no further sessions read after abort')
  })

  test('a missing sessions face folds, while a throwing live probe skips conservatively', async () => {
    for (const [label, sessions, folded] of [
      ['present-but-undefined', undefined, true],
      ['throwing get', { get: () => { throw new Error('registry broken') } }, false],
    ] as const) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      const route: RouteBox = {}
      ctx.provide('connection', connectionOf(route))
      coldFaces(ctx, state, { sessions })
      const dispose = watchActivityBackfill(ctx)
      await trigger(route)
      if (folded) await until(() => (state.coldSnapshots.length === 1 ? true : undefined), label)
      else await settle(80)
      dispose()
      assert.deepEqual(state.coldReads, folded ? ['a'] : [], label)
    }
  })

  test('a listing rejection is contained; after dispose it stays silent', async () => {
    const liveCtx = new Context()
    const liveRoute: RouteBox = {}
    let listed = 0
    liveCtx.provide('connection', connectionOf(liveRoute))
    coldFaces(liveCtx, fakeState([]), {
      sessionQuery: {
        listSessions: async () => {
          listed++
          throw new Error('corpus down')
        },
      },
    })
    const liveLines = captureLogs(liveCtx)
    const disposeLive = watchActivityBackfill(liveCtx)
    await trigger(liveRoute)
    await until(() => (listed > 0 ? true : undefined), 'the corpus was queried')
    await settle()
    disposeLive()
    assert.ok(liveLines.some(l => l.level === 'warn' && /stopped early/.test(l.text)), 'an unarmed rejection warns')

    const abortCtx = new Context()
    const abortRoute: RouteBox = {}
    let started = false
    let rejectListed: (error: Error) => void = () => {}
    abortCtx.provide('connection', connectionOf(abortRoute))
    coldFaces(abortCtx, fakeState([]), {
      sessionQuery: {
        listSessions: async () => new Promise((_resolve, reject) => {
          started = true
          rejectListed = reject
        }),
      },
    })
    const abortLines = captureLogs(abortCtx)
    const disposeAbort = watchActivityBackfill(abortCtx)
    await trigger(abortRoute)
    await until(() => (started ? true : undefined), 'the run listed the corpus')
    disposeAbort()
    rejectListed(new Error('corpus down'))
    await settle(20)
    assert.deepEqual(abortLines.filter(l => l.level === 'warn'), [], 'the unload owns the silence')
  })

  test('every cold read runs through the shared gate, and a skip stops the pass early', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'b', cwd: '/repo/b' } },
      { header: { id: 'c', cwd: '/repo/c' } },
    ])
    const route = arm(ctx, state)
    const lines = captureLogs(ctx)
    let admitted = 0
    const dispose = watchActivityBackfill(ctx, {
      admit: <T>(read: () => Promise<T>): Promise<T | undefined> => {
        admitted++
        return admitted === 1 ? read() : Promise.resolve(undefined)
      },
    })
    await trigger(route)
    await until(() => (lines.some(l => l.text.includes('heap pressure')) ? true : undefined), 'the early-stop line')
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, ['a'], 'the pass stopped at the first skip')
    assert.deepEqual(state.coldSnapshots, ['a'], 'the folded session kept its row')
    assert.equal(admitted, 2, 'one run plus one skip — the loop did not hammer the gate')
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('backfilled for 1 session(s)')), 'the folded count still reports')
    assert.ok(lines.some(l => l.level === 'info' && l.text.includes('stopped early under heap pressure')), 'the early stop reports once')
  })

  test('a crash-tailed log is written from the durable stored events: no synthetic closer reaches the cold write-back', async () => {
    const ctx = new Context()
    const durable = crashTailEvents(0)
    const durableLast = durable.at(-1)?.seq
    assert.ok(interruptedTurnClosers(durable).length > 0, 'the fixture ends in an open turn with an unanswered call')
    const state = fakeState([{ header: { id: 'crash', cwd: '/repo/crash' } }])
    const written: SessionEvent[] = []
    let coldCalls = 0
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: () => undefined,
        coldSnapshot: (_header: unknown, _inheritedEventCount: unknown, events: SessionEvent[]) => {
          coldCalls++
          written.push(...events)
          return {}
        },
      },
      sessionPersistence: fakePersistence(durable),
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (coldCalls === 1 ? true : undefined), 'the cold fold ran')
    dispose()
    assert.deepEqual(written.map(event => event.seq), durable.map(event => event.seq), 'the write-back sees the durable log verbatim')
    assert.equal(written.at(-1)?.seq, durableLast)
  })

  test('the sliced write-back folds the durable seed and lands only the deterministic resume marker above it', async () => {
    const ctx = new Context()
    const durable = crashTailEvents(4_000)
    const durableLast = durable.at(-1)?.seq ?? -1
    assert.ok(interruptedTurnClosers(durable).length > 0, 'the fixture ends in an open turn with an unanswered call')
    const rig = slicedRig(ctx, new Map([['monster', durable]]))
    const dispose = watchActivityBackfill(ctx)
    await trigger(rig.route)
    await until(() => (rig.writes.has('monster') ? true : undefined), 'the write-back landed')
    dispose()
    assert.deepEqual(rig.prepareCuts, [durableLast], 'the prepared seed ends at the durable cut')
    assert.deepEqual(rig.hydrateCuts, [durableLast], 'hydrate folds only the durable cut')
    const rows = Object.values(rig.writes.get('monster') ?? {})
    assert.ok(rows.length > 0, 'the write-back carries at least one projection row')
    for (const row of rows) assert.ok(row.seq <= durableLast + 1, `row seq ${row.seq} exceeds the durable end plus its resume marker`)
    assert.ok(rows.some(row => row.seq === durableLast + 1), 'the prepared session cursor carries the constructor resume marker')
  })

  test('a row at the durable end stays served while rows behind or ahead of it refold', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'fresh', cwd: '/repo/fresh' } },
      { header: { id: 'behind', cwd: '/repo/behind' } },
      { header: { id: 'ahead', cwd: '/repo/ahead' } },
      { header: { id: 'marker', cwd: '/repo/marker' } },
    ])
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: (header: { id: string }) => {
          const asOfSeq = header.id === 'behind' ? 1 : header.id === 'ahead' ? 5 : header.id === 'marker' ? 3 : 2
          return { asOfSeq, values: { contextActivity: { days: {} }, contextTimeline: { ok: true } } }
        },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
      sessionPersistence: fakePersistence([], async () => ({ eventCount: 3 }), state.coldReads),
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length >= 2 ? true : undefined), 'the stale rows refolded')
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['ahead', 'behind'])
    assert.deepEqual(state.coldSnapshots.sort(), ['ahead', 'behind'])
  })

  test('a no-stat backend keeps the presence check: a watermark that would look stale is served', async () => {
    const ctx = new Context()
    const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
    state.served.add('a')
    const route = arm(ctx, state)
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, [], 'no stat face means a present row is warm')
  })

  test('a backend whose stat never reports an event count is probed once per run', async () => {
    const ctx = new Context()
    const state = fakeState(['a', 'b', 'c'].map(id => ({ header: { id, cwd: `/repo/${id}` } })))
    for (const id of ['a', 'b', 'c']) state.served.add(id)
    let probes = 0
    const route = arm(ctx, state, {
      sessionPersistence: fakePersistence([], async () => { probes++; return { header: { id: 'x' } } }),
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await settle(40)
    dispose()
    assert.deepEqual(state.coldReads, [], 'presence keeps every served row warm')
    assert.equal(probes, 1, 'the capability probe runs once per pass, not once per session')
  })

  test('an unhelpful stat face falls back to the presence check', async () => {
    const statVariants: [string, (id: string) => Promise<unknown>][] = [
      ['throwing', async () => { throw new Error('no stat') }],
      ['non-record', async () => 'junk'],
      ['string count', async () => ({ eventCount: '2' })],
      ['fractional count', async () => ({ eventCount: 1.5 })],
      ['negative count', async () => ({ eventCount: -1 })],
    ]
    for (const [label, stat] of statVariants) {
      const ctx = new Context()
      const state = fakeState([{ header: { id: 'a', cwd: '/repo/a' } }])
      state.served.add('a')
      const route = arm(ctx, state, { sessionPersistence: fakePersistence([], stat) })
      const dispose = watchActivityBackfill(ctx)
      await trigger(route)
      await settle(20)
      dispose()
      assert.deepEqual(state.coldReads, [], label)
    }
  })

  test('a served block without a usable watermark refolds instead of trusting the rows', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'missing', cwd: '/repo/missing' } },
      { header: { id: 'fractional', cwd: '/repo/fractional' } },
      { header: { id: 'activity-only', cwd: '/repo/activity-only' } },
    ])
    const full = { contextActivity: { days: {} }, contextTimeline: { ok: true } }
    const route = arm(ctx, state, {
      sessionProjectionCache: {
        cachedSnapshot: (header: { id: string }) => {
          if (header.id === 'activity-only') return { asOfSeq: 0, values: { contextTimeline: {} } }
          if (header.id === 'fractional') return { asOfSeq: 0.5, values: full }
          return { values: full }
        },
        coldSnapshot: (header: { id: string }) => {
          state.coldSnapshots.push(header.id)
          return {}
        },
      },
    })
    const dispose = watchActivityBackfill(ctx)
    await trigger(route)
    await until(() => (state.coldSnapshots.length >= 3 ? true : undefined), 'the unusable blocks refolded')
    await settle(30)
    dispose()
    assert.deepEqual(state.coldReads.sort(), ['activity-only', 'fractional', 'missing'])
  })
})

describe('watchActivityBackfill — folded session journal', () => {
  test('folded ids drain once, an equal marker is empty, and overflow reports null', async () => {
    const ctx = new Context()
    const state = fakeState([
      { header: { id: 'a', cwd: '/repo/a' } },
      { header: { id: 'b', cwd: '/repo/b' } },
    ])
    const route = arm(ctx, state, { sessionQuery: { listSessions: async () => state.listed } })
    const handle = watchActivityBackfill(ctx, undefined, FAST_PACING)
    await trigger(route)
    await until(() => (handle.coverage().complete ? true : undefined), 'the first pass finished')
    const drained = handle.foldedSince(0)
    assert.equal(drained.version, 2, 'one journal version per folded session')
    assert.deepEqual([...(drained.ids ?? [])].sort(), ['a', 'b'])
    assert.deepEqual(handle.foldedSince(drained.version), { version: drained.version, ids: [] })
    handle()

    const many = new Context()
    const records = Array.from({ length: 4_100 }, (_, index) => ({ header: { id: `s${index}`, cwd: '/repo/x' } }))
    const big = fakeState(records)
    const bigRoute = arm(many, big, {
      sessionQuery: { listSessions: async () => big.listed },
      sessionPersistence: {
        open: async (id: string) => ({
          header: { id, version: 1, createdAt: 1, cwd: '/repo/x', isSeeded: false },
          inheritedEventCount: 0,
          read: async () => ({ events: [] }),
          close: async () => {},
        }),
      },
    })
    const bigHandle = watchActivityBackfill(many, undefined, FAST_PACING)
    await trigger(bigRoute)
    await until(() => (bigHandle.coverage().complete ? true : undefined), 'the big pass finished')
    const overflow = bigHandle.foldedSince(0)
    assert.equal(overflow.ids, null, 'more folded ids than the journal holds report the whole corpus dirty')
    bigHandle()
  })
})
