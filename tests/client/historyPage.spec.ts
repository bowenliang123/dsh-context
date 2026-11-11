import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { historyFace, makeContentFetcher, makeHeaderFetcher, pageNodesOf, subscribeHistoryFace, watchHistoryFaces, useHistoryFace } from '../../src/client/historyPage'
import { sessionAddressOf, type SessionAddressLike } from '../../src/client/services'
import { asClientCtx, TestClientCtx } from './helpers/harness'
import { flush, mount, makeKit } from './helpers/kit'
import { INSIGHT_PANEL_ID, INSIGHT_PANEL_ORDER, watchInsightPage } from '../../src/client/insightPage'
import { createContextSettings } from '../../src/client/settings'
import { resetSessionWarm, scheduleSessionWarm, useSessionDetailWarm } from '../../src/client/prefetch'
import { detailStoreOf, resetTimelineDetailStores } from '../../src/client/timelineSource'
import { copySkillPath, readSkillCatalog, setSkillCopier, skillInfoListOf } from '../../src/client/skills'

describe('historyPage', () => {

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
      { event: { type: 'user/message' } },
      { event: { type: 'user/message', seq: Number.NaN } },
      row('request/header', 1, {}),
      row('turn/end', 2, {}),
      row('tool/call', 4, {}),
      row('compaction/summary', 5, {}),
      row('compaction/summary', 6, { compactionId: 'k0', summary: [{ type: 'text', text: '   ' }] }),
      row('compaction/summary', 7, { compactionId: 'k0b', summary: 'not-an-array' }),
    ])
    assert.equal(nodes.size, 0)
    assert.deepEqual(pageNodesOf([{ event: { type: 'user/message', seq: 3 } }]).get(3), {
      kind: 'user', seq: 3, content: [],
    })
  })

  test('call heads degrade missing names and raw arguments, and read the message toolCallId when the source omits it', () => {
    const page = [
      row('tool/call', 10, { callId: 'c1' }),
      row('tool/result', 11, { message: { source: { callId: 'c1' }, content: [] } }),
      row('tool/call', 20, { callId: 'cb', name: 'read', arguments: '{"path":"a.ts"}' }),
      row('tool/result', 21, { message: { role: 'tool', toolCallId: 'cb', content: [] } }),
    ]
    const nodes = pageNodesOf(page)
    assert.deepEqual(nodes.get(11)?.call, { name: '?', argsRaw: '' })
    assert.deepEqual(nodes.get(21)?.call, { name: 'read', argsRaw: '{"path":"a.ts"}' })
  })

  test('bare event envelopes without the {event} wrapper map identically', () => {
    const nodes = pageNodesOf([{ type: 'user/message', seq: 45, time: 45, data: { content: [{ type: 'text', text: 'bare' }] } }])
    assert.deepEqual(nodes.get(45), { kind: 'user', seq: 45, content: [{ type: 'text', text: 'bare' }] })
    assert.equal(pageNodesOf([{ type: 'user/message', seq: 46 }]).get(46)?.kind, 'user')
    assert.equal(pageNodesOf(['junk', 7]).size, 0, 'scalar rows still drop')
    assert.equal(pageNodesOf([{ event: 42 }, { event: 'x' }]).size, 0, 'non-envelope event fields drop')
  })

  test('tool results pair with their in-page call head; isError rides the message mark', () => {
    const page = [
      row('tool/call', 30, { callId: 'c9', name: 'bash', arguments: '{"command":"pwd"}' }),
      row('tool/result', 31, {
        message: { role: 'tool', toolCallId: 'c9', isError: true, source: { kind: 'tool', callId: 'c9' }, content: [{ type: 'text', text: 'out' }] },
      }),
      row('tool/result', 32, {
        message: { role: 'tool', toolCallId: 'missing', isError: true, source: { kind: 'tool', callId: 'missing' }, content: [] },
      }),
      row('tool/result', 33, { message: {} }),
      row('tool/result', 34, {}),
    ]
    const nodes = pageNodesOf(page)
    const paired = nodes.get(31)
    assert.deepEqual(paired?.call, { name: 'bash', argsRaw: '{"command":"pwd"}' })
    assert.deepEqual(paired?.content, [{ type: 'text', text: 'out' }], 'the direct content blocks')
    assert.equal(paired?.isError, true, 'the message error mark')
    assert.equal(nodes.get(32)?.isError, true, 'the mark without a pairable call')
    assert.equal(nodes.get(32)?.call, null)
    assert.deepEqual(nodes.get(33)?.content, [])
    assert.equal(nodes.get(33)?.isError, false)
    assert.deepEqual(nodes.get(34), { kind: 'tool-result', seq: 34, call: null, content: [], isError: false })
  })

  test('user messages map with their durable content blocks', () => {
    const nodes = pageNodesOf([row('user/message', 10, { content: [{ type: 'text', text: 'hello' }], source: { form: 'context' } })])
    const n = nodes.get(10)
    assert.ok(n !== undefined)
    assert.equal(n.kind, 'user')
    assert.deepEqual(n.content, [{ type: 'text', text: 'hello' }])
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
    assert.deepEqual(pageNodesOf([row('assistant/message', 21, {})]).get(21), { kind: 'assistant', seq: 21, blocks: [] })
  })

  test('a compaction checkpoint renders as a compaction marker with its summary text', () => {
    const page = [
      row('compaction/summary', 40, {
        compactionId: 'k1',
        summary: [{ type: 'other' }, null, { type: 'text', text: 'the' }, { type: 'text', text: ' gist' }, 42],
      }),
      row('user/message', 41, { source: { kind: 'plugin', plugin: 'dsh-compaction', compactionId: 'k1' }, content: [{ type: 'text', text: '<envelope>' }] }),
      row('user/message', 42, { source: { kind: 'plugin', plugin: 'dsh-compaction', compactionId: 'gone' }, content: [] }),
    ]
    const nodes = pageNodesOf(page)
    assert.deepEqual(nodes.get(41), { kind: 'compaction', seq: 41, summary: 'the gist' })
    assert.deepEqual(nodes.get(42), { kind: 'compaction', seq: 42, summary: null }, 'summary outside the page degrades to null')
    const plain = pageNodesOf([row('user/message', 43, { source: { kind: 'plugin', plugin: 'other' }, content: [] })])
    assert.equal(plain.get(43)?.kind, 'user')
    assert.deepEqual(
      pageNodesOf([{ event: { type: 'user/message', seq: 44, data: 'scalar' } }]).get(44),
      { kind: 'user', seq: 44, content: [] },
    )
  })
})

