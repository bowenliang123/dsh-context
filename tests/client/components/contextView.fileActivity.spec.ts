import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { DICT_EN } from '../../../src/client/i18n'
import { type UseChatLike } from '../../../src/client/services'
import { type ContextTimeline, type CommandRecord } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, settle, text, unhover, until } from '../helpers/kit'
import { buttonByText, makeView, projectionsFor, T0, timeline, richTimeline, mountInScroller } from './contextViewHarness'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { watchHistoryFaces } from '../../../src/client/historyPage'

describe('contextView.fileActivity', () => {

describe('ContextView — file activity card', () => {
  const rest = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 200))
  function fileTimeline(): ContextTimeline {
    const req = (seq: number, time: number, extra: Record<string, unknown> = {}) =>
      ({ seq, time, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70, ...extra })
    return timeline({
      requests: [
        req(2, T0 + 1000, { turn: 1, step: 1 }),
        req(4, T0 + 3000, { turn: 1, step: 2 }),
        req(6, T0 + 5000),
        req(7, T0 + 6000),
        req(8, T0 + 7000, { turn: 2, step: 1 }),
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

  test('follows the chart pick with debounced hover: an exclusive next-step bound, a trailing rapid sweep, and a DNA rest', async () => {
    const { m, card } = await mountFiles('sv-files-scope')
    assert.ok(text(card).includes('+1') && text(card).includes('−2'))

    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await rest()
    assert.equal(queryAll(card, '.lc-fa-meta-delta').length, 0)
    assert.equal(queryAll(card, '.lc-fa-row').length, 1)

    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    await rest()
    assert.ok(text(card).includes('+1'))

    await unhover(query(m.container, '.lc-chart'))
    assert.ok(text(card).includes('−2'))

    const frozen = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValue(frozen)
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await hover(query(m.container, '.lc-bar[data-seq="4"]'))
    await hover(query(m.container, '.lc-bar[data-seq="6"]'))
    clock.mockRestore()
    await until(() => text(card).includes('+1'), 'the trailing hover lands on the last bar')

    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    await settle(80)
    assert.ok(text(card).includes('−2'), 'the cross-card preview stays on the latest scope')
    await settle(300)
    assert.ok(!text(card).includes('−2'))
    await m.unmount()
  })

  test('op clicks reveal the result in the browser', async () => {
    const { m, card } = await mountFiles('sv-files-locate')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    await click(query(card, '.lc-fa-row'))
    const ops = queryAll(card, '.lc-fa-op')
    assert.equal(ops.length, 2)
    assert.ok(text(query(ops[1], '.lc-fa-op-time')).includes('T1 S2'))
    assert.ok(/^\d{2}:\d{2}:\d{2}$/.test(text(query(ops[0], '.lc-fa-op-time'))))
    await click(ops[0])
    assert.equal(pick.value, 'live')
    await click(ops[1])
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
    assert.ok(text(card).includes('edit'))
    assert.ok(text(card).includes('Fix the failing test'))
    await click(query(card, '.lc-fa-op'))
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('Fix the failing test'))
    await m.unmount()
  })

  function openCtx(sessionId: string, sidebarRight?: { openResource: (address: string) => void }) {
    const opened: string[] = []
    const calls: string[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { list: { getSnapshot: () => ({ byId: { [sessionId]: { cwd: '/repo' } } }) } },
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
        ...(sidebarRight === undefined ? {} : { sidebarRight }),
      },
    })
    return { ctx, opened, calls }
  }

  async function mountOpen(sessionId: string, filePath: string, ctx: TestClientCtx) {
    const View = makeView(ctx)
    const conv = [
      { kind: 'tool', seq: 3, call: { name: 'read', argsRaw: JSON.stringify({ file_path: filePath }) } },
    ]
    const m = await mount(h(View, {
      sessionId,
      useProjection: projectionsFor(fileTimeline()),
      useChat: (sel =>
        sel({
          legacy: { nodes: conv } })) as UseChatLike,
    }))
    await flush()
    const card = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
    assert.ok(card !== undefined)
    return { m, card }
  }

  test('the session workspace relativizes row paths; the host opener opens the resolved file', async () => {
    const { ctx, opened, calls } = openCtx('sv-files-open')
    const { m, card } = await mountOpen('sv-files-open', '/repo/src/a.ts', ctx)
    const row = query(card, '.lc-fa-row')
    assert.ok(row.querySelector('.lc-fa-path em')?.textContent === './src/')
    const name = query(row, '.lc-fa-file')
    assert.equal(name.getAttribute('title'), DICT_EN['files.open'])
    await click(name)
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    assert.deepEqual(calls, ['session/openWorkspacePath'])
    await m.unmount()

    const previewed: string[] = []
    const previewCtx = openCtx('sv-preview', { openResource: (address: string) => { previewed.push(address) } })
    const preview = await mountOpen('sv-preview', '/repo/src/a.ts', previewCtx.ctx)
    const previewName = query(query(preview.card, '.lc-fa-row'), '.lc-fa-file')
    assert.equal(previewName.getAttribute('title'), DICT_EN['files.preview'])
    await click(previewName)
    assert.deepEqual(previewed, ['dsh-resource://file/session/sv-preview/src/a.ts'])
    assert.deepEqual(previewCtx.opened, [])
    await preview.m.unmount()
  })

  test('a Sidebar that refuses the address falls back to the system opener', async () => {
    const { ctx, opened } = openCtx('sv-preview-no', { openResource: () => { throw new Error('no registered tab type claims it') } })
    const { m, card } = await mountOpen('sv-preview-no', '/repo/src/a.ts', ctx)
    await click(query(query(card, '.lc-fa-row'), '.lc-fa-file'))
    assert.deepEqual(opened, ['/repo/src/a.ts'])
    await m.unmount()
  })

  test('an unencodable path skips the preview and still opens on the system', async () => {
    const previewed: string[] = []
    const { ctx, opened } = openCtx('sv-preview-bad', { openResource: (address: string) => { previewed.push(address) } })
    const { m, card } = await mountOpen('sv-preview-bad', '\uD800', ctx)
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
    resolveProbe({ ok: true, value: true })
    await new Promise(resolve => setTimeout(resolve, 0))
  })

  test('a ctx without service access degrades the card wiring, not the view', async () => {
    const View = makeView({} as unknown as TestClientCtx)
    const m = await mount(h(View, { sessionId: '' }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
  })
})
})

describe('contextView.splitDetail', () => {

describe('ContextView — the split generation (slim head + detail channel)', () => {
  function slimHead(over: Record<string, unknown> = {}): ContextTimeline {
    return timeline({
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      contextWindow: 128000,
      toolCalls: 3,
      images: 1,
      counts: { turns: 1, steps: 3, injects: 1, compactions: 1, prunes: 0 },
      last: { seq: 6, total: 420, prompt: 410 },
      detailRev: 6,
      ...over,
    })
  }

  function slimDetail(rev = 6): Record<string, unknown> {
    const rich = richTimeline()
    return {
      rev,
      requests: rich.requests,
      events: rich.events,
      nodes: rich.nodes,
      droppedNodes: rich.droppedNodes,
      archive: rich.archive,
    }
  }

  function slimCtx(serve: () => Promise<unknown>): TestClientCtx {
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => await serve() }))
    return new TestClientCtx()
  }

  test('the head paints the counters immediately; the detail collections land through the channel', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', (input: unknown) => String(input).endsWith('/detail')
      ? new Promise(res => {
        release = () => { res({ ok: true, status: 200, json: async () => ({ ok: true, value: slimDetail() }) }) }
      })
      : Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-slim', useProjection: projectionsFor(slimHead()) }))

    const values = queryAll(m.container, '.lc-core-kv:not(.lc-core-kv-events) b').map(el => text(el))
    assert.deepEqual(values, ['1', '3', '0', '0'], 'turns/steps/skills/answers from the head counters')
    assert.ok(text(m.container).includes(DICT_EN['detail.loading']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0, 'the chart waits for the detail')
    assert.equal(queryAll(m.container, '.lc-br-pick option').length, 1, 'the picker holds only the live row')

    await until(() => typeof release === 'function', 'the detail read never started')
    await act(async () => { release() })
    await until(() => queryAll(m.container, '.lc-bar').length === 3, 'the detail never landed')
    assert.ok(!text(m.container).includes(DICT_EN['detail.loading']))
    assert.ok(text(m.container).includes('heads-up'), 'the events list serves the detail')
    assert.equal(queryAll(m.container, '.lc-br-pick option').length, 4, 'live + three steps')
    assert.ok(text(m.container).includes('reply three'), 'the brief rows serve the detail')
    assert.ok(text(m.container).includes(DICT_EN['files.empty']), 'no file ops in this detail')
    await m.unmount()
  })

  test('the head tallies paint the tool and command stats before the detail lands', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const head = slimHead({
      toolTally: { bash: 2, read: 1 },
      programTally: { ls: 3, cat: 1 },
      commandStats: { runs: 3, failed: 0, ms: 10, bg: 0 },
    })
    const m = await mount(h(View, { sessionId: 'sv-tally', useProjection: projectionsFor(head) }))
    await until(() => text(m.container).includes('bash'), 'the tool tally never painted')
    assert.ok(text(m.container).includes('ls'), 'the command tally paints from the head')
    assert.ok(text(m.container).includes('read'))
    await m.unmount()
  })

  test('the facts core series carries the category breakdown for the trend and per-step composition', async () => {
    const rich = richTimeline()
    const head = slimHead()
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { parts?: string[] }
      const parts = body.parts ?? []
      let value: unknown
      if (parts.includes('head')) value = { rev: 6, live: false, parts: { head, series: rich.requests } }
      else if (parts.includes('nodes')) value = { rev: 6, parts: { nodes: { nodes: rich.nodes, archive: [], droppedNodes: 0 } } }
      else if (parts.includes('events')) value = { rev: 6, parts: { events: rich.events } }
      else if (parts.includes('files')) value = { rev: 6, parts: { files: { fileOps: [] } } }
      else if (parts.includes('spans')) value = { rev: 6, parts: { spans: [] } }
      else if (parts.includes('commands')) value = { rev: 6, parts: { commands: { commands: [], commandsFloor: 0 } } }
      else value = { rev: 6, parts: {} }
      return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
    })
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-facts', useProjection: projectionsFor(head) }))
    await until(() => queryAll(m.container, '.lc-bar').length === 3, 'the facts series never reached the trend')
    const segments = queryAll(m.container, '.lc-cat-seg')
    assert.ok(segments.length > 0, 'the trend needs per-category request buckets, not only totals')
    assert.ok(/Actual|实际/.test(text(m.container)), 'the step composition reads the same full request')
    await m.unmount()
  })

  test('a head with program tallies but no command stats paints the programs and a zero run count', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const head = slimHead({ toolTally: { bash: 1 }, programTally: { ls: 2 } })
    const m = await mount(h(View, { sessionId: 'sv-tally2', useProjection: projectionsFor(head) }))
    await until(() => text(m.container).includes('ls'), 'the program tally never painted')
    assert.ok(text(m.container).includes('bash'))
    await m.unmount()
  })

  test('the pending trend body reserves the loaded panel, so the detail fills the card instead of growing it', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', () => new Promise(res => {
      release = () => { res({ ok: true, status: 200, json: async () => ({ ok: true, value: slimDetail() }) }) }
    }))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-reserve', useProjection: projectionsFor(slimHead()) }))

    assert.equal(queryAll(m.container, '.lc-trend-lane').length, 1, 'the reserved body renders while the read is in flight')
    assert.equal(queryAll(m.container, '.lc-trend-lane .lc-legend .lc-chip').length, 7,
      'the lane reserves one chip per category')
    const laneChip = query(m.container, '.lc-trend-lane .lc-legend .lc-chip')
    assert.deepEqual(Array.from(laneChip.children).map(el => el.className.split(' ')[0]), ['', 'lc-chip-label', 'lc-chip-nums'],
      'the reserved chips wear the legend chip anatomy, so the panels measure alike')
    assert.equal(queryAll(m.container, '.lc-trend-lane .lc-detail-metrics').length, 0,
      'no fabricated figures in the reserved panel')

    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => queryAll(m.container, '.lc-bar').length === 3, 'the detail never landed')
    assert.equal(queryAll(m.container, '.lc-trend-lane').length, 0, 'the lane yields to the real panel')
    assert.equal(queryAll(m.container, '.lc-chartrow').length, 1, 'the chart took its place')
    await m.unmount()
  })

  test('the stats figures jump into the browser: skill loads open the skill section, answers open assistant filtered to Answer', async () => {
    const rich = richTimeline()
    const nodes = [...rich.nodes, { seq: 7, cat: 'skill', tokens: 5, skill: 'pdf', text: 'instructions', time: T0 + 6000 }]
    const ctx = slimCtx(async () => ({
      ok: true,
      value: { rev: 6, requests: rich.requests, events: rich.events, nodes, droppedNodes: rich.droppedNodes, archive: rich.archive },
    }))
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-slim',
      useProjection: projectionsFor(slimHead({
        counts: { turns: 1, steps: 3, injects: 1, compactions: 1, prunes: 0, skills: 1 },
        answers: 3,
      })),
    }))
    await until(() => queryAll(m.container, '.lc-bar').length === 3, 'the detail never landed')
    const openCat = (): HTMLElement => {
      const on = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(on.length, 1)
      const parent = on[0].parentElement
      assert.ok(parent !== null)
      return parent
    }

    const cells = queryAll(m.container, '.lc-core-kv-btn:not(.lc-core-kv-events)')
    assert.equal(cells.length, 4)
    await click(query(m.container, '.lc-core-kv-answers.lc-core-kv-btn'))
    await flush()
    const assistantCat = openCat()
    const answerChip = queryAll(assistantCat, '.lc-gran-btn').find(b => text(b).includes('Answer'))
    assert.ok(answerChip !== undefined && answerChip.className.includes('lc-gran-on'), 'the Answer chip is picked')
    assert.equal(queryAll(assistantCat, '.lc-br-elem').length, 3, 'all three textual replies survive the filter')

    await click(query(m.container, '.lc-core-kv-skills.lc-core-kv-btn'))
    await flush()
    const skillCat = openCat()
    assert.ok(text(skillCat).includes('pdf'), 'the loaded skill row shows')
    assert.equal(queryAll(skillCat, '.lc-br-elem').length, 1)
    await m.unmount()
  })

  test('a failed detail read arms the retry notes; one click refires and the cards land', async () => {
    let online = false
    const ctx = slimCtx(async () => {
      if (!online) throw new Error('offline')
      return { ok: true, value: slimDetail() }
    })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-slim-fail', useProjection: projectionsFor(slimHead()) }))
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)

    online = true
    await click(query(m.container, '.lc-br-retry'))
    await until(() => queryAll(m.container, '.lc-bar').length === 3, 'the retry never recovered the cards')
    assert.ok(!text(m.container).includes(DICT_EN['detail.loadFailed']))
    assert.ok(text(m.container).includes('heads-up'))
    await m.unmount()
  })

  test('the jump relay survives the split: held while the detail reads, resolves when it lands', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', () => new Promise(res => {
      release = () => { res({ ok: true, status: 200, json: async () => ({ ok: true, value: slimDetail() }) }) }
    }))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    requestContextFocus('sv-slim-jump', 4)
    const m = await mount(h(View, { sessionId: 'sv-slim-jump', useProjection: projectionsFor(slimHead()) }))
    assert.equal(queryAll(m.container, '.lc-bar-selected').length, 0, 'nothing pins before the detail')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(
      () => queryAll(m.container, '.lc-bar[data-seq="4"]')[0]?.className.includes('lc-bar-selected') === true,
      'the jump never resolved',
    )
    assert.equal(takeContextFocus('sv-slim-jump'), null)
    await m.unmount()
  })
})

