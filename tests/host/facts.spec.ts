import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FACTS_ROUTE, watchFactsChannel } from '../../src/host/facts'
import { resolveBounds } from '../../src/host/config'
import type { DetailChannelGate } from '../../src/host/detail'
import { OPEN_GATE, SKIP_GATE, connectionOf, fakeCtx, observationOf, postJson } from './helpers/ctx'
import type { FakeCtx, FakeRoute } from './helpers/ctx'
import { assistantMessage, header, userMessage } from './helpers/events'
import { createTimelineState } from '../../src/host/foldState'
import type { TimelineState } from '../../src/host/foldState'
import { driveTimeline } from './helpers/projection'

const BOUNDS = resolveBounds({})

const EVENTS = [
  header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
  userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
  assistantMessage(3, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
]

function stateOf(): unknown {
  return driveTimeline(EVENTS, undefined, true).state
}

function gatesWith(state: unknown): DetailChannelGate {
  return { live: true, retain() {}, stateOf: () => state }
}

interface ColdObserveSpec {
  events?: unknown
  revision?: unknown
  header?: unknown
  throwOnObserve?: boolean
  throwValue?: unknown
  cache?: unknown
}

function coldCtx(spec: ColdObserveSpec = {}): {
  fake: FakeCtx
  calls: () => number
  disposed: () => boolean
} {
  let calls = 0
  let disposed = false
  const observation = observationOf((spec.events ?? EVENTS) as never[], {
    ...(spec.revision === undefined ? {} : { revision: spec.revision }),
    ...(spec.header === undefined ? {} : { header: spec.header }),
  })
  ;(observation as { [Symbol.dispose]?: () => void })[Symbol.dispose] = () => { disposed = true }
  const fake = fakeCtx({
    connection: connectionOf(),
    sessionQuery: {
      observeSession: () => {
        calls++
        if (spec.throwOnObserve === true) return Promise.reject(spec.throwValue ?? new Error('observe failed'))
        return Promise.resolve(observation)
      },
    },
    sessionPersistence: { id: 'persistence' },
    ...(spec.cache === undefined ? {} : { sessionProjectionCache: spec.cache }),
  })
  return { fake, calls: () => calls, disposed: () => disposed }
}

const call = (captured: FakeRoute, body: unknown): Promise<Record<string, unknown>> => postJson(captured, FACTS_ROUTE, body)

describe('facts route mounting', () => {
  test('mounts only with a connection and disposes cleanly', () => {
    const bare = fakeCtx({})
    watchFactsChannel(bare.ctx, BOUNDS)
    assert.equal(bare.captured.path, undefined)
    const fake = fakeCtx({ connection: connectionOf() })
    watchFactsChannel(fake.ctx, BOUNDS)
    assert.equal(fake.captured.path, '/api/dsh-context/facts')
    for (const dispose of fake.disposers) dispose()
    assert.equal(fake.captured.path, undefined)
  })
})

describe('request validation', () => {
  test('rejects a body that is not JSON', async () => {
    const fake = fakeCtx({ connection: connectionOf() })
    watchFactsChannel(fake.ctx, BOUNDS)
    const body = await postJson(fake.captured, FACTS_ROUTE, 'not json')
    assert.equal(body.ok, false)
    assert.deepEqual((body.error as { code: string }).code, 'dsh-context/bad-request')
  })

  test('rejects a null body', async () => {
    const fake = fakeCtx({ connection: connectionOf() })
    watchFactsChannel(fake.ctx, BOUNDS)
    const body = await postJson(fake.captured, FACTS_ROUTE, 'null')
    assert.equal((body.error as { code: string }).code, 'dsh-context/bad-request')
  })

  test('rejects a missing or empty sessionId', async () => {
    const fake = fakeCtx({ connection: connectionOf() })
    watchFactsChannel(fake.ctx, BOUNDS)
    for (const payload of [{}, { sessionId: '' }, { sessionId: 42 }]) {
      const body = await call(fake.captured, payload)
      assert.equal((body.error as { code: string }).code, 'dsh-context/bad-request')
    }
  })
})

function liveFake(state: unknown = stateOf(), snapshot?: unknown, deps: Record<string, unknown> = {}): FakeCtx {
  const projections = { stateOf: () => state, ...(snapshot === undefined ? {} : { snapshot }) }
  const fake = fakeCtx({
    connection: connectionOf(),
    sessions: { get: (id: string) => (id === 's1' ? { id: 's1' } : undefined) },
    sessionProjections: projections,
  })
  watchFactsChannel(fake.ctx, BOUNDS, { gates: gatesWith(state), ...deps })
  return fake
}

describe('live sessions', () => {


  test('serves head, slim series and kernel stats in one consistent value', async () => {
    const snapshot = () => ({
      asOfSeq: 3,
      values: {
        sessionStats: { turns: 1, steps: 1 },
        tokenUsage: { totals: { outputTokens: 5 } },
        contextBreakdown: { breakdown: { messageTokens: 5 } },
        ignored: { value: true },
      },
    })
    const fake = liveFake(stateOf(), snapshot)
    const body = await call(fake.captured, { sessionId: 's1' })
    const value = body.value as Record<string, unknown>
    assert.equal(value.live, true)
    assert.equal(value.asOfSeq, 3)
    assert.equal(typeof value.rev, 'number')
    const parts = value.parts as Record<string, unknown>
    assert.ok(parts.head !== undefined)
    assert.ok(Array.isArray(parts.series))
    assert.equal((parts.series as unknown[]).length, 1)
    const series = (parts.series as Record<string, unknown>[])[0] as Record<string, unknown>
    assert.equal(series.seq, 3)
    assert.equal(series.total, 9)
    const stats = parts.stats as Record<string, unknown>
    assert.deepEqual(stats.sessionStats, { turns: 1, steps: 1 })
    assert.equal(stats.tokenUsage !== undefined, true)
    assert.equal(stats.ignored, undefined)
  })

  test('honors a requested part subset, ignores unknown parts and defaults an invalid list', async () => {
    const fake = liveFake()
    const onlySeries = await call(fake.captured, { sessionId: 's1', parts: ['series', 'unknown'] })
    const parts = (onlySeries.value as { parts: Record<string, unknown> }).parts
    assert.deepEqual(Object.keys(parts), ['series'])
    const none = await call(fake.captured, { sessionId: 's1', parts: ['unknown'] })
    assert.deepEqual(Object.keys((none.value as { parts: Record<string, unknown> }).parts), ['head', 'series'])
    const invalid = await call(fake.captured, { sessionId: 's1', parts: 'head' })
    assert.equal(Object.keys((invalid.value as { parts: Record<string, unknown> }).parts).length, 2)
  })

  test('defaults the revision when the state has none and omits non-requested parts', async () => {
    const fake = liveFake(createTimelineState())
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['head'] })).value as Record<string, unknown>
    assert.equal(body.rev, 0)
    const parts = body.parts as Record<string, unknown>
    assert.deepEqual(Object.keys(parts), ['head'])
  })

  test('tags every live and cold read with the kernel asOfSeq', async () => {
    const snapshot = () => ({ asOfSeq: 11, values: { sessionStats: { turns: 1 } } })
    const live = liveFake(stateOf(), snapshot)
    const liveBody = (await call(live.captured, { sessionId: 's1', parts: ['head'] })).value as Record<string, unknown>
    assert.equal(liveBody.asOfSeq, 11)
    assert.equal((liveBody.parts as Record<string, unknown>).stats, undefined, 'stats stay request-gated')
    const cold = coldCtx({ header: { id: 'cold' }, cache: { cachedSnapshot: () => ({ asOfSeq: 9, values: {} }) } })
    watchFactsChannel(cold.fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const coldBody = (await call(cold.fake.captured, { sessionId: 'cold', parts: ['series'] })).value as Record<string, unknown>
    assert.equal(coldBody.asOfSeq, 9)
  })

  test('serializes every optional series field', async () => {
    const state = createTimelineState()
    state.detailRev = 4
    state.requests.push({ seq: 5, time: 100, total: 9, turn: 1, step: 2, prompt: 7, activeMs: 12 })
    state.requests.push({ seq: 6, time: 200, total: 3 })
    const fake = liveFake(state)
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['series'] })).value as Record<string, unknown>
    const series = (body.parts as { series: Record<string, unknown>[] }).series
    assert.deepEqual(series[0], { seq: 5, time: 100, total: 9, turn: 1, step: 2, prompt: 7, activeMs: 12 })
    assert.deepEqual(series[1], { seq: 6, time: 200, total: 3 })
    assert.equal(body.rev, 4)
  })

  test('omits the stats part when the kernel values are not an object', async () => {
    const fake = liveFake(stateOf(), () => ({ asOfSeq: 2, values: null }))
    const body = (await call(fake.captured, { sessionId: 's1' })).value as Record<string, unknown>
    assert.equal(body.asOfSeq, 2)
    assert.equal((body.parts as Record<string, unknown>).stats, undefined)
  })

  test('returns null when the fallback projection face has no stateOf', async () => {
    const fake = fakeCtx({ connection: connectionOf(), sessions: { get: () => ({ id: 's1' }) }, sessionProjections: {} })
    watchFactsChannel(fake.ctx, BOUNDS)
    assert.equal((await call(fake.captured, { sessionId: 's1' })).value, null)
  })

  test('returns null when the gate reports no state for an attached session', async () => {
    const fake = fakeCtx({ connection: connectionOf(), sessions: { get: () => ({ id: 's1' }) } })
    watchFactsChannel(fake.ctx, BOUNDS, { gates: { live: true, retain() {}, stateOf: () => undefined } })
    assert.equal((await call(fake.captured, { sessionId: 's1' })).value, null)
  })

  test('returns null when the live projection state is absent', async () => {
    const nullState = liveFake(null)
    assert.equal((await call(nullState.captured, { sessionId: 's1' })).value, null)
  })

  test('omits stats when the kernel read is missing, throwing, or malformed', async () => {
    const missing = liveFake(stateOf())
    assert.equal(((await call(missing.captured, { sessionId: 's1' })).value as { parts: Record<string, unknown> }).parts.stats, undefined)
    const throwing = liveFake(stateOf(), () => { throw new Error('kernel down') })
    assert.equal(((await call(throwing.captured, { sessionId: 's1' })).value as { parts: Record<string, unknown> }).parts.stats, undefined)
    const malformed = liveFake(stateOf(), () => ({ asOfSeq: 1.5, values: { other: 1 } }))
    const body = (await call(malformed.captured, { sessionId: 's1' })).value as Record<string, unknown>
    assert.equal(body.asOfSeq, undefined)
    assert.equal((body.parts as Record<string, unknown>).stats, undefined)
    const negative = liveFake(stateOf(), () => ({ asOfSeq: -1, values: { sessionStats: {} } }))
    const negBody = (await call(negative.captured, { sessionId: 's1' })).value as Record<string, unknown>
    assert.equal(negBody.asOfSeq, undefined)
  })

  test('falls back to the projections stateOf face when no gate is supplied', async () => {
    const state = stateOf()
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => ({ id: 's1' }) },
      sessionProjections: { stateOf: () => state, snapshot: () => ({ asOfSeq: 3, values: {} }) },
    })
    watchFactsChannel(fake.ctx, BOUNDS)
    const body = await call(fake.captured, { sessionId: 's1' })
    assert.equal((body.value as { live: boolean }).live, true)
  })

  test('turns an unexpected failure into a gateway error', async () => {
    const fake = fakeCtx({
      connection: connectionOf(),
      sessions: { get: () => ({ id: 's1' }) },
      sessionProjections: { stateOf: () => { throw new Error('boom') } },
    })
    watchFactsChannel(fake.ctx, BOUNDS)
    const body = await call(fake.captured, { sessionId: 's1' })
    assert.equal(body.ok, false)
    assert.equal((body.error as { code: string }).code, 'gateway/internal')
  })
})