function armHistoryFaces(remote: unknown): TestClientCtx {
  const ctx = new TestClientCtx()
  ctx.setService('remote', remote)
  ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
  watchHistoryFaces(asClientCtx(ctx))
  return ctx
}

const ev = (type: string, seq: number, data: unknown) => ({ type, seq, time: seq, data })

const plainOf = (sessionId: string) => (): SessionAddressLike => ({ kind: 'session', sessionId })

const pageFace = (events: unknown[], calls: unknown[] = [], envelope: (records: unknown[]) => unknown = (r) => ({ ok: true, value: { records: r } })) => ({
  page: (request: unknown) => {
    calls.push(request)
    return Promise.resolve(envelope(events.map(event => ({ type: 'event', event }))))
  },
})

describe('makeContentFetcher — the per-session targeted read', () => {
  test('undefined while the declared slot holds no face', () => {
    assert.equal(makeContentFetcher(plainOf('s')), undefined)
    assert.equal(makeHeaderFetcher(plainOf('s')), undefined)
  })

  test('fetches the page anchored past the seq, maps it, and caches the hit', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([
      ev('user/message', 7, { content: [{ type: 'text', text: 'CACHED BODY' }] }),
    ], calls) })
    const fetch = makeContentFetcher(plainOf('sess-1'))!
    assert.deepEqual(calls, [])
    const node = await fetch(7)
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 'sess-1' }, throughSeq: 7, beforeSeq: 8 }])
    assert.equal((node?.content as { text: string }[])[0]?.text, 'CACHED BODY')
    const again = await fetch(7)
    assert.equal(again, node)
    assert.equal(calls.length, 1)
    ctx.dispose()
    assert.equal(makeContentFetcher(plainOf('sess-1')), undefined, 'the unloaded slot leaves no face behind')
  })

  test('the landed cache stays bounded; the least recently read seq drops first', async () => {
    const calls: unknown[] = []
    const events = Array.from({ length: 200 }, (_, i) => ev('user/message', i + 1, { content: [{ type: 'text', text: `m${i}` }] }))
    const ctx = armHistoryFaces({ session: pageFace(events, calls) })
    const fetch = makeContentFetcher(plainOf('cap'))!
    for (let seq = 1; seq <= 200; seq++) await fetch(seq)
    assert.equal(calls.length, 200)
    await fetch(130)
    assert.equal(calls.length, 200, 'seq 130 survived the cap')
    await fetch(1)
    assert.equal(calls.length, 201, 'seq 1 was evicted and refetched')
    await fetch(130)
    await fetch(200)
    assert.equal(calls.length, 201, 'refreshed and newest entries still replay')
    ctx.dispose()
  })

  test('a cached page expires after the retention ttl', async () => {
    vi.useFakeTimers()
    try {
      const calls: unknown[] = []
      const ctx = armHistoryFaces({ session: pageFace([
        ev('user/message', 3, { content: [{ type: 'text', text: 'TTL BODY' }] }),
      ], calls) })
      const fetch = makeContentFetcher(plainOf('ttl'))!
      await fetch(3)
      assert.equal(calls.length, 1)
      vi.advanceTimersByTime(5 * 60_000)
      await fetch(3)
      assert.equal(calls.length, 2, 'the expired content is re-read')
      ctx.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a page without the seq resolves null; an empty records page too', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 9, {})], calls) })
    const fetch = makeContentFetcher(plainOf('s'))!
    assert.equal(await fetch(500), null)
    ctx.dispose()
    const empty = armHistoryFaces({ session: pageFace([]) })
    assert.equal(await makeContentFetcher(plainOf('s'))!(1), null)
    empty.dispose()
  })

  test('a payload with no rows array at all rejects (never claims absence)', async () => {
    const ctx = armHistoryFaces({ session: pageFace([], [], () => ({ ok: true, value: {} })) })
    await assert.rejects(makeContentFetcher(plainOf('s'))!(1))
    ctx.dispose()
  })

  test('a hostile or shapeless declared face leaves the slot unset (issue #42)', () => {
    const remotes = [
      { get session() { throw new Error('traced read failed') } },
      { session: null },
      { session: 'x' },
      { session: { get page() { throw new Error('hostile page read') } } },
      { session: { page: 42 } },
    ]
    for (const remote of remotes) {
      const ctx = armHistoryFaces(remote)
      assert.equal(makeContentFetcher(plainOf('s')), undefined)
      ctx.dispose()
    }
  })

  test('the declared inject never fires without both remote services, and tolerates shapeless ones', () => {
    const withoutSession = new TestClientCtx()
    withoutSession.setService('remote', { session: {} })
    watchHistoryFaces(asClientCtx(withoutSession))
    assert.equal(makeContentFetcher(plainOf('s')), undefined)
    withoutSession.dispose()

    const shapeless = new TestClientCtx()
    shapeless.setService('remote', {})
    shapeless.setService('remote.session', {})
    watchHistoryFaces(asClientCtx(shapeless))
    assert.equal(makeContentFetcher(plainOf('s')), undefined)
    shapeless.dispose()
  })

  test('the page face maps its records', async () => {
    const calls: unknown[] = []
    const records = [
      { type: 'event', event: ev('user/message', 7, { content: [{ type: 'text', text: 'PAGED BODY' }] }) },
      { type: 'chunks', event: { type: 'chunkrow/text-chunks', seq: 8, time: 8, data: { turn: 1, step: 0, index: 0, dt: [1], texts: ['delta'] } } },
    ]
    const ctx = armHistoryFaces({ session: pageFace([], calls, () => ({ ok: true, value: { records } })) })
    const node = await makeContentFetcher(plainOf('sess-9'))!(7)
    assert.deepEqual(calls, [{
      address: { kind: 'session', sessionId: 'sess-9' },
      throughSeq: 7,
      beforeSeq: 8,
    }])
    assert.equal((node?.content as { text: string }[])[0]?.text, 'PAGED BODY')
    ctx.dispose()
    const bare = armHistoryFaces({ session: pageFace([], [], () => ({ records })) })
    assert.equal((await makeContentFetcher(plainOf('s'))!(7))?.kind, 'user')
    bare.dispose()
  })

  test('a system/message event maps its prompt text; whitespace-only renders and no text block maps to null', async () => {
    const ctx = armHistoryFaces({ session: pageFace([
      ev('system/message', 7, { message: { content: [{ type: 'text', text: 'the prompt' }, { type: 'text', text: ' line two' }] } }),
      ev('system/message', 8, { message: { content: [{ type: 'text', text: '   ' }] } }),
      ev('system/message', 9, { message: { content: [{ type: 'image', attachment: {} }] } }),
      ev('system/message', 10, { message: {} }),
      ev('system/message', 11, {}),
      ev('system/message', 12, { message: { content: [7, null] } }),
    ]) })
    const fetch = makeHeaderFetcher(plainOf('s'))!
    assert.deepEqual(await fetch(7), { system: 'the prompt line two', tools: [] })
    assert.deepEqual(await fetch(8), { system: '   ', tools: [] })
    assert.equal(await fetch(9), null, 'no text block: nothing to render')
    assert.equal(await fetch(10), null)
    assert.equal(await fetch(11), null)
    assert.equal(await fetch(12), null, 'primitive elements carry no text')
    ctx.dispose()
  })

  test('malformed rpc envelopes reject so the caller can offer a retry', async () => {
    for (const page of [
      async () => null,
      async () => ({}),
      async () => ({ ok: true, value: 'nope' }),
      async () => ({ ok: false, value: undefined }),
      async () => ({ ok: true, value: { records: 'nope' } }),
      async () => { throw new Error('transport down') },
    ]) {
      const ctx = armHistoryFaces({ session: { page } })
      await assert.rejects(makeContentFetcher(plainOf('s'))!(1))
      ctx.dispose()
    }
    const broken = armHistoryFaces({ session: { page: async () => { throw new Error('transport down') } } })
    await assert.rejects(makeHeaderFetcher(plainOf('s'))!(1), /transport down/)
    broken.dispose()
  })
})

