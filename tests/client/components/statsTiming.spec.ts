// StatsTiming (src/client/components/statsTiming.tsx) rendered with real
// React: the active-time donut (TTFT + generation vs tools vs overhead) and
// the pct-led slice rows with call counts and true durations — plus the empty
// and hostile-timing degrades.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeDonut } from '../../../src/client/components/donut'
import { makeStatsTiming } from '../../../src/client/components/statsTiming'
import type { TimingTotals } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text, hover } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsTiming = makeStatsTiming(kit, makeDonut(kit))
const StatsTimingZh = makeStatsTiming(kitZh, makeDonut(kitZh))

const TIMING: TimingTotals = {
  wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, calls: 10, toolsMs: 300_000, toolCalls: 25,
  tools: { bash: { calls: 15, ms: 200_000 }, read: { calls: 8, ms: 80_000 } },
}

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string; dim: boolean } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
    dim: row.className.includes('lc-sl-row-dim'),
  }
}

describe('StatsTiming', () => {
  test('absent and all-zero timings render the empty state', async () => {
    for (const timing of [null, { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} }] as const) {
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
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Active Time')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m 40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: 'LLM Gen', count: '2m 20s · 10 calls', dim: false })
    // The tools row keeps the true 5m sum even though the ring clamps it.
    assert.deepEqual(rowOf(m.container, 2), { pct: '50.0%', label: 'Tool runs', count: '5m 0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '10.0%', label: 'Overhead', count: '1m 0s', dim: false })
    // Four ring segments painted (ttft + gen + tools + overhead); four rows.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 4)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    await m.unmount()
  })

  test('the zh locale formats durations and counts in Chinese units', async () => {
    const m = await mount(h(StatsTimingZh, { timing: TIMING, locale: 'zh' }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10分0秒')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: '模型等待', count: '1分40秒 · 10次', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: '模型生成', count: '2分20秒 · 10次', dim: false })
    await m.unmount()
  })

  test('parallel tool overlap: the count keeps the true sum, the share caps at 100%', async () => {
    // 9 parallel 22s calls inside a 100s wall: tools sum 200s > wall.
    const timing: TimingTotals = { wallMs: 100_000, ttftMs: 25_000, genMs: 35_000, calls: 2, toolsMs: 200_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } } }
    const m = await mount(h(StatsTiming, { timing, locale: 'en' }))
    assert.deepEqual(rowOf(m.container, 2), { pct: '100.0%', label: 'Tool runs', count: '3m 20s · 9 runs', dim: false })
    // The ring clamps tools into the 40s post-model window; the zero
    // overhead segment is skipped: 3 circles, not 4.
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 3)
    // The zero overhead row dims whole.
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    // The hover link: the zero-overhead row tints itself but leaves the ring
    // at rest (no painted arc to light); a painted row dims the ring.
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[3])
    assert.ok(rows[3].className.includes('lc-sl-row-on'))
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    await hover(rows[2])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[2]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    await m.unmount()
  })

  test('a hostile no-wall timing renders rows with dash shares and bare counts', async () => {
    const timing: TimingTotals = { wallMs: 0, ttftMs: 5_000, genMs: 0, calls: 3, toolsMs: 0, toolCalls: 1, tools: { bash: { calls: 1, ms: 0 } } }
    const m = await mount(h(StatsTiming, { timing, locale: 'en' }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.deepEqual(rowOf(m.container, 0), { pct: '—', label: 'TTFT', count: '5.0s · 3 calls', dim: false })
    // A zero-duration slice dims and its secondary line keeps just the call
    // count — the dash has nothing to qualify.
    assert.deepEqual(rowOf(m.container, 1), { pct: '—', label: 'LLM Gen', count: '3 calls', dim: true })
    await m.unmount()
  })
})
