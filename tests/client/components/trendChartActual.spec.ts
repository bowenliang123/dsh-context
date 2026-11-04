import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { mount, query, queryAll } from '../helpers/kit'
import { BAR_GAP, BAR_W } from '../../../src/client/components/trendWindow'
import { CHART_H, TrendChart, bars, kit, propsOf, req } from './trendChartHarness'

const BAR_PITCH = BAR_W + BAR_GAP
const BAR_X = BAR_W / 2

describe('TrendChart provider-reported series', () => {
  test('the axis covers the provider prompt while the bars keep the fold figures', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400, prompt: 800 })
    const r2 = req(2, { turn: 1, step: 1, total: 420, prompt: 840 })
    const m = await mount(h(TrendChart, propsOf([r1, r2])))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '840', 'the scale reaches the provider prompt')
    const segs = queryAll(bars(m.container)[0], '.lc-bar-stack > div')
    assert.equal(segs[0].style.height, `${Math.round(100 / 840 * CHART_H)}px`, 'the bar keeps the fold ratio')
    await m.unmount()
  })

  test('the provider prompt rides the plot as a line', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400, prompt: 800 })
    const r2 = req(2, { turn: 1, step: 1, total: 420, prompt: 840 })
    const m = await mount(h(TrendChart, propsOf([r1, r2])))

    const line = query(m.container, '.lc-actual .lc-actual-line')
    assert.equal(line.getAttribute('points'), `${BAR_X},${Math.round((CHART_H - 800 / 840 * CHART_H) * 100) / 100} ${BAR_X + BAR_PITCH},0`)
    await m.unmount()
  })

  test('the hover tip names the provider actual beside the estimate', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400, prompt: 800 })
    const m = await mount(h(TrendChart, propsOf([r1], { hoveredSeq: 1 })))

    assert.deepEqual(
      queryAll(query(m.container, '.lc-chart-tip'), 'span').map(r => r.textContent),
      [kit.t('tip.step', { t: 1, s: 0, n: 1 }), kit.t('tip.total', { n: kit.fmt(400) }), kit.t('tip.actual', { n: kit.fmt(800) })],
    )
    await m.unmount()
  })

  test('a session without usage draws no line and keeps the fold scale', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400 })
    const r2 = req(2, { turn: 1, step: 1, total: 420 })
    const m = await mount(h(TrendChart, propsOf([r1, r2])))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '420')
    assert.equal(queryAll(m.container, '.lc-actual').length, 0)
    await m.unmount()
  })

  test('the focused view keeps its own scale and the delta view its diverging axis', async () => {
    const r1 = req(1, { turn: 1, step: 0, tool: 60, total: 400, prompt: 800 })
    const r2 = req(2, { turn: 1, step: 1, tool: 120, total: 420, prompt: 840 })
    const focused = await mount(h(TrendChart, propsOf([r1, r2], { focusCat: 'tool' })))
    assert.equal(query(focused.container, '.lc-axis-top').textContent, '120', 'the focus scales on its own category')
    assert.equal(queryAll(focused.container, '.lc-actual').length, 0, 'the focus draws no provider line')
    await focused.unmount()

    const delta = await mount(h(TrendChart, propsOf([r1, r2], { mode: 'delta' })))
    assert.equal(queryAll(delta.container, '.lc-actual').length, 0, 'the delta axis stays diverging')
    await delta.unmount()
  })

  test('a step without usage breaks the line', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400, prompt: 800 })
    const r2 = req(2, { turn: 1, step: 1, total: 420 })
    const r3 = req(3, { turn: 1, step: 2, total: 440, prompt: 880 })
    const m = await mount(h(TrendChart, propsOf([r1, r2, r3])))

    assert.equal(queryAll(m.container, '.lc-actual .lc-actual-line').length, 0, 'a lone point is a dot')
    assert.equal(queryAll(m.container, '.lc-actual .lc-actual-dot').length, 2)
    await m.unmount()
  })

  test('the adaptive scale follows the visible window, provider prompt included', async () => {
    const r1 = req(1, { turn: 1, step: 0, total: 400, prompt: 800 })
    const m = await mount(h(TrendChart, propsOf([r1], { adaptive: true })))

    assert.equal(query(m.container, '.lc-axis-top').textContent, '800')
    await m.unmount()
  })
})
