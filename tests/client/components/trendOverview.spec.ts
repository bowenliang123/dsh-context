
import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { aggregateByTurn } from '../../../src/client/components/trendChart'
import { makeTrendOverview, type TrendOverviewProps } from '../../../src/client/components/trendOverview'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover } from '../helpers/kit'
import { kit, req } from './trendChartHarness'

const TrendOverview = makeTrendOverview(kit)

function propsOf(requests: RequestRecord[], over: Partial<TrendOverviewProps> = {}): TrendOverviewProps {
  return {
    requests,
    markers: requests.map(() => undefined),
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    hoverCat: null,
    onSelect: () => {},
    onHover: () => {},
    onHoverTurn: () => {},
    onPickTurn: () => {},
    ...over,
  }
}

function stubSurfaceRect(el: HTMLElement, width = 400): void {
  el.getBoundingClientRect = () => ({ top: 0, left: 0, right: width, bottom: 130, width, height: 130, x: 0, y: 0, toJSON: () => null }) as DOMRect
}

async function moveXY(el: HTMLElement, clientX: number, clientY: number): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX, clientY })) })
}

async function moveX(el: HTMLElement, clientX: number): Promise<void> {
  await moveXY(el, clientX, 0)
}

async function clickXY(el: HTMLElement, clientX: number, clientY: number): Promise<void> {
  await act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX, clientY })) })
}

async function clickX(el: HTMLElement, clientX: number): Promise<void> {
  await clickXY(el, clientX, 0)
}

const deltaBase = req(1)
const deltaGrown = req(2, { system: 108, tools: 58, user: 38, inject: 28, skill: 8, assistant: 48, tool: 68, total: 346 })

describe('TrendOverview total-mode ribbon', () => {
  const r1 = req(1, { turn: 1, step: 0, skill: 0 })
  const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600, skill: 0 })

  test('stacks exact bands between adjacent cumulates, closes a lone record full-width, and keeps the unit axis for zero or empty histories', async () => {
    const m = await mount(h(TrendOverview, propsOf([r1, r2])))
    const svg = query(m.container, '.lc-fit-svg')
    assert.match(svg.getAttribute('class')!, /\blc-bar-in\b/)
    assert.match(svg.getAttribute('class')!, /\blc-duration\b/)
    assert.equal(svg.getAttribute('viewBox'), '0 0 1 112')
    assert.equal(svg.getAttribute('preserveAspectRatio'), 'none')
    const polys = queryAll(svg, 'polygon')
    assert.deepEqual(polys.map(p => p.getAttribute('data-cat')), ['system', 'tools', 'user', 'inject', 'assistant', 'tool'])
    assert.equal(polys.some(p => p.getAttribute('data-cat') === 'skill'), false, 'a zero-width category paints no band')
    assert.deepEqual([polys[0], polys[1], polys[5]].map(p => p.getAttribute('points')), [
      '0,93.33 1,74.67 1,112 0,112',
      '0,84 1,56 1,74.67 0,93.33',
      '0,56 1,0 1,22.4 0,67.2',
    ])
    assert.equal(polys[0].style.fill, 'var(--color-indigo-500)')
    assert.equal(polys[5].style.stroke, 'var(--color-teal-500)')
    assert.deepEqual(['top', 'q3', 'mid', 'q1', 'bot'].map(k => query(m.container, `.lc-axis-${k}`).textContent),
      ['600', '450', '300', '150', '0'])
    await m.unmount()

    const single = await mount(h(TrendOverview, propsOf([r1])))
    assert.equal(query(single.container, '.lc-fit-svg').getAttribute('viewBox'), '0 0 1 112')
    assert.equal(query(single.container, 'polygon').getAttribute('points'), '0,74.67 1,74.67 1,112 0,112')
    assert.equal(query(single.container, '.lc-turn-label').textContent, '1')
    assert.equal(queryAll(single.container, '.lc-trend-flag').length, 0)
    await single.unmount()

    const zero = req(9, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const zeroMount = await mount(h(TrendOverview, propsOf([zero])))
    assert.equal(query(zeroMount.container, '.lc-axis-top').textContent, '1')
    assert.equal(queryAll(zeroMount.container, '.lc-fit-svg').length, 0)
    await zeroMount.unmount()

    const empty = await mount(h(TrendOverview, propsOf([])))
    assert.equal(empty.container.firstElementChild, null)
    await empty.unmount()
  })
})

