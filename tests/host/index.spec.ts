import assert from 'node:assert/strict'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { type Session } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { apply, inject, name } from '../../src/host/index'
import { createContextTimelineDefinition, TIMELINE_STATE_VERSION } from '../../src/host/timeline'
import { BASELINE_DSH_VERSION } from '../../src/shared/version'
import { decodeKindOfBlock, firstTokenTimeOfStream, isTokenChunk, replaceRangeOf, streamTimingOf } from '../../src/host/logShapes'
import { resolveBounds } from '../../src/host/config'
import { watchTimelineRowSweep } from '../../src/host/sweep'
import { buildTimelineHead } from '../../src/host/foldWire'
import { applyTimeline, createTimelineState, type TimelineEvent } from '../../src/host/fold'
import { type TimelineState } from '../../src/host/foldState'
import { fakeCtx, type FakeCtx } from './helpers/ctx'
import { assistantMessage, header, toolCall, toolResult, userMessage } from './helpers/events'
import { createFallbackActivityDefinition, createFallbackHeadersDefinition, createFallbackTimelineDefinition } from '../../src/host/fallback'

describe('index', () => {

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
  test('mounts the facts route with the shared detail shadow', async () => {
    const ctx = new Context()
    const routes = new Map<string, { fetch?: (request: Request) => Promise<Response> }>()
    ctx.provide('connection', {
      fetch: {
        register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    const route = await until(() => routes.get('/api/dsh-context/facts'), 'facts route mounted')
    const response = await route.fetch!(new Request('http://dsh.test/api/dsh-context/facts', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: session.id, parts: ['head', 'nodes'] }),
    }))
    const body = await response.json() as { ok: boolean; value: { parts: Record<string, unknown>; missing?: string[] } }
    assert.equal(body.ok, true)
    assert.ok(body.value.parts.head !== undefined, 'the facts route serves the head')
    assert.deepEqual(body.value.missing, ['nodes'], 'detail parts need an observation face and are reported missing')
  })

  test('mounts the overview route over the live corpus and reports its summary', async () => {
    const ctx = new Context()
    const routes = new Map<string, { fetch?: (request: Request) => Promise<Response> }>()
    ctx.provide('connection', {
      fetch: {
        register(route: { path: string; fetch: (request: Request) => Promise<Response> }) {
          routes.set(route.path, route)
          return () => { routes.delete(route.path) }
        },
      },
    })
    ctx.provide('sessionQuery', {
      listSessions: async () => [...ctx.sessions.list()].map(session => ({ header: session.header, live: true, persisted: true })),
    })
    ctx.provide('sessionProjectionCache', { cachedSnapshot: () => undefined })
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(plugin, noConfig)
    const session = ctx.sessions.create()
    appendRealEnvelopes(session)
    const route = await until(() => routes.get('/api/dsh-context/overview'), 'overview route mounted')
    const response = await route.fetch!(new Request('http://dsh.test/api/dsh-context/overview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'summary' }),
    }))
    const body = await response.json() as { ok: boolean; value: { summary?: { sessions: number; tokens: number; coverage: { complete: boolean } }; revision?: string } }
    assert.equal(body.ok, true)
    assert.equal(body.value.summary?.sessions, 1, 'the live session enters the hosted summary')
    assert.equal(body.value.summary?.tokens !== undefined && body.value.summary.tokens >= 0, true)
    assert.equal(typeof body.value.revision, 'string')
    const unchanged = await route.fetch!(new Request('http://dsh.test/api/dsh-context/overview', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ part: 'summary', revision: body.value.revision }),
    }))
    const unchangedBody = await unchanged.json() as { ok: boolean; value: { unchanged?: boolean; summary?: unknown } }
    assert.equal(unchangedBody.ok, true)
    assert.equal(unchangedBody.value.unchanged, true, 'a repeated summary at the same revision skips the rows')
  })

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
})

