// StatsTokens (src/client/components/statsTokens.tsx) rendered with real
// React: the donut centered on the chat stats line's whole-session billed
// total, sliced by composition category — the prompt side shared by the
// estimated ratios, output exact.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeDonut } from '../../../src/client/components/donut'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import type { ContextBreakdown, Snapshot, TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, hover, unhover } from '../helpers/kit'

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, makeDonut(kit))

const CURRENT: Snapshot['current'] = { system: 200, tools: 100, user: 300, inject: 100, assistant: 200, tool: 100, total: 1000 }
// Billed input 400 (300 uncached + 100 read), output 50 → the chat line's 450.
const USAGE: TokenUsage = { uncachedInputTokens: 300, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 0 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('StatsTokens', () => {
  test('the donut center is the chat line total; rows split it by composition', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '450')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    // The estimated composition (sum 1000) scales to the billed input 400;
    // every row shares the whole 450. All seven parts are non-zero here.
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 7)
    assert.deepEqual(rowOf(m.container, 0), { pct: '17.8%', label: 'System Prompt', count: '≈80' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '8.9%', label: 'Tool Schemas', count: '≈40' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '26.7%', label: 'User Messages', count: '≈120' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '8.9%', label: 'Injected Context', count: '≈40' })
    assert.deepEqual(rowOf(m.container, 4), { pct: '17.8%', label: 'Assistant Messages', count: '≈80' })
    assert.deepEqual(rowOf(m.container, 5), { pct: '8.9%', label: 'Tool Results', count: '≈40' })
    assert.deepEqual(rowOf(m.container, 6), { pct: '11.1%', label: 'Output', count: '50 · incl. reasoning' })
    await m.unmount()
  })

  test('the center keeps the chat line total under compact formatting', async () => {
    const big: TokenUsage = { uncachedInputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 20_000, cacheWriteTokens: 5_000 }
    const m = await mount(h(StatsTokens, { usage: big, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '135.0k')
    await m.unmount()
  })

  test('a delivered breakdown drives the prompt-side split ratios', async () => {
    const current: Snapshot['current'] = { system: 0, tools: 0, user: 150, inject: 0, assistant: 150, tool: 0, total: 300 }
    const breakdown: ContextBreakdown = { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '840')
    // Ratios 1:1:1:1 over input 800 → 200 each; shares of the 840 total.
    assert.deepEqual(rowOf(m.container, 0), { pct: '23.8%', label: 'System Prompt', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.8%', label: 'Tool Schemas', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '23.8%', label: 'User Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '23.8%', label: 'Assistant Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 4), { pct: '4.8%', label: 'Output', count: '40 · incl. reasoning' })
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 5)
    await m.unmount()
  })

  test('zero categories stay hidden once any usage is reported', async () => {
    const current: Snapshot['current'] = { system: 100, tools: 0, user: 300, inject: 0, assistant: 0, tool: 0, total: 400 }
    const m = await mount(h(StatsTokens, { usage: USAGE, current, breakdown: null }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(m.container, 0), { pct: '22.2%', label: 'System Prompt', count: '≈100' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '66.7%', label: 'User Messages', count: '≈300' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '11.1%', label: 'Output', count: '50 · incl. reasoning' })
    await m.unmount()
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
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

  test('null usage degrades to a dash center and zero rows with dash shares', async () => {
    const m = await mount(h(StatsTokens, { usage: null, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 7)
    for (const row of queryAll(m.container, '.lc-sl-row')) {
      assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
    }
    const counts = queryAll(m.container, '.lc-sl-sub').map(n => n.textContent)
    assert.deepEqual(counts, ['≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '0 · incl. reasoning'])
    await m.unmount()
  })

  test('a zero usage report shows a zero center', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage: zero, current: CURRENT, breakdown: null }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '0')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 7)
    await m.unmount()
  })
})