describe('makeHeaderFetcher — the lazy epoch content read', () => {
  test('fetches the epoch page, maps the raw header, and caches per seq', async () => {
    const calls: unknown[] = []
    const headerEvent = {
      type: 'request/header', seq: 5, time: 5,
      data: {
        header: {
          tools: [
            { name: 'bash', description: 'run a command', parameters: { type: 'object' } },
            { name: 'mcp__gh__issue', description: '', plugin: 'mcp:github' },
            null,
            42,
          ],
        },
      },
    }
    const ctx = armHistoryFaces({ session: pageFace([headerEvent], calls) })
    const fetch = makeHeaderFetcher(plainOf('sess'))!
    const content = await fetch(5)
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 'sess' }, throughSeq: 5, beforeSeq: 6 }])
    assert.equal(content?.system, undefined, 'a header epoch never carries prompt text (it lives in system/message)')
    assert.equal(content?.tools.length, 4)
    assert.equal(content?.tools[0]?.name, 'bash')
    assert.equal(content?.tools[0]?.description, 'run a command')
    assert.deepEqual(content?.tools[0]?.schema, headerEvent.data.header.tools[0])
    assert.equal(content?.tools[1]?.description, undefined, 'empty description omitted')
    assert.equal(content?.tools[1]?.schema, headerEvent.data.header.tools[1])
    assert.equal(content?.tools[2]?.name, '?')
    assert.equal(content?.tools[3]?.name, '?')
    assert.equal(await fetch(5), content)
    assert.equal(calls.length, 1)
    ctx.dispose()
    const bare = armHistoryFaces({ session: pageFace([ev('request/header', 2, { header: {} })]) })
    const empty = await makeHeaderFetcher(plainOf('s'))!(2)
    assert.deepEqual(empty, { tools: [] }, 'an absent tools list maps to empty tools')
    assert.equal('system' in (empty ?? {}), false)
    bare.dispose()
  })

  test('a page holding OLDER epochs caches them for free alongside the picked one', async () => {
    const olderSys = ev('system/message', 1, { message: { content: [{ type: 'text', text: 'OLD' }] } })
    const older = ev('request/header', 2, { header: { tools: [] } })
    const picked = ev('request/header', 5, { header: { tools: [] } })
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([olderSys, older, picked], calls) })
    const fetch = makeHeaderFetcher(plainOf('s'))!
    const c5 = await fetch(5)
    assert.deepEqual(c5, { tools: [] })
    assert.deepEqual(calls, [{ address: { kind: 'session', sessionId: 's' }, throughSeq: 5, beforeSeq: 6 }])
    const c2 = await fetch(2)
    assert.deepEqual(c2, { tools: [] })
    const c1 = await fetch(1)
    assert.equal(c1?.system, 'OLD', 'a system/message epoch maps to its prompt text')
    assert.equal(calls.length, 1)
    ctx.dispose()
  })

  test('a page without the epoch resolves null; a non-header-only page too', async () => {
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 9, {}), ev('request/header', 3, {})]) })
    const fetch = makeHeaderFetcher(plainOf('s'))!
    assert.equal(await fetch(500), null, 'the seq is not on the page')
    assert.equal(await fetch(3), null, 'a header envelope without a header object maps to nothing')
    ctx.dispose()
  })
})

