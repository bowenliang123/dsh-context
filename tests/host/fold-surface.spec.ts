import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { assistantMessage, at, compaction, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, fullDef } from './helpers/projection'

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

  test('a replace with an armed claim removes by seqs and rewrites the metering event net-freed, clamped at zero', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)),
      userMessage(2, text(big)),
      userMessage(3, text(big)),
      compaction(4, 'summary', { shadowedTokenCount: 100, shadowedSeqs: [1, 2] }),
      userMessage(5, text('bbbbbbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(
      [state.surface.map(n => n.seq), state.sums.user, state.archived.map(n => [n.seq, n.gone]), state.events[0].tokens],
      [[3, 5], 22, [[1, 5], [2, 5]], 14],
      'removed nodes archived as stamped copies, the metering row rewritten net-freed',
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
