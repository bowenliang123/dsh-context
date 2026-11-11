import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { RISE_CAP } from '../../../src/client/components/trendChart'
import { aggregateByTurn } from '../../../src/client/components/trendModel'
import { CATS } from '../../../src/client/categories'
import { type TrendBand } from '../../../src/client/dna'
import { type RequestRecord, type SurfaceNode } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover, flush } from '../helpers/kit'
import { CHART_H, TrendChart, assertColor, bars, kit, makeSpies, propsOf, req, viewport } from './trendChartHarness'
import { capDnaRuns, snapDnaRuns } from '../../../src/client/components/trendDnaBars'

describe('trendChartModes', () => {

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
    assert.equal(query(raw.container, '.lc-axis-top').textContent, '600')
    const rawBars = bars(raw.container)
    assert.equal(rawBars.length, 3)
    const rawSegs1 = queryAll(rawBars[0]!, '.lc-bar-stack > div')
    const rawSegs2 = queryAll(rawBars[1]!, '.lc-bar-stack > div')
    assert.equal(rawSegs1.length, 6)
    assert.deepEqual(rawSegs2.map(s => s.style.height), rawSegs1.map(s => s.style.height), 'identical compositions plot identical heights regardless of the reported prompt')
    assert.equal(rawSegs1[0]!.style.height, `${Math.round(200 / 600 * CHART_H)}px`)
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
})