describe('subagent sessions — the read carries the durable parent address (issue #193)', () => {
  const resolverFor = (ctx: TestClientCtx, sessionId: string) => (): SessionAddressLike => sessionAddressOf(asClientCtx(ctx), sessionId)

  test('a direct child reads its prompt and tool definitions under the subagent address', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([
      ev('system/message', 7, { message: { content: [{ type: 'text', text: 'child prompt' }] } }),
      ev('request/header', 8, { header: { tools: [{ name: 'bash', description: 'run a command' }] } }),
    ], calls) })
    ctx.setService('sessions', { subagentAddress: () => ({ parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }) })
    const fetch = makeHeaderFetcher(resolverFor(ctx, 'child'))!
    assert.deepEqual(await fetch(7), { system: 'child prompt', tools: [] })
    const tools = await fetch(8)
    assert.equal(tools?.tools[0]?.name, 'bash')
    assert.equal(tools?.tools[0]?.description, 'run a command')
    assert.deepEqual(calls, [{
      address: { kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' },
      throughSeq: 7,
      beforeSeq: 8,
    }])
    ctx.dispose()
  })

  test('a nested child names its DIRECT parent, never the root', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 3, { content: [] })], calls) })
    ctx.setService('sessions', {
      subagentAddress: (id: string) => (id === 'grandchild'
        ? { parentSessionId: 'child', childSessionId: 'grandchild', mode: 'one-shot' }
        : undefined),
    })
    await makeContentFetcher(resolverFor(ctx, 'grandchild'))!(3)
    assert.deepEqual((calls[0] as { address: unknown }).address, {
      kind: 'subagent', parentSessionId: 'child', childSessionId: 'grandchild', mode: 'one-shot',
    })
    ctx.dispose()
  })

  test('a plain session keeps the plain address under the same resolver', async () => {
    const calls: unknown[] = []
    const ctx = armHistoryFaces({ session: pageFace([ev('user/message', 3, { content: [] })], calls) })
    ctx.setService('sessions', { subagentAddress: () => undefined })
    await makeContentFetcher(resolverFor(ctx, 's'))!(3)
    assert.deepEqual((calls[0] as { address: unknown }).address, { kind: 'session', sessionId: 's' })
    ctx.dispose()
  })

  test('a parent learned after a refused read heals the retry', async () => {
    const learned: { address?: { parentSessionId: string; childSessionId: string; mode: 'continuable' } } = {}
    const calls: { address: { kind: string } }[] = []
    const ctx = armHistoryFaces({
      session: {
        page: (request: { address: { kind: string } }) => {
          calls.push(request)
          const rows = [{ type: 'event', event: ev('system/message', 7, { message: { content: [{ type: 'text', text: 'healed' }] } }) }]
          return request.address.kind === 'session'
            ? Promise.resolve({ ok: false, value: undefined })
            : Promise.resolve({ ok: true, value: { records: rows } })
        },
      },
    })
    ctx.setService('sessions', { subagentAddress: () => learned.address })
    const fetch = makeHeaderFetcher(resolverFor(ctx, 'child'))!
    await assert.rejects(fetch(7))
    learned.address = { parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable' }
    assert.deepEqual(await fetch(7), { system: 'healed', tools: [] })
    assert.deepEqual(calls[1]?.address, {
      kind: 'subagent', parentSessionId: 'parent', childSessionId: 'child', mode: 'continuable',
    })
    ctx.dispose()
  })
})

