// StatsContext (src/client/components/statsContext.tsx) rendered with real
// React: the eight-cell 2×4 grid — session shape, the chat-line cache-hit
// cell, the priced cost cell with its rate tooltip, and the context-event
// tally — in both locales. The count figures arrive precomputed (the split
// generation's wire head carries them); `countsOfRecords` is the inline
// generation's derivation, pinned here to the same totals.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { countsOfRecords, makeStatsContext } from '../../../src/client/components/statsContext'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsContext = makeStatsContext(kit)
const StatsContextZh = makeStatsContext(kitZh)

const COST: SessionCostUsage = { flash: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } }
// Prompt-side billed input 300 (100 uncached + 200 read) → hit 66.6% truncated.
const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 }

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

function cells(container: HTMLElement): { labels: string[]; values: string[] } {
  const grid = queryAll(container, '.lc-stat')
  return {
    labels: grid.map(el => el.querySelector('.lc-stat-label')?.textContent ?? ''),
    values: grid.map(el => el.querySelector('.lc-stat-value')?.textContent ?? ''),
  }
}

describe('countsOfRecords (the inline generation derivation)', () => {
  test('tallies distinct turns, records, and the three priced event kinds', () => {
    // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
    const counts = countsOfRecords(
      [req(1), req(1), req(2), req()],
      [ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode')],
    )
    // model/mode events do not appear (only the three priced kinds do).
    assert.deepEqual(counts, { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 })
  })

  test('empty collections tally zero', () => {
    assert.deepEqual(countsOfRecords([], []), { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 })
  })
})

describe('StatsContext', () => {
  test('folds the eight-cell grid: shape stats, the cache-hit cell, cost, and the event tally', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 3, steps: 4, injects: 3, compactions: 2, prunes: 1 },
      toolCalls: 3,
      usage: USAGE,
      cost: COST,
      locale: 'en',
    }))
    assert.ok(text(m.container).includes('Context Stats'))
    const { labels, values } = cells(m.container)
    assert.equal(labels.length, 8)
    assert.deepEqual(labels, [
      'Turns', 'Steps', 'Tool Calls', 'Cache Hit',
      'Cost?', 'Injections', 'Compactions', 'Prunes',
    ])
    assert.deepEqual(values, ['3', '4', '3', '66.6%', '$0.30', '3', '2', '1'])
    await m.unmount()
  })

  test('absent counters, usage, and cost degrade to zeros and the dash', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      locale: 'en',
    }))
    assert.deepEqual(cells(m.container).values, ['0', '0', '0', '—', '—', '0', '0', '0'])
    await m.unmount()
    // A usage report with nothing billed prompt-side dashes the hit too.
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m2 = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: zero,
      locale: 'en',
    }))
    assert.deepEqual(cells(m2.container).values, ['0', '0', '0', '—', '—', '0', '0', '0'])
    await m2.unmount()
  })

  test('only the cost cell is tipped; the bubble lists both families with peak/off rates', async () => {
    const m = await mount(h(StatsContext, {
      counts: { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0 },
      usage: null,
      cost: COST,
      locale: 'en',
    }))
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 1)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 1)
    const tip = text(query(m.container, '.lc-stat-tip'))
    assert.ok(tip.includes('Per-1M-token rates'))
    assert.ok(tip.includes('deepseek-flash / deepseek-v4-flash'))
    assert.ok(tip.includes('deepseek-v4-pro'))
    assert.ok(tip.includes('miss $0.3/$0.15'))
    assert.ok(tip.includes('output $1.2/$0.6'))
    await m.unmount()
  })

  test('the zh locale localizes labels and prices the cost in CNY', async () => {
    const m = await mount(h(StatsContextZh, {
      counts: { turns: 1, steps: 1, injects: 0, compactions: 1, prunes: 0 },
      usage: USAGE,
      cost: COST,
      locale: 'zh',
    }))
    assert.ok(text(m.container).includes('上下文统计'))
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['轮次', '步数', '工具调用', '缓存命中', '预估费用?', '注入', '压缩', '剪枝'])
    assert.deepEqual(values, ['1', '1', '0', '66.6%', '¥2.00', '0', '1', '0'])
    await m.unmount()
  })
})
