import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewUsage, usageWindowOf } from '../../../src/client/components/overviewUsage'
import type { DayTotals } from '../../../src/client/overview'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const OverviewUsage = makeOverviewUsage(kit)

// 2026-09-16 was a Wednesday; the window is its seven-day tail.
const TODAY = '2026-09-16'

function day(over: Partial<DayTotals> = {}): DayTotals {
  return { tokens: 0, requests: 0, sessions: 0, cost: null, ...over }
}

describe('usageWindowOf', () => {
  test('walks today and the six days before it, oldest first', () => {
    assert.deepEqual(usageWindowOf(TODAY), [
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
    ])
  })

  test('an explicit 7d window matches the default', () => {
    assert.deepEqual(usageWindowOf(TODAY, '7d'), usageWindowOf(TODAY))
  })

  test('the 30d window walks thirty columns, oldest first, across the month edge', () => {
    const days = usageWindowOf(TODAY, '30d')
    assert.equal(days.length, 30)
    assert.equal(days[0], '2026-08-18')
    assert.equal(days[29], '2026-09-16')
    // Strictly ascending day keys: the calendar is a tail, not a sampled window.
    for (let i = 1; i < days.length; i++) assert.ok(days[i] > days[i - 1], `${days[i]} > ${days[i - 1]}`)
  })

  test('a corrupt today key reads as an empty window (the card degrades to its note)', () => {
    assert.deepEqual(usageWindowOf('junk'), [])
    assert.deepEqual(usageWindowOf('junk', '30d'), [])
  })
})

describe('OverviewUsage', () => {
  test('an all-empty window renders the empty note, no bars', async () => {
    const m = await mount(h(OverviewUsage, { days: {}, currency: 'usd', today: TODAY, window: '7d' }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    assert.equal(queryAll(m.container, '.lc-ov-usage-bar').length, 0)
    await m.unmount()
  })

  test('a corrupt today key degrades to the empty note', async () => {
    const m = await mount(h(OverviewUsage, { days: { '2026-09-16': day({ tokens: 5 }) }, currency: 'usd', today: 'junk', window: '7d' }))
    assert.ok(text(m.container).includes('No usage in the last 7 days'))
    await m.unmount()
  })

  test('seven columns draw, out-of-window days are ignored, and the key names both series', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1200, cost: 0.5 }),
        '2026-09-10': day({ tokens: 300 }),
        '2026-09-09': day({ tokens: 999_999 }),
        '2026-09-01': day({ tokens: 50_000_000 }),
      },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    const days = queryAll(m.container, '.lc-ov-usage-day').map(el => el.textContent)
    assert.deepEqual(days, ['09-10', '09-11', '09-12', '09-13', '09-14', '09-15', '09-16'])
    assert.ok(text(m.container).includes('Tokens'))
    assert.ok(text(m.container).includes('Cost'))
    await m.unmount()
  })

  test('bar heights scale on each series’ OWN window maximum, with a floor for tiny days', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 100, cost: 0.5 }),
        '2026-09-14': day({ tokens: 1, cost: 0.01 }),
      },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    const heightOf = (col: number, cls: string): string =>
      (queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.' + cls) as HTMLElement).style.height
    // Columns run oldest first; 09-16 (col 6) holds both series' maxima, the slivers under the 4% floor before it.
    assert.equal(heightOf(6, 'lc-ov-usage-tokens'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-tokens'), '10%')
    assert.equal(heightOf(4, 'lc-ov-usage-tokens'), '4%')
    // Cost scales independently: 1 → 100%, 0.5 → 50%, 0.01 → 4%.
    assert.equal(heightOf(6, 'lc-ov-usage-cost'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-cost'), '50%')
    assert.equal(heightOf(4, 'lc-ov-usage-cost'), '4%')
    await m.unmount()
  })

  test('the frame: five gridlines with a solid baseline, and tick rails off the same maxima', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 250, cost: 0.25 }),
      },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-line').length, 5)
    assert.ok(query(m.container, '.lc-ov-usage-line-0') !== null)
    const baseline = query(m.container, '.lc-ov-usage-line-0') as HTMLElement
    assert.equal(baseline.style.bottom, '0%')
    const left = queryAll(m.container, '.lc-ov-usage-rail-l .lc-ov-usage-tick').map(el => el.textContent)
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(left, ['0', '250', '500', '750', '1.0k'])
    assert.deepEqual(right, ['0', '$0.25', '$0.50', '$0.75', '$1.00'])
    await m.unmount()
  })

  test('an unpriced window reads the cost rail as dashes; the bars stay', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 500, cost: null }) },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(right, ['—', '—', '—', '—', '—'])
    const col = queryAll(m.container, '.lc-ov-usage-col')[6]
    assert.equal((col.querySelector('.lc-ov-usage-tokens') as HTMLElement).style.height, '100%')
    assert.equal((col.querySelector('.lc-ov-usage-cost') as HTMLElement).style.height, '0%')
    await m.unmount()
  })

  test('a priced-but-free day draws no bars yet keeps the column (not the empty note)', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 0, requests: 2, cost: 0 }) },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    assert.equal(text(m.container).includes('No usage in the last 7 days'), false)
    await m.unmount()
  })

  test('each tokens bar carries its own day’s figure, and only where there are tokens', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1_200_000 }),
        '2026-09-15': day({ tokens: 5000 }),
        // 09-14 stays absent — a day with no tokens has no figure to print.
      },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    const labelIn = (col: number): string | null =>
      queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.lc-ov-usage-value')?.textContent ?? null
    assert.equal(labelIn(6), '1.2M')
    assert.equal(labelIn(5), '5.0k')
    assert.equal(labelIn(4), null)
    assert.equal(queryAll(m.container, '.lc-ov-usage-value').length, 2)
    // The label is the tokens bar's own child, so it rides that bar's height; cost bars never carry one.
    assert.equal(queryAll(m.container, '.lc-ov-usage-bar.lc-ov-usage-tokens .lc-ov-usage-value').length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-usage-cost .lc-ov-usage-value').length, 0)
    await m.unmount()
  })

  test('the gridlines share the bars’ box, so the label headroom never shifts the scale', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 1000, cost: 1 }), '2026-09-15': day({ tokens: 500, cost: 0.5 }) },
      currency: 'usd',
      today: TODAY,
      window: '7d',
    }))
    // `bottom: N%` only reads the bar scale while the gridlines resolve against the same box the bars
    // fill — the plot above them takes the headroom the labels need.
    const cols = query(m.container, '.lc-ov-usage-cols')
    assert.equal(queryAll(cols, '.lc-ov-usage-line').length, 5)
    assert.equal(queryAll(m.container, '.lc-ov-usage-grid > .lc-ov-usage-line').length, 0)
    assert.equal((query(cols, '.lc-ov-usage-line-0') as HTMLElement).style.bottom, '0%')
    await m.unmount()
  })
})

