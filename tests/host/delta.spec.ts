import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { resolveBounds } from '../../src/host/config'
import { DELTA_ROUTE, watchDeltaChannel } from '../../src/host/delta'
import { makeColdReadGate } from '../../src/host/coldRead'
import type { DetailChannelGate } from '../../src/host/detail'
import type { DetailShadow } from '../../src/host/detailShadow'
import { createTimelineState, type TimelineState } from '../../src/host/foldState'
import type { TimelineEvent } from '../../src/host/fold'
import type { ContextDelta } from '../../src/shared/delta'
import { connectionOf, fakeCtx, observationOf, postJson } from './helpers/ctx'
import { userMessage } from './helpers/events'

const BOUNDS = resolveBounds({})

function archiveState(count: number, options: { rev?: boolean; systems?: boolean } = {}): TimelineState {
  const state = createTimelineState()
  if (options.rev !== false) state.detailRev = 7
  if (options.systems === true) state.systems = [{ seq: 0, time: 0, tokens: 5 }]
  for (let seq = 1; seq <= count; seq++) {
    state.archived.push({ seq, time: seq, cat: 'assistant', tokens: 10, gone: 1001 })
  }
  for (let seq = count + 1; seq <= 1000; seq++) {
    state.surface.push({ seq, time: seq, cat: 'user', tokens: 10 })
  }
  return state
}

interface LiveOptions {
  state?: TimelineState | null
  gateState?: unknown
  fail?: unknown
  resolve?: (name: string) => string | undefined
}

function liveFake(options: LiveOptions = {}): ReturnType<typeof fakeCtx> {
  const gate: DetailChannelGate = {
    live: true,
    retain() {},
    stateOf: () => ('gateState' in options ? options.gateState : { headers: [] }),
  }
  const shadow = {
    stateOf: async () => {
      if ('fail' in options) throw options.fail
      return options.state ?? null
    },
  } as unknown as DetailShadow
  const fake = fakeCtx({
    connection: connectionOf(),
    sessions: { get: (id: string) => (id === 's1' ? { id } : undefined) },
    sessionProjections: { stateOf: () => undefined },
  })
  watchDeltaChannel(fake.ctx, BOUNDS, makeColdReadGate(), gate, shadow, options.resolve)
  return fake
}

function coldFake(observation: unknown): ReturnType<typeof fakeCtx> {
  const fake = fakeCtx({
    connection: connectionOf(),
    sessions: { get: () => undefined },
    sessionQuery: { observeSession: () => Promise.resolve(observation) },
  })
  watchDeltaChannel(
    fake.ctx,
    BOUNDS,
    makeColdReadGate(),
    { live: true, retain() {}, stateOf: () => undefined },
    { stateOf: async () => null } as unknown as DetailShadow,
  )
  return fake
}

function shadowedEvents(extra: unknown[] = []): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (let seq = 1; seq <= 500; seq++) events.push(userMessage(seq, [{ type: 'text', text: 'x' }]))
  events.push(userMessage(502, [{ type: 'text', text: 'replacement' }], undefined, {
    surfaceOp: { op: 'replace', startSeq: 1, endSeq: 500 },
  }))
  return [...events, ...extra as TimelineEvent[]]
}

