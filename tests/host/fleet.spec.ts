import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { FLEET_ROUTE, fleetDetailOfEvents, watchFleetChannel } from '../../src/host/fleet'
import type { ColdReadGate } from '../../src/host/coldRead'

type RouteFetch = (request: Request) => Promise<Response>

interface CtxSpec {
  connection?: unknown
  sessionQuery?: unknown
  sessionPersistence?: unknown
}

function ctxOf(spec: CtxSpec): { ctx: Context; captured: { path?: string; fetch?: RouteFetch }; disposers: (() => void)[] } {
  const captured: { path?: string; fetch?: RouteFetch } = {}
  const disposers: (() => void)[] = []
  const services = new Map<string, unknown>()
  if ('connection' in spec) services.set('connection', spec.connection)
  if ('sessionQuery' in spec) services.set('sessionQuery', spec.sessionQuery)
  if ('sessionPersistence' in spec) services.set('sessionPersistence', spec.sessionPersistence)
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

function observing(events: unknown, inheritedEventCount?: number): { observeSession(id: string, options: unknown): Promise<unknown>; wasDisposed(): boolean } {
  let disposed = false
  return {
    wasDisposed: () => disposed,
    observeSession: () => Promise.resolve({
      events,
      ...(inheritedEventCount !== undefined ? { inheritedEventCount } : {}),
      get disposed() { return disposed },
      [Symbol.dispose]() { disposed = true },
    }),
  }
}

describe('watchFleetChannel gating', () => {
  test('no route without the connection service or its fetch registry; a rejecting registry keeps it absent without throwing', () => {
    for (const spec of [{}, { connection: {} }, { connection: { fetch: {} } }]) {
      const { ctx, captured } = ctxOf(spec)
      watchFleetChannel(ctx, OPEN_GATE)
      assert.equal(captured.path, undefined, JSON.stringify(spec))
    }
    const { captured } = armed()
    assert.equal(captured.path, FLEET_ROUTE)
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

  test('a missing query, a missing observeSession verb, a missing events array, or a skipped cold read answers a typed null', async () => {
    assert.deepEqual(await call(armed().captured, { sessionId: 's1' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: {} }).captured, { sessionId: 's1' }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: observing(null) }).captured, { sessionId: 's1' }), { ok: true, value: null })
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
    assert.equal(query.wasDisposed(), true, 'the observation is released after the fold')
  })

  test('a full body lifts the excerpt caps; an absent or junk full flag reads excerpts', async () => {
    const long = { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'z'.repeat(400) }] } } }
    const { captured } = armed({ sessionQuery: observing([long]) })
    const excerpt = await call(captured, { sessionId: 's1' }) as { value: { lastReply: { text: string }; truncated: boolean } }
    assert.equal(excerpt.value.lastReply.text.length, 301)
    assert.equal(excerpt.value.truncated, true)
    const full = await call(captured, { sessionId: 's1', full: true }) as typeof excerpt
    assert.equal(full.value.lastReply.text.length, 400)
    assert.equal(full.value.truncated, false)
    const junk = await call(captured, { sessionId: 's1', full: 42 }) as typeof excerpt
    assert.equal(junk.value.lastReply.text.length, 301)
  })

  test('a history body uses the complete-event mode rather than full text mode', async () => {
    const long = { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'z'.repeat(400) }] } } }
    const { captured } = armed({ sessionQuery: observing([long]) })
    const history = await call(captured, { sessionId: 's1', history: true }) as { value: { lastReply: { text: string }; truncated: boolean } }
    assert.equal(history.value.lastReply.text.length, 301)
    assert.equal(history.value.truncated, true)
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
        data: { version: 3, mode: 'continuable', provider: 'fork', label: 'worker', agentProvider: 'deepseek', agentModel: 'v4', agentReasoningEffort: 'max', persona: 'reviewer' },
      },
    ])
    assert.deepEqual(detail.descriptor, {
      mode: 'continuable', provider: 'fork', label: 'worker', agentProvider: 'deepseek', agentModel: 'v4', agentReasoningEffort: 'max', persona: 'reviewer',
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
      { type: 'assistant/message', seq: 7, time: 7, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
      { type: 'tool/result', seq: 8, time: 8, data: { message: { content: [] } } },
    ])
    assert.deepEqual(detail.descriptor, { mode: 'one-shot' })
    assert.deepEqual(detail.messages, [])
    assert.equal(detail.truncated, false)
  })
})

