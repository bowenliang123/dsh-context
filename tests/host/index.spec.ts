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

const HOMES = fileURLToPath(new URL('./fixtures/version/homes', import.meta.url))

async function bootWithHome(home: string) {
  const ctx = new Context()
  ctx.provide('dshHomePath', (...segments: string[]) => join(HOMES, home, ...segments))
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(plugin, noConfig)
  return { ctx, fiber }
}

async function until<T>(read: () => T | undefined, message: string): Promise<T> {
  for (let i = 0; i < 200; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  assert.fail(message)
}

function appendRealEnvelopes(session: Session): void {
  session.append('request/header', {
    header: {
      config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
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
  } as never, { surfaceOp: 'append' })
}

async function boot() {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  const fiber = await ctx.plugin(plugin, noConfig)
  return { ctx, fiber }
}

describe('dsh-context host plugin', () => {
  test('module shape is the sessionProjections inject gate, and all three units serve folded views over real appends', async () => {
    assert.equal(name, 'dsh-context')
    assert.deepEqual(inject, ['sessionProjections'])
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
    assert.ok(!('systemTokens' in headers.headers[0]), 'the system price lives in the timeline systems, never the epoch')

    const activity = snapshot.values.contextActivity
    assert.ok(activity !== undefined, 'contextActivity served after real appends')
    const entries = Object.values(activity.days)
    assert.equal(entries.length, 1, 'the one settlement books its day')
    assert.equal(entries[0].requests, 1)
    assert.equal(entries[0].tokens, 15, 'the metered buckets sum into the day (10 input + 5 output)')
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

  test('tool rows carry the static map and live register-hook attribution through real appends', async () => {
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

    ctx.provide('tools', { register() { return () => {} } })
    await ctx.plugin({
      name: 'my-agent-tools',
      apply(agentCtx) {
        const toolsFace = (agentCtx as any).tools
        toolsFace.register({ name: 'custom_dynamic_tool', description: 'd', parameters: { type: 'object' } })
      },
    })
    const live = ctx.sessions.create()
    live.append('request/header', {
      header: {
        config: { model: 'deepseek-v4-flash', provider: 'deepseek' },
        tools: [
          { name: 'custom_dynamic_tool', description: 'd', parameters: { type: 'object' } },
          { name: 'bash', description: 'run', parameters: { type: 'object' } },
        ],
      },
      reason: 'initial',
    } as never)
    const liveHeaders = ctx.sessionProjections.snapshot(live).values.contextHeaders
    assert.ok(liveHeaders !== undefined, 'contextHeaders served after real appends')
    const liveTools = liveHeaders.headers[0].tools
    assert.equal(liveTools.find(t => t.name === 'custom_dynamic_tool')?.plugin, 'my-agent-tools')
    assert.equal(liveTools.find(t => t.name === 'bash')?.plugin, '@deepseek-ai/dsh-tool-bash', 'static backbone still applies')
  })

  test('disposing the plugin fiber removes every projection key from later snapshots', async () => {
    const { ctx, fiber } = await boot()
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    assert.ok(ctx.sessionProjections.snapshot(session).values.contextTimeline !== undefined)

    await fiber.dispose()
    const snapshot = ctx.sessionProjections.snapshot(session)
    assert.equal(snapshot.values.contextTimeline, undefined, 'an unloaded plugin reads as capability absence')
    assert.equal(snapshot.values.contextHeaders, undefined)
    assert.equal(snapshot.values.contextActivity, undefined)
  })

  test('the split generation with the detail route live: slim wire head + the endpoint serves the collections', async () => {
    const ctx = new Context()
    const routes = new Map<string, { fetch?: (request: Request) => Promise<Response> }>()
    ctx.provide('connection', {
      fetch: {
        register: (r: never) => {
          const route = r as { path: string; fetch?: (request: Request) => Promise<Response> }
          routes.set(route.path, route)
          return () => {}
        },
      },
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    ctx.provide('sessionQuery', {
      observeSession: (id: string) => {
        const target = ctx.sessions.get(id as never)
        if (target === undefined) return Promise.resolve(null)
        return Promise.resolve({
          events: target.snapshotEvents(0 as never, target.seq),
          [Symbol.dispose]: () => {},
        })
      },
    })
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    const call = session.append('tool/call', { turn: 1, step: 1, callId: 'c1', name: 'read', arguments: JSON.stringify({ file_path: 'src/a.ts' }) } as never)
    session.append('tool/result', {
      message: { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }], source: { kind: 'tool', callId: 'c1' } },
    } as never, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })

    const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
    assert.ok(timeline !== undefined)
    assert.equal(typeof timeline.detailRev, 'number', 'the split marker rides the slim head')
    assert.deepEqual(timeline.counts, { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0, skills: 0 })
    assert.equal(timeline.nodes.length, 0, 'the collections stay off the wire value')
    assert.equal(timeline.requests.length, 0)

    assert.ok(routes.has('/api/dsh-context/attachment'), 'the attachment-location route registered beside the detail route')
    const route = routes.get('/api/dsh-context/detail')
    assert.ok(route !== undefined && route.fetch !== undefined, 'the detail route registered')
    const response = await route.fetch(new Request('http://dsh.test/api/dsh-context/detail', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.header.id }),
    }))
    const result = await response.json() as {
      ok: boolean
      value: { rev: number; nodes: unknown[]; requests: unknown[] } | null
    }
    assert.equal(result.ok, true)
    assert.ok(result.value !== null, 'a viewed session is live — its detail serves')
    assert.equal(result.value.rev, timeline.detailRev, 'the payload mirrors the head revision')
    assert.equal(result.value.nodes.length, 3, 'user + assistant + tool-result surface nodes')
    assert.equal(result.value.requests.length, 1)
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
    assert.deepEqual(timeline.unsupported, { current: '0.1.7-rc.2', minimum: BASELINE_DSH_VERSION })
    assert.equal(timeline.current.total, 0, 'the log is NOT folded below the baseline')
    assert.equal(timeline.nodes.length, 0, 'real appends leave no surface nodes')
    assert.equal(timeline.model, undefined, 'no model metadata either')

    const headers = ctx.sessionProjections.snapshot(session).values.contextHeaders
    assert.ok(headers !== undefined)
    assert.deepEqual(headers.headers, [], 'the header epoch is not folded either')
  })

  test('the baseline itself, newer releases, and an unparseable dev version compose the real units', async () => {
    for (const home of ['baseline', 'future', 'dev']) {
      const { ctx } = await bootWithHome(home)
      const session = ctx.sessions.create()
      appendRealEnvelopes(session)
      const timeline = ctx.sessionProjections.snapshot(session).values.contextTimeline
      assert.ok(timeline !== undefined, home)
      assert.equal(timeline.unsupported, undefined, home)
      assert.ok(timeline.current.total > 0, `the real fold runs on ${home}`)
    }
  })
})
