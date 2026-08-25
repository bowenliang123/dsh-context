// StatsBoard (src/client/components/statsBoard.tsx) rendered with real React:
// counts folded from requests/events, cache-hit share, and the priced cost
// cell with its rate tooltip in both locales.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeStatsBoard } from '../../../src/client/components/statsBoard'
import type { ContextEventRecord, RequestRecord, SessionCostUsage, TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const kitZh = makeKit('zh')
const StatsBoard = makeStatsBoard(kit)
const StatsBoardZh = makeStatsBoard(kitZh)

function req(turn?: number): RequestRecord {
  return {
    time: 0, seq: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 0,
    ...(turn !== undefined ? { turn } : {}),
  }
}

function ev(kind: ContextEventRecord['kind']): ContextEventRecord {
  return { seq: 0, time: 0, kind }
}

const USAGE: TokenUsage = { uncachedInputTokens: 100, outputTokens: 50, cacheReadTokens: 300, cacheWriteTokens: 0 }
const COST: SessionCostUsage = { flash: { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } }

function statValues(container: HTMLElement): string[] {
  return queryAll(container, '.lc-stat-value').map(el => el.textContent ?? '')
}

describe('StatsBoard counts and cells', () => {
  test('folds turns/steps/events, usage buckets, tool calls, images, and cost (usd)', async () => {
    const m = await mount(h(StatsBoard, {
      // Two steps in turn 1, one in turn 2, and one without a turn (folds as turn 0).
      requests: [req(1), req(1), req(2), req()],
      events: [ev('compaction'), ev('prune'), ev('inject'), ev('inject'), ev('mystery' as never)],
      usage: USAGE,
      toolCalls: 3,
      images: 2,
      cost: COST,
      locale: 'en',
    }))
    assert.ok(text(m.container).includes('Context Stats'))
    assert.deepEqual(statValues(m.container), ['3', '4', '2', '1', '1', '3', '2', '75.00%', '$0.44'])
    await m.unmount()
  })

  test('null usage and absent cost/counters degrade to dashes and zeros', async () => {
    const m = await mount(h(StatsBoard, { requests: [], events: [], usage: null, locale: 'en' }))
    assert.deepEqual(statValues(m.container), ['0', '0', '0', '0', '0', '0', '0', '—', '—'])
    // Usage with nothing billed also shows the dash (no division by zero).
    await m.update(h(StatsBoard, {
      requests: [],
      events: [],
      usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      locale: 'en',
    }))
    assert.deepEqual(statValues(m.container), ['0', '0', '0', '0', '0', '0', '0', '—', '—'])
    await m.unmount()
  })

  test('zh locale prices the cost cell in CNY', async () => {
    const m = await mount(h(StatsBoardZh, { requests: [], events: [], usage: null, cost: COST, locale: 'zh' }))
    const values = statValues(m.container)
    assert.equal(values[8], '¥3.00')
    await m.unmount()
  })
})

describe('StatsBoard cost tooltip', () => {
  test('only the cost cell is tipped; it lists both model families with peak/off rates', async () => {
    const m = await mount(h(StatsBoard, { requests: [], events: [], usage: null, cost: COST, locale: 'en' }))
    const tips = queryAll(m.container, '.lc-stat-tip')
    assert.equal(tips.length, 1)
    assert.equal(queryAll(m.container, '.lc-stat-q').length, 1)
    const costCell = query(m.container, '.lc-stat-tipped')
    assert.ok(query(costCell, '.lc-stat-label').textContent!.startsWith('Cost'))
    const tip = text(tips[0])
    assert.ok(tip.includes('Per-1M-token rates'))
    assert.ok(tip.includes('deepseek-v4-flash'))
    assert.ok(tip.includes('deepseek-v4-pro'))
    // flash: hit $0.014/$0.007 · miss $0.44/$0.22 · output $1.32/$0.66
    assert.ok(tip.includes('hit $0.014/$0.007'))
    assert.ok(tip.includes('miss $0.44/$0.22'))
    assert.ok(tip.includes('output $1.32/$0.66'))
    // pro: miss $1.32/$0.66 · output $3.96/$1.98
    assert.ok(tip.includes('miss $1.32/$0.66'))
    assert.ok(tip.includes('output $3.96/$1.98'))
    await m.unmount()
  })

  test('zh locale prints CNY rates in the tooltip', async () => {
    const m = await mount(h(StatsBoardZh, { requests: [], events: [], usage: null, cost: COST, locale: 'zh' }))
    const tip = text(query(m.container, '.lc-stat-tip'))
    // flash zh: hit ¥0.1/¥0.05 · miss ¥3/¥1.5 · output ¥9/¥4.5
    assert.ok(tip.includes('未命中 ¥3/¥1.5'))
    assert.ok(tip.includes('输出 ¥9/¥4.5'))
    await m.unmount()
  })
})
