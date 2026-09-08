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

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterAll, beforeAll, describe, test } from 'vitest'
import { aggregateByTurn, attachMarkers, jumpTargetOf, makeTrendChart, type TrendChartProps } from '../../../src/client/components/trendChart'
import { CATS } from '../../../src/client/categories'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
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

    // Total-mode axis: full quartile graduation — max, ¾, ½, ¼, 0.
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '450')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '300')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '150')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')

    // Turn strip: turn 1 spans two step columns (2*16-2 = 30px), the turnless request lands in group 0 (14px);
    // zebra fills alternate and stay disjoint from the category palette.
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].style.width, '30px')
    assert.equal(turns[1].style.width, '14px')
    assert.ok(turns[0].style.background.includes('0.12'))
    assert.ok(turns[1].style.background.includes('0.26'))
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
      [kit.t('tip.step', { t: 1, s: 1 }), kit.t('tip.total', { n: '600' })],
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
      [kit.t('tip.step', { t: 1, s: 1 }), kit.t('tip.delta', { n: '+60' })],
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
    assertColor(segs1[0].style.background, CATS[5].color)
    assert.equal(segs1[0].style.height, `${Math.round(60 / 120 * CHART_H)}px`)
    assert.equal(queryAll(bs[1], '.lc-bar-stack > div')[0].style.height, `${CHART_H}px`)

    // The tooltip's metric row names the focused category and carries its own figure.
    await m.update(h(TrendChart, propsOf([r1, r2], { focusCat: 'tool', hoveredSeq: 1 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 0 }), kit.t('tip.cat', { cat: kit.catLabel('tool'), n: '60' })],
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
      [kit.t('tip.step', { t: 1, s: 0 }), kit.t('tip.total', { n: '300' })],
    )
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(7px, 0)')

    // Turnless/step-less bars fall back to Turn 0 · Step 0.
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 4 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 0, s: 0 }), kit.t('tip.total', { n: '300' })],
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
})

describe('jumpTargetOf', () => {
  test('matches the exact seq; an aged-out seq clamps to the oldest retained request', () => {
    const reqs = [req(50), req(60), req(70)]
    assert.equal(jumpTargetOf(reqs, 60)?.seq, 60)
    assert.equal(jumpTargetOf(reqs, 10)?.seq, 50, 'below the window → the oldest retained bar')
    assert.equal(jumpTargetOf([], 1), null)
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
