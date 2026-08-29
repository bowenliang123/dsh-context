// StatsContext (src/client/components/statsContext.tsx) rendered with real
// React: the eight-cell 2×4 grid — session shape, the priced cost cell with
// its rate tooltip, and the context-event tally — in both locales.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeStatsContext } from '../../../src/client/components/statsContext'
import type { ContextEventRecord, RequestRecord, SessionCostUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsContext = makeStatsContext(kit)
const StatsContextZh = makeStatsContext(kitZh)

const COST: SessionCostUsage = { flash: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } }

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

describe('StatsContext', () => {
  test('folds the eight-cell grid: shape stats, cost, and the event tally', async () => {
    const m = await mount(h(StatsContext, {
      // Two steps in turn 1, one in turn 2, one without a turn (folds as turn 0).
      requests: [req(1), req(1), req(2), req()],
      events: [ev('inject'), ev('inject'), ev('inject'), ev('compaction'), ev('compaction'), ev('prune'), ev('model'), ev('mode')],
      toolCalls: 3,
      images: 2,
      cost: COST,
      locale: 'en',
    }))
    assert.ok(text(m.container).includes('Context Stats'))
    const { labels, values } = cells(m.container)
    assert.equal(labels.length, 8)
    assert.deepEqual(labels, [
      'Turns', 'Steps', 'Tool Calls', 'Images',
      'Cost?', 'Injections', 'Compactions', 'Prunes',
    ])
    // model/mode events do not appear (only their three priced kinds do).
    assert.deepEqual(values, ['3', '4', '3', '2', '$0.44', '3', '2', '1'])
    await m.unmount()
  })

  test('absent counters and cost degrade to zeros and the dash', async () => {
    const m = await mount(h(StatsContext, { requests: [], events: [], locale: 'en' }))
    assert.deepEqual(cells(m.container).values, ['0', '0', '0', '0', '—', '0', '0', '0'])
    await m.unmount()
  })

  test('only the cost cell is tipped; the bubble lists both families with peak/off rates', async () => {
    const m = await mount(h(StatsContext, { requests: [], events: [], cost: COST, locale: 'en' }))
    assert.equal(queryAll(m.container, '.lc-stat-tip').length, 1)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 1)
    const tip = text(query(m.container, '.lc-stat-tip'))
    assert.ok(tip.includes('Per-1M-token rates'))
    assert.ok(tip.includes('deepseek-v4-flash'))
    assert.ok(tip.includes('deepseek-v4-pro'))
    assert.ok(tip.includes('miss $0.44/$0.22'))
    assert.ok(tip.includes('output $3.96/$1.98'))
    await m.unmount()
  })

  test('the zh locale localizes labels and prices the cost in CNY', async () => {
    const m = await mount(h(StatsContextZh, { requests: [req(1)], events: [ev('compaction')], cost: COST, locale: 'zh' }))
    assert.ok(text(m.container).includes('上下文统计'))
    const { labels, values } = cells(m.container)
    assert.deepEqual(labels, ['轮次', '步数', '工具调用', '图片', '预估费用?', '注入', '压缩', '剪枝'])
    assert.deepEqual(values, ['1', '1', '0', '0', '¥3.00', '0', '1', '0'])
    await m.unmount()
  })
})
