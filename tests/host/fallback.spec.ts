// The baseline gate's fallback units (src/host/fallback.ts), driven over the
// REAL session-projection registry: the gate's value arrives through the
// ordinary snapshot cut no matter what the log carries, both registry
// contract generations read their own shape off the definition, and cached
// rows from either direction seed harmlessly.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { createFallbackHeadersDefinition, createFallbackTimelineDefinition } from '../../src/host/fallback'
import { BASELINE_DSH_VERSION } from '../../src/shared/version'

const CURRENT = '0.1.1-rc.2'

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  ctx.sessionProjections.register(createFallbackTimelineDefinition(CURRENT) as never)
  ctx.sessionProjections.register(createFallbackHeadersDefinition() as never)
  return ctx
}

function appendAnything(session: Session): void {
  session.append('request/header', {
    header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' }, system: 'sys', tools: [] },
    reason: 'initial',
  })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
}

describe('fallback units over the real registry', () => {
  test('the gate value arrives through the snapshot cut regardless of the log', async () => {
    const ctx = await boot()
    const session = ctx.sessions.create()
    appendAnything(session)

    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined)
    assert.equal(timeline.ok, true)
    assert.deepEqual(timeline.unsupported, { current: CURRENT, minimum: BASELINE_DSH_VERSION })
    assert.equal(timeline.current.total, 0, 'nothing is folded')
    assert.equal(timeline.requests.length, 0)
    assert.equal(timeline.nodes.length, 0)
    assert.equal(timeline.archive.length, 0)
    assert.equal(timeline.droppedNodes, 0)
    assert.equal(timeline.model, undefined)

    const headers = ctx.sessionProjections.snapshot(session).values.contextHeaders
    assert.ok(headers !== undefined)
    assert.deepEqual(headers.headers, [])
  })

  test('the served views pass the real wire schemas', () => {
    const timeline = createFallbackTimelineDefinition(CURRENT)
    assert.equal(timeline.wire.viewSchema.safeParse(timeline.wire.view({})).success, true)
    const headers = createFallbackHeadersDefinition()
    assert.equal(headers.wire.viewSchema.safeParse(headers.wire.view({})).success, true)
  })

  test('apply is a total identity over any event', () => {
    const timeline = createFallbackTimelineDefinition(CURRENT)
    const state = timeline.init()
    assert.deepEqual(state, {})
    assert.ok(timeline.apply(state, { type: 'user/message', seq: 1, time: 0, data: {} } as never) === state)
    assert.ok(timeline.apply(state, { type: 'bogus/event' } as never) === state, 'unknown event types pass through')
    const headers = createFallbackHeadersDefinition()
    assert.ok(headers.apply(state, { type: 'request/header', seq: 1, time: 0, data: null } as never) === state)
  })

  test('the state schema strips any cached row instead of rejecting it', () => {
    const timeline = createFallbackTimelineDefinition(CURRENT)
    // A ver-1 row of the REAL headers unit ({headers: [...]}) or any other
    // persisted shape seeds the gate's fold stripped to the empty state.
    assert.deepEqual(timeline.stateSchema.parse({ headers: [{ seq: 1 }] }), {})
    assert.deepEqual(timeline.stateSchema.parse({ surface: [null], sums: {} }), {})
    assert.equal(timeline.stateVersion, 1)
  })

  test('both registry contract generations read their shape off one definition', () => {
    const timeline = createFallbackTimelineDefinition(CURRENT)
    // Pre-0.1.1 aliases: top-level `schema` + `view`.
    assert.equal(timeline.schema.safeParse(timeline.view({})).success, true)
    assert.deepEqual(timeline.view({}).unsupported, { current: CURRENT, minimum: BASELINE_DSH_VERSION })
    const headers = createFallbackHeadersDefinition()
    assert.equal(headers.schema.safeParse(headers.view({})).success, true)
    assert.deepEqual(headers.view({}), { headers: [] })
  })
})