describe('logShapes', () => {

describe('decodeKindOfBlock', () => {
  test('maps the three block kinds the harness emits; an unknown or hostile marker stays unattributed', () => {
    assert.equal(decodeKindOfBlock('reasoning'), 'reasoning')
    assert.equal(decodeKindOfBlock('text'), 'text')
    assert.equal(decodeKindOfBlock('tool-call'), 'toolarg')
    for (const value of [undefined, null, '', 'image', 7, {}]) {
      assert.equal(decodeKindOfBlock(value), undefined, JSON.stringify(value))
    }
  })
})

describe('streamTimingOf', () => {
  const chunk = (time: number, blockType: string) => ({ type: 'chunk', time, chunk: { type: 'block-start', blockType } })

  test('tiles [first marker, endTime] in stream order; a lone block owns the tail and a repeated kind stays two spans', () => {
    const timing = streamTimingOf([
      chunk(1000, 'reasoning'),
      { type: 'reasoning-chunks', time0: 1010, index: 0, dt: [], texts: ['think'] },
      chunk(1300, 'text'),
      { type: 'text-chunks', time0: 1310, index: 1, dt: [], texts: ['answer'] },
      chunk(1500, 'tool-call'),
      { type: 'tool-call-chunks', time0: 1510, index: 2, dt: [], id: 'c1', args: ['{}'] },
    ], 2000)
    assert.deepEqual(timing.spans, [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'toolarg', start: 1500, end: 2000 },
    ])
    assert.equal(timing.firstToken, 1010, 'the packed run supplies the token instant')
    assert.deepEqual(streamTimingOf([chunk(500, 'text')], 900).spans, [
      { kind: 'text', start: 500, end: 900 },
    ], 'a single block owns the whole tail to endTime')
    assert.deepEqual(streamTimingOf([
      chunk(1000, 'reasoning'), chunk(1300, 'text'), chunk(1500, 'reasoning'),
    ], 2000).spans, [
      { kind: 'reasoning', start: 1000, end: 1300 },
      { kind: 'text', start: 1300, end: 1500 },
      { kind: 'reasoning', start: 1500, end: 2000 },
    ])
  })

  test('a later block closes the previous one even when its own kind is unknown', () => {
    const timing = streamTimingOf([chunk(1000, 'reasoning'), chunk(1400, 'image')], 1900)
    assert.deepEqual(timing.spans, [{ kind: 'reasoning', start: 1000, end: 1400 }])
  })

  test('a zero-width block paints nothing; a backwards marker clamps to a zero span instead of a negative one', () => {
    const sameInstant = streamTimingOf([chunk(500, 'reasoning'), chunk(500, 'text')], 900)
    assert.deepEqual(sameInstant.spans, [{ kind: 'text', start: 500, end: 900 }])
    const backwards = streamTimingOf([chunk(1000, 'text'), chunk(900, 'reasoning')], 950)
    assert.deepEqual(backwards.spans, [{ kind: 'reasoning', start: 900, end: 950 }])
  })

  test('a marker with an unusable time is skipped WHOLE; the previous block keeps its interval', () => {
    const timing = streamTimingOf([
      chunk(1000, 'reasoning'),
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      chunk(1500, 'text'),
    ], 2000)
    assert.deepEqual(timing.spans, [
      { kind: 'reasoning', start: 1000, end: 1500 },
      { kind: 'text', start: 1500, end: 2000 },
    ])
  })

  test('malformed records, hostile containers, no markers, and a non-finite endTime yield zero', () => {
    assert.deepEqual(streamTimingOf(undefined, 100), { spans: [] })
    assert.deepEqual(streamTimingOf('stream', 100), { spans: [] })
    assert.deepEqual(streamTimingOf([], 100), { spans: [] })
    assert.deepEqual(streamTimingOf([chunk(500, 'text')], Number.NaN), { spans: [] })
    assert.deepEqual(streamTimingOf([{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] }], 100).spans, [])
    assert.equal(streamTimingOf([{ type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } }], Number.NaN).firstToken, 2,
      'the token scan survives a non-finite endTime')
    const hostile = streamTimingOf([
      null, 7, 'x',
      { type: 'chunk' },
      { type: 'chunk', time: 1, chunk: null },
      { type: 'chunk', time: 2, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'chunk', time: 'x', chunk: { type: 'block-start', blockType: 'text' } },
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['a'] },
    ], 100)
    assert.deepEqual(hostile.spans, [])
    assert.equal(hostile.firstToken, 2, 'the delta chunk still anchors the first token')
  })

  test('a token-only read stops at the first token (a packed run answer ends the walk)', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a'] },
      { type: 'chunk', time: 500, chunk: { type: 'text-delta', text: 'later' } },
    ]), 100, 'the packed run answers before the later raw chunk is read')
    assert.equal(firstTokenTimeOfStream([
      { type: 'chunk', time: 200, chunk: { type: 'text-delta', text: 'x' } },
      { type: 'text-chunks', time0: 100, index: 0, dt: [], texts: ['a'] },
    ]), 200)
  })

  test('the first token wins in stream order across raw chunks and packed runs', () => {
    assert.equal(streamTimingOf([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'text-chunks', time0: 200, index: 0, dt: [], texts: ['a'] },
    ], 300).firstToken, 200)
    assert.equal(streamTimingOf([
      { type: 'chunk', time: 250, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'text-chunks', time0: 200, index: 0, dt: [], texts: ['a'] },
    ], 300).firstToken, 250)
    assert.equal(streamTimingOf([chunk(100, 'text')], 300).firstToken, undefined)
  })
})

