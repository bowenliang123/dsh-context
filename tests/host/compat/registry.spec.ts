import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { createContextActivityDefinition } from '../../../src/host/activity'
import { createContextHeadersDefinition } from '../../../src/host/headers'
import { createContextTimelineDefinition } from '../../../src/host/timeline'
import {
  assistantMessage,
  compaction,
  header,
  planMode,
  requestContext,
  stepEnd,
  stepStart,
  systemMessage,
  toolCall,
  toolResult,
  userMessage,
} from '../helpers/events'
import type { TimelineEvent } from '../../../src/host/fold'
import type { TimelineState } from '../../../src/host/foldState'
import type { HeadersState } from '../../../src/host/headers'
import type { ActivityState } from '../../../src/host/activity'
import { RegistryDriver, RegistryViolationError } from './registryDriver'
import type { Checkpoint, SessionLike } from './registryDriver'
import { assertStatesPlainJson, driveTimeline } from '../helpers/projection'

function canonicalLog(): TimelineEvent[] {
  return [
    header(1, {
      tools: [{ name: 'bash', description: 'run a command' }],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    }),
    systemMessage(2),
    requestContext(3, { contextWindow: 128000 }),
    stepStart(4),
    userMessage(5, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(6, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(7, { callId: 'c1', name: 'bash' }),
    toolResult(8, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(9),
    assistantMessage(10, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(11, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [5] }),
    planMode(12, { active: true }),
  ]
}

function fullLog(): TimelineEvent[] {
  return [{ seq: 0, time: 0, type: 'session/created', data: {} } as unknown as TimelineEvent, ...canonicalLog()]
}

function bootSession(log = fullLog(), slim = false): { driver: RegistryDriver; session: SessionLike } {
  const driver = new RegistryDriver()
  driver.register(createContextTimelineDefinition({}, () => slim))
  driver.register(createContextHeadersDefinition())
  const session: SessionLike = { seq: 0, header: { id: slim ? 's-slim' : 's-matrix', cwd: '/tmp' }, inheritedEventCount: 0, events: [] }
  driver.sessionCreated(session)
  for (const event of log) {
    session.events[event.seq] = event
    session.seq = event.seq + 1
    driver.driveEvent(session, event)
  }
  return { driver, session }
}

describe('registry contract — the semantics every supported line shares', () => {
  test('accepts both real units and serves both wire values after the canonical log; the slim head rides the same contract', () => {
    const { driver, session } = bootSession()
    const snapshot = driver.snapshot(session)
    assert.deepEqual(Object.keys(snapshot.values).sort(), ['contextHeaders', 'contextTimeline'])
    assert.equal(snapshot.asOfSeq, 12)
    const timeline = snapshot.values.contextTimeline as { current: { total: number }; nodes: unknown[] }
    assert.ok(timeline.current.total > 0)
    assert.ok(timeline.nodes.length > 0)
    const headers = snapshot.values.contextHeaders as { headers: { tools: { name: string }[] }[] }
    assert.equal(headers.headers[0].tools[0].name, 'bash')
    assertStatesPlainJson(driveTimeline(canonicalLog()))

    const log = fullLog()
    const slim = bootSession(log, true)
    const slimTimeline = slim.driver.snapshot(slim.session).values.contextTimeline as {
      detailRev?: number
      counts?: { steps: number }
      nodes: unknown[]
      requests: unknown[]
    }
    assert.equal(typeof slimTimeline.detailRev, 'number', 'the split marker rides the push feed')
    assert.equal(slimTimeline.counts?.steps, 2, 'the counters travel on the head')
    assert.equal(slimTimeline.nodes.length, 0, 'the collections stay off the wire')
    assert.equal(slimTimeline.requests.length, 0)
    assert.ok(slim.driver.checkpointJson(slim.session) !== undefined)
    const cold = slim.driver.restore({}, log, 0, slim.session.header)
    assert.deepEqual(cold.values, slim.driver.snapshot(slim.session).values)
  })

  test('the local unit contract stays assignable to the harness projection contract', () => {
    const timeline: ProjectionDefinition<'contextTimeline', TimelineState> = createContextTimelineDefinition({}, () => false)
    const headers: ProjectionDefinition<'contextHeaders', HeadersState> = createContextHeadersDefinition()
    const activity: ProjectionDefinition<'contextActivity', ActivityState> = createContextActivityDefinition()
    for (const definition of [timeline, headers, activity]) {
      assert.ok(definition.wire !== undefined, 'every unit serves a client view')
      const state = (definition.init as () => unknown)()
      assert.equal(definition.wire.viewSchema.safeParse(definition.wire.view(state as never)).success, true)
    }
  })

  test('init tolerates the registry call shape: the header and inherited-count arguments go unobserved', () => {
    const timelineDef = createContextTimelineDefinition({}, () => false)
    const headersDef = createContextHeadersDefinition()
    const probe = { id: 's-init', cwd: '/tmp' }
    for (const def of [timelineDef, headersDef]) {
      const bare = (def.init as () => unknown)()
      const headed = (def.init as (header: unknown, inheritedEventCount: number) => unknown)(probe, 7)
      assert.deepEqual(bare, headed, 'the zero-argument init ignores the registry arguments')
    }
    const driver = new RegistryDriver()
    driver.register(createContextTimelineDefinition({}, () => false))
    const session: SessionLike = { seq: 0, header: probe, inheritedEventCount: 7, events: [] }
    driver.sessionCreated(session)
    assert.equal(driver.snapshot(session).values.contextTimeline !== undefined, true)
  })

  test('the checkpoint rows pass the projection cache write gate at the canonical log end', () => {
    const { driver, session } = bootSession()
    const rows = driver.checkpointJson(session)
    assert.ok(rows !== undefined, 'checkpoint rows are losslessly JSON-serializable')
    for (const key of ['contextTimeline', 'contextHeaders']) {
      const row = rows[key] as { ver: number; seq: number }
      assert.equal(row.ver, key === 'contextTimeline' ? 37 : 1)
      assert.equal(row.seq, 12)
    }
  })

  test('cached rows restore: viewCheckpoint serves them, restore seeds them through stateSchema', () => {
    const log = fullLog()
    const { driver, session } = bootSession(log)
    const rows = driver.checkpoint(session)
    const viewed = driver.viewCheckpoint(rows)
    assert.deepEqual(Object.keys(viewed).sort(), ['contextHeaders', 'contextTimeline'])
    const floor = driver.restoreFloor(rows)
    assert.equal(floor, 12)

    const warm = driver.restore(rows, log, 0, session.header)
    assert.deepEqual(warm.values, driver.snapshot(session).values)
  })

  test('issue #44 recovery and rollback: a version mismatch discards the row and the refold re-tracks every step', () => {
    const log = [
      ...fullLog(),
      assistantMessage(13, { turn: 1, step: 2, usage: { inputTokens: -80, cacheReadTokens: 150.7, outputTokens: 22.4 } }),
      assistantMessage(14, { turn: 1, step: 3, usage: { inputTokens: NaN, outputTokens: null } }),
      assistantMessage(15, { turn: 1, step: 4, usage: { inputTokens: 12 } }),
    ]
    const { driver, session } = bootSession(log)
    const stale: Checkpoint = {
      ...driver.checkpoint(session),
      contextTimeline: {
        ver: 12,
        seq: 15,
        val: {
          surface: [],
          sums: { user: 0, inject: 0, assistant: 0, tool: 0 },
          systemTokens: 0,
          toolsTokens: 0,
          requests: [{ seq: 10, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: -80, cacheRead: 150, output: 22 }],
          events: [],
          archived: [],
          callNames: {},
        },
      },
    }
    const viewed = driver.viewCheckpoint(stale)
    assert.equal(viewed.contextTimeline, undefined)
    assert.ok(viewed.contextHeaders !== undefined, 'the untouched row still serves')
    const restored = driver.restore(stale, log, 0, session.header)
    const timeline = restored.values.contextTimeline as { current: { total: number }; nodes: unknown[] }
    assert.ok(timeline.current.total > 0, 'the refold serves the wire view')
    const refolded = (driver.checkpoint(session).contextTimeline as { val: { requests: { seq: number; prompt?: number }[] } }).val
    assert.deepEqual(refolded.requests.map(r => r.seq), [6, 10, 13, 14, 15], 'the refold re-tracks every step')
    assert.deepEqual(
      refolded.requests.filter(r => r.seq >= 13).map(r => r.prompt ?? null),
      [151, null, 12],
      'the persisted records keep the sanitized prompt figure (issue #44)',
    )

    const currentLog = fullLog()
    const current = bootSession(currentLog)
    const rows = current.driver.checkpoint(current.session)
    const rolledBack = new RegistryDriver()
    rolledBack.register({ ...createContextTimelineDefinition({}, () => false), stateVersion: 12 })
    rolledBack.register(createContextHeadersDefinition())
    assert.equal(rolledBack.viewCheckpoint(rows).contextTimeline, undefined)
    const rolled = rolledBack.restore(rows, currentLog, 0, current.session.header)
    const rolledTimeline = rolled.values.contextTimeline as { current: { total: number } }
    assert.ok(rolledTimeline.current.total > 0)
    const rolledVal = (rolledBack.checkpoint(current.session).contextTimeline as { val: { requests: unknown[] } }).val
    assert.equal(rolledVal.requests.length, 2)
  })

  test('the change gate keeps an uninteresting event inert; malformed committed events never throw the drive', () => {
    const { driver, session } = bootSession()
    const seen: string[] = []
    driver.onChanged((_s, key) => seen.push(key))
    const before = driver.snapshot(session)
    const foreign = { seq: 13, time: 1, type: 'todo/write', data: {} } as unknown as TimelineEvent
    session.events[13] = foreign
    session.seq = 14
    driver.driveEvent(session, foreign)
    const after = driver.snapshot(session)
    assert.deepEqual(after.values, before.values)
    assert.deepEqual(seen, [])

    const malformed = [
      { type: 'user/message', seq: 14, time: 1, data: null },
      { type: 'tool/call', seq: 15, time: 1, data: { callId: 42, name: null } },
      { type: 'assistant/message', seq: 16, time: 1, data: { message: 'not-a-record' } },
    ] as unknown as TimelineEvent[]
    for (const event of malformed) {
      session.events[event.seq] = event
      session.seq = event.seq + 1
      assert.doesNotThrow(() => driver.driveEvent(session, event))
    }
    assert.ok(driver.snapshot(session).values.contextTimeline !== undefined)
  })

  test('registry registration rules: bad stateVersion and shared-key version conflicts are refused', () => {
    const driver = new RegistryDriver()
    const def = createContextTimelineDefinition({}, () => false)
    assert.throws(() => driver.register({ ...def, key: 'x' as never, stateVersion: -1 }), RegistryViolationError)
    assert.throws(() => driver.register({ ...def, key: 'y' as never, stateVersion: 1.5 }), RegistryViolationError)
    driver.register(def)
    assert.doesNotThrow(() => driver.register(createContextTimelineDefinition({}, () => false)))
    assert.throws(() => driver.register({ ...def, stateVersion: def.stateVersion + 1 }), RegistryViolationError)
    const disposable = new RegistryDriver()
    const dispose = disposable.register(createContextTimelineDefinition({}, () => false))
    const session: SessionLike = { seq: 0, header: { id: 'reg' }, inheritedEventCount: 0, events: [] }
    disposable.sessionCreated(session)
    assert.ok(disposable.snapshot(session).values.contextTimeline !== undefined)
    dispose()
    assert.equal(disposable.snapshot(session).values.contextTimeline, undefined, 'the returned disposer unregisters the key')
  })
})
