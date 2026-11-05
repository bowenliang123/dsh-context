import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import type { ContextTimeline } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, mount, query, queryAll, text, until } from '../helpers/kit'
import { makeView, projectionsFor, richTimeline, T0, timeline } from './contextViewHarness'

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
