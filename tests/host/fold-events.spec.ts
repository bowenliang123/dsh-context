import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { foldSurface } from '@deepseek-ai/dsh-session'
import { type TimelineEvent, buildTimelineDetail, buildTimelineHead, skillNameOf } from '../../src/host/fold'
import { assistantAttempt, assistantMessage, at, compaction, endSeed, foreign, header, planMode, requestContext, toolCall, toolResult, userMessage, canonicalLog, stepStart } from './helpers/events'
import { estimateToolsTotal } from '../../src/host/pricing'
import { assertPlainJson, assertStable, driveTimeline, fullDef, requestsOf, timelineDef, assertStatesPlainJson } from './helpers/projection'
import { resolveBounds } from '../../src/host/config'

describe('fold-events', () => {

const text = (t: string) => [{ type: 'text', text: t }]

describe('request/header', () => {
  test('an absent payload, header, or hostile scalar folds as an empty header', () => {
    const def = timelineDef({})
    const absentData = def.apply(def.init(), { type: 'request/header', seq: 1, time: at() } as TimelineEvent)
    assert.equal(absentData.toolsTokens, 0)
    assert.equal(absentData.systemTokens, 0)
    assert.equal(absentData.model, undefined)
    const absentHeader = def.apply(def.init(), {
      type: 'request/header', seq: 1, time: at(), data: { reason: 'initial' },
    } as TimelineEvent)
    assert.equal(absentHeader.lastModel, undefined)
    assert.equal(absentHeader.provider, undefined)
    const hostileModel = driveTimeline([header(1, { model: 42, provider: 'p' })]).state
    assert.deepEqual([hostileModel.model, hostileModel.provider, hostileModel.lastModel], [undefined, 'p', undefined])
    const hostileProvider = driveTimeline([header(1, { model: 'm', provider: 7 })]).state
    assert.deepEqual([hostileProvider.model, hostileProvider.provider, hostileProvider.lastModel], ['m', undefined, 'm'])
  })

  test('the tools field prices one whole-array total; a non-array prices zero', () => {
    const junk = driveTimeline([header(1, { tools: 'nope' as never, model: 'm' })])
    assert.equal(junk.state.toolsTokens, 0)
    const tools = [{ name: 'bash', description: 'run a command' }, { name: 'read' }]
    const priced = driveTimeline([header(1, { tools, model: 'm' })])
    assert.equal(priced.state.toolsTokens, estimateToolsTotal(tools), 'one JSON price over the whole array')
  })

  test('a change or resume header records from → to only for a real model switch', () => {
    const first = driveTimeline([header(1, { model: 'a', reason: 'change' })])
    assert.equal(first.state.events.length, 0, 'no previous model')
    assert.equal(first.state.lastModel, 'a')
    const same = driveTimeline([header(1, { model: 'a' }), header(2, { model: 'a', reason: 'change' })])
    assert.equal(same.state.events.length, 0, 'the same model is no switch')
    for (const reason of ['change', 'resume'] as const) {
      const { state } = driveTimeline([header(1, { model: 'a' }), header(2, { model: 'b', reason })])
      assert.deepEqual(state.events, [{ seq: 2, time: state.events[0].time, kind: 'model', from: 'a', to: 'b' }], reason)
      assert.equal(state.model, 'b')
      assert.equal(state.lastModel, 'b')
    }
  })
})

describe('request/context', () => {
  test('route and capacity metadata land; hostile or absent values return the same state reference', () => {
    const routed = driveTimeline([header(1, { model: 'm' }), requestContext(2, {
      contextWindow: 128000, model: 'm2', provider: 'p2',
    })]).state
    assert.deepEqual([routed.contextWindow, routed.model, routed.provider], [128000, 'm2', 'p2'])
    const def = timelineDef({})
    const armed = def.apply(def.init(), header(1, { model: 'm', provider: 'p' }))
    const hostile = def.apply(armed, requestContext(2, { contextWindow: 'x', model: 5, provider: 9 }))
    assert.equal(hostile, armed)
    const init = def.init()
    const absent = def.apply(init, requestContext(1))
    assert.equal(absent, init, 'an unchanged route leaves the state untouched')
    const same = def.apply(routed, requestContext(3, { contextWindow: 128000, model: 'm2', provider: 'p2' }))
    assert.equal(same, routed)
    const routedOnly = def.apply(def.apply(def.init(), header(1, { model: 'm', provider: 'p' })), requestContext(2, { contextWindow: 64000 }))
    assert.deepEqual([routedOnly.contextWindow, routedOnly.model, routedOnly.provider], [64000, 'm', 'p'])
    const modelOnly = def.apply(routedOnly, requestContext(3, { model: 'm2', provider: 'p2' }))
    assert.deepEqual([modelOnly.contextWindow, modelOnly.model, modelOnly.provider], [64000, 'm2', 'p2'])
    const windowOnly = def.apply(modelOnly, requestContext(4, { contextWindow: 64000 }))
    assert.equal(windowOnly, modelOnly)
  })
})

describe('tool/call', () => {
  test('a valid call arms the callNames entry; an invalid envelope returns the same state reference', () => {
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' })])
    assert.equal(state.callNames.c1?.name, 'bash')
    assert.equal(typeof state.callNames.c1?.start, 'number')
    const empty = driveTimeline([]).state
    assertStable(empty, toolCall(1, { callId: 5, name: 'bash' }))
    assertStable(empty, toolCall(1, { callId: 'c1', name: 42 }))
    assertStable(empty, { type: 'tool/call', seq: 1, time: at() } as TimelineEvent)
  })
})

describe('user/message injection records', () => {
  test('an injection without a usable form records the context default', () => {
    const plain = driveTimeline([userMessage(1, text('ctx'), { kind: 'plugin' })]).state
    assert.equal(plain.events.length, 1)
    assert.equal(plain.events[0].form, 'context')
    assert.equal(plain.events[0].name, 'plugin')
    assert.equal(plain.surface[0].name, 'plugin')
    const hostile = driveTimeline([
      userMessage(1, text('note'), { kind: 'plugin', plugin: 'dsh-x', form: 123 } as never),
    ]).state
    assert.equal(hostile.events[0].name, 'dsh-x')
    assert.equal(hostile.events[0].form, 'context')
  })

  test('a skill-invocation records sub-skill with its name, or ? when nameless', () => {
    const named = driveTimeline([
      userMessage(1, text('run'), { kind: 'skill-invocation', form: 'skill', name: 'code-review' }),
    ]).state
    assert.equal(named.events[0].sub, 'skill')
    assert.equal(named.events[0].name, 'code-review')
    assert.equal(named.events[0].form, 'skill')
    assert.ok(!('name' in named.surface[0]))
    assert.equal(named.surface[0].skill, 'code-review')
    const nameless = driveTimeline([
      userMessage(1, text('run'), { kind: 'skill-invocation', form: 'skill' }),
    ]).state
    assert.equal(nameless.events[0].name, '?')
  })

  test('a notice carries its summary unless empty; a nameless source and other forms record no detail', () => {
    const unnamed = driveTimeline([
      userMessage(1, text('note'), { kind: '', form: 'notice', summary: 'heads up' }),
    ]).state
    assert.equal(unnamed.events.length, 1)
    assert.ok(!('name' in unnamed.events[0]), 'empty producer label stays absent')
    assert.equal(unnamed.events[0].detail, 'heads up')
    assert.ok(!('name' in unnamed.surface[0]), 'the node stays unstamped too')
    const empty = driveTimeline([
      userMessage(1, text('note'), { kind: 'plugin', plugin: 'dsh-x', form: 'notice', summary: '' }),
    ]).state
    assert.equal(empty.events[0].name, 'dsh-x')
    assert.equal(empty.surface[0].name, 'dsh-x')
    assert.ok(!('detail' in empty.events[0]))
    const catalog = driveTimeline([
      userMessage(1, text('catalog'), { kind: 'skill-catalog', form: 'catalog' }),
    ]).state
    assert.equal(catalog.events[0].name, 'skill-catalog')
    assert.equal(catalog.surface[0].name, 'skill-catalog')
    assert.ok(!('detail' in catalog.events[0]))
  })

  test('an agent-instructions source names its reconciled files on the event and the node', () => {
    const { state } = driveTimeline([
      userMessage(1, text('instructions'), {
        kind: 'agent-instructions', form: 'instructions',
        changes: [{ path: 'AGENTS.md' }, { path: 'AGENTS.md' }, { path: '' }, null],
      }),
    ])
    assert.equal(state.events[0].name, 'AGENTS.md')
    assert.equal(state.surface[0].name, 'AGENTS.md')
  })

  test('a non-injection user message records no event', () => {
    const { state } = driveTimeline([userMessage(1, text('just me'))])
    assert.equal(state.events.length, 0)
    assert.equal(state.surface.length, 1)
  })
})

describe('tool/result skill tagging', () => {
  const skillBody = (name: string) => text(`<skill_content name="${name}">instructions</skill_content>`)

  test('a skill-tool result carrying skill content re-buckets to `skill` and records the inject', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'skill' }),
      toolResult(2, { callId: 'c1', content: skillBody('pdf') }),
      assistantMessage(3, { turn: 1, step: 1 }),
    ])
    const node = state.surface.at(-2)
    assert.deepEqual([node?.tool, node?.skill, node?.cat], ['skill', 'pdf', 'skill'])
    assert.deepEqual([state.sums.tool, state.sums.skill, requestsOf(state).at(-1)?.skill], [0, node?.tokens, node?.tokens])
    assert.ok((state.requests.at(-1)?.total ?? 0) >= (node?.tokens ?? 0))
    assert.deepEqual(state.events, [
      { seq: 2, time: state.events[0].time, kind: 'inject', form: 'instructions', sub: 'skill', name: 'pdf', tokens: node?.tokens },
    ])
  })

  test('an untraced result (tool/call gone) tags from the wrapper alone and keeps its tool identity', () => {
    const { state } = driveTimeline([toolResult(1, { callId: 'zz', content: skillBody('xlsx') })])
    const node = state.surface.at(-1)
    assert.deepEqual([node?.skill, node?.cat, node?.tool], ['xlsx', 'skill', 'skill'])
    assert.deepEqual([state.sums.skill, state.events[0].name], [node?.tokens, 'xlsx'])
  })

  test('skill tagging needs the first-level wrapper on a skill or unpaired result; other shapes and non-skill tools stay untagged', () => {
    const plain = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'skill' }),
      toolResult(2, { callId: 'c1', content: text('plain output') }),
    ]).state
    assert.equal(plain.surface.at(-1)?.skill, undefined)
    assert.equal(plain.events.length, 0)
    const nested = driveTimeline([{
      type: 'tool/result', seq: 1, time: at(),
      data: {
        message: {
          content: [{ type: 'foreign-wrapper', content: [{ type: 'text', text: '<skill_content name="deep">x</skill_content>' }] }],
        },
      },
      surfaceOp: 'append',
    } as TimelineEvent]).state
    assert.equal(nested.surface.at(-1)?.skill, undefined)
    assert.equal(nested.events.length, 0)
    const empty = driveTimeline([{
      type: 'tool/result', seq: 1, time: at(),
      data: { message: { role: 'tool', toolCallId: 'e', content: [{ type: 'text', text: '' }] } },
      surfaceOp: 'append',
    } as TimelineEvent]).state
    assert.equal(empty.surface.at(-1)?.skill, undefined)
    assert.equal(empty.events.length, 0)
    const noContent = driveTimeline([{
      type: 'tool/result', seq: 1, time: at(),
      data: { message: {} },
      surfaceOp: 'append',
    } as TimelineEvent]).state
    assert.equal(noContent.surface.length, 1)
    assert.equal(noContent.surface[0].cat, 'tool')
    assert.equal(noContent.events.length, 0)
    const nonSkill = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: skillBody('pdf') }),
    ]).state
    assert.equal(nonSkill.surface.at(-1)?.tool, 'bash')
    assert.equal(nonSkill.surface.at(-1)?.skill, undefined)
    assert.equal(nonSkill.events.length, 0)
  })
})

