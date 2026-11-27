import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { describe, test } from 'vitest'
import { makeTimelineOverview } from '../../../src/client/components/timelineOverview'
import { wheelZoomFactor } from '../../../src/client/components/timelineZoom'
import { flush, mount, query, queryAll, wheel, type Mounted } from '../helpers/kit'
import { kit, req, viewport } from './timelineChartHarness'
import { probeScroll, propsOf, steps, wheelAt } from './timelineOverviewHarness'

const TimelineOverview = makeTimelineOverview(kit)

async function clickChip(m: Mounted): Promise<void> {
  await act(async () => { query<HTMLElement>(m.container, '.lc-zoom-chip').click() })
  await flush()
}

const TOTAL = 50
const PANE = 400
const ONE_NOTCH = wheelZoomFactor(-300, 0, PANE)

describe('TimelineOverview wheel zoom', () => {

describe('zoom gesture and fit chip', () => {
  test('the wheel magnifies around the pointer, caps at the readable pitch, and the chip fits it back', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    const wrap = query(m.container, '.lc-chart-wrap')
    const scroller = query<HTMLElement>(m.container, '.lc-chart-scroll')
    const probe = probeScroll(scroller, PANE)
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    assert.equal(query(m.container, '.lc-chart').style.width, '')

    assert.equal(await wheelAt(wrap, 0, 120, { clientX: 300 }), true, 'a wheel-out at fit still belongs to the chart')
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)

    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 300 }), true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
    assert.equal(query(m.container, '.lc-chart').style.width, '156.8%')
    assert.equal(query(m.container, '.lc-turns').style.width, '156.8%')
    const content = ONE_NOTCH * PANE
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * content - 300)) < 0.01, String(probe.scrollLeft))

    assert.equal(await wheelAt(wrap, 0, -3000, { clientX: 300 }), true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2.9')
    assert.equal(query(m.container, '.lc-chart').style.width, '294%')
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * 2.94 * PANE - 300)) < 0.01)

    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 300 }), true, 'a further notch is swallowed at the cap')
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2.9')
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * 2.94 * PANE - 300)) < 0.01)

    await clickChip(m)
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    assert.equal(query(m.container, '.lc-chart').style.width, '')
    assert.equal(probe.scrollLeft, 0)
    await m.unmount()
  })

  test('the pointer record stays put across notches at different horizontal positions', async () => {
    for (const vx of [50, 200, 380]) {
      const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
      const wrap = query(m.container, '.lc-chart-wrap')
      const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
      await wheelAt(wrap, 0, -300, { clientX: vx })
      await wheelAt(wrap, 0, -200, { clientX: vx })
      assert.equal(query<HTMLElement>(m.container, '.lc-chart').style.width, '211.7%')
      const content = Math.exp(0.75) * PANE
      assert.ok(Math.abs((probe.scrollLeft + vx) / content - vx / PANE) < 1e-9, `cursor ${vx} drifted`)
      await m.unmount()
    }
  })

  test('a burst of notches inside one frame accumulates instead of collapsing', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    const wrap = query(m.container, '.lc-chart-wrap')
    const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    let prevented = false
    await act(async () => {
      prevented = wheel(wrap, 0, -300, { clientX: 300 }) && wheel(wrap, 0, -300, { clientX: 300 })
    })
    assert.equal(prevented, true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2.5')
    assert.equal(query(m.container, '.lc-chart').style.width, '246%')
    const content = Math.exp(0.9) * PANE
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * content - 300)) < 0.01)
    await m.unmount()
  })
})

describe('pan and pass-through', () => {
  test('shift pans without handing the page its edges, and gestures that are not the chart gesture stay native', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    const wrap = query(m.container, '.lc-chart-wrap')
    const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    await wheelAt(wrap, 0, -300, { clientX: 200 })
    const start = probe.scrollLeft
    assert.ok(start > 0)

    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 200, ctrlKey: true }), false, 'pinch zoom keeps the browser')
    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 200, metaKey: true }), false, 'command-wheel keeps the browser')
    assert.equal(await wheelAt(wrap, 120, 0, { clientX: 200 }), false, 'a horizontal gesture is not the zoom gesture')
    assert.equal(query(m.container, '.lc-chart').style.width, '156.8%', 'none of the pass-through gestures changed the zoom')

    assert.equal(await wheelAt(wrap, 0, 60, { clientX: 200, shiftKey: true }), true)
    assert.ok(Math.abs(probe.scrollLeft - (start + 60)) < 0.01)

    assert.equal(await wheelAt(wrap, 0, -2000, { clientX: 200, shiftKey: true }), true)
    assert.equal(probe.scrollLeft, 0)
    assert.equal(await wheelAt(wrap, 0, -100, { clientX: 200, shiftKey: true }), true, 'the left edge still owns the gesture')

    const max = ONE_NOTCH * PANE - PANE
    assert.equal(await wheelAt(wrap, 0, 5000, { clientX: 200, shiftKey: true }), true)
    assert.ok(Math.abs(probe.scrollLeft - max) < 0.01)
    assert.equal(await wheelAt(wrap, 0, 100, { clientX: 200, shiftKey: true }), true, 'the right edge still owns the gesture')
    assert.ok(Math.abs(probe.scrollLeft - max) < 0.01)
    await m.unmount()
  })

  test('a sparse history still zooms up to the floor and then swallows the notch', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(3))))
    const wrap = query(m.container, '.lc-chart-wrap')
    probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 100 }), true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 100 }), true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2')
    assert.equal(query(m.container, '.lc-chart').style.width, '200%')
    assert.equal(await wheelAt(wrap, 0, -300, { clientX: 100 }), true)
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2')
    await m.unmount()
  })

  test('an unmeasured viewport still zooms, without an anchor to apply', async () => {
    const saved = viewport.clientW
    viewport.clientW = 0
    try {
      const m = await mount(h(TimelineOverview, propsOf(steps(30))))
      const wrap = query(m.container, '.lc-chart-wrap')
      const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), 0)
      assert.equal(await wheelAt(wrap, 0, -300, { clientX: 10 }), true)
      assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
      assert.equal(probe.scrollLeft, 0)
      await m.unmount()
    } finally {
      viewport.clientW = saved
    }
  })
})

