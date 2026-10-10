// The fleet route (src/host/fleet.ts): the per-session agent color extraction (descriptor,
// delegation prompt, inter-agent traffic) and the route's gating/transport behavior.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { FLEET_ROUTE, fleetDetailOfEvents, watchFleetChannel } from '../../src/host/fleet'
import type { ColdReadGate } from '../../src/host/coldRead'

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessionQuery?: unknown
}

/** A minimal host ctx double with cordis inject semantics (the detail route spec's own shape):
 * the callback fires once its dependency list completes, and disposers are collected. */
function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  const ctx = {
    get: (name: string) => services.get(name),
    effect(fn: () => unknown, _label?: string) {
      const d = fn()
      if (typeof d === 'function') disposers.push(d as () => void)
      return () => {}
    },
    inject(deps: string[], cb: (c: unknown) => unknown) {
      if (!deps.every(d => services.has(d))) return
      const d = cb(ctx)
      if (typeof d === 'function') disposers.push(d as () => void)
    },
  }
  if (spec.connection !== undefined && spec.connection !== null) {
    const conn = spec.connection as { fetch?: { register?: unknown } }
    if (typeof conn.fetch?.register === 'function') {
      conn.fetch.register = (route: { path: string; fetch: RouteFetch }) => {
        captured.path = route.path
        captured.fetch = route.fetch
        return () => {}
      }
    }
  }
  return { ctx: ctx as unknown as Context, captured, disposers }
}

const OPEN_GATE: ColdReadGate = { admit: read => read() }
/** A gate that refuses every read — the heap-pressure path. */
const SKIP_GATE: ColdReadGate = { admit: () => Promise.resolve(undefined) }

function armed(spec: CtxSpec = {}): { captured: { path?: string; fetch?: RouteFetch } } {
  const { ctx, captured } = ctxOf({ connection: { fetch: { register: () => () => {} } }, ...spec })
  watchFleetChannel(ctx, OPEN_GATE)
  return { captured }
}

async function call(captured: { fetch?: RouteFetch }, body: unknown): Promise<Record<string, unknown>> {
  const request = new Request(`http://dsh.test${FLEET_ROUTE}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const response = await captured.fetch!(request)
  return await response.json() as Record<string, unknown>
}

function observing(events: unknown): { observeSession(id: string, options: unknown): Promise<unknown> } {
  let disposed = false
  return {
    observeSession: () => Promise.resolve({
      events,
      get disposed() { return disposed },
      [Symbol.dispose]() { disposed = true },
    }),
  }
}

describe('watchFleetChannel gating', () => {
  test('no route without the connection service or its fetch registry', () => {
    assert.equal(ctxOf({}).captured.path, undefined)
    assert.equal(ctxOf({ connection: {} }).captured.path, undefined)
    assert.equal(ctxOf({ connection: { fetch: {} } }).captured.path, undefined)
    const { captured } = armed()
    assert.equal(captured.path, FLEET_ROUTE)
  })

  test('a rejecting registry keeps the route absent without throwing', () => {
    const ctx = {
      get: (name: string) => name === 'connection'
        ? {
          fetch: {
            register: () => {
              throw new Error('registration rejected')
            },
          },
        }
        : undefined,
      inject(_deps: string[], cb: (c: unknown) => unknown) { cb(ctx) },
    }
    assert.doesNotThrow(() => { watchFleetChannel(ctx as unknown as Context, OPEN_GATE) })
  })

  test('bad bodies and missing session ids are typed failures', async () => {
    const { captured } = armed()
    const badJson = await captured.fetch!(new Request(`http://dsh.test${FLEET_ROUTE}`, { method: 'POST', body: '{' }))
    assert.equal((await badJson.json() as { ok: boolean }).ok, false)
    for (const body of [undefined, null, {}, { sessionId: 42 }, { sessionId: '' }]) {
      const r = await call(captured, body)
      assert.equal(r.ok, false, JSON.stringify(body))
    }
  })

  test('no sessionQuery (or no observeSession verb) answers a typed null', async () => {
    const { captured } = armed()
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
    const withQuery = armed({ sessionQuery: {} })
    assert.deepEqual(await call(withQuery.captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('an observation without an events array answers a typed null', async () => {
    const { captured } = armed({ sessionQuery: observing(null) })
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('a skipped cold read answers a typed null', async () => {
    const { ctx, captured } = ctxOf({
      connection: { fetch: { register: () => () => {} } },
      sessionQuery: observing([]),
    })
    watchFleetChannel(ctx, SKIP_GATE)
    assert.deepEqual(await call(captured, { sessionId: 's1' }), { ok: true, value: null })
  })

  test('events fold into the detail and the observation disposes', async () => {
    const query = observing([
      { type: 'user/message', seq: 1, time: 100, data: { content: [{ type: 'text', text: 'do the thing' }] } },
    ])
    const { captured } = armed({ sessionQuery: query })
    const r = await call(captured, { sessionId: 's1' })
    assert.equal(r.ok, true)
    const value = r.value as { initialPrompt: string }
    assert.equal(value.initialPrompt, 'do the thing')
  })

  test('an observation without a dispose method still serves', async () => {
    const { captured } = armed({
      sessionQuery: {
        observeSession: () => Promise.resolve({
          events: [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'plain' }] } }],
        }),
      },
    })
    const r = await call(captured, { sessionId: 's1' })
    assert.equal((r.value as { initialPrompt: string }).initialPrompt, 'plain')
  })

  test('a throwing observation surfaces as an internal failure', async () => {
    const { captured } = armed({
      sessionQuery: { observeSession: () => Promise.reject(new Error('log unreadable')) },
    })
    const r = await call(captured, { sessionId: 's1' })
    assert.equal(r.ok, false)
    assert.equal((r.error as { message: string }).message, 'log unreadable')
    const nonError = armed({
      sessionQuery: { observeSession: () => Promise.reject('nope') },
    })
    const r2 = await call(nonError.captured, { sessionId: 's1' })
    assert.equal((r2.error as { message: string }).message, 'nope')
  })
})

