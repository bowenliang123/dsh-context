// historyPage (src/client/historyPage.ts): the targeted content fetch — raw
// durable-log pages mapped into the browser's conversation-node shapes, plus
// the per-session fetcher built over the shared api client.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeContentFetcher, pageNodesOf } from '../../src/client/historyPage'

/** One well-formed history row. */
function row(type: string, seq: number, data: unknown): unknown {
  return { event: { type, seq, time: seq, data } }
}

describe('pageNodesOf — the durable-page mapper', () => {
  test('garbage rows and non-message events project to nothing', () => {
    const nodes = pageNodesOf([
      null,
      42,
      {},
      { event: null },
      { event: { type: 'user/message' } }, // no seq
      { event: { type: 'user/message', seq: Number.NaN } },
      row('request/header', 1, {}),
      row('turn/end', 2, {}),
      row('tool/call', 4, {}), // no callId: nothing recorded
      row('compaction/summary', 5, {}), // no compactionId
      row('compaction/summary', 6, { compactionId: 'k0', summary: [{ type: 'text', text: '   ' }] }), // blank summary
      row('compaction/summary', 7, { compactionId: 'k0b', summary: 'not-an-array' }), // malformed summary
    ])
    assert.equal(nodes.size, 0)
    // An envelope with no data at all still maps to an empty user node.
    assert.deepEqual(pageNodesOf([{ event: { type: 'user/message', seq: 3 } }]).get(3), {
      kind: 'user', seq: 3, content: [],
    })
  })

  test('call heads degrade missing names and raw arguments safely', () => {
    const page = [
      row('tool/call', 10, { callId: 'c1' }),
      row('tool/result', 11, { message: { source: { callId: 'c1' }, content: [] } }),
    ]
    const nodes = pageNodesOf(page)
    assert.deepEqual(nodes.get(11)?.call, { name: '?', argsRaw: '' })
  })

  test('a tool result without any message shape still joins empty', () => {
    const nodes = pageNodesOf([row('tool/result', 12, {})])
    assert.deepEqual(nodes.get(12), { kind: 'tool-result', seq: 12, call: null, content: [], isError: false })
  })

  test('the call head falls back to the result block\u2019s toolCallId when the source omits it', () => {
    const page = [
      row('tool/call', 20, { callId: 'cb', name: 'read', arguments: '{"path":"a.ts"}' }),
      row('tool/result', 21, { message: { content: [{ toolCallId: 'cb', content: [] }] } }),
    ]
    assert.deepEqual(pageNodesOf(page).get(21)?.call, { name: 'read', argsRaw: '{"path":"a.ts"}' })
  })

  test('user messages map with their durable content blocks', () => {
    const nodes = pageNodesOf([row('user/message', 10, { content: [{ type: 'text', text: 'hello' }], source: { form: 'context' } })])
    const n = nodes.get(10)
    assert.ok(n !== undefined)
    assert.equal(n.kind, 'user')
    assert.deepEqual(n.content, [{ type: 'text', text: 'hello' }])
    // Missing/invalid content degrades to an empty array, never undefined.
    assert.deepEqual(pageNodesOf([row('user/message', 11, {}) ]).get(11)?.content, [])
  })

  test('assistant messages map to the snapshot block vocabulary', () => {
    const nodes = pageNodesOf([row('assistant/message', 20, {
      message: {
        content: [
          { type: 'text', text: 'reply' },
          { type: 'reasoning', text: 'hmm' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
          { type: 'image', attachment: { attachmentId: 'a1' } },
          { type: 'mystery', foo: 1 },
          'junk',
          // Degraded shapes: missing facts fall back per field.
          { type: 'text' },
          { type: 'image' },
          { type: 'tool-call', arguments: '{}' },
        ],
      },
    })])
    const n = nodes.get(20)
    assert.equal(n?.kind, 'assistant')
    assert.deepEqual(n?.blocks, [
      { kind: 'text', text: 'reply' },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'tool-call', name: 'bash', argsRaw: '{"command":"ls"}' },
      { kind: 'image', attachment: { attachmentId: 'a1' } },
      { type: 'mystery', foo: 1 },
      { value: 'junk' },
      { kind: 'text' },
      { kind: 'image' },
      { kind: 'tool-call', name: '?', argsRaw: '{}' },
    ])
  })

  test('an assistant event without a message still joins (empty blocks)', () => {
    assert.deepEqual(pageNodesOf([row('assistant/message', 21, {})]).get(21), { kind: 'assistant', seq: 21, blocks: [] })
  })

  test('tool results pair with their in-page call head; isError rides block or envelope', () => {
    const page = [
      row('tool/call', 30, { callId: 'c9', name: 'bash', arguments: '{"command":"pwd"}' }),
      row('tool/result', 31, {
        callId: 'c9',
        error: true,
        message: { source: { callId: 'c9' }, content: [{ toolCallId: 'c9', content: [{ type: 'text', text: 'out' }] }] },
      }),
      row('tool/result', 32, {
        message: { source: { callId: 'missing' }, content: [{ isError: true, content: [] }] },
      }),
      row('tool/result', 33, { message: {} }),
    ]
    const nodes = pageNodesOf(page)
    const paired = nodes.get(31)
    assert.deepEqual(paired?.call, { name: 'bash', argsRaw: '{"command":"pwd"}' })
    assert.deepEqual(paired?.content, [{ type: 'text', text: 'out' }])
    assert.equal(paired?.isError, true, 'envelope error flag')
    assert.equal(nodes.get(32)?.isError, true, 'block error flag without a pairable call')
    assert.equal(nodes.get(32)?.call, null)
    assert.deepEqual(nodes.get(33)?.content, [])
    assert.equal(nodes.get(33)?.isError, false)
  })

  test('a compaction checkpoint renders as a compaction marker with its summary text', () => {
    const page = [
      row('compaction/summary', 40, {
        compactionId: 'k1',
        // Mixed block shapes: only string texts join the summary.
        summary: [{ type: 'other' }, null, { type: 'text', text: 'the' }, { type: 'text', text: ' gist' }, 42],
      }),
      row('user/message', 41, { source: { kind: 'plugin', plugin: 'dsh-compaction', compactionId: 'k1' }, content: [{ type: 'text', text: '<envelope>' }] }),
      row('user/message', 42, { source: { kind: 'plugin', plugin: 'dsh-compaction', compactionId: 'gone' }, content: [] }),
    ]
    const nodes = pageNodesOf(page)
    assert.deepEqual(nodes.get(41), { kind: 'compaction', seq: 41, summary: 'the gist' })
    assert.deepEqual(nodes.get(42), { kind: 'compaction', seq: 42, summary: null }, 'summary outside the page degrades to null')
    // An ordinary plugin injection is NOT a checkpoint — it stays a user node.
    const plain = pageNodesOf([row('user/message', 43, { source: { kind: 'plugin', plugin: 'other' }, content: [] })])
    assert.equal(plain.get(43)?.kind, 'user')
    // A scalar data envelope degrades to an empty record (no source to read).
    assert.deepEqual(
      pageNodesOf([{ event: { type: 'user/message', seq: 44, data: 'scalar' } }]).get(44),
      { kind: 'user', seq: 44, content: [] },
    )
  })
})