describe('isTokenChunk', () => {
  test('accepts the three delta kinds the harness counts and rejects empty, non-delta, and hostile shapes', () => {
    assert.equal(isTokenChunk({ type: 'text-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'reasoning-delta', text: 'x' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: '{}' }), true)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', name: 'bash', argumentsDelta: '' }), true)
    assert.equal(isTokenChunk({ type: 'text-delta', text: '' }), false)
    assert.equal(isTokenChunk({ type: 'text-delta' }), false)
    assert.equal(isTokenChunk({ type: 'reasoning-delta', text: 42 }), false)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: '', name: undefined }), false)
    assert.equal(isTokenChunk({ type: 'tool-call-delta', argumentsDelta: 7 }), false)
    assert.equal(isTokenChunk({ type: 'block-start' }), false)
    assert.equal(isTokenChunk({}), false)
    assert.equal(isTokenChunk(null), false)
    assert.equal(isTokenChunk('text-delta'), false)
  })
})

describe('firstTokenTimeOfStream', () => {
  test('reads raw chunks and packed runs, including a leading empty fragment and a missing dt array', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'chunk', time: 100, chunk: { type: 'block-start', index: 0, blockType: 'text' } },
      { type: 'chunk', time: 250, chunk: { type: 'text-delta', text: 'hi' } },
      { type: 'chunk', time: 300, chunk: { type: 'text-delta', text: 'there' } },
    ]), 250)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['a', 'b', 'c'] },
    ]), 1000)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1000, index: 0, dt: [10, 20], texts: ['', 'b', 'c'] },
    ]), 1010, 'a leading empty fragment defers the stamp to the next member')
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 9, index: 0, texts: ['a'] }]), 9)
  })

  test('reads a reasoning run and a name-bearing tool-call run', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'reasoning-chunks', time0: 500, index: 0, dt: [5], texts: ['think', 'ing'] },
    ]), 500)
    assert.equal(firstTokenTimeOfStream([
      { type: 'tool-call-chunks', time0: 700, index: 1, dt: [0], id: 'c1', name: 'bash', args: ['{}', '{}'] },
    ]), 700, 'a name-bearing tool run starts at its first member')
    assert.equal(firstTokenTimeOfStream([
      { type: 'tool-call-chunks', time0: 700, index: 1, dt: [3], id: 'c1', args: ['', '{"a":1}'] },
    ]), 703, 'a nameless tool run defers to the first non-empty arguments fragment')
  })

  test('a packed run whose first member is empty and whose gaps are hostile reads as no token', () => {
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: 1, index: 0, dt: [Number.NaN], texts: ['', 'b'] },
    ]), undefined)
    assert.equal(firstTokenTimeOfStream([
      { type: 'text-chunks', time0: Number.POSITIVE_INFINITY, index: 0, dt: [], texts: ['a'] },
    ]), undefined)
  })

  test('malformed records and containers degrade to undefined', () => {
    assert.equal(firstTokenTimeOfStream(undefined), undefined)
    assert.equal(firstTokenTimeOfStream('stream'), undefined)
    assert.equal(firstTokenTimeOfStream([]), undefined)
    assert.equal(firstTokenTimeOfStream([null, 7, { type: 'chunk', time: 'x', chunk: { type: 'text-delta', text: 'a' } }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 1, index: 0, texts: 'not-an-array' }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'text-chunks', time0: 1, index: 0, dt: [], texts: [7] }]), undefined)
    assert.equal(firstTokenTimeOfStream([{ type: 'chunk', time: 5, chunk: { type: 'finish' } }]), undefined)
  })
})

describe('replaceRangeOf', () => {
  test('reads the startSeq/endSeq endpoints', () => {
    assert.deepEqual(replaceRangeOf({ op: 'replace', startSeq: 3, endSeq: 7 }), { start: 3, end: 7 })
  })

  test('append, unknown, and malformed ops read as no replacement', () => {
    assert.equal(replaceRangeOf('append'), null)
    assert.equal(replaceRangeOf(null), null)
    assert.equal(replaceRangeOf(undefined), null)
    assert.equal(replaceRangeOf({ op: 'insert', startSeq: 1, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', start: 3, end: 7 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: 1 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: Number.NaN, endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', startSeq: '1', endSeq: 2 }), null)
    assert.equal(replaceRangeOf({ op: 'replace', endSeq: 2 }), null)
  })
})
})

