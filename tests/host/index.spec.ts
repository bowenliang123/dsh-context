// Integration tests for the Host-half plugin module (src/host/index.ts)
// against the REAL cordis registry, session store, and session-projection
// registry — the dsh-canonical harness: real envelopes appended to a real
// session, folded by the registered units, read back through the snapshot
// cut and the change feed.

import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { BASELINE_DSH_VERSION } from '../../src/shared/version'
import type {} from '../../src/shared/types'

const plugin = { name, inject, apply } as never
const noConfig = {} as never

/** The committed version-probe homes (see version.spec.ts). */
const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

/** Boot with the probe's home anchor pointing at one fixture harness home. */
async function bootWithHome(home: string) {
  const ctx = new Context()
  ctx.provide('dshHomePath', (...segments: string[]) => join(HOMES, home, ...segments))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(plugin, noConfig)
  return { ctx, fiber }
}

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
    assert.ok(!('system' in headers.headers[0]), 'system text stays in the log, not the projection')
    assert.ok((headers.headers[0].systemTokens ?? 0) > 0, 'the epoch carries its system token price')
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
      createContextTimelineDefinition({}, () => false).wire.viewSchema.safeParse(last).success,
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

  test('the split generation with the detail channel live: slim wire head + the endpoint serves the collections', async () => {
    const ctx = new Context()
    let handler: ((endpoint: string, payload: unknown) => Promise<unknown>) | undefined
    ctx.provide('connection', {
      rpc: {
        handle: (_channel: string, h: never) => {
          handler = h
          return () => {}
        },
      },
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    // A file-tool pair: the fold-derived op log serves through the detail endpoint.
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) } as never)
    session.append('tool/result', {
      callId: 'c1',
      message: { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }], source: { kind: 'tool', callId: 'c1' } },
    } as never, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })

    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined)
    assert.equal(typeof timeline.detailRev, 'number', 'the split marker rides the slim head')
    assert.deepEqual(timeline.counts, { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 })
    assert.equal(timeline.nodes.length, 0, 'the collections stay off the wire value')
    assert.equal(timeline.requests.length, 0)

    assert.ok(handler !== undefined, 'the detail channel registered')
    const result = await handler('detail', { sessionId: session.header.id }) as {
      ok: boolean
      value: { rev: number; nodes: unknown[]; requests: unknown[] } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null, 'a viewed session is live — its detail serves')
    assert.equal(result.value.rev, timeline.detailRev, 'the payload mirrors the head revision')
    assert.equal(result.value.nodes.length, 3, 'user + assistant + tool-result surface nodes')
    assert.equal(result.value.requests.length, 1)
    // The fold-derived op log rides the detail payload.
    const ops = (result.value as { fileOps?: { path: string; kind: string; tool: string }[] }).fileOps
    assert.deepEqual(ops?.map(o => [o.kind, o.tool, o.path]), [['read', 'read', 'src/a.ts']])
  })

  test('without the connection service the wire value stays inline', async () => {
    const { ctx } = await boot()
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined)
    assert.equal(timeline.detailRev, undefined, 'no channel, no split marker')
    assert.equal(timeline.nodes.length, 2, 'the collections ride the wire value as before')
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

describe('the baseline gate', () => {
  test('a below-baseline harness gets the fallback units instead of the folds', async () => {
    const { ctx } = await bootWithHome('old')
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)

    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined, 'the fallback unit still delivers (no eternal loading)')
    assert.deepEqual(timeline.unsupported, { current: '0.1.1-rc.2', minimum: BASELINE_DSH_VERSION })
    assert.equal(timeline.current.total, 0, 'the log is NOT folded below the baseline')
    assert.equal(timeline.nodes.length, 0, 'real appends leave no surface nodes')
    assert.equal(timeline.model, undefined, 'no model metadata either')

    const headers = ctx.sessionProjections.snapshot(session).values.contextHeaders
    assert.ok(headers !== undefined)
    assert.deepEqual(headers.headers, [], 'the header epoch is not folded either')
  })

  test('the baseline itself and newer compose the real units', async () => {
    for (const home of ['baseline', 'future']) {
      const { ctx } = await bootWithHome(home)
      const session = ctx.sessions.create()
      appendRealEnvelopes(session)
      const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
      assert.ok(timeline !== undefined, home)
      assert.equal(timeline.unsupported, undefined, home)
      assert.ok(timeline.current.total > 0, `the real fold runs on ${home}`)
    }
  })

  test('an unparseable harness version fails open into the real units', async () => {
    const { ctx } = await bootWithHome('dev')
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined)
    assert.equal(timeline.unsupported, undefined)
    assert.ok(timeline.current.total > 0, 'a dev-channel harness build is never gated')
  })
})
