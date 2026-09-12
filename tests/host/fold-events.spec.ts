// applyTimeline switch-case paths of the fold (src/host/fold.ts): every
// durable event type's record-keeping (headers, context, tool calls,
// injections, skill tagging, request records, plan mode, compaction arming)
// plus the session-cost accumulation (model family match, Beijing peak
// windows, per-period running totals). No mocks: the real fold runs.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import {
  assistantMessage,
  at,
  compaction,
  foreign,
  header,
  planMode,
  requestContext,
  toolCall,
  toolResult,
  userMessage,
} from './helpers/events'
import { assertPlainJson, assertStable, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

describe('request/header', () => {
  test('an absent data payload still re-prices the envelope to zero', () => {
    const def = timelineDef({})
    const next = def.apply(def.init(), { type: 'request/header', seq: 1, time: at() } as TimelineEvent)
    assert.equal(next.toolsTokens, 0)
    assert.equal(next.systemTokens, 0)
    assert.equal(next.model, undefined)
  })

  test('an absent header field behaves like an empty header', () => {
    const def = timelineDef({})
    const next = def.apply(def.init(), { type: 'request/header', seq: 1, time: at(), data: { reason: 'initial' } } as TimelineEvent)
    assert.equal(next.lastModel, undefined)
  })

  test('a non-array tools field prices as no tools', () => {
    const { state } = driveTimeline([header(1, { tools: 'nope' as never, model: 'm' })])
    assert.equal(state.toolsTokens, 0)
  })

  test('named tools list prices as a single whole-array total', () => {
    const tools = [{ name: 'bash', description: 'run a command' }, { name: 'read' }]
    const { state } = driveTimeline([header(1, { tools, model: 'm' })])
    assert.ok(state.toolsTokens > 0)
  })

  test('a header without config sets neither model nor provider, and a change stays silent', () => {
    const def = timelineDef({})
    const next = def.apply(def.init(), {
      type: 'request/header', seq: 1, time: at(),
      data: { header: {}, reason: 'change' },
    } as TimelineEvent)
    assert.equal(next.model, undefined)
    assert.equal(next.provider, undefined)
    assert.equal(next.lastModel, undefined, 'no model → lastModel never set')
    assert.equal(next.events.length, 0, 'no model event without a current model')
  })

  test('non-string model/provider values are ignored', () => {
    const { state } = driveTimeline([header(1, { model: 42, provider: 'p' })])
    assert.equal(state.model, undefined)
    assert.equal(state.provider, 'p')
    assert.equal(state.lastModel, undefined)

    const { state: swapped } = driveTimeline([header(1, { model: 'm', provider: 7 })])
    assert.equal(swapped.model, 'm')
    assert.equal(swapped.provider, undefined)
    assert.equal(swapped.lastModel, 'm')
  })

  test('a change as the FIRST header fires no model event (no previous model)', () => {
    const { state } = driveTimeline([header(1, { model: 'a', reason: 'change' })])
    assert.equal(state.events.length, 0)
    assert.equal(state.lastModel, 'a')
  })

  test('a change to the SAME model fires no model event', () => {
    const { state } = driveTimeline([
      header(1, { model: 'a' }),
      header(2, { model: 'a', reason: 'change' }),
    ])
    assert.equal(state.events.length, 0)
  })

  test('a change to a new model records from → to', () => {
    const { state } = driveTimeline([
      header(1, { model: 'a' }),
      header(2, { model: 'b', reason: 'change' }),
    ])
    assert.deepEqual(state.events, [
      { seq: 2, time: state.events[0].time, kind: 'model', from: 'a', to: 'b' },
    ])
    assert.equal(state.model, 'b')
    assert.equal(state.lastModel, 'b')
  })

  test('a resume carrying a different model records the switch too', () => {
    const { state } = driveTimeline([
      header(1, { model: 'a' }),
      header(2, { model: 'b', reason: 'resume' }),
    ])
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].kind, 'model')
    assert.equal(state.events[0].to, 'b')
  })
})

