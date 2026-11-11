import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import { requestContextFocus, takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { TestClientCtx } from '../helpers/harness'
import { click, flush, hover, mount, query, queryAll, text, unhover } from '../helpers/kit'
import { buttonByText, eventLink, makeView, mountInScroller, mountRich, overflowingScroller, projectionsFor, richTimeline, settingsWith, stubRevealRects, T0, timeline } from './contextViewHarness'
import { type UseChatLike } from '../../../src/client/services'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { type ContextTimeline } from '../../../src/shared/types'

describe('contextView.jump', () => {

describe('ContextView — chat→Context jump', () => {
  test('the relay flips the chart to turn bars, pins the reply\'s turn, and consumes itself', async () => {
    requestContextFocus('sv-jump', 4)
    const m = await mountRich('sv-jump')
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'), 'granularity flips to turn')
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'the chart renders turn aggregates')
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the reply\'s turn bar is pinned')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-jump'), null, 'the relay is one-shot')
    await m.unmount()
  })

  test('no session id: the relay stays pending — the loading view never takes it', async () => {
    requestContextFocus('sv-jumpnone', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: '', useProjection: () => undefined }))
    assert.ok(text(m.container).includes(DICT_EN.loading))
    await m.unmount()
    assert.equal(takeContextFocus('sv-jumpnone'), 4, 'an absent session id skips leg 1')
    takeContextFocus('sv-jumpnone')
  })

  test('an empty history consumes the relay and pins nothing', async () => {
    requestContextFocus('sv-jumpempty', 4)
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-jumpempty', useProjection: projectionsFor(timeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 0)
    assert.equal(takeContextFocus('sv-jumpempty'), null)
    await m.unmount()
  })

  test('a turn-less reply routes to the turn-0 bar', async () => {
    requestContextFocus('sv-jump0', 6)
    const m = await mountRich('sv-jump0')
    assert.ok(query(m.container, '.lc-bar[data-seq="6"]').className.includes('lc-bar-selected'))
    assert.equal(takeContextFocus('sv-jump0'), null)
    await m.unmount()
  })

  test('a record landing after mount re-pins the mounted view (the sidebar repeat jump)', async () => {
    const m = await mountRich('sv-rejump')
    assert.ok(!query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'nothing pinned at mount')
    await act(async () => { requestContextFocus('sv-rejump', 4) })
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the later record re-pins')
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.equal(takeContextFocus('sv-rejump'), null, 'the record was consumed')
    await m.unmount()
  })

  test('the jump reveals the Current Composition card even over a restored position', async () => {
    const View = makeView(new TestClientCtx())
    const props = { sessionId: 'sv-jumpscroll', useProjection: projectionsFor(richTimeline()) }

    const scroller1 = document.createElement('div')
    scroller1.setAttribute('data-conversation-scroll', '')
    const m1 = await mountInScroller(h(View, props), scroller1)
    scroller1.scrollTop = 42
    await m1.unmount()

    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const top = this.hasAttribute('data-conversation-scroll') ? 100
        : this.hasAttribute('data-lc-current') ? 450 : 0
      return { top } as DOMRect
    })

    requestContextFocus('sv-jumpscroll', 4)
    const scroller2 = document.createElement('div')
    scroller2.setAttribute('data-conversation-scroll', '')
    scroller2.style.overflowY = 'auto'
    Object.defineProperty(scroller2, 'scrollHeight', { value: 800 })
    Object.defineProperty(scroller2, 'clientHeight', { value: 300 })
    const m2 = await mountInScroller(h(View, props), scroller2)
    assert.equal(scroller2.scrollTop, 392, 'restore(42) overridden by the card reveal delta(350)')
    assert.ok(query(m2.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m2.unmount()
    gBCR.mockRestore()
  })
})

