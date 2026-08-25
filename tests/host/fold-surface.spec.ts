// applySurface paths of the fold (src/host/fold.ts): per-category node
// projection (text/calls/tool/skill/plugin previews, image counts), the
// callNames consume-once lifecycle, the shadow-price claim arm/consume
// protocol, and every surfaceOp variant (append, range replace, shadowed-seq
// replace with the net-freed event rewrite). No mocks: the real fold runs.

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
    assert.equal(node?.err, undefined, 'no error flag without data.error')
    assert.deepEqual(state.callNames, {}, 'the consumed entry leaves the persisted map')
  })

  test('an unknown source callId falls through to the content block id', () => {
    // Neither id is armed: the node ends up tool-less (a replay window where
    // the tool/call event is gone). Note the fold assigns the lookup miss
    // onto the node, so this state is not assertPlainJson-able.
    const { state } = driveTimeline([toolResult(1, { callId: 'ghost', content: text('ok') })])
    assert.equal(state.surface.at(-1)?.tool, undefined)
    assert.deepEqual(state.callNames, {})
  })

  test('a block toolCallId hit names the node when the source id is unknown', () => {
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: {
        callId: 'x',
        message: {
          source: { kind: 'tool', callId: 'x' },
          content: [{ type: 'tool-result', toolCallId: 'c1', content: text('ok') }],
        },
      },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'c1', name: 'bash' }), ev])
    assert.equal(state.surface.at(-1)?.tool, 'bash')
    assert.deepEqual(state.callNames, {}, 'both the source id and the block id are consumed')
  })

  test('consume-once rebuild keeps the other pending calls', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolCall(2, { callId: 'c2', name: 'read' }),
      toolResult(3, { callId: 'c1', content: text('ok') }),
    ])
    assert.deepEqual(state.callNames, { c2: 'read' }, 'the unanswered call stays armed')
  })

  test('a result with neither id leaves callNames untouched', () => {
    const ev: TimelineEvent = {
      type: 'tool/result', seq: 2, time: at(),
      data: { message: { content: [{ type: 'tool-result', content: text('ok') }] } },
      surfaceOp: 'append',
    }
    const { state } = driveTimeline([toolCall(1, { callId: 'keep', name: 'read' }), ev])
    assert.equal(state.surface.at(-1)?.tool, undefined)
    assert.deepEqual(state.callNames, { keep: 'read' })
  })

  test('data.error flags the node', () => {
    const { state } = driveTimeline([
      toolCall(1, { callId: 'c1', name: 'bash' }),
      toolResult(2, { callId: 'c1', content: text('boom'), error: true }),
    ])
    assert.equal(state.surface.at(-1)?.err, true)
  })
})

describe('applySurface user-message previews', () => {
  test('skill-invocation sources carry the skill name', () => {
    const { state } = driveTimeline([userMessage(1, text('run it'), { kind: 'skill-invocation', name: 'pdf' })])
    assert.equal(state.surface.at(-1)?.skill, 'pdf')
    assert.equal(state.surface.at(-1)?.cat, 'inject')
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
      userMessage(1, text('x'), undefined, { surfaceOp: { op: 'insert', start: 0, end: 0 } }),
    ])
    assert.equal(state.surface.length, 1)
  })

  test('a replace with an armed claim removes by seqs and rewrites the metering event net-freed', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      userMessage(2, text(big)), // 12 tokens
      userMessage(3, text(big)), // 12 tokens — NOT shadowed, survives the replace
      compaction(4, 'summary', { shadowedTokenCount: 100, shadowedSeqs: [1, 2] }),
      userMessage(5, text('bbbbbbbb'), undefined, { surfaceOp: { op: 'replace', start: 1, end: 2 } }), // 10 tokens
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [3, 5])
    assert.equal(state.sums.user, 22)
    assert.deepEqual(state.archived.map(n => [n.seq, n.gone]), [[1, 5], [2, 5]], 'removed nodes archived as stamped copies')
    // Gross 100 rewritten to the net freed amount: 24 removed - 10 re-added.
    assert.equal(state.events[0].tokens, 14)
    assertPlainJson(state)
  })

  test('the net-freed rewrite clamps at zero when the replacement outweighs the shadow', () => {
    const { state } = driveTimeline([
      userMessage(1, text(big)), // 12 tokens
      compaction(2, 'prune', { shadowedTokenCount: 12, shadowedSeqs: [1] }),
      userMessage(3, text('x'.repeat(400)), undefined, { surfaceOp: { op: 'replace', start: 1, end: 1 } }), // 108 tokens
    ])
    assert.equal(state.events[0].tokens, 0)
    assert.equal(state.sums.user, 108)
  })

  test('an armed EMPTY claim falls through to the range path', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')), // 9 tokens
      userMessage(2, text('bbbb')), // 9 tokens
      compaction(3, 'summary', { shadowedTokenCount: 50, shadowedSeqs: [] }),
      userMessage(4, text('cccc'), undefined, { surfaceOp: { op: 'replace', start: 1, end: 2 } }),
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
      userMessage(4, text('dddddddd'), undefined, { surfaceOp: { op: 'replace', start: 2, end: 2 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 4, 3])
    assert.deepEqual(state.archived.map(n => [n.seq, n.gone]), [[2, 4]])
  })

  test('a replace whose start seq is missing appends', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', start: 99, end: 100 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 2])
  })

  test('a replace whose end seq is missing appends', () => {
    const { state } = driveTimeline([
      userMessage(1, text('aaaa')),
      userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', start: 1, end: 99 } }),
    ])
    assert.deepEqual(state.surface.map(n => n.seq), [1, 2])
  })

  test('restored state: claim without pendingShadowEventSeq skips the rewrite', () => {
    // A checkpoint restore may carry the claim fields partially — def.apply
    // accepts any TimelineState.
    const def = timelineDef({})
    const base = driveTimeline([userMessage(1, text(big))]).state
    const restored: TimelineState = { ...base, pendingShadowedSeqs: [1] }
    const next = def.apply(restored, userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', start: 1, end: 1 } }))
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
    const next = def.apply(restored, userMessage(2, text('bbbb'), undefined, { surfaceOp: { op: 'replace', start: 1, end: 1 } }))
    assert.deepEqual(next.surface.map(n => n.seq), [2])
    assert.equal(next.events.length, 0)
    assert.ok(!('pendingShadowEventSeq' in next))
  })
})