describe('request/context', () => {
  test('route and capacity metadata land on the state', () => {
    const { state } = driveTimeline([
      header(1, { model: 'm' }),
      requestContext(2, { contextWindow: 128000, model: 'm2', provider: 'p2' }),
    ])
    assert.equal(state.contextWindow, 128000)
    assert.equal(state.model, 'm2')
    assert.equal(state.provider, 'p2')
  })

  test('non-number contextWindow and non-string route fields are ignored', () => {
    const { state } = driveTimeline([
      header(1, { model: 'm', provider: 'p' }),
      requestContext(2, { contextWindow: 'x', model: 5, provider: 9 }),
    ])
    assert.equal(state.contextWindow, undefined)
    assert.equal(state.model, 'm')
    assert.equal(state.provider, 'p')
  })

  test('an absent data payload changes nothing (but still folds)', () => {
    const def = timelineDef({})
    const prev = def.init()
    const next = def.apply(prev, requestContext(1))
    assert.ok(next !== prev, 'request/context always re-seals the state')
    assert.equal(next.contextWindow, undefined)
    assert.equal(next.model, undefined)
  })
})

describe('tool/call', () => {
  test('a valid call arms the callNames entry (name + start instant)', () => {
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' })])
    assert.equal(state.callNames.c1?.name, 'bash')
    assert.equal(typeof state.callNames.c1?.start, 'number')
  })

  test('a non-string callId returns the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, toolCall(1, { callId: 5, name: 'bash' }))
  })

  test('a non-string name returns the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, toolCall(1, { callId: 'c1', name: 42 }))
  })

  test('an absent data payload returns the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, { type: 'tool/call', seq: 1, time: at() } as TimelineEvent)
  })
})

describe('user/message injection records', () => {
  test('a source without a form records the context default', () => {
    const { state } = driveTimeline([userMessage(1, text('ctx'), { kind: 'plugin' })])
    assert.equal(state.events.length, 1)
    assert.equal(state.events[0].form, 'context')
    assert.equal(state.events[0].name, 'plugin')
  })

  test('skill-invocation records sub-skill with its name', () => {
    const { state } = driveTimeline([
      userMessage(1, text('run'), { kind: 'skill-invocation', form: 'skill', name: 'code-review' }),
    ])
    assert.equal(state.events[0].sub, 'skill')
    assert.equal(state.events[0].name, 'code-review')
    assert.equal(state.events[0].form, 'skill')
  })

  test('a nameless skill-invocation records ?', () => {
    const { state } = driveTimeline([
      userMessage(1, text('run'), { kind: 'skill-invocation', form: 'skill' }),
    ])
    assert.equal(state.events[0].name, '?')
  })

  test('a source with no readable identity records no name; a notice carries its summary', () => {
    const { state } = driveTimeline([
      userMessage(1, text('note'), { kind: '', form: 'notice', summary: 'heads up' }),
    ])
    assert.equal(state.events.length, 1)
    assert.ok(!('name' in state.events[0]), 'empty producer label stays absent')
    assert.equal(state.events[0].detail, 'heads up')
  })

  test('a notice with an empty summary records no detail', () => {
    const { state } = driveTimeline([
      userMessage(1, text('note'), { kind: 'plugin', plugin: 'dsh-x', form: 'notice', summary: '' }),
    ])
    assert.equal(state.events[0].name, 'dsh-x')
    assert.ok(!('detail' in state.events[0]))
  })

  test('a non-notice form records no detail', () => {
    const { state } = driveTimeline([
      userMessage(1, text('catalog'), { kind: 'skill-catalog', form: 'catalog' }),
    ])
    assert.equal(state.events[0].name, 'skill-catalog')
    assert.ok(!('detail' in state.events[0]))
  })

  test('a non-injection user message records no event', () => {
    const { state } = driveTimeline([userMessage(1, text('just me'))])
    assert.equal(state.events.length, 0)
    assert.equal(state.surface.length, 1)
  })
})

