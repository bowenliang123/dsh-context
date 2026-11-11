import assert from 'node:assert/strict'
import { describe, test, afterEach, vi } from 'vitest'
import { type TimelineEvent, createTimelineState } from '../../src/host/fold'
import { assistantMessage, at, compaction, toolCall, toolResult, userMessage, header, planMode, requestContext } from './helpers/events'
import { assertPlainJson, driveTimeline, fullDef, timelineDef } from './helpers/projection'
import { buildTimelineDetail } from '../../src/host/foldWire'
import { resolveBounds } from '../../src/host/config'
import { type CostBucketTotals, type SessionCostUsage, type SurfaceNode } from '../../src/shared/types'
import { makeFoldCache, type FoldCacheOptions } from '../../src/host/foldCache'
import { fakeCtx } from './helpers/ctx'
import { makeFoldJournal } from '../../src/host/foldJournal'
import { Context } from '@deepseek-ai/cordis'
import { type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { createFoldPool, startFoldWorkerChannel } from '../../src/host/foldWorker'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { createContextTimelineDefinition } from '../../src/host/timeline'
import { createContextActivityDefinition } from '../../src/host/activity'
import { foldInProcess, inProcessPool } from './helpers/foldWorker'

describe('fold-surface', () => {

const text = (t: string) => [{ type: 'text', text: t }]

describe('applySurface assistant branch', () => {
  test('assistant text lands on the node preview; a text-less message lists its tool-call names capped at three, or neither', () => {
    const spoken = driveTimeline([assistantMessage(1, { content: text('hello world') })]).state.surface.at(-1)
    assert.equal(spoken?.text, 'hello world')
    assert.equal(spoken?.cat, 'assistant')
    const named = driveTimeline([assistantMessage(1, {
      content: [
        { type: 'tool-call', name: 'bash', arguments: '{}' },
        { type: 'tool-call', name: 'read', arguments: '{}' },
        { type: 'tool-call', name: 'edit', arguments: '{}' },
        { type: 'tool-call', name: 'grep', arguments: '{}' },
      ],
    })]).state.surface.at(-1)
    assert.equal(named?.text, undefined)
    assert.deepEqual(named?.calls, ['bash', 'read', 'edit'])
    const unnamed = driveTimeline([assistantMessage(1, { content: [{ type: 'tool-call', arguments: '{}' }] })]).state.surface.at(-1)
    assert.equal(unnamed?.text, undefined)
    assert.equal(unnamed?.calls, undefined)
  })
})

describe('assistant reasoning accounting', () => {
  const reasoning = (t: string) => ({ type: 'reasoning', text: t })

  test('a node prices its reasoning blocks as a live subset, and the whole message as the generated tally', () => {
    const drive = driveTimeline([assistantMessage(1, {
      content: [reasoning('think'), ...text('reply')],
    })])
    const node = drive.state.surface.at(-1)
    assert.deepEqual([node?.tokens, node?.reasoning], [16, 6])
    assert.equal(drive.state.sums.assistant, 16)
    assert.equal(drive.state.assistantReasoning, 6)
    assert.equal(drive.state.generatedReasoning, 6)
    assert.equal(drive.view.current.assistantReasoning, 6)
    assert.equal(drive.view.generatedReasoning, 6)
    assert.equal(drive.def.wire.viewSchema.safeParse(drive.view).success, true)
  })

  test('a replacement drops the live price but keeps the generated tally; a reasoning-less log stays absent', () => {
    const drive = driveTimeline([
      assistantMessage(1, { content: [reasoning('think')] }),
      compaction(2, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [1] }),
      assistantMessage(3, { content: [reasoning('more')], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.equal(drive.state.assistantReasoning, 5, "'more' is 4 chars: ceil(4/4) + 4")
    assert.equal(drive.state.generatedReasoning, 11, 'the shadowed message was still generated')
    assert.equal(drive.state.archived[0]?.reasoning, 6)
    assert.deepEqual([drive.view.current.assistant, drive.view.current.assistantReasoning], [9, 5])
    const plain = driveTimeline([assistantMessage(1, { content: text('reply') })])
    assert.deepEqual([plain.view.current.assistantReasoning, plain.view.generatedReasoning], [0, undefined])
    assert.ok(!('generatedReasoning' in plain.view))
  })

  test("a provider reasoning count wins over the estimate, clamps to output, and survives without an output bucket; an unreadable count falls back", () => {
    const generated = (usage: Record<string, unknown>): number | undefined =>
      driveTimeline([assistantMessage(1, { content: [reasoning('think')], usage })]).state.generatedReasoning
    assert.equal(generated({ inputTokens: 1, outputTokens: 3, reasoningTokens: 2 }), 2)
    assert.equal(generated({ inputTokens: 1, outputTokens: 3, reasoningTokens: 9 }), 3)
    assert.equal(generated({ reasoningTokens: 2 }), 2)
    assert.equal(generated({ inputTokens: 1, outputTokens: 3, reasoningTokens: 'x' }), 6, 'the estimate stands in')
    assert.equal(generated({ inputTokens: 1, outputTokens: 3, reasoningTokens: -1 }), undefined, 'a zero provider count stays zero')
  })
})

describe('applySurface tool/result branch', () => {
  test('a source callId armed by tool/call names the node, is consumed, and leaves other pending calls armed', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolCall(2, { callId: 'c2', name: 'read' }),
      toolResult(3, { callId: 'c1', content: text('ok') }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.tool, 'bash')
    assert.equal(node?.err, undefined, 'no error flag without the message mark')
    assert.deepEqual(Object.keys(state.callNames), ['c2'], 'the consumed entry leaves the persisted map')
    assert.equal(state.callNames.c2?.name, 'read', 'the unanswered call stays armed')
  })

  test('an untraced result with an unknown or missing source callId pairs nothing and leaves callNames untouched', () => {
    const unknown = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })]).state
    assert.equal(unknown.surface.at(-1)?.tool, undefined)
    assert.deepEqual(unknown.callNames, {})
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: { message: { role: 'tool', toolCallId: 'keep', content: text('ok') } },
      surfaceOp: 'append',
    }
    const sourceless = driveTimeline([toolCall(1, { callId: 'keep', name: 'read' }), ev]).state
    assert.equal(sourceless.surface.at(-1)?.tool, undefined)
    assert.equal(sourceless.callNames.keep?.name, 'read')
  })

  test('the message isError flags the node; the retired envelope-only mark no longer does', () => {
    const flagged = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: text('boom'), error: true }),
    ]).state.surface.at(-1)
    assert.deepEqual([flagged?.err, flagged?.tool], [true, 'bash'], 'the message mark flags while the source callId still pairs')
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: {
        error: true,
        message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: text('boom') },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' }), ev])
    assert.deepEqual([state.surface.at(-1)?.err, state.surface.at(-1)?.tool], [undefined, 'bash'])
  })
})