describe('OverviewUsage in the 30-day dense window', () => {
  test('thirty columns draw with the dense chrome: 30d title, no per-bar figures, stride-5 strip labels', async () => {
    const days: Record<string, DayTotals> = {}
    for (const key of usageWindowOf(TODAY, '30d')) {
      days[key] = day({ tokens: 1000, cost: 0.01 })
    }
    const m = await mount(h(OverviewUsage, { days, currency: 'usd', today: TODAY, window: '30d' }))
    assert.ok(query(m.container, '.lc-ov-usage-dense') !== null, 'the dense class marks the layout')
    assert.ok(text(m.container).includes('Last 30 Days'))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 30)
    // The per-bar figures yield to the tooltip in the dense layout.
    assert.equal(queryAll(m.container, '.lc-ov-usage-value').length, 0)
    // Every fifth strip label back from today stays visible; the rest keep their slots hidden.
    const strips = queryAll(m.container, '.lc-ov-usage-day')
    assert.equal(strips.length, 30)
    const hidden = strips.filter(el => el.style.visibility === 'hidden')
    assert.equal(hidden.length, 24, 'labels at offsets not divisible by 5 hide, slots kept')
    assert.equal(strips[29].style.visibility, '', 'today always labels')
    assert.equal(strips[24].style.visibility, '', 'and the column five days back labels too')
    await m.unmount()
  })

  test('an empty 30-day window reads the 30-day note', async () => {
    const m = await mount(h(OverviewUsage, { days: {}, currency: 'usd', today: TODAY, window: '30d' }))
    assert.ok(text(m.container).includes('No usage in the last 30 days'))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 0)
    await m.unmount()
  })
})
