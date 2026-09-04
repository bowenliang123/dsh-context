// historyPage (src/client/historyPage.ts): the targeted content fetch — raw
// durable-log pages mapped into the browser's conversation-node shapes, plus
// the per-session fetcher built over the shared api client.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeContentFetcher, makeHeaderFetcher, pageNodesOf, watchHistoryFaces } from '../../src/client/historyPage'
import { asClientCtx, TestClientCtx } from './helpers/harness'

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

  test('bare event envelopes without the {event} wrapper map identically', () => {
    // Shape-drift tolerance: a face that serves the envelope unwrapped.
    const nodes = pageNodesOf([{ type: 'user/message', seq: 45, time: 45, data: { content: [{ type: 'text', text: 'bare' }] } }])
    assert.deepEqual(nodes.get(45), { kind: 'user', seq: 45, content: [{ type: 'text', text: 'bare' }] })
    assert.equal(pageNodesOf([{ type: 'user/message', seq: 46 }]).get(46)?.kind, 'user')
    assert.equal(pageNodesOf(['junk', 7]).size, 0, 'scalar rows still drop')
    assert.equal(pageNodesOf([{ event: 42 }, { event: 'x' }]).size, 0, 'non-envelope event fields drop')
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

/** Arm the DECLARED inject with one `remote` facade (the way the harness
 * serves it) and prove the fetchers read through that path only. The direct
 * `remote.session` service is hostile on purpose — an undeclared read of the
 * traced proxy throws on the real host, so the declared path must be the one
 * that carries the read. Dispose the returned ctx to unload the slot. */
function armHistoryFaces(remote: unknown): TestClientCtx {
  const ctx = new TestClientCtx()
  ctx.setService('remote', remote)
  ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
  watchHistoryFaces(asClientCtx(ctx))
  return ctx
}

/** One raw durable-log event, as a page record carries it. */
const ev = (type: string, seq: number, data: unknown) => ({ type, seq, time: seq, data })

/** The gateway session-page face: records of `{type:'event', event}` rows. */
const pageFace = (events: unknown[], calls: unknown[] = [], envelope: (records: unknown[]) => unknown = (r) => ({ ok: true, value: { records: r } })) => ({
  page: (request: unknown) => {
    calls.push(request)
    return Promise.resolve(envelope(events.map(event => ({ type: 'event', event }))))
  },
})

describe('makeContentFetcher — the per-session targeted read', () => {
  test('undefined while the declared slot holds no face', () => {
    assert.equal(makeContentFetcher('s'), undefined)
  })

  test('fetches the page anchored past the seq, maps it, and caches the hit', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([
      ev('user/message', 7, { content: [{ type: 'text', text: 'CACHED BODY' }] }),
    ], calls) })
    const fetch = makeContentFetcher('sess-1')!
    assert.deepEqual(calls, [])
    const node = await fetch(7)
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 7, beforeSeq: 8 }])
    assert.equal((node?.content as { text: string }[])[0]?.text, 'CACHED BODY')
    // Second read hits the closure cache — no second RPC.
    const again = await fetch(7)
    assert.equal(again, node)
    assert.equal(calls.length, 1)
    // Unload clears the slot: nothing stales across plugin reloads.
    ctx.dispose()
    assert.equal(makeContentFetcher('sess-1'), undefined, 'the unloaded slot leaves no face behind')
  })

  test('a page without the seq resolves null; an empty records page too', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 9, {})], calls) })
    const fetch = makeContentFetcher('s')!
    assert.equal(await fetch(500), null)
    ctx.dispose()
    const empty = armHistoryFaces({ session: pageFace([]) })
    assert.equal(await makeContentFetcher('s')!(1), null)
    empty.dispose()
  })

  test('a payload with no rows array at all rejects (never claims absence)', async () => {
    const ctx = armHistoryFaces({ session: pageFace([], [], () => ({ ok: true, value: {} })) })
    await assert.rejects(makeContentFetcher('s')!(1))
    ctx.dispose()
  })

  test('a hostile or shapeless declared face leaves the slot unset (issue #42)', () => {
    // The traced proxy can throw on the property READ itself, or serve a
    // null / primitive / verb-less / hostile-verb face — the declared
    // callback contains all of it, the slot stays unset, and the fetcher
    // degrades instead of taking the view down.
    const remotes = [
      { get session() { throw new Error('traced read failed') } },
      { session: null },
      { session: 'x' },
      { session: { get page() { throw new Error('hostile page read') } } },
      { session: { page: 42 } },
    ]
    for (const remote of remotes) {
      const ctx = armHistoryFaces(remote)
      assert.equal(makeContentFetcher('s'), undefined)
      ctx.dispose()
    }
  })

  test('the declared inject never fires without both remote services', () => {
    const ctx = new TestClientCtx()
    // Only `remote`: the injected fiber requires BOTH names, so nothing fires.
    ctx.setService('remote', { session: {} })
    watchHistoryFaces(asClientCtx(ctx))
    assert.equal(makeContentFetcher('s'), undefined)
    ctx.dispose()
  })

  test('the declared inject tolerates a shapeless remote service', () => {
    const ctx = new TestClientCtx()
    // Both names exist but the facade bears no session namespace: the
    // callback fires and leaves the slot unset, never throwing.
    ctx.setService('remote', {})
    ctx.setService('remote.session', {})
    watchHistoryFaces(asClientCtx(ctx))
    assert.equal(makeContentFetcher('s'), undefined)
    ctx.dispose()
  })

  test('the page face maps its records', async () => {
    const calls: unknown[] = []
    // The real shape: the remote resolves to the ClientResult itself.
    const records = [
      { type: 'event', event: ev('user/message', 7, { content: [{ type: 'text', text: 'PAGED BODY' }] }) },
      // A packed chunk-row record projects to nothing — only final events matter.
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 8, time: 8, data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['delta'] } } },
    ]
    const ctx = armHistoryFaces({ session: pageFace([], calls, () => ({ ok: true, value: { records } })) })
    const node = await makeContentFetcher('sess-9')!(7)
    assert.deepEqual(calls, [{
      address: { kind: 'session', sessionId: 'sess-9' },
      throughSeq: 7,
      beforeSeq: 8,
    }])
    assert.equal((node?.content as { text: string }[])[0]?.text, 'PAGED BODY')
    ctx.dispose()
    // A bare (non-enveloped) SessionPage passes too.
    const bare = armHistoryFaces({ session: pageFace([], [], () => ({ records })) })
    assert.equal((await makeContentFetcher('s')!(7))?.kind, 'user')
    bare.dispose()
  })

  test('page-face failures reject so the caller can offer a retry', async () => {
    const badTop = armHistoryFaces({ session: { page: async () => ({ ok: false, error: { message: 'gone' } }) } })
    await assert.rejects(makeContentFetcher('s')!(1))
    badTop.dispose()
    const garbage = armHistoryFaces({ session: { page: async () => ({ records: 'nope' }) } })
    await assert.rejects(makeContentFetcher('s')!(1))
    garbage.dispose()
    const broken = armHistoryFaces({ session: { page: async () => { throw new Error('transport down') } } })
    await assert.rejects(makeContentFetcher('s')!(1), /transport down/)
    broken.dispose()
  })

  test('malformed rpc envelopes reject so the caller can offer a retry', async () => {
    const nullResponse = armHistoryFaces({ session: { page: async () => null } })
    await assert.rejects(makeContentFetcher('s')!(1))
    nullResponse.dispose()
    const noResult = armHistoryFaces({ session: { page: async () => ({}) } })
    await assert.rejects(makeContentFetcher('s')!(1))
    noResult.dispose()
    const scalarValue = armHistoryFaces({ session: { page: async () => ({ ok: true, value: 'nope' }) } })
    await assert.rejects(makeContentFetcher('s')!(1))
    scalarValue.dispose()
  })
})