describe('ContextView — the stats board\'s pill jumps', () => {
  function jumpTimeline(): ReturnType<typeof timeline> {
    return timeline({
      humanInputs: 1,
      requests: [{ seq: 2, turn: 1, step: 1, time: T0, system: 10, tools: 20, user: 10, inject: 0, assistant: 20, tool: 0, total: 60 }],
      nodes: [{ seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 }],
      fileOps: [
        { seq: 3, path: '/src/a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0, read: { start: 1, count: 3 } },
        { seq: 4, path: '/src/a.ts', kind: 'write', tool: 'edit', err: false, added: 2, removed: 1 },
      ],
    })
  }

  test('the session figures scroll the trend card into view', async () => {
    const scroller = overflowingScroller(900)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-trendjump', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      await click(query(m.container, '.lc-core-kv-turns.lc-core-kv-btn'))
      await flush()
      assert.equal(scroller.scrollTop, 350, 'the turn figure lands on the trend card')
      scroller.scrollTop = 0
      await click(query(m.container, '.lc-core-kv-steps.lc-core-kv-btn'))
      await flush()
      assert.equal(scroller.scrollTop, 350, 'the step figure lands on the same card')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('a session-figure jump ignores the hover its own scroll leaves under the pointer', async () => {
    const scroller = overflowingScroller(900)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000)
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-hoverlock', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      await click(query(m.container, '.lc-core-kv-steps.lc-core-kv-btn'))
      await flush()
      const bar = query(m.container, '.lc-bar')
      const turn = query(m.container, '.lc-turn')
      now.mockReturnValue(1_100)
      await hover(turn)
      assert.equal(queryAll(m.container, '.lc-chart-dim').length, 0, 'the landing turn hover is swallowed')
      now.mockReturnValue(1_200)
      await hover(bar)
      assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0, 'the landing bar hover is swallowed')
      now.mockReturnValue(1_400)
      await hover(turn)
      assert.equal(queryAll(m.container, '.lc-chart-dim').length, 1, 'a later turn hover dims as usual')
      now.mockReturnValue(1_500)
      await hover(bar)
      assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1, 'a later bar hover shows the tip')
      await m.unmount()
    } finally {
      now.mockRestore()
      gBCR.mockRestore()
    }
  })

  test('the input pill opens the browser\'s user messages; a file pill picks the card\'s kind chip and scrolls it in', async () => {
    const scroller = document.createElement('div')
    scroller.setAttribute('data-conversation-scroll', '')
    scroller.style.overflowY = 'auto'
    Object.defineProperty(scroller, 'scrollHeight', { value: 900 })
    Object.defineProperty(scroller, 'clientHeight', { value: 300 })
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-col-browser') ? 450
      : el.classList.contains('lc-fa-card') ? 700 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-pilljump', useProjection: projectionsFor(jumpTimeline()) }), scroller)
      const pill = (label: string): HTMLElement => {
        const hit = queryAll(m.container, '.lc-ledger-in-chips .lc-ledger-chip').find(el => text(el).startsWith(label))
        if (hit === undefined) throw new Error(`pill not found: ${label}`)
        return hit
      }
      const fileCard = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['files.title']))
      assert.ok(fileCard !== undefined)
      const chip = (label: string): HTMLElement => {
        const hit = queryAll(fileCard, '.lc-fa-chips .lc-gran-btn').find(b => text(b).startsWith(label))
        if (hit === undefined) throw new Error(`chip not found: ${label}`)
        return hit
      }

      await click(pill(DICT_EN['stats.user']))
      await flush()
      const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes(DICT_EN['cat.user']), 'the user category opens')
      assert.ok(text(open[0].parentElement as HTMLElement).includes('hello there'), 'its messages show')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')

      await click(pill(DICT_EN['files.kind.read']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'))
      assert.equal(queryAll(fileCard, '.lc-fa-row').length, 1, 'the read filter narrows the list')
      assert.equal(scroller.scrollTop, 600, 'the File Activity card scrolled to the scrollport top')

      await click(pill(DICT_EN['stats.fileWrite']))
      await flush()
      assert.ok(chip(DICT_EN['files.kind.write']).className.includes('lc-gran-on'))
      assert.ok(!chip(DICT_EN['files.kind.read']).className.includes('lc-gran-on'), 'the previous jump is replaced')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })
})

