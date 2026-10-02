import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { TimelineEvent } from '../../src/host/fold'
import { assistantMessage, at, compaction, userMessage } from './helpers/events'
import { assertStatesPlainJson, driveTimeline, timelineDef } from './helpers/projection'

// The agent loop logs these blocks when the effective tool registry changes.
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
    assert.equal(result.state.requests[0].inject, 35)
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
    assert.equal(result.state.requests[0].inject, 35)
    assert.equal(result.state.requests[1].inject, 10)
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

  test.each([undefined, null, {}, { kind: 'user' }])('a developer source %j never counts as a human input', source => {
    const event = developerMessage(1)
    const message = event.data!.message as Record<string, unknown>
    if (source === undefined) delete message.source
    else message.source = source
    const result = driveTimeline([event])
    assert.equal(result.state.surface[0].cat, 'inject')
    assert.equal(result.state.sums.inject, 35)
    assert.equal(result.state.humanInputs, undefined)
    assert.equal(result.state.events[0].kind, 'inject')
    assertStatesPlainJson(result)
  })

  test.each([undefined, {}, { message: null }, { message: { content: 'invalid' } }])(
    'a malformed nested message leaves the state unchanged: %j', data => {
      const def = timelineDef()
      const initial = def.init()
      const event: TimelineEvent = { type: 'developer/message', seq: 1, time: at(), ...(data === undefined ? {} : { data }) }
      assert.equal(def.apply(initial, event), initial)
      def.stateSchema.parse(initial)
    },
  )
})
