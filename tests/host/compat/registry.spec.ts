// The always-on compatibility matrix — HOST side. For every supported dsh
// baseline (tests/baselines.ts) the plugin's REAL projection definitions are
// registered through a driver of that baseline's registry semantics
// (registryDriver.ts, mirrored from the dsh source at each tag) and driven
// over a canonical session log. This is the regression net for the recurring
// host-side compatibility incidents: a fold that throws under one registry
// generation (issues #26/#8 — the tab stuck "Reading the session log…"), a
// state that fails the projection cache's plain-JSON write gate (issues
// #5-#7, #27-#30 — session creation/titles broke host-wide), a stale-row
// restore that must seed through stateSchema, and an init that must tolerate
// the 0.1.2 header argument.
//
// The real-code complement — the ACTUAL dsh registry sources per tag — runs
// in the `compat` vitest project (tests/compat/matrix.spec.ts).

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { BASELINES } from '../../baselines'
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
  toolCall,
  toolResult,
  userMessage,
} from '../helpers/events'
import { assertStatesPlainJson, driveTimeline } from '../helpers/projection'
import type { TimelineEvent } from '../../../src/host/fold'
import { RegistryDriver, RegistryViolationError } from './registryDriver'
import type { Checkpoint, SessionLike } from './registryDriver'

/** A session log touching every envelope family the fold serves. */
function canonicalLog(): TimelineEvent[] {
  return [
    header(1, {
      system: 'You are an agent.',
      tools: [{ name: 'bash', description: 'run a command' }],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
    }),
    requestContext(2, { contextWindow: 128000 }),
    stepStart(3),
    userMessage(4, [{ type: 'text', text: 'hello there' }], { kind: 'user' }),
    assistantMessage(5, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3 } }),
    toolCall(6, { callId: 'c1', name: 'bash' }),
    toolResult(7, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    stepEnd(8),
    assistantMessage(9, { turn: 1, step: 1, usage: { inputTokens: 20, outputTokens: 8 } }),
    compaction(10, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [4] }),
    planMode(11, { active: true }),
  ]
}

/** The full durable log: the seq-0 session/created envelope (fold-ignored) plus the canonical body. */
function fullLog(): TimelineEvent[] {
  return [{ seq: 0, time: 0, type: 'session/created', data: {} } as unknown as TimelineEvent, ...canonicalLog()]
}

/** A live session folded through the driver, event by event (the log is returned for restore reads). */
function bootSession(baselineIndex: number, log = fullLog()): { driver: RegistryDriver; session: SessionLike; log: TimelineEvent[] } {
  const baseline = BASELINES[baselineIndex]
  const driver = new RegistryDriver(baseline)
  driver.register(createContextTimelineDefinition({}))
  driver.register(createContextHeadersDefinition())
  const session: SessionLike = { seq: 0, header: { id: 's-matrix', cwd: '/tmp' }, events: [] }
  driver.sessionCreated(session)
  for (const event of log) {
    session.events[event.seq] = event
    session.seq = event.seq + 1
    driver.driveEvent(session, event)
  }
  return { driver, session, log }
}