describe('makeContentFetcher — the per-session targeted read', () => {
  /** A minimal cordis-like ctx over one service map. */
  function ctxWith(services: Record<string, unknown>): Parameters<typeof makeContentFetcher>[0] {
    return { get: (key: string) => services[key] } as Parameters<typeof makeContentFetcher>[0]
  }

  const apiFace = (events: unknown[], calls: { beforeSeq: number }[] = []) => ({
    sessions: {
      history: (request: { sessionId: string; beforeSeq: number }) => {
        calls.push({ beforeSeq: request.beforeSeq })
        return Promise.resolve({ result: { ok: true, value: { events } } })
      },
    },
  })

  test('undefined without the connection face or the history verb (older hosts)', () => {
    assert.equal(makeContentFetcher(ctxWith({}), 's'), undefined)
    assert.equal(makeContentFetcher(ctxWith({ connection: {} }), 's'), undefined)
    assert.equal(makeContentFetcher(ctxWith({ connection: { api: { sessions: {} } } }), 's'), undefined)
  })

  test('fetches the page anchored past the seq, maps it, and caches the hit', async () => {
    const calls: { beforeSeq: number }[] = []
    const fetch = makeContentFetcher(ctxWith({
      connection: { api: apiFace([
        row('user/message', 7, { content: [{ type: 'text', text: 'CACHED BODY' }] }),
      ], calls) },
    }), 'sess-1')!
    assert.deepEqual(calls, [])
    const node = await fetch(7)
    assert.deepEqual(calls, [{ beforeSeq: 8 }])
    assert.equal((node?.content as { text: string }[])[0]?.text, 'CACHED BODY')
    // Second read hits the closure cache — no second RPC.
    const again = await fetch(7)
    assert.equal(again, node)
    assert.deepEqual(calls.length, 1)
  })

  test('a page without the seq resolves null; garbage events arrays too', async () => {
    const fetch = makeContentFetcher(ctxWith({ connection: { api: apiFace([row('user/message', 9, {})]) } }), 's')!
    assert.equal(await fetch(500), null)
    const empty = makeContentFetcher(ctxWith({
      connection: { api: { sessions: { history: async () => ({ result: { ok: true, value: {} } }) } } },
    }), 's')!
    assert.equal(await empty(1), null)
  })

  test('malformed rpc envelopes reject so the caller can offer a retry', async () => {
    const fetch = makeContentFetcher(ctxWith({
      connection: { api: { sessions: { history: async () => ({ result: { ok: false, value: undefined } }) } } },
    }), 's')!
    await assert.rejects(fetch(1))
    const noResult = makeContentFetcher(ctxWith({
      connection: { api: { sessions: { history: async () => ({}) } } },
    }), 's')!
    await assert.rejects(noResult(1))
    const scalarValue = makeContentFetcher(ctxWith({
      connection: { api: { sessions: { history: async () => ({ result: { ok: true, value: 'nope' } }) } } },
    }), 's')!
    await assert.rejects(scalarValue(1))
    const broken = makeContentFetcher(ctxWith({
      connection: { api: { sessions: { history: async () => { throw new Error('transport down') } } } },
    }), 's')!
    await assert.rejects(broken(1), /transport down/)
  })
})