describe('window stability', () => {
  test('an appended step keeps the left record fixed, the end follows the newest, and a reset record does not drift', async () => {
    const list = steps(40)
    const m = await mount(h(TimelineOverview, propsOf(list)))
    const wrap = query(m.container, '.lc-chart-wrap')
    const scroller = query<HTMLElement>(m.container, '.lc-chart-scroll')
    const probe = probeScroll(scroller, PANE)
    await wheelAt(wrap, 0, -300, { clientX: 300 })
    const content = ONE_NOTCH * PANE
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * content - 300)) < 0.01)

    await m.update(h(TimelineOverview, propsOf([...list, req(41, { turn: 41, step: 0 })])))
    assert.ok(Math.abs(probe.scrollLeft - (0.75 * content - 300) * 39 / 40) < 0.01, String(probe.scrollLeft))
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6', 'an append keeps the zoom')

    scroller.scrollLeft = content - 400
    await m.update(h(TimelineOverview, propsOf([...list, req(41, { turn: 41, step: 0 }), req(42, { turn: 42, step: 0 })])))
    assert.ok(Math.abs(probe.scrollLeft - (content - 400)) < 0.01, 'a reader at the newest end stays there')

    await clickChip(m)
    await m.update(h(TimelineOverview, propsOf([...list, req(41, { turn: 41, step: 0 }), req(42, { turn: 42, step: 0 }), req(43, { turn: 43, step: 0 })])))
    assert.equal(probe.scrollLeft, 0)
    await m.unmount()
  })

  test('a pane resize keeps the zoomed record window and re-caps an over-zoomed scale', async () => {
    const callbacks: (() => void)[] = []
    class FakeResizeObserver {
      constructor(cb: () => void) { callbacks.push(cb) }
      observe(): void {}
      disconnect(): void {}
    }
    const holder = globalThis as { ResizeObserver?: unknown }
    const saved = holder.ResizeObserver
    holder.ResizeObserver = FakeResizeObserver
    let width = PANE
    try {
      const m = await mount(h(TimelineOverview, propsOf(steps(100))))
      const wrap = query(m.container, '.lc-chart-wrap')
      const scroller = query<HTMLElement>(m.container, '.lc-chart-scroll')
      const probe = probeScroll(scroller, () => width)
      await wheelAt(wrap, 0, -300, { clientX: 300 })
      assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
      const start = probe.scrollLeft

      width = 600
      await act(async () => { for (const cb of callbacks) cb() })
      assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6', 'the pane resize keeps the factor under the cap')
      assert.ok(Math.abs(probe.scrollLeft - start * 1.5) < 0.01, String(probe.scrollLeft))

      for (let i = 0; i < 8; i++) {
        const chip = query<HTMLElement>(m.container, '.lc-zoom-chip').textContent
        if (chip === '×4') break
        await wheelAt(wrap, 0, -3000, { clientX: 300 })
      }
      assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×4')
      scroller.scrollLeft = 1000

      width = 800
      await act(async () => { for (const cb of callbacks) cb() })
      assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×3', 'a wider pane lowers the pitch cap and re-caps the zoom')
      assert.ok(Math.abs(probe.scrollLeft - 1000) < 0.01, 'the visible records survive the re-cap')
      await m.unmount()
    } finally {
      holder.ResizeObserver = saved
    }
  })

  test('switching the mode, the granularity, or the focused category fits the timeline again', async () => {
    const list = steps(TOTAL, 5)
    const m = await mount(h(TimelineOverview, propsOf(list)))
    const wrap = query(m.container, '.lc-chart-wrap')
    const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    const zoom = async (): Promise<void> => {
      await wheelAt(wrap, 0, -300, { clientX: 200 })
      assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 1)
    }
    await zoom()
    await m.update(h(TimelineOverview, propsOf(list, { mode: 'delta' })))
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    assert.equal(probe.scrollLeft, 0)
    await zoom()
    await m.update(h(TimelineOverview, propsOf(list, { mode: 'delta', granularity: 'turn' })))
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    await zoom()
    await m.update(h(TimelineOverview, propsOf(list, { mode: 'delta', granularity: 'turn', focusCat: 'tool' })))
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    await m.unmount()
  })

  test('a deep zoom resets to fit rather than to a lower cap when the axis changes', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    const wrap = query(m.container, '.lc-chart-wrap')
    const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    await wheelAt(wrap, 0, -3000, { clientX: 300 })
    await wheelAt(wrap, 0, -3000, { clientX: 300 })
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2.9')
    await m.update(h(TimelineOverview, propsOf(steps(10), { granularity: 'turn' })))
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0, 'the switch fits the chart instead of clamping it')
    assert.equal(query(m.container, '.lc-chart').style.width, '')
    assert.equal(probe.scrollLeft, 0)
    await m.unmount()
  })
})