describe('assistant/message request records', () => {
  test('turn and step land on the record, and absent ones never materialize undefined properties', () => {
    const { state } = driveTimeline([assistantMessage(1, { turn: 2, step: 3 })])
    assert.equal(state.requests[0].turn, 2)
    assert.equal(state.requests[0].step, 3)
    const bare = driveTimeline([assistantMessage(1, {})]).state
    assertPlainJson(bare)
    assert.ok(!('turn' in bare.requests[0]))
    assert.ok(!('step' in bare.requests[0]))
  })

  test('usage buckets bill prompt = input + cacheRead + cacheWrite with the splits; absent usage bills nothing', () => {
    const absent = driveTimeline([assistantMessage(1, { turn: 1, step: 1 })]).state
    assert.ok(!('prompt' in absent.requests[0]))
    assert.equal(absent.cost, undefined)
    const outputOnly = driveTimeline([assistantMessage(1, { usage: { outputTokens: 5 } })]).state
    assert.deepEqual([requestsOf(outputOnly)[0].prompt, requestsOf(outputOnly)[0].output, outputOnly.cost], [0, 5, undefined])
    assert.ok(!('cacheRead' in outputOnly.requests[0]))
    const inputOnly = requestsOf(driveTimeline([assistantMessage(1, { usage: { inputTokens: 100 } })]).state)[0]
    assert.equal(inputOnly.prompt, 100)
    assert.ok(!('cacheRead' in inputOnly) && !('output' in inputOnly))
    const full = requestsOf(driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 40 } }),
    ]).state)[0]
    assert.deepEqual([full.prompt, full.cacheRead, full.output], [60, 20, 40])
  })

  test('an empty-content assistant message projects to a zero-token node', () => {
    const { state } = driveTimeline([assistantMessage(1, { content: [], usage: { inputTokens: 7 } })])
    const node = state.surface.at(-1)
    assert.equal(node?.cat, 'assistant')
    assert.equal(node?.tokens, 0, 'usage-only events project to no message')
    assert.equal(state.requests.length, 1, 'the request record still lands')
  })
})

