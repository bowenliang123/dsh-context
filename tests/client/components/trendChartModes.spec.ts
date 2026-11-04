import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { RISE_CAP, aggregateByTurn } from '../../../src/client/components/trendChart'
import { CATS } from '../../../src/client/categories'
import type { TrendBand } from '../../../src/client/dna'
import type { RequestRecord } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover } from '../helpers/kit'
import { CHART_H, TrendChart, assertColor, bars, kit, makeSpies, propsOf, req } from './trendChartHarness'

describe('TrendChart empty history', () => {
  test('renders the chart frame with no bars and no turn blocks; a zero-only history keeps the unit scale', async () => {
    const m = await mount(h(TrendChart, propsOf([])))
    assert.equal(bars(m.container).length, 0)
    assert.equal(queryAll(m.container, '.lc-turn').length, 0)
    assert.deepEqual(['top', 'q3', 'mid', 'q1', 'bot'].map(k => query(m.container, `.lc-axis-${k}`).textContent),
      ['1', '1', '1', '0', '0'])
    for (const grid of ['mid', 'q3', 'q1', 'zero']) assert.ok(query(m.container, `.lc-grid-${grid}`), `the ${grid} grid line renders`)
    await m.unmount()

    const zero = req(1, { turn: 1, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const zeroMount = await mount(h(TrendChart, propsOf([zero])))
    assert.equal(query(zeroMount.container, '.lc-axis-top').textContent, '1', 'maxTotal floors at 1')
    assert.equal(queryAll(bars(zeroMount.container)[0], '.lc-bar-stack > div').length, 0)
    await zeroMount.unmount()
  })
})

describe('TrendChart entrance rise cap', () => {
  test('a log longer than the cap rises only over its newest columns, while a short log cascades fully', async () => {
    const reqs: RequestRecord[] = []
    for (let i = 0; i < RISE_CAP + 10; i++) reqs.push(req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const stacks = queryAll(m.container, '.lc-bar-stack')
    assert.equal(stacks.length, RISE_CAP + 10)
    const risers = stacks.filter(s => s.className.includes('animate-lc-bar-in'))
    assert.equal(risers.length, RISE_CAP)
    assert.deepEqual(stacks.slice(0, 10).map(s => s.className.includes('animate-lc-bar-in')), new Array<boolean>(10).fill(false))
    assert.deepEqual(stacks.slice(10).map(s => s.className.includes('animate-lc-bar-in')), new Array<boolean>(RISE_CAP).fill(true))
    assert.equal(stacks[10].style.getPropertyValue('--lc-i'), '0')
    await m.unmount()

    const short = await mount(h(TrendChart, propsOf([req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })])))
    assert.deepEqual(queryAll(short.container, '.lc-bar-stack').map(s => s.className.includes('animate-lc-bar-in')), [true, true, true])
    await short.unmount()

    const dnaReqs: RequestRecord[] = []
    const bands: TrendBand[][] = []
    for (let i = 0; i < RISE_CAP + 5; i++) {
      const tokens = 100 + i
      dnaReqs.push(req(i + 1, { turn: 1, step: i, total: tokens }))
      bands.push([{ key: 'sys', cat: 'system', tokens, off: 0, color: '#123456' } as TrendBand])
    }
    const total = await mount(h(TrendChart, propsOf(dnaReqs, { dna: bands })))
    const totalDivs = queryAll(total.container, '.lc-bar-dna')
    assert.equal(totalDivs.length, RISE_CAP + 5)
    assert.equal(totalDivs.filter(d => d.className.includes('animate-lc-bar-in')).length, RISE_CAP)
    await total.unmount()
    const delta = await mount(h(TrendChart, propsOf(dnaReqs, { dna: bands, mode: 'delta' })))
    const deltaDivs = queryAll(delta.container, '.lc-bar-dna')
    assert.equal(deltaDivs.length, RISE_CAP + 4, 'the DNA and DNA+delta interiors obey the same cap')
    assert.equal(deltaDivs.filter(d => d.className.includes('animate-lc-bar-in')).length, RISE_CAP)
    await delta.unmount()
  })
})

describe('TrendChart step granularity, total mode', () => {
  test('stacks per-category segments in CATS order with real colors and proportional px heights, plotting raw fold figures', async () => {
    const r1 = req(1, { turn: 1, step: 0, skill: 40, total: 340 })
    const r2 = req(2, { turn: 1, step: 1, system: 200, tools: 100, user: 60, inject: 40, skill: 60, assistant: 80, tool: 120, total: 660 })
    const r3 = req(3, { turn: undefined, step: 0, user: 0, total: 280 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    const bs = bars(m.container)
    assert.equal(bs.length, 3)
    assert.deepEqual(bs.map(b => b.getAttribute('data-seq')), ['1', '2', '3'])

    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 7)
    for (let i = 0; i < CATS.length; i++) assertColor(segs1[i].style.background, CATS[i].color)
    assert.equal(segs1[0].style.height, `${Math.round(100 / 660 * CHART_H)}px`)
    assert.equal(segs1[4].style.height, `${Math.round(40 / 660 * CHART_H)}px`)
    assert.equal(segs1[6].style.height, `${Math.round(60 / 660 * CHART_H)}px`)
    const segs2 = queryAll(bs[1], '.lc-bar-stack > div')
    assert.equal(segs2[0].style.height, `${Math.round(200 / 660 * CHART_H)}px`)

    const segs3 = queryAll(bs[2], '.lc-bar-stack > div')
    assert.equal(segs3.length, 5)
    assert.ok(![...segs3].some(s => s.style.background.includes('var(--color-green-500)')))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '660')
    assert.equal(query(m.container, '.lc-axis-q3').textContent, '495')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '330')
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '165')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '0')

    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.equal(turns[0].style.width, '30px')
    assert.equal(turns[1].style.width, '14px')
    assert.ok(turns[0].style.background.includes('var(--color-neutral-500) 12%'))
    assert.ok(turns[1].style.background.includes('var(--color-neutral-500) 26%'))
    assert.deepEqual(turns.map(t => t.textContent), ['1', '0'])
    await m.unmount()

    const composition = { system: 200, tools: 100, user: 60, inject: 40, assistant: 80, tool: 120, total: 600 }
    const rawReqs = [
      req(1, { turn: 1, step: 0, ...composition }),
      req(2, { turn: 1, step: 1, ...composition, prompt: 1200 }),
      req(3, { turn: 2, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0, prompt: 500 }),
    ]
    const raw = await mount(h(TrendChart, propsOf(rawReqs)))
    assert.equal(query(raw.container, '.lc-axis-top').textContent, '1.2k', 'the axis reaches the provider prompt')
    const rawBars = bars(raw.container)
    assert.equal(rawBars.length, 3)
    const rawSegs1 = queryAll(rawBars[0]!, '.lc-bar-stack > div')
    const rawSegs2 = queryAll(rawBars[1]!, '.lc-bar-stack > div')
    assert.equal(rawSegs1.length, 6)
    assert.deepEqual(rawSegs2.map(s => s.style.height), rawSegs1.map(s => s.style.height), 'identical compositions plot identical heights regardless of the reported prompt')
    assert.equal(rawSegs1[0]!.style.height, `${Math.round(200 / 1200 * CHART_H)}px`, 'the bars keep the fold figures on the wider scale')
    assert.equal(queryAll(rawBars[2]!, '.lc-bar-stack > div').length, 0)
    await raw.unmount()
  })
})