describe('the declared-face store — resolution, revocation, and the mount race', () => {
  test('the face resolves late (watch armed before the services) and clears on unload', () => {
    const ctx = new TestClientCtx()
    watchHistoryFaces(asClientCtx(ctx))
    assert.equal(historyFace(), undefined)
    assert.equal(makeContentFetcher(plainOf('s')), undefined)
    ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    ctx.setService('remote', { session: pageFace([ev('user/message', 1, {})]) })
    assert.ok(historyFace() !== undefined, 'the late-fired inject resolved the face')
    assert.ok(makeContentFetcher(plainOf('s')) !== undefined, 'a fetcher built after the landing face exists')
    ctx.dispose()
    assert.equal(historyFace(), undefined, 'unload revokes the face')
    assert.equal(makeContentFetcher(plainOf('s')), undefined)
  })

  test('subscribers hear resolution and revocation; unsubscribing stops the channel', () => {
    const seen: (undefined | ReturnType<typeof historyFace>)[] = [historyFace()]
    const unsubscribe = subscribeHistoryFace(() => { seen.push(historyFace()) })
    const ctx = armHistoryFaces({ session: pageFace([]) })
    ctx.dispose()
    unsubscribe()
    const before = seen.length
    armHistoryFaces({ session: pageFace([]) }).dispose()
    assert.equal(seen.length, before, 'an unsubscribed listener hears nothing more')
    assert.equal(seen[0], undefined, 'the channel starts from the current face')
    assert.equal(seen[seen.length - 1], undefined)
  })

  test('useHistoryFace re-renders a mount that raced the inject (the auto-heal)', async () => {
    function FaceProbe(): ReactElement {
      const face = useHistoryFace()
      return h('div', null, face === undefined ? 'no-face' : 'has-face')
    }
    const ctx = new TestClientCtx()
    watchHistoryFaces(asClientCtx(ctx))
    const m = await mount(h(FaceProbe))
    assert.equal(m.container.textContent, 'no-face', 'a mount before the inject sees no face')
    await act(async () => {
      ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
      ctx.setService('remote', { session: pageFace([ev('user/message', 1, {})]) })
    })
    await flush()
    assert.equal(m.container.textContent, 'has-face', 'the landing face re-renders the racer')
    await act(async () => {
      ctx.dispose()
    })
    assert.equal(m.container.textContent, 'no-face')
    await m.unmount()
  })
})
})