describe('the answers tally (assistant messages carrying text)', () => {
  test('a textual reply tallies — alone, or beside tool calls; a tool-only dispatch, an empty projection, and blank text do not', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { content: [{ type: 'text', text: 'here is the answer' }] }),
      assistantMessage(2, { content: [{ type: 'tool-call', name: 'bash' }] }),
      assistantMessage(3, { content: [] }),
      assistantMessage(4, { content: [{ type: 'text', text: '   ' }] }),
      assistantAttempt(5, {}),
      assistantMessage(6, { content: [{ type: 'text', text: 'done' }] }),
      assistantMessage(7, { content: [{ type: 'text', text: 'checking' }, { type: 'tool-call', name: 'bash' }] }),
    ])
    assert.equal(state.answers, 3)
    assertPlainJson(state)
  })
})

describe('hostile provider usage (issue #44: stats must survive nonconforming figures)', () => {
  test('nonconforming buckets sanitize: fractional rounds, a negative clamps, string figures read, a readable minority bills', () => {
    const fractional = requestsOf(driveTimeline([
      assistantMessage(1, { usage: { inputTokens: 10.4, cacheReadTokens: 20.6, outputTokens: 3.5 } }),
    ]).state)[0]
    assert.equal(fractional.prompt, 31)
    assert.equal(fractional.cacheRead, 21)
    assert.equal(fractional.output, 4)
    const negative = requestsOf(driveTimeline([
      assistantMessage(1, { usage: { inputTokens: -80, cacheReadTokens: 150, outputTokens: 22 } }),
    ]).state)[0]
    assert.equal(negative.prompt, 150, 'the cache bucket still bills')
    assert.equal(negative.cacheRead, 150)
    assert.equal(negative.output, 22)
    const strings = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: '100', cacheWriteTokens: ' 7 ' } }),
    ]).state.requests[0]
    assert.equal(strings.prompt, 107)
    assert.ok(!('cacheRead' in strings))
    assert.ok(!('output' in strings))
    const minority = requestsOf(driveTimeline([assistantMessage(1, { usage: { inputTokens: 'n/a', outputTokens: 9 } })]).state)[0]
    assert.equal(minority.prompt, 0)
    assert.equal(minority.output, 9)
    const billed = driveTimeline([
      header(1, { model: 'deepseek-v4-flash', provider: 'deepseek-official' }),
      assistantMessage(2, {
        usage: { inputTokens: -100, cacheReadTokens: 300.4, cacheWriteTokens: '10', outputTokens: 8 },
        time: Date.UTC(2024, 0, 1, 2, 0, 0),
      }),
    ]).state
    assert.deepEqual(billed.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak, {
      uncached: 0, cacheRead: 300, cacheWrite: 10, output: 8,
    })
  })

  test('non-finite and garbage buckets read as absent', () => {
    const { state } = driveTimeline([
      assistantMessage(1, { usage: { inputTokens: Number.NaN, outputTokens: null, cacheReadTokens: {}, cacheWriteTokens: '   ' } }),
    ])
    assert.ok(!('prompt' in state.requests[0]), 'no readable bucket → the sample is absent, not a bogus zero')
    assert.equal(state.cost, undefined)
  })

  test('the folded state and served view stay schema-valid under hostile usage', () => {
    const drive = driveTimeline([
      header(1, { model: 'deepseek-v4-flash' }),
      assistantMessage(2, { turn: 1, step: 1, usage: { inputTokens: -80, cacheReadTokens: 150.7, outputTokens: '22.2' } }),
      assistantMessage(3, { turn: 1, step: 2, usage: { inputTokens: Number.NaN, outputTokens: null } }),
      assistantMessage(4, { turn: 1, step: 3, usage: { inputTokens: 12.4 } }),
    ])
    drive.def.stateSchema.parse(assertPlainJson(drive.state))
    drive.def.wire.viewSchema.parse(drive.def.wire.view(drive.state))
  })
})

