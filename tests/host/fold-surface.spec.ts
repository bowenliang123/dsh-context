// applySurface paths of the fold (src/host/fold.ts): per-category node projection, the callNames
// consume-once lifecycle, the shadow-price claim protocol, and every surfaceOp variant. No mocks: the real fold runs.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent, TimelineState } from '../../src/host/fold'
import { assistantMessage, at, compaction, toolCall, toolResult, userMessage } from './helpers/events'
import { assertPlainJson, driveTimeline, timelineDef } from './helpers/projection'

const text = (t: string) => [{ type: 'text', text: t }]

describe('applySurface assistant branch', () => {
  test('assistant text lands on the node preview', () => {
    const { state } = driveTimeline([assistantMessage(1, { content: text('hello world') })])
    assert.equal(state.surface.at(-1)?.text, 'hello world')
    assert.equal(state.surface.at(-1)?.cat, 'assistant')
  })

  test('a text-less assistant message lists its tool-call names, capped at three', () => {
    const { state } = driveTimeline([assistantMessage(1, {
      content: [
        { type: 'tool-call', name: 'bash', arguments: '{}' },
        { type: 'tool-call', name: 'read', arguments: '{}' },
        { type: 'tool-call', name: 'edit', arguments: '{}' },
        { type: 'tool-call', name: 'grep', arguments: '{}' },
      ],
    })])
    const node = state.surface.at(-1)
    assert.equal(node?.text, undefined)
    assert.deepEqual(node?.calls, ['bash', 'read', 'edit'])
  })

  test('a text-less assistant message without call names carries neither preview', () => {
    const { state } = driveTimeline([assistantMessage(1, { content: [{ type: 'tool-call', arguments: '{}' }] })])
    const node = state.surface.at(-1)
    assert.equal(node?.text, undefined)
    assert.equal(node?.calls, undefined)
  })
})

describe('applySurface tool/result branch', () => {
  test('a source callId armed by tool/call names the node and is consumed', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: text('ok') }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.tool, 'bash')
    assert.equal(node?.err, undefined, 'no error flag without the message mark')
    assert.deepEqual(state.callNames, {}, 'the consumed entry leaves the persisted map')
  })

  test('an unknown source callId pairs nothing (a replay window where the tool/call event is gone)', () => {
    const { state } = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(state.surface.at(-1)?.tool, undefined)
    assert.deepEqual(state.callNames, {})
  })

  test('consume-once rebuild keeps the other pending calls', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolCall(2, { callId: 'c2', name: 'read' }),
      toolResult(3, { callId: 'c1', content: text('ok') }),
    ])
    assert.equal(state.callNames.c2?.name, 'read', 'the unanswered call stays armed')
  })

  test('a result without the source callId pairs nothing and leaves callNames untouched', () => {
    // A hostile/foreign envelope: the admission validation requires the
    // source callId, so a source-less row can only arrive hostile — it folds to an unnamed node instead of throwing.
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: { message: { role: 'tool', toolCallId: 'keep', content: text('ok') } },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'keep', name: 'read' }), ev])
    assert.equal(state.surface.at(-1)?.tool, undefined)
    assert.equal(state.callNames.keep?.name, 'read')
  })

  test('the message isError flags the node', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: text('boom'), error: true }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.err, true)
    assert.equal(node?.tool, 'bash', 'the source callId still pairs the node')
  })

  test('the retired envelope-only error mark no longer flags the node', () => {
    // The pre-V4 spelling (an event-level `data.error` with no message mark)
    // is unreachable through the supported harnesses' admission validation;
    // a hostile replay carrying it degrades to an unflagged node, never a throw.
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: {
        error: true,
        message: { role: 'tool', toolCallId: 'c1', source: { kind: 'tool', callId: 'c1' }, content: text('boom') },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' }), ev])
    const node = state.surface.at(-1)
    assert.equal(node?.err, undefined)
    assert.equal(node?.tool, 'bash')
  })
})