describe('applySurface user-message previews', () => {
  test('skill sources carry the skill name, or ? when nameless; the catalog joins the bucket unnamed', () => {
    const named = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation', name: 'pdf' })]).state
    assert.equal(named.surface.at(-1)?.skill, 'pdf')
    assert.equal(named.surface.at(-1)?.cat, 'skill')
    const nameless = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation' })]).state
    assert.equal(nameless.surface.at(-1)?.skill, '?')
    const catalog = driveTimeline([userMessage(1, text('<available_skills>'), { kind: 'skill-catalog', form: 'catalog' })]).state
    assert.equal(catalog.surface.at(-1)?.cat, 'skill')
    assert.equal(catalog.surface.at(-1)?.skill, undefined)
    assert.equal(catalog.surface.at(-1)?.form, 'catalog')
  })

  test('plugin notice sources preview the summary; snapshots join section names, skipping nulls, truncated to 80', () => {
    const notice = driveTimeline([
      userMessage(1, text('injected'), { kind: 'plugin', form: 'notice', plugin: 'dsh-x', summary: 'Skill injected (pdf)' }),
    ]).state.surface.at(-1)
    assert.equal(notice?.text, 'Skill injected (pdf)')
    assert.equal(notice?.form, 'notice')
    const sections = [{ name: 'a'.repeat(50) }, null, { name: 'b'.repeat(50) }, {}]
    const snapshot = driveTimeline([
      userMessage(1, text('snapshot'), { kind: 'plugin', form: 'snapshot', sections }),
    ]).state.surface.at(-1)
    const expected = `${'a'.repeat(50)}, ${'b'.repeat(50)}`.slice(0, 80)
    assert.equal(expected.length, 80, 'fixture must actually exceed the truncation bound')
    assert.equal(snapshot?.text, expected)
  })

  test('other plugin forms preview the first text, or nothing without one', () => {
    const withText = driveTimeline([
      userMessage(1, text('plain body'), { kind: 'plugin', form: 'instructions' }),
    ]).state
    assert.equal(withText.surface.at(-1)?.text, 'plain body')
    const empty = driveTimeline([userMessage(1, [], { kind: 'plugin', form: 'instructions' })]).state
    assert.equal(empty.surface.at(-1)?.text, undefined)
  })

  test('a plain user message previews its text and image count, or nothing without text', () => {
    const withText = driveTimeline([userMessage(1, text('hi there'))]).state
    const node = withText.surface.at(-1)
    assert.equal(node?.text, 'hi there')
    assert.equal(node?.cat, 'user')
    assert.equal(node?.form, undefined, 'no source, no form stamp')
    const empty = driveTimeline([userMessage(1, [])]).state
    assert.equal(empty.surface.at(-1)?.text, undefined)
    const image = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
    ]).state.surface.at(-1)
    assert.equal(image?.imgs, 1)
  })
})

describe('shadow-price claim lifecycle', () => {
  test('the next surface event consumes and DELETES the armed claim', () => {
    const { state } = driveTimeline([
      compaction(1, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [1] }),
      userMessage(2, text('after')),
    ])
    assert.ok(!('pendingShadowedSeqs' in state), 'consumed claims are deleted, not undefined-valued')
    assert.ok(!('pendingShadowEventSeq' in state))
    assertPlainJson(state)
  })
})

