import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FLEET_ROUTE, fleetDetailOfEvents, watchFleetChannel } from '../../src/host/fleet'
import { connectionOf, fakeCtx, observing as observingOf, OPEN_GATE, postJson, SKIP_GATE } from './helpers/ctx'
import type { FakeCtx, FakeRoute } from './helpers/ctx'

const armed = (spec: Record<string, unknown> = {}): FakeCtx => {
  const fake = fakeCtx({ connection: connectionOf(), ...spec })
  watchFleetChannel(fake.ctx, OPEN_GATE)
  return fake
}

const call = (captured: FakeRoute, body: unknown): Promise<Record<string, unknown>> => postJson(captured, FLEET_ROUTE, body)

const observing = (events: unknown, inheritedEventCount?: number): ReturnType<typeof observingOf> =>
  observingOf(events, inheritedEventCount === undefined ? {} : { inheritedEventCount })

describe('watchFleetChannel gating', () => {
  test('no route without the connection service or its fetch registry; a rejecting registry keeps it absent without throwing', () => {
    for (const spec of [{}, { connection: {} }, { connection: { fetch: {} } }]) {
      const { ctx, captured } = fakeCtx(spec)
      watchFleetChannel(ctx, OPEN_GATE)
      assert.equal(captured.path, undefined, JSON.stringify(spec))
    }
    const { captured } = armed()
    assert.equal(captured.path, FLEET_ROUTE)
    const rejecting = fakeCtx({ connection: { fetch: { register: () => { throw new Error('registration rejected') } } } })
    assert.doesNotThrow(() => { watchFleetChannel(rejecting.ctx, OPEN_GATE) })
    assert.equal(rejecting.captured.path, undefined)
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
    const skipped = fakeCtx({ connection: connectionOf(), sessionQuery: observing([]) })
    watchFleetChannel(skipped.ctx, SKIP_GATE)
    assert.deepEqual(await call(skipped.captured, { sessionId: 's1' }), { ok: true, value: null })
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
  test('accepts every catalog version and activated Team records, with catalog taking precedence', () => {
    const detail = fleetDetailOfEvents([
      { type: 'subagent/catalog', seq: 4, time: 40, data: { version: 1, childId: 'unknown', childCreatedAt: 400, mode: 'unknown' } },
      { type: 'subagent/catalog', seq: 2, time: 20, data: { version: 0, childId: 'one', childCreatedAt: 200, mode: 'one-shot', label: 'Inspect' } },
      { type: 'subagent/catalog', seq: 1, time: 10, data: { version: 0, childId: 'continuable', childCreatedAt: 100, mode: 'continuable', label: 'Continue' } },
      { type: 'subagent/catalog', seq: 3, time: 30, data: { version: 2, childId: 'external', childCreatedAt: 300, mode: 'external', label: 'Remote' } },
      { type: 'subagent/catalog', seq: 5, time: 50, data: { version: 0, childId: 'bad', childCreatedAt: 500, mode: 'mystery' } },
      { type: 'subagent/catalog', seq: 6, time: 60, data: { version: 0, childId: '', childCreatedAt: 600, mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 7, time: 70, data: { version: 0, childId: 'bad-time', childCreatedAt: 'no', mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 8, time: 80, data: null },
      { type: 'subagent/catalog', seq: 10, time: 100, data: { version: 0, childId: 'missing-label', childCreatedAt: 1000, mode: 'continuable' } },
      { type: 'subagent/catalog', seq: 11, time: 110, data: { version: 3, childId: 'named', childCreatedAt: 1100, mode: 'continuable', label: 'Named duty', name: 'agent-1' } },
      { type: 'subagent/catalog', seq: 12, time: 120, data: { version: 3, childId: 'named-external', childCreatedAt: 1200, mode: 'external', label: 'Named remote', name: 'agent-2' } },
      { type: 'subagent/catalog', seq: 13, time: 130, data: { childId: 'bare', childCreatedAt: 1300, mode: 'one-shot' } },
      { type: 'team/member', seq: 14, time: 1400, data: { teamId: 'root', member: { id: 'mate', name: 'mate', description: 'Team duty', phase: 'provisioning' } } },
      { type: 'team/member', seq: 15, time: 1500, data: { teamId: 'root', member: { id: 'mate', name: 'mate', description: 'Changed', phase: 'active' } } },
      { type: 'team/member', seq: 16, time: 1600, data: { teamId: 'root', member: { id: 'failed', name: 'failed', description: 'Failed', phase: 'failed' } } },
      { type: 'subagent/catalog', seq: 17, time: 1700, data: { version: 1, childId: 'mate', childCreatedAt: 1400, mode: 'continuable', label: 'Catalog wins' } },
      { type: 'team/member', seq: 18, time: 1800, data: { teamId: 'root', member: { id: 'root', name: 'lead', description: 'Lead', phase: 'active' } } },
      { type: 'team/member', seq: 19, time: 1900, data: { teamId: 'root', member: { id: '', name: 'bad', description: 'Bad', phase: 'active' } } },
      { type: 'team/member', seq: 20, time: 2000, data: { teamId: 'root', member: { id: 'empty', name: 'empty', description: '', phase: 'active' } } },
      { type: 'team/member', seq: 21, time: 2100, data: { teamId: 'root', member: { id: 'numeric', name: 'numeric', description: 42, phase: 'active' } } },
      { type: 'subagent/catalog', seq: 22, time: 2200, data: { version: 0, childId: 'bare-one', childCreatedAt: 2200, mode: 'one-shot' } },
      { type: 'subagent/catalog', seq: 23, time: 2300, data: { version: 2, childId: 'bare-external', childCreatedAt: 2300, mode: 'external' } },
    ])
    assert.deepEqual(detail.delegations, [
      { seq: 1, time: 100, to: 'continuable', mode: 'continuable', label: 'Continue' },
      { seq: 2, time: 200, to: 'one', mode: 'one-shot', label: 'Inspect' },
      { seq: 3, time: 300, to: 'external', mode: 'external', label: 'Remote' },
      { seq: 4, time: 400, to: 'unknown', mode: 'unknown' },
      { seq: 11, time: 1100, to: 'named', mode: 'continuable', label: 'Named duty' },
      { seq: 12, time: 1200, to: 'named-external', mode: 'external', label: 'Named remote' },
      { seq: 13, time: 1300, to: 'bare', mode: 'one-shot' },
      { seq: 17, time: 1400, to: 'mate', mode: 'continuable', label: 'Catalog wins' },
      { seq: 20, time: 2000, to: 'empty', mode: 'continuable' },
      { seq: 21, time: 2100, to: 'numeric', mode: 'continuable' },
      { seq: 22, time: 2200, to: 'bare-one', mode: 'one-shot' },
      { seq: 23, time: 2300, to: 'bare-external', mode: 'external' },
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

const catalogEvent = (seq: number, childId: string, over: Record<string, unknown> = {}): unknown => ({
  type: 'subagent/catalog', seq, time: seq, data: { version: 0, childId, childCreatedAt: seq, mode: 'one-shot', ...over },
})

const teamMemberEvent = (seq: number, member: Record<string, unknown>, teamId = 'root'): unknown => ({
  type: 'team/member', seq, time: seq, data: { teamId, member },
})

function observingMap(byId: Record<string, unknown>, over: Record<string, unknown> = {}): {
  observeSession(id: string): Promise<unknown>
  disposeCount(): number
} {
  let disposed = 0
  return {
    observeSession: (id: string) => {
      const events = byId[id]
      if (events === undefined) return Promise.reject(new Error('missing ' + id))
      if (events instanceof Error) return Promise.reject(events)
      return Promise.resolve({ events, ...over, [Symbol.dispose]() { disposed += 1 } })
    },
    disposeCount: () => disposed,
  }
}

describe('fleet summary', () => {
  test('serves the root fold, the durable family facts, and the known root count', async () => {
    const events = [
      catalogEvent(1, 'kid-a', { label: 'Inspect', name: 'agent-1', mode: 'continuable' }),
      catalogEvent(2, 'kid-b'),
      teamMemberEvent(3, { id: 'mate', name: 'mate', description: 'Team duty', phase: 'active' }),
      teamMemberEvent(4, { id: 'root', name: 'lead', description: 'Lead', phase: 'active' }),
      teamMemberEvent(5, { id: 'bare-team', description: 42, phase: 'settled' }),
      teamMemberEvent(6, { id: 'no-phase', name: 'x', phase: 42 }),
      { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'agent-message', senderSessionId: 'lead' }, content: [{ type: 'text', text: 'status?' }] } },
    ]
    const query = observingMap({ root: events }, { source: 'stored', revision: 'r1', header: { createdAt: 1234 } })
    const { captured } = armed({ sessionQuery: query })
    const r = await call(captured, { sessionId: 'root', summary: true }) as {
      value: {
        rootId: string
        rootCreatedAt: number
        detail: { messages: unknown[]; messagesTotal?: number }
        members: unknown[]
        familySize: number
        counts: Record<string, { readAt: number; messagesTotal: number; delegationsCount: number }>
      }
    }
    assert.equal(r.value.rootId, 'root')
    assert.equal(r.value.rootCreatedAt, 1234)
    assert.equal(r.value.detail.messages.length, 1)
    assert.deepEqual(r.value.members, [
      { id: 'kid-a', createdAt: 1, name: 'agent-1', mode: 'continuable', label: 'Inspect' },
      { id: 'kid-b', createdAt: 2, mode: 'one-shot' },
      { id: 'mate', createdAt: 3, name: 'mate', mode: 'continuable', description: 'Team duty', phase: 'active' },
      { id: 'bare-team', createdAt: 5, mode: 'continuable', phase: 'settled' },
      { id: 'no-phase', createdAt: 6, name: 'x', mode: 'continuable' },
    ])
    assert.equal(r.value.familySize, 6)
    assert.equal(r.value.counts.root?.messagesTotal, 1)
    assert.equal(r.value.counts.root?.delegationsCount, 3)
    assert.equal(r.value.counts['kid-a'], undefined, 'unobserved children stay unknown')
    assert.equal(query.disposeCount(), 1)
  })

  test('merges catalog labels over team facts and drops hostile member rows', async () => {
    const events = [
      teamMemberEvent(1, { id: 'kid', name: 'from-team', description: 'duty', phase: 'active', provider: 'spawn', context: 'fresh' }),
      catalogEvent(2, 'kid', { label: 'from-catalog', name: 'agent-x', mode: 'continuable' }),
      teamMemberEvent(3, { id: '', name: 'bad' }),
      teamMemberEvent(4, null as unknown as Record<string, unknown>),
      { type: 'team/member', seq: 5, time: 5, data: null },
    ]
    const { captured } = armed({ sessionQuery: observingMap({ root: events }) })
    const r = await call(captured, { sessionId: 'root', summary: true }) as { value: { members: unknown[] } }
    assert.deepEqual(r.value.members, [
      { id: 'kid', createdAt: 2, name: 'agent-x', mode: 'continuable', label: 'from-catalog', description: 'duty', phase: 'active' },
    ])
  })

  test('orders same-creation members by id without depending on the fold order', async () => {
    const sameTime = (seq: number, childId: string): unknown => ({
      type: 'subagent/catalog', seq, time: 10, data: { version: 0, childId, childCreatedAt: 10, mode: 'one-shot' },
    })
    const { captured } = armed({ sessionQuery: observingMap({ root: [sameTime(1, 'zulu'), sameTime(2, 'alpha'), sameTime(3, 'mike')] }) })
    const r = await call(captured, { sessionId: 'root', summary: true }) as { value: { members: Array<{ id: string }> } }
    assert.deepEqual(r.value.members.map(member => member.id), ['alpha', 'mike', 'zulu'])
  })

  test('degrades to a typed null without a query, an event list, or an admitted cold read', async () => {
    assert.deepEqual(await call(armed().captured, { sessionId: 's1', summary: true }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: {} }).captured, { sessionId: 's1', summary: true }), { ok: true, value: null })
    assert.deepEqual(await call(armed({ sessionQuery: observing(null) }).captured, { sessionId: 's1', summary: true }), { ok: true, value: null })
    const skipped = fakeCtx({ connection: connectionOf(), sessionQuery: observing([]) })
    watchFleetChannel(skipped.ctx, SKIP_GATE)
    assert.deepEqual(await call(skipped.captured, { sessionId: 's1', summary: true }), { ok: true, value: null })
  })

  test('a summary flag that is not exactly true keeps the single detail shape', async () => {
    const { captured } = armed({ sessionQuery: observing([{ type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'plain' }] } }]) })
    const r = await call(captured, { sessionId: 's1', summary: 1 }) as { value: { initialPrompt?: string; members?: unknown } }
    assert.equal(r.value.initialPrompt, 'plain')
    assert.equal(r.value.members, undefined)
  })

  test('a rejecting observation is an internal failure in both error shapes', async () => {
    const err = armed({ sessionQuery: { observeSession: () => Promise.reject(new Error('log unreadable')) } })
    assert.equal(((await call(err.captured, { sessionId: 's1', summary: true })).error as { message: string }).message, 'log unreadable')
    const raw = armed({ sessionQuery: { observeSession: () => Promise.reject('nope') } })
    assert.equal(((await call(raw.captured, { sessionId: 's1', summary: true })).error as { message: string }).message, 'nope')
  })

  test('tolerates missing or hostile header and inherited-count facts', async () => {
    const header: Record<string, unknown> = {}
    const query = observingMap({
      root: [catalogEvent(1, 'inherited'), catalogEvent(3, 'own')],
    }, { header, inheritedEventCount: Number.NaN })
    const { captured } = armed({ sessionQuery: query })
    const first = await call(captured, { sessionId: 'root', summary: true }) as { value: { rootCreatedAt?: number; members: unknown[] } }
    assert.equal(first.value.rootCreatedAt, undefined)
    assert.equal(first.value.members.length, 2, 'a non-finite inherited count reads as zero')
    header.createdAt = 'soon'
    const second = await call(captured, { sessionId: 'root', summary: true }) as { value: { rootCreatedAt?: number } }
    assert.equal(second.value.rootCreatedAt, undefined)
    const negative = armed({ sessionQuery: observingMap({ root: [catalogEvent(1, 'a')] }, { inheritedEventCount: -2 }) })
    const third = await call(negative.captured, { sessionId: 'root', summary: true }) as { value: { members: unknown[] } }
    assert.equal(third.value.members.length, 1)
    const inherited = armed({ sessionQuery: observingMap({ root: [catalogEvent(1, 'inherited'), catalogEvent(3, 'own')] }, { inheritedEventCount: 2 }) })
    const fourth = await call(inherited.captured, { sessionId: 'root', summary: true }) as { value: { members: Array<{ id: string }> } }
    assert.deepEqual(fourth.value.members.map(m => m.id), ['own'])
  })

  test('returns the per-child counts observed so far and rewrites them when the root lifecycle changes', async () => {
    const header: { createdAt?: number } = { createdAt: 5 }
    const query = observingMap({
      root: [catalogEvent(1, 'kid-a'), catalogEvent(2, 'kid-b')],
      'kid-a': [{ type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'team-message', senderId: 'root', senderName: 'lead' }, content: [{ type: 'text', text: 'hello' }] } }],
      'kid-b': [],
    }, { header })
    const { captured } = armed({ sessionQuery: query })
    const root = await call(captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.deepEqual(Object.keys(root.value.counts), ['root'])
    const batch = await call(captured, { batch: { ids: ['kid-a', 'kid-b'], rootId: 'root' } }) as { value: { rows: Record<string, { messagesTotal?: number }>; total: number } }
    assert.deepEqual(Object.keys(batch.value.rows).sort(), ['kid-a', 'kid-b'])
    const grown = await call(captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, { messagesTotal: number; delegationsCount: number }> } }
    assert.deepEqual(Object.keys(grown.value.counts).sort(), ['kid-a', 'kid-b', 'root'])
    assert.equal(grown.value.counts['kid-a']?.messagesTotal, 1)
    assert.equal(grown.value.counts['kid-b']?.messagesTotal, 0)

    header.createdAt = 6
    const reset = await call(captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown>; rootCreatedAt?: number } }
    assert.equal(reset.value.rootCreatedAt, 6)
    assert.deepEqual(Object.keys(reset.value.counts), ['root'], 'a recreated root never inherits the old counts')

    const mismatched = fakeCtx({
      connection: connectionOf(),
      sessionQuery: observingMap({ root: [catalogEvent(1, 'kid-a')], 'kid-a': [] }, { header: { createdAt: 6 } }),
      sessions: { get: (id: string) => id === 'root' ? { header: { createdAt: 7 } } : undefined },
    })
    watchFleetChannel(mismatched.ctx, OPEN_GATE)
    const adapted = await call(mismatched.captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.deepEqual(Object.keys(adapted.value.counts), ['root'])
    await call(mismatched.captured, { batch: { ids: ['kid-a'], rootId: 'root' } })
    const afterMismatch = await call(mismatched.captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.deepEqual(Object.keys(afterMismatch.value.counts), ['root'], 'a different live root identity blocks the update')

    const throwing = fakeCtx({
      connection: connectionOf(),
      sessionQuery: observingMap({ root: [catalogEvent(1, 'kid-a')], 'kid-a': [] }),
      sessions: { get: () => { throw new Error('gone') } },
    })
    watchFleetChannel(throwing.ctx, OPEN_GATE)
    await call(throwing.captured, { sessionId: 'root', summary: true })
    await call(throwing.captured, { batch: { ids: ['kid-a'], rootId: 'root' } })
    const caught = await call(throwing.captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.deepEqual(Object.keys(caught.value.counts).sort(), ['kid-a', 'root'], 'an unreadable live root keeps the buckets usable')
  })

  test('bounds the counts cache by roots and by children, evicting the oldest facts', async () => {
    const eventsByRoot: Record<string, unknown> = {}
    for (let i = 0; i < 9; i++) eventsByRoot[`root-${i}`] = [catalogEvent(1, `kid-${i}`)]
    eventsByRoot['kid-0'] = []
    const { captured } = armed({ sessionQuery: observingMap(eventsByRoot) })
    for (let i = 0; i < 9; i++) await call(captured, { sessionId: `root-${i}`, summary: true })
    await call(captured, { batch: { ids: ['kid-0'], rootId: 'root-0' } })
    const evicted = await call(captured, { sessionId: 'root-0', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.deepEqual(Object.keys(evicted.value.counts), ['root-0'], 'the oldest root bucket was dropped')

    const wide = ['root', ...Array.from({ length: 1024 }, (_, i) => `kid-${i}`)]
    const wideEvents: Record<string, unknown> = { root: wide.slice(1).map((id, i) => catalogEvent(i + 1, id)) }
    for (const id of wide.slice(1)) wideEvents[id] = []
    const wideCtx = armed({ sessionQuery: observingMap(wideEvents) })
    await call(wideCtx.captured, { sessionId: 'root', summary: true })
    for (let offset = 0; offset < 1024; offset += 16) {
      const ids = wide.slice(1 + offset, 1 + offset + 16)
      await call(wideCtx.captured, { batch: { ids, rootId: 'root' } })
    }
    const bounded = await call(wideCtx.captured, { sessionId: 'root', summary: true }) as { value: { counts: Record<string, unknown> } }
    assert.equal(Object.keys(bounded.value.counts).length, 1024, 'the root plus the newest children stay within the bound')
    assert.equal(bounded.value.counts['kid-0'], undefined, 'the oldest child count was evicted')
    assert.ok(bounded.value.counts['kid-1023'] !== undefined)
  })

  test('a cached live fold extends its family facts without losing the summary shape', async () => {
    const events: unknown[] = [catalogEvent(1, 'kid-a')]
    let reads = 0
    const query = { observeSession: () => { reads++; return Promise.resolve({ source: 'live', events, [Symbol.dispose]() {} }) } }
    const { captured } = armed({ sessionQuery: query })
    const first = await call(captured, { sessionId: 'live-root', summary: true }) as { value: { members: Array<{ id: string }> } }
    assert.deepEqual(first.value.members.map(m => m.id), ['kid-a'])
    events.push(catalogEvent(2, 'kid-b'))
    const second = await call(captured, { sessionId: 'live-root', summary: true }) as { value: { members: Array<{ id: string }> } }
    assert.deepEqual(second.value.members.map(m => m.id), ['kid-a', 'kid-b'])
    assert.equal(reads, 2)
  })
})

describe('fleet batch', () => {
  test('folds each id, isolates per-id failures, dedupes, and caps the call', async () => {
    const byId: Record<string, unknown> = {
      a: [catalogEvent(1, 'kid')],
      drop: new Error('unreadable'),
      junk: 'not-events',
      'ok-live': [],
    }
    for (let i = 0; i < 13; i++) byId[`ok-${i}`] = []
    const query = observingMap(byId)
    const { captured } = armed({ sessionQuery: query })
    const ids: unknown[] = ['a', 'a', 42, '', 'drop', 'junk', ...Array.from({ length: 13 }, (_, i) => `ok-${i}`)]
    const r = await call(captured, { batch: { ids, mode: 'preview' } }) as {
      value: { rows: Record<string, unknown>; missing: string[]; total: number }
    }
    assert.equal(r.value.total, 16, 'the batch is capped at sixteen accepted ids')
    assert.deepEqual(r.value.missing.sort(), ['drop', 'junk'])
    assert.equal(Object.keys(r.value.rows).length, 14)
    assert.deepEqual(Object.keys(r.value.rows).sort(), ['a', 'ok-0', 'ok-1', 'ok-10', 'ok-11', 'ok-12', 'ok-2', 'ok-3', 'ok-4', 'ok-5', 'ok-6', 'ok-7', 'ok-8', 'ok-9'])
    assert.equal(query.disposeCount(), 14, 'every served observation is disposed')
  })

  test('serves complete history on request and the bounded excerpt otherwise', async () => {
    const messages = Array.from({ length: 85 }, (_, i) => ({
      type: 'user/message', seq: i + 1, time: i + 1,
      data: { source: { kind: 'agent-message', senderSessionId: 'lead' }, content: [{ type: 'text', text: 'event ' + String(i) }] },
    }))
    const { captured } = armed({ sessionQuery: observingMap({ p: messages }) })
    const preview = await call(captured, { batch: { ids: ['p'], mode: 'preview' } }) as { value: { rows: Record<string, { messages: unknown[]; messagesTotal?: number }> } }
    assert.equal(preview.value.rows.p?.messages.length, 80)
    assert.equal(preview.value.rows.p?.messagesTotal, 85)
    const history = await call(captured, { batch: { ids: ['p'], mode: 'history' } }) as { value: { rows: Record<string, { messages: unknown[]; messagesTotal?: number }> } }
    assert.equal(history.value.rows.p?.messages.length, 85)
    assert.equal(history.value.rows.p?.messagesTotal, undefined)
    const junkMode = await call(captured, { batch: { ids: ['p'], mode: 'full' } }) as { value: { rows: Record<string, { messages: unknown[] }> } }
    assert.equal(junkMode.value.rows.p?.messages.length, 80)
    const noRoot = await call(captured, { batch: { ids: ['p'], mode: 'preview', rootId: '', extra: 1 } }) as { value: { rows: Record<string, unknown> } }
    assert.equal(Object.keys(noRoot.value.rows).length, 1)
  })

  test('answers a typed empty value without a query or an admitted cold read, and surfaces a gate rejection', async () => {
    const empty = armed()
    const noQuery = await call(empty.captured, { batch: { ids: ['a', 'b'] } }) as { value: { rows: Record<string, unknown>; missing: string[]; total: number } }
    assert.deepEqual(noQuery.value, { rows: {}, missing: ['a', 'b'], total: 2 })
    const skipped = fakeCtx({ connection: connectionOf(), sessionQuery: observingMap({ a: [] }) })
    watchFleetChannel(skipped.ctx, SKIP_GATE)
    const gateSkipped = await call(skipped.captured, { batch: { ids: ['a'] } }) as { value: { rows: Record<string, unknown>; missing: string[]; total: number } }
    assert.deepEqual(gateSkipped.value, { rows: {}, missing: ['a'], total: 1 })
    const rejected = fakeCtx({ connection: connectionOf(), sessionQuery: observingMap({ a: [] }) })
    watchFleetChannel(rejected.ctx, { admit: () => Promise.reject(new Error('gate down')) })
    const failure = await call(rejected.captured, { batch: { ids: ['a'] } })
    assert.equal(failure.ok, false)
    assert.equal((failure.error as { message: string }).message, 'gate down')
    const raw = fakeCtx({ connection: connectionOf(), sessionQuery: observingMap({ a: [] }) })
    watchFleetChannel(raw.ctx, { admit: () => Promise.reject('gate down') })
    assert.equal(((await call(raw.captured, { batch: { ids: ['a'] } })).error as { message: string }).message, 'gate down')
  })

  test('a live batch observation extends its fold cache branch', async () => {
    let events: unknown[] = [catalogEvent(1, 'kid')]
    const query = { observeSession: () => Promise.resolve({ source: 'live', events, [Symbol.dispose]() {} }) }
    const { captured } = armed({ sessionQuery: query })
    const first = await call(captured, { batch: { ids: ['live'] } }) as { value: { rows: Record<string, { delegations?: unknown[] }> } }
    assert.equal(first.value.rows.live?.delegations?.length, 1)
    events = [...events, catalogEvent(2, 'kid-2')]
    const second = await call(captured, { batch: { ids: ['live'] } }) as { value: { rows: Record<string, { delegations?: unknown[] }> } }
    assert.equal(second.value.rows.live?.delegations?.length, 2)
  })

  test('rejects a malformed batch as a missing session id', async () => {
    const { captured } = armed()
    for (const body of [{ batch: null }, { batch: {} }, { batch: { ids: 'nope' } }, { batch: { ids: [] } }, { batch: { ids: [42, ''] } }]) {
      const r = await call(captured, body)
      assert.equal(r.ok, false, JSON.stringify(body))
    }
  })
})

describe('the fleet fold cache bounds', () => {
  test('stays bounded by entries and by bytes while every stored field is measured', async () => {
    const rich = [
      { type: 'subagent/descriptor', seq: 1, time: 1, data: { mode: 'continuable', label: 'worker', provider: 'fork' } },
      { type: 'user/message', seq: 2, time: 2, data: { content: [{ type: 'text', text: 'prompt' }] } },
      { type: 'assistant/message', seq: 3, time: 3, data: { message: { content: [{ type: 'text', text: 'reply' }] } } },
      { type: 'user/message', seq: 4, time: 4, data: { source: { kind: 'team-message', senderId: 'peer', senderName: 'peer' }, content: [{ type: 'text', text: 'Team message m from peer: hi' }] } },
      { type: 'user/message', seq: 5, time: 5, data: { source: { kind: 'subagent-settled', summary: 'child done', senderSessionId: 'w' }, content: [{ type: 'text', text: 'child done. Its closing message:report. Structured result: {"ok":true}tail' }] } },
      teamMemberEvent(6, { id: 'mate', name: 'mate', description: 'duty', phase: 'active' }),
      catalogEvent(7, 'kid', { label: 'Inspect', name: 'agent-1' }),
    ]
    const byId: Record<string, unknown> = { rich, bare: [] }
    for (let i = 0; i < 40; i++) byId[`s-${i}`] = []
    byId.huge = [catalogEvent(1, 'kid', { label: 'x'.repeat(4 * 1024 * 1024 + 1) })]
    const { captured } = armed({ sessionQuery: observingMap(byId, { source: 'stored', revision: 'r1' }) })
    for (const id of ['rich', 'bare', ...Array.from({ length: 40 }, (_, i) => `s-${i}`)]) {
      const r = await call(captured, { sessionId: id })
      assert.equal(r.ok, true, id)
    }
    const huge = await call(captured, { sessionId: 'huge' })
    assert.equal(huge.ok, true)
    const again = await call(captured, { sessionId: 'huge' })
    assert.equal(again.ok, true)
    assert.equal(((again.value as { delegations?: Array<{ label?: string }> }).delegations?.[0]?.label?.length), 4 * 1024 * 1024 + 1)
  })
})

describe('fleet fold cache idle sweep', () => {
  test('drops the fold cache after inactivity and a later request still serves', async () => {
    const relay = { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'agent-message', senderSessionId: 'lead' }, content: [{ type: 'text', text: 'one' }] } }
    const keyed = {
      sessionQuery: {
        observeSession: () => Promise.resolve({ source: 'stored', revision: 'r-1', events: [relay] }),
      },
    }
    const fake = fakeCtx({ connection: connectionOf(), ...keyed })
    watchFleetChannel(fake.ctx, OPEN_GATE, { idleSweepMs: 10 })
    const first = await postJson(fake.captured, FLEET_ROUTE, { sessionId: 's1', summary: true })
    assert.equal(first.ok, true)
    await new Promise(resolve => setTimeout(resolve, 30))
    const second = await postJson(fake.captured, FLEET_ROUTE, { sessionId: 's1', summary: true })
    assert.equal(second.ok, true)
    const third = await postJson(fake.captured, FLEET_ROUTE, { sessionId: 's1', summary: true })
    assert.equal(third.ok, true)
    fake.dispose()
    assert.doesNotThrow(() => { fake.dispose() })
    const untimed = fakeCtx({ connection: connectionOf() })
    watchFleetChannel(untimed.ctx, OPEN_GATE, { idleSweepMs: 10 })
    untimed.dispose()
  })
})
