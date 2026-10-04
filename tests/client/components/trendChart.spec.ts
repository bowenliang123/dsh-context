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

import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { aggregateByTurn, attachMarkers, jumpTargetOf, makeTrendChart, turnStepsOf, type TrendChartProps } from '../../../src/client/components/trendChart'
import { CATS } from '../../../src/client/categories'
import type { TrendBand } from '../../../src/client/dna'
import type { ContextEventRecord, RequestRecord, SurfaceNode } from '../../../src/shared/types'
import { click, flush, hover, makeKit, mount, query, queryAll, unhover, wheel } from '../helpers/kit'

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
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '1')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(m.container, '.lc-grid-mid'), 'total mode keeps the dashed mid grid')
    assert.ok(query(m.container, '.lc-grid-q3'), 'total mode keeps the dashed quarter guides')
    assert.ok(query(m.container, '.lc-grid-q1'), 'total mode keeps the dashed quarter guides')
    assert.ok(query(m.container, '.lc-grid-zero'), 'total mode draws the solid zero baseline at the chart floor')
    await m.unmount()
  })
})

describe('TrendChart step granularity, total mode', () => {
  test('stacks per-category segments in CATS order with real colors and proportional px heights', async () => {
    const r1 = req(1, { turn: 1, step: 0, skill: 40, total: 340 })
    const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, skill: 60, assistant: 80, tool: 120, total: 660 })
    const r3 = req(3, { turn: undefined, step: 0, user: 0, total: 280 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    assert.deepEqual(bs.map(b => b.getAttribute('data-seq')), ['1', '2', '3'])

    // Seven priced categories, in CATS order, with the shipped colors; max bar segments scale against maxTotal=660.
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 7)
    for (let i = 0; i < CATS.length; i++) assertColor(segs1[i].style.background, CATS[i].color)
    assert.equal(segs1[0].style.height, `${Math.round(100 / 660 * CHART_H)}px`)
    assert.equal(segs1[4].style.height, `${Math.round(40 / 660 * CHART_H)}px`)
    assert.equal(segs1[6].style.height, `${Math.round(60 / 660 * CHART_H)}px`)
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs2[0].style.height, `${Math.round(200 / 660 * CHART_H)}px`)

    // Zero-value categories are skipped entirely (r3.user = 0 → five segments, no user-green segment).
    const segs3 = queryAll(bs[2], '.lc-bar-stack > div')
    assert.equal(segs3.length, 5)
    assert.ok(![...segs3].some(s => s.style.background.includes('var(--color-green-500)')))

    // Total-mode axis: full quartile graduation — max, ¾, ½, ¼, 0.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '660')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '495')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '330')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '165')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')

    // Turn strip: turn 1 spans two step columns (2*16-2 = 30px), the turnless request lands in group 0 (14px);
    // zebra fills alternate and stay disjoint from the category palette.
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].style.width, '30px')
    assert.equal(turns[1].style.width, '14px')
    assert.ok(turns[0].style.background.includes('var(--color-neutral-500) 12%'))
    assert.ok(turns[1].style.background.includes('var(--color-neutral-500) 26%'))
    assert.deepEqual(turns.map(t => t.textContent), ['1', '0'])
    await m.unmount()
  })

  test('plots raw fold figures: the provider prompt never rescales the stack, so constant categories stay flat', async () => {
    const composition = { system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 }
    const r1 = req(1, { turn: 1, step: 0, ...composition })
    const r2 = req(2, { turn: 1, step: 1, ...composition, prompt: 1200 })
    const r3 = req(3, { turn: 2, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 500 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    // maxTotal follows the heuristic totals (600), not the provider prompt (1200).
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    // Identical compositions plot IDENTICAL segment heights regardless of the reported prompt — a constant
    // system prompt must not ride the provider/heuristic ratio (that per-request rescale faked growth into
    // categories the fold never changed).
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs1.length, 6)
    assert.deepEqual(segs2.map(s => s.style.height), segs1.map(s => s.style.height))
    assert.equal(segs1[0].style.height, `${Math.round(200 / 600 * CHART_H)}px`)
    // A usage-only record (prompt without messages) still renders no segments.
    assert.equal(queryAll(bs[2], '.lc-bar-stack > div').length, 0)

    // The tip is placed over its bar's visible slice imperatively (transform, not `left`), so it never
    // contributes to the scroller's overflow — see the overlay test below.
    const { spies, handlers } = makeSpies()
    await m.update(h(TrendChart, { ...propsOf([r1, r2, r3]), ...handlers, hoveredSeq: 2 }))
    const tip = query(m.container, '.lc-chart-tip')
    // Rows: identity, then the SAME total the bar is drawn against (the heuristic 600, not the prompt 1200).
    assert.deepEqual(
      queryAll(tip, 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 1, n: 2 }), kit.t('tip.total', { n: '600' })],
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
    const m = await mount(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta' })))

    // maxUp=60 (grown: +10 x6), maxDown=120 (shrunk: -20 x6) → scale 112/180, zero line at upPx=37.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+60')
    // Quarter marks sit on the uniform scale: +15 above (height ¼), -75 below (height ¾). The +15 mark's
    // label box (top 41) is 9px from the zero label's (13+37=50) — under one 11px label height — so it
    // drops itself instead of overlapping the zero reference; the -75 mark stays.
    assert.equal(queryAll(m.container, '.lc-axis-q3').length, 0)
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '-75')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 37}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-120')
    assert.equal(query(m.container, '.lc-grid-zero').style.top, `${18 + 37}px`)
    // Each surviving quarter mark keeps its dashed guide; the mark that yielded to the zero label drops it too.
    assert.equal(queryAll(m.container, '.lc-grid-q3').length, 0)
    assert.ok(query(m.container, '.lc-grid-q1'))

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

    // Delta tooltip: signed net change on the metric row, '+' only for positive nets.
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', hoveredSeq: 2 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 1, n: 2 }), kit.t('tip.delta', { n: '+60' })],
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
    // Zero line pinned to the chart bottom (upPx 112) clears both quarter marks: +225 / +75.
    assert.equal(query(up.container, '.lc-axis-q3').textContent, '+225')
    assert.equal(query(up.container, '.lc-axis-q1').textContent, '+75')
    assert.equal(query(up.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(up.container, '.lc-grid-q3'))
    assert.ok(query(up.container, '.lc-grid-q1'))
    const upSegs = queryAll(bars(up.container)[1], '.lc-bar-up > div')
    assert.equal(upSegs.length, 6)
    assert.equal(upSegs[0].style.height, `${Math.round(100 * CHART_H / 300)}px`)
    await up.unmount()

    const down = await mount(h(TrendChart, propsOf([base, zeroReq], { mode: 'delta' })))
    // Zero line pinned to the chart top (upPx 0): the quarter marks read -75 / -225.
    assert.equal(query(down.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(down.container, '.lc-axis-q3').textContent, '-75')
    assert.equal(query(down.container, '.lc-axis-q1').textContent, '-225')
    assert.equal(query(down.container, '.lc-axis-bot').textContent, '-300')
    assert.ok(query(down.container, '.lc-grid-q3'))
    assert.ok(query(down.container, '.lc-grid-q1'))
    assert.equal(queryAll(bars(down.container)[1], '.lc-bar-down > div').length, 6)
    await down.unmount()
  })

  test('a quarter mark landing on the zero label drops itself; the opposite mark keeps its place', async () => {
    // maxUp=90 (+90 system), maxDown=30 (-30 tools) → upPx 84: the zero label (top 97) sits exactly on the
    // ¼-height mark (top 97), which drops itself; the ¾-height mark renders +60 well clear of it.
    const flat = req(1, { turn: 1, step: 0, system: 0, tools: 30, user: 0, inject: 0, assistant: 0, tool: 0, total: 30 })
    const mixed = req(2, { turn: 1, step: 1, system: 90, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 90 })
    const m = await mount(h(TrendChart, propsOf([flat, mixed], { mode: 'delta' })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+90')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '+60')
    assert.equal(queryAll(m.container, '.lc-axis-q1').length, 0)
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 84}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-30')
    assert.ok(query(m.container, '.lc-grid-q3'))
    assert.equal(queryAll(m.container, '.lc-grid-q1').length, 0)
    await m.unmount()
  })
})