describe('ContextView — the op-log generation (fileOps on the detail payload)', () => {
  test('the File Activity card renders the fold-derived ops, no conversation join needed', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        value: {
          rev: 1,
          requests: [{ seq: 2, turn: 1, step: 1, time: T0, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 5, total: 15 }],
          events: [],
          nodes: [],
          droppedNodes: 0,
          archive: [],
          fileOps: [
            { seq: 1, path: '/ws/README.md', kind: 'read', tool: 'read', err: false, added: 0, removed: 0, read: { start: 1, count: 12 } },
            { seq: 2, path: '/ws/src/a.ts', kind: 'write', tool: 'edit', err: false, added: 3, removed: 1 },
          ],
        },
      }),
    }))
    const ctx = new TestClientCtx()
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-opslog',
      useProjection: projectionsFor(timeline({
        counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 },
        detailRev: 1,
      })),
    }))
    await until(() => text(m.container).includes('README.md'), 'the detail never landed')
    assert.ok(text(m.container).includes('a.ts'), 'both served ops row')
    assert.ok(text(m.container).includes('+3'), 'the edit delta shows')
    assert.ok(!text(m.container).includes('No file reads'), 'not the empty state')
    await m.unmount()
  })
})
})

describe('contextView.contentFetch', () => {

describe('ContextView — targeted content fetch and image loading', () => {
  test('opening an un-joined node reads one seq-anchored history page through the gateway remote', async () => {
    const calls: { sessionId: string; throughSeq: number; beforeSeq: number }[] = []
    const ctx = new TestClientCtx({
      services: {
        remote: {
          session: {
            page: (request: { address: { sessionId: string }; throughSeq: number; beforeSeq: number }) => {
              calls.push({ sessionId: request.address.sessionId, throughSeq: request.throughSeq, beforeSeq: request.beforeSeq })
              return Promise.resolve({
                ok: true,
                value: {
                  records: [
                    { type: 'event', event: { type: 'user/message', seq: request.throughSeq, data: { content: [{ type: 'text', text: 'OLD FULL BODY' }] } } },
                  ],
                },
              })
            },
          },
        },
      },
    })
    ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    watchHistoryFaces(asClientCtx(ctx))
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-page',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await flush()
    assert.deepEqual(calls, [{ sessionId: 'sv-page', throughSeq: 1, beforeSeq: 2 }], 'one read anchored just past the seq')
    assert.ok(text(m.container).includes('OLD FULL BODY'), 'mapped page content renders')
    await m.unmount()
    ctx.dispose()
  })

  test('a subagent session epoch reads its prompt under the durable parent address (issue #193)', async () => {
    const calls: unknown[] = []
    const ctx = new TestClientCtx({
      services: {
        sessions: { subagentAddress: () => ({ parentSessionId: 'sv-parent', childSessionId: 'sv-sys', mode: 'continuable' }) },
        remote: {
          session: {
            page: (request: unknown) => {
              calls.push(request)
              return Promise.resolve({
                ok: true,
                value: {
                  records: [{
                    type: 'event',
                    event: { type: 'system/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'SYSTEM FROM PAGE' }] } } },
                  }],
                },
              })
            },
          },
        },
      },
    })
    ctx.setService('remote.session', { get page() { throw new Error('cannot get property "remote.session" without inject') } })
    watchHistoryFaces(asClientCtx(ctx))
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-sys',
      useProjection: projectionsFor(timeline(), {
        contextHeaders: { headers: [{ seq: 1, time: 0, systemTokens: 5, tools: [] }] },
      }),
    }))
    const sysRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.system']))
    assert.ok(sysRow !== undefined)
    await click(sysRow)
    await flush()
    assert.deepEqual(calls, [{
      address: { kind: 'subagent', parentSessionId: 'sv-parent', childSessionId: 'sv-sys', mode: 'continuable' },
      throughSeq: 1,
      beforeSeq: 2,
    }])
    assert.ok(text(m.container).includes('SYSTEM FROM PAGE'), 'the fetched prompt renders')
    await m.unmount()
    ctx.dispose()
  })

  test('without a history face an uncached node shows the static note', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-nopage',
      useProjection: projectionsFor(timeline({ nodes: [{ seq: 1, cat: 'user', tokens: 5, text: 'old msg' }] })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    assert.ok(text(m.container).includes(DICT_EN['browser.noContent']))
    await m.unmount()
  })

  test('image attachments resolve through the conversation service loader', async () => {
    const resolved: [string, unknown][] = []
    const ctx = new TestClientCtx({
      services: {
        uiConversation: {
          imageUrl: (sessionId: string, attachment: unknown) => {
            resolved.push([sessionId, attachment])
            return Promise.resolve('blob:pic')
          },
        },
      },
    })
    const View = makeView(ctx)
    const m = await mount(h(View, {
      sessionId: 'sv-img',
      useProjection: projectionsFor(timeline({
        images: 1,
        nodes: [{ seq: 1, cat: 'user', tokens: 400, text: 'see this', imgs: 1 }],
      })),
      useChat: (sel =>
        sel({
          legacy: { nodes: [{
            kind: 'user',
            seq: 1,
            content: [{ type: 'image', attachment: { attachmentId: 'att-1', name: 'pic.png', bytes: 2048, width: 640, height: 480 } }],
          }] }
        })) as UseChatLike,
    }))
    const catRow = queryAll(m.container, '.lc-br-cat-row').find(r => text(r).includes(DICT_EN['cat.user']))
    assert.ok(catRow !== undefined)
    await click(catRow)
    await flush()
    assert.equal(resolved.length, 1)
    assert.equal(resolved[0][0], 'sv-img')
    assert.equal((resolved[0][1] as { attachmentId: string }).attachmentId, 'att-1')
    assert.ok(m.container.querySelector('.lc-att-item img') !== null)
    await m.unmount()
  })
})

