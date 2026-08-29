// StatsTokens (src/client/components/statsTokens.tsx) rendered with real
// React: the billed-bucket donut with the cache-hit center and the
// pct-led bucket rows.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeDonut } from '../../../src/client/components/donut'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import type { TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll } from '../helpers/kit'

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, makeDonut(kit))

const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-count')?.textContent ?? '',
  }
}

describe('StatsTokens', () => {
  test('the donut center is the cache-hit share; buckets carry counts and shares', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE }))
    // Prompt-side hit = 300 / (100 + 300 + 0) = 75.00% (the chat line's formula);
    // the rows normalize over the whole billed total (450).
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '75.00%')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Cache hit')
    assert.deepEqual(rowOf(m.container, 0), { pct: '67%', label: 'Cache read', count: '300' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '0%', label: 'Cache write', count: '0' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '22%', label: 'Uncached input', count: '100' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '11%', label: 'Output (incl. reasoning)', count: '50' })
    await m.unmount()
  })

  test('null usage degrades to a dash center and zero rows with dash shares', async () => {
    const m = await mount(h(StatsTokens, { usage: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    for (const row of queryAll(m.container, '.lc-sl-row')) {
      assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
      assert.equal(row.querySelector('.lc-sl-count')?.textContent, '0')
    }
    await m.unmount()
  })

  test('zero billed usage also shows the dash center', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage: zero }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    await m.unmount()
  })
})