describe('fleetDetailOfEvents — durable delegations', () => {
  test('accepts only versioned catalog and activated Team records, with catalog taking precedence', () => {
    const detail = fleetDetailOfEvents([
      { type: 'subagent/catalog', seq: 4, time: 40, data: { version: 1, childId: 'unknown', childCreatedAt: 400, mode: 'unknown' } },
      { type: 'subagent/catalog', seq: 2, time: 20, data: { version: 0, childId: 'one', childCreatedAt: 200, mode: 'one-shot', label: 'Inspect' } },
      { type: 'subagent/catalog', seq: 1, time: 10, data: { version: 0, childId: 'continuable', childCreatedAt: 100, mode: 'continuable', label: 'Continue' } },
      { type: 'subagent/catalog', seq: 3, time: 30, data: { version: 2, childId: 'external', childCreatedAt: 300, mode: 'external', label: 'Remote' } },
      { type: 'subagent/catalog', seq: 5, time: 50, data: { version: 0, childId: 'bad', childCreatedAt: 500, mode: 'mystery' } },
      { type: 'subagent/catalog', seq: 6, time: 60, data: { version: 0, childId: '', childCreatedAt: 600, mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 7, time: 70, data: { version: 0, childId: 'bad-time', childCreatedAt: 'no', mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 8, time: 80, data: null },
      { type: 'subagent/catalog', seq: 9, time: 90, data: { version: 2, childId: 'bad-version', childCreatedAt: 900, mode: 'continuable', label: 'Wrong version' } },
      { type: 'subagent/catalog', seq: 10, time: 100, data: { version: 0, childId: 'missing-label', childCreatedAt: 1000, mode: 'continuable' } },
      { type: 'team/member', seq: 11, time: 1100, data: { teamId: 'root', member: { id: 'mate', name: 'mate', description: 'Team duty', phase: 'provisioning' } } },
      { type: 'team/member', seq: 12, time: 1200, data: { teamId: 'root', member: { id: 'mate', name: 'mate', description: 'Changed', phase: 'active' } } },
      { type: 'team/member', seq: 13, time: 1300, data: { teamId: 'root', member: { id: 'failed', name: 'failed', description: 'Failed', phase: 'failed' } } },
      { type: 'subagent/catalog', seq: 14, time: 1400, data: { version: 1, childId: 'mate', childCreatedAt: 1400, mode: 'continuable', label: 'Catalog wins' } },
      { type: 'team/member', seq: 15, time: 1500, data: { teamId: 'root', member: { id: 'root', name: 'lead', description: 'Lead', phase: 'active' } } },
      { type: 'team/member', seq: 16, time: 1600, data: { teamId: 'root', member: { id: '', name: 'bad', description: 'Bad', phase: 'active' } } },
      { type: 'team/member', seq: 17, time: 1700, data: { teamId: 'root', member: { id: 'empty', name: 'empty', description: '', phase: 'active' } } },
      { type: 'team/member', seq: 18, time: 1800, data: { teamId: 'root', member: { id: 'numeric', name: 'numeric', description: 42, phase: 'active' } } },
      { type: 'subagent/catalog', seq: 19, time: 1900, data: { version: 0, childId: 'bare-one', childCreatedAt: 1900, mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 20, time: 2000, data: { version: 2, childId: 'bare-external', childCreatedAt: 2000, mode: 'external' } },
    ])
    assert.deepEqual(detail.delegations, [
      { seq: 1, time: 100, to: 'continuable', mode: 'continuable', label: 'Continue' },
      { seq: 2, time: 200, to: 'one', mode: 'one-shot', label: 'Inspect' },
      { seq: 3, time: 300, to: 'external', mode: 'external', label: 'Remote' },
      { seq: 14, time: 1400, to: 'mate', mode: 'continuable', label: 'Catalog wins' },
      { seq: 17, time: 1700, to: 'empty', mode: 'continuable' },
      { seq: 18, time: 1800, to: 'numeric', mode: 'continuable' },
      { seq: 19, time: 1900, to: 'bare-one', mode: 'one-shot' },
      { seq: 20, time: 2000, to: 'bare-external', mode: 'external' },
    ])
    assert.deepEqual(detail.messages, [])
  })

  test('the route excludes inherited catalog and Team creation records', async () => {
    const { captured } = armed({
      sessionQuery: observing([
        { type: 'subagent/catalog', seq: 1, time: 100, data: { version: 0, childId: 'inherited', childCreatedAt: 100, mode: 'one-shot' } },
        { type: 'team/member', seq: 2, time: 200, data: { teamId: 'root', member: { id: 'inherited-team', name: 'inherited-team', description: 'Inherited', phase: 'active' } } },
        { type: 'subagent/catalog', seq: 3, time: 300, data: { version: 1, childId: 'own', childCreatedAt: 300, mode: 'continuable', label: 'Own' } },
      ], 3),
    })
    const r = await call(captured, { sessionId: 's1' })
    assert.deepEqual((r.value as { delegations?: unknown[] }).delegations, [
      { seq: 3, time: 300, to: 'own', mode: 'continuable', label: 'Own' },
    ])
  })
})

describe('fleetDetailOfEvents — the delegation prompt', () => {
  test('the first plain user message is the prompt (minus the teammate reminder); injections and later prompts are not', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'plugin', form: 'notice' }, content: [{ type: 'text', text: 'injected' }] } },
      { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '' }] } },
      {
        type: 'user/message',
        seq: 3,
        time: 3,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: '<system-reminder>\nYou are teammate "reviewer".\n</system-reminder>\n\nbuild it' }] },
      },
      { type: 'user/message', seq: 4, time: 4, data: { content: [{ type: 'text', text: 'second prompt never wins' }] } },
    ])
    assert.equal(detail.initialPrompt, 'build it')
  })

  test('the full read removes prompt and reply caps while previews stay bounded', () => {
    const events = [
      { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'x'.repeat(80_000) }] } },
      { type: 'assistant/message', seq: 2, time: 2, data: { message: { content: [{ type: 'text', text: 'z'.repeat(120_000) }] } } },
    ]
    const excerpt = fleetDetailOfEvents(events)
    assert.equal(excerpt.initialPrompt?.length, 1601)
    assert.equal(excerpt.lastReply?.text.length, 301)
    assert.equal(excerpt.truncated, true)
    const full = fleetDetailOfEvents(events, 'full')
    assert.equal(full.initialPrompt?.length, 80_000)
    assert.equal(full.lastReply?.text.length, 120_000)
    assert.equal(full.truncated, false)
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

  test('the latest assistant text is the reply; a timeless reply zeros the clock', () => {
    const detail = fleetDetailOfEvents([
      { type: 'assistant/message', seq: 1, time: 10, data: { message: { content: [{ type: 'text', text: 'first' }] } } },
      { type: 'assistant/message', seq: 2, time: 20, data: { message: { content: [{ type: 'tool-call' }] } } },
      { type: 'assistant/message', seq: 3, time: 30, data: { message: { content: [{ type: 'text', text: 'latest report' }] } } },
      { type: 'assistant/message', seq: 4, time: 40, data: { message: { content: [{ type: 'text', text: '  ' }] } } },
      { type: 'assistant/message', seq: 5, time: 50, data: { message: { content: 'nope' } } },
      { type: 'assistant/message', seq: 6, time: 60, data: {} },
      { type: 'assistant/message', seq: 7, time: 70, data: { message: { content: [null, { type: 'text', text: 7 }] } } },
    ])
    assert.deepEqual(detail.lastReply, { time: 30, text: 'latest report' })
    assert.equal(fleetDetailOfEvents([]).lastReply, undefined)
    const timeless = fleetDetailOfEvents([
      { type: 'assistant/message', seq: 1, data: { message: { content: [{ type: 'text', text: 'hi' }] } } },
    ])
    assert.deepEqual(timeless.lastReply, { time: 0, text: 'hi' })
  })
})

