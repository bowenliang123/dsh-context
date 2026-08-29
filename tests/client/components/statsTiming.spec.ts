// StatsTiming (src/client/components/statsTiming.tsx) rendered with real
// React: the active-time donut (model vs tools vs overhead) and the
// pct-led slice rows with call counts and true durations — plus the empty
// and hostile-timing degrades.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeDonut } from '../../../src/client/components/donut'
import { makeStatsTiming } from '../../../src/client/components/statsTiming'
import type { TimingTotals } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsTiming = makeStatsTiming(kit, makeDonut(kit))
const StatsTimingZh = makeStatsTiming(kitZh, makeDonut(kitZh))

const TIMING: TimingTotals = {
  wallMs: 600_000, lmMs: 240_000, calls: 10, toolsMs: 300_000, toolCalls: 25,
  tools: { bash: { calls: 15, ms: 200_000 }, read: { calls: 8, ms: 80_000 } },
}

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-count')?.textContent ?? '',
  }
}

describe('StatsTiming', () => {
  test('absent and all-zero timings render the empty state', async () => {
    for (const timing of [null, { wallMs: 0, lmMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }] as const) {
      const m = await mount(h(StatsTiming, { timing, locale: 'en' }))
      assert.ok(text(m.container).includes('No timing data yet'))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      await m.unmount()
    }
  })

  test('the donut center shows the wall total; rows lead with shares', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING, locale: 'en' }))
    assert.ok(text(m.container).includes('Timing Stats'))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10m 0s')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'active time')
    assert.deepEqual(rowOf(m.container, 0), { pct: '40%', label: 'Model calls 10×', count: '4m 0s' })
    // The tools row keeps the true 5m sum even though the ring clamps it.
    assert.deepEqual(rowOf(m.container, 1), { pct: '50%', label: 'Tool runs 25×', count: '5m 0s' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '10%', label: 'Overhead', count: '1m 0s' })
    // Three ring segments painted (lm + tools + overhead); exactly three rows.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 3)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    await m.unmount()
  })

  test('the zh locale formats durations and counts in Chinese units', async () => {
    const m = await mount(h(StatsTimingZh, { timing: TIMING, locale: 'zh' }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10分0秒')
    assert.deepEqual(rowOf(m.container, 0), { pct: '40%', label: '模型调用 10次', count: '4分0秒' })
    await m.unmount()
  })

  test('parallel tool overlap: the count keeps the true sum, the share caps at 100%', async () => {
    // 9 parallel 22s calls inside a 100s wall: tools sum 200s > wall.
    const timing: TimingTotals = { wallMs: 100_000, lmMs: 60_000, calls: 2, toolsMs: 200_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } } }
    const m = await mount(h(StatsTiming, { timing, locale: 'en' }))
    assert.deepEqual(rowOf(m.container, 1), { pct: '100%', label: 'Tool runs 9×', count: '3m 20s' })
    // The ring clamps tools into the 40s post-model window; the zero
    // overhead segment is skipped: 2 circles, not 3.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 2)
    assert.equal(rowOf(m.container, 2).pct, '0%')
    assert.equal(rowOf(m.container, 2).count, '—')
    await m.unmount()
  })

  test('a hostile no-wall timing renders rows with dash shares and bare counts', async () => {
    const timing: TimingTotals = { wallMs: 0, lmMs: 5_000, calls: 3, toolsMs: 0, toolCalls: 1, tools: { bash: { calls: 1, ms: 0 } } }
    const m = await mount(h(StatsTiming, { timing, locale: 'en' }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(m.container, 0), { pct: '—', label: 'Model calls 3×', count: '5.0s' })
    // A zero-duration slice shows the dash; its count still rides the label.
    assert.deepEqual(rowOf(m.container, 1), { pct: '—', label: 'Tool runs 1×', count: '—' })
    await m.unmount()
  })
})
