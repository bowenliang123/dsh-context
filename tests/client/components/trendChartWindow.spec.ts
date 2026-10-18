import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import {
  BAR_GAP, BAR_W, initialBarWindow, nextBarWindow, TREND_WINDOW_MIN, WINDOW_HYSTERESIS_BARS, WINDOW_OVERSCAN_BARS,
  windowPads, windowRangeFor,
} from '../../../src/client/components/trendChart'
import { flush, mount, query, queryAll, until } from '../helpers/kit'
import { TrendChart, bars, propsOf, req, scrollTo, viewport } from './trendChartHarness'
import type { LayoutEl } from './trendChartHarness'

const PITCH = BAR_W + BAR_GAP

describe('trend chart windowing', () => {
  test('keep small and empty histories whole', () => {
    assert.deepEqual(windowRangeFor(0, 400, 0), { from: 0, to: 0 })
    assert.deepEqual(windowRangeFor(3200, 400, 120), { from: 0, to: 119 })
    assert.deepEqual(nextBarWindow({ from: 0, to: 10 }, { from: 50, to: 60 }, 100), { from: 0, to: 99 })
    assert.deepEqual(windowPads(0, 119, 120), { left: 0, right: 0 })
    assert.deepEqual(initialBarWindow(120), { from: 0, to: 119 })
    assert.equal(initialBarWindow(1_000).to, 999)
    assert.ok(1_000 > TREND_WINDOW_MIN)
  })

  test('fill an overscanned range around the scroll position', () => {
    const n = 1_000
    const range = windowRangeFor(8000, 400, n)
    assert.equal(range.from, Math.max(0, Math.floor(8000 / PITCH) - WINDOW_OVERSCAN_BARS))
    assert.equal(range.to, Math.min(n - 1, Math.ceil(8400 / PITCH) + WINDOW_OVERSCAN_BARS))
    assert.ok(range.from > 0 && range.to < n - 1)
    // Near both edges the range clamps into the history.
    assert.equal(windowRangeFor(0, 400, n).from, 0)
    assert.equal(windowRangeFor(999_999, 400, n).to, n - 1)
  })

  test('keep a covering window and refill after leaving it', () => {
    const prev = { from: 100, to: 300 }
    assert.equal(nextBarWindow(prev, { from: 120, to: 280 }, 1_000), prev)
    const moved = nextBarWindow(prev, { from: 400, to: 500 }, 1_000)
    assert.deepEqual(moved, { from: 400 - WINDOW_HYSTERESIS_BARS, to: 500 + WINDOW_HYSTERESIS_BARS })
    const clamped = nextBarWindow({ from: 0, to: 100 }, { from: 900, to: 999 }, 1_000)
    assert.deepEqual(clamped, { from: 900 - WINDOW_HYSTERESIS_BARS, to: 999 })
  })

  test('padding reproduces the full column width exactly', () => {
    const n = 1_000
    for (const [from, to] of [[0, 0], [0, 799], [200, 799], [950, 999], [400, 500]] as const) {
      const pads = windowPads(from, to, n)
      const rendered = to - from + 1
      const items = rendered + (pads.left > 0 ? 1 : 0) + (pads.right > 0 ? 1 : 0)
      const width = rendered * BAR_W + pads.left + pads.right + Math.max(0, items - 1) * BAR_GAP
      assert.equal(width, n * PITCH - BAR_GAP, `columns ${from}..${to}`)
    }
  })

  test('DNA highlights are windowed with the same padding', async () => {
    const list = Array.from({ length: 400 }, (_, i) => req(i + 1))
    const dna = list.map(() => [{ key: 'sys', cat: 'system' as const, tokens: 10, off: 0, color: '#8b5cf6' }])
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(list, { dna })))
    try {
      const scroller = query<LayoutEl>(m.container, '.lc-chart-scroll')
      await scrollTo(scroller, 3_200)
      await until(() => queryAll(m.container, '.lc-bar-pad').length === 2, 'window lands mid-history with both pads')
      const dnaBar = query(m.container, '.lc-bar-dna')
      await act(async () => { dnaBar.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientY: 10 })) })
      await flush()
      const highlight = query(m.container, '.lc-dna-hl')
      assert.ok(highlight !== null)
      assert.equal(queryAll(highlight, '.lc-dna-cell').length, queryAll(m.container, '.lc-bar').length + 2)
    } finally {
      await m.unmount()
    }
  })

  test('a large history mounts on its newest bars and follows a scroll', async () => {
    const list = Array.from({ length: 400 }, (_, i) => req(i + 1))
    viewport.clientW = 400
    const m = await mount(h(TrendChart, propsOf(list)))
    try {
      const scroller = query<LayoutEl>(m.container, '.lc-chart-scroll')
      const chart = query(m.container, '.lc-chart')
      assert.equal(chart.getAttribute('data-lc-bars'), '400')
      const initial = bars(m.container)
      assert.ok(initial.length < list.length, 'a window, not all 400 bars')
      assert.ok(initial.length > 50, 'a window wide enough to scroll through')
      assert.equal(initial[initial.length - 1].getAttribute('data-seq'), String(list[list.length - 1].seq))
      assert.ok(scroller.__scrollL !== undefined && scroller.__scrollL > 0, 'anchored to the newest bars')
      assert.ok(query(m.container, '.lc-bar-pad') !== null, 'a pad keeps the full content width')

      await scrollTo(scroller, 0)
      await until(
        () => bars(m.container)[0]?.getAttribute('data-seq') === String(list[0].seq),
        'window follows the scroll to the oldest bars',
      )
      assert.equal(bars(m.container)[0].getAttribute('data-seq'), String(list[0].seq))
      // The full readout remains: axis, turn strip and hover model still see 400 columns.
      assert.equal(query(m.container, '.lc-turns').children.length, 1)
    } finally {
      await m.unmount()
      viewport.clientW = 400
    }
  })
})