describe('insightPage', () => {

const NS = 'dsh-context'

function page(_props: { sessionId?: string } & Record<string, unknown>): null {
  return null
}

describe('watchInsightPage', () => {
  test("the default 'show' mounts both registrations under one identity", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)

    const main = ctx.slots.of('main')
    assert.equal(main.length, 1, 'the page rides the keyed main seat')
    assert.equal(main[0].registration.name, 'main')
    assert.equal(main[0].registration.key, INSIGHT_PANEL_ID)
    assert.equal(main[0].registration.locale, NS)
    assert.equal(main[0].component, page, 'the page component registered verbatim')

    const entries = ctx.slots.of('sidebar.panellist')
    assert.equal(entries.length, 1, 'the entry rides the sidebar panel list')
    assert.equal(entries[0].registration.name, 'sidebar.panellist')
    assert.equal(entries[0].registration.id, INSIGHT_PANEL_ID, 'the entry id addresses the main panel')
    assert.equal(entries[0].registration.order, INSIGHT_PANEL_ORDER)
    assert.equal(entries[0].registration.locale, NS)
    assert.equal(entries[0].registration.label?.(), 'Context Insights', 'the label thunk resolves the page title')
    const iconEl = entries[0].component({ size: 16 }) as ReactElement
    assert.equal((iconEl.type as { name: string }).name, 'InsightPanelIcon', 'the entry glyph component')
    const defaults = entries[0].component({}) as ReactElement
    assert.equal((defaults.type as { name: string }).name, 'InsightPanelIcon', 'the size seat defaults')
    dispose()
  })

  test("'hide' unwinds both registrations and 'show' remounts them; a 'hide' start mounts nothing; the disposer unwinds once and is repeat-safe", () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(asClientCtx(ctx), settings, page, t, NS)
    assert.equal(ctx.slots.of('main').length, 1)

    settings.set('insightsEntry', 'hide')
    assert.equal(ctx.slots.of('main').length, 0, 'hiding the entry unwinds the page')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 0, 'hiding unwinds the entry')

    settings.set('insightsEntry', 'show')
    assert.equal(ctx.slots.of('main').length, 1, 'showing remounts the pair')
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)

    settings.set('defaultGranularity', 'turn')
    assert.equal(ctx.slots.of('main').length, 1)
    assert.equal(ctx.slots.of('sidebar.panellist').length, 1)
    dispose()

    const hidden = new TestClientCtx()
    const hiddenSettings = createContextSettings()
    hiddenSettings.set('insightsEntry', 'hide')
    const disposeHidden = watchInsightPage(asClientCtx(hidden), hiddenSettings, page, t, NS)
    assert.equal(hidden.slots.of('main').length, 0)
    assert.equal(hidden.slots.of('sidebar.panellist').length, 0)
    disposeHidden()
    hiddenSettings.set('insightsEntry', 'show')
    assert.equal(hidden.slots.of('main').length, 0)

    const live = new TestClientCtx()
    const liveSettings = createContextSettings()
    const disposeLive = watchInsightPage(asClientCtx(live), liveSettings, page, t, NS)
    disposeLive()
    assert.equal(live.slots.of('main').length, 0, 'the disposer unwinds the live mount')
    assert.equal(live.slots.of('sidebar.panellist').length, 0)
    assert.doesNotThrow(disposeLive, 'the disposer is safe to repeat')
  })

  test('a slots face returning no disposer is tolerated across flips and dispose', () => {
    const bare = {
      slots: {
        inject: (_name: string, cb: () => unknown) => { cb(); return undefined },
        register: () => undefined,
      },
    }
    const settings = createContextSettings()
    const { t } = makeKit()
    const dispose = watchInsightPage(bare as never, settings, page, t, NS)
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'hide') })
    assert.doesNotThrow(() => { settings.set('insightsEntry', 'show') })
    assert.doesNotThrow(dispose)
  })
})
})