describe('tool/result skill tagging', () => {
  const skillBody = (name: string) => text(`<skill_content name="${name}">instructions</skill_content>`)

  test('a skill-tool result carrying skill content tags the node and records the inject', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'skill' }),
      toolResult(2, { callId: 'c1', content: skillBody('pdf') }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.tool, 'skill')
    assert.equal(node?.skill, 'pdf')
    assert.deepEqual(state.events, [
      { seq: 2, time: state.events[0].time, kind: 'inject', form: 'instructions', sub: 'skill', name: 'pdf', tokens: node?.tokens },
    ])
  })

  test('an untraced result (tool/call gone) tags from the wrapper alone', () => {
    // No tool/call armed: node.tool resolves to undefined — the content
    // wrapper is trusted (a missed tag is worse than a content guess).
    const { state } = driveTimeline([toolResult(1, { callId: 'zz', content: skillBody('xlsx') })])
    assert.equal(state.surface.at(-1)?.skill, 'xlsx')
    assert.equal(state.events[0].name, 'xlsx')
  })

  test('a skill-tool result without the wrapper records nothing', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'skill' }),
      toolResult(2, { callId: 'c1', content: text('plain output') }),
    ])
    assert.equal(state.surface.at(-1)?.skill, undefined)
    assert.equal(state.events.length, 0)
  })

  test('a NON-skill tool result is never tagged, wrapper or not', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: skillBody('pdf') }),
    ])
    assert.equal(state.surface.at(-1)?.tool, 'bash')
    assert.equal(state.surface.at(-1)?.skill, undefined)
    assert.equal(state.events.length, 0)
  })

  test('skill content nested two tool-result levels deep still tags', () => {
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 1, time: at(),
      data: {
        message: {
          content: [{ type: 'tool-result', content: [{ type: 'tool-result', content: skillBody('deep') }] }],
        },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([ev])
    assert.equal(state.surface.at(-1)?.skill, 'deep')
    assert.equal(state.events[0].name, 'deep')
  })

  test('nested empty text yields no tag', () => {
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 1, time: at(),
      data: { message: { content: [{ type: 'tool-result', toolCallId: 'e', content: [{ type: 'text', text: '' }] }] } },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([ev])
    assert.equal(state.surface.at(-1)?.skill, undefined)
    assert.equal(state.events.length, 0)
  })

  test('a message without a content array yields no tag', () => {
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 1, time: at(),
      data: { message: {} },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([ev])
    assert.equal(state.surface.length, 1)
    assert.equal(state.surface[0].cat, 'tool')
    assert.equal(state.events.length, 0)
  })
})

describe('assistant/message request records', () => {
  test('turn and step land on the record', () => {
    const { state } = driveTimeline([assistantMessage(1, { turn: 2, step: 3 })])
    assert.equal(state.requests[0].turn, 2)
    assert.equal(state.requests[0].step, 3)
  })

  test('absent turn/step never materialize undefined properties', () => {
    const { state } = driveTimeline([assistantMessage(1, {})])
    assertPlainJson(state)
    assert.ok(!('turn' in state.requests[0]))
    assert.ok(!('step' in state.requests[0]))
  })

  test('absent usage leaves the billed fields off the record', () => {
    const { state } = driveTimeline([assistantMessage(1, { turn: 1, step: 1 })])
    assert.ok(!('prompt' in state.requests[0]))
    assert.equal(state.cost, undefined)
  })

  test('output-only usage is a billing sample: prompt 0 with the output split', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { outputTokens: 5 } })])
    assert.equal(state.requests[0].prompt, 0)
    assert.equal(state.requests[0].output, 5)
    assert.ok(!('cacheRead' in state.requests[0]))
    assert.equal(state.cost, undefined)
  })

  test('input-only usage bills prompt = input, without cache/output fields', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { inputTokens: 100 } })])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 100)
    assert.ok(!('cacheRead' in rec))
    assert.ok(!('output' in rec))
  })

  test('full usage bills prompt = input + cacheRead + cacheWrite, with cache and output splits', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 } }),
    ])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 60)
    assert.equal(rec.cacheRead, 20)
    assert.equal(rec.output, 40)
  })

  test('an empty-content assistant message projects to a zero-token node', () => {
    const { state } = driveTimeline([assistantMessage(1, { content: [], usage: { inputTokens: 7 } })])
    const node = state.surface.at(-1)
    assert.equal(node?.cat, 'assistant')
    assert.equal(node?.tokens, 0, 'usage-only events project to no message')
    assert.equal(state.requests.length, 1, 'the request record still lands')
  })
})