describe('session/end-seed', () => {
  const inherited = [
    header(1, { model: 'deepseek-v3' }),
    assistantMessage(2, { usage: { inputTokens: 100 } }),
  ]

  test('a tagged marker zeroes inherited spend; later spend prices afresh and a nested cut re-resets', () => {
    const { states, state } = driveTimeline([
      ...inherited,
      endSeed(3, { inherited: true }),
      assistantMessage(4, { usage: { inputTokens: 7 } }),
      endSeed(5, { inherited: true }),
      assistantMessage(6, { usage: { inputTokens: 2 } }),
    ])
    assert.deepEqual(states[3].cost, {})
    assert.equal(states[4].cost?.['']?.['deepseek-v3']?.peak?.uncached, 7)
    assert.equal(state.cost?.['']?.['deepseek-v3']?.peak?.uncached, 2)
  })

  test('a tagged marker cuts the generated-reasoning tally with the spend; the live prefix keeps its price', () => {
    const think = (text: string) => ({ type: 'reasoning', text })
    const { states, state } = driveTimeline([
      assistantMessage(1, { content: [think('think')] }),
      endSeed(2, { inherited: true }),
      assistantMessage(3, { content: [think('more')] }),
    ])
    assert.equal(states[1].generatedReasoning, 6)
    assert.equal(states[2].generatedReasoning, undefined)
    assert.equal(state.generatedReasoning, 5)
    assert.equal(state.assistantReasoning, 11, 'the inherited surface stays live')
  })

  test('a tagged marker cuts the generated-answers tally with the spend; the live prefix keeps its price', () => {
    const say = (text: string) => ({ type: 'text', text })
    const { states, state } = driveTimeline([
      assistantMessage(1, { content: [say('hello')] }),
      endSeed(2, { inherited: true }),
      assistantMessage(3, { content: [say('more')] }),
    ])
    assert.equal(states[1].generatedAnswerTokens, 6)
    assert.equal(states[2].generatedAnswerTokens, undefined)
    assert.equal(state.generatedAnswerTokens, 5)
    assert.equal(state.assistantAnswerTokens, 11, 'the inherited surface stays live')
  })

  test('a tagged marker cuts the generated tool-call tally with the spend; the live prefix keeps its price', () => {
    const call = () => ({ type: 'tool-call', name: 'bash', arguments: '{}' })
    const { states, state } = driveTimeline([
      assistantMessage(1, { content: [call()] }),
      endSeed(2, { inherited: true }),
      assistantMessage(3, { content: [call()] }),
    ])
    assert.equal(states[1].generatedCallTokens, 6)
    assert.equal(states[2].generatedCallTokens, undefined)
    assert.equal(state.generatedCallTokens, 6)
    assert.equal(state.assistantCallTokens, 12, 'the inherited surface stays live')
  })

  test('a marker without a strict `inherited: true` flag is a no-op', () => {
    const { def, state } = driveTimeline(inherited)
    const before = state.cost
    assert.ok(before !== undefined)
    for (const data of [undefined, null, {}, { inherited: 'yes' }, { inherited: 1 }, { inherited: null }]) {
      assert.equal(def.apply(state, endSeed(3, data)), state, `data ${JSON.stringify(data)} must not reset`)
    }
    assert.equal(state.cost, before)
  })
})