describe('sweep', () => {

const ROW_KEY = 'contextTimeline'
const LEGACY_VERSION = 36

interface Row {
  ver: number
  seq: number
  val: unknown
}

interface RecordShape {
  identity: Record<string, unknown>
  rows: Record<string, Row>
}

interface TableHarness {
  records: Map<string, RecordShape>
  updates: number
  failNext: boolean
}

function fullVal(): TimelineState {
  const events: TimelineEvent[] = [
    header(1, { model: 'deepseek-v4-flash', provider: 'deepseek' }),
    userMessage(2, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
    toolCall(3, { callId: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'ls -la plus a long command payload'.repeat(40) }) }),
    toolResult(4, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    assistantMessage(5, { turn: 1, step: 0, usage: { inputTokens: 10, outputTokens: 5 } }),
  ]
  let state = createTimelineState()
  for (const ev of events) state = applyTimeline(state, ev, resolveBounds({}))
  return state
}

interface SweepHarness extends FakeCtx {
  ran(): Promise<void>
}

function ctxOf(table: TableHarness | undefined, onFirstUpdate?: () => void): SweepHarness {
  const domain = table === undefined
    ? undefined
    : { table: (name2: string) => name2 === 'sessions' ? tableFace(table, onFirstUpdate) : undefined }
  const fake = fakeCtx({ storageDomain: { get: (name: string) => name === 'session_projcache' ? domain : undefined } }, {
    injectAll: true,
    logger: { info: () => {}, warn: () => {} },
  })
  return {
    ...fake,
    ran: async () => { await new Promise(resolve => setTimeout(resolve, 0)) },
  }
}

function tableFace(harness: TableHarness, onFirstUpdate?: () => void) {
  let hooked = false
  return {
    entries: () => harness.records.entries(),
    update: async (id: string, fn: (current: RecordShape) => RecordShape) => {
      harness.updates++
      if (onFirstUpdate !== undefined && !hooked) {
        hooked = true
        onFirstUpdate()
      }
      if (harness.failNext) {
        harness.failNext = false
        throw new Error('write failed')
      }
      const next = fn(harness.records.get(id)!)
      harness.records.set(id, next)
      return next
    },
  }
}

function legacyRecord(val: unknown, ver = LEGACY_VERSION): RecordShape {
  return {
    identity: { formatVersion: 4, createdAt: 1, cwd: '/w', isSeeded: false, inheritedEventCount: 0 },
    rows: {
      [ROW_KEY]: { ver, seq: 5, val },
      contextHeaders: { ver: 1, seq: 5, val: { headers: [] } },
    },
  }
}

describe('the timeline row sweep (issue #217)', () => {
  test('a legacy full row rewrites to the head-only shape, exact head, other rows and identity intact', async () => {
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(structuredClone(fullVal()))]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 1)
    const row = harness.records.get('s1')!.rows[ROW_KEY]
    assert.equal(row.ver, 37, 'pinned: the head-only shape generation the sweep writes')
    assert.equal(row.seq, 5)
    const val = row.val as TimelineState
    assert.equal(val.spans.length, 0)
    assert.equal(val.fileOps.length, 0)
    assert.equal(val.archived.length, 0)
    assert.ok(val.surface.every((node: { text?: unknown }) => !('text' in node)))
    assert.equal('contextHeaders' in harness.records.get('s1')!.rows, true, 'sibling rows survive')
    assert.deepEqual(harness.records.get('s1')!.identity.createdAt, 1)
  })

  test('the migrated row serves the same head the legacy row served', async () => {
    const val = fullVal()
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(structuredClone(val))]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    const migrated = harness.records.get('s1')!.rows[ROW_KEY].val as TimelineState
    assert.deepStrictEqual(buildTimelineHead(migrated), buildTimelineHead(val))
  })

  test('current-version rows, foreign versions, and malformed values are skipped', async () => {
    const harness: TableHarness = {
      records: new Map([
        ['current', legacyRecord(fullVal(), TIMELINE_STATE_VERSION)],
        ['older', legacyRecord(fullVal(), 30)],
        ['malformed', legacyRecord({ surface: 'junk' })],
        ['norow', { identity: {}, rows: {} }],
      ]),
      updates: 0,
      failNext: false,
    }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 0)
  })

  test('a concurrent current-version write at the update slot leaves the row untouched', async () => {
    const harness: TableHarness = { records: new Map([['s1', legacyRecord(fullVal())]]), updates: 0, failNext: false }
    const { ctx, ran } = ctxOf(harness, () => {
      harness.records.set('s1', legacyRecord(fullVal(), TIMELINE_STATE_VERSION))
    })
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.updates, 1)
    const row = harness.records.get('s1')!.rows[ROW_KEY]
    assert.equal(row.ver, TIMELINE_STATE_VERSION, 'the row keeps whichever current version won')
    assert.notEqual(row.val, undefined)
  })

  test('a failed write skips the record fail-soft and the sweep continues', async () => {
    const harness: TableHarness = {
      records: new Map([
        ['bad', legacyRecord(fullVal())],
        ['good', legacyRecord(fullVal())],
      ]),
      updates: 0,
      failNext: true,
    }
    const { ctx, ran } = ctxOf(harness)
    watchTimelineRowSweep(ctx)
    await ran()
    assert.equal(harness.records.get('bad')!.rows[ROW_KEY].ver, LEGACY_VERSION, 'the failed row stays on the refold path')
    assert.equal(harness.records.get('good')!.rows[ROW_KEY].ver, 37, 'the sweep moved on')
  })

  test('a missing domain or table arms nothing', async () => {
    for (const storageDomain of [undefined, 42, {}, { get: () => undefined }]) {
      const fake = fakeCtx(storageDomain === undefined ? {} : { storageDomain }, {
        injectAll: true,
        logger: { info: () => {}, warn: () => {} },
      })
      watchTimelineRowSweep(fake.ctx)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  test('a junk domain or table face arms nothing', async () => {
    for (const domain of ['junk', {}, { table: () => 'junk' }, { table: () => ({}) }]) {
      const facility = { get: (name: string) => name === 'session_projcache' ? domain : undefined }
      const fake = fakeCtx({ storageDomain: facility }, { injectAll: true, logger: { info: () => {}, warn: () => {} } })
      watchTimelineRowSweep(fake.ctx)
      await new Promise(resolve => setTimeout(resolve, 0))
    }
  })

  test('a hostile table rejects the sweep through the outer guard', async () => {
    const facility = {
      get: (name: string) => name === 'session_projcache'
        ? { table: () => ({ entries: () => { throw new Error('quarantined') }, update: () => Promise.resolve(undefined) }) }
        : undefined,
    }
    const warnings: string[] = []
    const fake = fakeCtx({ storageDomain: facility }, {
      injectAll: true,
      logger: { info: () => {}, warn: (message: unknown) => warnings.push(String(message)) },
    })
    watchTimelineRowSweep(fake.ctx)
    await new Promise(resolve => setTimeout(resolve, 0))
    assert.ok(warnings.some(message => message.includes('quarantined')), 'the outer guard reports the rejection')
  })
})
})