describe('surfaceOp variants', () => {
  const big = 'a'.repeat(16)

  test('a null, non-object, or non-replace surfaceOp appends', () => {
    for (const surfaceOp of [null, 'append', undefined, { op: 'insert', startSeq: 0, endSeq: 0 }]) {
      const ev: TimelineEvent = { type: 'user/message', seq: 1, time: at(), data: { content: text('x') }, surfaceOp }
      const { state } = driveTimeline([ev])
      assert.deepEqual(state.surface.map(n => n.seq), [1], JSON.stringify(surfaceOp))
    }
  })

  test('a replace with an armed claim removes by seqs, inserts at the replaced position, and rewrites the metering event net-freed, clamped at zero', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)),
      userMessage(2, text(big)),
      userMessage(3, text(big)),
      compaction(4, 'summary', { shadowedTokenCount: 100, shadowedSeqs: [1, 2] }),
      userMessage(5, text('bbbbbbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(
      [state.surface.map(n => n.seq), state.sums.user, state.archived.map(n => [n.seq, n.gone]), state.events[0].tokens],
      [[5, 3], 22, [[1, 5], [2, 5]], 14],
      'removed nodes archived as stamped copies, the replacement lands at the replaced position, the metering row rewritten net-freed',
    )
    assertPlainJson(state)
    const clamped = driveTimeline([
      userMessage(1, text(big)),
      compaction(2, 'prune', { shadowedTokenCount: 12, shadowedSeqs: [1] }),
      userMessage(3, text('x'.repeat(400)), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ]).state
    assert.equal(clamped.events[0].tokens, 0)
    assert.equal(clamped.sums.user, 108)
  })

  test('the range path splices in place and never rewrites the metering event; missing endpoints append', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb')),
      compaction(3, 'summary', { shadowedTokenCount: 50, shadowedSeqs: [] }),
      userMessage(4, text('cccc'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [4], 'range replace splices the node in place')
    assert.equal(state.sums.user, 9)
    assert.deepEqual(state.archived.map(n => n.seq), [1, 2])
    assert.equal(state.events[0].tokens, 50, 'the range path never rewrites the metering event')
    assert.ok(!('pendingShadowedSeqs' in state))
    const single = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb')),
      userMessage(3, text('cccc')),
      userMessage(4, text('dddddddd'), undefined, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
    ]).state
    assert.deepEqual(single.surface.map(n => n.seq), [1, 4, 3])
    assert.deepEqual(single.archived.map(n => [n.seq, n.gone]), [[2, 4]])
    for (const surfaceOp of [{ op: 'replace', startSeq: 99, endSeq: 100 }, { op: 'replace', startSeq: 1, endSeq: 99 }]) {
      const missing = driveTimeline([
        userMessage(1, text('aaaa')),
        userMessage(2, text('bbbb'), undefined, { surfaceOp }),
      ]).state
      assert.deepEqual(missing.surface.map(n => n.seq), [1, 2], JSON.stringify(surfaceOp))
    }
  })

  test('an armed claim whose seqs are absent from the surface appends the replacement', () => {
    const def = fullDef({})
    const base = driveTimeline([userMessage(1, text('aaaa'))]).state
    const applied = def.apply(
      { ...base, pendingShadowedSeqs: [99], pendingShadowEventSeq: 99 },
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    )
    assert.deepEqual(applied.surface.map(n => n.seq), [1, 2])
    assert.deepEqual(applied.archived, [])
    assert.equal(applied.events.length, 0)
  })

  test('restored state: a claim whose metering event cannot be rewritten skips the rewrite', () => {
    const def = fullDef({})
    const base = driveTimeline([userMessage(1, text(big))]).state
    const withoutSeq = def.apply(
      { ...base, pendingShadowedSeqs: [1] },
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    )
    assert.deepEqual(withoutSeq.surface.map(n => n.seq), [2])
    assert.equal(withoutSeq.archived.length, 1)
    assert.equal(withoutSeq.events.length, 0, 'no event to rewrite, no crash')
    assert.ok(!('pendingShadowedSeqs' in withoutSeq))
    assertPlainJson(withoutSeq)
    const missingEvent = def.apply(
      { ...base, pendingShadowedSeqs: [1], pendingShadowEventSeq: 999 },
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    )
    assert.deepEqual(missingEvent.surface.map(n => n.seq), [2])
    assert.equal(missingEvent.events.length, 0)
    assert.ok(!('pendingShadowEventSeq' in missingEvent))
  })
})