describe('fleetDetailOfEvents — inter-agent messages', () => {
  const SETTLEMENT = 'Background subagent w-2 finished and will do no further work unless you send it more.'
  const settled = (text: string, summary?: string, seq = 1, time = 10) => ({
    type: 'user/message',
    seq,
    time,
    data: {
      source: { kind: 'subagent-settled', form: 'notice', ...(summary === undefined ? {} : { summary }), senderSessionId: 'w-2' },
      content: [{ type: 'text', text }],
    },
  })

  test('relay, mailbox (transport preamble stripped), and settled rows each carry their attribution', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: 3, time: 30, data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'lead-1' }, content: [{ type: 'text', text: 'how far along?' }] } },
      { type: 'user/message', seq: 1, time: 10, data: { source: { kind: 'team-message', senderId: 'w-1', senderName: 'worker' }, content: [{ type: 'text', text: 'Team message team-message-abc from lead: done' }] } },
      settled('unused', 'child finished', 2, 20),
    ])
    assert.deepEqual(detail.messages, [
      { seq: 3, time: 30, kind: 'relay', from: 'lead-1', text: 'how far along?' },
      { seq: 2, time: 20, kind: 'settled', from: 'w-2', text: 'child finished', summary: 'child finished' },
      { seq: 1, time: 10, kind: 'mailbox', from: 'w-1', fromName: 'worker', text: 'done' },
    ])
    const framed = fleetDetailOfEvents([
      { type: 'user/message', seq: 1, time: 10, data: { source: { kind: 'agent-message', form: 'relay', senderSessionId: 'w-1' }, content: [{ type: 'text', text: 'Team message from host-cleaner:task-2 is done' }] } },
    ])
    assert.deepEqual(framed.messages, [
      { seq: 1, time: 10, kind: 'relay', from: 'w-1', fromName: 'host-cleaner', text: 'task-2 is done' },
    ], 'a Team relay framing line attests the sender name the source id alone cannot')
  })

  test('a settled notice splits its summary, closing report, structured result, and diagnostic', () => {
    const fullText = `${SETTLEMENT}Its closing message:All gates green {but not the end}.\nStructured result: {"ok":true,"note":"a } brace"}provider diagnostic tail`
    const detail = fleetDetailOfEvents([settled(fullText, SETTLEMENT)])
    assert.deepEqual(detail.messages, [{
      seq: 1,
      time: 10,
      kind: 'settled',
      from: 'w-2',
      text: fullText,
      summary: SETTLEMENT,
      report: 'All gates green {but not the end}.',
      structured: '{"ok":true,"note":"a } brace"}',
      diagnostic: 'provider diagnostic tail',
    }])
    const structured = JSON.stringify({ note: 'a "quoted" \\ path', nested: { x: 1 } })
    const nested = fleetDetailOfEvents([settled(`${SETTLEMENT}Its closing message:done.Structured result: ${structured}tail`, SETTLEMENT)])
    assert.equal(nested.messages[0]?.structured, structured, 'nested braces and escaped characters stay whole')
    assert.equal(nested.messages[0]?.diagnostic, 'tail')
    const spaced = fleetDetailOfEvents([settled(`\n  ${SETTLEMENT}Its closing message:clean report.`, SETTLEMENT)])
    assert.equal(spaced.messages[0]?.text, `${SETTLEMENT}Its closing message:clean report.`, 'leading whitespace before the settlement is trimmed')
    assert.equal(spaced.messages[0]?.report, 'clean report.')
  })

  test('a non-JSON or unterminated structured tail stays whole without inventing a diagnostic', () => {
    for (const [tail, expected] of [
      ['not-json', 'not-json'],
      ['[1,2]', '[1,2]'],
      ['{"a":1', '{"a":1'],
    ] as const) {
      const detail = fleetDetailOfEvents([settled(`${SETTLEMENT}Structured result: ${tail}`, SETTLEMENT)])
      assert.equal(detail.messages[0]?.structured, expected)
      assert.equal(detail.messages[0]?.diagnostic, undefined)
    }
  })

  test('the no-closing markers leave no report; a long closing report clips and flags the row', () => {
    const noClosing = fleetDetailOfEvents([settled(`${SETTLEMENT}It left no closing message.`, SETTLEMENT)])
    assert.equal(noClosing.messages[0]?.report, undefined)
    const omitted = fleetDetailOfEvents([settled(`${SETTLEMENT}It sent you a message just before finishing, so its closing message is omitted.`, SETTLEMENT)])
    assert.equal(omitted.messages[0]?.report, undefined)
    const clipped = fleetDetailOfEvents([settled(`${SETTLEMENT}Its closing message:${'r'.repeat(500)}`, SETTLEMENT)])
    assert.equal(clipped.messages[0]?.report?.length, 401)
    assert.equal(clipped.messages[0]?.clipped, true)
    assert.equal(clipped.truncated, true)
    const longSummary = 'Background subagent ' + 's'.repeat(500)
    const summaryCut = fleetDetailOfEvents([settled(longSummary, longSummary)])
    assert.equal(summaryCut.messages[0]?.summary?.length, 401)
    assert.equal(summaryCut.messages[0]?.clipped, true)
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

  test('the message list caps at the newest 80 on an excerpt and lifts on a full read, keeping the total', () => {
    const events = Array.from({ length: 85 }, (_, i) => ({
      type: 'user/message',
      seq: i + 1,
      time: i + 1,
      data: { source: { kind: 'agent-message', senderSessionId: 'x' }, content: [{ type: 'text', text: 'z'.repeat(500) }] },
    }))
    const detail = fleetDetailOfEvents(events)
    assert.equal(detail.messages.length, 80)
    assert.equal(detail.messages[0].seq, 85)
    assert.equal(detail.messages[0].text.length, 401)
    assert.equal(detail.messages[0].clipped, true)
    assert.equal(detail.messagesTotal, 85)
    assert.equal(detail.truncated, true)
    const full = fleetDetailOfEvents(events, 'full')
    assert.equal(full.messages.length, 85)
    assert.equal(full.messages[0].text.length, 500)
    assert.equal(full.messages[0].clipped, undefined)
    assert.equal(full.messagesTotal, undefined)
    assert.equal(full.truncated, false)
    const history = fleetDetailOfEvents(events, 'history')
    assert.equal(history.messages.length, 85)
    assert.equal(history.messages[0].text.length, 401)
    assert.equal(history.messages[0].clipped, true)
    assert.equal(history.messagesTotal, undefined)
    assert.equal(history.truncated, true)
  })

  test('hostile rows drop or zero out instead of rejecting: non-finite seq/time, no content array, non-text blocks', () => {
    const detail = fleetDetailOfEvents([
      { type: 'user/message', seq: Number.NaN, time: Number.POSITIVE_INFINITY, data: { source: { kind: 'agent-message' }, content: [{ type: 'text', text: 'hi' }] } },
      { type: 'user/message', seq: 2, time: 2, data: { source: { kind: 'agent-message' }, content: 'not-an-array' } },
      { type: 'user/message', seq: 3, time: 3, data: { source: { kind: 'agent-message' }, content: [{ type: 'image' }, { type: 'text', text: 7 }] } },
    ])
    assert.deepEqual(detail.messages, [{ seq: 0, time: 0, kind: 'relay', text: 'hi' }])
  })
})