describe('TrendChart delta mode', () => {
  const base = req(1, { turn: 1, step: 0 })
  const grown = req(2, { turn: 1, step: 1, system: 110, tools: 60, user: 40, inject: 30, assistant: 50, tool: 70, total: 360 })
  const shrunk = req(3, { turn: 2, step: 0, system: 90, tools: 40, user: 20, inject: 10, assistant: 30, tool: 50, total: 240 })

  test('diverging stacks pile positive deltas up and hang negatives down off a solid zero line, zeroing an absent arm', async () => {
    const m = await mount(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta' })))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '+60')
    assert.equal(queryAll(m.container, '.lc-axis-q3').length, 0)
    assert.equal(query(m.container, '.lc-axis-q1').textContent, '-75')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-mid').style.top, `${13 + 37}px`)
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-120')
    assert.equal(query(m.container, '.lc-grid-zero').style.top, `${18 + 37}px`)
    assert.equal(queryAll(m.container, '.lc-grid-q3').length, 0)
    assert.ok(query(m.container, '.lc-grid-q1'))

    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-bar-up > div').length, 0)
    assert.equal(queryAll(bs[0], '.lc-bar-down > div').length, 0)
    const up2 = queryAll(bs[1], '.lc-bar-up > div')
    assert.equal(up2.length, 6)
    assert.equal(up2[0].style.height, `${Math.round(10 * CHART_H / 180)}px`)
    assertColor(up2[0].style.background, CATS[0].color)
    assert.equal(queryAll(bs[1], '.lc-bar-down > div').length, 0)
    const down3 = queryAll(bs[2], '.lc-bar-down > div')
    assert.equal(down3.length, 6)
    assert.equal(down3[0].style.height, `${Math.round(20 * CHART_H / 180)}px`)
    assert.equal(queryAll(bs[2], '.lc-bar-up > div').length, 0)
    assert.equal(query(bs[1], '.lc-bar-up').style.bottom, '75px')
    assert.equal(query(bs[2], '.lc-bar-down').style.top, '37px')

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

    const zeroReq = req(9, { turn: 3, step: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0 })
    const baseReq = req(1, { turn: 1, step: 0 })
    const up = await mount(h(TrendChart, propsOf([zeroReq, baseReq], { mode: 'delta' })))
    assert.equal(query(up.container, '.lc-axis-top').textContent, '+300')
    assert.equal(query(up.container, '.lc-axis-q3').textContent, '+225')
    assert.equal(query(up.container, '.lc-axis-q1').textContent, '+75')
    assert.equal(query(up.container, '.lc-axis-bot').textContent, '0')
    assert.ok(query(up.container, '.lc-grid-q3'))
    assert.ok(query(up.container, '.lc-grid-q1'))
    const upSegs = queryAll(bars(up.container)[1]!, '.lc-bar-up > div')
    assert.equal(upSegs.length, 6)
    assert.equal(upSegs[0]!.style.height, `${Math.round(100 * CHART_H / 300)}px`)
    await up.unmount()
    const down = await mount(h(TrendChart, propsOf([baseReq, zeroReq], { mode: 'delta' })))
    assert.equal(query(down.container, '.lc-axis-top').textContent, '0')
    assert.equal(query(down.container, '.lc-axis-q3').textContent, '-75')
    assert.equal(query(down.container, '.lc-axis-q1').textContent, '-225')
    assert.equal(query(down.container, '.lc-axis-bot').textContent, '-300')
    assert.ok(query(down.container, '.lc-grid-q3'))
    assert.ok(query(down.container, '.lc-grid-q1'))
    assert.equal(queryAll(bars(down.container)[1]!, '.lc-bar-down > div').length, 6)
    await down.unmount()
  })

  test('a quarter mark landing on the zero label drops itself; the opposite mark keeps its place', async () => {
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

  test('turn aggregates render one bar per turn with aggregated labels and turn-count tooltips, and the strip drives the turn callbacks', async () => {
    const agg = aggregateByTurn([t1s0, t1s1, t2s0])
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn' })))
    const bs = bars(m.container)
    assert.equal(bs.length, 2)
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns.length, 2)
    assert.deepEqual(turns.map(t => t.style.width), ['14px', '14px'])
    assert.deepEqual(turns.map(t => t.textContent), ['1', '2'])

    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t1s1.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 1, n: 2 })))
    await m.update(h(TrendChart, propsOf(agg, { granularity: 'turn', hoveredSeq: t2s0.seq })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 2 })))
    await m.unmount()

    const turnless = aggregateByTurn([req(10, { turn: undefined }), req(11, { turn: undefined })])
    const m2 = await mount(h(TrendChart, propsOf(turnless, { granularity: 'turn', hoveredSeq: 11 })))
    assert.ok(query(m2.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn', { t: 0, n: 2 })))
    await m2.unmount()

    const m3 = await mount(h(TrendChart, propsOf([req(20, { turn: undefined, step: 3 })], { granularity: 'turn', hoveredSeq: 20 })))
    assert.ok(query(m3.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.turn1', { t: 0 })))
    await m3.unmount()

    const { spies, handlers } = makeSpies()
    const stripAgg = aggregateByTurn([t1s0, t1s1, t2s0])
    const strip = await mount(h(TrendChart, propsOf(stripAgg, { ...handlers, granularity: 'turn' })))
    const stripBlocks = queryAll(strip.container, '.lc-turn')
    await hover(stripBlocks[0]!)
    assert.deepEqual(spies.hoverTurn, [1])
    await click(stripBlocks[1]!)
    assert.deepEqual(spies.pickTurn, [2])
    await unhover(stripBlocks[0]!)
    assert.deepEqual(spies.hoverTurn, [1, null])
    await strip.update(h(TrendChart, propsOf(stripAgg, { ...handlers, granularity: 'turn', activeTurn: 1 })))
    assert.ok(query(strip.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    const stripBars = bars(strip.container)
    assert.ok(stripBars[0]!.className.includes('lc-bar-in-turn'))
    assert.ok(!stripBars[1]!.className.includes('lc-bar-in-turn'))
    assert.ok(queryAll(strip.container, '.lc-turn')[0]!.className.includes('lc-turn-on'))
    assert.ok(!queryAll(strip.container, '.lc-turn')[1]!.className.includes('lc-turn-on'))
    await strip.update(h(TrendChart, propsOf(stripAgg, { ...handlers, granularity: 'turn', activeTurn: null })))
    assert.ok(!query(strip.container, '.lc-chart-scroll').className.includes('lc-chart-dim'))
    assert.ok(!bars(strip.container)[0]!.className.includes('lc-bar-in-turn'))
    await strip.unmount()
  })
})

describe('TrendChart step flags', () => {
  test('every 5th step bar plants a flag labeled with its cumulative step number', async () => {
    const reqs = Array.from({ length: 12 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const m = await mount(h(TrendChart, propsOf(reqs)))
    const flags = queryAll(m.container, '.lc-trend-flag')
    assert.equal(flags.length, 2)
    assert.deepEqual(flags.map(f => f.textContent), ['5', '10'])
    const bs = bars(m.container)
    assert.equal(queryAll(bs[0], '.lc-trend-flag').length, 0)
    assert.ok(query(bs[4], '.lc-trend-flag'))
    assert.ok(query(bs[9], '.lc-trend-flag'))
    await m.unmount()

    const deltaReqs = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: 1, step: i }))
    const delta = await mount(h(TrendChart, propsOf(deltaReqs, { mode: 'delta' })))
    assert.deepEqual(queryAll(delta.container, '.lc-trend-flag').map(f => f.textContent), ['5'], 'delta mode keeps the flags')
    await delta.unmount()

    const turns = Array.from({ length: 6 }, (_, i) => req(i + 1, { turn: i + 1, step: 0 }))
    const turnMount = await mount(h(TrendChart, propsOf(aggregateByTurn(turns), { granularity: 'turn' })))
    assert.equal(queryAll(turnMount.container, '.lc-trend-flag').length, 0, 'the turn strip numbers that grid')
    await turnMount.unmount()
  })
})