describe('assistant content subsets', () => {
  const reasoning = (t: string) => ({ type: 'reasoning', text: t })

  test('a node prices its text blocks as a live subset and the whole text as the generated tally', () => {
    const drive = driveTimeline([assistantMessage(1, {
      content: [...text('reply'), reasoning('think'), { type: 'tool-call', name: 'bash', arguments: '{}' }],
    })])
    const node = drive.state.surface.at(-1)
    assert.deepEqual([node?.tokens, node?.answerTokens, node?.reasoning, node?.callTokens], [22, 6, 6, 6])
    assert.equal(drive.state.assistantAnswerTokens, 6)
    assert.equal(drive.state.assistantCallTokens, 6)
    assert.equal(drive.state.generatedAnswerTokens, 6)
    assert.equal(drive.state.generatedCallTokens, 6)
    assert.equal(drive.view.current.assistantAnswerTokens, 6)
    assert.equal(drive.view.current.assistantCallTokens, 6)
    assert.equal(drive.view.generatedAnswerTokens, 6)
    assert.equal(drive.view.generatedCallTokens, 6)
    assert.equal(drive.def.wire.viewSchema.safeParse(drive.view).success, true)
  })

  test('a replacement drops the live price but keeps the generated tally; a text-less log stays absent', () => {
    const drive = driveTimeline([
      assistantMessage(1, { content: text('hello') }),
      compaction(2, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [1] }),
      assistantMessage(3, { content: text('more'), surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.equal(drive.state.assistantAnswerTokens, 5, "'more' is 4 chars: ceil(4/4) + 4")
    assert.equal(drive.state.generatedAnswerTokens, 11, 'the shadowed message was still generated')
    assert.equal(drive.state.archived[0]?.answerTokens, 6)
    assert.deepEqual([drive.view.current.assistant, drive.view.current.assistantAnswerTokens], [9, 5])
    const toolOnly = driveTimeline([assistantMessage(1, { content: [{ type: 'tool-call', name: 'bash', arguments: '{}' }] })])
    assert.deepEqual([toolOnly.view.current.assistantAnswerTokens, toolOnly.view.generatedAnswerTokens], [0, undefined])
    assert.ok(!('generatedAnswerTokens' in toolOnly.view))
  })

  test('a replacement drops the live tool-call price but keeps the generated tally', () => {
    const call = (name: string) => ({ type: 'tool-call', name, arguments: '{}' })
    const drive = driveTimeline([
      assistantMessage(1, { content: [call('bash')] }),
      compaction(2, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [1] }),
      assistantMessage(3, { content: [call('ls')], surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    assert.equal(drive.state.assistantCallTokens, 6)
    assert.equal(drive.state.generatedCallTokens, 12, 'the shadowed message was still generated')
    assert.equal(drive.state.archived[0]?.callTokens, 6)
    assert.deepEqual([drive.view.current.assistant, drive.view.current.assistantCallTokens], [10, 6])
    const plain = driveTimeline([assistantMessage(1, { content: text('reply') })])
    assert.deepEqual([plain.view.current.assistantCallTokens, plain.view.generatedCallTokens], [0, undefined])
    assert.ok(!('generatedCallTokens' in plain.view))
  })
})
})

describe('fold-view', () => {

type ContentBlocks = { type: 'text'; text: string }[]

function text(content: string): ContentBlocks {
  return [{ type: 'text', text: content }]
}

const bucket = (uncached: number, cacheRead: number, cacheWrite: number, output: number): CostBucketTotals =>
  ({ uncached, cacheRead, cacheWrite, output })

describe('buildTimelineDetail on a fresh state', () => {
  test('an absent detailRev reads as rev 0 and the collections stay empty', () => {
    const detail = buildTimelineDetail(createTimelineState(), resolveBounds({}))
    assert.equal(detail.rev, 0)
    assert.deepEqual(detail.requests, [])
    assert.deepEqual(detail.nodes, [])
    assert.equal(detail.head?.humanInputs, 0)
  })

  test('a slim state serves the detailCollections filter honestly', () => {
    const def = fullDef({}, false)
    let state = def.init()
    state = def.apply(state, header(1, { model: 'm' }))
    state = def.apply(state, userMessage(2, text('hi'), { kind: 'user' }))
    const detail = buildTimelineDetail(state, resolveBounds({}))
    assert.deepEqual(detail.requests, [], 'slim request records never pose as full ones')
    assert.ok(detail.nodes.length > 0, 'the slim surface index still serves')
  })

})

describe('buildTimelineView unknown-model shape', () => {
  test('optional scalars stay ABSENT keys until known, then ride their own keys (issue #29)', () => {
    const unknown = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      assistantMessage(2, { turn: 1, step: 1 }),
    ]).view
    assert.equal(unknown.ok, true)
    assert.ok(!('model' in unknown), 'no own `model` key')
    assert.ok(!('provider' in unknown), 'no own `provider` key')
    assert.ok(!('reasoningEffort' in unknown), 'no own `reasoningEffort` key')
    assert.ok(!('contextWindow' in unknown), 'no own `contextWindow` key')
    assert.ok(!('maxOutputTokens' in unknown), 'no own `maxOutputTokens` key')
    assertPlainJson(unknown)
    const known = driveTimeline([
      header(1, { config: { model: 'deepseek-v4-flash', provider: 'deepseek', reasoningEffort: 'max', maxTokens: 256000 } }),
      requestContext(2, { provider: 'deepseek', model: 'deepseek-v4-flash', contextWindow: 128000 }),
      userMessage(3, [{ type: 'text', text: 'hi' }]),
    ]).view
    assert.equal(known.ok, true)
    assert.equal(known.model, 'deepseek-v4-flash')
    assert.equal(known.provider, 'deepseek')
    assert.equal(known.reasoningEffort, 'max')
    assert.equal(known.contextWindow, 128000)
    assert.equal(known.maxOutputTokens, 256000)
    assertPlainJson(known)
  })

  test('the reasoning effort and output cap are LAST-WINS across headers; hostile values clear them', () => {
    const cleared = driveTimeline([
      header(1, { config: { model: 'm', reasoningEffort: 'max', maxTokens: 256000 } }),
      header(2, { config: { model: 'm' }, reason: 'change' }),
    ]).view
    assert.equal(cleared.reasoningEffort, undefined)
    assert.equal(cleared.maxOutputTokens, undefined, 'a cap-less header clears it (dsh reserves zero, not the old envelope)')
    for (const effort of ['', 42, null, false] as const) {
      const { view } = driveTimeline([header(1, { config: { model: 'm', reasoningEffort: effort } })])
      assert.equal(view.reasoningEffort, undefined, String(effort))
    }
    for (const maxTokens of ['256000', -1, 0, Number.NaN, Number.POSITIVE_INFINITY, null] as const) {
      const { view } = driveTimeline([header(1, { config: { model: 'm', provider: 'p', maxTokens } })])
      assert.equal(view.maxOutputTokens, undefined, String(maxTokens))
    }
    const kept = driveTimeline([
      header(1, { config: { model: 'm', provider: 'p', reasoningEffort: 'low', maxTokens: 8000 } }),
      header(2, { config: { model: 'm', provider: 'p', reasoningEffort: 'max', maxTokens: 256000 }, reason: 'change' }),
    ]).view
    assert.equal(kept.reasoningEffort, 'max')
    assert.equal(kept.maxOutputTokens, 256000)
  })
})

describe('buildTimelineView counters', () => {
  test('images and toolCalls sum live surface nodes, absent counts as zero', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
      userMessage(2, [{ type: 'text', text: 'no image here' }]),
      toolCall(3, { callId: 'c1', name: 'bash' }),
      toolResult(4, { callId: 'c1', content: [{ type: 'text', text: 'ok' }] }),
    ])
    assert.equal(view.images, 1)
    assert.equal(view.toolCalls, 1)
  })

  test('humanInputs tallies the user\'s own messages and answered questions, other tool results excluded', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'hello' }], { kind: 'user' }),
      userMessage(2, [{ type: 'text', text: 'again' }]),
      userMessage(3, [{ type: 'text', text: 'AGENTS.md' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(4, [{ type: 'text', text: '/skill' }], { kind: 'skill-invocation', name: 's' }),
      userMessage(5, [{ type: 'image', attachment: { width: 8, height: 8 } }], { kind: 'user' }),
      toolCall(6, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(7, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["x"]}]}' }] }),
      toolCall(8, { callId: 'b1', name: 'bash' }),
      toolResult(9, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }),
      toolCall(10, { callId: 'q2', name: 'ask_user_question' }),
      toolResult(11, { callId: 'q2', content: [{ type: 'text', text: '{"answers":[{"id":"b","selected":["y"]}]}' }] }),
    ])
    assert.equal(view.humanInputs, 5)
    const standalone = driveTimeline([
      toolCall(1, { callId: 'q1', name: 'ask_user_question' }),
      toolResult(2, { callId: 'q1', content: [{ type: 'text', text: '{"answers":[{"id":"a","selected":["y"]}]}' }] }),
    ]).view
    assert.equal(standalone.humanInputs, 1)
  })

  test('humanInputs stays ABSENT until the first human input — never undefined-valued', () => {
    const { state, view } = driveTimeline([
      toolCall(1, { callId: 'b1', name: 'bash' }),
      toolResult(2, { callId: 'b1', content: [{ type: 'text', text: 'ok' }] }),
      planMode(3, { active: true }),
    ])
    assert.equal(view.humanInputs, 0)
    assert.ok(!('humanInputs' in state), 'no own key on the persisted state')
    assertPlainJson(state)
  })
})