describe('hostile provider usage (issue #44: stats must survive nonconforming figures)', () => {
  // The registry parses every served view (and every cold-restored state)
  // against the unit's strict integer schemas with no containment: one raw
  // nonconforming figure in the state fails the gate on EVERY later delivery
  // and permanently freezes the session's projection feed. The fold therefore
  // sanitizes each bucket before it touches the state, and the records stay
  // complete (billed, not dropped).
  test('fractional buckets round to integers', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 10.4, cacheReadTokens: 20.6, outputTokens: 3.5 } }),
    ])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 31)
    assert.equal(rec.cacheRead, 21)
    assert.equal(rec.output, 4)
  })

  test('a gateway reporting cached_tokens above prompt_tokens clamps to billed zeros', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: -80, cacheReadTokens: 150, outputTokens: 22 } }),
    ])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 150)
    assert.equal(rec.cacheRead, 150)
    assert.equal(rec.output, 22)
  })

  test('string-reported buckets are read', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: '100', cacheWriteTokens: ' 7 ' } }),
    ])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 107)
    assert.ok(!('cacheRead' in rec))
    assert.ok(!('output' in rec))
  })

  test('non-finite and garbage buckets read as absent', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: Number.NaN, outputTokens: null, cacheReadTokens: {}, cacheWriteTokens: '   ' } }),
    ])
    assert.ok(!('prompt' in state.requests[0]), 'no readable bucket → the sample is absent, not a bogus zero')
    assert.equal(state.cost, undefined)
  })

  test('a readable minority still bills: garbage input with a valid output', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 'n/a', outputTokens: 9 } }),
    ])
    const rec = state.requests[0]
    assert.equal(rec.prompt, 0)
    assert.equal(rec.output, 9)
  })

  test('the folded state and served view stay schema-valid under hostile usage', () => {
    const drive = driveTimeline([
      header(1, { model: 'deepseek-v4-flash' }),
      assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: -80, cacheReadTokens: 150.7, outputTokens: '22.2' } }),
      assistantMessage(3, { turn: 1, step: 2, usage: { inputTokens: Number.NaN, outputTokens: null } }),
      assistantMessage(4, { turn: 1, step: 3, usage: { inputTokens: 12.4 } }),
    ])
    // The gates the registry itself parses with: a throw here is exactly the
    // issue #44 freeze (the drive loop and every later delivery die on it).
    drive.def.stateSchema.parse(assertPlainJson(drive.state))
    drive.def.wire.viewSchema.parse(drive.def.wire.view(drive.state))
  })

  test('sanitized buckets accumulate into the session-cost totals', () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek-official' }),
      assistantMessage(2, {
        usage: { inputTokens: -100, cacheReadTokens: 300.4, cacheWriteTokens: '10', outputTokens: 0.2 },
        time: Date.UTC(2024, 0, 1, 2, 0, 0), // Mon 02:00 UTC — peak
      }),
    ])
    assert.deepEqual(state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak, {
      uncached: 0, cacheRead: 300, cacheWrite: 10, output: 0,
    })
  })
})

describe('plan/mode', () => {
  test('active true records plan.on', () => {
    const { state } = driveTimeline([planMode(1, { active: true })])
    assert.deepEqual(state.events.map(e => [e.kind, e.name]), [['mode', 'plan.on']])
  })

  test('active false records plan.off', () => {
    const { state } = driveTimeline([planMode(1, { active: false })])
    assert.deepEqual(state.events.map(e => [e.kind, e.name]), [['mode', 'plan.off']])
  })

  test('absent data returns the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, planMode(1))
  })

  test('a non-boolean active returns the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, planMode(1, { active: 'yes' }))
  })
})

