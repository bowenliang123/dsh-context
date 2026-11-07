import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { aggregateByTurn } from '../../../src/client/components/trendModel'
import type { RequestRecord } from '../../../src/shared/types'
import { flush, mount, query, queryAll, wheel } from '../helpers/kit'
import { BAR_CELL, CHART_H, TrendChart, bars, kit, makeSpies, propsOf, req, scrollEvent, scrollTo, viewport, type LayoutEl } from './trendChartHarness'

describe('TrendChart adaptive scale (the title-adjacent toggle)', () => {
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
    assert.equal(scroll.scrollLeft, 80)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-stack > div')[0].style.height, `${CHART_H}px`)

    await scrollTo(scroll, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-stack > div')[0].style.height, `${Math.round(100 / 900 * CHART_H)}px`)

    await scrollTo(scroll, 64)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')

    await scrollTo(scroll, 15)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '100')
    await scrollTo(scroll, 13)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')

    await m.update(h(TrendChart, propsOf(reqs, { adaptive: false })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '900')
    await m.unmount()

    const durations: RequestRecord[] = []
    for (let i = 0; i < 30; i++) durations.push(req(i + 1, { turn: 1, step: i, activeMs: i === 0 ? 9000 : 1000 }))
    const curve = await mount(h(TrendChart, propsOf(durations, { adaptive: true, durationCurve: true })))
    await flush()
    const curveScroll = query<LayoutEl>(curve.container, '.lc-chart-scroll')
    assert.equal(query(curve.container, '.lc-axis-r .lc-axis-top').textContent, '1.0s')
    await scrollTo(curveScroll, 0)
    assert.equal(query(curve.container, '.lc-axis-r .lc-axis-top').textContent, '9.0s', 'the curve rescales with the visible window like the bars')
    await curve.unmount()
  })

  test('an empty history or a zero-width viewport keeps the previous scale', async () => {
    const empty = await mount(h(TrendChart, propsOf([], { adaptive: true })))
    assert.equal(query(empty.container, '.lc-axis-top').textContent, '1')
    await empty.unmount()

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
    const reqs = [step(0, 100), step(1, 600)]
    for (let i = 2; i < 30; i++) reqs.push(step(i, 600 + (i - 1) * 10 - (i >= 20 ? 40 : 0)))
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta', adaptive: true })))
    await flush()
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+10')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-30')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 28}px`)
    assert.equal(queryAll(bars(m.container)[29], '.lc-bar-up > div')[0].style.height, `${Math.round(10 * CHART_H / 40)}px`)
    assert.equal(queryAll(bars(m.container)[20], '.lc-bar-down > div')[0].style.height, `${Math.round(30 * CHART_H / 40)}px`)
    await m.unmount()

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
  const activeMsY = (activeMs: number, maxActiveMs: number): number => Math.round((CHART_H - activeMs * (CHART_H / Math.max(1, maxActiveMs))) * 100) / 100

  test('off by default there is no curve or right-hand axis; with no stamped durations the enabled axis dashes', async () => {
    const off = await mount(h(TrendChart, propsOf([req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 })])))
    assert.equal(queryAll(off.container, '.lc-duration').length, 0)
    assert.equal(queryAll(off.container, '.lc-axis-r').length, 0)
    await off.unmount()

    const m = await mount(h(TrendChart, propsOf([req(1), req(2)], { durationCurve: true })))
    assert.equal(queryAll(m.container, '.lc-duration').length, 0)
    const axis = query(m.container, '.lc-axis-r')
    assert.equal(query(axis, '.lc-axis-top').textContent, '—')
    assert.equal(query(axis, '.lc-axis-bot').textContent, '0')
    await m.unmount()
  })

  test('on: the curve rides the bar columns and the right axis carries duration quartiles', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 }), req(3, { activeMs: 4000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-duration')
    assert.equal(svg.getAttribute('width'), String(3 * BAR_CELL - 2))
    assert.equal(svg.getAttribute('height'), String(CHART_H))
    const lines = queryAll(svg, 'polyline:not(.lc-dur-halo)')
    assert.equal(lines.length, 1, 'one contiguous run of stamped bars')
    assert.equal(
      lines[0].getAttribute('points'),
      `7,${activeMsY(1000, 4000)} 23,${activeMsY(2000, 4000)} 39,${activeMsY(4000, 4000)}`,
    )
    const halos = queryAll(svg, 'polyline.lc-dur-halo')
    assert.equal(halos.length, 1, 'each run paints a card-bg knockout underlay')
    assert.equal(halos[0].getAttribute('points'), lines[0].getAttribute('points'))
    assert.equal(queryAll(svg, 'circle').length, 0)
    const axis = query(m.container, '.lc-axis-r')
    assert.equal(query(axis, '.lc-axis-top').textContent, '4.0s')
    assert.equal(query(axis, '.lc-axis-q3').textContent, '3.0s')
    assert.equal(query(axis, '.lc-axis-mid').textContent, '2.0s')
    assert.equal(query(axis, '.lc-axis-q1').textContent, '1.0s')
    assert.equal(query(axis, '.lc-axis-bot').textContent, '0')
    await m.unmount()

    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, activeMs: 500 }),
      req(3, { turn: 2, step: 0, activeMs: 2000 }),
    ])
    const turns = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn', durationCurve: true })))
    const turnLines = queryAll(query(turns.container, '.lc-duration'), 'polyline:not(.lc-dur-halo)')
    assert.equal(turnLines[0].getAttribute('points'), `7,${activeMsY(1500, 2000)} 23,${activeMsY(2000, 2000)}`, 'each turn plots its summed active time')
    assert.equal(query(turns.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    await turns.unmount()
  })

  test('a bar without ms breaks the line; an isolated single point draws a dot', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2), req(3, { activeMs: 2000 }), req(4, { activeMs: 4000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-duration')
    const lines = queryAll(svg, 'polyline:not(.lc-dur-halo)')
    assert.equal(lines.length, 1, 'the trailing pair re-joins after the gap')
    assert.equal(lines[0].getAttribute('points'), `39,${activeMsY(2000, 4000)} 55,${activeMsY(4000, 4000)}`)
    const dots = queryAll(svg, 'circle:not(.lc-dur-halo)')
    assert.equal(dots.length, 1, 'a one-point run would be an invisible polyline')
    assert.equal(dots[0].getAttribute('cx'), '7')
    assert.equal(dots[0].getAttribute('cy'), String(activeMsY(1000, 4000)))
    await m.unmount()
  })

  test('delta mode keeps the floor-anchored duration axis; the hover tip appends the duration row', async () => {
    const reqs = [req(1, { activeMs: 1000 }), req(2, { activeMs: 2000 })]
    const m = await mount(h(TrendChart, propsOf(reqs, { mode: 'delta', durationCurve: true, hoveredSeq: 1 })))
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    assert.equal(queryAll(query(m.container, '.lc-duration'), 'polyline:not(.lc-dur-halo)').length, 1)
    const rows = queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent)
    assert.equal(rows.length, 3)
    assert.equal(rows[2], kit.t('tip.duration', { n: '1.0s' }))
    await m.update(h(TrendChart, propsOf(reqs, { mode: 'delta', hoveredSeq: 1 })))
    assert.equal(queryAll(query(m.container, '.lc-chart-tip'), 'span').length, 2)
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

  async function narrowViewport(body: () => Promise<void>): Promise<void> {
    const saved = viewport.clientW
    viewport.clientW = 30
    try {
      await body()
    } finally {
      viewport.clientW = saved
    }
  }

  test('the end-anchor sticks only near the end, and a data push follows the newest bar only there', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')

    assert.equal(scroll.scrollLeft, 240)
    await scrollTo(scroll, 100)

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, selectedSeq: 1 })))
    assert.equal(scroll.scrollLeft, 100)
    await scrollTo(scroll, 230)
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, selectedSeq: 2 })))
    await flush()
    assert.equal(scroll.scrollLeft, 230, 'selection-only update near the end does not stick')

    await scrollTo(scroll, 240)
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.equal(labels.length, 4)
    assert.equal(labels[1].style.transform, 'translateX(40px)')
    assert.equal(labels[2].style.transform, '')
    assert.equal(labels[0].style.transform, '')
    await scrollTo(scroll, 0)
    assert.equal(labels[1].style.transform, '', 'back at the left edge every block centers natively')
    await m.unmount()

    const pushedReqs = manySteps()
    const pushedSpies = makeSpies()
    const pushed = await mount(h(TrendChart, propsOf(pushedReqs, pushedSpies.handlers)))
    await flush()
    const pushedScroll = query<LayoutEl>(pushed.container, '.lc-chart-scroll')
    assert.equal(pushedScroll.scrollLeft, 240)
    const grown = [...pushedReqs, req(pushedReqs.length + 1, { turn: 1 + Math.floor(pushedReqs.length / 10), step: pushedReqs.length % 10 })]
    await pushed.update(h(TrendChart, propsOf(grown, pushedSpies.handlers)))
    await flush()
    assert.equal(pushedScroll.scrollLeft, 256, 'near-edge reader follows the appended bar')
    await scrollTo(pushedScroll, 100)
    const grown2 = [...grown, req(grown.length + 1, { turn: 1 + Math.floor(grown.length / 10), step: grown.length % 10 })]
    await pushed.update(h(TrendChart, propsOf(grown2, pushedSpies.handlers)))
    await flush()
    assert.equal(pushedScroll.scrollLeft, 100, 'mid-scroll reader is not yanked back to the newest')
    await pushed.unmount()
  })

  test('a granularity switch re-anchors and flips overflow for real (React #185 regression)', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, granularity: 'step' })))
    await flush()
    assert.equal(query(m.container, '.lc-chart-scroll').scrollLeft, 240)

    await m.update(h(TrendChart, propsOf(aggregateByTurn(reqs), { ...handlers, granularity: 'turn' })))
    await flush()
    assert.equal(bars(m.container).length, 4)

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, granularity: 'step' })))
    await flush()
    assert.equal(bars(m.container).length, 40)
    assert.equal(query(m.container, '.lc-chart-scroll').scrollLeft, 240)
    await m.unmount()
  })

  test('focusTurn and focusSeq scroll-center their bar once; an absent target still consumes the focus', async () => {
    await narrowViewport(async () => {
      const agg = aggregateByTurn([...manySteps(), ...manySteps().map(r => ({ ...r, seq: r.seq + 40, turn: (r.turn ?? 0) + 4 }))])
      assert.equal(agg.length, 8)
      const { spies, handlers } = makeSpies()
      const m = await mount(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', focusTurn: 2 })))
      await flush()
      const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
      assert.ok(spies.focusHandled >= 1)
      assert.equal(scroll.scrollLeft, 8)

      const before = spies.focusHandled
      await m.update(h(TrendChart, propsOf(agg, { ...handlers, granularity: 'turn', focusTurn: 99 })))
      await flush()
      assert.ok(spies.focusHandled > before, 'the focus is consumed even when the turn is absent')
      assert.equal(scroll.scrollLeft, 8, 'no focus target and not near the end → the scroll position holds')
      await m.unmount()

      const reqs = manySteps()
      const stepSpies = makeSpies()
      const step = await mount(h(TrendChart, propsOf(reqs, { ...stepSpies.handlers, focusSeq: 21 })))
      await flush()
      const stepScroll = query<LayoutEl>(step.container, '.lc-chart-scroll')
      assert.ok(stepSpies.spies.seqFocusHandled >= 1)
      assert.equal(stepScroll.scrollLeft, 20 * 16 + 7 - 15)

      const stepBefore = stepSpies.spies.seqFocusHandled
      await step.update(h(TrendChart, propsOf(reqs, { ...stepSpies.handlers, focusSeq: 999 })))
      await flush()
      assert.ok(stepSpies.spies.seqFocusHandled > stepBefore, 'the focus is consumed even when the step is absent')
      assert.equal(stepScroll.scrollLeft, 20 * 16 + 7 - 15, 'no focus target and not near the end → the scroll position holds')
      await step.unmount()
    })
  })

  test('turn labels clear their shift for blocks narrower than the measured label', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < 16; i++) reqs.push(req(i + 1, { turn: 1 + Math.floor(i / 8), step: i % 8 }))
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, handlers)))
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.equal(labels.length, 2)

    scroll.__clientW = 60
    await scrollTo(scroll, 150)
    assert.equal(labels[1].style.transform, 'translateX(-11px)')
    assert.equal(labels[0].style.transform, '')

    Object.defineProperty(labels[1], 'offsetWidth', { configurable: true, get: () => 200 })
    await scrollTo(scroll, 150)
    assert.equal(labels[1].style.transform, '')

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
    const agg = aggregateByTurn([req(1, { turn: 10 }), req(2, { turn: 11 }), req(3, { turn: 12 })])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const labels = queryAll(m.container, '.lc-turn-label')
    assert.deepEqual(labels.map(l => l.textContent), ['10', '11', '12'])

    for (const l of labels) Object.defineProperty(l, 'offsetWidth', { configurable: true, get: () => 20 })
    await scrollEvent(scroll)
    assert.equal(labels[0].style.visibility, '')
    assert.equal(labels[1].style.visibility, 'hidden')
    assert.equal(labels[2].style.visibility, '')

    for (const l of labels) Object.defineProperty(l, 'offsetWidth', { configurable: true, get: () => 8 })
    await scrollEvent(scroll)
    assert.equal(labels[1].style.visibility, '')
    await scrollEvent(scroll)
    assert.equal(labels[1].style.visibility, '', 'repeat scroll with unchanged geometry writes nothing')
    await m.unmount()
  })

  test('the strip shrinks every label to the largest size at which the tightest adjacent pair fits', async () => {
    const single = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 1 }), req(2, { turn: 2 }), req(3, { turn: 10 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(single.container, '.lc-turns').style.fontSize, '')
    await single.unmount()

    const three = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 100 }), req(2, { turn: 101 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(three.container, '.lc-turns').style.fontSize, '7px')
    await three.unmount()

    const four = await mount(h(TrendChart, propsOf(
      aggregateByTurn([req(1, { turn: 1000 }), req(2, { turn: 1001 })]),
      { granularity: 'turn' },
    )))
    assert.equal(query<HTMLElement>(four.container, '.lc-turns').style.fontSize, '6px')
    await four.unmount()

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

  test('renders outside the scroller, glues to the visible slice while scrolling, and clamps real widths at both edges', async () => {
    const reqs = manySteps()
    const { handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 40 })))
    await flush()
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    const tip = query(m.container, '.lc-chart-tip')
    assert.equal(tip.parentElement!.className, 'lc-chart-wrap', 'the tip is a sibling of the scroller, not its child')
    assert.equal(query(m.container, '.lc-chart-wrap').contains(tip), true)
    assert.equal(query(m.container, '.lc-chart-wrap').contains(scroll), true)

    assert.equal(tip.style.transform, 'translate(391px, 0)')

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 20 })))
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(71px, 0)')
    await scrollTo(scroll, 100)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(211px, 0)')
    await scrollTo(scroll, 211)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(100px, 0)')

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 2 })))
    await scrollTo(scroll, 240)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(0px, 0)')

    assert.equal(scroll.scrollWidth, 640)
    await m.unmount()

    const wideSpies = makeSpies()
    const wide = await mount(h(TrendChart, propsOf(manySteps(), { ...wideSpies.handlers, hoveredSeq: 30 })))
    await flush()
    const wideScroll = query<LayoutEl>(wide.container, '.lc-chart-scroll')
    const wideTip = query<LayoutEl & { offsetWidth: number }>(wide.container, '.lc-chart-tip')
    wideScroll.__clientW = 160
    Object.defineProperty(wideTip, 'offsetWidth', { configurable: true, get: () => 120 })
    try {
      await scrollTo(wideScroll, 0)
      assert.equal(wideTip.style.transform, 'translate(40px, 0)')
      await scrollTo(wideScroll, 380)
      assert.equal(wideTip.style.transform, 'translate(31px, 0)')
      await scrollTo(wideScroll, 480)
      assert.equal(wideTip.style.transform, 'translate(0px, 0)')
      Object.defineProperty(wideTip, 'offsetWidth', { configurable: true, get: () => 500 })
      await scrollTo(wideScroll, 0)
      assert.equal(wideTip.style.transform, 'translate(-170px, 0)')
    } finally {
      delete wideScroll.__clientW
      await wide.unmount()
    }
  })
})