describe('buildTimelineView lastUser preview', () => {
  test('the newest own message rides the view, whitespace collapsed and bounded; injections and text-less inputs leave it alone', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: '  hello   world  ' }]),
      userMessage(2, [{ type: 'text', text: 'AGENTS.md' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(3, [{ type: 'text', text: '/skill' }], { kind: 'skill-invocation', name: 's' }),
      userMessage(4, [{ type: 'image', attachment: { width: 8, height: 8 } }]),
    ])
    assert.equal(view.lastUser, 'hello world')
    const newer = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'first' }]),
      userMessage(2, [{ type: 'text', text: 'second' }]),
    ])
    assert.equal(newer.state.lastUser, 'second')
    assert.equal(newer.view.lastUser, 'second')
    assertPlainJson(newer.state)
    const long = driveTimeline([userMessage(1, [{ type: 'text', text: 'x'.repeat(500) }])]).view
    assert.equal(long.lastUser?.length, 80)
  })

  test('stays ABSENT before any textual user message — never undefined-valued', () => {
    const { state, view } = driveTimeline([
      toolCall(1, { callId: 'b1', name: 'bash' }),
      userMessage(2, [{ type: 'image', attachment: { width: 8, height: 8 } }]),
    ])
    assert.ok(!('lastUser' in view), 'no own key on the view')
    assert.ok(!('lastUser' in state), 'no own key on the persisted state')
    assertPlainJson(view)
  })
})

describe('buildTimelineView copies', () => {
  test('the view is detached from state; repeated views are deep-equal but distinct, and state is untouched', () => {
    const { def, state } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'aaaa' }]),
      planMode(2, { active: true }),
      assistantMessage(3, { turn: 1, step: 1 }),
      userMessage(4, [{ type: 'text', text: 'b' }], undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
    ])
    const before = assertPlainJson(state)
    const v1 = def.wire.view(state)
    const v2 = def.wire.view(state)
    assert.ok(v1 !== v2 && v1.nodes !== v2.nodes && v1.requests !== v2.requests)
    assert.deepEqual(v1, v2)
    assert.notEqual(v1.requests[0], state.requests[0])
    assert.deepEqual(v1.requests[0], state.requests[0])
    assert.notEqual(v1.events[0], state.events[0])
    assert.equal(v1.archive.length, 1)
    assert.notEqual(v1.archive[0], state.archived[0])
    assert.deepEqual(v1.archive[0], state.archived[0])
    v1.requests[0].total = -1
    v1.events[0].name = 'mutated'
    v1.archive[0].tokens = -1
    assert.notEqual(state.requests[0].total, -1)
    assert.notEqual(state.events[0].name, 'mutated')
    assert.notEqual(state.archived[0].tokens, -1)
    assert.deepEqual(assertPlainJson(state), before, 'view() must not mutate the persisted state')
  })
})

describe('buildTimelineView cost copy', () => {
  test('every provider, model, and period branch copies through; no cost omits the field', () => {
    const st = createTimelineState()
    st.cost = {
      'deepseek-official': {
        'deepseek-v4-flash': { peak: bucket(1, 0, 0, 2) },
        'deepseek-v4-pro': { peak: bucket(3, 0, 0, 4), off: bucket(5, 0, 6, 0) },
      },
      'kimi-coding': { 'kimi-k2.7-code': { peak: bucket(7, 8, 0, 9) } },
      '': { 'mystery-model': { peak: bucket(8, 0, 9, 10) } },
    }
    const view = timelineDef({}).wire.view(st)
    assert.deepEqual<SessionCostUsage | undefined>(view.cost, st.cost)
    assert.notEqual(view.cost?.['deepseek-official'], st.cost['deepseek-official'])
    assert.notEqual(view.cost?.['deepseek-official']?.['deepseek-v4-flash']?.peak, st.cost['deepseek-official']['deepseek-v4-flash'].peak)
    assert.notEqual(view.cost?.['deepseek-official']?.['deepseek-v4-pro']?.off, st.cost['deepseek-official']['deepseek-v4-pro'].off)
    assert.notEqual(view.cost?.['kimi-coding']?.['kimi-k2.7-code']?.peak, st.cost['kimi-coding']['kimi-k2.7-code'].peak)
    assert.notEqual(view.cost?.['']?.['mystery-model']?.peak, st.cost['']['mystery-model'].peak)
    assert.equal('cost' in timelineDef({}).wire.view(createTimelineState()), false)
  })
})