describe('ContextView — the stats board\'s lower-lane jumps', () => {
  function commandTimeline(): ReturnType<typeof timeline> {
    return timeline({
      commands: [
        { seq: 10, time: T0, tool: 'bash', cmd: 'python3 a.py && python3 b.py', start: T0, end: T0 + 100, status: 'completed', err: false },
        { seq: 11, time: T0, tool: 'bash', cmd: 'python3 build.py', start: T0, end: T0 + 100, status: 'completed', err: false },
        { seq: 12, time: T0 + 1000, tool: 'bash', cmd: 'git status --short', start: T0 + 1000, end: T0 + 1100, status: 'completed', err: false },
        { seq: 13, time: T0 + 2000, tool: 'bash', cmd: 'node --version', start: T0 + 2000, end: T0 + 2100, status: 'completed', err: false },
        { seq: 14, time: T0 + 3000, tool: 'bash', cmd: 'npm --version', start: T0 + 3000, end: T0 + 3100, status: 'completed', err: false },
      ],
    })
  }

  test('a command chip mounts the lazy card, seeds its lens, and scrolls it in', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-cmd-card') ? 700 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-cmdjump', useProjection: projectionsFor(commandTimeline()) }), scroller)
      assert.ok(queryAll(m.container, '.lc-ledger-in-body2 .lc-ledger-chip').some(el => text(el).startsWith('npm')), 'the whole program tally reaches the stats board')
      const chip = queryAll(m.container, '.lc-ledger-in-body2 .lc-ledger-chip').find(el => text(el).startsWith('python3'))
      assert.ok(chip !== undefined)
      assert.equal(text(chip), 'python33', 'the lane counts INVOCATIONS, including repeats within one record')
      await click(chip)
      await flush()
      const card = query(m.container, '.lc-cmd-card')
      assert.equal(query<HTMLInputElement>(card, 'input.lc-fa-search').value, 'python3', 'the seeded lens shows in the box')
      assert.equal(queryAll(card, '.lc-cmd-row').length, 2, 'the lens narrows to the records running the program')
      assert.equal(scroller.scrollTop, 600, 'the command card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('the folded "+N" tails jump: tools open every result, commands reveal the card without a lens', async () => {
    const data = timeline({
      commands: ['git status', 'pnpm test', 'node x.js', 'grep -n x src', 'tail -5 log']
        .map((cmd, i) => ({ seq: 20 + i, time: T0 + i, tool: 'bash', cmd, start: T0, end: T0 + 10, status: 'completed' as const, err: false })),
      nodes: ['read', 'edit', 'bash', 'grep', 'write']
        .map((tool, i) => ({ seq: 30 + i, cat: 'tool' as const, tokens: 5, tool })),
    })
    const scroller = overflowingScroller(1400)
    const rect = (w: number, top: number): DOMRect => ({ width: w, height: 0, top, left: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect)
    const gBCR = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      if (this.hasAttribute('data-conversation-scroll')) return rect(0, 100)
      if (this.classList.contains('lc-ledger-chips')) return rect(260, 0)
      if (this.classList.contains('lc-ledger-chip')) return rect(this.classList.contains('lc-ledger-chip-more') ? 40 : 100, 0)
      const top = this.classList.contains('lc-col-browser') ? 450 : this.classList.contains('lc-cmd-card') ? 700 : 0
      return rect(0, top - scroller.scrollTop)
    })
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-morejump', useProjection: projectionsFor(data) }), scroller)
      const toolMore = query(m.container, '.lc-ledger-out-chips .lc-ledger-chip-more')
      const cmdMore = query(m.container, '.lc-ledger-in-body2 .lc-ledger-chip-more')
      assert.equal(toolMore.getAttribute('title'), DICT_EN['stats.toolsMoreTip'])
      assert.equal(toolMore.getAttribute('role'), 'button')
      assert.equal(cmdMore.getAttribute('title'), DICT_EN['stats.commandsMoreTip'])
      await click(toolMore)
      await flush()
      const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes(DICT_EN['cat.tool']), 'every tool result opens')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled into view')
      await click(cmdMore)
      await flush()
      const card = query(m.container, '.lc-cmd-card')
      assert.equal(query<HTMLInputElement>(card, 'input.lc-fa-search').value, '', 'no program lens is seeded')
      assert.equal(scroller.scrollTop, 600, 'the command card scrolled into view')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('a tool chip opens the bucket its results are filed in, seeding the name only in Tool Results', async () => {
    const base = richTimeline()
    const skill = { seq: 7, cat: 'skill' as const, tool: 'skill', skill: 'code-review', tokens: 30, text: 'Skill instructions' }
    const cases = [
      { tool: 'bash', data: base, cat: DICT_EN['cat.tool'], lens: 'bash' },
      { tool: 'skill', data: richTimeline({ nodes: [...base.nodes, skill] }), cat: DICT_EN['cat.skill'], lens: '' },
    ]
    for (const c of cases) {
      const scroller = overflowingScroller(1200)
      const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-col-browser') ? 450 : 0))
      try {
        const View = makeView(new TestClientCtx())
        const m = await mountInScroller(h(View, { sessionId: 'sv-tooljump-' + c.tool, useProjection: projectionsFor(c.data) }), scroller)
        const chip = queryAll(m.container, '.lc-ledger-out-chips .lc-ledger-chip').find(el => text(el).startsWith(c.tool))
        assert.ok(chip !== undefined)
        await click(chip)
        await flush()
        const open = queryAll(m.container, '.lc-br-cat-row.lc-br-cat-open')
        assert.equal(open.length, 1)
        assert.ok(text(open[0]).includes(c.cat), 'the bucket holding the results opens')
        const lens = open[0].parentElement?.querySelector<HTMLInputElement>('.lc-br-tool-search')
        assert.ok(lens !== null && lens !== undefined)
        assert.equal(lens.value, c.lens)
        assert.equal(queryAll(m.container, '.lc-br-elem-row').length, 1, 'the tool result is listed, never an empty lens')
        assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')
        await m.unmount()
      } finally {
        gBCR.mockRestore()
      }
    }
  })

  test('the whole tile reveals the events card as-is; a kind narrows it and scrolls it in', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-events-card') ? 700 : 0))
    try {
      const data = richTimeline({
        events: [
          ...richTimeline().events,
          { seq: 7, time: T0 + 6000, kind: 'model', from: 'a', to: 'b' },
        ],
      })
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, { sessionId: 'sv-eventsjump', useProjection: projectionsFor(data) }), scroller)
      await click(query(m.container, '.lc-core-kv-events'))
      await flush()
      const card = query(m.container, '.lc-events-card')
      assert.equal(queryAll(card, '.lc-gran-on').length, 5, 'every kind stays picked')
      assert.equal(queryAll(card, '.lc-event').length, 3, 'the unfiltered list keeps every row')
      assert.equal(scroller.scrollTop, 600, 'the events card scrolled to the scrollport top')

      const entry = query(m.container, '.lc-core-kv-event[data-kind="compaction"]')
      assert.equal(entry.getAttribute('role'), 'button')
      await click(entry)
      await flush()
      assert.deepEqual(
        queryAll(card, '.lc-gran-on').map(el => el.getAttribute('data-kind')),
        ['compaction'],
        'the picked kind is the only active lens',
      )
      assert.equal(queryAll(card, '.lc-event').length, 1, 'only the compaction row survives')
      assert.ok(text(card).includes(DICT_EN['kind.compaction']))
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })
})