describe('fleetDetailOfEvents — the descriptor', () => {
  test('last descriptor wins (the fork-seed replay order), optional fields ride along', () => {
    const detail = fleetDetailOfEvents([
      { type: 'subagent/descriptor', seq: 1, time: 1, data: { version: 3, mode: 'one-shot', provider: 'spawn' } },
      {
        type: 'subagent/descriptor',
        seq: 2,
        time: 2,
        data: { version: 3, mode: 'continuable', provider: 'fork', label: 'worker', agentProvider: 'deepseek', agentModel: 'v4', persona: 'reviewer' },
      },
    ])
    assert.deepEqual(detail.descriptor, {
      mode: 'continuable', provider: 'fork', label: 'worker', agentProvider: 'deepseek', agentModel: 'v4', persona: 'reviewer',
    })
  })

  test('malformed descriptors drop alone', () => {
    const detail = fleetDetailOfEvents([
      { type: 'subagent/descriptor', seq: 1, time: 1, data: { mode: 'mystery' } },
      { type: 'subagent/descriptor', seq: 2, time: 2, data: { mode: 'one-shot', label: '', provider: 7 } },
      { type: 'subagent/descriptor', seq: 3, time: 3, data: null },
      { type: 'subagent/descriptor', seq: 4, time: 4 },
      null,
      42,
      { seq: 5, time: 5, data: {} },
      { type: 9, seq: 6, data: {} },
      // A real but irrelevant event type folds to nothing.
      { type: 'assistant/message', seq: 7, time: 7, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    ])
    assert.deepEqual(detail.descriptor, { mode: 'one-shot' })
    assert.deepEqual(detail.messages, [])
    assert.equal(detail.truncated, false)
  })
})

describe('fleetDetailOfEvents — the delegation prompt', () => {
  test('the first plain user message is the prompt; injections and agent traffic are not', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'plugin', form: 'notice' }, content: [{ type: 'text', text: 'injected' }] } },
      { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '' }] } },
      { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'build it' }] } },
      { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'second prompt never wins' }] } },
    ])
    assert.equal(detail.initialPrompt, 'build it')
  })

  test('the teammate framing reminder strips off the excerpt', () => {
    const detail = fleetDetailOfEvents([
      {
        type: 'user/message',
        seq: 1,
        time: 1,
        data: { content: [{ type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\n</system-reminder>\n\nreview the diff' }] },
      },
    ])
    assert.equal(detail.initialPrompt, 'review the diff')
  })

  test('a long prompt clips and flags the payload', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'x'.repeat(2000) }] } },
    ])
    assert.equal(detail.initialPrompt?.length, 1601)
    assert.equal(detail.truncated, true)
  })
})