describe('compaction metering events', () => {
  test('summary with shadowedSeqs arms the claim and records the count', () => {
    const { state } = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 500, shadowedSeqs: [3, 4] }),
    ])
    assert.deepEqual(state.pendingShadowedSeqs, [3, 4])
    assert.equal(state.pendingShadowEventSeq, 1)
    assert.equal(state.events[0].kind, 'compaction')
    assert.equal(state.events[0].tokens, 500)
    assert.equal(state.events[0].count, 2)
  })

  test('prune with shadowedSeqs arms the claim but records no count', () => {
    const { state } = driveTimeline([
      compaction(1, 'prune', { shadowedTokenCount: 5, shadowedSeqs: [9] }),
    ])
    assert.deepEqual(state.pendingShadowedSeqs, [9])
    assert.equal(state.events[0].kind, 'prune')
    assert.equal(state.events[0].tokens, 5)
    assert.ok(!('count' in state.events[0]))
  })

  test('without shadowedSeqs nothing is armed', () => {
    const { state } = driveTimeline([compaction(1, 'summary', { shadowedTokenCount: 7 })])
    assert.ok(!('pendingShadowedSeqs' in state))
    assert.equal(state.events[0].tokens, 7)
    assert.ok(!('count' in state.events[0]), 'count rides the shadowedSeqs array only')
  })

  test('a missing shadowedTokenCount records zero tokens', () => {
    const { state } = driveTimeline([compaction(1, 'summary', { shadowedSeqs: [1] })])
    assert.equal(state.events[0].tokens, 0)
  })

  test('non-number shadowedSeqs entries are filtered out of the claim', () => {
    const { state } = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 1, shadowedSeqs: [1, 'x', null, 2] }),
    ])
    assert.deepEqual(state.pendingShadowedSeqs, [1, 2])
    assert.equal(state.events[0].count, 4, 'the count mirrors the durable array verbatim')
  })

  test('absent data records a zero-token event without arming', () => {
    const { state } = driveTimeline([compaction(1, 'prune')])
    assert.ok(!('pendingShadowedSeqs' in state))
    assert.equal(state.events[0].kind, 'prune')
    assert.equal(state.events[0].tokens, 0)
  })
})

describe('unknown event types', () => {
  test('events outside the fold vocabulary return the same state reference', () => {
    const { state } = driveTimeline([])
    assertStable(state, foreign(1))
    assertStable(state, foreign(2, 'todo/update'))
  })
})