describe('TrendChart turn granularity', () => {
  const t1s0 = req(1, { turn: 1, step: 0 })
  const t1s1 = req(2, { turn: 1, step: 1, total: 360 })
  const t2s0 = req(3, { turn: 2, step: 0, total: 280 })

  test('turn aggregates render one bar per turn with aggregated labels and turn-count tooltips', async () => {
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const bs = bars(m.container)
    assert.equal(bs.length, 2)
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    // Aggregated groups always occupy exactly one column.
    assert.deepEqual(turns.map(t => t.style.width), ['14px', '14px'])
    assert.deepEqual(turns.map(t => t.textContent), ['1', '2'])

    // Multi-step aggregate → tip.turn; a single-step aggregate still speaks TURN ("共 1 步"), never the step index.
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t1s1.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 1, n: 2 })))
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t2s0.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 2 })))
    await m.unmount()

    // A multi-step aggregate of TURNLESS requests reports turn 0.
    const turnless = aggregateByTurn([req(10, { turn: undefined }), req(11, { turn: undefined })])
    const m2 = await mount(h(TrendChart, propsOf(turnless, { granularity: 'turn', hoveredSeq: 11 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 0, n: 2 })))
    await m2.unmount()

    // A turn-mode record missing stepCount (the parent always aggregates, so this is defensive) degrades to 1 step;
    // a missing turn field degrades to turn 0 the same way.
    const m3 = await mount(h(TrendChart, propsOf([req(20, { turn: undefined, step: 3 })], { granularity: 'turn', hoveredSeq: 20 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 0 })))
    await m3.unmount()
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
    const r1 = req(1, { turn: 1, step: 0, skill: 10 })
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

    // Delta mode: diverging stacks' segments are tagged the same way — an all-shrinking pair hangs all seven below the line.
    const big = req(4, { turn: 3, step: 0, system: 200, tools: 100, user: 60, inject: 40, skill: 30, assistant: 80, tool: 120 })
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

