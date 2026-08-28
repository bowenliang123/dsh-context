/**
 * TrendChart (src/client/components/trendChart.tsx) rendered with the REAL React 18 tree in jsdom: stacked step bars,
 * turn aggregation, total/delta geometry, compaction/prune markers, hover tooltips, scroll anchoring, and turn-label
 * centering. The pure helpers (aggregateByTurn/attachMarkers) are also driven directly.
 *
 * jsdom reports zero layout metrics, so beforeAll overrides them (scrollWidth follows the bar count, clientWidth is
 * test-controlled, the scrollLeft setter dispatches a real scroll event in a microtask) — the overflow/scroll-anchor
 * logic runs FOR REAL — and afterAll restores the originals.
 *
 * Note: the 'trend.empty' panel and the defaultGranularity/defaultTrendMode settings reads live in the PARENT
 * (contextView.tsx); TrendChart itself always renders the chart frame, so the empty-history arm is asserted as an
 * empty frame here.
 */

import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { act } from 'react'
import { h } from '../../../src/client/react'
import { aggregateByTurn, attachMarkers, makeTrendChart, type TrendChartProps } from '../../../src/client/components/trendChart'
import { CATS } from '../../../src/client/categories'
import { replyTipsOf } from '../../../src/client/brief'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../../src/shared/types'
import { click, flush, hover, makeKit, mount, query, queryAll, unhover } from '../helpers/kit'

const kit = makeKit()
const TrendChart = makeTrendChart(kit)

const CHART_H = 112
const BAR_CELL = 16 // BAR_W 14 + BAR_GAP 2

/** Module-level default client width; tests may retarget it (with try/finally) before mounting. */
let CLIENT_W = 400

type LayoutEl = HTMLElement & { __clientW?: number; __scrollL?: number; __scrollW?: number }

let saved: [string, PropertyDescriptor | undefined][] = []

beforeAll(() => {
  saved = (['scrollWidth', 'clientWidth', 'scrollLeft'] as const)
    .map((name): [string, PropertyDescriptor | undefined] => [name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)])
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', {
    configurable: true,
    get(this: LayoutEl): number {
      if (this.classList && this.classList.contains('lc-chart-scroll')) {
        return Math.max(this.clientWidth, this.querySelectorAll('.lc-bar').length * BAR_CELL)
      }
      return this.__scrollW ?? 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: LayoutEl): number { return this.__clientW ?? CLIENT_W },
  })
  Object.defineProperty(HTMLElement.prototype, 'scrollLeft', {
    configurable: true,
    get(this: LayoutEl): number { return this.__scrollL ?? 0 },
    set(this: LayoutEl, v: number) {
      this.__scrollL = Math.max(0, Math.min(v, Math.max(0, this.scrollWidth - this.clientWidth)))
      const el = this
      queueMicrotask(() => { if (el.isConnected) el.dispatchEvent(new Event('scroll')) })
    },
  })
})

afterAll(() => {
  for (const [name, desc] of saved) {
    if (desc === undefined) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name]
    else Object.defineProperty(HTMLElement.prototype, name, desc)
  }
})

function req(seq: number, over: Partial<RequestRecord> = {}): RequestRecord {
  return {
    time: 1700000000000 + seq * 60000, seq, turn: 1, step: seq - 1,
    system: 100, tools: 50, user: 30, inject: 20, assistant: 40, tool: 60, total: 300,
    ...over,
  }
}

interface Spies {
  select: (number | null)[]
  hover: (number | null)[]
  hoverTurn: (number | null)[]
  pickTurn: number[]
  focusHandled: number
}

function makeSpies(): { spies: Spies; handlers: Pick<TrendChartProps, 'onSelect' | 'onHover' | 'onHoverTurn' | 'onPickTurn' | 'onFocusTurnHandled'> } {
  const spies: Spies = { select: [], hover: [], hoverTurn: [], pickTurn: [], focusHandled: 0 }
  return {
    spies,
    handlers: {
      onSelect: (s) => { spies.select.push(s) },
      onHover: (s) => { spies.hover.push(s) },
      onHoverTurn: (t) => { spies.hoverTurn.push(t) },
      onPickTurn: (t) => { spies.pickTurn.push(t) },
      onFocusTurnHandled: () => { spies.focusHandled++ },
    },
  }
}

function propsOf(requests: RequestRecord[], over: Partial<TrendChartProps> = {}): TrendChartProps {
  const { handlers } = makeSpies()
  return {
    requests,
    markers: requests.map(() => undefined),
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    focusTurn: null,
    hoverCat: null,
    ...handlers,
    ...over,
  }
}

