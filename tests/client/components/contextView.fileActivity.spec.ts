import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import type { UseChatLike } from '../../../src/client/services'
import type { ContextTimeline } from '../../../src/shared/types'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, T0, timeline } from './contextViewHarness'

describe('ContextView — file activity card', () => {
  // Chart hover previews the browser/file activity after a short rest; a rapid sweep keeps only the trailing
  // value (contextView's hover debounce), so tests wait for the trailing update before asserting.
  const rest = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 200))
  /** Six steps with two file ops: a live read (seq 3) and an edit (seq 5) compacted away before seq 6 dispatched. */
  function fileTimeline(): ContextTimeline {
    const req = (seq: number, time: number, extra: Record<string, unknown> = {}) =>
      ({ seq, time, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70, ...extra })
    return timeline({
      requests: [
        req(2, T0 + 1000, { turn: 1, step: 1 }),
        req(4, T0 + 3000, { turn: 1, step: 2 }),
        req(6, T0 + 5000), // two turn-less mid-session steps form their own aggregate
        req(7, T0 + 6000),
        req(8, T0 + 7000, { turn: 2, step: 1 }), // a single-step turn, not the last bar
        req(9, T0 + 8000, { turn: 3, step: 1 }),
      ],
      nodes: [
        { seq: 1, cat: 'user', tokens: 10, text: 'hi', time: T0 + 500 },
        { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
        { seq: 3, cat: 'tool', tokens: 30, tool: 'read', time: T0 + 2000 },
        { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
        { seq: 6, cat: 'assistant', tokens: 80, text: 'r3', time: T0 + 5000 },
        { seq: 7, cat: 'assistant', tokens: 80, text: 'r3b', time: T0 + 6000 },
        { seq: 8, cat: 'assistant', tokens: 80, text: 'r4', time: T0 + 7000 },
        { seq: 9, cat: 'assistant', tokens: 80, text: 'r5', time: T0 + 8000 },
      ],
      archive: [
        { seq: 5, cat: 'tool', tokens: 30, tool: 'edit', gone: 6, time: T0 + 4000 },
      ],
    })
  }

  const fileConv = [
    { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/src/a.ts' }) } },
    { kind: 'tool', seq: 5, call: { name: 'edit', argsRaw: JSON.stringify({ file_path: '/src/a.ts', old_string: 'a\nb', new_string: 'a' }) } },
  ]

  async function mountFiles(sessionId: string) {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId,
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: fileConv } })) as UseChatLike,
    }))
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    return { m, card }
  }

  test('follows the chart pick: the scope label and the exclusive next-step bound', async () => {
    const { m, card } = await mountFiles('sv-files-scope')
    assert.ok(text(card).includes(DICT_EN['files.scopeLatest']))
    assert.ok(text(card).includes('+1') && text(card).includes('−2'))

    // Hovering the FIRST bar bounds the fold at the second request: the edit drops out.
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await rest()
    assert.ok(text(card).includes('Turn 1 · Step 1'))
    assert.equal(queryAll(card, '.lc-fa-meta-delta').length, 0)
    assert.equal(queryAll(card, '.lc-fa-row').length, 1)
    assert.ok(!text(card).includes('+1'))

    // The turn-less mid step falls back to zero labels and still bounds at the next request.
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    await rest()
    assert.ok(text(card).includes('Turn 0 · Step 0'))
    assert.ok(text(card).includes('+1'))

    await unhover(query(m.container, '.lc-chart'))
    assert.ok(text(card).includes(DICT_EN['files.scopeLatest']))
    await m.unmount()
  })

  test('a rapid second hover keeps only the trailing preview', async () => {
    const { m, card } = await mountFiles('sv-files-trailing')
    // Freeze the hover clock across both moves: the first previews immediately, the second can only trail.
    const frozen = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(frozen)
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await hover(query(m.container, '.lc-bar[data-seq="4"]'))
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    clock.mockRestore()
    await rest()
    assert.ok(text(card).includes('Turn 0 · Step 0'))
    await m.unmount()
  })

  test('DNA mode waits for the pointer to rest before updating the preview', async () => {
    const { m, card } = await mountFiles('sv-files-dna-hover')
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await new Promise(resolve => setTimeout(resolve, 80))
    // The chart lights its own bar immediately; the cross-card preview stays on the latest scope.
    assert.ok(text(card).includes(DICT_EN['files.scopeLatest']))
    await new Promise(resolve => setTimeout(resolve, 300))
    assert.ok(text(card).includes('Turn 1 · Step 1'))
    await m.unmount()
  })

  test('turn aggregates label the scope; op clicks reveal the result in the browser', async () => {
    const { m, card } = await mountFiles('sv-files-locate')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    await hover(query(m.container, '.lc-bar[data-seq="4"]'))
    await rest()
    assert.ok(text(card).includes(DICT_EN['detail.turn'].replace('{t}', '1').replace('{n}', '2')))
    await hover(query(m.container, '.lc-bar[data-seq="7"]'))
    await rest()
    assert.ok(text(card).includes(DICT_EN['detail.turn'].replace('{t}', '0').replace('{n}', '2')))
    await hover(query(m.container, '.lc-bar[data-seq="8"]'))
    await rest()
    assert.ok(text(card).includes('Turn 2 · Step 1'))
    await unhover(query(m.container, '.lc-chart'))

    // Expand the file row: the compacted edit (seq 5) has no viewing step and
    // its click is a no-op; the read (seq 3) reveals in step 4's surface.
    await click(query(card, '.lc-fa-row'))
    const ops = queryAll(card, '.lc-fa-op')
    assert.equal(ops.length, 2)
    await click(ops[0]) // edit, gone = 6: unlocatable
    assert.equal(pick.value, 'live')
    await click(ops[1]) // read at seq 3
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('/src/a.ts'))
    await m.unmount()
  })

  test('a nested PTC op reveals on its parent run_code result, not on its dispatch seq', async () => {
    const ptcTimeline = timeline({
      requests: [
        { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70 },
        { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70 },
      ],
      nodes: [
        { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
        { seq: 3, cat: 'tool', tokens: 30, tool: 'run_code', time: T0 + 2000 },
        { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
      ],
    })
    const ptcConv = [
      {
        kind: 'tool-result',
        seq: 3,
        call: { name: 'run_code', argsRaw: JSON.stringify({ code: 'await tools.edit(…)', description: 'Fix the failing test' }) },
        subCalls: [
          {
            kind: 'tool-result',
            seq: 2,
            time: T0 + 1500,
            call: { name: 'edit', argsRaw: JSON.stringify({ file_path: '/src/a.ts', old_string: 'a\nb', new_string: 'a' }) },
            isError: false,
            subCalls: [],
          },
        ],
      },
    ]
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-ptc-locate',
      useProjection: projectionsFor(ptcTimeline),
      useChat: (sel =>
        sel({
          legacy: { nodes: ptcConv } })) as UseChatLike,
    }))
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    await click(query(card, '.lc-fa-row'))
    // The op is attributed to the nested tool, and says why (its program).
    assert.ok(text(card).includes('edit'))
    assert.ok(text(card).includes('Fix the failing test'))
    // The click lands on the parent run_code node (seq 3 → step 4's surface).
    await click(query(card, '.lc-fa-op'))
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('Fix the failing test'))
    await m.unmount()
  })

  test('the session workspace relativizes row paths; the host opener opens the resolved file', async () => {
    const opened: string[] = []
    const calls: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'sv-files-open': { cwd: '/repo' } } }) } },
        connection: {
          isLoopback: true,
          rpc: {
            call: (_channel: string, endpoint: string, payload: unknown) => {
              if (endpoint === 'session/canOpenWorkspacePath') return Promise.resolve({ ok: true, value: true })
              calls.push(endpoint)
              opened.push((payload as { args: { request: { path: string } } }).args.request.path)
              return Promise.resolve({ ok: true, value: { opened: true } })
            },
          },
        },
      },
    })
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/repo/src/a.ts' }) } },
    ]
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-files-open',
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: conv } })) as UseChatLike,
    }))
    // The capability probe is an RPC round-trip: the answer lands in state on the next flush.
    await flush()
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    const row = query(card, '.lc-fa-row')
    assert.ok(row.querySelector('.lc-fa-path em')?.textContent === 'src/')
    const name = query(row, '.lc-fa-file')
    assert.equal(name.getAttribute('title'), DICT_EN['files.open'])
    await click(name)
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    assert.deepEqual(calls, ['session/openWorkspacePath'])
    await m.unmount()
  })

  test('the Sidebar preview leads the name click; a refusal falls through to the system opener', async () => {
    const previewed: string[] = []
    const opened: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'sv-preview': { cwd: '/repo' } } }) } },
        connection: {
          isLoopback: true,
          rpc: {
            call: (_channel: string, endpoint: string, payload: unknown) => {
              if (endpoint === 'session/canOpenWorkspacePath') return Promise.resolve({ ok: true, value: true })
              opened.push((payload as { args: { request: { path: string } } }).args.request.path)
              return Promise.resolve({ ok: true, value: { opened: true } })
            },
          },
        },
        sidebarRight: { openResource: (address: string) => { previewed.push(address) } },
      },
    })
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/repo/src/a.ts' }) } },
    ]
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-preview',
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: conv } })) as UseChatLike,
    }))
    await flush()
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    const name = query(query(card, '.lc-fa-row'), '.lc-fa-file')
    assert.equal(name.getAttribute('title'), DICT_EN['files.preview'])
    await click(name)
    assert.deepEqual(previewed, ['dsh-resource://file/session/sv-preview/src/a.ts'])
    assert.deepEqual(opened, [])
    await m.unmount()
  })

  test('a Sidebar that refuses the address falls back to the system opener', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'sv-preview-no': { cwd: '/repo' } } }) } },
        connection: {
          isLoopback: true,
          rpc: {
            call: (_channel: string, endpoint: string, payload: unknown) => {
              if (endpoint === 'session/canOpenWorkspacePath') return Promise.resolve({ ok: true, value: true })
              opened.push((payload as { args: { request: { path: string } } }).args.request.path)
              return Promise.resolve({ ok: true, value: { opened: true } })
            },
          },
        },
        // No preview type claims the address (or no surface is mounted): the throw
        // is the face's own wiring-error report, and the card must fall back.
        sidebarRight: { openResource: () => { throw new Error('no registered tab type claims it') } },
      },
    })
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '/repo/src/a.ts' }) } },
    ]
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-preview-no',
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: conv } })) as UseChatLike,
    }))
    await flush()
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    await click(query(query(card, '.lc-fa-row'), '.lc-fa-file'))
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    await m.unmount()
  })

  test('an unencodable path skips the preview and still opens on the system', async () => {
    // Parsing resilience: a lone surrogate in a log path is unrepresentable in a
    // resource address (the encoder throws), so the preview opener is never
    // asked for one address and the system opener still takes the resolved path.
    const opened: string[] = []
    const previewed: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { 'sv-preview-bad': { cwd: '/repo' } } }) } },
        connection: {
          isLoopback: true,
          rpc: {
            call: (_channel: string, endpoint: string, payload: unknown) => {
              if (endpoint === 'session/canOpenWorkspacePath') return Promise.resolve({ ok: true, value: true })
              opened.push((payload as { args: { request: { path: string } } }).args.request.path)
              return Promise.resolve({ ok: true, value: { opened: true } })
            },
          },
        },
        sidebarRight: { openResource: (address: string) => { previewed.push(address) } },
      },
    })
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: '\uD800' }) } },
    ]
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-preview-bad',
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: conv } })) as UseChatLike,
    }))
    await flush()
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    await click(query(query(card, '.lc-fa-row'), '.lc-fa-file'))
    assert.deepEqual(previewed, [])
    assert.deepEqual(opened, ['/repo/\uD800'])
    await m.unmount()
  })

  test('a capability probe that settles after unmount drops its answer', async () => {
    let resolveProbe!: (value: unknown) => void
    const ctx = new TestClientCtx({
      services: {
        connection: {
          isLoopback: true,
          rpc: { call: () => new Promise(resolve => { resolveProbe = resolve }) },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-open-late',
      useProjection: projectionsFor(fileTimeline()),
    }))
    await m.unmount()
    // The late "yes" arrives on a dead view: the stale answer is dropped whole.
    resolveProbe({ ok: true, value: true })
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  test('a ctx without service access degrades the card wiring, not the view', async () => {
    const View = makeView({} as unknown as TestClientCtx)
    // No session id: the view stays on its loading screen; the workspace and
    // opener wiring (both read ctx before the early return) resolve to nothing.
    const m = await mount(h(View, { sessionId: '' }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
  })
})