describe('makeHeaderFetcher — the lazy epoch content read', () => {
  test('undefined while the declared slot holds no face', () => {
    assert.equal(makeHeaderFetcher('s'), undefined)
  })

  test('fetches the epoch page, maps the raw header, and caches per seq', async () => {
    const calls: unknown[] = []
    const headerEvent = {
      type: 'request/header', seq: 5, time: 5,
      data: {
        header: {
          system: 'You are an agent.',
          tools: [
            { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
            { name: 'mcp__gh__issue', description: '', plugin: 'mcp:github' },
            null, // hostile entry degrades to an unnamed row
            42,
          ],
        },
      },
    }
    const ctx = armHistoryFaces({ session: pageFace([headerEvent], calls) })
    const fetch = makeHeaderFetcher('sess')!
    const content = await fetch(5)
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 'sess' }, throughSeq: 5, beforeSeq: 6 }])
    assert.equal(content?.system, 'You are an agent.')
    assert.equal(content?.tools.length, 4)
    assert.equal(content?.tools[0]?.name, 'bash')
    assert.equal(content?.tools[0]?.description, 'run a command')
    assert.deepEqual(content?.tools[0]?.schema, headerEvent.data.header.tools[0])
    assert.equal(content?.tools[1]?.description, undefined, 'empty description omitted')
    assert.equal(content?.tools[1]?.schema, headerEvent.data.header.tools[1])
    assert.equal(content?.tools[2]?.name, '?')
    assert.equal(content?.tools[3]?.name, '?')
    // Cached: the second read of the epoch costs no RPC.
    assert.equal(await fetch(5), content)
    assert.equal(calls.length, 1)
    ctx.dispose()
  })

  test('an epoch with no system text and an absent tools list maps to empty tools', async () => {
    const ctx = armHistoryFaces({ session: pageFace([ev('request/header', 2, { header: {} })]) })
    const content = await makeHeaderFetcher('s')!(2)
    assert.deepEqual(content, { tools: [] })
    assert.equal('system' in (content ?? {}), false)
    ctx.dispose()
  })

  test('a page holding OLDER epochs caches them for free alongside the picked one', async () => {
    const older = ev('request/header', 1, { header: { system: 'OLD', tools: [] } })
    const picked = ev('request/header', 5, { header: { system: 'NEW', tools: [] } })
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([older, picked], calls) })
    const fetch = makeHeaderFetcher('s')!
    const c5 = await fetch(5)
    assert.equal(c5?.system, 'NEW')
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 's' }, throughSeq: 5, beforeSeq: 6 }])
    // The older epoch resolves from the cache — no second page read.
    const c1 = await fetch(1)
    assert.equal(c1?.system, 'OLD')
    assert.equal(calls.length, 1)
    ctx.dispose()
  })

  test('a page without the epoch resolves null; a non-header-only page too', async () => {
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 9, {}), ev('request/header', 3, {})]) })
    const fetch = makeHeaderFetcher('s')!
    assert.equal(await fetch(500), null, 'the seq is not on the page')
    assert.equal(await fetch(3), null, 'a header envelope without a header object maps to nothing')
    ctx.dispose()
  })

  test('malformed rpc envelopes reject so the caller can offer a retry', async () => {
    const rejector = armHistoryFaces({ session: { page: async () => ({ ok: false, value: undefined }) } })
    await assert.rejects(makeHeaderFetcher('s')!(1))
    rejector.dispose()
    const rowsGarbage = armHistoryFaces({ session: { page: async () => ({ ok: true, value: { records: 'nope' } }) } })
    await assert.rejects(makeHeaderFetcher('s')!(1))
    rowsGarbage.dispose()
    const broken = armHistoryFaces({ session: { page: async () => { throw new Error('transport down') } } })
    await assert.rejects(makeHeaderFetcher('s')!(1), /transport down/)
    broken.dispose()
  })
})
