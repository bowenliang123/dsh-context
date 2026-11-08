import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { resolveBounds } from '../../src/host/config'
import { DetailShadow } from '../../src/host/detailShadow'
import { buildTimelineDetail } from '../../src/host/foldWire'
import type { TimelineEvent } from '../../src/host/fold'
import type { TimelineState } from '../../src/host/foldState'
import { assistantMessage, header, userMessage } from './helpers/events'
import { driveTimeline } from './helpers/projection'

const BOUNDS = resolveBounds({})

interface CtxHarness {
  ctx: Context
  emit: (event: string, ...args: unknown[]) => void
  disposed: () => boolean
  dispose: () => void
}

function ctxOf(): CtxHarness {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>()
  const disposers: (() => void)[] = []
  const ctx = {
    on(event: string, listener: (...args: unknown[]) => void) {
      const known = listeners.get(event) ?? []
      known.push(listener)
      listeners.set(event, known)
    },
    effect(fn: () => unknown) {
      const d = fn()
      const dispose = (): void => {
        if (typeof d === 'function') (d as () => void)()
      }
      disposers.push(dispose)
      return dispose
    },
    get: () => undefined,
  }
  return {
    ctx: ctx as unknown as Context,
    emit: (event, ...args) => {
      for (const listener of listeners.get(event) ?? []) listener(...args)
    },
    disposed: () => disposers.length === 0,
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose()
    },
  }
}

function gate(admit = true): { admit: <T>(read: () => Promise<T>) => Promise<T | undefined>; count: () => number } {
  let reads = 0
  return {
    admit: async <T>(read: () => Promise<T>): Promise<T | undefined> => {
      reads++
      return admit ? read() : undefined
    },
    count: () => reads,
  }
}

async function shadowSeed(
  harness: CtxHarness,
  bounds: typeof BOUNDS,
  gate2: { admit: <T>(read: () => Promise<T>) => Promise<T | undefined> },
  events: TimelineEvent[],
): Promise<TimelineState | null> {
  const shadow = new DetailShadow(harness.ctx, bounds, gate2, () => (id, options) => {
    void id
    void options
    return Promise.resolve({ events, [Symbol.dispose]: () => {} })
  })
  return shadow.stateOf('s1')
}

function observeOf(events: TimelineEvent[] | Error, reads: { count: number } = { count: 0 }, disposed?: { count: number }) {
  return (id: string, options: unknown): Promise<unknown> => {
    reads.count++
    if (events instanceof Error) return Promise.reject(events)
    return Promise.resolve({
      events,
      options,
      [Symbol.dispose]: () => {
        if (disposed !== undefined) disposed.count++
      },
    })
  }
}

function log(seqBase: number, count: number): TimelineEvent[] {
  const events: TimelineEvent[] = [header(seqBase, { model: 'm', provider: 'p' })]
  for (let i = 1; i <= count; i++) {
    const seq = seqBase + i
    events.push(i % 2 === 0
      ? userMessage(seq, [{ type: 'text', text: `q${seq}` }], { kind: 'user' })
      : assistantMessage(seq, { turn: i, step: i, usage: { inputTokens: 10, outputTokens: 5 } }))
  }
  return events
}