describe('ContextView — the events card\'s boundary rows', () => {
  function compactionLink(container: ParentNode): HTMLElement {
    return eventLink(container, DICT_EN['ev.compaction'].replace('{n}', '2'))
  }

  test('a click pins the step the compaction landed on, aligns the browser, and reveals the trend card', async () => {
    const scroller = overflowingScroller(1200)
    const gBCR = stubRevealRects(scroller, el => (el.hasAttribute('data-lc-trend') ? 450 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, {
        sessionId: 'sv-compactjump',
        useProjection: projectionsFor(richTimeline()),
      }), scroller)
      assert.equal(queryAll(m.container, '.lc-bar-selected').length, 0, 'nothing is pinned before the click')

      await click(compactionLink(m.container))
      assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the landed-on step is pinned')
      assert.equal(query<HTMLElement>(m.container, '.lc-chart-scroll').scrollLeft, 1 * 16 + 7, 'the trend scrolled to the landed bar')
      assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4', 'the browser aligns to the same step')
      assert.equal(scroller.scrollTop, 350, 'the trend card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }

    const pruneData = richTimeline({
      events: [{ seq: 3, time: T0 + 2000, kind: 'prune', tokens: 500, turn: 1, step: 2, fromTurn: 1, fromStep: 1 }],
    })
    const pruneView = makeView(new TestClientCtx())
    const prune = await mount(h(pruneView, { sessionId: 'sv-prunejump', useProjection: projectionsFor(pruneData) }))
    await click(eventLink(prune.container, DICT_EN['ev.prune']))
    assert.ok(query(prune.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'), 'the pruned step is pinned')
    assert.equal(query<HTMLSelectElement>(prune.container, 'select.lc-br-pick').value, '4')
    await prune.unmount()
  })

  test('a click leaves the overview face and flips turn granularity to the exact step', async () => {
    const View = makeView(new TestClientCtx(), settingsWith({ defaultGranularity: 'turn' }))
    const m = await mount(h(View, { sessionId: 'sv-compactoverview', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2, 'one aggregate bar per turn at mount')
    await click(buttonByText(m.container, DICT_EN['trend.overview']))
    assert.ok(buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'))

    await click(compactionLink(m.container))
    assert.ok(!buttonByText(m.container, DICT_EN['trend.overview']).className.includes('lc-gran-on'), 'the overview yields to the bar face')
    assert.ok(buttonByText(m.container, DICT_EN['gran.step']).className.includes('lc-gran-on'), 'step granularity is on')
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)
    assert.ok(query(m.container, '.lc-bar[data-seq="4"]').className.includes('lc-bar-selected'))
    await m.unmount()
  })

  test('a compaction past the retained log has no landing step, so its row stays a plain label', async () => {
    const data = richTimeline({ events: [{ seq: 99, time: T0 + 9000, kind: 'compaction', count: 2, tokens: 100 }] })
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, { sessionId: 'sv-compactpast', useProjection: projectionsFor(data) }))
    const row = queryAll(m.container, '.lc-event').find(r => text(r).includes(DICT_EN['ev.compaction'].replace('{n}', '2')))
    assert.ok(row !== undefined, 'the compaction row is listed')
    assert.equal(row.querySelector('.lc-event-jump'), null, 'a jump it cannot make is not offered as a link')
    assert.equal(query(row, '.lc-event-label').tagName, 'SPAN')
    assert.equal(queryAll(m.container, '.lc-bar-selected').length, 0)
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    await m.unmount()
  })
})
})

describe('contextView.interactions', () => {

describe('ContextView — interactions', () => {
  test('the browser column caps at the left cards\' full extent, flush with the column, live', async () => {
    const orig = Element.prototype.getBoundingClientRect
    let cardH = 100
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const box = orig.call(this)
      const parent = this.parentElement
      if (!this.classList.contains('lc-card') || parent === null
        || !parent.classList.contains('lc-col') || parent.classList.contains('lc-col-browser')) return box
      const top = 100 + [...parent.children].indexOf(this) * (cardH + 7)
      return { ...box, top, bottom: top + cardH }
    } as never
    try {
      const View = makeView(new TestClientCtx())
      const el = () => h(View, {
        sessionId: 'sv-cap',
        useProjection: projectionsFor(richTimeline(), {
          contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
        }),
        useChat: (sel => sel({ legacy: { nodes: [] } })) as UseChatLike,
      })
      const m = await mount(el())
      const col = query<HTMLElement>(m.container, '.lc-col-browser')
      assert.equal(col.style.maxHeight, '207px', 'two 100px cards and their 7px gap')
      assert.equal(col.style.overflowY, '')
      assert.ok(query(m.container, '.lc-br-scroll') !== null)
      cardH = 150
      await m.update(el())
      assert.equal(col.style.maxHeight, '307px', 'the cap follows the grown cards on the next render')
      await m.unmount()
    } finally {
      Element.prototype.getBoundingClientRect = orig
    }
  })

  test('bar hover previews in the browser; a turn-less bar highlights nothing; hover loss on a granularity switch falls back', async () => {
    const m = await mountRich('sv-hover')
    const chart = query(m.container, '.lc-chart')
    const bar2 = query(m.container, '.lc-bar[data-seq="2"]')
    await hover(bar2)
    assert.ok(bar2.className.includes('lc-bar-hovered'))
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    await click(buttonByText(m.container, DICT_EN['gran.turn']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    assert.equal(queryAll(m.container, '.lc-bar-hovered').length, 0)
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    assert.equal(queryAll(m.container, '.lc-bar').length, 3)

    const bar6 = query(m.container, '.lc-bar[data-seq="6"]')
    await hover(bar6)
    assert.ok(bar6.className.includes('lc-bar-hovered'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await m.unmount()
  })

  test('turn strip hover dims, strip click focuses the turn in turn granularity', async () => {
    const m = await mountRich('sv-strip')
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    await hover(turns[0])
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    await unhover(query(m.container, '.lc-turns'))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))

    await click(turns[0])
    assert.ok(buttonByText(m.container, DICT_EN['gran.turn']).className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar').length, 2)
    await click(buttonByText(m.container, DICT_EN['gran.step']))
    await m.unmount()
  })

  test('pinning a bar selects its step in the browser; unpinning returns to live', async () => {
    const m = await mountRich('sv-pin')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')
    assert.equal(pick.value, 'live')

    const bar4 = query(m.container, '.lc-bar[data-seq="4"]')
    await click(bar4)
    assert.ok(bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, '4')
    assert.ok(query(m.container, '.lc-detail').textContent?.includes('✂') === true)

    await click(bar4)
    assert.ok(!bar4.className.includes('lc-bar-selected'))
    assert.equal(pick.value, 'live')
    await m.unmount()
  })

  test('brief rows locate their node in the browser (input, mid response, live response)', async () => {
    const m = await mountRich('sv-brief')
    const pick = query<HTMLSelectElement>(m.container, 'select.lc-br-pick')

    await click(query(m.container, '.lc-bar[data-seq="4"]'))
    const briefRows = queryAll(m.container, '.lc-brief-row')
    assert.equal(briefRows.length, 3)

    const inRow = briefRows.find(r => text(r).includes(DICT_EN['brief.input']))
    assert.ok(inRow !== undefined)
    await click(inRow)
    assert.equal(pick.value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))

    const replyRow = briefRows.find(r => text(r).includes('reply two'))
    assert.ok(replyRow !== undefined)
    await click(replyRow)
    assert.equal(pick.value, '6')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply two'))

    await click(query(m.container, '.lc-bar[data-seq="6"]'))
    const lastReply = queryAll(m.container, '.lc-brief-row').find(r => text(r).includes('reply three'))
    assert.ok(lastReply !== undefined)
    await click(lastReply)
    assert.equal(pick.value, 'live')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('reply three'))
    await m.unmount()
  })

  test('category hover links the composition legend, browser rows, trend segments, and detail chips', async () => {
    const m = await mountRich('sv-link-trend')
    const comp = queryAll(m.container, '.lc-card').find(c => text(c).includes(DICT_EN['overview.title']))
    assert.ok(comp !== undefined)

    const compChip = query(comp, '.lc-legend .lc-chip')
    await hover(compChip)
    assert.ok(query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))
    await unhover(compChip)
    assert.ok(!query(m.container, '.lc-br-cat-row').className.includes('lc-br-cat-on'))

    const toolsRow = queryAll(m.container, '.lc-br-cat-row')[1]
    await hover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    const detailBar = query(m.container, '.lc-detail .lc-stacked')
    assert.ok(detailBar.className.includes('lc-stacked-dim'))
    assert.ok(queryAll(detailBar, '.lc-stacked-seg-on').length === 1)
    assert.ok(queryAll(m.container, '.lc-detail .lc-chip-on').length === 1, 'the matching detail chip lights too')

    await unhover(toolsRow)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))

    await hover(query(m.container, '.lc-stacked-free'))
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    assert.ok(!query(m.container, '.lc-detail .lc-stacked').className.includes('lc-stacked-dim'))
    await unhover(query(m.container, '.lc-stacked-free'))

    const detailChip = queryAll(m.container, '.lc-detail .lc-legend .lc-chip')[1]
    await hover(detailChip)
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')
    assert.equal(queryAll(comp, '.lc-legend .lc-chip-on').length, 1, 'the composition legend chip lights with it')
    await unhover(detailChip)
    assert.equal(query(m.container, '.lc-chart').hasAttribute('data-catdim'), false)
    await m.unmount()
  })

  test('expanding a browser category focuses the trend bars on it; collapsing restores all', async () => {
    const m = await mountRich('sv-focus')
    assert.equal(text(query(m.container, '.lc-axis-top')), '420', 'unfocused: the axis tops at the largest whole-bar total')
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)

    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '80')
    const segs = queryAll(m.container, '.lc-bar .lc-bar-stack > .lc-cat-seg')
    assert.equal(segs.length, 3)
    for (const s of segs) assert.equal(s.getAttribute('data-cat'), 'assistant')

    await click(queryAll(m.container, '.lc-br-cat-row')[5])
    assert.equal(text(query(m.container, '.lc-axis-top')), '420')
    assert.equal(queryAll(m.container, '.lc-bar[data-seq="4"] .lc-bar-stack > .lc-cat-seg').length, 5)
    await m.unmount()
  })

  test('the duration toggle overlays the active-time curve with a right-hand quartile axis; Adaptive toggles mount-locally', async () => {
    const View = makeView(new TestClientCtx())
    const m = await mount(h(View, {
      sessionId: 'sv-ms-curve',
      useProjection: projectionsFor(timeline({
        requests: [
          { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, activeMs: 1000 },
          { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400, activeMs: 2000 },
        ],
      })),
    }))

    const msBtn = () => buttonByText(m.container, DICT_EN['trend.duration'])
    assert.ok(msBtn().className.includes('lc-gran-on'), 'on at mount (the settings default)')
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-top')), '2.0s')
    assert.equal(text(query(m.container, '.lc-axis-r .lc-axis-mid')), '1.0s')

    await click(msBtn())
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    assert.equal(queryAll(m.container, '.lc-axis-r').length, 0)
    await click(msBtn())
    assert.equal(queryAll(m.container, '.lc-duration polyline:not(.lc-dur-halo)').length, 1)

    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    assert.ok(!adaptive().className.includes('lc-gran-on'), 'off at mount')
    await click(adaptive())
    assert.ok(adaptive().className.includes('lc-gran-on'))
    await click(adaptive())
    assert.ok(!adaptive().className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('the trend card\'s DNA toggle fingerprints the bars, combinable with Delta', async () => {
    const m = await mountRich('sv-trend-dna')
    const dnaBtn = () => buttonByText(m.container, DICT_EN['trend.dna'])
    assert.ok(!dnaBtn().className.includes('lc-gran-on'), 'off at mount')
    const dnaGroup = dnaBtn().parentElement as HTMLElement
    assert.ok(dnaGroup.className.includes('lc-trend-mods'))
    assert.equal(dnaBtn().getAttribute('title'), DICT_EN['trend.dnaTip'])
    assert.equal(dnaBtn().nextElementSibling, buttonByText(m.container, DICT_EN['trend.adaptive']), 'DNA rides left of the adaptive switch')

    await click(dnaBtn())
    assert.ok(dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 3)

    const g = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna').style.background
    const amberAt = g.indexOf('color-amber-500')
    const greenAt = g.indexOf('color-green-500')
    const blueAt = g.indexOf('color-blue-500')
    const tealAt = g.indexOf('color-teal-500')
    assert.ok(amberAt >= 0 && greenAt > amberAt && blueAt > greenAt && tealAt > blueAt, g)

    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 2)
    assert.ok(text(query(m.container, '.lc-axis-mid')).includes('0'), 'the delta zero line label rides the axis')

    await click(dnaBtn())
    assert.ok(!dnaBtn().className.includes('lc-gran-on'))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 0)
    assert.ok(queryAll(m.container, '.lc-bar-up').length > 0, 'delta arms are back')

    const browserDna = () => query(m.container, '.lc-br-dna-ctl .lc-gran-btn')
    await click(dnaBtn())
    assert.ok(browserDna().className.includes('lc-gran-on'), 'the browser follows the trend toggle')
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 1)
    await click(browserDna())
    assert.ok(!dnaBtn().className.includes('lc-gran-on'), 'the trend follows the browser toggle')
    assert.equal(queryAll(m.container, '.lc-br-bar-dna').length, 0)
    await m.unmount()
  })

  test('Delta arms Adaptive and links the browser switch; Overview suppresses the link', async () => {
    const m = await mountRich('sv-trend-delta-link')
    const trendDelta = () => buttonByText(m.container, DICT_EN['gran.delta'])
    const browserDelta = () => query(m.container, '.lc-br-delta-ctl .lc-gran-btn')
    const adaptive = () => buttonByText(m.container, DICT_EN['trend.adaptive'])
    const overview = () => buttonByText(m.container, DICT_EN['trend.overview'])
    assert.ok(!browserDelta().className.includes('lc-gran-on'), 'off at mount')
    assert.equal(query(m.container, '.lc-br-delta-ctl').getAttribute('title'), DICT_EN['browser.deltaTip'])
    assert.equal(query(m.container, '.lc-br-dna-ctl').nextElementSibling, query(m.container, '.lc-br-delta-ctl'), 'the switch sits right of DNA mode')

    await click(trendDelta())
    assert.ok(trendDelta().className.includes('lc-gran-on'))
    assert.ok(browserDelta().className.includes('lc-gran-on'), 'the browser follows the trend Delta')
    assert.ok(adaptive().className.includes('lc-gran-on'), 'Delta arms Adaptive')
    assert.ok(text(query(m.container, '.lc-br-meta')).includes('Added ≈'))

    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!trendDelta().className.includes('lc-gran-on'))
    assert.ok(adaptive().className.includes('lc-gran-on'), 'leaving Delta keeps Adaptive as set')

    await click(trendDelta())
    await click(adaptive())
    assert.ok(!adaptive().className.includes('lc-gran-on'), 'Adaptive stays switchable under Delta')
    await click(trendDelta())
    assert.ok(!adaptive().className.includes('lc-gran-on'), 're-clicking the active Delta chip keeps the opt-out')

    await click(browserDelta())
    assert.ok(!trendDelta().className.includes('lc-gran-on'), 'the trend follows the browser switch')
    assert.ok(!browserDelta().className.includes('lc-gran-on'))

    await click(browserDelta())
    assert.ok(browserDelta().className.includes('lc-gran-on'), 'the browser can switch it back on')
    assert.ok(trendDelta().className.includes('lc-gran-on'), 'the trend follows that direction too')
    assert.ok(adaptive().className.includes('lc-gran-on'), 'the linked switch arms Adaptive too')

    await click(overview())
    assert.ok(overview().className.includes('lc-gran-on'))
    assert.ok(!adaptive().className.includes('lc-gran-on'), 'Overview clears Adaptive')
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    await click(trendDelta())
    assert.ok(overview().className.includes('lc-gran-on'), 'Overview keeps the face')
    assert.ok(!adaptive().className.includes('lc-gran-on'), 'Overview suppresses the Delta-to-Adaptive link')

    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!trendDelta().className.includes('lc-gran-on'))
    assert.ok(!browserDelta().className.includes('lc-gran-on'))
    await m.unmount()
  })

  test('clicking a DNA band reveals that item in the Context browser', async () => {    const m = await mountRich('sv-dna-reveal')
    await click(buttonByText(m.container, DICT_EN['trend.dna']))
    const dnaDiv = query(m.container, '.lc-bar[data-seq="4"] .lc-bar-dna')
    dnaDiv.getBoundingClientRect = () => ({ top: 0, left: 0, right: 14, bottom: 112, width: 14, height: 112, x: 0, y: 0, toJSON: () => null }) as DOMRect
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    await flush()
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    assert.ok(text(query(m.container, '.lc-br-elem-on')).includes('file output'))
    await m.unmount()
  })

  test('delta mode pairs the detail with the previous record; first bar has none', async () => {
    const m = await mountRich('sv-delta')
    const chart = query(m.container, '.lc-chart')
    await click(buttonByText(m.container, DICT_EN['gran.delta']))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await hover(query(m.container, '.lc-bar[data-seq="2"]'))
    assert.ok(query(m.container, '.lc-bar[data-seq="2"]').className.includes('lc-bar-hovered'))
    assert.ok(queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await unhover(chart)
    await click(buttonByText(m.container, DICT_EN['gran.total']))
    assert.ok(!queryAll(m.container, '.lc-detail-tag').some(el => text(el) === DICT_EN['gran.delta']))
    await m.unmount()
  })

  test('event-kind filter narrows, unions, drops, and resets', async () => {
    const m = await mountRich('sv-kinds')
    const countEvents = () => queryAll(m.container, '.lc-event').length
    const kindBtn = (k: string) => query(m.container, `.lc-kinds [data-kind="${k}"]`) as HTMLElement
    assert.equal(countEvents(), 2)
    assert.deepEqual(
      queryAll(m.container, '.lc-kinds .lc-kind-n').map(el => text(el)),
      ['1', '1', '0'],
    )

    await click(kindBtn('inject'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 2)
    await click(kindBtn('compaction'))
    assert.equal(countEvents(), 1)
    await click(kindBtn('inject'))
    assert.equal(countEvents(), 2)
    await m.unmount()
  })
})
})