describe('the fleet fold cache', () => {
  test('an unkeyed stored observation is never extended from an old fold', async () => {
    const relay = (seq: number, text: string): unknown => ({
      type: 'user/message', seq, time: seq, data: { source: { kind: 'agent-message', senderSessionId: 'lead' }, content: [{ type: 'text', text }] },
    })
    let events: unknown[] = [relay(1, 'one')]
    const { captured } = armed({ sessionQuery: { observeSession: () => Promise.resolve({ events }) } })
    const first = await call(captured, { sessionId: 's1' }) as { value: { messages: Array<{ text: string }> } }
    assert.deepEqual(first.value.messages.map(m => m.text), ['one'])
    events = [...events, relay(2, 'two')]
    const grown = await call(captured, { sessionId: 's1' }) as { value: { messages: Array<{ text: string }> } }
    assert.deepEqual(grown.value.messages.map(m => m.text).sort(), ['one', 'two'], 'the appended message is served, not a cached prefix')
  })

  test('a keyed stored cache trims past its bound and a live append extends its fold', async () => {
    const { captured } = armed({
      sessionQuery: {
        observeSession: (id: string) => Promise.resolve({
          source: 'stored', revision: 'r-' + id,
          events: [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: id }] } }],
        }),
      },
      sessionPersistence: { id: 'p1' },
    })
    for (let i = 0; i < 9; i++) await call(captured, { sessionId: 's' + i })
    assert.equal((await call(captured, { sessionId: 's0' }) as { value: { initialPrompt: string } }).value.initialPrompt, 's0')
    assert.equal((await call(captured, { sessionId: 's8' }) as { value: { initialPrompt: string } }).value.initialPrompt, 's8')

    let liveEvents: unknown[] = [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'live' }] } }]
    const live = armed({ sessionQuery: { observeSession: () => Promise.resolve({ source: 'live', events: liveEvents }) } })
    assert.equal((await call(live.captured, { sessionId: 'l1' }) as { value: { initialPrompt: string } }).value.initialPrompt, 'live')
    liveEvents = [...liveEvents, { type: 'team/member', seq: 2, time: 2, data: { member: { name: 'worker' } } }]
    const extended = await call(live.captured, { sessionId: 'l1' }) as { value: { roster: unknown } }
    assert.deepEqual(extended.value.roster, [{ name: 'worker', description: '' }])
  })

  test('a stored observation with no finite seq serves its fold', async () => {
    const { captured } = armed({ sessionQuery: observing([{}, { seq: 'bad' }]) })
    const r = await call(captured, { sessionId: 's1' })
    assert.equal(r.ok, true)
    assert.deepEqual((r.value as { messages: unknown[] }).messages, [])
  })
})

