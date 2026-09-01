// StatsTokens (src/client/components/statsTokens.tsx) rendered with real
// React: the billed-bucket donut with the cache-hit center and the
// pct-led bucket rows.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeDonut } from '../../../src/client/components/donut'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import type { TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, hover, unhover } from '../helpers/kit'

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, makeDonut(kit))

const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('StatsTokens', () => {
  test('the donut center is the cache-hit share; buckets carry counts and shares', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE }))
    // Prompt-side hit = 300 / (100 + 300 + 0) = 75.00% (the chat line's formula);
    // the rows normalize over the whole billed total (450).
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '75.00%')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Cache Hit')
    // Zero buckets stay hidden: the always-zero DeepSeek cache write drops out.
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(m.container, 0), { pct: '66.7%', label: 'Cached Input', count: '300' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '22.2%', label: 'Uncached Input', count: '100' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '11.1%', label: 'Output', count: '50 · incl. reasoning' })
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[0]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[0].className.includes('lc-sl-row-on'))
    await unhover(rows[0])
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await m.unmount()
  })

  test('non-zero cache writes render as a fourth bucket', async () => {
    const written: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 50 }
    const m = await mount(h(StatsTokens, { usage: written }))
    // Hit = 300 / (100 + 300 + 50) = 66.66%; rows normalize over billed 500.
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '66.66%')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.deepEqual(rowOf(m.container, 0), { pct: '60.0%', label: 'Cached Input', count: '300' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '10.0%', label: 'Cache Write', count: '50' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '20.0%', label: 'Uncached Input', count: '100' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '10.0%', label: 'Output', count: '50 · incl. reasoning' })
    await m.unmount()
  })

  test('null usage degrades to a dash center and zero rows with dash shares', async () => {
    const m = await mount(h(StatsTokens, { usage: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    for (const row of queryAll(m.container, '.lc-sl-row')) {
      assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
    }
    assert.deepEqual(queryAll(m.container, '.lc-sl-sub').map(n => n.textContent),
      ['0', '0', '0', '0 · incl. reasoning'])
    await m.unmount()
  })

  test('zero billed usage also shows the dash center', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage: zero }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    await m.unmount()
  })
})