function bars(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-bar')
}

/** jsdom/cssstyle may keep hex or normalize to rgb(); accept the exact color either way. */
function assertColor(actual: string, hex: string): void {
  const n = parseInt(hex.slice(1), 16)
  const rgb = `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
  assert.ok(actual === hex || actual === rgb, `expected ${actual} to be ${hex}`)
}


async function scrollTo(el: LayoutEl, v: number): Promise<void> {
  await act(async () => { el.scrollLeft = v })
  await flush()
}

async function scrollEvent(el: Element): Promise<void> {
  await act(async () => { el.dispatchEvent(new Event('scroll')) })
  await flush()
}

describe('TrendChart empty history', () => {
  test('renders the chart frame with no bars and no turn blocks', async () => {
    // The 'trend.empty' placeholder is the parent's (contextView) render arm; with zero requests the chart itself
    // renders an empty frame: unit axis (maxTotal floors at 1), empty scroll content, empty turn strip.
    const m = await mount(h(TrendChart, propsOf([])))
    assert.equal(bars(m.container).length, 0)
    assert.equal(queryAll(m.container, '.lc-turn').length, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(m.container, '.lc-grid-mid'), 'total mode keeps the dashed mid grid')
    await m.unmount()
  })
})

describe('TrendChart step granularity, total mode', () => {
  test('stacks per-category segments in CATS order with real colors and proportional px heights', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 })
    const r3 = req(3, { turn: undefined, step: 0, user: 0, total: 280 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    assert.deepEqual(bs.map(b => b.getAttribute('data-seq')), ['1', '2', '3'])

    // Six priced categories, in CATS order, with the shipped colors; max bar segments scale against maxTotal=600.
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 6)
    for (let i = 0; i < CATS.length; i++) assertColor(segs1[i].style.background, CATS[i].color)
    assert.equal(segs1[0].style.height, `${Math.round(100 / 600 * CHART_H)}px`)
    assert.equal(segs1[5].style.height, `${Math.round(60 / 600 * CHART_H)}px`)
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs2[0].style.height, `${Math.round(200 / 600 * CHART_H)}px`)

    // Zero-value categories are skipped entirely (r3.user = 0 → five segments, no user-green segment).
    const segs3 = queryAll(bs[2], '.lc-bar-stack > div')
    assert.equal(segs3.length, 5)
    assert.ok(![...segs3].some(s => s.style.background.includes('34, 197, 94') || s.style.background === '#22c55e'))

    // Total-mode axis: top = maxTotal, mid = half, bottom = 0.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '300')

    // Turn strip: T1 spans two step columns (2*16-2 = 30px), the turnless request lands in group T0 (14px);
    // zebra fills alternate and stay disjoint from the category palette.
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].style.width, '30px')
    assert.equal(turns[1].style.width, '14px')
    assert.ok(turns[0].style.background.includes('0.12'))
    assert.ok(turns[1].style.background.includes('0.26'))
    assert.deepEqual(turns.map(t => t.textContent), ['T1', 'T0'])
    await m.unmount()
  })

  test('provider prompt anchors bar height; zero/absent prompt and zero total fall back honestly', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600, prompt: 1200 })
    const r3 = req(3, { turn: 2, step: 0, prompt: 0 }) // prompt 0 → not an anchor, total drives
    const r4 = req(4, { turn: 3, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 500 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3, r4])))

    // maxTotal follows the provider prompt (1200), not the heuristic sum.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1.2k')
    const bs = bars(m.container)
    assert.equal(bs.length, 4)
    // r2 anchor = 1200/600 = 2: the system segment rides 200*2 against the 1200 max.
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs2[0].style.height, `${Math.round(200 * 2 / 1200 * CHART_H)}px`)
    // r4 anchors to prompt (500) but every category is zero → the stack renders no segments.
    assert.equal(queryAll(bs[3], '.lc-bar-stack > div').length, 0)

    // The tip is placed over its bar's visible slice imperatively (transform, not `left`), so it never
    // contributes to the scroller's overflow — see the overlay test below.
    const { spies, handlers } = makeSpies()
    await m.update(h(TrendChart, { ...propsOf([r1, r2, r3, r4]), ...handlers, hoveredSeq: 2 }))
    const tip = query(m.container, '.lc-chart-tip')
    assert.equal(
      tip.textContent,
      kit.t('tip.step', { t: 1, s: 1 }) + ' · ' + kit.fmtTime(r2.time) + ' · '
        + kit.t('tip.total', { n: '600' }) + ' · ' + kit.t('tip.actual', { n: '1.2k' }),
    )
    assert.equal(tip.style.transform, 'translate(23px, 0)') // idx 1 * 16 + BAR_W/2, scrollLeft 0
    assert.ok(spies.hover.length === 0, 'hover callback only fires from real mouseover')
    await m.unmount()
  })

  test('a zero-only history keeps the unit scale (maxTotal floors at 1)', async () => {
    const zero = req(1, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const m = await mount(h(TrendChart, propsOf([zero])))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '1')
    assert.equal(queryAll(bars(m.container)[0], '.lc-bar-stack > div').length, 0)
    await m.unmount()
  })
})

describe('TrendChart delta mode', () => {
  const base = req(1, { turn: 1, step: 0 })
  const grown = req(2, { turn: 1, step: 1, system: 110, tools: 60, user: 40, inject: 30, assistant: 50, tool: 70, total: 360 })
  const shrunk = req(3, { turn: 2, step: 0, system: 90, tools: 40, user: 20, inject: 10, assistant: 30, tool: 50, total: 240 })
  const zeroReq = req(9, { turn: 3, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })

  test('diverging stacks pile positive deltas up and hang negatives down off a solid zero line', async () => {
    const nodes: SurfaceNode[] = [{ seq: 2, cat: 'assistant', tokens: 5, text: 'did work' }]
    const m = await mount(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', replyTips: replyTipsOf(nodes) })))

    // maxUp=60 (grown: +10 x6), maxDown=120 (shrunk: -20 x6) → scale 112/180, zero line at upPx=37.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+60')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 37}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-120')
    assert.equal(query(m.container, '.lc-grid-zero').style.top, `${18 + 37}px`)

    const bs = bars(m.container)
    // First bar starts from zero: both diverging stacks render empty.
    assert.equal(queryAll(bs[0], '.lc-bar-up > div').length, 0)
    assert.equal(queryAll(bs[0], '.lc-bar-down > div').length, 0)
    // Grown bar: six +10 segments above the zero line, nothing below.
    const up2 = queryAll(bs[1], '.lc-bar-up > div')
    assert.equal(up2.length, 6)
    assert.equal(up2[0].style.height, `${Math.round(10 * CHART_H / 180)}px`)
    assertColor(up2[0].style.background, CATS[0].color)
    assert.equal(queryAll(bs[1], '.lc-bar-down > div').length, 0)
    // Shrunk bar: six -20 segments below, nothing above.
    const down3 = queryAll(bs[2], '.lc-bar-down > div')
    assert.equal(down3.length, 6)
    assert.equal(down3[0].style.height, `${Math.round(20 * CHART_H / 180)}px`)
    assert.equal(queryAll(bs[2], '.lc-bar-up > div').length, 0)
    // The up stack rides downPx up from the bottom, the down stack hangs upPx from the zero line.
    assert.equal(query(bs[1], '.lc-bar-up').style.bottom, '75px')
    assert.equal(query(bs[2], '.lc-bar-down').style.top, '37px')

    // Delta tooltip: signed net change, '+' only for positive nets; the reply tail still appends.
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', replyTips: replyTipsOf(nodes), hoveredSeq: 2 })))
    assert.equal(
      query(m.container, '.lc-chart-tip').textContent,
      kit.t('tip.step', { t: 1, s: 1 }) + ' · ' + kit.fmtTime(grown.time) + ' · ' + kit.t('tip.delta', { n: '+60' }) + ' · “did work”',
    )
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 3 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '-120' })))
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 1 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '0' })))
    await m.unmount()
  })

  test('growth-only history zeroes the negative axis arm; shrink-only zeroes the positive arm', async () => {
    const up = await mount(h(TrendChart, propsOf([zeroReq, base], { mode: 'delta' })))
    assert.equal(query(up.container, '.lc-axis-top').textContent, '+300')
    assert.equal(query(up.container, '.lc-axis-bot').textContent, '0')
    const upSegs = queryAll(bars(up.container)[1], '.lc-bar-up > div')
    assert.equal(upSegs.length, 6)
    assert.equal(upSegs[0].style.height, `${Math.round(100 * CHART_H / 300)}px`)
    await up.unmount()

    const down = await mount(h(TrendChart, propsOf([base, zeroReq], { mode: 'delta' })))
    assert.equal(query(down.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(down.container, '.lc-axis-bot').textContent, '-300')
    assert.equal(queryAll(bars(down.container)[1], '.lc-bar-down > div').length, 6)
    await down.unmount()
  })
})

describe('TrendChart turn granularity', () => {
  const t1s0 = req(1, { turn: 1, step: 0 })
  const t1s1 = req(2, { turn: 1, step: 1, total: 360 })
  const t2s0 = req(3, { turn: 2, step: 0, total: 280 })

  test('turn aggregates render one bar per turn with aggregated labels and step-count tooltips', async () => {
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const bs = bars(m.container)
    assert.equal(bs.length, 2)
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    // Aggregated groups always occupy exactly one column.
    assert.deepEqual(turns.map(t => t.style.width), ['14px', '14px'])
    assert.deepEqual(turns.map(t => t.textContent), ['T1', 'T2'])

    // Multi-step aggregate → tip.turn; single-step aggregate falls back to tip.step.
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t1s1.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 1, n: 2 })))
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t2s0.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.step', { t: 2, s: 0 })))
    await m.unmount()

    // A multi-step aggregate of TURNLESS requests reports turn 0.
    const turnless = aggregateByTurn([req(10, { turn: undefined }), req(11, { turn: undefined })])
    const m2 = await mount(h(TrendChart, propsOf(turnless, { granularity: 'turn', hoveredSeq: 11 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 0, n: 2 })))
    await m2.unmount()
  })

  test('turn strip hover/click drive the turn callbacks; activeTurn dims the chart and lights the block', async () => {
    const { spies, handlers } = makeSpies()
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn' })))

    const turns = queryAll(m.container, '.lc-turn')
    await hover(turns[0])
    assert.deepEqual(spies.hoverTurn, [1])
    await click(turns[1])
    assert.deepEqual(spies.pickTurn, [2])
    await unhover(turns[0])
    assert.deepEqual(spies.hoverTurn, [1, null])

    await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', activeTurn: 1 })))
    assert.ok(query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    const bs = bars(m.container)
    assert.ok(bs[0].className.includes('lc-bar-in-turn'))
    assert.ok(!bs[1].className.includes('lc-bar-in-turn'))
    assert.ok(queryAll(m.container, '.lc-turn')[0].className.includes('lc-turn-on'))
    assert.ok(!queryAll(m.container, '.lc-turn')[1].className.includes('lc-turn-on'))

    await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', activeTurn: null })))
    assert.ok(!query(m.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    assert.ok(!bars(m.container)[0].className.includes('lc-bar-in-turn'))
    await m.unmount()
  })
})

describe('TrendChart selection and hover linking', () => {
  test('clicking a bar picks it, clicking the picked bar clears it; turnless bars match activeTurn 0', async () => {
    const { spies, handlers } = makeSpies()
    const x1 = req(1, { turn: undefined, step: undefined })
    const x2 = req(2, { turn: 2, step: 0 })
    const m = await mount(h(TrendChart, propsOf([x1, x2], handlers)))

    await click(bars(m.container)[0])
    assert.deepEqual(spies.select, [1])
    await m.update(h(TrendChart, propsOf([x1, x2], { ...handlers, selectedSeq: 1 })))
    assert.ok(bars(m.container)[0].className.includes('lc-bar-selected'))
    assert.ok(!bars(m.container)[1].className.includes('lc-bar-selected'))

    await click(bars(m.container)[0])
    assert.deepEqual(spies.select, [1, null])
    await m.update(h(TrendChart, propsOf([x1, x2], { ...handlers, selectedSeq: 2 })))
    assert.ok(bars(m.container)[1].className.includes('lc-bar-selected'))

    // activeTurn against a turnless bar: 0 (its ?? fallback) mismatches turn 5, matches turn 0.
    await m.update(h(TrendChart, propsOf([x1, x2], { ...handlers, selectedSeq: 2, activeTurn: 5 })))
    assert.ok(!bars(m.container)[0].className.includes('lc-bar-in-turn'))
    await m.update(h(TrendChart, propsOf([x1, x2], { ...handlers, selectedSeq: 2, activeTurn: 0 })))
    assert.ok(bars(m.container)[0].className.includes('lc-bar-in-turn'))
    assert.ok(!bars(m.container)[1].className.includes('lc-bar-in-turn'))
    await m.unmount()
  })
})

describe('TrendChart category hover-link', () => {
  test('segments carry their category key; the container mirrors the shared hover for CSS to light', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 200 })
    const r3 = req(3, { turn: 2, step: 0 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3], { hoverCat: 'tools' })))

    // No hover: the container carries no dim attribute at all.
    await m.update(h(TrendChart, propsOf([r1, r2, r3])))
    const chart = query(m.container, '.lc-chart')
    assert.equal(chart.hasAttribute('data-catdim'), false)

    // Every total-mode segment is tagged with its category; a zero-value category renders no segment to light.
    const segs = queryAll(chart, '.lc-bar[data-seq="1"] .lc-bar-stack > .lc-cat-seg')
    assert.deepEqual(segs.map(s => s.getAttribute('data-cat')), CATS.map(c => c.key))

    // The hovered key rides the container attribute — the dim/highlight pairing itself is CSS.
    await m.update(h(TrendChart, propsOf([r1, r2, r3], { hoverCat: 'tools' })))
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')

    // Delta mode: diverging stacks' segments are tagged the same way — an all-shrinking pair hangs all six below the line.
    const big = req(4, { turn: 3, step: 0, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120 })
    await m.update(h(TrendChart, propsOf([big, r1], { mode: 'delta', hoverCat: 'user' })))
    const deltaChart = query(m.container, '.lc-chart')
    assert.equal(deltaChart.getAttribute('data-catdim'), 'user')
    assert.deepEqual(
      queryAll(deltaChart, '.lc-bar-down > .lc-cat-seg').map(s => s.getAttribute('data-cat')),
      CATS.map(c => c.key),
    )
    await m.unmount()
  })
})

describe('TrendChart markers', () => {
  test('compaction/prune markers render the ✂ glyph with a positioned or bare title', async () => {
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const compaction: ContextEventRecord = { seq: 2, time: 1700000000000, kind: 'compaction', count: 5, fromTurn: 1, fromStep: 0, turn: 1, step: 1 }
    const prune: ContextEventRecord = { seq: 3, time: 1700000060000, kind: 'prune' }
    const markers = attachMarkers(reqs, [compaction, prune])
    assert.equal(markers[1], compaction)
    assert.equal(markers[2], prune)

    const m = await mount(h(TrendChart, propsOf(reqs, { markers })))
    const glyph = queryAll(m.container, '.lc-bar-marker')
    assert.equal(glyph.length, 2)
    assert.equal(glyph[0].textContent, '✂')
    assert.equal(
      glyph[0].getAttribute('title'),
      '✂ ' + kit.t('events.range', { t: 1, a: 0, b: 1 }) + ' — ' + kit.t('ev.compaction', { n: 5 }),
    )
    // No host-stamped position → bare label title.
    assert.equal(glyph[1].getAttribute('title'), '✂ ' + kit.t('ev.prune'))
    await m.unmount()
  })
})

describe('TrendChart tooltips', () => {
  const r1 = req(1, { turn: 1, step: 0 })
  const r2 = req(2, { turn: 1, step: 1, total: 360 })
  const r3 = req(3, { turn: 2, step: 0 })
  const r4 = req(4, { turn: undefined, step: undefined })
  const nodes: SurfaceNode[] = [
    { seq: 1, cat: 'assistant', tokens: 5, text: 'fixed the bug' },
    { seq: 2, cat: 'assistant', tokens: 5, text: 'a'.repeat(60) },
    { seq: 3, cat: 'assistant', tokens: 5, calls: ['bash', 'read'] },
  ]

  test('hover floats a positioned tip with step identity, total, and reply preview variants', async () => {
    const { spies, handlers } = makeSpies()
    const reqs = [r1, r2, r3, r4]
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))

    // No replyTips prop at all: the tip renders without a tail.
    const bs = bars(m.container)
    await hover(bs[0])
    assert.deepEqual(spies.hover, [1])
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 1 })))
    assert.equal(
      query(m.container, '.lc-chart-tip').textContent,
      kit.t('tip.step', { t: 1, s: 0 }) + ' · ' + kit.fmtTime(r1.time) + ' · ' + kit.t('tip.total', { n: '300' }),
    )
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(7px, 0)')

    // With replyTips (built by the real replyTipsOf): short reply lands verbatim.
    const withTips = (hoveredSeq: number | null): TrendChartProps =>
      propsOf(reqs, { ...handlers, hoveredSeq, replyTips: replyTipsOf(nodes) })
    await m.update(h(TrendChart, withTips(1)))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.endsWith(' · “fixed the bug”'))

    // Long replies truncate to 48 chars plus the ellipsis; call breadcrumbs join with ›.
    await m.update(h(TrendChart, withTips(2)))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.endsWith(' · “' + 'a'.repeat(48) + '…”'))
    await m.update(h(TrendChart, withTips(3)))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.endsWith(' · “bash › read”'))

    // No reply row → no tail; turnless/step-less bars fall back to Turn 0 · Step 0.
    await m.update(h(TrendChart, withTips(4)))
    const tip4 = query(m.container, '.lc-chart-tip').textContent!
    assert.ok(tip4.startsWith(kit.t('tip.step', { t: 0, s: 0 })))
    assert.ok(!tip4.includes('“'))

    // A hoveredSeq outside the rendered list floats no tip.
    await m.update(h(TrendChart, withTips(999)))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)

    // Leaving the chart clears the hover and hides the tip.
    await m.update(h(TrendChart, withTips(1)))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    await unhover(query(m.container, '.lc-chart'))
    assert.deepEqual(spies.hover, [1, null])
    await m.update(h(TrendChart, withTips(null)))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    await m.unmount()
  })
})

describe('TrendChart scroll anchoring', () => {
  function manySteps(): RequestRecord[] {
    const out: RequestRecord[] = []
    for (let i = 0; i < 40; i++) {
      out.push(req(i + 1, { turn: 1 + Math.floor(i / 10), step: i % 10 }))
    }
    return out
  }

  test('the end-anchor sticks only near the end', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')

    // scrollWidth 640 vs clientWidth 400: mount anchors to the newest (right) edge.
    assert.equal(scroll.scrollLeft, 240)
    await scrollTo(scroll, 100)

    // An unrelated (selection-only) update mid-scroll does NOT re-anchor (100 + 400 < 640 - 24), and the chart
    // also stays put when the same selection-only update fires NEAR the right edge — only a real data push
    // (a new request appended, or a granularity/focus switch) may follow the newest bar, so a hover/select
    // change never flashes the column.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, selectedSeq: 1 })))
    assert.equal(scroll.scrollLeft, 100)
    await scrollTo(scroll, 230)
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, selectedSeq: 2 })))
    await flush()
    assert.equal(scroll.scrollLeft, 230, 'selection-only update near the end does not stick')

    // Turn labels re-center within their visible slice: with the reader at scrollLeft 240, T2 is half-clipped
    // at the left → shifted right; T3 is fully visible and centered → no transform; T1 is fully out of view
    // → untouched.
    await scrollTo(scroll, 240)
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.equal(labels.length, 4)
    assert.equal(labels[1].style.transform, 'translateX(40px)')
    assert.equal(labels[2].style.transform, '')
    assert.equal(labels[0].style.transform, '')
    await scrollTo(scroll, 0)
    assert.equal(labels[1].style.transform, '', 'back at the left edge every block centers natively')
    await m.unmount()
  })

  test('a data push follows the newest bar only when the reader was near the right edge', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    // Mount anchors at the right edge (scrollLeft = 240 over scrollWidth 640 / clientWidth 400).
    assert.equal(scroll.scrollLeft, 240)

    // A new request appended while the reader sits at the right edge → follows the newest bar.
    const grown = [...reqs, req(reqs.length + 1, { turn: 1 + Math.floor(reqs.length / 10), step: reqs.length % 10 })]
    await m.update(h(TrendChart, propsOf(grown, handlers)))
    await flush()
    assert.equal(scroll.scrollLeft, 256, 'near-edge reader follows the appended bar')

    // A push while the reader is mid-chart leaves them where they were — no auto-follow yank.
    await scrollTo(scroll, 100)
    const grown2 = [...grown, req(grown.length + 1, { turn: 1 + Math.floor(grown.length / 10), step: grown.length % 10 })]
    await m.update(h(TrendChart, propsOf(grown2, handlers)))
    await flush()
    assert.equal(scroll.scrollLeft, 100, 'mid-scroll reader is not yanked back to the newest')
    await m.unmount()
  })

  test('a granularity switch re-anchors and flips overflow for real (React #185 regression)', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, granularity: 'step' })))
    await flush()
    assert.equal(query(m.container, '.lc-chart-scroll').scrollLeft, 240)

    // Step → turn: 4 aggregated bars fit the viewport.
    await m.update(h(TrendChart, propsOf(aggregateByTurn(reqs), { ...handlers, granularity: 'turn' })))
    await flush()
    assert.equal(bars(m.container).length, 4)

    // Turn → step re-anchors to the newest bars again.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, granularity: 'step' })))
    await flush()
    assert.equal(bars(m.container).length, 40)
    assert.equal(query(m.container, '.lc-chart-scroll').scrollLeft, 240)
    await m.unmount()
  })

  test('focusTurn scroll-centers the target turn bar once; unknown turns still consume the focus', async () => {
    const savedW = CLIENT_W
    CLIENT_W = 30
    try {
      // Six aggregated turns (scrollWidth 96): the focus target sits far from the near-end stick zone.
      const agg = aggregateByTurn([...manySteps(), ...manySteps().map(r => ({ ...r, seq: r.seq + 40, turn: (r.turn ?? 0) + 4 }))])
      assert.equal(agg.length, 8)
      const { spies, handlers } = makeSpies()
      const m = await mount(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', focusTurn: 2 })))
      await flush()
      const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
      assert.ok(spies.focusHandled >= 1)
      assert.equal(scroll.scrollLeft, 8) // 1 * 16 + 7 - 30/2

      const before = spies.focusHandled
      await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', focusTurn: 99 })))
      await flush()
      assert.ok(spies.focusHandled > before, 'the focus is consumed even when the turn is absent')
      assert.equal(scroll.scrollLeft, 8, 'no focus target and not near the end → the scroll position holds')
      await m.unmount()
    } finally {
      CLIENT_W = savedW
    }
  })

  test('turn labels clear their shift for blocks narrower than the measured label', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < 16; i++) reqs.push(req(i + 1, { turn: 1 + Math.floor(i / 8), step: i % 8 }))
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.equal(labels.length, 2) // T1 off 0 w 126, T2 off 128 w 126; scrollWidth 256

    scroll.__clientW = 60
    await scrollTo(scroll, 150)
    // T2 visible slice [150, 210] → center 52 vs block center 63 → shift left; T1 fully out of view → untouched.
    assert.equal(labels[1].style.transform, 'translateX(-11px)')
    assert.equal(labels[0].style.transform, '')

    // A measured label wider than its block never shifts (block stays put).
    Object.defineProperty(labels[1], 'offsetWidth', { configurable: true, get: () => 200 })
    await scrollTo(scroll, 150)
    assert.equal(labels[1].style.transform, '')

    // A real measured label: clamped to keep the label inside its block on both sides.
    Object.defineProperty(labels[1], 'offsetWidth', { configurable: true, get: () => 40 })
    await scrollTo(scroll, 196)
    assert.equal(labels[1].style.transform, 'translateX(34px)')
    await scrollTo(scroll, 100)
    assert.equal(labels[1].style.transform, 'translateX(-43px)')
    await scrollTo(scroll, 0)
    assert.equal(labels[1].style.transform, '', 'fully out of view → shift cleared')
    await scrollEvent(scroll)
    assert.equal(labels[1].style.transform, '', 'repeat scroll with unchanged geometry writes nothing')
    await m.unmount()
  })
})

describe('TrendChart hover tip overlay', () => {
  function manySteps(): RequestRecord[] {
    const out: RequestRecord[] = []
    for (let i = 0; i < 40; i++) {
      out.push(req(i + 1, { turn: 1 + Math.floor(i / 10), step: i % 10 }))
    }
    return out
  }

  /**
   * The regression behind the overlay split: the tooltip used to live INSIDE .lc-chart-scroll, and an absolutely
   * positioned child of a scroller contributes to its scrollable overflow — a several-hundred-px reply preview on a
   * right-edge bar inflated scrollWidth on every hover, flapping the horizontal scrollbar open/closed and jumping the
   * whole card. The tip now lives beside the scroller (positioned by the wrapper), and syncTip glues it to the bar's
   * visible slice on every scroll/commit.
   */
  test('renders outside the scroller, glues to the visible slice while scrolling, and clamps at both edges', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    // Mounted WITH the hover set: the wrapper owns the tip from the very first commit (scrollWidth 640 > 400, so the
    // chart mounts pre-scrolled to sl=240).
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 40 })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const tip = query(m.container, '.lc-chart-tip')
    assert.equal(tip.parentElement!.className, 'lc-chart-wrap', 'the tip is a sibling of the scroller, not its child')
    assert.equal(query(m.container, '.lc-chart-wrap').contains(tip), true)
    assert.equal(query(m.container, '.lc-chart-wrap').contains(scroll), true)

    // Newest bar (idx 39 → col 631) fully scrolled into view at the right edge: dx = 631 - 240.
    assert.equal(tip.style.transform, 'translate(391px, 0)')

    // Glue without clamping: hover bar idx 19 (col 311) — the scroller is still parked at sl=240 from mount.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 20 })))
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(71px, 0)')
    // Scrolling without any React commit keeps the tip glued: 311 - 100 = 211.
    await scrollTo(scroll, 100)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(211px, 0)')
    // And again deeper: 311 - 211 = 100.
    await scrollTo(scroll, 211)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(100px, 0)')

    // Left-edge clamp: hovering bar idx 1 (col 23) while parked deep right pushes the raw dx far negative.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 2 })))
    await scrollTo(scroll, 240)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(0px, 0)')

    // Overflow geometry stays honest: the scrollable area is exactly the bars', never the tip's (jsdom cannot prove
    // the browser-level scrollbar parity here — verified against real Chromium separately).
    assert.equal(scroll.scrollWidth, 640)
    await m.unmount()
  })

  test('real tip widths clamp into the viewport on both sides and center when wider than the viewport', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 30 })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const tip = query<LayoutEl & { offsetWidth: number }>(m.container, '.lc-chart-tip')
    scroll.__clientW = 160
    Object.defineProperty(tip, 'offsetWidth', { configurable: true, get: () => 120 })
    // idx 29 → col 471. cw 160 / lw 120 → valid center window [60, 100]:
    try {
      // dx 471 far past the right edge → pinned at cw - lw/2.
      await scrollTo(scroll, 0)
      assert.equal(tip.style.transform, 'translate(40px, 0)')
      // dx 91, inside the window → rides raw.
      await scrollTo(scroll, 380)
      assert.equal(tip.style.transform, 'translate(31px, 0)')
      // Parked at the last sl (480): dx -9 → pinned at lw/2.
      await scrollTo(scroll, 480)
      assert.equal(tip.style.transform, 'translate(0px, 0)')

      // A tip wider than the viewport centers over it, bleeding symmetrically instead of picking a bogus side.
      Object.defineProperty(tip, 'offsetWidth', { configurable: true, get: () => 500 })
      await scrollTo(scroll, 0)
      assert.equal(tip.style.transform, 'translate(-170px, 0)')
    } finally {
      delete scroll.__clientW
    }
    await m.unmount()
  })
})

describe('aggregateByTurn', () => {
  test('collapses a run of same-turn steps into its last record tagged with the step count', () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1, total: 500 }),
      req(3, { turn: 2, step: 0 }),
    ])
    assert.equal(agg.length, 2)
    assert.equal(agg[0].seq, 2, 'the turn bar is its LAST step')
    assert.equal(agg[0].stepCount, 2)
    assert.equal(agg[0].total, 500)
    assert.equal(agg[1].stepCount, 1)
  })

  test('turnless requests share turn 0; a turnless run breaks at the first stamped turn', () => {
    const agg = aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: undefined })])
    assert.equal(agg.length, 1)
    assert.equal(agg[0].stepCount, 2)
    const mixed = aggregateByTurn([req(1, { turn: undefined }), req(2, { turn: 1 })])
    assert.equal(mixed.length, 2)
  })

  test('an empty history aggregates to nothing', () => {
    assert.deepEqual(aggregateByTurn([]), [])
  })
})

describe('attachMarkers', () => {
  test('attaches each boundary event to the first request logged after it', () => {
    const reqs = [req(5), req(10)]
    const ev: ContextEventRecord = { seq: 7, time: 0, kind: 'compaction' }
    const markers = attachMarkers(reqs, [ev])
    assert.equal(markers.length, 2)
    assert.equal(markers[0], undefined)
    assert.equal(markers[1], ev)
  })

  test('events after the whole log, and non-boundary kinds, attach nowhere', () => {
    const reqs = [req(5), req(10)]
    // `new Array(n)` leaves holes: an event that never matches assigns no index at all.
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 99, time: 0, kind: 'prune' }])).length, 0)
    assert.equal(Object.keys(attachMarkers(reqs, [{ seq: 1, time: 0, kind: 'inject' }])).length, 0)
    assert.equal(attachMarkers([], [{ seq: 1, time: 0, kind: 'compaction' }]).length, 0)
  })

  test('the first event to claim a request index wins', () => {
    const reqs = [req(5), req(10)]
    const first: ContextEventRecord = { seq: 1, time: 0, kind: 'compaction' }
    const second: ContextEventRecord = { seq: 2, time: 0, kind: 'prune' }
    const markers = attachMarkers(reqs, [first, second])
    assert.equal(markers[0], first)
    assert.equal(markers[1], undefined)
  })
})