describe('plan/mode', () => {
  test('a boolean active records plan.on or plan.off; absent or hostile active returns the same reference', () => {
    for (const [active, name] of [[true, 'plan.on'], [false, 'plan.off']] as const) {
      const { state } = driveTimeline([planMode(1, { active })])
      assert.deepEqual(state.events.map(e => [e.kind, e.name]), [['mode', name]], String(active))
    }
    const { state } = driveTimeline([])
    assertStable(state, planMode(1))
    assertStable(state, planMode(1, { active: 'yes' }))
  })
})

describe('compaction metering events', () => {
  test('summary arms the claim and records the count; a missing token count records zero; junk seqs filter', () => {
    const { state } = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 500, shadowedSeqs: [3, 4] }),
    ])
    assert.deepEqual(state.pendingShadowedSeqs, [3, 4])
    assert.equal(state.pendingShadowEventSeq, 1)
    assert.equal(state.events[0].kind, 'compaction')
    assert.equal(state.events[0].tokens, 500)
    assert.equal(state.events[0].count, 2)
    const uncounted = driveTimeline([compaction(1, 'summary', { shadowedSeqs: [1] })]).state
    assert.equal(uncounted.events[0].tokens, 0)
    const filtered = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 1, shadowedSeqs: [1, 'x', null, 2] }),
    ]).state
    assert.deepEqual(filtered.pendingShadowedSeqs, [1, 2])
    assert.equal(filtered.events[0].count, 4, 'the count mirrors the durable array verbatim')
  })

  test('prune arms the claim but records no count; without shadowedSeqs or data nothing is armed', () => {
    const { state } = driveTimeline([
      compaction(1, 'prune', { shadowedTokenCount: 5, shadowedSeqs: [9] }),
    ])
    assert.deepEqual(state.pendingShadowedSeqs, [9])
    assert.equal(state.events[0].kind, 'prune')
    assert.equal(state.events[0].tokens, 5)
    assert.ok(!('count' in state.events[0]))
    const noSeqs = driveTimeline([compaction(1, 'summary', { shadowedTokenCount: 7 })]).state
    assert.ok(!('pendingShadowedSeqs' in noSeqs))
    assert.equal(noSeqs.events[0].tokens, 7)
    assert.ok(!('count' in noSeqs.events[0]), 'count rides the shadowedSeqs array only')
    const absent = driveTimeline([compaction(1, 'prune')]).state
    assert.ok(!('pendingShadowedSeqs' in absent))
    assert.equal(absent.events[0].kind, 'prune')
    assert.equal(absent.events[0].tokens, 0)
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
  const PEAK = Date.UTC(2024, 0, 1, 2, 0, 0)
  const at100 = (seq: number, time: number) => assistantMessage(seq, { usage, time })

  test('a request without a model never prices; an unknown named model still books verbatim', () => {
    assert.equal(driveTimeline([assistantMessage(1, { usage })]).state.cost, undefined)
    assert.equal(
      driveTimeline([header(1, { model: 'gemini-2.0-flash' }), assistantMessage(2, { usage })]).state.cost?.['']?.['gemini-2.0-flash']?.peak?.uncached,
      100,
      'the fold records every model verbatim; pricing filters on the client',
    )
  })

  test('different providers and models book separate buckets; a provider-less header books under the empty key', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, PEAK),
      header(3, { provider: 'deepseek-official', model: 'deepseek-v4-pro' }),
      at100(4, PEAK),
      header(5, { provider: 'kimi-coding', model: 'kimi-k2.7-code' }),
      assistantMessage(6, { usage }),
    ])
    assert.deepEqual([
      state.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak?.uncached,
      state.cost?.['deepseek-official']?.['deepseek-v4-pro']?.peak?.uncached,
      state.cost?.['kimi-coding']?.['kimi-k2.7-code']?.peak?.uncached,
    ], [100, 100, 100])
    const providerless = driveTimeline([header(1, { model: 'deepseek-v4-flash' }), at100(2, PEAK)]).state.cost
    assert.equal(providerless?.['']?.['deepseek-v4-flash']?.peak?.uncached, 100, 'a provider-less header books under the empty key')
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
    const night = Date.UTC(2024, 0, 3, 23, 0, 0)
    const deepseek = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, night),
    ]).state.cost?.['deepseek-official']?.['deepseek-v4-flash']
    assert.deepEqual([deepseek?.off?.uncached, deepseek?.peak], [100, undefined])
    const kimi = driveTimeline([
      header(1, { provider: 'kimi-coding', model: 'kimi-k3' }),
      at100(2, night),
    ]).state.cost?.['kimi-coding']?.['kimi-k3']
    assert.deepEqual([kimi?.peak?.uncached, kimi?.off], [100, undefined], 'a flat-rate provider never books off-peak')
  })

  test('DeepSeek peak-window boundaries and weekends split the periods', () => {
    const { state } = driveTimeline([
      header(1, { provider: 'deepseek-official', model: 'deepseek-v4-flash' }),
      at100(2, Date.UTC(2024, 0, 1, 1, 0, 0)),
      at100(3, Date.UTC(2024, 0, 1, 4, 0, 0)),
      at100(4, Date.UTC(2024, 0, 1, 6, 0, 0)),
      at100(5, Date.UTC(2024, 0, 1, 10, 0, 0)),
      at100(6, Date.UTC(2024, 0, 6, 2, 0, 0)),
      at100(7, Date.UTC(2024, 0, 7, 2, 0, 0)),
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
})

describe('hostile events', () => {
  test('a malformed assistant/message is dropped instead of taking the fold down', () => {
    const def = timelineDef({})
    const init = def.init()
    const next = def.apply(init, { type: 'assistant/message', seq: 1, time: at(), data: {} } as TimelineEvent)
    assert.equal(next, init, 'a failed event leaves the state untouched')
    const then = def.apply(next, assistantMessage(2, { turn: 1, step: 1 }))
    assert.equal(then.surface.length, 1)
    assert.equal(then.requests.length, 1)
    assertPlainJson(then)
  })

  test('null and primitive content blocks price and render as nothing', () => {
    const blocks = [null, 7, 'x', { type: 'text', text: 'hello' }] as never
    const { state } = driveTimeline([
      userMessage(1, blocks),
      toolResult(2, { callId: 'c1', content: blocks }),
      assistantMessage(3, { content: blocks }),
    ])
    assert.ok(state.sums.user > 0)
    assertPlainJson(state)
  })
})

describe('surface order parity with the harness fold', () => {
  test('every prefix keeps the canonical surface order after prune and summary replacements', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    const appendUnknown = (type: string, data: unknown): { seq: number } =>
      (session.append as unknown as (type: string, data: unknown) => { seq: number })(type, data)
    session.append('request/header', { header: { config: { model: 'deepseek-v4-flash', provider: 'deepseek' } }, reason: 'initial' } as never)
    session.append('system/message', {
      turn: 1,
      step: 0,
      message: { role: 'system', source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, content: [{ type: 'text', text: 'You are an agent.' }] },
    } as never, { surfaceOp: 'append' })
    session.append('user/message', { content: [{ type: 'text', text: 'one' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    session.append('assistant/message', {
      turn: 1,
      step: 0,
      message: { content: [{ type: 'text', text: 'reply' }] },
      usage: { inputTokens: 10, outputTokens: 5 },
    } as never, { surfaceOp: 'append' })
    session.append('tool/call', { turn: 1, step: 0, callId: 'c1', name: 'bash', arguments: '{}' } as never)
    const result = session.append('tool/result', {
      message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'ok' }] },
    } as never, { surfaceOp: 'append' })
    const two = session.append('user/message', { content: [{ type: 'text', text: 'two' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    const three = session.append('user/message', { content: [{ type: 'text', text: 'three' }], source: { kind: 'user' } } as never, { surfaceOp: 'append' })
    appendUnknown('compaction/prune', { shadowedRange: { start: result.seq, end: result.seq }, shadowedSeqs: [result.seq], shadowedTokenCount: 5 })
    session.append('tool/result', {
      message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'text', text: 'pruned' }] },
    } as never, { surfaceOp: { op: 'replace', startSeq: result.seq, endSeq: result.seq }, sourceEventSeqs: [result.seq] })
    appendUnknown('compaction/summary', {
      compactionId: 'c1',
      summary: 'summary',
      shadowedRange: { start: two.seq, end: three.seq },
      shadowedSeqs: [two.seq, three.seq],
      shadowedTokenCount: 12,
      provider: 'deepseek',
      model: 'deepseek-v4-flash',
    })
    session.append('user/message', { content: [{ type: 'text', text: 'summary' }], source: { kind: 'plugin', form: 'summary' } } as never, {
      surfaceOp: { op: 'replace', startSeq: two.seq, endSeq: three.seq },
      sourceEventSeqs: [two.seq, three.seq],
    })
    const log = session.snapshotEvents() as unknown as TimelineEvent[]
    const def = fullDef()
    for (let cut = 1; cut <= log.length; cut++) {
      const prefix = log.slice(0, cut)
      const types = new Map<number, string>(prefix.map(event => [event.seq, event.type] as const))
      let state = def.init()
      for (const event of prefix) state = def.apply(state, event)
      const canonical = foldSurface(prefix as never).nodes.filter(seq => types.get(seq) !== 'system/message')
      assert.deepStrictEqual(state.surface.map(node => node.seq), canonical, `surface order drift at prefix ${cut}`)
    }
  })
})
})

describe('fold-split', () => {

describe('the detailRev ledger', () => {
  test('bumps exactly on detail-mutating folds — never on working-slot or envelope folds — and on a real model switch', () => {
    const { def, state } = driveTimeline(canonicalLog())
    assert.equal(state.detailRev, 7)
    const workingSlot: TimelineEvent[] = [
      requestContext(13, { contextWindow: 256000 }),
      header(14, { model: 'deepseek-v4-flash', provider: 'deepseek', reason: 'change' }),
      stepStart(15),
      toolCall(16, { callId: 'c2', name: 'bash' }),
    ]
    let st = state
    for (const ev of workingSlot) st = def.apply(st, ev)
    assert.equal(st.detailRev, 7, 'no detail mutation, no bump')
    assert.notEqual(st, state)
    const switched = def.apply(state, header(13, { model: 'deepseek-v4-pro', provider: 'deepseek', reason: 'change' }))
    assert.equal(switched.detailRev, 8, 'the events collection gained a model row')
  })
})

describe('buildTimelineHead', () => {
  test('serves the counters, the headline anchor, and the revision; a fresh state zeroes them', () => {
    const fresh = buildTimelineHead(timelineDef().init())
    assert.deepEqual(fresh.counts, { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: 0 })
    assert.equal(fresh.humanInputs, 0, 'the tally defaults to zero on the wire')
    assert.equal(fresh.answers, 0, 'the answers tally defaults to zero on the wire too')
    assert.ok(!('lastUser' in fresh), 'no own key on the wire — no user message yet')
    assert.equal(fresh.last, undefined, 'no request yet — the anchor stays absent')
    assert.equal(fresh.detailRev, 0)
    assert.equal(fresh.current.total, 0)
    const { state } = driveTimeline(canonicalLog())
    const head = buildTimelineHead(state)
    assert.equal(head.ok, true)
    assert.deepEqual(
      [head.model, head.provider, head.reasoningEffort, head.contextWindow],
      ['deepseek-v4-flash', 'deepseek', 'max', 128000],
    )
    assert.ok(head.current.total > 0)
    assert.deepEqual(head.counts, { turns: 1, steps: 2, injects: 0, compactions: 1, prunes: 0, skills: 0 })
    assert.equal(head.humanInputs, 1)
    assert.equal(head.answers, 2)
    assert.equal(head.lastUser, 'hello there')
    const lastReq = state.requests.at(-1)!
    assert.deepEqual(head.last, { seq: lastReq.seq, total: lastReq.total, prompt: 20 })
    assert.equal(head.detailRev, 7)
    assert.deepEqual(head.requests, [])
    assert.deepEqual(head.events, [])
    assert.deepEqual(head.nodes, [])
    assert.equal(head.droppedNodes, 0)
    assert.deepEqual(head.archive, [])
    assertPlainJson(head)
  })

  test('the counters tally injects/prunes, a turn-less record folds as turn 0, and a usage-less anchor omits prompt', () => {
    const tallied = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      compaction(2, 'prune', { shadowedTokenCount: 3 }),
      assistantMessage(3, {}),
    ]).state
    assert.deepEqual(buildTimelineHead(tallied).counts, { turns: 1, steps: 1, injects: 1, compactions: 0, prunes: 1, skills: 0 })
    const anchorless = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hi' }], { kind: 'user' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ])
    const head = buildTimelineHead(anchorless.state)
    assert.deepEqual(head.last, { seq: 2, total: anchorless.state.requests[0].total })
    assert.ok(head.last !== undefined && !('prompt' in head.last), 'no undefined-valued prompt key')
  })

  test('the skills counter tallies DISTINCT loaded-skill names — the catalog digest never counts', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'run' }], { kind: 'skill-invocation', form: 'skill', name: 'grilling' }),
      toolCall(2, { callId: 'c1', name: 'skill' }),
      toolResult(3, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="grilling">instructions</skill_content>' }] }),
      userMessage(4, [{ type: 'text', text: 'catalog' }], { kind: 'skill-catalog', form: 'catalog' }),
      userMessage(5, [{ type: 'text', text: 'again' }], { kind: 'skill-invocation', form: 'skill', name: 'ponytail' }),
      userMessage(6, [{ type: 'text', text: 'once more' }], { kind: 'skill-invocation', form: 'skill', name: 'grilling' }),
    ])
    const head = buildTimelineHead(state)
    assert.deepEqual(head.counts, { turns: 0, steps: 0, injects: 5, compactions: 0, prunes: 0, skills: 2 })
    assertPlainJson(head)
  })

  test('skillNameOf narrows hostile messages to no name (the activity fold’s reuse)', () => {
    assert.equal(skillNameOf(null), '')
    assert.equal(skillNameOf('text'), '')
    assert.equal(skillNameOf(42), '')
    assert.equal(skillNameOf({}), '')
    assert.equal(skillNameOf({ content: [{ type: 'text', text: '<skill_content name="tdd">…' }] }), 'tdd')
  })
})