describe('delta route', () => {
  test('mounts only with the required services', () => {
    const bare = fakeCtx({})
    watchDeltaChannel(bare.ctx, BOUNDS, makeColdReadGate(), { live: true, retain() {}, stateOf: () => undefined }, { stateOf: async () => null } as unknown as DetailShadow)
    assert.equal(bare.captured.path, undefined)
  })

  test('a live session returns the complete removed set from the full archive', async () => {
    const fake = liveFake({ state: archiveState(500) })
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
    const value = body.value as ContextDelta
    assert.equal(value.removedCounts.assistant, 500, 'every archived removal is reported')
    assert.equal(value.tokenDown.assistant, 5000)
    assert.equal(value.added.length, 1, 'the one newer surface node is the only addition')
    assert.equal(value.viewNodes.length, 500)
    assert.equal(value.total, 10)
  })

  test('the live view omits its full node list', async () => {
    const fake = liveFake({ state: archiveState(500) })
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: null, baseSeq: 1000 })
    const value = body.value as ContextDelta
    assert.deepEqual(value.viewNodes, [])
    assert.equal(value.removedCounts.assistant, 500)
  })

  test('a live state without systems or a detail revision still answers', async () => {
    const fake = liveFake({ state: archiveState(2, { rev: false }) })
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
    const value = body.value as ContextDelta
    assert.equal(value.removedCounts.assistant, 2)
    const withSystems = liveFake({ state: archiveState(2, { systems: true }) })
    const systemBody = await postJson(withSystems.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
    assert.equal((systemBody.value as ContextDelta).viewSystem?.tokens, 5)
  })

  test('a live session without a state or header history still answers what it can', async () => {
    const empty = liveFake({ state: null })
    const missing = await postJson(empty.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
    assert.equal(missing.value, null)
    for (const gateState of [undefined, {}, { headers: [] }]) {
      const fake = liveFake({ state: archiveState(2), gateState })
      const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
      assert.equal((body.value as ContextDelta).removedCounts.assistant, 2)
    }
  })

  test('the historical header keeps plugin attribution', async () => {
    const fake = liveFake({
      state: archiveState(2),
      gateState: { headers: [{ seq: 1, time: 1, tools: [{ name: 'bash', tokens: 4 }] }] },
      resolve: name => (name === 'bash' ? 'plugin:bash' : undefined),
    })
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1001, baseSeq: 1000 })
    assert.equal((body.value as ContextDelta).viewHeader?.tools[0].plugin, 'plugin:bash')
  })

  test('a live failure surfaces as gateway/internal', async () => {
    for (const fail of [new Error('boom'), 'boom']) {
      const fake = liveFake({ fail })
      const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 1, baseSeq: 0 })
      assert.equal((body.error as { code: string }).code, 'gateway/internal')
      assert.equal((body.error as { message: string }).message, 'boom')
    }
  })

  test('a cold session folds the log and reports every shadowed node', async () => {
    const fake = coldFake(observationOf(shadowedEvents([null, {}])))
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    const value = body.value as ContextDelta
    assert.equal(value.removedCounts.user, 500)
    assert.equal(value.added.length, 1)
  })

  test('a cold session without a session getter still folds the observation', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: {},
      sessionQuery: { observeSession: () => Promise.resolve(observationOf(shadowedEvents())) },
    })
    watchDeltaChannel(
      fake.ctx,
      BOUNDS,
      makeColdReadGate(),
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
    )
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    assert.equal((body.value as ContextDelta).removedCounts.user, 500)
  })

  test('a cold revision reuses the folded state across selections', async () => {
    const events = shadowedEvents()
    let calls = 0
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => undefined },
      sessionQuery: {
        observeSession: () => {
          calls += 1
          return Promise.resolve(observationOf(events, { revision: calls === 1 ? 'r1' : 'r2' }))
        },
      },
    })
    watchDeltaChannel(
      fake.ctx,
      BOUNDS,
      makeColdReadGate(),
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
    )
    const first = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    const second = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    const third = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    assert.equal(calls, 3)
    assert.equal((first.value as ContextDelta).removedCounts.user, 500)
    assert.deepEqual(second.value, first.value)
    assert.deepEqual(third.value, first.value)
  })

  test('a cold session without a readable observation returns null', async () => {
    const noObserve = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => undefined },
    })
    watchDeltaChannel(
      noObserve.ctx,
      BOUNDS,
      makeColdReadGate(),
      { live: true, retain() {}, stateOf: () => undefined },
      { stateOf: async () => null } as unknown as DetailShadow,
    )
    const none = await postJson(noObserve.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    assert.equal(none.value, null)
    const malformed = coldFake({ events: 'x' })
    const bad = await postJson(malformed.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: 501 })
    assert.equal(bad.value, null)
  })

  test('a missing base reports every visible node as added', async () => {
    const fake = coldFake(observationOf(shadowedEvents()))
    const body = await postJson(fake.captured, DELTA_ROUTE, { sessionId: 's1', seq: 503, baseSeq: null })
    const value = body.value as ContextDelta
    assert.equal(value.removedCounts.user, 0)
    assert.equal(value.added.length, 1)
  })

  test('rejects a body that is not JSON', async () => {
    const fake = liveFake({ state: archiveState(1) })
    const body = await postJson(fake.captured, DELTA_ROUTE, 'not json')
    assert.equal((body.error as { code: string }).code, 'dsh-context/bad-request')
  })

  test('rejects a missing or malformed seq', async () => {
    const fake = liveFake({ state: archiveState(1) })
    for (const payload of [
      { sessionId: 's1', baseSeq: 1 },
      { sessionId: 's1', seq: '1', baseSeq: 1 },
      { sessionId: 's1', seq: 1.5, baseSeq: 1 },
      { sessionId: 's1', seq: 1, baseSeq: -1 },
      { seq: 1, baseSeq: 1 },
    ]) {
      const body = await postJson(fake.captured, DELTA_ROUTE, payload)
      assert.equal((body.error as { code: string }).code, 'dsh-context/bad-request')
    }
  })
})