describe('zoomed overlays', () => {
  test('the turn strip grows a label for every block that now reads', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL, 10))))
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['2', '3', '4', '5'])
    const wrap = query(m.container, '.lc-chart-wrap')
    probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    await wheelAt(wrap, 0, -300, { clientX: 300 })
    assert.deepEqual(queryAll(m.container, '.lc-turn-label').map(l => l.textContent), ['1', '2', '3', '4', '5'])
    await m.unmount()
  })

  test('the duration curve rides the widened plot without rescaling', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL), { durationCurve: true })))
    const wrap = query(m.container, '.lc-chart-wrap')
    probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    const svg = query(m.container, '.lc-fit-svg')
    assert.equal(svg.getAttribute('viewBox'), '0 0 49 112')
    await wheelAt(wrap, 0, -300, { clientX: 300 })
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
    assert.equal(query(m.container, '.lc-fit-svg').getAttribute('viewBox'), '0 0 49 112')
    await m.unmount()
  })

  test('the tip tracks the record while the plot is scrolled by the gesture or the scrollbar', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(40), { hoveredSeq: 21 })))
    const wrap = query(m.container, '.lc-chart-wrap')
    const scroller = query<HTMLElement>(m.container, '.lc-chart-scroll')
    probeScroll(scroller, PANE)
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(205px, 0)')

    await wheelAt(wrap, 0, -300, { clientX: 120 })
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(254px, 0)')
    scroller.scrollLeft = 118.1975
    assert.equal(query(m.container, '.lc-chart-tip').style.transform, 'translate(204px, 0)')
    await m.unmount()
  })

  test('the keyboard zooms and fits without a pointer', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    const chart = query<HTMLElement>(m.container, '.lc-chart')
    const press = async (key: string): Promise<void> => {
      await act(async () => { chart.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    }
    await act(async () => { chart.dispatchEvent(new KeyboardEvent('keydown', { key: '+', ctrlKey: true, bubbles: true, cancelable: true })) })
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0, 'a modified shortcut stays with the browser')
    await press('+')
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.3')
    await press('=')
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.6')
    await press('-')
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×1.3')
    for (let i = 0; i < 5; i++) await press('+')
    assert.equal(query(m.container, '.lc-zoom-chip').textContent, '×2.9', 'the cap swallows further zoom keys')
    await press('0')
    assert.equal(queryAll(m.container, '.lc-zoom-chip').length, 0)
    assert.equal(query(m.container, '.lc-chart').style.width, '')
    await m.unmount()
  })

  test('arrow keys keep the cursor inside the zoomed window while focusing alone keeps the window put', async () => {
    const m = await mount(h(TimelineOverview, propsOf(steps(TOTAL))))
    const wrap = query(m.container, '.lc-chart-wrap')
    const probe = probeScroll(query<HTMLElement>(m.container, '.lc-chart-scroll'), PANE)
    await wheelAt(wrap, 0, -300, { clientX: 300 })
    const content = ONE_NOTCH * PANE
    const chart = query<HTMLElement>(m.container, '.lc-chart')
    const before = probe.scrollLeft
    await act(async () => { chart.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.ok(Math.abs(probe.scrollLeft - before) < 0.01, 'focusing the chart does not jump to the first record')

    const press = async (key: string): Promise<void> => {
      await act(async () => { chart.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
    }
    await press('End')
    assert.ok(Math.abs(probe.scrollLeft - (content - PANE)) < 0.01)
    await press('ArrowLeft')
    assert.ok(Math.abs(probe.scrollLeft - (content - PANE)) < 0.01, 'a cursor already in view never scrolls')
    await m.unmount()
  })
})
})