describe('applySurface user-message previews', () => {
  test('skill-invocation sources carry the skill name under the skill bucket', () => {
    const { state } = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation', name: 'pdf' })])
    assert.equal(state.surface.at(-1)?.skill, 'pdf')
    assert.equal(state.surface.at(-1)?.cat, 'skill')
  })

  test('skill-catalog sources join the skill bucket', () => {
    const { state } = driveTimeline([userMessage(1, text('<available_skills>'), { kind: 'skill-catalog', form: 'catalog' })])
    const node = state.surface.at(-1)
    assert.equal(node?.cat, 'skill')
    assert.equal(node?.skill, undefined)
    assert.equal(node?.form, 'catalog')
  })

  test('a nameless skill-invocation falls back to ?', () => {
    const { state } = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation' })])
    assert.equal(state.surface.at(-1)?.skill, '?')
  })

  test('plugin notice sources preview the summary', () => {
    const { state } = driveTimeline([
      userMessage(1, text('injected'), { kind: 'plugin', form: 'notice', plugin: 'dsh-x', summary: 'Skill injected (pdf)' }),
    ])
    const node = state.surface.at(-1)
    assert.equal(node?.text, 'Skill injected (pdf)')
    assert.equal(node?.form, 'notice')
  })

  test('plugin snapshot sources join section names, skipping nulls, truncated to 80', () => {
    const sections = [{ name: 'a'.repeat(50) }, null, { name: 'b'.repeat(50) }, {}]
    const { state } = driveTimeline([
      userMessage(1, text('snapshot'), { kind: 'plugin', form: 'snapshot', sections }),
    ])
    const expected = `${'a'.repeat(50)}, ${'b'.repeat(50)}`.slice(0, 80)
    assert.equal(expected.length, 80, 'fixture must actually exceed the truncation bound')
    assert.equal(state.surface.at(-1)?.text, expected)
  })

  test('plugin sources of other forms preview the first text', () => {
    const { state } = driveTimeline([
      userMessage(1, text('plain body'), { kind: 'plugin', form: 'instructions' }),
    ])
    assert.equal(state.surface.at(-1)?.text, 'plain body')
  })

  test('plugin sources without text carry no preview', () => {
    const { state } = driveTimeline([userMessage(1, [], { kind: 'plugin', form: 'instructions' })])
    assert.equal(state.surface.at(-1)?.text, undefined)
  })

  test('a plain user message previews its text', () => {
    const { state } = driveTimeline([userMessage(1, text('hi there'))])
    const node = state.surface.at(-1)
    assert.equal(node?.text, 'hi there')
    assert.equal(node?.cat, 'user')
    assert.equal(node?.form, undefined, 'no source, no form stamp')
  })

  test('a plain user message without text carries no preview', () => {
    const { state } = driveTimeline([userMessage(1, [])])
    assert.equal(state.surface.at(-1)?.text, undefined)
  })

  test('image blocks ride the node as imgs', () => {
    const { state } = driveTimeline([
      userMessage(1, [{ type: 'image', attachment: { width: 800, height: 600 } }]),
    ])
    assert.equal(state.surface.at(-1)?.imgs, 1)
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
  const big = 'a'.repeat(16) // 12 tokens: ceil(16/4) + 4 block + 4 role

  test('a null surfaceOp appends', () => {
    const ev: TimelineEvent = { type: 'user/message', seq: 1, time: at(), data: { content: text('x') }, surfaceOp: null }
    const { state } = driveTimeline([ev])
    assert.equal(state.surface.length, 1)
  })

  test('a non-object surfaceOp appends', () => {
    const { state } = driveTimeline([userMessage(1, text('x'))]) // builder default: 'append'
    assert.equal(state.surface.length, 1)
  })

  test('a non-replace op object appends', () => {
    const { state } = driveTimeline([
      userMessage(1, text('x'), undefined, { surfaceOp: { op: 'insert', startSeq: 0, endSeq: 0 } }),
    ])
    assert.equal(state.surface.length, 1)
  })

  test('a replace with an armed claim removes by seqs and rewrites the metering event net-freed', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      userMessage(2, text(big)), // 12 tokens
      userMessage(3, text(big)), // 12 tokens — NOT shadowed, survives the replace
      compaction(4, 'summary', { shadowedTokenCount: 100, shadowedSeqs: [1, 2] }),
      userMessage(5, text('bbbbbbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }), // 10 tokens
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [3, 5])
    assert.equal(state.surface[1].seat, 1, "the replacement takes the declared range start's prompt seat")
    assert.equal(state.sums.user, 22)
    assert.deepEqual(state.archived.map(n => [n.seq, n.gone]), [[1, 5], [2, 5]], 'removed nodes archived as stamped copies')
    // Gross 100 rewritten to the net freed amount: 24 removed - 10 re-added.
    assert.equal(state.events[0].tokens, 14)
    assertPlainJson(state)
  })

  test('a replacement inherits the seat of the replacement it shadows', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)),
      compaction(2, 'summary', { shadowedTokenCount: 20, shadowedSeqs: [1] }),
      userMessage(3, text('sum'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }),
      // A second compaction over the PRIOR SUMMARY itself: its prompt seat is the first range's seat, not the summary's log seq.
      compaction(4, 'summary', { shadowedTokenCount: 20, shadowedSeqs: [3] }),
      userMessage(5, text('sum2'), undefined, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
    ])
    assert.equal(state.surface.at(-1)?.seq, 5)
    assert.equal(state.surface.at(-1)?.seat, 1)
  })

  test('an armed claim whose declared start is not among the shadowed seqs stamps no seat', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb')),
      compaction(3, 'summary', { shadowedTokenCount: 10, shadowedSeqs: [2] }),
      userMessage(4, text('cccc'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 4])
    assert.equal(state.surface[1].seat, undefined)
  })

  test('the net-freed rewrite clamps at zero when the replacement outweighs the shadow', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      compaction(2, 'prune', { shadowedTokenCount: 12, shadowedSeqs: [1] }),
      userMessage(3, text('x'.repeat(400)), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }), // 108 tokens
    ])
    assert.equal(state.events[0].tokens, 0)
    assert.equal(state.sums.user, 108)
  })

  test('an armed EMPTY claim falls through to the range path', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')), // 9 tokens
      userMessage(2, text('bbbb')), // 9 tokens
      compaction(3, 'summary', { shadowedTokenCount: 50, shadowedSeqs: [] }),
      userMessage(4, text('cccc'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [4], 'range replace splices the node in place')
    assert.equal(state.sums.user, 9)
    assert.deepEqual(state.archived.map(n => n.seq), [1, 2])
    assert.equal(state.events[0].tokens, 50, 'the range path never rewrites the metering event')
    assert.ok(!('pendingShadowedSeqs' in state))
  })

  test('a single-node range replace (start === end)', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb')),
      userMessage(3, text('cccc')),
      userMessage(4, text('dddddddd'), undefined, { surfaceOp: { op: 'replace', startSeq: 2, endSeq: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 4, 3])
    assert.equal(state.surface[1].seat, 2, 'the replacement takes the replaced node 2\'s position')
    assert.deepEqual(state.archived.map(n => [n.seq, n.gone]), [[2, 4]])
  })

  test('a range rewrite over a replacement keeps that replacement\'s prompt seat', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)),
      compaction(2, 'summary', { shadowedTokenCount: 12, shadowedSeqs: [1] }),
      userMessage(3, text('sum'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }), // seat 1
      userMessage(4, text('sum2'), undefined, { surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [4])
    assert.equal(state.surface[0].seat, 1, 'the inherited seat survives a later range rewrite')
  })

  test('a replace whose start seq is missing appends', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 99, endSeq: 100 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 2])
  })

  test('a replace whose end seq is missing appends', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 99 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 2])
  })

  test('restored state: claim without pendingShadowEventSeq skips the rewrite', () => {
    // A checkpoint restore may carry the claim fields partially — def.apply accepts any TimelineState.
    const def = timelineDef({})
    const base = driveTimeline([userMessage(1, text(big))]).state
    const restored: TimelineState = { ...base, pendingShadowedSeqs: [1] }
    const next = def.apply(restored, userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }))
    assert.deepEqual(next.surface.map(n => n.seq), [2])
    assert.equal(next.archived.length, 1)
    assert.equal(next.events.length, 0, 'no event to rewrite, no crash')
    assert.ok(!('pendingShadowedSeqs' in next))
    assertPlainJson(next)
  })

  test('restored state: a claim whose event seq matches no event skips the rewrite', () => {
    const def = timelineDef({})
    const base = driveTimeline([userMessage(1, text(big))]).state
    const restored: TimelineState = { ...base, pendingShadowedSeqs: [1], pendingShadowEventSeq: 999 }
    const next = def.apply(restored, userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 } }))
    assert.deepEqual(next.surface.map(n => n.seq), [2])
    assert.equal(next.events.length, 0)
    assert.ok(!('pendingShadowEventSeq' in next))
  })
})