describe('TrendChart category focus (the browser open category)', () => {
  const r1 = req(1, { turn: 1, step: 0 })
  const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 })

  test('total mode plots only the focused category, rescaled to its own max, and the tip names it', async () => {
    const m = await mount(h(TrendChart, propsOf([r1, r2], { focusCat: 'tool' })))
    // maxTotal follows the focused figure (60 / 120), not the bars' whole compositions (300 / 600).
    assert.equal(query(m.container, '.lc-axis-top').textContent, '120')
    const bs = bars(m.container)
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 1)
    assert.equal(segs1[0].getAttribute('data-cat'), 'tool')
    assertColor(segs1[0].style.background, CATS[6].color)
    assert.equal(segs1[0].style.height, `${Math.round(60 / 120 * CHART_H)}px`)
    assert.equal(queryAll(bs[1], '.lc-bar-stack > div')[0].style.height, `${CHART_H}px`)

    // The tooltip's metric row names the focused category and carries its own figure.
    await m.update(h(TrendChart, propsOf([r1, r2], { focusCat: 'tool', hoveredSeq: 1 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 0, n: 2 }), kit.t('tip.cat', { cat: kit.catLabel('tool'), n: '60' })],
    )
    await m.unmount()
  })

  test('the focused figure is the raw fold value; a category at zero everywhere keeps the unit axis', async () => {
    // r1a carries usage: the focused tool value (60) still plots as-is — no provider rescale.
    const r1a = req(1, { turn: 1, step: 0, prompt: 600 })
    const m = await mount(h(TrendChart, propsOf([r1a, r2], { focusCat: 'tool' })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '120')
    assert.equal(queryAll(bars(m.container)[0], '.lc-bar-stack > div')[0].style.height, `${Math.round(60 / 120 * CHART_H)}px`)
    await m.unmount()

    const zero = req(9, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const mz = await mount(h(TrendChart, propsOf([zero], { focusCat: 'user' })))
    assert.equal(query(mz.container, '.lc-axis-top').textContent, '1')
    assert.equal(queryAll(bars(mz.container)[0], '.lc-bar-stack > div').length, 0)
    await mz.unmount()
  })

  test('delta mode diffs the focused category only', async () => {
    const base = req(1, { turn: 1, step: 0 })
    const grown = req(2, { turn: 1, step: 1, system: 130, tools: 50, user: 30, inject: 20, assistant: 40, tool: 60, total: 330 })
    const shrunk = req(3, { turn: 2, step: 0, system: 90, tools: 50, user: 30, inject: 20, assistant: 40, tool: 60, total: 290 })
    const m = await mount(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', focusCat: 'system' })))
    // Only the system deltas (+30 / -40) drive the scale: maxUp 30, maxDown 40.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+30')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-40')
    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-bar-up > div').length, 0)
    const up = queryAll(bs[1], '.lc-bar-up > div')
    assert.equal(up.length, 1)
    assert.equal(up[0].getAttribute('data-cat'), 'system')
    assert.equal(up[0].style.height, `${Math.round(30 * CHART_H / 70)}px`)
    const down = queryAll(bs[2], '.lc-bar-down > div')
    assert.equal(down.length, 1)
    assert.equal(down[0].style.height, `${Math.round(40 * CHART_H / 70)}px`)

    // The delta tip reports the focused category's signed change.
    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', focusCat: 'system', hoveredSeq: 2 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '+30' })))
    await m.unmount()
  })

  test('an unknown focus key and an explicit null degrade to the unfocused chart', async () => {
    for (const focusCat of ['nope', null]) {
      const m = await mount(h(TrendChart, propsOf([r1, r2], { focusCat })))
      assert.equal(queryAll(bars(m.container)[0], '.lc-bar-stack > div').length, 6)
      assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
      await m.unmount()
    }
  })
})

describe('TrendChart adaptive scale (the title-adjacent toggle)', () => {
  /** 30 steps of one category: bar 0 carries the spike, the rest a flat 100 — 25 columns fit the test viewport. */
  function spikedSteps(): RequestRecord[] {
    const out: RequestRecord[] = []
    for (let i = 0; i < 30; i++) {
      const total = i === 0 ? 900 : 100
      out.push(req(i + 1, { turn: 1, step: i, system: total, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total }))
    }
    return out
  }

  test('rescales to the visible window, follows the scroll, and yields to the whole-log scale when switched off', async () => {
    const reqs = spikedSteps()
    const m = await mount(h(TrendChart, propsOf(reqs, { adaptive: true })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    // Mount anchors at the newest bars (scrollLeft 80 over scrollWidth 480 / clientWidth 400): the 900 spike at
    // bar 0 is off screen, so the visible 100s scale the axis and the bars fill the chart.
    assert.equal(scroll.scrollLeft, 80)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-stack > div')[0].style.height, `${CHART_H}px`)

    // Back to the left edge: the spike is on screen and takes the scale back.
    await scrollTo(scroll, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-stack > div')[0].style.height, `${Math.round(100 / 900 * CHART_H)}px`)

    // A scroll inside a window whose maxima do not move keeps the same scale (bars 4..28 are all 100).
    await scrollTo(scroll, 64)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')

    // Switched off: the whole-log scale returns even though a visible window is still measured.
    await m.update(h(TrendChart, propsOf(reqs, { adaptive: false })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
    await m.unmount()
  })

  test('a column wholly in the 2px gap outside the viewport does not join the window', async () => {
    const m = await mount(h(TrendChart, propsOf(spikedSteps(), { adaptive: true })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    // scrollLeft 15 lands in the gap after bar 0's 14px column: the spike is off screen and must not scale the axis.
    await scrollTo(scroll, 15)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
    // One pixel earlier its column is still (partly) on screen and takes the scale back.
    await scrollTo(scroll, 13)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
    await m.unmount()
  })

  test('an empty history or a zero-width viewport keeps the previous scale', async () => {
    const empty = await mount(h(TrendChart, propsOf([], { adaptive: true })))
    assert.equal(query(empty.container, '.lc-axis-top').textContent, '1')
    await empty.unmount()

    // A hidden pane (zero width) has nothing visible to scale to: the measured scale stands instead of collapsing
    // every bar onto a unit axis.
    const m = await mount(h(TrendChart, propsOf(spikedSteps(), { adaptive: true })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    scroll.__clientW = 0
    await scrollEvent(scroll)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
    await m.unmount()
  })

  test('delta mode rescales the diverging arms; an all-zero window keeps the whole-log zero line', async () => {
    const step = (i: number, system: number): RequestRecord =>
      req(i + 1, { turn: 1, step: i, system, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: system })
    // Deltas: bar 1 jumps +500, bars 2..29 grow +10 each, with a -30 dip carried from bar 20 on.
    const reqs = [step(0, 100), step(1, 600)]
    for (let i = 2; i < 30; i++) reqs.push(step(i, 600 + (i - 1) * 10 - (i >= 20 ? 40 : 0)))
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta', adaptive: true })))
    await flush()
    // Mount anchors right (scrollLeft 80): the visible +10/-30 deltas scale both arms (maxUp 10, maxDown 30),
    // lifting the zero line to 28px off the floor and stretching the +10 segment to 28px.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+10')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-30')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 28}px`)
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-up > div')[0].style.height, `${Math.round(10 * CHART_H / 40)}px`)
    assert.equal(queryAll(bars(m.container)[20], '.lc-bar-down > div')[0].style.height, `${Math.round(30 * CHART_H / 40)}px`)
    await m.unmount()

    // Bars 0..24 carry no change at all and the +500 sits at bar 25: the all-zero window has no scale of its own,
    // so the whole-log zero line stands instead of collapsing onto the chart top.
    const flat = [step(0, 100)]
    for (let i = 1; i < 25; i++) flat.push(step(i, 100))
    flat.push(step(25, 600))
    const m2 = await mount(h(TrendChart, propsOf(flat, { mode: 'delta', adaptive: true })))
    await flush()
    await scrollTo(query<LayoutEl>(m2.container, '.lc-chart-scroll'), 0)
    assert.equal(query(m2.container, '.lc-axis-top').textContent, '+500')
    assert.equal(query(m2.container, '.lc-axis-mid').style.top, `${13 + CHART_H}px`)
    await m2.unmount()
  })

  test('a container resize re-measures the visible window through the observer', async () => {
    const callbacks: (() => void)[] = []
    class FakeResizeObserver {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe(): void {}
      disconnect(): void {}
    }
    const holder = globalThis as { ResizeObserver?: unknown }
    const saved = holder.ResizeObserver
    holder.ResizeObserver = FakeResizeObserver
    try {
      const m = await mount(h(TrendChart, propsOf(spikedSteps(), { adaptive: true })))
      await flush()
      const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
      assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
      assert.equal(callbacks.length, 1)
      // The pane widens back to the whole log while the reader sits at the left edge — a resize renders nothing,
      // so only the observer's callback re-measures.
      scroll.__clientW = 480
      scroll.__scrollL = 0
      await act(async () => { callbacks[0]() })
      assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
      await m.unmount()
    } finally {
      holder.ResizeObserver = saved
    }
  })

  test('the chart scroller cancels a horizontal swipe at either edge (browser history guard)', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < 40; i++) reqs.push(req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    // Mount anchors at the newest bars: a further rightward swipe is the browser's forward gesture, leftward
    // still scrolls the chart, and a vertical-dominant gesture belongs to the page.
    assert.equal(scroll.scrollLeft, 240)
    assert.equal(wheel(scroll, 30, 0), true, 'right edge cancels the forward swipe')
    assert.equal(wheel(scroll, -30, 0), false, 'leftward still scrolls the chart')
    assert.equal(wheel(scroll, 30, 120), false, 'vertical-dominant gestures stay with the page')
    await scrollTo(scroll, 0)
    assert.equal(wheel(scroll, -30, 0), true, 'left edge cancels the back swipe')
    await scrollTo(scroll, 100)
    assert.equal(wheel(scroll, -30, 0), false, 'mid-chart leftward still scrolls')
    await m.unmount()
  })
})

describe('TrendChart duration overlay (durationCurve)', () => {
  /** The overlay's y for a duration at the whole-log scale (the component's own rounding). */
  const activeMsY = (activeMs: number, maxActiveMs: number): number => Math.round((CHART_H - activeMs * (CHART_H / Math.max(1, maxActiveMs))) * 100) / 100

  test('off by default: no curve, no right-hand axis', async () => {
    const m = await mount(h(TrendChart, propsOf([req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 })])))
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    assert.equal(queryAll(m.container, '.lc-axis-r').length, 0)
    await m.unmount()
  })

  test('on: the curve rides the bar columns and the right axis carries duration quartiles', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 }), req(3, { activeMs: 4000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-duration')
    assert.equal(svg.getAttribute('width'), String(3 * BAR_CELL - 2))
    assert.equal(svg.getAttribute('height'), String(CHART_H))
    const lines = queryAll(svg, 'polyline')
    assert.equal(lines.length, 1, 'one contiguous run of stamped bars')
    assert.equal(
      lines[0].getAttribute('points'),
      `7,${activeMsY(1000, 4000)} 23,${activeMsY(2000, 4000)} 39,${activeMsY(4000, 4000)}`,
    )
    assert.equal(queryAll(svg, 'circle').length, 0)
    // The right-hand axis: max, ¾, ½, ¼, 0 — formatted as durations.
    const axis = query(m.container, '.lc-axis-r')
    assert.equal(query(axis, '.lc-axis-top').textContent, '4.0s')
    assert.equal(query(axis, '.lc-axis-q3').textContent, '3.0s')
    assert.equal(query(axis, '.lc-axis-mid').textContent, '2.0s')
    assert.equal(query(axis, '.lc-axis-q1').textContent, '1.0s')
    assert.equal(query(axis, '.lc-axis-bot').textContent, '0')
    await m.unmount()
  })

  test('a bar without ms breaks the line; an isolated single point draws a dot', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2), req(3, { activeMs: 2000 }), req(4, { activeMs: 4000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-duration')
    const lines = queryAll(svg, 'polyline')
    assert.equal(lines.length, 1, 'the trailing pair re-joins after the gap')
    assert.equal(lines[0].getAttribute('points'), `39,${activeMsY(2000, 4000)} 55,${activeMsY(4000, 4000)}`)
    const dots = queryAll(svg, 'circle')
    assert.equal(dots.length, 1, 'a one-point run would be an invisible polyline')
    assert.equal(dots[0].getAttribute('cx'), '7')
    assert.equal(dots[0].getAttribute('cy'), String(activeMsY(1000, 4000)))
    await m.unmount()
  })

  test('turn granularity plots each turn\'s summed active time', async () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, activeMs: 500 }),
      req(3, { turn: 2, step: 0, activeMs: 2000 }),
    ])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn', durationCurve: true })))
    const lines = queryAll(query(m.container, '.lc-duration'), 'polyline')
    assert.equal(lines[0].getAttribute('points'), `7,${activeMsY(1500, 2000)} 23,${activeMsY(2000, 2000)}`)
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    await m.unmount()
  })

  test('delta mode keeps the floor-anchored duration axis; the hover tip appends the duration row', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta', durationCurve: true, hoveredSeq: 1 })))
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    assert.equal(queryAll(query(m.container, '.lc-duration'), 'polyline').length, 1)
    const rows = queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent)
    assert.equal(rows.length, 3)
    assert.equal(rows[2], kit.t('tip.duration', { n: '1.0s' }))
    // Off again: the tip drops the duration row.
    await m.update(h(TrendChart, propsOf(reqs, { mode: 'delta', hoveredSeq: 1 })))
    assert.equal(queryAll(query(m.container, '.lc-chart-tip'), 'span').length, 2)
    await m.unmount()
  })

  test('adaptive scale rescales the curve to the visible window like the bars', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < 30; i++) reqs.push(req(i + 1, { turn: 1, step: i, activeMs: i === 0 ? 9000 : 1000 }))
    const m = await mount(h(TrendChart, propsOf(reqs, { adaptive: true, durationCurve: true })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    // Anchored at the newest bars (scrollLeft 80): the 9s spike at bar 0 is off screen.
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '1.0s')
    await scrollTo(scroll, 0)
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '9.0s')
    await m.unmount()
  })

  test('no stamped durations at all: the axis shows the scale floor, the curve draws nothing', async () => {
    const m = await mount(h(TrendChart, propsOf([req(1), req(2)], { durationCurve: true })))
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    const axis = query(m.container, '.lc-axis-r')
    assert.equal(query(axis, '.lc-axis-top').textContent, '—')
    assert.equal(query(axis, '.lc-axis-bot').textContent, '0')
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

describe('TrendChart step flags', () => {
  test('every 5th step bar plants a flag labeled with its cumulative step number', async () => {
    const reqs = Array.from({ length: 12 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const flags = queryAll(m.container, '.lc-step-flag')
    assert.equal(flags.length, 2)
    // Single- and multi-digit labels alike; the flag rides its bar (5th and 10th columns).
    assert.deepEqual(flags.map(f => f.textContent), ['5', '10'])
    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-step-flag').length, 0)
    assert.ok(query(bs[4], '.lc-step-flag'))
    assert.ok(query(bs[9], '.lc-step-flag'))
    await m.unmount()
  })

  test('delta mode keeps the flags; turn granularity plants none (the turn strip numbers that grid)', async () => {
    const reqs = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta' })))
    assert.deepEqual(queryAll(m.container, '.lc-step-flag').map(f => f.textContent), ['5'])
    await m.unmount()

    const turns = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: i + 1, step: 0 }))
    const m2 = await mount(h(TrendChart, propsOf(aggregateByTurn(turns), { granularity: 'turn' })))
    assert.equal(queryAll(m2.container, '.lc-step-flag').length, 0)
    await m2.unmount()
  })
})

describe('TrendChart tooltips', () => {
  const r1 = req(1, { turn: 1, step: 0 })
  const r4 = req(4, { turn: undefined, step: undefined })

  test('hover floats a two-row tip (identity + bar total) and clears on leave', async () => {
    const { spies, handlers } = makeSpies()
    const reqs = [r1, r4]
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))

    const bs = bars(m.container)
    await hover(bs[0])
    assert.deepEqual(spies.hover, [1])
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 1 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 0, n: 1 }), kit.t('tip.total', { n: '300' })],
    )
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(7px, 0)')

    // Turnless/step-less bars fall back to Turn 0 · Step 0.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 4 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 0, s: 0, n: 1 }), kit.t('tip.total', { n: '300' })],
    )

    // A hoveredSeq outside the rendered list floats no tip.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 999 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)

    // Leaving the chart clears the hover and hides the tip.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 1 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    await unhover(query(m.container, '.lc-chart'))
    assert.deepEqual(spies.hover, [1, null])
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: null })))
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

  test('overflowing labels render whole and thin out: a label colliding with the kept one hides until it clears', async () => {
    // Turn granularity: three 14px blocks at 16px pitch, all carrying two-digit labels.
    const agg = aggregateByTurn([req(1, { turn: 10 }), req(2, { turn: 11 }), req(3, { turn: 12 })])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.deepEqual(labels.map(l => l.textContent), ['10', '11', '12'])

    // 20px labels over 14px blocks (dx pinned at 0, natively centered): boxes [-3,17], [13,33], [29,49] — 11
    // collides with the kept 10 and hides; 12 clears it (past box + gap) and stays visible.
    for (const l of labels) Object.defineProperty(l, 'offsetWidth', { configurable: true, get: () => 20 })
    await scrollEvent(scroll)
    assert.equal(labels[0].style.visibility, '')
    assert.equal(labels[1].style.visibility, 'hidden')
    assert.equal(labels[2].style.visibility, '')

    // Narrower labels fit their blocks again → the hidden one is restored.
    for (const l of labels) Object.defineProperty(l, 'offsetWidth', { configurable: true, get: () => 8 })
    await scrollEvent(scroll)
    assert.equal(labels[1].style.visibility, '')
    await scrollEvent(scroll)
    assert.equal(labels[1].style.visibility, '', 'repeat scroll with unchanged geometry writes nothing')
    await m.unmount()
  })

  test('the strip shrinks every label to the largest size at which the tightest adjacent pair fits', async () => {
    // One/two-digit turns at the 16px column pitch fit the 10px base (est. 6.5px/digit + 2px gap vs 16px) → no override.
    const single = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 1 }), req(2, { turn: 2 }), req(3, { turn: 10 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(single.container, '.lc-turns').style.fontSize, '')
    await single.unmount()

    // Three-digit labels over 14px blocks: est. need 21.5px vs 16px pitch → floor(10 * 16/21.5) = 7px for EVERY label.
    const three = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 100 }), req(2, { turn: 101 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(three.container, '.lc-turns').style.fontSize, '7px')
    await three.unmount()

    // Four-digit pairs clamp at the 6px floor (the measured chain stays the last-resort guard below it).
    const four = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 1000 }), req(2, { turn: 1001 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(four.container, '.lc-turns').style.fontSize, '6px')
    await four.unmount()

    // Wide step-mode blocks buy room: ten-step turns carry three-digit labels at the base size.
    const wide: RequestRecord[] = []
    for (let i = 0; i < 20; i++) wide.push(req(i + 1, { turn: 100 + Math.floor(i / 10), step: i % 10 }))
    const step = await mount(h(TrendChart, propsOf(wide)))
    assert.equal(query<HTMLElement>(step.container, '.lc-turns').style.fontSize, '')
    await step.unmount()
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

  test('the duration overlay\'s ms sums across a turn\'s steps; absent only when no step carried one', () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, activeMs: 2500 }),
      req(3, { turn: 2, step: 0, activeMs: 800 }),
    ])
    assert.equal(agg[0].activeMs, 3500, 'the turn bar carries its steps\' summed active time')
    assert.equal(agg[1].activeMs, 800, 'a single-step turn keeps its own figure')

    // A step without a stamp contributes nothing but does not hide the run's known share.
    const partial = aggregateByTurn([req(1, { turn: 1, activeMs: 1000 }), req(2, { turn: 1 })])
    assert.equal(partial[0].activeMs, 1000)
    const none = aggregateByTurn([req(1, { turn: 1 }), req(2, { turn: 1 })])
    assert.ok(!('ms' in none[0]), 'no fabricated zero when no step reported')
  })
})