describe('buildTimelineDetail', () => {
  test('serves the revision and head, with collections detached from the fold state', () => {
    const { state, view } = driveTimeline(canonicalLog())
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.equal(detail.rev, 7)
    assert.ok(detail.head !== undefined)
    assert.deepEqual(detail.head.current, view.current)
    assertPlainJson(detail)
    assert.notEqual(detail.requests[0], state.requests[0])
    assert.notEqual(detail.archive, state.archived)
  })
})

describe('the split wire generation (definition slim flag)', () => {
  test('each generation validates on the one schema, and the inline value is exactly the head plus the detail', () => {
    const { state } = driveTimeline(canonicalLog())
    const slim = timelineDef({}, true)
    const slimView = slim.wire.view(state)
    assert.equal(slim.wire.viewSchema.safeParse(slimView).success, true, 'the slim head validates')
    assert.equal(typeof slimView.detailRev, 'number', 'the split marker is present')
    assert.ok(slimView.counts !== undefined)
    assert.deepEqual(slimView.nodes, [], 'collections stay off the wire value')
    const inline = timelineDef({}, false)
    const inlineView = inline.wire.view(state)
    assert.equal(inline.wire.viewSchema.safeParse(inlineView).success, true, 'the inline value validates on the same schema')
    assert.equal(inlineView.detailRev, undefined)
    assert.ok(inlineView.nodes.length > 0)
    assert.ok(inlineView.requests.length > 0)
    const head = buildTimelineHead(state)
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.deepEqual(inlineView.counts, head.counts, 'the inline value carries the full-session counters')
    const { last: _last, detailRev: _rev, ...headScalars } = head
    const { rev: _detailRev, head: _detailHead, ...collections } = detail
    assert.deepEqual(inlineView, { ...headScalars, ...collections })
  })
})
})

