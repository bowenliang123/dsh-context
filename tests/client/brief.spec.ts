// Step brief (src/client/brief.ts): node merge/sort, the per-step brief
// (response hit, turn-start detection, opener scan, mid-turn inputs), and
// the tooltip reply previews.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { briefNodes, briefOf, replyTipsOf } from '../../src/client/brief'
import type { ContextTimeline, RequestRecord, SurfaceNode } from '../../src/shared/types'

function node(seq: number, over: Partial<SurfaceNode> = {}): SurfaceNode {
  return { seq, cat: 'user', tokens: 1, ...over }
}

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return { time: 0, seq, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, ...over }
}

function timeline(nodes: SurfaceNode[], archive: SurfaceNode[]): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 },
    toolList: [],
    requests: [],
    events: [],
    nodes,
    droppedNodes: 0,
    archive,
  }
}

describe('briefNodes', () => {
  test('merges live and archived nodes sorted by seq', () => {
    const data = timeline([node(5), node(1)], [node(3, { gone: 9 }), node(2, { gone: 9 })])
    assert.deepEqual(briefNodes(data).map(n => n.seq), [1, 2, 3, 5])
  })
})

describe('briefOf index bounds', () => {
  test('an out-of-range index yields no brief', () => {
    assert.equal(briefOf([], [req(1)], -1), null)
    assert.equal(briefOf([], [req(1)], 1), null)
  })
})

describe('briefOf response', () => {
  test('the assistant node at the request seq is the response', () => {
    const nodes = [node(5, { cat: 'assistant', text: 'hi' })]
    const brief = briefOf(nodes, [req(5, { turn: 1 })], 0)
    assert.equal(brief?.response, nodes[0])
  })

  test('a non-assistant node at the request seq is not a response', () => {
    const brief = briefOf([node(5)], [req(5, { turn: 1 })], 0)
    assert.equal(brief?.response, undefined)
  })

  test('no node at the request seq means no response', () => {
    const brief = briefOf([node(4)], [req(5, { turn: 1 })], 0)
    assert.equal(brief?.response, undefined)
  })
})

describe('briefOf opener scan', () => {
  test('the opener is the newest user message before the turn starts', () => {
    const nodes = [node(1), node(2), node(3, { cat: 'tool' }), node(5, { cat: 'assistant' })]
    const brief = briefOf(nodes, [req(5, { turn: 1 })], 0)
    assert.equal(brief?.opener, nodes[1])
  })

  test('no user message in the window means no opener', () => {
    const nodes = [node(3, { cat: 'tool' }), node(5, { cat: 'assistant' })]
    const brief = briefOf(nodes, [req(5, { turn: 1 })], 0)
    assert.equal(brief?.opener, undefined)
  })

  test('the scan stops at the previous turn’s last bar', () => {
    const nodes = [node(1), node(3, { cat: 'assistant' }), node(5, { cat: 'tool' }), node(7, { cat: 'assistant' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 2 })]
    const brief = briefOf(nodes, requests, 1)
    // The user at seq 1 lies at/below the lower bound (3) and is not found.
    assert.equal(brief?.opener, undefined)
  })

  test('a user message inside the window of a later turn is found', () => {
    const nodes = [node(3, { cat: 'assistant' }), node(5), node(7, { cat: 'assistant' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 2 })]
    const brief = briefOf(nodes, requests, 1)
    assert.equal(brief?.opener, nodes[1])
  })
})

describe('briefOf inputs', () => {
  test('a mid-turn step collects the nodes since the previous bar', () => {
    const nodes = [node(2), node(3, { cat: 'assistant' }), node(4, { cat: 'tool' }), node(5), node(7, { cat: 'assistant' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    const brief = briefOf(nodes, requests, 1)
    assert.deepEqual(brief?.inputs.map(n => n.seq), [4, 5])
  })

  test('the input scan stops at the request seq even past the node tail', () => {
    const nodes = [node(4, { cat: 'tool' }), node(9, { cat: 'tool' })]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 1 })]
    const brief = briefOf(nodes, requests, 1)
    assert.deepEqual(brief?.inputs.map(n => n.seq), [4])
  })

  test('a turn start has no inputs row', () => {
    const nodes = [node(4, { cat: 'tool' }), node(5)]
    const requests = [req(3, { turn: 1 }), req(7, { turn: 2 })]
    const brief = briefOf(nodes, requests, 1)
    assert.deepEqual(brief?.inputs, [])
  })

  test('requests without turn fields share the default turn', () => {
    const nodes = [node(4, { cat: 'tool' })]
    const requests = [req(3), req(7)]
    const brief = briefOf(nodes, requests, 1)
    assert.deepEqual(brief?.inputs.map(n => n.seq), [4])
  })

  test('a missing previous turn field differs from a numbered turn', () => {
    const requests = [req(3), req(7, { turn: 2 })]
    const brief = briefOf([], requests, 1)
    assert.deepEqual(brief?.inputs, [])
  })
})

describe('replyTipsOf', () => {
  test('an assistant reply previews its text', () => {
    const tips = replyTipsOf([node(5, { cat: 'assistant', text: 'hello' })])
    assert.equal(tips.get(5), 'hello')
  })

  test('text wins over the call breadcrumb', () => {
    const tips = replyTipsOf([node(5, { cat: 'assistant', text: 'hello', calls: ['bash'] })])
    assert.equal(tips.get(5), 'hello')
  })

  test('a text-less reply previews its joined call breadcrumb', () => {
    const tips = replyTipsOf([node(5, { cat: 'assistant', calls: ['bash', 'read'] })])
    assert.equal(tips.get(5), 'bash › read')
  })

  test('a reply with neither text nor calls is skipped', () => {
    const tips = replyTipsOf([node(5, { cat: 'assistant' })])
    assert.equal(tips.size, 0)
  })

  test('an empty text and an empty call list are both skipped', () => {
    const tips = replyTipsOf([
      node(5, { cat: 'assistant', text: '' }),
      node(6, { cat: 'assistant', calls: [] }),
    ])
    assert.equal(tips.size, 0)
  })

  test('non-assistant nodes are skipped', () => {
    const tips = replyTipsOf([node(5, { text: 'hi' })])
    assert.equal(tips.size, 0)
  })
})