for (const [index, baseline] of BASELINES.entries()) {
  describe(`registry contract — ${baseline.id}`, () => {
    test('accepts both real units and serves both wire values after the canonical log', () => {
      const { driver, session } = bootSession(index)
      const snapshot = driver.snapshot(session)
      assert.deepEqual(Object.keys(snapshot.values).sort(), ['contextHeaders', 'contextTimeline'])
      assert.equal(snapshot.asOfSeq, 11)
      const timeline = snapshot.values.contextTimeline as { current: { total: number }; nodes: unknown[] }
      assert.ok(timeline.current.total > 0)
      assert.ok(timeline.nodes.length > 0)
      const headers = snapshot.values.contextHeaders as { headers: { tools: { name: string }[] }[] }
      assert.equal(headers.headers[0].tools[0].name, 'bash')
    })

    test('init tolerates the baseline call shape: with the header arg when the registry passes one, without before', () => {
      const timelineDef = createContextTimelineDefinition({})
      const headersDef = createContextHeadersDefinition()
      const probe = { id: 's-init', cwd: '/tmp' }
      for (const def of [timelineDef, headersDef]) {
        const bare = (def.init as () => unknown)()
        const headed = (def.init as (header: unknown) => unknown)(probe)
        assert.deepEqual(bare, headed, 'the zero-argument init ignores the 0.1.2 header argument')
      }
      // And through the driver, whose init arity follows the baseline.
      const driver = new RegistryDriver(baseline)
      driver.register(createContextTimelineDefinition({}))
      const session: SessionLike = { seq: 0, header: probe, events: [] }
      driver.sessionCreated(session)
      assert.equal(driver.snapshot(session).values.contextTimeline !== undefined, true)
    })

    test('every intermediate fold state and checkpoint row passes the projection cache write gate', () => {
      // The #5-#7/#27-#30 class: ONE undefined-valued property failed EVERY
      // cache write for the session and broke sessions host-wide.
      const { driver, session } = bootSession(index)
      const rows = driver.checkpointJson(session)
      assert.ok(rows !== undefined, 'checkpoint rows are losslessly JSON-serializable')
      for (const key of ['contextTimeline', 'contextHeaders']) {
        const row = rows[key] as { ver: number; seq: number }
        assert.equal(row.ver, key === 'contextTimeline' ? 11 : 1)
        assert.equal(row.seq, 11)
      }
      // And the write-gate equivalent on every intermediate state of a fresh fold.
      assertStatesPlainJson(driveTimeline(canonicalLog()))
    })

    test('cached rows restore: viewCheckpoint serves them, restore seeds them through stateSchema', () => {
      const log = fullLog()
      const { driver, session } = bootSession(index, log)
      const rows = driver.checkpoint(session)

      const viewed = driver.viewCheckpoint(rows)
      assert.deepEqual(Object.keys(viewed).sort(), ['contextHeaders', 'contextTimeline'])

      // A stale-row tail read: the floor anchors one below the lowest usable watermark.
      const floor = driver.restoreFloor(rows)
      assert.equal(floor, 11)
      // A full cold read (empty rows, baseSeq 0) refolds from init and matches the live snapshot.
      const cold = driver.restore({}, log, 0, session.header)
      assert.deepEqual(cold.values, driver.snapshot(session).values)

      // A warm read seeded from the rows equals the live cut too (the rows ride stateSchema).
      const warm = driver.restore(rows, log, 0, session.header)
      assert.deepEqual(warm.values, driver.snapshot(session).values)
    })

    test('a corrupted checkpoint row is skipped by viewCheckpoint, never served', () => {
      const { driver, session } = bootSession(index)
      const rows: Checkpoint = driver.checkpoint(session)
      rows.contextTimeline = { ver: 999, seq: 11, val: rows.contextTimeline.val }
      const viewed = driver.viewCheckpoint(rows)
      assert.equal(viewed.contextTimeline, undefined)
      assert.ok(viewed.contextHeaders !== undefined)
    })

    test('the change gate: an uninteresting event keeps its state reference and notifies nothing', () => {
      const { driver, session } = bootSession(index)
      const seen: string[] = []
      driver.onChanged((_s, key) => seen.push(key))
      const before = driver.snapshot(session)
      // A durable event family the fold ignores (registry still drives it through apply).
      const foreign = { seq: 12, time: 1, type: 'assistant/chunk', data: {} } as unknown as TimelineEvent
      session.events[12] = foreign
      session.seq = 13
      driver.driveEvent(session, foreign)
      const after = driver.snapshot(session)
      assert.deepEqual(after.values, before.values)
      assert.deepEqual(seen, [])
    })

    test('a malformed committed event must not throw the drive (a throwing fold stalls the push feed)', () => {
      const { driver, session } = bootSession(index)
      const malformed = [
        { type: 'user/message', seq: 12, time: 1, data: null },
        { type: 'tool/call', seq: 12, time: 1, data: { callId: 42, name: null } },
        { type: 'assistant/message', seq: 12, time: 1, data: { message: 'not-a-record' } },
      ] as unknown as TimelineEvent[]
      for (const event of malformed) {
        session.events[event.seq] = event
        session.seq = event.seq + 1
        assert.doesNotThrow(() => driver.driveEvent(session, event))
      }
      assert.ok(driver.snapshot(session).values.contextTimeline !== undefined)
    })

    test('registry registration rules: bad stateVersion and shared-key version conflicts are refused', () => {
      const driver = new RegistryDriver(baseline)
      const def = createContextTimelineDefinition({})
      assert.throws(() => driver.register({ ...def, key: 'x' as never, stateVersion: -1 }), RegistryViolationError)
      assert.throws(() => driver.register({ ...def, key: 'y' as never, stateVersion: 1.5 }), RegistryViolationError)
      driver.register(def)
      // Same key at the SAME stateVersion shares the registration (preset ref-counting).
      assert.doesNotThrow(() => driver.register(createContextTimelineDefinition({})))
      assert.throws(() => driver.register({ ...def, stateVersion: 12 }), RegistryViolationError)
    })
  })
}

describe('registry contract — settings namespace seam', () => {
  // Both baselines enforce `/^[a-z][a-z0-9-]*$/` on registered namespaces —
  // inside the removed `settingsNamespace()` helper before 0.1.2-alpha.2,
  // inside `settings.register` since. The plugin registers the raw literal
  // (branded cast), so the literal must pass the pattern on every baseline.
  const NAMESPACE_PATTERN = /^[a-z][a-z0-9-]*$/
  const SETTINGS_NAMESPACE = 'dsh-context'

  test('the plugin namespace passes the enforcement pattern of every baseline', () => {
    assert.equal(NAMESPACE_PATTERN.test(SETTINGS_NAMESPACE), true)
  })
})