describe('buildTimelineView serving window', () => {
  test('overflow drops the oldest non-inject nodes and floors the newest dropped seq', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'injected' }], { kind: 'plugin', form: 'context', plugin: 'dsh-test' }),
      userMessage(2, [{ type: 'text', text: 'x1' }]),
      userMessage(3, [{ type: 'text', text: 'x2' }]),
      userMessage(4, [{ type: 'text', text: 'x3' }]),
      userMessage(5, [{ type: 'text', text: 'x4' }]),
    ], { maxNodes: 2 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 4, 5], 'the out-of-window inject is pinned ahead of the tail')
    assert.equal(view.droppedNodes, 2, 'pinned injects are not counted as dropped')
    assert.equal(view.surfaceFloor, 3, 'the floor is the newest unserved non-inject seq')
  })

  test('without overflow the served nodes are a plain tail copy; no floors ride, and an existing archiveFloor passes through', () => {
    const { state, view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'a' }]),
      userMessage(2, [{ type: 'text', text: 'b' }]),
    ], { maxNodes: 4 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 2])
    assert.notEqual(view.nodes, state.surface, 'the served slice never aliases the surface')
    assert.equal(view.droppedNodes, 0)
    assert.equal('surfaceFloor' in view, false)
    assert.equal('archiveFloor' in view, false)
    const archived = createTimelineState()
    archived.archiveFloor = 7
    assert.equal(timelineDef({}).wire.view(archived).archiveFloor, 7)
  })

  test('an overflow made only of injects drops nothing and sets no floor', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'i1' }], { kind: 'plugin', form: 'context', plugin: 'p1' }),
      userMessage(2, [{ type: 'text', text: 'i2' }], { kind: 'goal' }),
    ], { maxNodes: 1 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 2], 'every inject is pinned')
    assert.equal(view.droppedNodes, 0)
    assert.equal('surfaceFloor' in view, false)
  })

  test('skill nodes pin like injects when the window overflows (issue #66)', () => {
    const { view } = driveTimeline([
      userMessage(1, [{ type: 'text', text: '<available_skills>' }], { kind: 'skill-catalog', form: 'catalog' }),
      userMessage(2, [{ type: 'text', text: 'x1' }]),
      userMessage(3, [{ type: 'text', text: 'x2' }]),
      toolCall(4, { callId: 'c1', name: 'skill' }),
      toolResult(5, { callId: 'c1', content: [{ type: 'text', text: '<skill_content name="pdf">body</skill_content>' }] }),
    ], { maxNodes: 2 })
    assert.deepEqual((view.nodes as SurfaceNode[]).map(n => n.seq), [1, 3, 5])
    assert.equal(view.droppedNodes, 1)
    assert.equal(view.surfaceFloor, 2, 'the floor is the newest unserved non-skill seq')
  })
})

describe('buildTimelineView event attribution', () => {
  test('an event before the first or after the last request takes only the available side; between two requests, both', () => {
    const before = driveTimeline([
      userMessage(1, [{ type: 'text', text: 'ctx' }], { kind: 'plugin', form: 'notice', plugin: 'p', summary: 'hi' }),
      assistantMessage(2, { turn: 1, step: 1 }),
    ]).view.events[0]
    assert.equal(before.kind, 'inject')
    assert.equal(before.turn, 1)
    assert.equal(before.step, 1)
    assert.equal(before.fromTurn, undefined)
    assert.equal(before.fromStep, undefined)
    const after = driveTimeline([
      assistantMessage(1, { turn: 1, step: 1 }),
      planMode(2, { active: false }),
    ]).view.events[0]
    assert.equal(after.turn, undefined)
    assert.equal(after.step, undefined)
    assert.equal(after.fromTurn, 1)
    assert.equal(after.fromStep, 1)
    for (const [nextTurn, nextStep, fromTurn, fromStep] of [
      [1, 2, 1, 1],
      [2, 1, 1, 1],
    ] as const) {
      const { view } = driveTimeline([
        assistantMessage(1, { turn: 1, step: 1 }),
        planMode(2, { active: true }),
        assistantMessage(3, { turn: nextTurn, step: nextStep }),
      ])
      const ev = view.events[0]
      assert.equal(ev.turn, nextTurn, `next turn ${nextTurn}`)
      assert.equal(ev.step, nextStep)
      assert.equal(ev.fromTurn, fromTurn)
      assert.equal(ev.fromStep, fromStep)
    }
  })

  test('an event with no requests, or an incomplete next request, takes no side', () => {
    const { view } = driveTimeline([planMode(1, { active: true })])
    const ev = view.events[0]
    assert.equal(ev.turn, undefined)
    assert.equal(ev.fromTurn, undefined)
    for (const next of [{}, { turn: 3 }]) {
      const none = driveTimeline([planMode(1, { active: true }), assistantMessage(2, next)]).view.events[0]
      assert.equal(none.turn, undefined, JSON.stringify(next))
      assert.equal(none.step, undefined)
    }
  })

  test('a previous request without a complete turn/step pair stamps no from-side', () => {
    for (const previous of [{}, { turn: 7 }]) {
      const { view } = driveTimeline([
        assistantMessage(1, previous),
        planMode(2, { active: true }),
        assistantMessage(3, { turn: 8, step: 1 }),
      ])
      const ev = view.events[0]
      assert.equal(ev.fromTurn, undefined, JSON.stringify(previous))
      assert.equal(ev.fromStep, undefined)
      assert.equal(ev.turn, 8)
      assert.equal(ev.step, 1)
    }
  })
})
})