describe('fleetDetailOfEvents — roster facts and latest reply', () => {
  test('team/member records fold last-wins by name; malformed rows drop alone', () => {
    const detail = fleetDetailOfEvents([
      { type: 'team/member', seq: 1, time: 1, data: { teamId: 't', member: { id: 'a', name: 'worker', description: 'old duty', provider: 'spawn', context: 'fresh', phase: 'provisioning' } } },
      { type: 'team/member', seq: 2, time: 2, data: { teamId: 't', member: { id: 'a', name: 'worker', description: 'duty', provider: 'spawn', context: 'fresh', phase: 'active' } } },
      { type: 'team/member', seq: 3, time: 3, data: { member: null } },
      { type: 'team/member', seq: 4, time: 4, data: { member: { name: '' } } },
      { type: 'team/member', seq: 5, time: 5, data: { member: { name: 'bare', description: 7, provider: 9, context: 'sideways' } } },
    ])
    assert.deepEqual(detail.roster, [
      { name: 'worker', description: 'duty', provider: 'spawn', context: 'fresh' },
      { name: 'bare', description: '' },
    ])
  })

  test('the latest assistant text is the reply; non-text and empty replies are skipped', () => {
    const detail = fleetDetailOfEvents([
      { type: 'assistant/message', seq: 1, time: 10, data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { type: 'assistant/message', seq: 2, time: 20, data: { message: { content: [{ type: 'tool-call' }] } } },
      { type: 'assistant/message', seq: 3, time: 30, data: { message: { content: [{ type: 'text', text: 'latest report' }] } } },
      { type: 'assistant/message', seq: 4, time: 40, data: { message: { content: [{ type: 'text', text: '  ' }] } } },
      { type: 'assistant/message', seq: 5, time: 50, data: { message: { content: 'nope' } } },
      { type: 'assistant/message', seq: 6, time: 60, data: {} },
      // The reply scan walks the log newest-LAST-in-array first: hostile blocks precede the winner here.
      { type: 'assistant/message', seq: 7, time: 70, data: { message: { content: [null, { type: 'text', text: 7 }] } } },
    ])
    assert.deepEqual(detail.lastReply, { time: 30, text: 'latest report' })
    assert.equal(fleetDetailOfEvents([]).lastReply, undefined)
    // A reply with no readable instant zeros the clock.
    const timeless = fleetDetailOfEvents([
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    ])
    assert.deepEqual(timeless.lastReply, { time: 0, text: 'hi' })
  })

  test('a long reply clips and flags the payload', () => {
    const detail = fleetDetailOfEvents([
      { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'z'.repeat(400) }] } } },
    ])
    assert.equal(detail.lastReply?.text.length, 301)
    assert.equal(detail.truncated, true)
  })

  test('the mailbox transport preamble strips off the excerpt', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'team-message', senderId: 'a', senderName: 'lead' }, content: [{ type: 'text', text: 'Team message team-message-abc from lead: 请继续 task-3' }] } },
    ])
    assert.equal(detail.messages[0].text, '请继续 task-3')
  })
})

describe('fleetDetailOfEvents — inter-agent messages', () => {
  test('relay, mailbox, and settled rows each carry their attribution', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 3, time: 30, data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'lead-1' }, content: [{ type: 'text', text: 'how far along?' }] } },
      { type: 'user/message', seq: 1, time: 10, data: { source: { kind: 'team-message', senderId: 'w-1', senderName: 'worker' }, content: [{ type: 'text', text: 'done' }] } },
      { type: 'user/message', seq: 2, time: 20, data: { source: { kind: 'subagent-settled', form: 'notice', summary: 'child finished', senderSessionId: 'w-2' }, content: [{ type: 'text', text: 'unused' }] } },
    ])
    assert.deepEqual(detail.messages, [
      { seq: 3, time: 30, kind: 'relay', from: 'lead-1', text: 'how far along?' },
      { seq: 2, time: 20, kind: 'settled', from: 'w-2', text: 'child finished' },
      { seq: 1, time: 10, kind: 'mailbox', from: 'w-1', fromName: 'worker', text: 'done' },
    ])
  })

  test('a settled notice without a summary falls back to its content; empty text drops the row', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 10, data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: '  ' }] } },
      { type: 'user/message', seq: 2, time: 20, data: { source: { kind: 'subagent-settled' }, content: [{ type: 'text', text: 'content account' }] } },
      { type: 'user/message', seq: 3, time: 30, data: { source: { kind: 'agent-message', senderSessionId: 'x' }, content: [{ type: 'text', text: '' }] } },
      { type: 'user/message', seq: 4, time: 40, data: { source: { kind: 'team-message', senderId: '', senderName: 9 }, content: [{ type: 'text', text: 'hi' }] } },
    ])
    assert.deepEqual(detail.messages, [
      { seq: 4, time: 40, kind: 'mailbox', text: 'hi' },
      { seq: 2, time: 20, kind: 'settled', text: 'content account' },
    ])
  })

  test('long texts clip, and the list caps at the newest 40', () => {
    const events = Array.from({ length: 45 }, (_, i) => ({
      type: 'user/message',
      seq: i + 1,
      time: i + 1,
      data: { source: { kind: 'agent-message', senderSessionId: 'x' }, content: [{ type: 'text', text: `m${i}` }] },
    }))
    events.push({ type: 'user/message', seq: 99, time: 99, data: { source: { kind: 'agent-message', senderSessionId: 'x' }, content: [{ type: 'text', text: 'y'.repeat(500) }] } })
    const detail = fleetDetailOfEvents(events)
    assert.equal(detail.messages.length, 40)
    assert.equal(detail.messages[0].seq, 99)
    assert.equal(detail.messages[0].text.length, 401)
    assert.equal(detail.truncated, true)
  })

  test('non-finite seq/time zero out rather than reject the row', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: Number.NaN, time: Number.POSITIVE_INFINITY, data: { source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'hi' }] } },
    ])
    assert.deepEqual(detail.messages, [{ seq: 0, time: 0, kind: 'relay', text: 'hi' }])
  })

  test('a message with no content array reads as empty and drops', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'agent-message' }, content: 'not-an-array' } },
      { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'agent-message' }, content: [{ type: 'image' }, { type: 'text', text: 7 }] } },
    ])
    assert.deepEqual(detail.messages, [])
  })
})