describe('ContextView — scroll ledger', () => {
  test('restores the saved position per session and re-applies only once per mount', async () => {
    const View = makeView(new TestClientCtx())
    const props = {
      sessionId: 'sv-scroll',
      useProjection: undefined as ((key: string) => unknown) | undefined,
    }

    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller1,
    )
    assert.equal(scroller1.scrollTop, 0)

    scroller1.scrollTop = 17
    await m1.update(h(View, { ...props, useProjection: projectionsFor(richTimeline({ droppedNodes: 3 })) }))
    assert.equal(scroller1.scrollTop, 17)

    scroller1.scrollTop = 42
    await m1.unmount()

    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    const m2 = await mountInScroller(
      h(View, { ...props, useProjection: projectionsFor(richTimeline()) }),
      scroller2,
    )
    assert.equal(scroller2.scrollTop, 42)
    await m2.unmount()
  })
})
})

describe('contextView.commandPanel', () => {

const req = (seq: number, time: number, extra: Record<string, unknown> = {}) =>
  ({ seq, time, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 10, total: 70, ...extra })

function cmd(seq: number, over: Partial<CommandRecord> = {}): CommandRecord {
  return {
    seq,
    time: T0 + seq * 1000,
    tool: 'bash',
    cmd: 'git status --short',
    description: 'check the tree',
    start: T0 + seq * 1000,
    end: T0 + seq * 1000 + 100,
    status: 'completed',
    err: false,
    ...over,
  }
}

function commandTimeline(commands: CommandRecord[]): ContextTimeline {
  return timeline({
    requests: [
      req(2, T0 + 1000, { turn: 1, step: 1 }),
      req(4, T0 + 3000, { turn: 1, step: 2 }),
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hi', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'r1', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'on branch main', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'r2', time: T0 + 3000 },
    ],
    commands,
  })
}

async function mountCommands(sessionId: string, commands: CommandRecord[]) {
  const View = makeView(new TestClientCtx())
  const m = await mount(h(View, {
    sessionId,
    useProjection: projectionsFor(commandTimeline(commands)),
    useChat: (sel =>
      sel({
        legacy: { nodes: [] } })) as UseChatLike,
  }))
  const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
  assert.ok(card !== undefined)
  return { m, card }
}

describe('ContextView — command panel', () => {
  test('the panel lists the served commands and reveals the result message in the browser', async () => {
    const { m, card } = await mountCommands('sv-cmds', [cmd(10, { resultSeq: 3 })])
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    const row = query(card, '.lc-cmd-row')
    assert.ok(text(row).includes('git status --short'))
    await click(query(row, '.lc-cmd-time'))
    assert.equal(pick.value, '4', 'the browser lands on the step that first carried the result')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('on branch main'))
    await m.unmount()
  })

  test('a running run without a result is not locatable; a nested run reveals on its parent', async () => {
    const { m, card } = await mountCommands('sv-cmds-nested', [
      cmd(10, { status: 'running', end: undefined }),
      cmd(11, { cmd: 'git diff', codeMode: true, parent: 3, resultSeq: undefined }),
    ])
    const rows = queryAll(card, '.lc-cmd-row')
    const running = rows.find(r => text(r).includes('Running'))
    const nested = rows.find(r => text(r).includes('git diff'))
    assert.ok(running !== undefined && nested !== undefined)
    assert.equal(queryAll(running, '.lc-cmd-time-link').length, 0)
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    await click(query(nested, '.lc-cmd-time'))
    assert.equal(pick.value, '4', 'the nested run reveals its run_code parent')
    await m.unmount()
  })

  test('the card follows the detail channel states', async () => {
    const { m } = await mountCommands('sv-cmds-none', [])
    assert.ok(text(m.container).includes('No commands executed in this session'))
    await m.unmount()
  })

  test('the split generation serves the command log through the detail channel', async () => {
    const rich = commandTimeline([cmd(10, { resultSeq: 3 })])
    const head = timeline({
      counts: { turns: 1, steps: 2, injects: 0, compactions: 0, prunes: 0 },
      detailRev: 2,
    })
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {}
      if ('beforeSeq' in body) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: { commands: [], atStart: true, total: 1 } }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: {
            rev: 2,
            requests: rich.requests,
            events: rich.events,
            nodes: rich.nodes,
            droppedNodes: rich.droppedNodes,
            archive: rich.archive,
            commands: rich.commands,
            commandsFloor: 1,
            commandStats: { runs: 42, failed: 2, ms: 9100, bg: 0 },
          },
        }),
      }
    })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-cmds-split', useProjection: projectionsFor(head) }))
    try {
      await until(() => queryAll(m.container, '.lc-cmd-row').length === 1, 'the detail never landed')
      const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
      assert.ok(card !== undefined)
      const kpi = query(card, '.lc-cmd-kpi b')
      assert.ok(kpi !== undefined && text(kpi) === '42', 'the whole-log tally rides the detail')
      await until(() => queryAll(card, '.lc-cmd-floor').length === 0, 'the history fill never completed')
      assert.ok(!text(card).includes('Covering'), 'a completed fill drops the floor note')
    } finally {
      await m.unmount()
    }
  })

  test('a run whose result was compacted away before any step carried it cannot be located', async () => {
    const View = makeView(new TestClientCtx())
    const goneTimeline = {
      ...commandTimeline([cmd(10, { resultSeq: 99 })]),
      archive: [{ seq: 99, cat: 'tool' as const, tokens: 30, tool: 'bash', gone: 6, time: T0 + 2000 }],
    }
    const m = await mount(h(View, {
      sessionId: 'sv-cmds-gone',
      useProjection: projectionsFor(goneTimeline),
      useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
    }))
    try {
      const card = queryAll(m.container, '.lc-card').find(c => c.className.includes('lc-cmd-card'))
      assert.ok(card !== undefined)
      const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
      await click(query(card, '.lc-cmd-time'))
      assert.equal(pick.value, 'live')
    } finally {
      await m.unmount()
    }
  })
})
})