describe('contextView.injectFocus', () => {

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

function injectTimeline(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return timeline({
    requests: [
      { seq: 4, turn: 1, step: 1, time: T0 + 1000, system: 10, tools: 20, user: 10, inject: 20, assistant: 0, tool: 0, total: 60 },
      { seq: 8, turn: 1, step: 2, time: T0 + 2000, system: 10, tools: 20, user: 10, inject: 20, assistant: 0, tool: 0, total: 60 },
    ],
    events: [
      { seq: 3, time: T0 + 500, kind: 'inject', form: 'notice', name: 'hook', tokens: 20, turn: 1, step: 1 },
      { seq: 5, time: T0 + 1500, kind: 'inject', form: 'context', name: 'dropped', tokens: 5 },
      { seq: 11, time: T0 + 3000, kind: 'inject', form: 'notice', name: 'late', tokens: 7 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 },
      { seq: 3, cat: 'inject', tokens: 20, time: T0 + 500, text: 'the injected note' },
      { seq: 11, cat: 'inject', tokens: 7, time: T0 + 3000, text: 'the late note' },
    ],
    ...over,
  })
}

function mountInject(sessionId: string, data: ContextTimeline) {
  const View = makeView(new TestClientCtx())
  return mount(h(View, { sessionId, useProjection: projectionsFor(data) }))
}

describe('ContextView — injection rows reveal their item', () => {
  test('a click opens the browser on the injection\'s own item at its entry step and scrolls the card in', async () => {
    const scroller = overflowingScroller(800)
    const gBCR = stubRevealRects(scroller, el => (el.classList.contains('lc-col-browser') ? 450 : 0))
    try {
      const View = makeView(new TestClientCtx())
      const m = await mountInScroller(h(View, {
        sessionId: 'sv-injectfocus',
        useProjection: projectionsFor(injectTimeline()),
      }), scroller)
      assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0, 'nothing is open before the click')

      await click(eventLink(m.container, DICT_EN['form.notice'] + ' · hook'))

      assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4', 'the entry step is selected')
      const open = queryAll(m.container, '.lc-br-elem-on')
      assert.equal(open.length, 1)
      assert.ok(text(open[0]).includes('the injected note'), 'the injection\'s own item is open')
      assert.ok(queryAll(m.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'), 'the Inject category is open')
      assert.equal(scroller.scrollTop, 350, 'the browser card scrolled to the scrollport top')
      await m.unmount()
    } finally {
      gBCR.mockRestore()
    }
  })

  test('an injection past the last request reveals on the live surface', async () => {
    const m = await mountInject('sv-injectlive', injectTimeline())
    await click(eventLink(m.container, DICT_EN['form.notice'] + ' · late'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, 'live')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('the late note'))
    await m.unmount()
  })

  test('an injection whose item is no longer served moves to its step, opening the category only', async () => {
    const m = await mountInject('sv-injectdropped', injectTimeline())
    await click(eventLink(m.container, DICT_EN['form.context'] + ' · dropped'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '8')
    assert.equal(queryAll(m.container, '.lc-br-elem-on').length, 0, 'the item is not served, so no row can open')
    assert.ok(queryAll(m.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'))
    await m.unmount()
  })

  test('a compaction shadow reveals on the steps before its removal, and never after it', async () => {
    const archived = (gone: number) => injectTimeline({
      nodes: [{ seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 }],
      archive: [{ seq: 3, cat: 'inject', tokens: 20, time: T0 + 500, text: 'the removed note', gone }],
    })

    const m = await mountInject('sv-injectshadow', archived(6))
    await click(eventLink(m.container, DICT_EN['form.notice'] + ' · hook'))
    assert.equal(query<HTMLSelectElement>(m.container, 'select.lc-br-pick').value, '4')
    const open = queryAll(m.container, '.lc-br-elem-on')
    assert.equal(open.length, 1)
    assert.ok(text(open[0]).includes('the removed note'))
    await m.unmount()

    const gone = await mountInject('sv-injectgone', archived(4))
    await click(eventLink(gone.container, DICT_EN['form.notice'] + ' · hook'))
    assert.equal(query<HTMLSelectElement>(gone.container, 'select.lc-br-pick').value, 'live')
    assert.equal(queryAll(gone.container, '.lc-br-elem-on').length, 0)
    assert.ok(!queryAll(gone.container, '.lc-br-cat-row')[3].className.includes('lc-br-cat-open'))
    await gone.unmount()
  })
})
})