describe('session-cost accumulation', () => {
  const usage = { inputTokens: 100 }
  // DeepSeek peak windows: UTC weekdays 01:00–04:00 and 06:00–10:00. 2024-01-01
  // is a Monday; 2024-01-06/07 the weekend. 02:00 UTC Monday is peak; the
  // helpers' default clock (1970-01-01T00:00:01 UTC) is off-peak.
  const PEAK = Date.UTC(2024, 0, 1, 2, 0, 0)
  const at100 = (seq: number, time: number) => assistantMessage(seq, { usage, time })

  test('no model never prices; any named model accumulates', () => {
    assert.equal(driveTimeline([assistantMessage(1, { usage })]).state.cost, undefined)
    assert.equal(
      driveTimeline([header(1, { model: 'deepseek-v3' }), assistantMessage(2, { usage })]).state.cost?.['']?.['deepseek-v3']?.peak?.uncached,
      100,
      'the fold records every model verbatim; pricing filters on the client',
    )
    assert.equal(
      driveTimeline([header(1, { model: 'gemini-2.0-flash' }), assistantMessage(2, { usage })]).state.cost?.['']?.['gemini-2.0-flash']?.peak?.uncached,
      100,
    )
  })

  test('usage keys by provider, then by model', () => {
    const flash = driveTimeline([header(1, { model: 'deepseek-v4-flash' }), assistantMessage(2, { usage })]).state.cost
    assert.equal(flash?.['']?.['deepseek-v4-flash']?.peak?.uncached, 100, 'a provider-less header books under the empty key')
    const pro = driveTimeline([header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }), at100(2, PEAK)]).state.cost
    assert.equal(pro?.['deepseek-official']?.['deepseek-v4-pro']?.peak?.uncached, 100)
  })

  test('different providers and models book separate buckets', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, PEAK),
      header(3, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      at100(4, PEAK),
      header(5, { provider: 'kimi-coding', model: 'kimi-k2.7-code' }),
      assistantMessage(6, { usage }),
    ])
    assert.equal(state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak?.uncached, 100)
    assert.equal(state.cost?.['deepseek-official']?.['deepseek-v4-pro']?.peak?.uncached, 100)
    assert.equal(state.cost?.['kimi-coding']?.['kimi-k2.7-code']?.peak?.uncached, 100)
    assertPlainJson(state)
  })

  test('consecutive samples of one (provider, model) accumulate', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'kimi-coding', model: 'kimi-k2.7-code' }),
      assistantMessage(2, { usage }),
      assistantMessage(3, { usage }),
    ])
    assert.equal(state.cost?.['kimi-coding']?.['kimi-k2.7-code']?.peak?.uncached, 200)
  })

  test('only DeepSeek splits peak/off-peak; other providers always book list price', () => {
    const night = Date.UTC(2024, 0, 3, 23, 0, 0) // Wed 23:00 UTC — off-peak for DeepSeek
    const deepseek = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, night),
    ]).state.cost?.['deepseek-official']?.['deepseek-v4-flash']
    assert.equal(deepseek?.off?.uncached, 100)
    assert.equal(deepseek?.peak, undefined)
    const kimi = driveTimeline([
      header(1, { provider: 'kimi-coding', model: 'kimi-k3' }),
      at100(2, night),
    ]).state.cost?.['kimi-coding']?.['kimi-k3']
    assert.equal(kimi?.peak?.uncached, 100, 'a flat-rate provider never books off-peak')
    assert.equal(kimi?.off, undefined)
  })

  test('DeepSeek peak-window boundaries and weekends split the periods', () => {
    const at100 = (seq: number, time: number) => assistantMessage(seq, { usage, time })
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, Date.UTC(2024, 0, 1, 1, 0, 0)), // Mon 01:00 UTC — peak opens
      at100(3, Date.UTC(2024, 0, 1, 4, 0, 0)), // Mon 04:00 UTC — peak closed
      at100(4, Date.UTC(2024, 0, 1, 6, 0, 0)), // Mon 06:00 UTC — peak reopens
      at100(5, Date.UTC(2024, 0, 1, 10, 0, 0)), // Mon 10:00 UTC — peak closed
      at100(6, Date.UTC(2024, 0, 6, 2, 0, 0)), // Sat 02:00 UTC — weekend off-peak
      at100(7, Date.UTC(2024, 0, 7, 2, 0, 0)), // Sun 02:00 UTC — weekend off-peak
    ])
    const flash = state.cost?.['deepseek-official']?.['deepseek-v4-flash']
    assert.equal(flash?.peak?.uncached, 200, 'two same-period samples accumulate (01:00 + 06:00 UTC)')
    assert.equal(flash?.off?.uncached, 400, '04:00, 10:00 UTC and the weekend are off-peak')
    assertPlainJson(state)
  })

  test('a request/context provider switch rekeys the following samples', () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash' }),
      assistantMessage(2, { usage }),
      requestContext(3, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(4, PEAK),
    ])
    assert.equal(state.cost?.['']?.['deepseek-v4-flash']?.peak?.uncached, 100)
    assert.equal(state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak?.uncached, 100)
  })

  test('missing usage buckets accumulate as zero', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, PEAK),
    ])
    assert.deepEqual(state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak, {
      uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0,
    })
    assert.equal(state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.off, undefined)
  })

  test('full usage buckets accumulate per bucket', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      assistantMessage(2, {
        usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
        time: PEAK,
      }),
    ])
    assert.deepEqual(state.cost?.['deepseek-official']?.['deepseek-v4-pro']?.peak, {
      uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40,
    })
  })
})

describe('hostile events', () => {
  test('a malformed assistant/message is dropped instead of taking the fold down', () => {
    const def = timelineDef({})
    // deriveEventMessage dereferences data.message.content — a log without it
    // must not throw out of apply (the projection registry has no net; a
    // throwing fold stalls the unit and the browser waits on loading forever).
    const init = def.init()
    const next = def.apply(init, { type: 'assistant/message', seq: 1, time: at(), data: {} } as TimelineEvent)
    assert.equal(next, init, 'a failed event leaves the state untouched')
    // The fold carries on: the next well-formed event still lands.
    const then = def.apply(next, assistantMessage(2, { turn: 1, step: 1 }))
    assert.equal(then.surface.length, 1)
    assert.equal(then.requests.length, 1)
    assertPlainJson(then)
  })

  test('null and primitive content blocks price and render as nothing', () => {
    const blocks = [null, 7, 'x', { type: 'text', text: 'hello' }] as never
    // The tool/result has NO preceding tool/call — the unpaired lookup must
    // not stamp an `undefined`-valued node.tool (it would fail every
    // projection-cache write for the session).
    const { state } = driveTimeline([
      userMessage(1, blocks),
      toolResult(2, { callId: 'c1', content: blocks }),
      assistantMessage(3, { content: blocks }),
    ])
    // The text block still prices; the junk blocks cost overhead only.
    assert.ok(state.sums.user > 0)
    assertPlainJson(state)
  })
})
