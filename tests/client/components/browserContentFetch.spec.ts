import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { SurfaceNode } from '../../../src/shared/types'
import type { ConversationNodeLike } from '../../../src/client/services'
import { click, flush, mount, query, queryAll, surfaceNode, text, type Mounted } from '../helpers/kit'
import { Browser, catRow, elemRows, props, silenceFetchWarn, tl } from './browserHarness'

describe('ContextBrowser tool results', () => {
  const cases: { seq: number; tail: string; err: boolean; label: string }[] = [
    { seq: 80, tail: 'boom\n[exit code: 3]', err: true, label: 'Failed · exit 3' },
    { seq: 81, tail: '[killed by signal: SIGKILL]', err: true, label: 'Failed' },
    { seq: 82, tail: '[shell killed by signal: SIGTERM]', err: true, label: 'Failed' },
    { seq: 83, tail: '[shell exited: code 2]', err: true, label: 'Failed · exit 2' },
    { seq: 84, tail: '[shell exited: code 0]', err: false, label: 'OK' },
    { seq: 85, tail: '[shell exited]', err: false, label: 'OK' },
    { seq: 86, tail: 'oops [exit code: 7]\n[shell killed by signal: SIGTERM]', err: true, label: 'Failed · exit 7' },
    { seq: 87, tail: '[status: killed]', err: true, label: 'Failed' },
    { seq: 88, tail: '[status: failed, boom]', err: true, label: 'Failed' },
    { seq: 89, tail: 'all good', err: false, label: 'OK' },
    { seq: 90, tail: 'a quoted [exit code: 9] marker mid-text\nmore output', err: false, label: 'OK' },
  ]
  const convNodes: ConversationNodeLike[] = cases.map(c => ({
    kind: 'tool-result', seq: c.seq,
    call: { name: 'bash', argsRaw: '{"description":"run it"}' },
    content: [{ type: 'image', attachment: { attachmentId: 'x' + String(c.seq) } }, null, { type: 'text', text: c.tail }],
  }))
  convNodes.push(
    { kind: 'tool-result', seq: 91, call: { name: 'read', argsRaw: '{}' }, content: [{ type: 'text', text: 'denied' }], isError: true },
    { kind: 'tool-result', seq: 92, call: null, content: [{ type: 'text', text: 'orphan' }] },
    { kind: 'tool-result', seq: 93, call: { name: 'bash', argsRaw: '' }, content: 'raw-text' as never },
  )
  const nodes: SurfaceNode[] = [
    ...cases.map(c => surfaceNode({ seq: c.seq, cat: 'tool', tokens: 9, tool: 'bash' })),
    surfaceNode({ seq: 91, cat: 'tool', tokens: 9, tool: 'read' }),
    surfaceNode({ seq: 92, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 93, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 94, cat: 'tool', tokens: 9, tool: 'write', err: true }),
    surfaceNode({ seq: 95, cat: 'tool', tokens: 9, tool: 'bash' }),
    surfaceNode({ seq: 96, cat: 'tool', tokens: 9 }),
    surfaceNode({ seq: 97, cat: 'tool', tokens: 9, tool: 'bash' }),
  ]
  convNodes.push({ kind: 'tool-result', seq: 97, call: { name: 'bash', argsRaw: '{}' }, content: [{ type: 'text', text: 'skill body' }] })

  const data = tl({
    current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 162, total: 162 },
    nodes,
  })

  test('tail-status matrix drives the error dot; tags and previews render on collapsed rows', async () => {
    const m = await mount(h(Browser, props({ data, convNodes })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    assert.equal(rows.length, nodes.length)
    const dots = queryAll(m.container, '.lc-br-err-dot')
    assert.equal(dots.length, 9, 'one red dot per failing result')
    assert.ok(text(rows[0]).includes('bash'))
    assert.ok(text(rows[1]).includes('?'), 'missing tool name tags as ?')
    assert.ok(text(rows[1]).includes('Tool Result'), 'no join → placeholder preview')
    assert.ok(text(rows[2]).includes('Tool Result'))
    assert.ok(text(rows[3]).includes('write'))
    const byIdx = Object.fromEntries([97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80].map((s, i) => [s, i]))
    for (const c of cases) {
      const hasDot = rows[byIdx[c.seq]].querySelector('.lc-br-err-dot') !== null
      assert.equal(hasDot, c.err, `seq ${c.seq}: dot ${c.err ? 'shown' : 'hidden'} for tail ${JSON.stringify(c.tail)}`)
    }
    assert.ok(rows[byIdx[91]].querySelector('.lc-br-err-dot') !== null, 'isError stamps the dot')
    assert.ok(rows[byIdx[94]].querySelector('.lc-br-err-dot') !== null, 'the fold err flag stamps the dot')
    assert.ok(rows[byIdx[93]].querySelector('.lc-br-err-dot') === null, 'non-array content has no markers')
    await click(rows[0])
    const content = query(m.container, '.lc-br-content')
    assert.ok(text(content).includes('OK'))
    assert.ok(text(content).includes('skill body'))
    await m.unmount()
  })

  test('clean results render the OK state; orphan results render no call card', async () => {
    const m = await mount(h(Browser, props({ data, convNodes })))
    await click(catRow(m, 'tool'))
    const rows = elemRows(m)
    const byIdx = Object.fromEntries([97, 96, 95, 94, 93, 92, 91, 90, 89, 88, 87, 86, 85, 84, 83, 82, 81, 80].map((s, i) => [s, i]))
    const expand = async (seq: number) => {
      await click(rows[byIdx[seq]])
      return query(m.container, '.lc-br-content')
    }
    let content = await expand(89)
    assert.ok(text(content).includes('OK'))
    assert.ok(!queryAll(content, '.lc-br-err-dot').length)
    await click(elemRows(m)[byIdx[89]])
    content = await expand(80)
    assert.ok(text(content).includes('Failed · exit 3'))
    await click(elemRows(m)[byIdx[80]])
    content = await expand(81)
    assert.ok(text(content).includes('Failed'))
    assert.ok(!text(content).includes('exit'))
    await click(elemRows(m)[byIdx[81]])
    content = await expand(86)
    assert.ok(text(content).includes('Failed · exit 7'))
    await click(elemRows(m)[byIdx[86]])
    content = await expand(92)
    assert.ok(!text(content).includes('→'), 'no call card without a call record')
    assert.ok(text(content).includes('orphan'))
    await click(elemRows(m)[byIdx[92]])
    content = await expand(93)
    assert.ok(text(content).includes('OK'))
    assert.ok(!text(content).includes('raw-text'))
    await m.unmount()
  })
})

describe('ContextBrowser targeted content fetch', () => {
  const data = tl({
    current: { system: 0, tools: 0, user: 10, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
    nodes: [surfaceNode({ seq: 5, tokens: 5, text: 'pageable' }), surfaceNode({ seq: 6, tokens: 5, text: 'also pageable' })],
  })

  const openFirstRow = async (m: Mounted) => {
    await click(catRow(m, 'user'))
    await click(elemRows(m)[1])
  }

  test('a missed join fetches the seq once, and the fetched body renders', async () => {
    let calls = 0
    let release: (() => void) | null = null
    const fetchContent = async (seq: number) => {
      calls += 1
      return new Promise<void>((resolve) => { release = resolve })
        .then(() => ({ kind: 'user', seq, content: [{ type: 'text', text: 'FULL BODY' }] }) as ConversationNodeLike)
    }
    const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
    await openFirstRow(m)
    assert.equal(calls, 1, 'one targeted read')
    assert.ok(text(query(m.container, '.lc-br-content')).includes('Loading full content from older session history'), 'in-flight note')
    await act(async () => { release?.() })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('FULL BODY'))
    await click(elemRows(m)[1])
    await click(elemRows(m)[1])
    assert.ok(text(query(m.container, '.lc-br-content')).includes('FULL BODY'))
    assert.equal(calls, 1, 'no second fetch for a merged seq')
    await m.unmount()
  })

  test('a page without the seq reports it as absent from the session log', async () => {
    let calls = 0
    const fetchContent = async () => {
      calls += 1
      return null
    }
    const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
    await openFirstRow(m)
    await flush()
    assert.equal(calls, 1)
    assert.ok(text(query(m.container, '.lc-br-content')).includes('not in the session log anymore'))
    await m.unmount()
  })

  test('a failed read arms the retry button; retrying succeeds', async () => {
    silenceFetchWarn()
    vi.useFakeTimers()
    try {
      let calls = 0
      let failing = true
      const fetchContent = async (seq: number) => {
        calls += 1
        if (failing) throw new Error('transport down')
        return { kind: 'user', seq, content: [{ type: 'text', text: 'RETRY BODY' }] } as ConversationNodeLike
      }
      const m = await mount(h(Browser, props({ data, convNodes: [], fetchContent })))
      await openFirstRow(m)
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      const failed = query(m.container, '.lc-br-content')
      assert.ok(text(failed).includes('Load failed'))
      assert.equal(calls, 4, 'the bounded auto-retry exhausts before arming the manual retry')
      failing = false
      await click(query(failed, '.lc-br-retry'))
      await act(async () => { await Promise.resolve() })
      assert.ok(text(query(m.container, '.lc-br-content')).includes('RETRY BODY'))
      assert.equal(calls, 5)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a session scope change refetches instead of reusing another session value', async () => {
    const fetched: string[] = []
    let session = 'A'
    const fetchContent = async (seq: number) => {
      fetched.push(session + ':' + String(seq))
      return { kind: 'user', seq, content: [{ type: 'text', text: session + ' BODY' }] } as ConversationNodeLike
    }
    const mountWith = (value: string) => props({ data, convNodes: [], fetchContent, session: value })
    const m = await mount(h(Browser, mountWith('A')))
    await openFirstRow(m)
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('A BODY'))
    session = 'B'
    await m.update(h(Browser, mountWith('B')))
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('B BODY'))
    assert.deepEqual(fetched, ['A:5', 'B:5'])
    await m.unmount()
  })

  test('a late fetch for an abandoned row never lands; the next row fetches its own seq', async () => {
    silenceFetchWarn()
    const deferreds: { resolve: (node: ConversationNodeLike | null) => void; reject: (reason: Error) => void }[] = []
    const fetchedFor: number[] = []
    const fetchContent = (seq: number): Promise<ConversationNodeLike | null> => {
      fetchedFor.push(seq)
      if (seq === 5) return new Promise((resolve, reject) => { deferreds.push({ resolve, reject }) })
      return Promise.resolve({ kind: 'user', seq, content: [{ type: 'text', text: 'BODY ' + String(seq) }] } as ConversationNodeLike)
    }
    let snap: { nodes?: readonly ConversationNodeLike[] } = { nodes: [] }
    const el = () => h(Browser, props({ data, convNodes: snap.nodes, fetchContent }))
    const m = await mount(el())
    await openFirstRow(m)
    assert.equal(deferreds.length, 1)
    await click(elemRows(m)[0])
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'))
    await act(async () => {
      deferreds[0]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'STALE BODY' }] })
    })
    assert.ok(!text(m.container).includes('STALE BODY'), 'stale result ignored')
    await click(elemRows(m)[1])
    await click(elemRows(m)[0])
    await flush()
    await act(async () => {
      deferreds[1]?.reject(new Error('gone'))
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 6'), 'stale rejection ignored')
    await click(elemRows(m)[1])
    await act(async () => {
      deferreds[2]?.resolve({ kind: 'user', seq: 5, content: [{ type: 'text', text: 'BODY 5' }] })
    })
    await flush()
    assert.ok(text(query(m.container, '.lc-br-content')).includes('BODY 5'))
    assert.deepEqual(fetchedFor, [5, 6, 5, 5], 'one call per miss (seq 6 stays cached)')
    snap = { nodes: [{ kind: 'user', seq: 5, content: [{ type: 'text', text: 'WINDOW BODY' }] }] }
    await m.update(el())
    assert.ok(text(query(m.container, '.lc-br-content')).includes('WINDOW BODY'))
    assert.ok(!text(m.container).includes('BODY 5'), 'the join takes precedence over the fetch cache')
    await m.unmount()
  })
})