describe('fallback', () => {

const CURRENT = '0.2.0-rc.1'

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
    header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } },
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
    assert.deepEqual(timeline.stateSchema.parse({ headers: [{ seq: 1 }] }), {})
    assert.deepEqual(timeline.stateSchema.parse({ surface: [null], sums: {} }), {})
    assert.equal(timeline.stateVersion, 1)
  })

  test('both registry contract generations read their shape off one definition, for every unit', () => {
    const timeline = createFallbackTimelineDefinition(CURRENT)
    assert.equal(timeline.schema.safeParse(timeline.view({})).success, true)
    assert.deepEqual(timeline.view({}).unsupported, { current: CURRENT, minimum: BASELINE_DSH_VERSION })
    const headers = createFallbackHeadersDefinition()
    assert.equal(headers.schema.safeParse(headers.view({})).success, true)
    assert.deepEqual(headers.view({}), { headers: [] })
    const activity = createFallbackActivityDefinition()
    assert.equal(activity.key, 'contextActivity')
    assert.equal(activity.stateVersion, 1)
    assert.deepEqual(activity.init(), {})
    const state = activity.init()
    assert.ok(activity.apply(state, { type: 'assistant/message', seq: 1, time: 0, data: {} } as never) === state)
    assert.equal(activity.wire.viewSchema.safeParse(activity.wire.view({})).success, true)
    assert.equal(activity.schema.safeParse(activity.view({})).success, true)
    assert.deepEqual(activity.view({}), { days: {} })
  })
})
})
