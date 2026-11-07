import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { CATS } from '../../../src/client/categories'
import type { ContextEventRecord } from '../../../src/shared/types'
import { click, hover, mount, query, queryAll, unhover } from '../helpers/kit'
import { CHART_H, TrendChart, assertColor, bars, kit, makeSpies, propsOf, req } from './trendChartHarness'

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

    await m.update(h(TrendChart, propsOf([r1, r2, r3])))
    const chart = query(m.container, '.lc-chart')
    assert.equal(chart.hasAttribute('data-catdim'), false)

    const segs = queryAll(chart, '.lc-bar[data-seq="1"] .lc-bar-stack > .lc-cat-seg')
    assert.deepEqual(segs.map(s => s.getAttribute('data-cat')), CATS.map(c => c.key))

    await m.update(h(TrendChart, propsOf([r1, r2, r3], { hoverCat: 'tools' })))
    assert.equal(query(m.container, '.lc-chart').getAttribute('data-catdim'), 'tools')

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
    assert.equal(query(m.container, '.lc-axis-top').textContent, '120')
    const bs = bars(m.container)
    const segs1 = queryAll(bs[0], '.lc-bar-stack > div')
    assert.equal(segs1.length, 1)
    assert.equal(segs1[0].getAttribute('data-cat'), 'tool')
    assertColor(segs1[0].style.background, CATS[6].color)
    assert.equal(segs1[0].style.height, `${Math.round(60 / 120 * CHART_H)}px`)
    assert.equal(queryAll(bs[1], '.lc-bar-stack > div')[0].style.height, `${CHART_H}px`)

    await m.update(h(TrendChart, propsOf([r1, r2], { focusCat: 'tool', hoveredSeq: 1 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 0, n: 2 }), kit.t('tip.cat', { cat: kit.catLabel('tool'), n: '60' })],
    )
    await m.unmount()

    for (const focusCat of ['nope', null]) {
      const degraded = await mount(h(TrendChart, propsOf([r1, r2], { focusCat })))
      assert.equal(queryAll(bars(degraded.container)[0], '.lc-bar-stack > div').length, 6, 'an unknown key or explicit null degrades to the unfocused chart')
      assert.equal(query(degraded.container, '.lc-axis-top').textContent, '600')
      await degraded.unmount()
    }
  })

  test('the focused figure is the raw fold value; a category at zero everywhere keeps the unit axis', async () => {
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

    await m.update(h(TrendChart, propsOf([base, grown, shrunk], { mode: 'delta', focusCat: 'system', hoveredSeq: 2 })))
    assert.ok(query(m.container, '.lc-chart-tip').textContent!.includes(kit.t('tip.delta', { n: '+30' })))
    await m.unmount()
  })

})

describe('TrendChart markers', () => {
  test('compaction/prune markers render the ✂ glyph with a positioned or bare title', async () => {
    const reqs = [req(1, { turn: 1, step: 0 }), req(2, { turn: 1, step: 1 }), req(3, { turn: 2, step: 0 })]
    const compaction: ContextEventRecord = { seq: 2, time: 1700000000000, kind: 'compaction', count: 5, fromTurn: 1, fromStep: 0, turn: 1, step: 1 }
    const prune: ContextEventRecord = { seq: 3, time: 1700000060000, kind: 'prune' }
    const markers = [undefined, compaction, prune]

    const m = await mount(h(TrendChart, propsOf(reqs, { markers })))
    const glyph = queryAll(m.container, '.lc-bar-marker')
    assert.equal(glyph.length, 2)
    assert.equal(glyph[0].textContent, '✂')
    assert.equal(
      glyph[0].getAttribute('title'),
      '✂ ' + kit.t('events.range', { t: 1, a: 0, b: 1 }) + ' — ' + kit.t('ev.compaction', { n: 5 }),
    )
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
      [kit.t('tip.step', { t: 1, s: 0, n: 1 }), kit.t('tip.total', { n: '300' })],
    )
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(7px, 0)')

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 4 })))
    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 0, s: 0, n: 1 }), kit.t('tip.total', { n: '300' })],
    )

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 999 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: 1 })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    await unhover(query(m.container, '.lc-chart'))
    assert.deepEqual(spies.hover, [1, null])
    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, hoveredSeq: null })))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    await m.unmount()
  })
})

describe('TrendChart keyboard picks', () => {
  test('a focused bar selects on Enter and Space only, and turn chips pick their turn number', async () => {
    const { spies, handlers } = makeSpies()
    const first = req(1, { turn: 1, step: 0 })
    const second = req(2, { turn: 2, step: 0 })
    const m = await mount(h(TrendChart, propsOf([first, second], handlers)))
    const [bar, other] = bars(m.container)
    assert.equal(bar.getAttribute('role'), 'button')
    assert.equal(bar.getAttribute('aria-pressed'), 'false')
    await act(async () => { bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })) })
    assert.deepEqual(spies.select, [])
    await act(async () => { bar.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    assert.deepEqual(spies.select, [1])
    await act(async () => { other.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    assert.deepEqual(spies.select, [1, 2])
    await m.update(h(TrendChart, propsOf([first, second], { ...handlers, selectedSeq: 1 })))
    const picked = bars(m.container)[0]
    assert.equal(picked.getAttribute('aria-pressed'), 'true')
    await act(async () => { picked.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    assert.deepEqual(spies.select, [1, 2, null])
    const turns = queryAll(m.container, '.lc-turn')
    assert.equal(turns[1].getAttribute('role'), 'button')
    await act(async () => { turns[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    assert.deepEqual(spies.pickTurn, [])
    await act(async () => { turns[1].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    assert.deepEqual(spies.pickTurn, [2])
    await m.unmount()
  })
})
