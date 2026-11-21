import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import * as detailShadow from '../../src/host/detailShadow'
import type { DetailShadow } from '../../src/host/detailShadow'
import { createColdTimelineStates } from '../../src/host/coldTimeline'
import { resolveBounds } from '../../src/host/config'
import { DELTA_ROUTE, watchDeltaChannel } from '../../src/host/delta'
import { FACTS_ROUTE, watchFactsChannel } from '../../src/host/facts'
import { OPEN_GATE, SKIP_GATE, connectionOf, fakeCtx, observationOf, observing, postJson } from './helpers/ctx'
import { assistantMessage, header, userMessage } from './helpers/events'

const BOUNDS = resolveBounds({})

const EVENTS = [
  header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
  userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
  assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
]

interface OwnerSpec {
  events?: unknown
  revision?: unknown
  header?: unknown
  persistence?: unknown
}

function ownerCtx(spec: OwnerSpec = {}): ReturnType<typeof fakeCtx> {
  return fakeCtx({
    connection: connectionOf(),
    sessions: { get: () => undefined },
    sessionQuery: { observeSession: () => Promise.resolve(observationOf((spec.events ?? EVENTS) as never[], {
      ...(spec.revision === undefined ? {} : { revision: spec.revision }),
      ...(spec.header === undefined ? {} : { header: spec.header }),
    })) },
    ...(spec.persistence === undefined ? {} : { sessionPersistence: spec.persistence }),
  })
}