describe('DetailShadow', () => {
  test('the first stateOf seeds from the observed log; the next call re-serves without re-observing', async () => {
    const harness = ctxOf()
    const events = log(1, 4)
    const reads = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(events, reads))
    const first = await shadow.stateOf('s1')
    assert.ok(first !== null)
    assert.equal(reads.count, 1)
    const reference = buildTimelineDetail(driveTimeline(events).state, BOUNDS)
    assert.deepStrictEqual(buildTimelineDetail(first, BOUNDS), reference)
    const second = await shadow.stateOf('s1')
    assert.equal(reads.count, 1, 'the seeded state re-serves')
    assert.equal(second, first)
  })

  test('committed events advance the state incrementally; stale seqs never double-apply', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(log(1, 2), reads))
    await shadow.stateOf('s1')
    harness.emit('session/event', { id: 's1' }, log(4, 1)[1])
    const advanced = await shadow.stateOf('s1')
    assert.ok(advanced !== null)
    harness.emit('session/event', { id: 's1' }, log(4, 1)[1])
    const again = await shadow.stateOf('s1')
    assert.equal(again, advanced, 'a stale seq never re-applies')
  })

  test('events committed during the seed replay past the seeded cut, exactly once', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const events = log(1, 2)
    const live = log(4, 1)[1]
    const shadow = new DetailShadow(harness.ctx, BOUNDS, {
      admit: async <T>(read: () => Promise<T>): Promise<T> => {
        await blocked
        return read()
      },
    }, () => (id, options) => {
      reads.count++
      void id
      return observeOf(events, reads)(id, options)
    })
    const pending = shadow.stateOf('s1')
    harness.emit('session/event', { id: 's1' }, live)
    release!()
    const state = await pending
    assert.ok(state !== null)
    const reference = buildTimelineDetail(driveTimeline([...events, live]).state, BOUNDS)
    assert.deepStrictEqual(buildTimelineDetail(state, BOUNDS), reference, 'the buffered event folded exactly once')
  })

  test('an event flood during a stalled seed drops the entry; the next read reseeds and both leases dispose', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    const disposed = { count: 0 }
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const shadow = new DetailShadow(harness.ctx, BOUNDS, {
      admit: async <T>(read: () => Promise<T>): Promise<T> => {
        await blocked
        return read()
      },
    }, () => observeOf(log(1, 1), reads, disposed))
    const pending = shadow.stateOf('s1')
    for (let i = 0; i < 600; i++) {
      harness.emit('session/event', { id: 's1' }, log(1, 1)[1])
    }
    release!()
    const state = await pending
    assert.equal(state, null, 'the flooded entry dropped; the seed aborted')
    assert.equal(disposed.count, 1, 'the dropped seed disposes its observation lease once')
    const again = await shadow.stateOf('s1')
    assert.ok(again !== null, 'the next read reseeds cleanly')
    assert.equal(reads.count, 2)
    assert.equal(disposed.count, 2, 'the reseeded lease disposes once on success')
  })

  test('a disposed session drops its seeded entry and its lease was disposed once at seed completion', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    const disposed = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(log(1, 1), reads, disposed))
    await shadow.stateOf('s1')
    assert.equal(reads.count, 1)
    assert.equal(disposed.count, 1, 'the seeded observation lease is disposed exactly once')
    harness.emit('session/disposed', { id: 's1' })
    harness.emit('session/event', { id: 's1' }, log(3, 1)[1])
    assert.equal(disposed.count, 1, 'dropping the entry never disposes the lease again')
    const reseeded = await shadow.stateOf('s1')
    assert.ok(reseeded !== null)
    assert.equal(reads.count, 2, 'a later read reseeds after the dispose')
    assert.equal(disposed.count, 2, 'the reseeded lease is disposed too')
  })

  test('a failed observation propagates the failure and clears the entry', async () => {
    const harness = ctxOf()
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(new Error('persistence down')))
    await assert.rejects(shadow.stateOf('s1'), /persistence down/)
    const gate2 = gate()
    const retried = new DetailShadow(harness.ctx, BOUNDS, gate2, () => observeOf(log(1, 1)))
    const state = await retried.stateOf('s1')
    assert.ok(state !== null, 'a fresh shadow seeds after the failure')
  })

  test('a seed failure after the lease arrives disposes the lease exactly once and clears the entry', async () => {
    const harness = ctxOf()
    const disposed = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => async () => ({
      get events(): readonly TimelineEvent[] { throw new Error('log read failed') },
      [Symbol.dispose]: () => { disposed.count++ },
    }))
    await assert.rejects(shadow.stateOf('s1'), /log read failed/)
    assert.equal(disposed.count, 1, 'the finally disposes the failed seed lease')
    const retried = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(log(1, 1), { count: 0 }, disposed))
    assert.ok(await retried.stateOf('s1') !== null, 'a fresh shadow seeds after the failure')
    assert.equal(disposed.count, 2, 'the retried lease disposes once on success')
  })

  test('a refused cold-read admission answers null without observing', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(false), () => observeOf(log(1, 1), reads))
    const state = await shadow.stateOf('s1')
    assert.equal(state, null)
    assert.equal(reads.count, 0, 'a refused admission never touches the log')
  })

  test('junk payloads fold past and hostile entries never break the seed', async () => {
    const harness = ctxOf()
    const events: TimelineEvent[] = []
    for (let seq = 1; seq <= 1_200; seq++) {
      events.push(seq % 2 === 0
        ? userMessage(seq, [{ type: 'text', text: `q${seq}` }], { kind: 'user' })
        : assistantMessage(seq, { turn: seq, step: seq, usage: { inputTokens: 1, outputTokens: 1 } }))
    }
    events.splice(50, 0, { seq: 50.5 } as TimelineEvent, 'junk' as unknown as TimelineEvent, { type: 'user/message', seq: 'x' } as unknown as TimelineEvent)
    const slowGate = {
      admit: async <T,>(read: () => Promise<T>): Promise<T> => {
        await new Promise(resolve => setTimeout(resolve, 30))
        return read()
      },
    }
    const seedPromise = shadowSeed(harness, BOUNDS, slowGate, events)
    const state = await seedPromise
    assert.ok(state !== null, 'junk entries never break the fold')
    assert.equal(state.requests.length, 300, 'the real events folded into the kept-turns window')
    assert.equal(state.surface.length, 1201, 'junk seqs still fold whole (the schema gate discards such rows on read)')
  })

  test('hostile session identities and stale buffered events never disturb the advance', async () => {
    const harness = ctxOf()
    const reads = { count: 0 }
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const events = log(1, 2)
    const shadow = new DetailShadow(harness.ctx, BOUNDS, {
      admit: async <T>(read: () => Promise<T>): Promise<T> => {
        await blocked
        return read()
      },
    }, () => (id, options) => {
      reads.count++
      void id
      return observeOf(events, reads)(id, options)
    })
    const pending = shadow.stateOf('s1')
    harness.emit('session/event', { nope: true }, log(4, 1)[1])
    harness.emit('session/disposed', { nope: true })
    harness.emit('session/event', { id: 's1' }, 'junk' as unknown as TimelineEvent)
    harness.emit('session/event', { id: 's1' }, log(1, 2)[1])
    harness.emit('session/event', { id: 's1' }, { type: 'user/message', seq: null })
    release!()
    const state = await pending
    assert.ok(state !== null)
    const reference = buildTimelineDetail(driveTimeline(events).state, BOUNDS)
    assert.deepStrictEqual(buildTimelineDetail(state, BOUNDS), reference, 'junk and stale buffers fold to the same state')
  })

  test('a session disposed mid-seed aborts at the next yield and still disposes its lease once', async () => {
    const harness = ctxOf()
    const disposed = { count: 0 }
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => (id, options) => {
      void id
      void options
      return Promise.resolve({
        events: log(1, 3_200),
        [Symbol.dispose]: () => { disposed.count++ },
      })
    })
    const pending = shadow.stateOf('s1')
    await new Promise(resolve => setTimeout(resolve, 20))
    harness.emit('session/disposed', { id: 's1' })
    assert.equal(await pending, null, 'the seed aborts once the entry is gone')
    assert.equal(disposed.count, 1, 'the aborted seed still disposes the observation lease once')
  })

  test('evicting while every other entry still seeds keeps them all', async () => {
    const harness = ctxOf()
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const shadow = new DetailShadow(harness.ctx, BOUNDS, {
      admit: async <T>(read: () => Promise<T>): Promise<T> => {
        await blocked
        return read()
      },
    }, () => observeOf(log(1, 1)))
    const pendings = []
    for (let i = 0; i < 10; i++) pendings.push(shadow.stateOf(`s${i}`))
    release!()
    for (const p of pendings) assert.ok(await p !== null)
  })

  test('a buffered duplicate folds past and a buffered fresh event lands exactly once', async () => {
    const harness = ctxOf()
    let release: (() => void) | undefined
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    const events = log(1, 3)
    const fresh = log(4, 1)[1]
    const shadow = new DetailShadow(harness.ctx, BOUNDS, {
      admit: async <T>(read: () => Promise<T>): Promise<T> => {
        await blocked
        return read()
      },
    }, () => (id, options) => {
      void id
      return observeOf(events)(id, options)
    })
    const pending = shadow.stateOf('s1')
    harness.emit('session/event', { id: 's1' }, events[1])
    harness.emit('session/event', { id: 's1' }, fresh)
    release!()
    const state = await pending
    assert.ok(state !== null)
    const reference = buildTimelineDetail(driveTimeline([...events, fresh]).state, BOUNDS)
    assert.deepStrictEqual(buildTimelineDetail(state, BOUNDS), reference, 'the duplicate never folds twice')
  })

  test('observeFaceOf wraps a real face and refuses a faceless query', async () => {
    const { observeFaceOf } = await import('../../src/host/detailShadow')
    const called: string[] = []
    const wrapped = observeFaceOf({ get: () => ({ observeSession: (id: string) => { called.push(id); return Promise.resolve({}) } }) } as never)
    assert.ok(wrapped !== undefined)
    await wrapped!('s9', {})
    assert.deepEqual(called, ['s9'])
    assert.equal(observeFaceOf({ get: () => ({}) } as never), undefined)
  })

  test('entries evict least-recently-used past the cap, never the seeding one', async () => {
    const harness = ctxOf()
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => observeOf(log(1, 1)))
    for (let i = 0; i < 9; i++) await shadow.stateOf(`s${i}`)
    const oldest = await shadow.stateOf('s0')
    assert.ok(oldest !== null, 'the evicted entry reseeds on demand')
  })

  test('an entry without the observe face resolves to null', async () => {
    const harness = ctxOf()
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => undefined)
    assert.equal(await shadow.stateOf('s1'), null)
  })

  test('a non-array events payload resolves to null', async () => {
    const harness = ctxOf()
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => async () => ({ events: 'junk' }))
    assert.equal(await shadow.stateOf('s1'), null)
    harness.dispose()
  })
})

describe('detail shadow idle sweep', () => {
  test('an idle shadow drops its entries and keeps serving a reseeded state', async () => {
    const harness = ctxOf()
    const shadow = new DetailShadow(harness.ctx, BOUNDS, gate(), () => undefined, 5)
    assert.equal(await shadow.stateOf('s1'), null)
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(await shadow.stateOf('s1'), null)
    harness.dispose()
  })
})