describe('fleet observeSession live source', () => {
  test('a live observation uses the live revision branch and extends its fold', async () => {
    const events = [{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'live-observe' }] } }]
    const { captured } = armed({ sessionQuery: { observeSession: () => Promise.resolve({ source: 'live', events }) } })
    const r = await call(captured, { sessionId: 's1' })
    assert.equal((r.value as { initialPrompt: string }).initialPrompt, 'live-observe')
  })
})

describe('a live fold prefix reset', () => {
  test('a shorter live log refolds instead of serving the longer cached prefix', async () => {
    const relay = (seq: number, text: string): unknown => ({
      type: 'user/message', seq, time: seq, data: { source: { kind: 'agent-message', senderSessionId: 'lead' }, content: [{ type: 'text', text }] },
    })
    let events: unknown[] = [relay(1, 'one'), relay(2, 'two')]
    const { captured } = armed({ sessionQuery: { observeSession: () => Promise.resolve({ source: 'live', events }) } })
    const first = await call(captured, { sessionId: 'l2' }) as { value: { messages: Array<{ text: string }> } }
    assert.deepEqual(first.value.messages.map(m => m.text).sort(), ['one', 'two'])
    events = [relay(2, 'two')]
    const reset = await call(captured, { sessionId: 'l2' }) as { value: { messages: Array<{ text: string }> } }
    assert.deepEqual(reset.value.messages.map(m => m.text), ['two'])
  })
})