describe('cold timeline states', () => {

  test('folds once per revision and reuses the same state across reads', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const states = createColdTimelineStates(ownerCtx({ revision: 'r1' }).ctx, BOUNDS, { coldReads: OPEN_GATE })
    states.touch()
    const first = await states.stateOf('s1')
    const second = await states.stateOf('s1')
    assert.equal(spy.mock.calls.length, 1, 'the second read reuses the folded state')
    assert.ok(first !== null && second !== null)
    assert.equal(second.state, first.state)
    assert.deepEqual(second.headers, first.headers)
    assert.deepEqual(second.header, undefined)
    spy.mockRestore()
  })

  test('delta serves a state folded by facts through the shared owner', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const fake = ownerCtx({ revision: 'r1', header: { id: 's1' } })
    const shared = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    watchFactsChannel(fake.ctx, BOUNDS, { coldStates: shared })
    watchDeltaChannel(
      fake.ctx,
      BOUNDS,
      OPEN_GATE,
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
      undefined,
      shared,
    )
    const facts = await postJson(fake.routes.get(FACTS_ROUTE)!, FACTS_ROUTE, { sessionId: 's1', parts: ['head'] })
    assert.equal((facts.value as { live: boolean }).live, false)
    const delta = await postJson(fake.routes.get(DELTA_ROUTE)!, DELTA_ROUTE, { sessionId: 's1', seq: 3, baseSeq: 2 })
    assert.equal((delta.value as { added: unknown[] }).added.length, 1)
    assert.equal(spy.mock.calls.length, 1, 'the delta read reuses the facts fold')
    fake.dispose()
    spy.mockRestore()
  })

  test('delta never reuses a cursor-keyed fold but its own fold feeds a later facts read', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const fake = ownerCtx({})
    const shared = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    watchFactsChannel(fake.ctx, BOUNDS, { coldStates: shared })
    watchDeltaChannel(
      fake.ctx,
      BOUNDS,
      OPEN_GATE,
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
      undefined,
      shared,
    )
    await postJson(fake.routes.get(FACTS_ROUTE)!, FACTS_ROUTE, { sessionId: 's1', parts: ['head'] })
    const delta = await postJson(fake.routes.get(DELTA_ROUTE)!, DELTA_ROUTE, { sessionId: 's1', seq: 3, baseSeq: 2 })
    assert.equal((delta.value as { added: unknown[] }).added.length, 1, 'the untrusted fold is refolded for delta')
    await postJson(fake.routes.get(FACTS_ROUTE)!, FACTS_ROUTE, { sessionId: 's1', parts: ['head'] })
    assert.equal(spy.mock.calls.length, 2, 'the delta fold feeds the later facts read')
    fake.dispose()
    spy.mockRestore()
  })

  test('facts reuses a trusted fold authored by delta', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const fake = ownerCtx({ revision: 'r1' })
    const shared = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    watchFactsChannel(fake.ctx, BOUNDS, { coldStates: shared })
    watchDeltaChannel(
      fake.ctx,
      BOUNDS,
      OPEN_GATE,
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
      undefined,
      shared,
    )
    await postJson(fake.routes.get(DELTA_ROUTE)!, DELTA_ROUTE, { sessionId: 's1', seq: 3, baseSeq: 2 })
    const facts = await postJson(fake.routes.get(FACTS_ROUTE)!, FACTS_ROUTE, { sessionId: 's1', parts: ['head'] })
    assert.equal((facts.value as { live: boolean }).live, false)
    assert.equal(spy.mock.calls.length, 1, 'the trusted delta fold serves the facts read')
    fake.dispose()
    spy.mockRestore()
  })

  test('a revision change refolds and the new revision reuses', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    let revision = 'r1'
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => Promise.resolve(observationOf(EVENTS as never[], { revision })) },
      sessionPersistence: { id: 'p1' },
    })
    const states = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    await states.stateOf('s1')
    revision = 'r2'
    await states.stateOf('s1')
    await states.stateOf('s1')
    assert.equal(spy.mock.calls.length, 2, 'the new revision folds once and reuses')
    spy.mockRestore()
  })

  test('a persistence identity change refolds the same revision', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    let persistence: unknown = { id: 'p1' }
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => Promise.resolve(observationOf(EVENTS as never[], { revision: 'r1' })) },
    }, { serviceGetters: { sessionPersistence: () => persistence } })
    const states = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    await states.stateOf('s1')
    persistence = { id: 'p2' }
    await states.stateOf('s1')
    assert.equal(spy.mock.calls.length, 2, 'a rebound persistence service invalidates the fold')
    spy.mockRestore()
  })

  test('trusted-only reads refuse cursor-keyed entries', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const states = createColdTimelineStates(ownerCtx({}).ctx, BOUNDS, { coldReads: OPEN_GATE })
    await states.stateOf('s1')
    await states.stateOf('s1', { trustedOnly: true })
    assert.equal(spy.mock.calls.length, 2, 'a cursor-keyed fold is not trusted for delta')
    spy.mockRestore()
  })

  test('returns null without an observation face, for a bad log, or when the gate refuses', async () => {
    const noQuery = createColdTimelineStates(fakeCtx({ connection: connectionOf() }).ctx, BOUNDS)
    assert.equal(await noQuery.stateOf('s1'), null)

    const spy = vi.spyOn(detailShadow, 'foldLog')
    const badLog = createColdTimelineStates(ownerCtx({ events: 'x' }).ctx, BOUNDS, { coldReads: OPEN_GATE })
    assert.equal(await badLog.stateOf('s1'), null)
    assert.equal(spy.mock.calls.length, 0)

    let observed = 0
    const gated = fakeCtx({
      connection: connectionOf(),
      sessionQuery: { observeSession: () => {
        observed += 1
        return Promise.resolve(observationOf(EVENTS as never[], { revision: 'r1' }))
      } },
    })
    const skipped = createColdTimelineStates(gated.ctx, BOUNDS, { coldReads: SKIP_GATE })
    assert.equal(await skipped.stateOf('s1'), null)
    assert.equal(observed, 0, 'a gate skip never touches the log')
    spy.mockRestore()
  })

  test('disposes the observation lease once per read', async () => {
    const observation = observing(EVENTS as never[], { revision: 'r1' })
    const fake = fakeCtx({
      connection: connectionOf(),
      sessionQuery: observation,
      sessionPersistence: { id: 'p1' },
    })
    const states = createColdTimelineStates(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    await states.stateOf('s1')
    await states.stateOf('s1')
    assert.equal(observation.disposeCount(), 2, 'every read releases its own lease')
  })

  test('evicts the oldest state beyond the bound and refolds it on the next read', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const states = createColdTimelineStates(ownerCtx({ revision: 'r1' }).ctx, BOUNDS, { coldReads: OPEN_GATE })
    for (const id of ['a', 'b', 'c', 'd', 'e']) await states.stateOf(id)
    assert.equal(spy.mock.calls.length, 5)
    await states.stateOf('a')
    assert.equal(spy.mock.calls.length, 6, 'the evicted oldest entry refolds')
    spy.mockRestore()
  })

  test('an idle sweep drops the cached fold and the next read refolds', async () => {
    const spy = vi.spyOn(detailShadow, 'foldLog')
    const states = createColdTimelineStates(ownerCtx({ revision: 'r1' }).ctx, BOUNDS, { coldReads: OPEN_GATE, idleSweepMs: 10 })
    await states.stateOf('s1')
    await new Promise(resolve => setTimeout(resolve, 30))
    await states.stateOf('s1')
    assert.equal(spy.mock.calls.length, 2, 'the swept cache refolds')
    spy.mockRestore()
  })
})