function richState(): TimelineState {
  const state = createTimelineState()
  state.detailRev = 4
  state.surface = [
    { seq: 1, cat: 'user', tokens: 1 },
    { seq: 2, cat: 'tool', tokens: 2 },
    { seq: 3, cat: 'assistant', tokens: 3 },
    { seq: 4, cat: 'inject', tokens: 4 },
    { seq: 5, cat: 'tool', tokens: 5 },
  ]
  state.archived = [{ seq: 2, cat: 'tool', tokens: 2, gone: 6 }]
  state.archiveFloor = 2
  state.requests = [{ seq: 5, time: 10, total: 5, turn: 1, step: 2, prompt: 4 }]
  state.events = [{ seq: 4, time: 9, kind: 'inject', form: 'context', tokens: 4 }]
  state.fileOps = [{ seq: 5, path: 'x.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }]
  state.fileOpsFloor = 3
  state.commands = [
    { seq: 5, time: 10, tool: 'bash', cmd: 'ls', start: 9, status: 'completed', err: false, run: 1 } as never,
  ]
  state.commandsFloor = 4
  state.commandStats = { runs: 1, failed: 0, ms: 5, bg: 0 }
  state.spans = [{ kind: 'ttft', start: 1, end: 2 }, { kind: 'text', start: 2, end: 3 }]
  return state
}

describe('detail parts and windows', () => {
  test('serves windowed detail parts from a provided live detail state', async () => {
    const head = stateOf() as import('../../src/host/foldState').TimelineState
    const fake = liveFake(head, undefined, { detailState: async () => ({ ...richState(), detailRev: head.detailRev ?? 0 }) })
    const body = (await call(fake.captured, {
      sessionId: 's1',
      parts: ['requests', 'nodes', 'events', 'files', 'commands', 'spans'],
      window: { nodesTail: 2, spansTail: 1, commandsTail: 1, eventsTail: 1, filesTail: 1, requestsTail: 1 },
    })).value as Record<string, unknown>
    const parts = body.parts as Record<string, unknown>
    const nodes = parts.nodes as { nodes: { seq: number; cat: string }[]; droppedNodes: number; surfaceFloor: number; archive: unknown[]; archiveFloor: number }
    assert.equal(nodes.droppedNodes, 3)
    assert.equal(nodes.surfaceFloor, 3)
    assert.equal(nodes.archiveFloor, 2)
    assert.equal(nodes.archive.length, 1)
    assert.deepEqual(nodes.nodes.map(n => n.seq), [4, 5])
    const files = parts.files as { fileOps: unknown[]; fileOpsFloor: number }
    assert.equal(files.fileOps.length, 1)
    assert.equal(files.fileOpsFloor, 3)
    const commands = parts.commands as { commands: { call?: unknown }[]; commandsFloor: number; commandStats: { runs: number } }
    assert.equal(commands.commands.length, 1)
    assert.equal(commands.commands[0].call, undefined)
    assert.equal(commands.commandsFloor, 4)
    assert.equal(commands.commandStats.runs, 1)
    assert.deepEqual(parts.spans, [{ kind: 'text', start: 2, end: 3 }])
    assert.equal((parts.events as unknown[]).length, 1)
    assert.equal((parts.requests as unknown[]).length, 1)
    assert.equal(body.missing, undefined)
  })

  test('treats a missing detail revision as revision zero', async () => {
    const head = createTimelineState()
    const fake = liveFake(head, undefined, { detailState: async () => ({ ...richState(), detailRev: undefined }) })
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['nodes'] })).value as Record<string, unknown>
    assert.equal((body.parts as Record<string, unknown>).nodes !== undefined, true)
    assert.equal(body.missing, undefined)
  })

  test('rejects a detail fold from another revision and keeps the head-only series out', async () => {
    const head = stateOf() as import('../../src/host/foldState').TimelineState
    const fake = liveFake(head, undefined, { detailState: async () => ({ ...richState(), detailRev: (head.detailRev ?? 0) + 1 }) })
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['head', 'series', 'nodes'] })).value as Record<string, unknown>
    assert.deepEqual(body.missing, ['nodes', 'series'], 'a foreign revision must not bleed into the cut')
    const parts = body.parts as Record<string, unknown>
    assert.equal('nodes' in parts, false)
  })

  test('series carries the full request breakdown for the trend and per-step composition', async () => {
    const head = stateOf() as import('../../src/host/foldState').TimelineState
    const fullRequests = [
      { seq: 1, time: 1, total: 10, turn: 1, step: 0, system: 2, tools: 3, user: 4, inject: 0, assistant: 5, tool: 6, prompt: 9 },
      { seq: 2, time: 2, total: 20, turn: 1, step: 1, system: 2, tools: 3, user: 4, inject: 0, assistant: 10, tool: 11 },
    ]
    const fake = liveFake(head, undefined, { detailState: async () => ({ ...head, requests: fullRequests as never }) })
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['head', 'series'] })).value as Record<string, unknown>
    const series = (body.parts as { series: Record<string, unknown>[] }).series
    assert.equal(series.length, 2)
    assert.deepEqual(series[0], fullRequests[0], 'the trend needs the category buckets, not the trimmed total')
    assert.deepEqual(series[1], fullRequests[1])
  })

  test('serves series from the full detail state, not the trimmed head window', async () => {
    const head = stateOf() as import('../../src/host/foldState').TimelineState
    const detailState = { ...head, requests: Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, time: i, total: i + 1 })) }
    const fake = liveFake(head, undefined, { detailState: async () => detailState })
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['head', 'series'] })).value as Record<string, unknown>
    const parts = body.parts as Record<string, unknown>
    assert.equal((parts.series as unknown[]).length, 5, 'the trend series needs the full request history')
    assert.equal((parts.head as { current: { total: number } }).current.total, head.sums.user + head.systemTokens + head.toolsTokens + head.sums.inject + head.sums.skill + head.sums.assistant + head.sums.tool)
    assert.equal(body.missing, undefined)
  })

  test('reports series as missing when the head state has no detail companion', async () => {
    const fake = liveFake(stateOf())
    const body = (await call(fake.captured, { sessionId: 's1', parts: ['series'] })).value as Record<string, unknown>
    assert.deepEqual(body.missing, ['series'])
    const parts = body.parts as Record<string, unknown>
    assert.equal((parts.series as unknown[]).length, 1, 'the head window still backs a degraded series')
  })

  test('omits detail parts and reports them as missing when no detail state is available', async () => {
    const absent = liveFake(stateOf())
    const absentBody = (await call(absent.captured, { sessionId: 's1', parts: ['nodes', 'missing-part'] })).value as Record<string, unknown>
    assert.deepEqual(absentBody.missing, ['nodes'])
    const nullRead = liveFake(stateOf(), undefined, { detailState: async () => null })
    assert.deepEqual(((await call(nullRead.captured, { sessionId: 's1', parts: ['nodes'] })).value as Record<string, unknown>).missing, ['nodes'])
    const throwing = liveFake(stateOf(), undefined, { detailState: async () => { throw new Error('shadow down') } })
    assert.deepEqual(((await call(throwing.captured, { sessionId: 's1', parts: ['nodes'] })).value as Record<string, unknown>).missing, ['nodes'])
  })

  test('clamps and defaults the requested window', async () => {
    const head = stateOf() as import('../../src/host/foldState').TimelineState
    const fake = liveFake(head, undefined, { detailState: async () => ({ ...richState(), detailRev: head.detailRev ?? 0 }) })
    const clamped = (await call(fake.captured, {
      sessionId: 's1',
      parts: ['nodes', 'spans'],
      window: { nodesTail: -5, spansTail: 99999, requestsTail: 'bad', eventsTail: Number.NaN },
    })).value as Record<string, unknown>
    const nodes = (clamped.parts as Record<string, unknown>).nodes as { nodes: { seq: number }[]; droppedNodes: number }
    assert.equal(nodes.droppedNodes, 3)
    assert.deepEqual(nodes.nodes.map(n => n.seq), [4, 5])
    assert.equal(((clamped.parts as Record<string, unknown>).spans as unknown[]).length, 2)
    const nonWindow = (await call(fake.captured, { sessionId: 's1', parts: ['spans'], window: 42 })).value as Record<string, unknown>
    assert.equal(((nonWindow.parts as Record<string, unknown>).spans as unknown[]).length, 2)
  })
})