describe('prefetch', () => {

function detail(rev: number): unknown {
  return {
    rev,
    requests: [], events: [], nodes: [], droppedNodes: 0, archive: [],
    head: {
      ok: true,
      current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
      detailRev: rev,
    },
  }
}

function stubDetail(rev = 1): { reads: string[] } {
  const reads: string[] = []
  vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
    const id = JSON.parse(init?.body ?? '{}').sessionId as string
    reads.push(id)
    return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(rev) }) }
  })
  return { reads }
}

afterEach(() => {
  resetSessionWarm()
  resetTimelineDetailStores()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('scheduleSessionWarm', () => {
  test('invalid ids and revisions arm nothing', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('', 1)
    scheduleSessionWarm(undefined, 1)
    scheduleSessionWarm('s1', null)
    scheduleSessionWarm('s1', -1)
    scheduleSessionWarm('s1', Number.NaN)
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, [])
  })

  test('a newer revision updates the pending target without moving the deadline; a replay is covered', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('s1', 1)
    await vi.advanceTimersByTimeAsync(500)
    scheduleSessionWarm('s1', 2)
    await vi.advanceTimersByTimeAsync(401)
    assert.deepEqual(reads, ['s1'], 'the original 900ms deadline fired with the newest revision')
    scheduleSessionWarm('s1', 1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, ['s1'], 'the landed revision covers a replay')
  })

  test('the fired window warms the newest scheduled revision, not the first', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail(5)
    detailStoreOf('s1').warm(5)
    await vi.advanceTimersByTimeAsync(0)
    assert.deepEqual(reads, ['s1'])
    scheduleSessionWarm('s1', 1)
    scheduleSessionWarm('s1', 6)
    await vi.advanceTimersByTimeAsync(900)
    assert.deepEqual(reads, ['s1', 's1'], 'the upgraded revision warmed the channel')
  })

  test('the pending map stays bounded under a burst of sessions', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    for (let i = 0; i < 33; i++) scheduleSessionWarm('s' + i, 1)
    await vi.advanceTimersByTimeAsync(900)
    assert.equal(reads.length, 32, 'the oldest pending warm-up was evicted')
    assert.equal(reads.includes('s0'), false)
    assert.equal(reads.includes('s32'), true)
  })
})

describe('useSessionDetailWarm', () => {
  test('the rendered session and its split head arm the warm-up; a head without a revision does not', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(props: { useProjection?: unknown }): null {
      useSessionDetailWarm('s1', props.useProjection)
      return null
    }
    const m = await mount(h(Probe, { useProjection: () => ({ detailRev: 4 }) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    assert.deepEqual(reads, ['s1'])
    await m.update(h(Probe, { useProjection: () => ({}) }))
    await act(async () => { await vi.advanceTimersByTimeAsync(900) })
    assert.deepEqual(reads, ['s1'], 'an inline head arms nothing')
    await m.unmount()
  })
})

describe('useSessionDetailWarm — teardown', () => {
  test('a mount without a projection seat arms nothing', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm('s1', undefined)
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
    await m.unmount()
  })

  test('a missing session id arms nothing and unmounts cleanly', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm(undefined, () => ({ detailRev: 2 }))
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
    await m.unmount()
  })

  test('unmounting before the window cancels the pending warm-up', async () => {
    vi.useFakeTimers()
    const { reads } = stubDetail()
    function Probe(): null {
      useSessionDetailWarm('s1', () => ({ detailRev: 2 }))
      return null
    }
    const m = await mount(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
    await m.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
    assert.deepEqual(reads, [])
  })
})

describe('scheduleSessionWarm — dedupe and reset', () => {
  test('a pending session ignores a lower or equal revision, and reset clears an armed timer', async () => {
    resetSessionWarm()
    resetTimelineDetailStores()
    vi.useFakeTimers()
    const { reads } = stubDetail()
    scheduleSessionWarm('dedupe', 2)
    scheduleSessionWarm('dedupe', 1)
    scheduleSessionWarm('dedupe', 2)
    await vi.advanceTimersByTimeAsync(901)
    assert.deepEqual(reads, ['dedupe'])
    scheduleSessionWarm('dedupe-2', 1)
    resetSessionWarm()
    await vi.advanceTimersByTimeAsync(1000)
    assert.deepEqual(reads, ['dedupe'], 'reset cleared the armed timer')
  })
})
})