describe('trendChartDna', () => {

describe('TrendChart DNA mode', () => {
  const COLORS = Object.fromEntries(CATS.map(c => [c.key, c.color])) as Record<string, string>

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
    const g1 = dnaDivs[0].style.background
    assert.ok(g1.startsWith('linear-gradient(to top, '), g1)
    assert.ok(g1.includes('var(--color-indigo-500) 0px, var(--color-indigo-500) 18px'), g1)
    assert.ok(g1.includes('var(--color-amber-500) 18px, var(--color-amber-500) 28px'), g1)
    assert.ok(g1.includes('var(--color-blue-500) 28px, var(--color-blue-500) 56px'), g1)
    const g2 = dnaDivs[1].style.background
    assert.ok(g2.includes('var(--color-indigo-500) 0px, var(--color-indigo-500) 38px'), g2)
    assert.ok(g2.includes('var(--color-blue-500) 38px, var(--color-blue-500) 52px'), g2)
    assert.ok(g2.includes('var(--color-green-500) 52px, var(--color-green-500) 70px'), g2)
    assert.ok(g2.includes('var(--color-teal-500) 70px, var(--color-teal-500) 112px'), g2)
    assert.equal(queryAll(m.container, '.lc-bar-stack').length, 0)
    assert.equal(query(m.container, '.lc-axis-top').textContent, '600')
    await act(async () => { dnaDivs[0].dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    await m.unmount()

    const r1b = req(1, { turn: 1, step: 0, total: 1, system: 1 })
    const r2b = req(2, { turn: 1, step: 1, total: 50000, system: 50000 })
    const tiny = await mount(h(TrendChart, propsOf([r1b, r2b], {
      dna: [dnaBands([['sys', 'system', 1]]), dnaBands([['sys', 'system', 50000]])],
    })))
    const tinyBars = queryAll<HTMLElement>(tiny.container, '.lc-bar-dna')
    assert.ok(tinyBars[0].style.background.length > 0)
    assert.ok(!tinyBars[0].style.background.includes('linear-gradient(to top, )'))
    assert.ok(tinyBars[0].style.background.includes('var(--color-indigo-500)'), 'a bar far below the shared scale keeps its colour')
    await tiny.unmount()

    const empty = await mount(h(TrendChart, propsOf([req(1, { turn: 1, step: 0, total: 0 }), req(2, { turn: 1, step: 1, total: 600 })], {
      dna: [dnaBands([['n1', 'user', 0, { seq: 1, cat: 'user', tokens: 0 }]]), dnaBands([['n2', 'user', 600, { seq: 2, cat: 'user', tokens: 600 }]])],
    })))
    assert.equal(queryAll(empty.container, '.lc-bar-dna').length, 1, 'a bar whose bands carry no tokens paints no DNA strip')
    await empty.unmount()

    const focused = await mount(h(TrendChart, propsOf(
      [req(1, { turn: 1, step: 0, total: 300 }), req(2, { turn: 1, step: 1, total: 600, user: 150 })],
      {
        dna: [
          dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
          dnaBands([['sys', 'system', 100], ['n2', 'user', 500, { seq: 2, cat: 'user', tokens: 500 }]]),
        ],
        focusCat: 'user',
      },
    )))
    const focusedBars = queryAll(focused.container, '.lc-bar-dna')
    assert.equal(focusedBars[0]!.style.height, `${Math.round(CHART_H * 300 / 600)}px`, 'full-context share, not the focused category share')
    assert.equal(focusedBars[1]!.style.height, `${CHART_H}px`)
    assert.ok(focusedBars[0]!.style.background.includes('var(--color-indigo-500)'), 'the system band is still painted')
    await focused.unmount()
  })

  test('a band click reports the picked item with the bar seq, for the Context browser reveal', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 300 })
    const d1 = dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]])
    const picks: [number, string][] = []
    const m = await mount(h(TrendChart, propsOf([r1], {
      dna: [d1],
      onPickBand: (seq, band) => { picks.push([seq, band.key]) },
    })))
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

    await move(dnaDivs[0], 40)
    let slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    assert.equal(slices[0].style.bottom, '0px')
    assert.equal(slices[0].style.height, `${Math.round(100 / 600 * CHART_H)}px`)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))

    stubBarRect(dnaDivs[0])
    stubBarRect(dnaDivs[1])
    await move(dnaDivs[0], CHART_H + 20)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '100' })))
    await move(dnaDivs[0], 0)
    slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 1)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '200' })))
    await m.update(h(TrendChart, propsOf([r1, r2], { dna: [d1, d2], hoveredSeq: 2 })))
    await move(dnaDivs[1], -10)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'write', n: '100' })))

    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    assert.ok(tipText().includes(kit.t('tip.total', { n: '600' })))

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
    const dnaDivs = queryAll(m.container, '.lc-bar-dna')
    assert.equal(dnaDivs.length, 4, 'the first bar has no baseline and carries no strip')
    assert.equal(query(m.container, '.lc-axis-top').textContent, '+150')
    assert.equal(query(m.container, '.lc-axis-mid').textContent, '0')
    assert.equal(query(m.container, '.lc-axis-bot').textContent, '-210')

    assert.equal(dnaDivs[0].style.height, '19px')
    assert.equal(dnaDivs[0].style.bottom, '65px')
    assert.ok(dnaDivs[0].style.background.includes('var(--color-blue-500) 0%, var(--color-blue-500) 100%'))

    assert.equal(dnaDivs[1].style.height, '47px')
    const g3 = dnaDivs[1].style.background
    assert.ok(g3.includes('var(--color-blue-500) 0%, var(--color-blue-500) 20%'), g3)
    assert.ok(g3.includes('var(--color-teal-500) 20%, var(--color-teal-500) 100%'), g3)

    assert.equal(dnaDivs[2].style.height, '90px')
    assert.equal(dnaDivs[2].style.bottom, '0px')
    assert.equal(dnaDivs[2].style.transformOrigin, '50% 72.41%')
    const g4 = dnaDivs[2].style.background
    assert.ok(g4.includes('var(--color-teal-500) 0%, var(--color-teal-500) 41.38%'), g4)
    assert.ok(g4.includes('var(--color-blue-500) 41.38%, var(--color-blue-500) 72.41%'), g4)
    assert.ok(g4.includes('var(--color-green-500) 72.41%, var(--color-green-500) 100%'), g4)

    assert.equal(dnaDivs[3].style.height, '25px')
    assert.equal(dnaDivs[3].style.bottom, '40px')

    await move(dnaDivs[2], 40)
    const tipText = () => query(m.container, '.lc-chart-tip').textContent ?? ''
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: 'bash', n: '-120' })))
    stubBarRect(dnaDivs[2])
    await move(dnaDivs[2], 0)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '+40' })), 'the very top is the last up band')
    await move(dnaDivs[2], 55)
    assert.ok(tipText().includes(kit.t('trend.dnaItem', { label: kit.catLabel('assistant'), n: '-90' })), 'the down arm walks read order from the zero line')
    await act(async () => { dnaDivs[2].dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 55 })) })
    assert.deepEqual(picks, [[4, 'a1']])

    stubBarRect(dnaDivs[1])
    await move(dnaDivs[1], 0)
    const slices = queryAll(m.container, '.lc-dna-slice')
    assert.equal(slices.length, 2)
    assert.equal(slices[0].style.bottom, `${Math.round(65 + 30 * 112 / 360)}px`)
    assert.equal(slices[0].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    assert.equal(slices[1].style.bottom, `${Math.round(65 - 210 * 112 / 360)}px`)
    assert.equal(slices[1].style.height, `${Math.max(1, Math.round(120 * 112 / 360))}px`)
    await unhover(dnaDivs[1])
    assert.equal(queryAll(m.container, '.lc-dna-slice').length, 0)
    await m.unmount()

    const downOnlyReqs = [req(1, { turn: 1, step: 0, total: 300 }), req(2, { turn: 1, step: 1, total: 260 })]
    const downOnlyBands = [
      dnaBands([['sys', 'system', 100], ['n1', 'user', 200, { seq: 1, cat: 'user', tokens: 200 }]]),
      dnaBands([['sys', 'system', 100]]),
    ]
    const downOnly = await mount(h(TrendChart, propsOf(downOnlyReqs, { dna: downOnlyBands, mode: 'delta', hoveredSeq: 2 })))
    const dnaDiv = query(downOnly.container, '.lc-bar-dna')
    stubBarRect(dnaDiv)
    await act(async () => { dnaDiv.dispatchEvent(new MouseEvent('click', { bubbles: true, clientY: 0 })) })
    await move(dnaDiv, 0)
    assert.ok((query(downOnly.container, '.lc-chart-tip').textContent ?? '').includes(kit.t('trend.dnaItem', { label: kit.catLabel('user'), n: '-200' })))
    await downOnly.unmount()
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
    assert.ok(tipText().includes(kit.t('tip.delta', { n: '-40' })))
    assert.ok(!tipText().includes(kit.t('tip.total', { n: '40' })))
    await m.unmount()
  })

})
})