describe('turnStepsOf', () => {
  test('tallies per-turn step counts over the raw records; turnless pool under 0', () => {
    const stepsOf = turnStepsOf([
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 1, step: 1 }),
      req(3, { turn: 2, step: 0 }),
      req(4, { turn: undefined, step: undefined }),
    ])
    assert.equal(stepsOf(1), 2)
    assert.equal(stepsOf(2), 1)
    assert.equal(stepsOf(undefined), 1, 'turnless records read the pooled 0 key')
  })

  test('a turn outside the list answers 1 instead of missing', () => {
    assert.equal(turnStepsOf([req(1, { turn: 1 })])(9), 1)
    assert.equal(turnStepsOf([])(1), 1)
  })
})

describe('jumpTargetOf', () => {
  test('matches the exact seq; an aged-out seq clamps to the oldest retained request', () => {
    const reqs = [req(50), req(60), req(70)]
    assert.equal(jumpTargetOf(reqs, 60)?.seq, 60)
    assert.equal(jumpTargetOf(reqs, 10)?.seq, 50, 'below the window → the oldest retained bar')
    assert.equal(jumpTargetOf([], 1), null)
  })
})

describe('TrendChart entrance rise', () => {
  const slot = (el: Element): string => (el as HTMLElement).style.getPropertyValue('--lc-i')

  test('each bar carries its rise stagger slot, capped so a long log settles quickly', async () => {
    const reqs = Array.from({ length: 25 }, (_, i) => req(i + 1))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const stacks = queryAll(m.container, '.lc-bar-stack')
    assert.equal(stacks.length, 25)
    assert.equal(slot(stacks[0]), '0')
    assert.equal(slot(stacks[1]), '1')
    assert.equal(slot(stacks[19]), '19')
    // Past the cap every late bar joins at the same slot.
    assert.equal(slot(stacks[20]), '20')
    assert.equal(slot(stacks[24]), '20')
    await m.unmount()
  })

  test('delta arms share their bar rise stagger slot', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, system: 50, user: 60 })
    const m = await mount(h(TrendChart, propsOf([r1, r2], { mode: 'delta' })))
    const ups = queryAll(m.container, '.lc-bar-up')
    const downs = queryAll(m.container, '.lc-bar-down')
    assert.equal(slot(ups[0]), '0')
    assert.equal(slot(ups[1]), '1')
    assert.equal(slot(downs[1]), '1')
    // The first bar diffs against nothing, so it grows no down arm.
    assert.equal(queryAll(downs[0], 'div').length, 0)
    await m.unmount()
  })

  test('switching granularity remounts every bar so the entrance rise replays', async () => {
    // A turn aggregate IS its last step's record (the same seq): without the granularity-keyed remount,
    // a turn → step switch would reuse that bar's DOM node and its turn-final step bars would not rise.
    function GranularityHarness(props: { requests: RequestRecord[] }) {
      const [granularity, setGranularity] = useState<'step' | 'turn'>('turn')
      // The parent (ContextView) aggregates for turn granularity; TrendChart renders what it is given.
      const display = granularity === 'turn' ? aggregateByTurn(props.requests) : props.requests
      return h('div', null,
        h('button', { onClick: () => { setGranularity('step') } }, 'to-step'),
        h(TrendChart, { ...propsOf(display), granularity }))
    }
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const m = await mount(h(GranularityHarness, { requests: reqs }))
    // Turn mode: one aggregate per turn, each keyed by its LAST step's seq.
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['2', '3'])
    const reusedSeq = query(m.container, '.lc-bar[data-seq="2"]')
    await click(query(m.container, 'button'))
    // Step mode renders every step; even the seq the aggregate reused must be a FRESH node.
    assert.deepEqual(bars(m.container).map(b => b.getAttribute('data-seq')), ['1', '2', '3'])
    assert.notEqual(query(m.container, '.lc-bar[data-seq="2"]'), reusedSeq)
    await m.unmount()
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

describe('TrendChart DNA mode', () => {
  const COLORS = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<string, string>

  /** Trend-band fixture builder: cumulative offsets accumulate exactly like trendBandsOf. */
  function dnaBands(spec: [string, string, number, SurfaceNode?][]): TrendBand[] {
    let off = 0
    return spec.map(([key, cat, tokens, node]) => {
      const band = (node !== undefined
        ? { key, cat, tokens, off, color: COLORS[cat], node }
        : { key, cat, tokens, off, color: COLORS[cat] }) as TrendBand
      off += tokens
      return band
    })
  }

  /** jsdom has no layout: give a bar interior the 112px stack area so pointer fractions read real. */
  function stubBarRect(el: HTMLElement): void {
    el.getBoundingClientRect = () => ({ top: 0, left: 0, right: 14, bottom: CHART_H, width: 14, height: CHART_H, x: 0, y: 0, toJSON: () => null }) as DOMRect
  }

  async function move(el: HTMLElement, clientY: number): Promise<void> {
    await act(async () => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY })) })
  }

  test('paints one coalesced gradient per bar — read order, proportional heights, zero bands dropped', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const r2 = req(2, { turn: 1, step: 1, total: 600 })
    const d1 = dnaBands([
      ['sys', 'system', 100],
      ['tool:bash', 'tools', 50],
      ['n1', 'assistant', 80, { seq: 1, cat: 'assistant', tokens: 80 }],
      ['n2', 'assistant', 70, { seq: 2, cat: 'assistant', tokens: 70 }],
    ])
    const d2 = dnaBands([
      ['sys', 'system', 200],
      ['n1', 'assistant', 80, { seq: 1, cat: 'assistant', tokens: 80 }],
      ['n3', 'user', 100, { seq: 3, cat: 'user', tokens: 100 }],
      ['n4', 'user', 0, { seq: 4, cat: 'user', tokens: 0 }],
      ['n5', 'tool', 220, { seq: 5, cat: 'tool', tokens: 220 }],
    ])
    const m = await mount(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2] })))
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 2)
    assert.equal(dnaDivs[0].style.height, `${Math.round(300 / 600 * CHART_H)}px`)
    assert.equal(dnaDivs[1].style.height, `${CHART_H}px`)
    // d1: the two adjacent assistant bands coalesce into ONE blue run (50% → 100%).
    const g1 = dnaDivs[0].style.background
    assert.ok(g1.startsWith('linear-gradient(to top, '), g1)
    assert.ok(g1.includes('var(--color-indigo-500) 0%, var(--color-indigo-500) 33.33%'), g1)
    assert.ok(g1.includes('var(--color-amber-500) 33.33%, var(--color-amber-500) 50%'), g1)
    assert.ok(g1.includes('var(--color-blue-500) 50%, var(--color-blue-500) 100%'), g1)
    // d2: the zero-token user band leaves no run of its own; the teal run starts at its offset.
    const g2 = dnaDivs[1].style.background
    assert.ok(g2.includes('var(--color-blue-500) 33.33%, var(--color-blue-500) 46.67%'), g2)
    assert.ok(g2.includes('var(--color-green-500) 46.67%, var(--color-green-500) 63.33%'), g2)
    assert.ok(g2.includes('var(--color-teal-500) 63.33%, var(--color-teal-500) 100%'), g2)
    // No segmented stacks, and the total-mode axis stays.
    assert.equal(queryAll(m.container, '.lc-bar-stack').length, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    // Without an onPickBand handler a band click is a quiet no-op (the pick guard's undefined arm).
    await act(async () => { dnaDivs[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await m.unmount()
  })

  test('a band click reports the picked item with the bar seq, for the Context browser reveal', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const d1 = dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]])
    const picks: [number, string][] = []
    const m = await mount(h(TrendChart, propsOf([r1], {
      dna: [d1],
      onPickBand: (seq, band) => { picks.push([seq, band.key]) },
    })))
    // jsdom's zero-height rect resolves the click to the bottom band; the pick carries the bar's seq.
    const dnaDiv = query(m.container, '.lc-bar-dna')
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 30 })) })
    assert.deepEqual(picks, [[1, 'sys']])
    await m.unmount()
  })

  test('hit-tests the pointer into a band; the same item lights its lifetime slice in every bar', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const r2 = req(2, { turn: 1, step: 1, total: 600 })
    const n1: SurfaceNode = { seq: 1, cat: 'user', tokens: 100, text: 'hello' }
    const d1 = dnaBands([['n1', 'user', 100, n1], ['n2', 'assistant', 200, { seq: 2, cat: 'assistant', tokens: 200 }]])
    const d2 = dnaBands([
      ['n1', 'user', 100, n1],
      ['n3', 'tool', 400, { seq: 3, cat: 'tool', tokens: 400, tool: 'bash' }],
      ['n4', 'user', 0, { seq: 4, cat: 'user', tokens: 0 }],
      ['n5', 'tool', 100, { seq: 5, cat: 'tool', tokens: 100, tool: 'write' }],
    ])
    const m = await mount(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2], hoveredSeq: 1 })))
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 2)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''

    // Before the rect stub the zero-height fallback resolves to the bottom band (frac 0), which
    // lives in BOTH bars: the lifetime highlight paints one slice per bar at its axis position.
    await move(dnaDivs[0], 40)
    let slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    assert.equal(slices[0].style.bottom, '0px')
    assert.equal(slices[0].style.height, `${Math.round(100 / 600 * CHART_H)}px`)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))

    // Real 112px bars: the pointer walks the strip — below the bar clamps to the bottom band…
    stubBarRect(dnaDivs[0])
    stubBarRect(dnaDivs[1])
    await move(dnaDivs[0], CHART_H + 20)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))
    // …the very top resolves to the LAST band (n2 lives only in the first bar)…
    await move(dnaDivs[0], 0)
    slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 1)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '200' })))
    // …and above the second bar clamps to its top band (the zero-token n4 is invisible and skipped).
    // The hover seq is a controlled prop, so the tip only follows after it moves to the second bar.
    await m.update(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2], hoveredSeq: 2 })))
    await move(dnaDivs[1], -10)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'write', n: '100' })))

    // Leaving the band (not the bar) drops the highlight and restores the plain total row.
    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    assert.ok(tipText().includes(kit.t('tip.total', { n: '600' })))

    // Leaving the whole chart clears the item hover too.
    await move(dnaDivs[0], 100)
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 2)
    await unhover(query(m.container, '.lc-chart'))
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    await m.unmount()
  })

  test('DNA + delta diffs each item against the previous bar — new items rise, removed items hang', async () => {
    const rs = [
      req(1, { turn: 1, step: 0, total: 300 }),
      req(2, { turn: 1, step: 1, total: 300 }),
      req(3, { turn: 1, step: 2, total: 600 }),
      req(4, { turn: 2, step: 0, total: 500 }),
      req(5, { turn: 2, step: 1, total: 300 }),
    ]
    const ds = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['a1', 'assistant', 60, { seq: 2, cat: 'assistant', tokens: 60 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['a1', 'assistant', 90, { seq: 2, cat: 'assistant', tokens: 90 }], ['t1', 'tool', 120, { seq: 3, cat: 'tool', tokens: 120, tool: 'bash' }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }], ['u1', 'user', 40, { seq: 4, cat: 'user', tokens: 40 }], ['u2', 'user', 40, { seq: 5, cat: 'user', tokens: 40 }]]),
      dnaBands([['sys', 'system', 100], ['n1', 'user', 100, { seq: 1, cat: 'user', tokens: 100 }]]),
    ]
    const picks: [number, string][] = []
    const m = await mount(h(TrendChart, propsOf(rs, {
      dna: ds,
      mode: 'delta',
      hoveredSeq: 4,
      adaptive: true,
      onPickBand: (seq, band) => { picks.push([seq, band.key]) },
    })))
    // maxUp = 150 (bar 3's growth + newcomers), maxDown = 210 (bar 4's removals); the zero line
    // splits the floor plan at downPx = 112 − round(150·112/360) = 65.
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 4, 'the first bar has no baseline and carries no strip')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+150')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-210')

    // Bar 2 (idx 0): one up item, no down — the div rides the zero line (bottom 65), one blue run.
    assert.equal(dnaDivs[0].style.height, '19px')
    assert.equal(dnaDivs[0].style.bottom, '65px')
    assert.ok(dnaDivs[0].style.background.includes('var(--color-blue-500) 0%, var(--color-blue-500) 100%'))

    // Bar 3 (idx 1): up arm in read order (a1 grew +30, t1 joined +120) — still nothing below the line.
    assert.equal(dnaDivs[1].style.height, '47px')
    const g3 = dnaDivs[1].style.background
    assert.ok(g3.includes('var(--color-blue-500) 0%, var(--color-blue-500) 20%'), g3)
    assert.ok(g3.includes('var(--color-teal-500) 20%, var(--color-teal-500) 100%'), g3)

    // Bar 4 (idx 2): the removals hang BELOW the line (bottom 0 — the div spans both arms) and the
    // gradient reads bottom-up: the down arm REVERSED (t1, then a1), then the up arm — the two
    // adjacent user newcomers coalesce into ONE green run.
    assert.equal(dnaDivs[2].style.height, '90px')
    assert.equal(dnaDivs[2].style.bottom, '0px')
    assert.equal(dnaDivs[2].style.transformOrigin, '50% 72.41%')
    const g4 = dnaDivs[2].style.background
    assert.ok(g4.includes('var(--color-teal-500) 0%, var(--color-teal-500) 41.38%'), g4)
    assert.ok(g4.includes('var(--color-blue-500) 41.38%, var(--color-blue-500) 72.41%'), g4)
    assert.ok(g4.includes('var(--color-green-500) 72.41%, var(--color-green-500) 100%'), g4)

    // Bar 5 (idx 3): a pure removal (both user messages left, coalesced) hanging under the line.
    assert.equal(dnaDivs[3].style.height, '25px')
    assert.equal(dnaDivs[3].style.bottom, '40px')

    // The zero-height rect fallback resolves to the bottom band before any stub (t1, the last
    // down item); stub 112px and walk bar 4's arms: u1 (+40) at the top, then a1 (−90) and t1
    // (−120) below the line in read order.
    await move(dnaDivs[2], 40)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'bash', n: '-120' })))
    stubBarRect(dnaDivs[2])
    await move(dnaDivs[2], 0)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '+40' })), 'the very top is the last up band')
    await move(dnaDivs[2], 55)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '-90' })), 'the down arm walks read order from the zero line')
    // A band click picks through to the reveal bridge with the bar's seq.
    await act(async () => { dnaDivs[2].dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 55 })) })
    assert.deepEqual(picks, [[4, 'a1']])

    // Hovering t1 lights its delta slices across the bars: above the line where it joined
    // (bar 3), below where it was removed (bar 4), nothing where it never existed.
    stubBarRect(dnaDivs[1])
    await move(dnaDivs[1], 0)
    const slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    // Bar 3's up arm: t1 joined at off 30 (after a1's +30).
    assert.equal(slices[0].style.bottom, `${Math.round(65 + 30 * 112 / 360)}px`)
    assert.equal(slices[0].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    // Bar 4's down arm: a1 (90) then t1 (120) stack from the zero line — t1 hugs the floor.
    assert.equal(slices[1].style.bottom, `${Math.round(65 - 210 * 112 / 360)}px`)
    assert.equal(slices[1].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    // Leaving the band (not the bar) drops the highlight.
    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    await m.unmount()
  })

  test('a down-only DNA+delta bar resolves the zero-line edge into its first removed item', async () => {
    const rs = [
      req(1, { turn: 1, step: 0, total: 300 }),
      req(2, { turn: 1, step: 1, total: 260 }),
    ]
    const ds = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
      dnaBands([['sys', 'system', 100]]),
    ]
    const m = await mount(h(TrendChart, propsOf(rs, { dna: ds, mode: 'delta', hoveredSeq: 2 })))
    const dnaDiv = query(m.container, '.lc-bar-dna')
    stubBarRect(dnaDiv)
    // No onPickBand handler: the pick guard's undefined arm is a quiet no-op.
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    // The very top of a down-only bar IS the zero line: it resolves to the first removed item.
    await move(dnaDiv, 0)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '-200' })))
    await m.unmount()
  })

  test('combo hover off the arms keeps the delta row — the churn is never labeled a total (#96)', async () => {
    const rs = [
      req(1, { turn: 1, step: 0, total: 300 }),
      req(2, { turn: 1, step: 1, total: 260, tool: 20 }),
    ]
    const ds = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
      dnaBands([['sys', 'system', 100]]),
    ]
    const m = await mount(h(TrendChart, propsOf(rs, { dna: ds, mode: 'delta', hoveredSeq: 2 })))
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    // No band under the pointer (dnaHit untouched): the fallback speaks the bar's NET — the same
    // row plain delta mode shows — never the churn under the total label.
    assert.ok(tipText().includes(kit.t('tip.delta', { n: '-40' })))
    assert.ok(!tipText().includes(kit.t('tip.total', { n: '40' })))
    await m.unmount()
  })

  test('the browser category focus is ignored — the bands already are the full composition', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const d1 = dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]])
    const m = await mount(h(TrendChart, propsOf([r1], { dna: [d1], focusCat: 'user' })))
    const dnaDiv = query(m.container, '.lc-bar-dna')
    assert.equal(dnaDiv.style.height, `${CHART_H}px`, 'full height, not the focused category share')
    assert.ok(dnaDiv.style.background.includes('var(--color-indigo-500)'), 'the system band is still painted')
    await m.unmount()
  })

  test('a bar whose bands carry no tokens paints no DNA strip', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 0 })
    const r2 = req(2, { turn: 1, step: 1, total: 600 })
    const d1 = dnaBands([['n1', 'user', 0, { seq: 1, cat: 'user', tokens: 0 }]])
    const d2 = dnaBands([['n2', 'user', 600, { seq: 2, cat: 'user', tokens: 600 }]])
    const m = await mount(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2] })))
    assert.equal(queryAll(m.container, '.lc-bar-dna').length, 1)
    await m.unmount()
  })
})