describe('skills', () => {

afterEach(() => {
  setSkillCopier(null)
  vi.unstubAllGlobals()
})

describe('skillInfoListOf', () => {
  test('absent or malformed payloads read null', () => {
    assert.equal(skillInfoListOf(null), null)
    assert.equal(skillInfoListOf('x'), null)
    assert.equal(skillInfoListOf([]), null)
    assert.equal(skillInfoListOf({}), null)
    assert.equal(skillInfoListOf({ skills: 'nope' }), null)
  })

  test('entries failing the name proof drop individually; the proved fields ride alone', () => {
    assert.deepEqual(skillInfoListOf({
      skills: [
        null,
        'row',
        [],
        { description: 'no name' },
        { name: '' },
        { name: 42 },
        { name: 'bare' },
        { name: 'full', description: 'd', path: '/p/SKILL.md', source: 'bundled' },
        { name: 'odd', description: 7, path: '', source: '' },
      ],
    }), [
      { name: 'bare', description: '' },
      { name: 'full', description: 'd', path: '/p/SKILL.md', source: 'bundled' },
      { name: 'odd', description: '' },
    ])
  })
})

describe('readSkillCatalog', () => {
  function stubFetch(mode: 'ok' | 'reject' | 'status' | 'badjson', body?: unknown): { urls: string[]; bodies: unknown[] } {
    const urls: string[] = []
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      urls.push(String(url))
      bodies.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
      if (mode === 'reject') throw new Error('down')
      if (mode === 'status') return { ok: false, json: async () => ({}) } as unknown as Response
      if (mode === 'badjson') return { ok: true, json: () => Promise.reject(new Error('not json')) } as unknown as Response
      return { ok: true, json: async () => body } as unknown as Response
    })
    return { urls, bodies }
  }

  test('a served catalog narrows into the name-keyed map; the cwd and session id ride the body', async () => {
    const { urls, bodies } = stubFetch('ok', {
      ok: true,
      value: {
        skills: [
          { name: 'tdd', description: 'Test-driven', path: '/p/tdd/SKILL.md', source: 'user-agents' },
          { name: 'ask-matt', description: 'A router' },
        ],
      },
    })
    const catalog = await readSkillCatalog('/repo/alpha', 's1')
    assert.deepEqual(urls, ['api/dsh-context/skills'])
    assert.deepEqual(bodies, [{ cwd: '/repo/alpha', sessionId: 's1' }])
    assert.equal(catalog?.size, 2)
    assert.deepEqual(catalog?.get('tdd'), { name: 'tdd', description: 'Test-driven', path: '/p/tdd/SKILL.md', source: 'user-agents' })
  })

  test('a context-less open posts an empty body', async () => {
    const { bodies } = stubFetch('ok', { ok: true, value: { skills: [{ name: 'tdd' }] } })
    await readSkillCatalog(undefined, undefined)
    assert.deepEqual(bodies, [{}])
  })

  test('every failure or empty answer reads null, never a rejection', async () => {
    stubFetch('reject')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('status')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('badjson')
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', {})
    assert.equal(await readSkillCatalog(undefined, undefined), null, 'no ok flag')
    stubFetch('ok', { ok: false, value: { skills: [{ name: 'tdd' }] } })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', { ok: true, value: null })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
    stubFetch('ok', { ok: true, value: { skills: [] } })
    assert.equal(await readSkillCatalog(undefined, undefined), null, 'an empty catalog is no enrichment')
    stubFetch('ok', { ok: true, value: { skills: 'x' } })
    assert.equal(await readSkillCatalog(undefined, undefined), null)
  })
})

describe('copySkillPath', () => {
  test('the seam’s write resolves true; a throwing write resolves false', async () => {
    const seen: string[] = []
    setSkillCopier(async (text) => { seen.push(text) })
    assert.equal(await copySkillPath('/p/tdd/SKILL.md'), true)
    assert.deepEqual(seen, ['/p/tdd/SKILL.md'])
    setSkillCopier(async () => { throw new Error('denied') })
    assert.equal(await copySkillPath('/p/tdd/SKILL.md'), false)
  })

  test('the default write rides the platform clipboard; an absent API fails the copy', async () => {
    const written: string[] = []
    vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { written.push(text) } } })
    assert.equal(await copySkillPath('/p/a/SKILL.md'), true)
    assert.deepEqual(written, ['/p/a/SKILL.md'])
    vi.stubGlobal('navigator', {})
    assert.equal(await copySkillPath('/p/a/SKILL.md'), false)
    vi.stubGlobal('navigator', undefined)
    assert.equal(await copySkillPath('/p/a/SKILL.md'), false)
  })
})
})
