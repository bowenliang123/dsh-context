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

  test('usage without inputTokens is not a billing sample', () => {
    const { state } = driveTimeline([assistantMessage(1, { usage: { outputTokens: 5 } })])
    assert.ok(!('prompt' in state.requests[0]))
    assert.ok(!('output' in state.requests[0]))
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
  // DeepSeek peak windows: weekdays 09:00-12:00 and 14:00-18:00 Beijing
  // (UTC+8). 2024-01-01 is a Monday; 2024-01-06/07 the weekend.
  const usage = { inputTokens: 100 }

  test('no model, non-V4 model, and bare deepseek-v4 are never priced', () => {
    assert.equal(driveTimeline([assistantMessage(1, { usage })]).state.cost, undefined)
    assert.equal(
      driveTimeline([header(1, { model: 'deepseek-v3' }), assistantMessage(2, { usage })]).state.cost,
      undefined,
    )
    assert.equal(
      driveTimeline([header(1, { model: 'deepseek-v4' }), assistantMessage(2, { usage })]).state.cost,
      undefined,
      'v4 without a flash/pro suffix matches no family',
    )
  })

  test('v4-flash usage lands in the flash family; v4-pro in pro', () => {
    const flash = driveTimeline([header(1, { model: 'deepseek-v4-flash' }), assistantMessage(2, { usage })]).state.cost
    assert.equal(flash?.flash?.off?.uncached, 100)
    assert.equal(flash?.pro, undefined)
    const pro = driveTimeline([header(1, { model: 'deepseek-v4-pro' }), assistantMessage(2, { usage })]).state.cost
    assert.equal(pro?.pro?.off?.uncached, 100)
    assert.equal(pro?.flash, undefined)
  })

  test('peak-window boundaries and weekends split the periods', () => {
    const at100 = (seq: number, time: number) => assistantMessage(seq, { usage, time })
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash' }),
      at100(2, Date.UTC(2024, 0, 1, 1, 0, 0)), // Mon 09:00 BJT — peak opens
      at100(3, Date.UTC(2024, 0, 1, 4, 0, 0)), // Mon 12:00 BJT — peak closed
      at100(4, Date.UTC(2024, 0, 1, 6, 0, 0)), // Mon 14:00 BJT — peak reopens
      at100(5, Date.UTC(2024, 0, 1, 10, 0, 0)), // Mon 18:00 BJT — peak closed
      at100(6, Date.UTC(2024, 0, 6, 2, 0, 0)), // Sat 10:00 BJT — weekend off-peak
      at100(7, Date.UTC(2024, 0, 7, 2, 0, 0)), // Sun 10:00 BJT — weekend off-peak
    ])
    const flash = state.cost?.flash
    assert.equal(flash?.peak?.uncached, 200, 'two same-period samples accumulate (09:00 + 14:00)')
    assert.equal(flash?.off?.uncached, 400, '12:00, 18:00, Saturday and Sunday are off-peak')
    assertPlainJson(state)
  })

  test('missing usage buckets accumulate as zero', () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-flash' }),
      assistantMessage(2, { usage: { inputTokens: 100 }, time: Date.UTC(2024, 0, 1, 1, 0, 0) }),
    ])
    assert.deepEqual(state.cost?.flash?.peak, { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 })
  })

  test('full usage buckets accumulate per bucket', () => {
    const { state } = driveTimeline([
      header(1, { model: 'deepseek-v4-pro' }),
      assistantMessage(2, {
        usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 },
        time: Date.UTC(2024, 0, 1, 1, 0, 0),
      }),
    ])
    assert.deepEqual(state.cost?.pro?.peak, { uncached: 10, cacheRead: 20, cacheWrite: 30, output: 40 })
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