describe('fold-developer', () => {

const changes = [
  { type: 'tool-addition', toolName: 'read_file' },
  { type: 'tool-removal', toolName: 'shell' },
]

function developerMessage(seq: number, options: {
  content?: unknown
  source?: unknown
  surfaceOp?: unknown
} = {}): TimelineEvent {
  return {
    type: 'developer/message', seq, time: at(), surfaceOp: options.surfaceOp ?? 'append',
    data: {
      turn: 1, step: 1, headerSeq: 0,
      message: {
        role: 'developer',
        source: options.source ?? { kind: 'tool-registry' },
        content: options.content ?? changes,
      },
    },
  }
}

describe('developer/message', () => {
  test('tool-registry changes enter the surface, request composition and served detail', () => {
    const result = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hello' }]),
      developerMessage(2),
      assistantMessage(3, { turn: 1, step: 1 }),
    ])
    const node = result.state.surface.find(n => n.seq === 2)
    assert.ok(node, 'the model-visible registry change must not disappear')
    assert.equal(node.cat, 'inject')
    assert.equal(node.tokens, 35)
    assert.equal(node.name, 'tool-registry')
    assert.equal(result.state.humanInputs, 1)
    assert.equal(requestsOf(result.state)[0].inject, 35)
    assert.equal(result.state.sums.inject, 35)
    assert.equal(result.view.nodes.some(n => n.seq === 2 && n.tokens === 35), true)
    assert.equal(result.state.events.find(e => e.seq === 2)?.kind, 'inject')
    assertStatesPlainJson(result)
    result.def.stateSchema.parse(result.state)
    result.def.wire.viewSchema.parse(result.view)
  })

  test('compaction removes and archives registry nodes with the rest of the claimed surface', () => {
    const result = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hello' }]),
      developerMessage(2),
      assistantMessage(3, { turn: 1, step: 1 }),
      compaction(4, 'summary', { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 55 }),
      userMessage(5, [{ type: 'text', text: 'summary' }], { kind: 'plugin', form: 'summary' }, {
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 3 },
      }),
      assistantMessage(6, { turn: 2, step: 1 }),
    ])
    assert.equal(result.state.surface.some(n => n.seq === 2), false)
    const archived = result.state.archived.find(n => n.seq === 2)
    assert.equal(archived?.tokens, 35)
    assert.equal(archived?.gone, 5)
    assert.equal(requestsOf(result.state)[0].inject, 35)
    assert.equal(requestsOf(result.state)[1].inject, 10)
    assertStatesPlainJson(result)
  })

  test('a developer replacement archives the replaced injection and bumps the detail revision', () => {
    const result = driveTimeline([
      developerMessage(1),
      developerMessage(2, {
        content: [{ type: 'tool-removal', toolName: 'read_file' }],
        surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      }),
    ])
    assert.deepEqual(result.state.surface.map(n => n.seq), [2])
    assert.equal(result.state.archived[0].seq, 1)
    assert.equal(result.state.archived[0].gone, 2)
    assert.equal(result.state.sums.inject, result.state.surface[0].tokens)
    assert.equal(result.state.detailRev, 2)
    assert.equal(result.state.humanInputs, undefined)
    assertStatesPlainJson(result)
  })

  test('empty content keeps its surface position without adding model tokens', () => {
    const result = driveTimeline([developerMessage(1, { content: [] })])
    assert.equal(result.state.surface[0].seq, 1)
    assert.equal(result.state.surface[0].tokens, 0)
    assert.equal(result.state.sums.inject, 0)
    assert.equal(result.state.events[0].tokens, 0)
  })

  test('no developer source, whatever its shape, ever counts as a human input', () => {
    for (const source of [undefined, null, {}, { kind: 'user' }]) {
      const event = developerMessage(1)
      const message = event.data!.message as Record<string, unknown>
      if (source === undefined) delete message.source
      else message.source = source
      const result = driveTimeline([event])
      assert.equal(result.state.surface[0].cat, 'inject', JSON.stringify(source))
      assert.equal(result.state.sums.inject, 35)
      assert.equal(result.state.humanInputs, undefined)
      assert.equal(result.state.events[0].kind, 'inject')
      assertStatesPlainJson(result)
    }
  })

  test('a malformed nested message leaves the state unchanged', () => {
    for (const data of [undefined, {}, { message: null }, { message: { content: 'invalid' } }]) {
      const def = timelineDef()
      const initial = def.init()
      const event: TimelineEvent = { type: 'developer/message', seq: 1, time: at(), ...(data === undefined ? {} : { data }) }
      assert.equal(def.apply(initial, event), initial, JSON.stringify(data))
      def.stateSchema.parse(initial)
    }
  })
})
})