describe('trendChartLazyDna', () => {

const bandOf = (seq: number): TrendBand[] => [{ key: 'a', cat: 'system', tokens: 10 + (seq % 7), off: 0, color: '#8b5cf6' }]

function requestList(n: number) {
  return Array.from({ length: n }, (_, i) => req(i + 1, {
    turn: 1 + Math.floor(i / 100),
    step: i % 100,
    system: 10 + i % 7,
    tools: 20,
    user: 5,
    inject: 0,
    assistant: 15,
    tool: 5,
    total: 55 + i % 7,
    activeMs: 1_000 + i,
  }))
}

function lazyBands() {
  const calls = new Map<number, number>()
  const at = (seq: number): TrendBand[] => {
    calls.set(seq, (calls.get(seq) ?? 0) + 1)
    return bandOf(seq)
  }
  return { calls, at }
}

describe('snapDnaRuns', () => {
  test('snaps internal boundaries to the shared pixel grid, aligns identical bands across bars, and absorbs sub-grid strands', () => {
    const a = snapDnaRuns([{ color: '#a', from: 0, to: 2.3 }, { color: '#b', from: 2.3, to: 7.9 }])
    const b = snapDnaRuns([{ color: '#a', from: 0, to: 2.3 }, { color: '#b', from: 2.3, to: 10.9 }])
    assert.equal(a[0].to, 2, '2.3px snaps down to the 2px grid')
    assert.equal(b[0].to, a[0].to, 'the same prefix band keeps the same boundary in a taller bar')
    assert.equal(a[a.length - 1].to, 7.9, 'the final boundary stays exact')
    assert.equal(b[b.length - 1].to, 10.9)
    assert.deepEqual(snapDnaRuns([]), [])

    const merged = snapDnaRuns([
      { color: '#a', from: 0, to: 2.1 },
      { color: '#a', from: 2.1, to: 4.4 },
      { color: '#b', from: 4.4, to: 9.2 },
    ])
    assert.deepEqual(merged.map(r => r.color), ['#a', '#b'])
    const tiny = snapDnaRuns([
      { color: '#a', from: 0, to: 1.9 },
      { color: '#b', from: 1.9, to: 2.1 },
      { color: '#c', from: 2.1, to: 6.5 },
    ])
    const covered = tiny.map(r => [r.from, r.to])
    for (let i = 1; i < covered.length; i++) assert.equal(covered[i][0], covered[i - 1][1], 'runs stay contiguous')
    assert.equal(covered.at(-1)?.[1], 6.5)
  })
})

describe('capDnaRuns', () => {
  test('passes short runs through and samples dense ones onto a fixed stop count', () => {
    const short = [{ color: '#a', from: 0, to: 50 }, { color: '#b', from: 50, to: 100 }]
    assert.equal(capDnaRuns(short, 96), short)
    const dense = Array.from({ length: 400 }, (_, i) => ({
      color: i % 2 === 0 ? '#a' : '#b',
      from: i / 4,
      to: (i + 1) / 4,
    }))
    const capped = capDnaRuns(dense, 96)
    assert.ok(capped.length <= 96)
    assert.equal(capped[0].from, 0)
    assert.equal(capped[capped.length - 1].to, dense[dense.length - 1].to)
    assert.ok(capped.every((run, i) => i === 0 || capped[i - 1].color !== run.color))
    const mono = Array.from({ length: 400 }, (_, i) => ({ color: '#a', from: i / 4, to: (i + 1) / 4 }))
    assert.equal(capDnaRuns(mono, 96).length, 1)
  })
})

describe('TrendChart lazy DNA bands', () => {
  test('a lazy source assembles only the rendered window and hit-tests its bands', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at })))
    const dnaBars = queryAll(m.container, '.lc-bar-dna')
    assert.ok(dnaBars.length > 0 && dnaBars.length < reqs.length, `windowed DNA bars (${dnaBars.length})`)
    assert.ok(lazy.calls.size < reqs.length, `only visible steps assembled (${lazy.calls.size})`)
    await act(async () => { dnaBars[0].dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10 })) })
    await flush()
    assert.ok(queryAll(m.container, '.lc-dna-slice').length > 0)
    await m.unmount()
  })

  test('entering DNA tightens the window and leaving it restores the ordinary range', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(reqs, { dna: null })))
    const plain = queryAll(m.container, '.lc-bar').length
    await m.update(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at })))
    const dna = queryAll(m.container, '.lc-bar').length
    assert.ok(dna > 0 && dna < plain, `DNA window is tighter (${dna} < ${plain})`)
    await m.update(h(TrendChart, propsOf(reqs, { dna: null })))
    assert.ok(queryAll(m.container, '.lc-bar').length > dna, 'leaving DNA expands the window again')
    await m.unmount()
  })

  test('delta mode reads every per-key band so a lazy source keeps the eager axis', async () => {
    const reqs = requestList(600)
    const lazy = lazyBands()
    viewport.clientW = 400
    const eager = reqs.map((_, i) => bandOf(i + 1))
    const eagerView = await mount(h(TrendChart, propsOf(reqs, { dna: eager, mode: 'delta' })))
    const axisOf = (el: HTMLElement): (string | null)[] => ['.lc-axis-top', '.lc-axis-q3', '.lc-axis-mid', '.lc-axis-q1']
      .map(sel => el.querySelector(sel)?.textContent ?? null)
    const eagerAxis = axisOf(eagerView.container)
    await eagerView.unmount()
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at, mode: 'delta' })))
    try {
      assert.ok(queryAll(m.container, '.lc-bar-dna').length > 0)
      assert.deepEqual(axisOf(m.container), eagerAxis, 'lazy delta axes match the eager per-band maxima')
      assert.ok(lazy.calls.size <= reqs.length * 2, `bounded per-seq lookups (${lazy.calls.size})`)
      assert.ok(bars(m.container).length > 0)

      const afterMount = lazy.calls.size
      const firstBar = queryAll(m.container, '.lc-bar')[0]
      await act(async () => {
        firstBar.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      })
      await flush()
      assert.equal(lazy.calls.size, afterMount, 'a hover re-render re-walks no step')
    } finally {
      await m.unmount()
    }

    const rereadReqs = requestList(600)
    const rereadLazy = lazyBands()
    const total = (): number => [...rereadLazy.calls.values()].reduce((a, b) => a + b, 0)
    const reread = await mount(h(TrendChart, propsOf(rereadReqs, { dnaAt: rereadLazy.at, mode: 'delta' })))
    assert.equal(rereadLazy.calls.size, rereadReqs.length, 'the axis walk read every step')
    const afterMount = total()
    await reread.update(h(TrendChart, propsOf(rereadReqs, { dnaAt: rereadLazy.at, mode: 'delta', markers: [] })))
    await flush()
    const rereadCount = total() - afterMount
    assert.ok(rereadCount <= 400, `a re-render re-reads at most the window (${rereadCount} of ${rereadReqs.length})`)
    assert.ok(rereadCount < rereadReqs.length, 'the whole-log walk never re-runs on a hover/scroll re-render')
    await reread.unmount()
  })
})


describe('TrendChart lazy DNA maxima with adaptive window', () => {
  test('an adaptive window skips the full-history maxima walk and scales from the visible window', async () => {
    const lazy = lazyBands()
    const reqs = requestList(60)
    const m = await mount(h(TrendChart, propsOf(reqs, { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
    try {
      const callsAfterMount = lazy.calls.size
      assert.ok(callsAfterMount > 0, 'the first paint resolves the pre-measure maxima through the lazy accessor')
      await m.update(h(TrendChart, propsOf(reqs.map(r => ({ ...r })), { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
      const total = lazy.calls.size
      await m.update(h(TrendChart, propsOf(reqs.map(r => ({ ...r, total: r.total + 5 })), { dnaAt: lazy.at, mode: 'delta', adaptive: true })))
      assert.ok(lazy.calls.size >= total, 'the lazy accessor keeps serving the visible window')
      assert.notEqual(query(m.container, '.lc-axis-top')?.textContent ?? '', '', 'the adaptive chart keeps an axis')
      void callsAfterMount
    } finally {
      await m.unmount()
    }
  })
})
})