describe('cold sessions', () => {
  test('returns null without an observation face and when the cold gate skips the read', async () => {
    const noQuery = fakeCtx({ connection: connectionOf() })
    watchFactsChannel(noQuery.ctx, BOUNDS)
    assert.equal((await call(noQuery.captured, { sessionId: 's2' })).value, null)

    const { fake } = coldCtx({ revision: 'r1' })
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: SKIP_GATE })
    assert.equal((await call(fake.captured, { sessionId: 's2' })).value, null)
  })

  test('folds the log, caches state per revision and reuses it on the next call', async () => {
    const cache = {
      cachedSnapshot: (header: unknown, keys: readonly string[]) => {
        assert.deepEqual(header, { id: 's2' })
        assert.deepEqual(keys, ['sessionStats', 'tokenUsage', 'contextBreakdown'])
        return { asOfSeq: 2, values: { sessionStats: { turns: 1 }, tokenUsage: { totals: {} } } }
      },
    }
    const { fake, calls, disposed } = coldCtx({ revision: 'r1', header: { id: 's2' }, cache })
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const body = await call(fake.captured, { sessionId: 's2', parts: ['head', 'series', 'stats'] })
    const value = body.value as Record<string, unknown>
    assert.equal(value.live, false)
    assert.equal(value.asOfSeq, 2)
    assert.equal((value.parts as Record<string, unknown>).stats !== undefined, true)
    assert.equal((await call(fake.captured, { sessionId: 's2', parts: ['head', 'stats'] })).value !== null, true)
    const headOnly = (await call(fake.captured, { sessionId: 's2', parts: ['head'] })).value as Record<string, unknown>
    assert.deepEqual(Object.keys(headOnly.parts as Record<string, unknown>), ['head'])
    assert.equal(calls(), 3, 'the revision is re-read before the cached state is reused')
    assert.equal(disposed(), true)
  })

  test('evicts the oldest cached states once the bound is exceeded', async () => {
    const { fake, calls } = coldCtx({ revision: 'r0' })
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    for (let i = 0; i < 5; i++) {
      assert.equal((await call(fake.captured, { sessionId: 's' + i })).value !== null, true)
    }
    assert.equal(calls(), 5)
  })

  test('rebuilds when the revision is absent and evicts the oldest cached states', async () => {
    const { fake, calls } = coldCtx({})
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    for (let i = 0; i < 5; i++) {
      assert.equal((await call(fake.captured, { sessionId: 's' + i })).value !== null, true)
    }
    assert.equal(calls(), 5)
  })

  test('folds without reading kernel stats when only head is requested', async () => {
    const { fake } = coldCtx({ revision: 'r9' })
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const body = (await call(fake.captured, { sessionId: 's9', parts: ['head'] })).value as Record<string, unknown>
    assert.deepEqual(Object.keys(body.parts as Record<string, unknown>), ['head'])
  })

  test('rejects an observation whose events are not an array', async () => {
    const { fake } = coldCtx({ events: { not: 'events' }, revision: 'r1' })
    watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    assert.equal((await call(fake.captured, { sessionId: 's2' })).value, null)
  })

  test('tolerates a missing, throwing or malformed kernel cache read', async () => {
    for (const cache of [
      undefined,
      { cachedSnapshot: () => { throw new Error('cache down') } },
      { cachedSnapshot: () => ({ values: { other: 'value' } }) },
      { cachedSnapshot: () => ({ asOfSeq: Number.NaN, values: { sessionStats: { turns: 0 } } }) },
    ]) {
      const { fake } = coldCtx({ revision: 'r1', header: { id: 's2' }, ...(cache === undefined ? {} : { cache }) })
      watchFactsChannel(fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
      const body = (await call(fake.captured, { sessionId: 's2' })).value as Record<string, unknown>
      assert.equal(body !== null, true)
    }
  })

  test('turns an observation failure into a gateway error', async () => {
    const withError = coldCtx({ throwOnObserve: true })
    watchFactsChannel(withError.fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    assert.equal(((await call(withError.fake.captured, { sessionId: 's2' })).error as { code: string }).code, 'gateway/internal')
    const withString = coldCtx({ throwOnObserve: true, throwValue: 'observe exploded' })
    watchFactsChannel(withString.fake.ctx, BOUNDS, { coldReads: OPEN_GATE })
    const body = await call(withString.fake.captured, { sessionId: 's2' })
    assert.equal((body.error as { message: string }).message, 'observe exploded')
  })
})