describe('foldCache', () => {

afterEach(() => {
  vi.useRealTimers()
})

function cacheOf<V>(options: FoldCacheOptions<V>): ReturnType<typeof makeFoldCache<V>> {
  return makeFoldCache(fakeCtx({}).ctx, options)
}

describe('fold cache', () => {
  test('bounds entries, promotes accepted reads, and misses are undefined', () => {
    const cache = cacheOf<number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a', () => true), 1)
    cache.set('c', 3)
    assert.equal(cache.get('a', () => true), 1, 'a read is promoted')
    assert.equal(cache.get('b', () => true), undefined, 'the least recently used entry was evicted')
    assert.equal(cache.get('c', () => true), 3)
    assert.equal(cache.get('missing', () => true), undefined)
  })

  test('a rejected read does not promote', () => {
    const cache = cacheOf<number>({ maxEntries: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    assert.equal(cache.get('a', () => false), undefined)
    cache.set('c', 3)
    assert.equal(cache.get('a', () => true), undefined, 'the rejected read left a as the oldest entry')
    assert.equal(cache.get('b', () => true), 2)
    assert.equal(cache.get('c', () => true), 3)
  })

  test('bounds bytes without evicting the entry just stored', () => {
    const cache = cacheOf<number>({ maxEntries: 8, maxBytes: 10, bytesOf: value => value })
    cache.set('a', 6)
    cache.set('b', 6)
    assert.equal(cache.get('a', () => true), undefined, 'the older entry made room')
    assert.equal(cache.get('b', () => true), 6)
    cache.set('huge', 20)
    assert.equal(cache.get('b', () => true), undefined)
    assert.equal(cache.get('huge', () => true), 20, 'an entry larger than the budget stays')
  })

  test('sweeps after idle and runs the sweep hook', () => {
    vi.useFakeTimers()
    const swept = vi.fn()
    const cache = cacheOf<number>({ maxEntries: 2, idleMs: 10, onSweep: swept })
    cache.set('a', 1)
    cache.touch()
    vi.advanceTimersByTime(9)
    assert.equal(cache.get('a', () => true), 1)
    vi.advanceTimersByTime(1)
    assert.equal(cache.get('a', () => true), undefined)
    assert.equal(swept.mock.calls.length, 1)
  })

  test('sweeps without a hook', () => {
    vi.useFakeTimers()
    const cache = cacheOf<number>({ maxEntries: 2, idleMs: 10 })
    cache.set('a', 1)
    cache.touch()
    vi.advanceTimersByTime(10)
    assert.equal(cache.get('a', () => true), undefined)
  })

  test('defaults to the twenty-second idle window and resets on each touch', () => {
    vi.useFakeTimers()
    const swept = vi.fn()
    const cache = cacheOf<number>({ maxEntries: 2, onSweep: swept })
    cache.set('a', 1)
    cache.touch()
    cache.touch()
    vi.advanceTimersByTime(20_000)
    assert.equal(cache.get('a', () => true), undefined)
    assert.equal(swept.mock.calls.length, 1)
    cache.set('b', 2)
    cache.touch()
    vi.advanceTimersByTime(20_000)
    assert.equal(cache.get('b', () => true), undefined)
    assert.equal(swept.mock.calls.length, 2)
  })

  test('the context teardown disarms the sweep and clears the store', () => {
    vi.useFakeTimers()
    const fake = fakeCtx({})
    const cache = makeFoldCache<number>(fake.ctx, { maxEntries: 2, idleMs: 10 })
    cache.set('a', 1)
    cache.touch()
    fake.dispose()
    vi.advanceTimersByTime(10)
    assert.equal(cache.get('a', () => true), undefined)
  })
})
})

describe('foldJournal', () => {

describe('dsh-context fold journal', () => {
  test('drain returns the folded ids, the worker-folded subset, and clears both', () => {
    const journal = makeFoldJournal()
    journal.note('a')
    journal.note('b', true)
    const drained = journal.drain()
    assert.deepEqual(drained.ids, ['a', 'b'])
    assert.deepEqual(drained.workerIds, ['b'])
    assert.deepEqual(journal.drain(), { ids: [], workerIds: [] })
  })

  test('an id overflow reports the whole corpus dirty once, then recovers', () => {
    const journal = makeFoldJournal()
    for (let index = 0; index < 4_200; index++) journal.note(`s${index}`, true)
    const drained = journal.drain()
    assert.equal(drained.ids, null)
    assert.equal(drained.workerIds, null)
    assert.deepEqual(journal.drain(), { ids: [], workerIds: [] })
    journal.note('a', true)
    assert.deepEqual(journal.drain(), { ids: ['a'], workerIds: ['a'] })
  })
})
})

describe('foldWorker', () => {

const META = { id: 'w1', version: 4, createdAt: 1, cwd: '/repo/w1', isSeeded: false } as unknown as SessionHeader

function messageEvents(): SessionEvent[] {
  const events: SessionEvent[] = [header(0, { model: 'deepseek-v4-flash', provider: 'deepseek' }) as unknown as SessionEvent]
  let seq = 1
  for (const [text, tokens] of [['first', 10] as const, ['second', 30] as const]) {
    events.push(userMessage(seq++, [{ type: 'text', text }], { kind: 'user' }) as unknown as SessionEvent)
    events.push(assistantMessage(seq++, { turn: seq, usage: { inputTokens: tokens, outputTokens: 5 } }) as unknown as SessionEvent)
  }
  return events
}

function referenceValues(config: Record<string, unknown>, events: readonly SessionEvent[]): Record<string, unknown> {
  const ctx = new Context()
  const registry = new SessionProjectionRegistry(ctx as never)
  registry.register(createContextTimelineDefinition(config as never, () => false) as never)
  registry.register(createContextActivityDefinition() as never)
  return registry.restore({}, events, 0 as never, META, 0 as never).snapshot.values as Record<string, unknown>
}

describe('dsh-context fold worker', () => {
  test('the channel folds chunked events into the same values a single-shot restore produces', async () => {
    const events = messageEvents()
    const folded = await foldInProcess({}, events)
    const reference = referenceValues({}, events)
    assert.deepEqual(folded.timeline, reference.contextTimeline)
    assert.deepEqual(folded.activity, reference.contextActivity)
    const lastPrompt = events
      .filter(event => event.type === 'user/message')
      .reduce((max, event) => Math.max(max, event.time), 0)
    assert.equal(folded.lastPromptAt, lastPrompt)
    assert.equal(folded.blank, false)
  })

  test('an empty or promptless session folds blank with no last prompt', async () => {
    const folded = await foldInProcess({}, [header(0) as unknown as SessionEvent])
    assert.equal(folded.blank, true)
    assert.equal(folded.lastPromptAt, 0)
    assert.deepEqual(folded.activity, { days: {} })
  })

  test('a fold that throws reports the failure through the pool', async () => {
    const pool = inProcessPool()
    try {
      const hostile = { get maxEvents(): number { throw new Error('boom') } }
      await assert.rejects(pool.fold(hostile as never, messageEvents()), /boom/)
    } finally {
      pool.dispose()
    }
  })

  test('a second concurrent fold is rejected as busy', async () => {
    const pool = inProcessPool()
    try {
      const first = pool.fold({}, messageEvents())
      await assert.rejects(pool.fold({}, messageEvents()), /busy/)
      await first
    } finally {
      pool.dispose()
    }
  })

  test('dispose rejects the pending fold; a later dispose is a no-op', async () => {
    const pool = inProcessPool()
    const pending = pool.fold({}, messageEvents())
    pool.dispose()
    await assert.rejects(pending, /disposed/)
    pool.dispose()
  })

  test('the channel without a port returns quietly', () => {
    startFoldWorkerChannel(null)
  })

  test('worker error events fail the pending fold with the emitted cause', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const first = pool.fold({}, messageEvents())
      worker.emit('error', 'boom-string')
      await assert.rejects(first, /boom-string/)
      const second = pool.fold({}, messageEvents())
      worker.emit('error', new Error('bang'))
      await assert.rejects(second, /bang/)
    } finally {
      pool.dispose()
    }
  })

  test('a worker exit fails a pending fold and the next fold runs again', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const pending = pool.fold({}, messageEvents())
      worker.emit('exit')
      await assert.rejects(pending, /exited/)
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded)
    } finally {
      pool.dispose()
    }
  })

  test('non-object worker messages are ignored', async () => {
    const pool = inProcessPool()
    const worker = pool.worker
    try {
      const pending = pool.fold({}, messageEvents())
      worker.emit('message', 42)
      const folded = await pending
      assert.ok('timeline' in folded)
      const again = await pool.fold({}, messageEvents())
      assert.ok('timeline' in again)
    } finally {
      pool.dispose()
    }
  })

  test('the channel tolerates non-record traffic and a missing config', async () => {
    const pool = inProcessPool()
    try {
      pool.sendToWorker('junk')
      pool.sendToWorker({ kind: 'begin' })
      pool.sendToWorker({ kind: 'end' })
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded)
    } finally {
      pool.dispose()
    }
  })

  test('a chunk that throws a non-error reports the failure and the pool recovers', async () => {
    const pool = inProcessPool()
    try {
      pool.sendToWorker({ kind: 'begin', config: {} })
      pool.sendToWorker({ kind: 'chunk', events: [{ get type(): string { throw 'zap' } }] })
      await new Promise(resolve => setTimeout(resolve, 10))
      const folded = await pool.fold({}, messageEvents())
      assert.ok('timeline' in folded, 'the pool re-spawns after an out-of-band failure')
    } finally {
      pool.dispose()
    }
  })

  test('a rejecting terminate stays fail-soft on dispose', async () => {
    const pool = inProcessPool({ terminate: async () => { throw new Error('no thread') } })
    await pool.fold({}, messageEvents())
    pool.dispose()
  })

  test('pool message edge cases stay fail-soft', async () => {
    const pool = inProcessPool()
    try {
      const failing = pool.fold({}, messageEvents())
      pool.worker.emit('message', { kind: 'failed', message: 42 })
      await assert.rejects(failing, /fold worker failed/)
      const pending = pool.fold({}, messageEvents())
      pool.worker.emit('message', { kind: 'done', timeline: {}, activity: {}, lastPromptAt: 'x', blank: true })
      const folded = await pending
      assert.equal(folded.lastPromptAt, 0)
      assert.equal(folded.blank, true)
    } finally {
      pool.dispose()
    }
  })

  test('the default eval worker fails to boot from source and the pool surfaces the error', async () => {
    const pool = createFoldPool()
    try {
      await assert.rejects(pool.fold({}, messageEvents()))
    } finally {
      pool.dispose()
    }
  })
})
})
