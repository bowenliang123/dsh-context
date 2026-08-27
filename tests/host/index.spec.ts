// Integration tests for the Host-half plugin module (src/host/index.ts)
// against the REAL cordis registry, session store, and session-projection
// registry — the dsh-canonical harness: real envelopes appended to a real
// session, folded by the registered units, read back through the snapshot
// cut and the change feed.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import type {} from '../../src/shared/types'

const plugin = { name, inject, apply } as never
const noConfig = {} as never

/** Poll until the pending plugin fiber has started and folded the log. */
async function until<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

/** The minimal real envelope trio: header epoch, user message, metered assistant reply. */
function appendRealEnvelopes(session: Session): void {
  session.append('request/header', {
    header: {
      config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
      system: 'sys',
      tools: [],
    },
    reason: 'initial',
  })
  session.append('user/message', {
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  } as never, { surfaceOp: 'append' })
  session.append('assistant/message', {
    turn: 1,
    step: 0,
    message: { content: [{ type: 'text', text: 'hello' }] },
    usage: { inputTokens: 10, outputTokens: 5 },
  } as never, { surfaceOp: 'append', sourceEventSeqs: [] })
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(plugin, noConfig)
  return { ctx, fiber }
}

describe('dsh-context host plugin', () => {
  test('module shape: name and the sessionProjections inject gate', () => {
    assert.equal(name, 'dsh-context')
    assert.deepEqual(inject, ['sessionProjections'])
  })

  test('registers both units and serves the folded views over real appends', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)

    const snapshot = ctx.sessionProjections.snapshot(session)
    const timeline = snapshot.values.contextTimeline
    assert.ok(timeline !== undefined, 'contextTimeline served after real appends')
    assert.equal(timeline.ok, true)
    assert.equal(timeline.model, 'deepseek-v4-flash')
    assert.equal(timeline.provider, 'deepseek')
    assert.ok(timeline.current.total > 0, 'the folded totals are non-zero')
    assert.equal(timeline.nodes.length, 2, 'user + assistant surface nodes')

    const headers = snapshot.values.contextHeaders
    assert.ok(headers !== undefined, 'contextHeaders served after real appends')
    assert.equal(headers.headers.length, 1)
    assert.equal(headers.headers[0].system, 'sys')
  })

  test('the change feed fires with the schema-validated view', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create()
    const seen: Array<{ key: string; value: unknown }> = []
    ctx.sessionProjections.onChanged((changedSession, key, value) => {
      if (changedSession === session) seen.push({ key, value })
    })
    appendRealEnvelopes(session)

    const timeline = seen.filter(e => e.key === 'contextTimeline')
    assert.ok(timeline.length > 0, 'contextTimeline changes notified')
    const last = timeline.at(-1)?.value
    assert.equal(
      createContextTimelineDefinition({}).schema.safeParse(last).success,
      true,
      'the notified value is the validated wire view',
    )
    assert.ok(seen.some(e => e.key === 'contextHeaders'), 'contextHeaders changes notified')
  })

  test('tool schema rows carry best-effort plugin attribution through real appends', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: {
        config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
        tools: [
          { name: 'bash', description: 'run', parameters: { type: 'object' } },
          { name: 'mcp__github__get_issue', description: 'm', parameters: { type: 'object' } },
          { name: 'agent_teams_add_member', description: 't', parameters: { type: 'object' } },
        ],
      },
      reason: 'initial',
    } as never)
    const headers = ctx.sessionProjections.snapshot(session).values.contextHeaders
    assert.ok(headers !== undefined, 'contextHeaders served after real appends')
    const tools = headers.headers[0].tools
    assert.equal(tools.find(t => t.name === 'bash')?.plugin, '@deepseek-ai/dsh-tool-bash')
    assert.equal(tools.find(t => t.name === 'mcp__github__get_issue')?.plugin, 'mcp:github')
    assert.ok(!('plugin' in tools.find(t => t.name === 'agent_teams_add_member')!), 'unmapped third-party tools stay untagged')
  })

  test('register-hook attribution flows through to the rendered headers', async () => {
    const { ctx } = await boot()
    // dsh-context booted before any tools service existed; a late-provided
    // instance is wrapped on first read inside the registering plugin.
    ctx.provide('tools', { register() { return () => {} } })
    await ctx.plugin({
      name: 'my-agent-tools',
      apply(agentCtx) {
        const tools = (agentCtx as any).tools
        tools.register({ name: 'custom_dynamic_tool', description: 'd', parameters: { type: 'object' } })
      },
    })
    const session = ctx.sessions.create()
    session.append('request/header', {
      header: {
        config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
        tools: [
          { name: 'custom_dynamic_tool', description: 'd', parameters: { type: 'object' } },
          { name: 'bash', description: 'run', parameters: { type: 'object' } },
        ],
      },
      reason: 'initial',
    } as never)
    const headers = ctx.sessionProjections.snapshot(session).values.contextHeaders
    assert.ok(headers !== undefined, 'contextHeaders served after real appends')
    const tools = headers.headers[0].tools
    assert.equal(tools.find(t => t.name === 'custom_dynamic_tool')?.plugin, 'my-agent-tools')
    assert.equal(tools.find(t => t.name === 'bash')?.plugin, '@deepseek-ai/dsh-tool-bash', 'static backbone still applies')
  })

  test('disposing the plugin fiber removes both keys from later snapshots', async () => {
    const { ctx, fiber } = await boot()
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    assert.ok(ctx.sessionProjections.snapshot(session).values.contextTimeline !== undefined)

    await fiber.dispose()
    const snapshot = ctx.sessionProjections.snapshot(session)
    assert.equal(snapshot.values.contextTimeline, undefined, 'an unloaded plugin reads as capability absence')
    assert.equal(snapshot.values.contextHeaders, undefined)
  })

  test('stays pending without the registry, starts when it arrives', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const fiber = ctx.plugin(plugin, noConfig)
    const session = ctx.sessions.create()
    assert.doesNotThrow(() => appendRealEnvelopes(session), 'an absent registry leaves the plugin inert')
    assert.equal(ctx.get('sessionProjections'), undefined)
    assert.notEqual((fiber as unknown as { state: number }).state, 2, 'the fiber is not ACTIVE without its inject')

    await ctx.plugin(SessionProjectionRegistry)
    const timeline = await until(
      () => ctx.sessionProjections.snapshot(session).values.contextTimeline,
      'the plugin never started after the registry arrived',
    )
    assert.equal(timeline.ok, true, 'the late-mounted registry folds the already-appended log')
    await fiber
  })
})