describe('TrendOverview delta ribbon', () => {
  test('splits grow/shrink around the proportional zero line; a lone record paints no bands', async () => {
    const lone = await mount(h(TrendOverview, propsOf([deltaBase], { mode: 'delta' })))
    assert.equal(queryAll(lone.container, '.lc-fit-svg').length, 0)
    assert.equal(query(lone.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(lone.container, '.lc-axis-bot').textContent, '0')
    await lone.unmount()

    const m = await mount(h(TrendOverview, propsOf([deltaBase, deltaGrown, deltaBase], { mode: 'delta' })))
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 56}px`)
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '+28')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '-28')
    const polys = queryAll(m.container, 'polygon')
    assert.equal(polys.length, 14)
    const up = polys.find(p => p.getAttribute('data-cat') === 'system' && p.getAttribute('points')!.startsWith('0,56 1,48'))
    assert.ok(up !== undefined)
    assert.equal(up.getAttribute('points'), '0,56 1,48 2,56 2,56 1,56 0,56')
    const down = polys.find(p => p.getAttribute('data-cat') === 'system' && p.getAttribute('points')!.endsWith('2,64 1,56 0,56'))
    assert.ok(down !== undefined)
    assert.equal(down.getAttribute('points'), '0,56 1,56 2,56 2,64 1,56 0,56')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+56')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-56')
    await m.unmount()
  })

  test('a quarter mark yields entirely when its label box would overlap the zero label', async () => {
    const heavy = req(1, { turn: 1, step: 0, system: 400, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360, total: 2490 })
    const upSmall = req(2, { turn: 1, step: 1, system: 540, total: 2630, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const downBig = req(3, { turn: 2, step: 0, system: 340, tools: 290, user: 270, inject: 260, skill: 250, assistant: 280, tool: 300, total: 1990 })
    const m1 = await mount(h(TrendOverview, propsOf([heavy, upSmall, downBig], { mode: 'delta' })))
    assert.equal(query(m1.container, '.lc-axis-mid').style.top, `${13 + 22}px`)
    assert.equal(queryAll(m1.container, '.lc-axis-q3').length, 0)
    assert.equal(queryAll(m1.container, '.lc-grid-q3').length, 0)
    assert.equal(query(m1.container, '.lc-axis-q1').textContent, '-385')
    await m1.unmount()

    const upBig = req(2, { turn: 1, step: 1, system: 820, total: 2910, tools: 350, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const downSmall = req(3, { turn: 2, step: 0, system: 760, tools: 270, total: 2690, user: 330, inject: 320, skill: 310, assistant: 340, tool: 360 })
    const m2 = await mount(h(TrendOverview, propsOf([heavy, upBig, downSmall], { mode: 'delta' })))
    assert.equal(query(m2.container, '.lc-axis-mid').style.top, `${13 + 84}px`)
    assert.equal(queryAll(m2.container, '.lc-axis-q1').length, 0)
    assert.equal(queryAll(m2.container, '.lc-grid-q1').length, 0)
    assert.equal(query(m2.container, '.lc-axis-q3').textContent, '+280')
    await m2.unmount()
  })
})

describe('TrendOverview duration overlay', () => {
  const reqs = [
    req(1, { turn: 1, step: 0, activeMs: 1000 }),
    req(2, { turn: 1, step: 1 }),
    req(3, { turn: 1, step: 2, activeMs: 2000 }),
    req(4, { turn: 1, step: 3, activeMs: 500 }),
  ]

  test('the curve rides record positions, breaks on missing stamps, dots lone points', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs, { durationCurve: true })))
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 3 112')
    const lines = queryAll(svg, 'polyline:not(.lc-dur-halo)')
    assert.equal(lines.length, 1)
    assert.equal(lines[0].getAttribute('points'), '2,0 3,84')
    assert.equal(queryAll(svg, '.lc-dur-halo').length, 2)
    const dot = queryAll(svg, 'circle').find(c => c.getAttribute('r') === '2')
    assert.ok(dot !== undefined)
    assert.equal(dot.getAttribute('cx'), '0')
    assert.equal(dot.getAttribute('cy'), '56')
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-top').textContent, '2.0s')
    assert.equal(query(m.container, '.lc-axis-r .lc-axis-q1').textContent, '500ms')
    await m.unmount()

    const unstamped = await mount(h(TrendOverview, propsOf([req(1), req(2)], { durationCurve: true })))
    assert.equal(query(unstamped.container, '.lc-axis-r .lc-axis-top').textContent, '—')
    assert.equal(queryAll(unstamped.container, 'polyline').length, 0, 'no stamps: the curve is absent')
    assert.equal(queryAll(unstamped.container, 'polygon').length, 6, 'the bands still paint')
    await unstamped.unmount()
  })
})

describe('TrendOverview provider series', () => {
  const reqs = [
    req(1, { turn: 1, step: 0, total: 300, prompt: 600 }),
    req(2, { turn: 1, step: 1, total: 300, prompt: 300 }),
    req(3, { turn: 1, step: 2 }),
  ]

  test('the provider prompt rides the ribbon and the axis reaches it', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs)))
    const svg = query(m.container, '.lc-fit-svg')
    const line = queryAll(svg, 'polyline.lc-actual-line')[0]
    assert.equal(line.getAttribute('points'), '0,0 1,56')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    await m.unmount()

    const lone = await mount(h(TrendOverview, propsOf([
      req(1, { turn: 1, step: 0, total: 300, prompt: 600 }),
      req(2, { turn: 1, step: 1, total: 300 }),
    ])))
    assert.equal(queryAll(lone.container, 'polyline.lc-actual-line').length, 0, 'a lone point is a dot')
    assert.equal(queryAll(lone.container, 'circle.lc-actual-dot').length, 1)
    await lone.unmount()
  })
})

describe('TrendOverview category focus', () => {
  test('plots the focused band rescaled to its own max; an unknown key degrades', async () => {
    const r1 = req(1, { turn: 1, step: 0 })
    const r2 = req(2, { turn: 1, step: 1, tool: 120, total: 600 })
    const m = await mount(h(TrendOverview, propsOf([r1, r2], { focusCat: 'tool' })))
    assert.equal(query(m.container, '.lc-axis-top').textContent, '120')
    const polys = queryAll(m.container, 'polygon')
    assert.equal(polys.length, 1)
    assert.equal(polys[0].getAttribute('data-cat'), 'tool')
    assert.equal(polys[0].getAttribute('points'), '0,56 1,0 1,112 0,112')
    await m.unmount()

    const m2 = await mount(h(TrendOverview, propsOf([r1, r2], { focusCat: 'nope' })))
    assert.equal(query(m2.container, '.lc-axis-top').textContent, '600')
    assert.equal(queryAll(m2.container, 'polygon').length, 6)
    await m2.unmount()

    const hover = await mount(h(TrendOverview, propsOf([r1, r2], { hoverCat: 'tools' })))
    assert.equal(query(hover.container, '.lc-chart').getAttribute('data-catdim'), 'tools', 'the shared category hover rides the container attribute')
    await hover.update(h(TrendOverview, propsOf([r1, r2])))
    assert.equal(query(hover.container, '.lc-chart').hasAttribute('data-catdim'), false)
    await hover.unmount()
  })
})

describe('TrendOverview flags and markers', () => {
  function steps(count: number, perTurn = 1): RequestRecord[] {
    const out: RequestRecord[] = []
    for (let i = 1; i <= count; i++) out.push(req(i, { turn: Math.ceil(i / perTurn), step: (i - 1) % perTurn }))
    return out
  }

  test('plants poles at the record quartiles and the full span (step granularity)', async () => {
    const m = await mount(h(TrendOverview, propsOf(steps(47))))
    const flags = queryAll(m.container, '.lc-trend-flag')
    assert.equal(flags.length, 4)
    const idx = [12, 23, 35]
    flags.slice(0, 3).forEach((f, i) => assert.ok(Math.abs(parseFloat(f.style.left) - idx[i] / 46 * 100) < 1e-9, f.style.left))
    assert.equal(flags[3].style.left, 'calc(100% - 1px)')
    assert.deepEqual(flags.map(f => query(f, '.lc-trend-flag-label').textContent), ['13', '24', '36', '47'])
    await m.unmount()
  })

  test('short logs keep the collapsed-at-start pole out but keep the full-span pole', async () => {
    const two = await mount(h(TrendOverview, propsOf(steps(2))))
    const flag = query(two.container, '.lc-trend-flag')
    assert.equal(query(flag, '.lc-trend-flag-label').textContent, '2')
    assert.equal(flag.style.left, 'calc(100% - 1px)')
    await two.unmount()
    const three = await mount(h(TrendOverview, propsOf(steps(3))))
    const flags = queryAll(three.container, '.lc-trend-flag')
    assert.deepEqual(flags.map(f => query(f, '.lc-trend-flag-label').textContent), ['2', '3'])
    assert.equal(flags[0].style.left, '50%')
    await three.unmount()
    const one = await mount(h(TrendOverview, propsOf([req(1, { turn: 1, step: 0 })])))
    assert.equal(queryAll(one.container, '.lc-trend-flag').length, 0)
    await one.unmount()
  })

  test('turn poles and strip blocks share the absolute, equal-width turn axis rather than step-span widths', async () => {
    const m = await mount(h(TrendOverview, propsOf(aggregateByTurn(steps(10, 2)), { granularity: 'turn' })))
    const flags = queryAll(m.container, '.lc-trend-flag')
    assert.equal(flags.length, 4)
    flags.slice(0, 3).forEach((f, i) => assert.ok(Math.abs(parseFloat(f.style.left) - (i + 1) / 4 * 100) < 1e-9, f.style.left))
    assert.equal(flags[3].style.left, 'calc(100% - 1px)')
    assert.deepEqual(flags.map(f => query(f, '.lc-trend-flag-label').textContent), ['2', '3', '4', '5'])
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['2', '3', '4', '5'])
    const blocks = queryAll(m.container, '.lc-turn')
    assert.equal(blocks.length, 5)
    assert.deepEqual(blocks.map(b => b.style.flexGrow), ['1', '1', '1', '1', '1'])
    await m.unmount()

    const wideTail = [
      req(1, { turn: 1, step: 0 }),
      req(2, { turn: 2, step: 0 }),
      ...Array.from({ length: 50 }, (_, i) => req(3 + i, { turn: 3, step: i })),
    ]
    const tail = await mount(h(TrendOverview, propsOf(aggregateByTurn(wideTail), { granularity: 'turn' })))
    assert.deepEqual(queryAll(tail.container, '.lc-trend-flag-label').map(l => l.textContent), ['2', '3'])
    assert.equal(queryAll(tail.container, '.lc-trend-flag')[1].style.left, 'calc(100% - 1px)')
    assert.deepEqual(queryAll(tail.container, '.lc-turn').map(b => b.style.flexGrow), ['1', '1', '1'])
    assert.deepEqual(queryAll(tail.container, '.lc-turn-label').map(l => l.textContent), ['1', '2', '3'])
    await tail.unmount()
    const tailSteps = await mount(h(TrendOverview, propsOf(wideTail)))
    assert.deepEqual(queryAll(tailSteps.container, '.lc-turn-label').map(l => l.textContent), ['3'], 'a wide tail turn carries every strip quartile its width holds')
    await tailSteps.unmount()

    const absolutes = aggregateByTurn([301, 302, 303, 304, 305].map((turn, i) => req(i + 1, { turn, step: 0 })))
    const absoluteMount = await mount(h(TrendOverview, propsOf(absolutes, { granularity: 'turn' })))
    assert.deepEqual(queryAll(absoluteMount.container, '.lc-trend-flag-label').map(l => l.textContent), ['302', '303', '304', '305'])
    assert.deepEqual(queryAll(absoluteMount.container, '.lc-turn-label').map(l => l.textContent), ['302', '303', '304', '305'])
    await absoluteMount.unmount()
  })

  test('markers carry the positioned scissors with the event title', async () => {
    const reqs = steps(3, 2)
    const compaction: ContextEventRecord = { seq: 2, time: 1700000000000, kind: 'compaction', count: 5, fromTurn: 1, fromStep: 0, turn: 1, step: 1 }
    const prune: ContextEventRecord = { seq: 3, time: 1700000060000, kind: 'prune' }
    const markers = [undefined, compaction, prune]
    const m = await mount(h(TrendOverview, propsOf(reqs, { markers })))
    const glyphs = queryAll(m.container, '.lc-bar-marker')
    assert.equal(glyphs.length, 2)
    assert.equal(glyphs[0].textContent, '✂')
    assert.equal(glyphs[0].style.left, '50%')
    assert.equal(
      glyphs[0].getAttribute('title'),
      '✂ ' + kit.t('events.range', { t: 1, a: 0, b: 1 }) + ' — ' + kit.t('ev.compaction', { n: 5 }),
    )
    assert.equal(glyphs[1].style.left, '100%')
    assert.equal(glyphs[1].getAttribute('title'), '✂ ' + kit.t('ev.prune'))
    await m.unmount()
  })

})

describe('TrendOverview pointer interaction', () => {
  const reqs = [1, 2, 3, 4, 5].map(i => req(i, { turn: 1, step: i - 1 }))

  test('mousemove picks the nearest record, dedupes repeats, lights the band under the pointer, and clears on leave', async () => {
    const spies = { select: [] as (number | null)[], hover: [] as (number | null)[], hoverTurn: [] as (number | null)[], pickTurn: [] as number[] }
    const m = await mount(h(TrendOverview, propsOf(reqs, {
      onSelect: (s) => { spies.select.push(s) },
      onHover: (s) => { spies.hover.push(s) },
      onHoverTurn: (t) => { spies.hoverTurn.push(t) },
      onPickTurn: (t) => { spies.pickTurn.push(t) },
    })))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    await moveX(surface, 200)
    await moveX(surface, 210)
    await moveX(surface, 399)
    await moveX(surface, -100)
    assert.deepEqual(spies.hover, [3, 5, 1])
    await unhover(surface)
    assert.deepEqual(spies.hover, [3, 5, 1, null])
    await m.unmount()

    const unmeasured = { hover: [] as (number | null)[] }
    const zeroWidth = await mount(h(TrendOverview, propsOf(reqs, { onHover: (s) => { unmeasured.hover.push(s) } })))
    await moveX(query(zeroWidth.container, '.lc-chart'), 300)
    assert.deepEqual(unmeasured.hover, [1], 'a zero-width rect picks the first record')
    await zeroWidth.unmount()

    const lone = { hover: [] as (number | null)[], select: [] as (number | null)[] }
    const single = await mount(h(TrendOverview, propsOf([req(1)], {
      onHover: (s) => { lone.hover.push(s) },
      onSelect: (s) => { lone.select.push(s) },
    })))
    const loneSurface = query(single.container, '.lc-chart')
    stubSurfaceRect(loneSurface)
    await moveX(loneSurface, 400)
    await clickX(loneSurface, 400)
    assert.deepEqual(lone.hover, [1], 'a single record keeps the far edge on its only record')
    assert.deepEqual(lone.select, [1])
    await single.unmount()

    const band = { hover: [] as (number | null)[] }
    const banded = await mount(h(TrendOverview, propsOf(reqs, { onHover: (s) => { band.hover.push(s) } })))
    const bandSurface = query(banded.container, '.lc-chart')
    stubSurfaceRect(bandSurface)
    await moveXY(bandSurface, 200, 30)
    assert.equal(bandSurface.getAttribute('data-catdim'), 'tool', 'the band under the pointer lights its whole category')
    await moveXY(bandSurface, 200, 120)
    assert.equal(bandSurface.getAttribute('data-catdim'), 'system')
    await moveXY(bandSurface, 200, 56)
    assert.equal(bandSurface.getAttribute('data-catdim'), 'inject', 'the zero-width skill band is never hit-tested; its neighbour answers')
    assert.deepEqual(band.hover, [3])
    await unhover(bandSurface)
    assert.equal(bandSurface.hasAttribute('data-catdim'), false)
    assert.deepEqual(band.hover, [3, null])
    await banded.unmount()
  })

  test('the pointer tracks locally without waiting for the parent hover', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs)))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    await moveX(surface, 200)
    assert.equal(query(m.container, '.lc-fit-cursor').style.left, '50%')
    assert.equal(query(query(m.container, '.lc-chart-tip'), 'span').textContent, kit.t('tip.step', { t: 1, s: 2, n: 5 }))
    await moveX(surface, 120)
    assert.equal(query(m.container, '.lc-fit-cursor').style.left, '25%')
    await unhover(surface)
    assert.equal(queryAll(m.container, '.lc-fit-cursor').length, 0)
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    await m.unmount()
  })

  test('clicking a band opens its category and still pins the record', async () => {
    const spies = { cat: [] as string[], select: [] as (number | null)[] }
    const m = await mount(h(TrendOverview, propsOf(reqs, {
      onPickCat: (c, seq) => { spies.cat.push(`${c}:${seq}`) },
      onSelect: (s) => { spies.select.push(s) },
    })))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    await clickXY(surface, 200, 30)
    assert.deepEqual(spies.cat, ['tool:3'])
    assert.deepEqual(spies.select, [3])
    await clickXY(surface, 200, 0)
    assert.deepEqual(spies.cat, ['tool:3'])
    assert.deepEqual(spies.select, [3, 3])

    await m.update(h(TrendOverview, propsOf(reqs, {
      selectedSeq: 3,
      onPickCat: (c, seq) => { spies.cat.push(`${c}:${seq}`) },
      onSelect: (s) => { spies.select.push(s) },
    })))
    await clickXY(surface, 200, 30)
    assert.deepEqual(spies.select, [3, 3, null])
    await m.update(h(TrendOverview, propsOf(reqs, {
      onPickCat: (c, seq) => { spies.cat.push(`${c}:${seq}`) },
      onSelect: (s) => { spies.select.push(s) },
    })))
    await clickXY(surface, 10, 0)
    assert.deepEqual(spies.select, [3, 3, null, 1], 'a fresh record pins')
    await m.unmount()

    const r1 = req(1, { user: 200, tools: 0, inject: 0, assistant: 0, tool: 0, total: 300 })
    const r2 = req(2, { tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 100 })
    const interpolated = await mount(h(TrendOverview, propsOf([r1, r2])))
    const interpolatedSurface = query(interpolated.container, '.lc-chart')
    stubSurfaceRect(interpolatedSurface)
    await moveXY(interpolatedSurface, 100, 28)
    assert.equal(interpolatedSurface.hasAttribute('data-catdim'), false)
    await moveXY(interpolatedSurface, 300, 78)
    assert.equal(interpolatedSurface.getAttribute('data-catdim'), 'user')
    await interpolated.unmount()
  })

  test('delta arms resolve their categories above and below the zero line', async () => {
    const m = await mount(h(TrendOverview, propsOf([deltaBase, deltaGrown, deltaBase], { mode: 'delta' })))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    await moveXY(surface, 200, 22)
    assert.equal(surface.getAttribute('data-catdim'), 'tool')
    await moveXY(surface, 400, 128)
    assert.equal(surface.getAttribute('data-catdim'), 'tool')
    await moveXY(surface, 200, 70)
    assert.equal(surface.getAttribute('data-catdim'), 'system')
    await m.unmount()
  })

  test('a lit band replaces the other-turn wash; empty space keeps it', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs, { activeTurn: 1 })))
    const surface = query(m.container, '.lc-chart')
    stubSurfaceRect(surface)
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 2)
    await moveXY(surface, 200, 30)
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 0)
    await moveXY(surface, 200, 0)
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 2)
    assert.equal(surface.hasAttribute('data-catdim'), false)
    await m.update(h(TrendOverview, propsOf(reqs, { activeTurn: 1, focusCat: 'tool' })))
    await moveXY(surface, 200, 30)
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 0)
    assert.equal(surface.getAttribute('data-catdim'), 'tool')
    await m.unmount()
  })

  test('the hovered record drives the tip, the brand rule, and the selection pin', async () => {
    const m = await mount(h(TrendOverview, propsOf(reqs)))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    assert.equal(queryAll(m.container, '.lc-fit-cursor').length, 0)

    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 3 })))
    const tip = query(m.container, '.lc-chart-tip')
    assert.deepEqual(queryAll(tip, 'span').map(r => r.textContent), [
      kit.t('tip.step', { t: 1, s: 2, n: 5 }),
      kit.t('tip.total', { n: '300' }),
    ])
    assert.equal(tip.style.transform, 'translate(200px, 0)')
    const cursor = query(m.container, '.lc-fit-cursor')
    assert.equal(cursor.style.left, '50%')

    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 3, selectedSeq: 1 })))
    const cursors = queryAll(m.container, '.lc-fit-cursor')
    assert.equal(cursors.length, 2)
    assert.match(cursors[0].className, /lc-fit-cursor/)
    assert.match(cursors[1].className, /lc-fit-pin/)
    assert.equal(cursors[1].style.left, '0%')

    await m.update(h(TrendOverview, propsOf(reqs, { hoveredSeq: 999, selectedSeq: 999 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    assert.equal(queryAll(m.container, '.lc-fit-cursor').length, 0)
    await m.unmount()
  })

  test('tip rows follow the granularity, mode, focus and duration state', async () => {
    const aggs = aggregateByTurn([req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })])
    const m1 = await mount(h(TrendOverview, propsOf(aggs, { granularity: 'turn', hoveredSeq: 2 })))
    assert.deepEqual(queryAll(query(m1.container, '.lc-chart-tip'), 'span').map(r => r.textContent), [
      kit.t('tip.turn', { t: 1, n: 2 }),
      kit.t('tip.total', { n: '300' }),
    ])
    await m1.update(h(TrendOverview, propsOf(aggs, { granularity: 'turn', hoveredSeq: 3 })))
    assert.equal(query(query(m1.container, '.lc-chart-tip'), 'span').textContent, kit.t('tip.turn1', { t: 2 }))
    await m1.unmount()

    const grew = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 })
    const m2 = await mount(h(TrendOverview, propsOf([req(1), grew], { mode: 'delta', hoveredSeq: 2 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '+300' })))
    await m2.update(h(TrendOverview, propsOf([grew, req(4)], { mode: 'delta', hoveredSeq: 4 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '-300' })))
    await m2.unmount()

    const m3 = await mount(h(TrendOverview, propsOf([req(1, { activeMs: 2000 }), grew], { durationCurve: true, hoveredSeq: 1 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.duration', { n: '2.0s' })))
    await m3.update(h(TrendOverview, propsOf([req(1), grew], { focusCat: 'tool', hoveredSeq: 1 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.cat', { cat: kit.catLabel('tool'), n: '60' })))
    await m3.unmount()

    const m4 = await mount(h(TrendOverview, propsOf([req(9, { turn: undefined, step: undefined })], { hoveredSeq: 9 })))
    assert.equal(query(query(m4.container, '.lc-chart-tip'), 'span').textContent, kit.t('tip.step', { t: 0, s: 0, n: 1 }))
    await m4.unmount()
  })
})

describe('TrendOverview turn strip', () => {
  const reqs = [1, 2, 3, 4, 5, 6].map(i => req(i, { turn: Math.ceil(i / 3), step: (i - 1) % 3 }))

  test('the active turn washes the plot outside its range and relays strip hover and clicks', async () => {
    const spies = { hoverTurn: [] as (number | null)[], pickTurn: [] as number[] }
    const handlers = {
      onHoverTurn: (t: number | null) => { spies.hoverTurn.push(t) },
      onPickTurn: (t: number) => { spies.pickTurn.push(t) },
    }
    const m = await mount(h(TrendOverview, propsOf(reqs, { activeTurn: 1, ...handlers })))
    assert.match(query(m.container, '.lc-chart-scroll').className, /lc-chart-dim/)
    const washes = queryAll(m.container, '.lc-fit-wash')
    assert.equal(washes.length, 2)
    assert.equal(washes[0].style.width, '0%')
    assert.equal(washes[1].style.width, '50%')
    assert.match(query(m.container, '.lc-turn').className, /lc-turn-on/)

    await m.update(h(TrendOverview, propsOf(reqs, { activeTurn: 2, ...handlers })))
    const washes2 = queryAll(m.container, '.lc-fit-wash')
    assert.equal(washes2[0].style.width, '50%')
    assert.equal(washes2[1].style.width, '0%')
    assert.match(queryAll(m.container, '.lc-turn')[1].className, /lc-turn-on/)

    await m.update(h(TrendOverview, propsOf(reqs, { activeTurn: 999, ...handlers })))
    assert.equal(queryAll(m.container, '.lc-fit-wash').length, 0)
    assert.equal(queryAll(m.container, '.lc-turn-on').length, 0)

    await hover(query(m.container, '.lc-turn'))
    assert.deepEqual(spies.hoverTurn, [1])
    await click(query(m.container, '.lc-turn'))
    assert.deepEqual(spies.pickTurn, [1])
    await unhover(query(m.container, '.lc-turns'))
    assert.deepEqual(spies.hoverTurn, [1, null])
    await m.unmount()
  })
})
