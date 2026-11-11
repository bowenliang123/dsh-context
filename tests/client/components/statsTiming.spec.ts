import { createElement as h, useState, createRef, useRef, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { Donut, type DonutSegment } from '../../../src/client/components/donut'
import { makeStatsTiming } from '../../../src/client/components/statsTiming'
import { type TimingSpan, type TimingTotals, type ContextBreakdown, type Snapshot, type TokenUsage } from '../../../src/shared/types'
import { makeKit, mount, query, queryAll, text, hover, unhover, pinRect, click } from '../helpers/kit'
import { makeStatsTokens } from '../../../src/client/components/statsTokens'
import { clampTipLeft, TipBubble, tipShiftOf, tipShiftStyle, tipShiftTransform, useTipShift } from '../../../src/client/components/tip'
import { SliceList, type SliceRow } from '../../../src/client/components/sliceList'
import { makeNodeText } from '../../../src/client/components/nodes'
import { makeDetailNote } from '../../../src/client/components/detailNote'
import { DICT_EN } from '../../../src/client/i18n'

describe('statsTiming', () => {

const kit = makeKit()
const StatsTiming = makeStatsTiming(kit, Donut)

const timeOf = (ms: number): string => new Date(ms).toLocaleTimeString('en-GB', { hour12: false })

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

function pctSum(container: HTMLElement): number {
  return queryAll(container, '.lc-sl-pct').reduce((sum, n) => sum + Number.parseFloat(n.textContent ?? '0'), 0)
}

describe('StatsTiming', () => {
  test('absent timing renders the empty state; a zero-with-live-call timing renders every slot dimmed', async () => {
    for (const timing of [
      null,
      { wallMs: 0, ttftMs: 0, genMs: 0, calls: 0, toolsMs: 0, toolCalls: 0, tools: {} },
    ] as const) {
      const m = await mount(h(StatsTiming, { timing }))
      assert.ok(text(m.container).includes('No timing data yet'))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 0)
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      await m.unmount()
    }
    const zero = await mount(h(StatsTiming, { timing: { wallMs: 0, ttftMs: 0, genMs: 0, calls: 2, toolsMs: 0, toolCalls: 0, tools: {} } }))
    assert.deepEqual(queryAll(zero.container, '.lc-sl-label').map(n => n.textContent), ['TTFT', 'LLM Gen', 'Tool runs', 'Overhead'])
    assert.ok(queryAll(zero.container, '.lc-sl-row').every(r => r.className.includes('lc-sl-row-dim')))
    assert.equal(query(zero.container, '.lc-donut-center b').textContent, '—')
    await zero.unmount()
  })

  test('the donut center shows the wall total; rows lead with shares', async () => {
    const m = await mount(h(StatsTiming, { timing: TIMING }))
    assert.ok(text(m.container).includes('Timing Stats'))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '10m0s')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Active Time')
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: 'LLM Gen', count: '2m20s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    assert.ok(Math.abs(pctSum(m.container) - 100) < 0.05, `rows must sum to 100%: ${pctSum(m.container)}`)
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 4)
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    await m.unmount()

    const zh = await mount(h(makeStatsTiming(makeKit('zh'), Donut), { timing: TIMING }))
    assert.ok(text(zh.container).includes('耗时统计'))
    await zh.unmount()
  })

  test('parallel tool overlap: the busy union prices once; the per-call sum never inflates the share', async () => {
    const timing: TimingTotals = {
      wallMs: 100_000, ttftMs: 25_000, genMs: 35_000, calls: 2,
      toolsMs: 200_000, toolBusyMs: 40_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } },
    }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 2), { pct: '40.0%', label: 'Tool runs', count: '40.0s · 9 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    assert.ok(Math.abs(pctSum(m.container) - 100) < 0.05, `rows must sum to 100%: ${pctSum(m.container)}`)
    const rows = queryAll(m.container, '.lc-sl-row')
    const tip = rows[2].getAttribute('title') ?? ''
    assert.ok(tip.includes('3m20s'), `the overlapped per-call sum stays discoverable: ${tip}`)
    await hover(rows[2])
    assert.ok(rows[2].className.includes('lc-sl-row-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[2]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    await hover(rows[3])
    assert.ok(rows[3].className.includes('lc-sl-row-on'))
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    await m.unmount()
  })

  test('a pre-field row clamps its tool window and keeps the per-call sum in the tip', async () => {
    const timing: TimingTotals = { wallMs: 100_000, ttftMs: 25_000, genMs: 35_000, calls: 2, toolsMs: 200_000, toolCalls: 9, tools: { bash: { calls: 9, ms: 200_000 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 2), { pct: '40.0%', label: 'Tool runs', count: '40.0s · 9 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    const tip = queryAll(m.container, '.lc-sl-row')[2].getAttribute('title') ?? ''
    assert.ok(tip.includes('3m20s'), `the clamped fallback keeps the per-call sum discoverable: ${tip}`)
    await m.unmount()
  })

  test('a hostile no-wall timing keeps the measured slices beside the idle slots', async () => {
    const timing: TimingTotals = { wallMs: 0, ttftMs: 5_000, genMs: 0, calls: 3, toolsMs: 0, toolCalls: 1, tools: { bash: { calls: 1, ms: 0 } } }
    const m = await mount(h(StatsTiming, { timing }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '—')
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
    assert.deepEqual(rowOf(m.container, 0), { pct: '—', label: 'TTFT', count: '5.0s · 3 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '—', label: 'LLM Gen', count: '—', dim: true })
    assert.deepEqual(rowOf(m.container, 2), { pct: '—', label: 'Tool runs', count: '1 runs', dim: true })
    assert.deepEqual(rowOf(m.container, 3), { pct: '—', label: 'Overhead', count: '—', dim: true })
    await m.unmount()
  })

  test('zero slices stay visible and dimmed; every category keeps its slot', async () => {
    const timing: TimingTotals = {
      wallMs: 532, ttftMs: 480, genMs: 52, reasoningMs: 0, textMs: 52, toolArgMs: 0,
      calls: 1, toolsMs: 0, toolCalls: 0, tools: {},
    }
    const m = await mount(h(StatsTiming, { timing }))
    const labels = queryAll(m.container, '.lc-sl-label').map(n => n.textContent)
    assert.deepEqual(labels, ['TTFT', 'Reasoning', 'Answers', 'Tool args', 'Tool runs', 'Overhead'])
    assert.equal(queryAll(m.container, '.lc-donut-seg').length, 2)
    assert.deepEqual(rowOf(m.container, 1), { pct: '0.0%', label: 'Reasoning', count: '—', dim: true })
    assert.deepEqual(rowOf(m.container, 2), { pct: '9.8%', label: 'Answers', count: '52ms', dim: false })
    assert.deepEqual(rowOf(m.container, 4), { pct: '0.0%', label: 'Tool runs', count: '0 runs', dim: true })
    assert.deepEqual(rowOf(m.container, 5), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    await m.unmount()
  })

  test('idle time prices out of the shares and the center, and the overhead slot absorbs the remainder', async () => {
    const timing: TimingTotals = { ...TIMING, idleMs: 200_000 }
    const m = await mount(h(StatsTiming, { timing }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '6m40s')
    assert.deepEqual(rowOf(m.container, 0), { pct: '25.0%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '35.0%', label: 'LLM Gen', count: '2m20s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '40.0%', label: 'Tool runs', count: '2m40s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Overhead', count: '—', dim: true })
    assert.ok(Math.abs(pctSum(m.container) - 100) < 0.05, `rows must sum to 100%: ${pctSum(m.container)}`)
    const tip = queryAll(m.container, '.lc-sl-row')[2].getAttribute('title') ?? ''
    assert.ok(tip.includes('5m0s'), `the carved per-call sum stays discoverable: ${tip}`)
    await m.unmount()
  })
})

describe('StatsTiming — the generation split', () => {
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }

  test('the model slice expands into thinking / answer / tool args', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT }))
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 6)
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '15.0%', label: 'Reasoning', count: '1m30s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s', dim: false })
    assert.deepEqual(rowOf(m.container, 4), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 5), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    assert.equal(queryAll(m.container, '.lc-donut circle').length, 6)
    await m.unmount()
  })

  test('decode slices never borrow call counts; their own block tallies qualify them; absent tallies render duration alone', async () => {
    const borrowed = await mount(h(StatsTiming, { timing: { ...SPLIT, calls: 236, toolCalls: 302 } }))
    const sub = (i: number): string => queryAll(borrowed.container, '.lc-sl-sub')[i]?.textContent ?? ''
    assert.equal(sub(0), '1m40s · 236 calls', 'TTFT keeps its per-call count')
    for (const i of [1, 2, 3]) {
      assert.ok(!sub(i).includes('236 calls'), `decode row ${i} must not borrow the call count: ${sub(i)}`)
      assert.ok(!sub(i).includes('302'), `decode row ${i} must not borrow the tool count: ${sub(i)}`)
    }
    assert.equal(sub(4), '5m0s · 302 runs', 'tools keep their own per-run count')
    await borrowed.unmount()

    const folded = await mount(h(StatsTiming, { timing: { ...SPLIT, reasoningBlocks: 14, textBlocks: 5, toolArgBlocks: 26 } }))
    assert.deepEqual(rowOf(folded.container, 1), { pct: '15.0%', label: 'Reasoning', count: '1m30s · 14 blocks', dim: false })
    assert.deepEqual(rowOf(folded.container, 2), { pct: '5.0%', label: 'Answers', count: '30.0s · 5 blocks', dim: false })
    assert.deepEqual(rowOf(folded.container, 3), { pct: '3.3%', label: 'Tool args', count: '20.0s · 26 blocks', dim: false })
    await folded.unmount()

    for (const counts of [{ reasoningBlocks: 0 }, {}]) {
      const m = await mount(h(StatsTiming, { timing: { ...SPLIT, ...counts } }))
      assert.equal(rowOf(m.container, 1).count, '1m30s', JSON.stringify(counts))
      await m.unmount()
    }
  })

  test('a hostile bucket total exceeding the generation window clamps only the shares, never the measured figures', async () => {
    const timing: TimingTotals = { ...SPLIT, reasoningMs: 400_000, textMs: 100_000, toolArgMs: 0 }
    const m = await mount(h(StatsTiming, { timing }))
    assert.deepEqual(rowOf(m.container, 0), { pct: '16.7%', label: 'TTFT', count: '1m40s · 10 calls', dim: false })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.3%', label: 'Reasoning', count: '6m40s', dim: false })
    assert.deepEqual(rowOf(m.container, 2), { pct: '0.0%', label: 'Answers', count: '1m40s', dim: false })
    assert.deepEqual(rowOf(m.container, 3), { pct: '0.0%', label: 'Tool args', count: '—', dim: true })
    assert.deepEqual(rowOf(m.container, 4), { pct: '50.0%', label: 'Tool runs', count: '5m0s · 25 runs', dim: false })
    assert.deepEqual(rowOf(m.container, 5), { pct: '10.0%', label: 'Overhead', count: '1m0s', dim: false })
    assert.ok(Math.abs(pctSum(m.container) - 100) < 0.05, `rows must sum to 100%: ${pctSum(m.container)}`)
    await m.unmount()
  })
})

describe('StatsTiming — the throughput figure', () => {
  const paired: TimingTotals = { ...TIMING, speedTokens: 12_345, speedMs: 42_720 }

  test('the output-speed figure: paired renders tok/s (one decimal under 10), unpaired or hostile renders none', async () => {
    const m = await mount(h(StatsTiming, { timing: paired }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'TPS 289 tok/s', '12345 tokens over 42.72s')
    assert.ok(rate?.getAttribute('title')?.includes('Output speed (TPS)'))
    await m.unmount()

    const slow = await mount(h(StatsTiming, { timing: { ...TIMING, speedTokens: 26, speedMs: 10_000 } }))
    assert.equal(query(slow.container, '.lc-card-rate')?.textContent, 'TPS 2.6 tok/s')
    await slow.unmount()

    for (const timing of [
      TIMING,
      { ...TIMING, speedTokens: 500, speedMs: 0 },
      { ...TIMING, speedTokens: Number.NaN, speedMs: 1_000 },
      { ...TIMING, speedTokens: -5, speedMs: 1_000 },
    ] as TimingTotals[]) {
      const bare = await mount(h(StatsTiming, { timing }))
      assert.equal(queryAll(bare.container, '.lc-card-rate').length, 0, JSON.stringify(timing.speedTokens))
      await bare.unmount()
    }
  })
})

describe('StatsTiming — the session-time strip', () => {
  const SPLIT: TimingTotals = {
    wallMs: 600_000, ttftMs: 100_000, genMs: 140_000, reasoningMs: 90_000, textMs: 30_000, toolArgMs: 20_000,
    calls: 10, toolsMs: 300_000, toolCalls: 25, tools: { bash: { calls: 15, ms: 200_000 } },
  }
  const SPANS: TimingSpan[] = [
    { kind: 'ttft', start: 1_000, end: 6_000 },
    { kind: 'reasoning', start: 6_000, end: 16_000 },
    { kind: 'text', start: 16_000, end: 21_000 },
    { kind: 'tools', start: 26_000, end: 41_000 },
    { kind: 'other', start: 46_000, end: 51_000 },
  ]

  test('an absent or empty spans collection paints no strip (the aggregate overview card)', async () => {
    const collections: (TimingSpan[] | undefined)[] = [undefined, []]
    for (const spans of collections) {
      const m = await mount(h(StatsTiming, { timing: TIMING, spans }))
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 4, 'the rows still render')
      assert.equal(queryAll(m.container, '.lc-tstrip').length, 0)
      await m.unmount()
    }
  })

  test('the strip/donut/legend hover link works in both directions: a band lights its arc and row, a row lights the spans without a tip', async () => {
    const m = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const segs = queryAll(m.container, '.lc-tstrip-seg')
    await hover(segs[3])
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.className.includes('lc-bar-tip-on'))
    assert.equal(tip.textContent, `Tool runs 15.0s · ${timeOf(26_000)}`)
    assert.ok(segs[3].className.includes('lc-tstrip-seg-on'))
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[4]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(queryAll(m.container, '.lc-sl-row')[4].className.includes('lc-sl-row-on'))
    await m.unmount()

    const mirror = await mount(h(StatsTiming, { timing: SPLIT, spans: SPANS }))
    const rows = queryAll(mirror.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(mirror.container, '.lc-tstrip-bar').className.includes('lc-tstrip-dim'))
    const on = queryAll(mirror.container, '.lc-tstrip-seg-on')
    assert.equal(on.length, 1)
    assert.equal(on[0], queryAll(mirror.container, '.lc-tstrip-seg')[1])
    assert.equal(query(mirror.container, '.lc-bar-tip').className, 'lc-tip lc-bar-tip')
    await mirror.unmount()
  })
})
})

describe('statsTokens', () => {

const kit = makeKit()
const StatsTokens = makeStatsTokens(kit, Donut)

const CURRENT: Snapshot['current'] = { system: 200, tools: 100, user: 300, inject: 100, skill: 0, assistant: 200, tool: 100, total: 1000 }
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
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 5)
    const expected = [
      { pct: '17.8%', label: 'System Prompt', count: '≈80' },
      { pct: '8.9%', label: 'Tool Schemas', count: '≈40' },
      { pct: '26.7%', label: 'User Messages', count: '≈120' },
      { pct: '8.9%', label: 'Injected Context', count: '≈40' },
      { pct: '37.8%', label: 'Tool Calls', count: '≈170' },
    ]
    expected.forEach((row, i) => assert.deepEqual(rowOf(m.container, i), row))
    await m.unmount()

    const zh = await mount(h(makeStatsTokens(makeKit('zh'), Donut), { usage: USAGE, current: CURRENT, breakdown: null }))
    assert.equal(query(zh.container, '.lc-card-title-text').textContent, 'Token 统计')
    await zh.unmount()

    const sparse: Snapshot['current'] = { system: 100, tools: 0, user: 300, inject: 0, skill: 0, assistant: 0, tool: 0, total: 400 }
    const sparseMount = await mount(h(StatsTokens, { usage: USAGE, current: sparse, breakdown: null }))
    assert.equal(queryAll(sparseMount.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(sparseMount.container, 0), { pct: '22.2%', label: 'System Prompt', count: '≈100' })
    assert.deepEqual(rowOf(sparseMount.container, 1), { pct: '66.7%', label: 'User Messages', count: '≈300' })
    assert.deepEqual(rowOf(sparseMount.container, 2), { pct: '11.1%', label: 'Tool Calls', count: '≈50' })
    await sparseMount.unmount()
  })

  test('the Tool Calls and Answers rows explain their scope in the tooltip', async () => {
    const toolTip = 'What Tool Calls counts:\n• Call names and arguments, replayed in the prompt and generated in the output\n• Tool results: everything the tools returned\nExcludes model replies and reasoning; tool schemas are counted separately.'
    const answersTip = 'What Answers counts:\n• Reply prose replayed in the prompt\n• Reply prose generated in the output\nExcludes reasoning, tool-call arguments, and tool results.'
    const zhToolTip = '工具调用统计的内容：\n• 调用名称与参数：提示词中重放的 + 输出中生成的\n• 工具结果：工具返回的全部内容\n不含模型回复正文与模型思考；工具定义单独统计。'
    const zhAnswersTip = '模型回复统计的内容：\n• 提示词中重放的模型回复正文\n• 输出中生成的模型回复正文\n不含模型思考、工具调用参数与工具结果。'
    const withAnswers: Snapshot['current'] = { ...CURRENT, assistantAnswerTokens: 50 }

    for (const [kitFor, labels, tips, answerRow] of [
      [kit, ['Tool Calls', 'Answers'], [toolTip, answersTip], { pct: '28.9%', label: 'Answers', count: '≈130' }],
      [makeKit('zh'), ['工具调用', '模型回复'], [zhToolTip, zhAnswersTip], { pct: '28.9%', label: '模型回复', count: '≈130' }],
    ] as [ReturnType<typeof makeKit>, string[], string[], { pct: string; label: string; count: string }][]) {
      const Tokens = makeStatsTokens(kitFor, Donut)
      const m = await mount(h(Tokens, { usage: USAGE, current: withAnswers, breakdown: null, generatedAnswerTokens: 10 }))
      const rows = queryAll(m.container, '.lc-sl-row')
      for (const [i, label] of labels.entries()) {
        const row = rows.find(r => r.querySelector('.lc-sl-label')?.textContent === label)
        assert.equal(row?.getAttribute('title'), tips[i])
        assert.equal(row?.querySelector('.lc-sl-label')?.getAttribute('title'), tips[i])
      }
      assert.deepEqual(rowOf(m.container, 5), answerRow)
      await m.unmount()
    }
  })

  test('the thinking slice splits the assistant bucket and the generated output, in both locales', async () => {
    const current: Snapshot['current'] = { system: 100, tools: 0, user: 0, inject: 0, skill: 0, assistant: 100, assistantReasoning: 60, assistantCallTokens: 40, tool: 0, total: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 200, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown: null, generatedReasoning: 40, generatedCallTokens: 60 }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '300')
    assert.deepEqual(rowOf(m.container, 1), { pct: '33.3%', label: 'Tool Calls', count: '≈100' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '33.3%', label: 'Reasoning', count: '≈100' })
    await m.unmount()

    const zh = await mount(h(makeStatsTokens(makeKit('zh'), Donut), { usage, current, breakdown: null, generatedReasoning: 40, generatedCallTokens: 60 }))
    assert.deepEqual(rowOf(zh.container, 2), { pct: '33.3%', label: '模型思考', count: '≈100' })
    await zh.unmount()
  })

  test('a delivered breakdown drives the prompt-side split ratios', async () => {
    const current: Snapshot['current'] = { system: 0, tools: 0, user: 150, inject: 0, skill: 0, assistant: 150, tool: 0, total: 300 }
    const breakdown: ContextBreakdown = { systemTokens: 100, toolsTokens: 100, messageTokens: 200 }
    const usage: TokenUsage = { uncachedInputTokens: 800, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0 }
    const m = await mount(h(StatsTokens, { usage, current, breakdown }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '840')
    assert.deepEqual(rowOf(m.container, 0), { pct: '23.8%', label: 'System Prompt', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 1), { pct: '23.8%', label: 'Tool Schemas', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 2), { pct: '23.8%', label: 'User Messages', count: '≈200' })
    assert.deepEqual(rowOf(m.container, 3), { pct: '28.6%', label: 'Tool Calls', count: '≈240' })
    assert.equal(queryAll(m.container, '.lc-sl-row').length, 4)
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

  test('null or zero usage degrades to the matching center and zero rows with dash shares', async () => {
    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const [usage, center] of [[null, '—'], [zero, '0']] as [TokenUsage | null, string][]) {
      const m = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(query(m.container, '.lc-donut-center b').textContent, center)
      assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
      assert.equal(queryAll(m.container, '.lc-sl-row').length, 8)
      for (const row of queryAll(m.container, '.lc-sl-row')) {
        assert.equal(row.querySelector('.lc-sl-pct')?.textContent, '—')
      }
      const counts = queryAll(m.container, '.lc-sl-sub').map(n => n.textContent)
      assert.deepEqual(counts, ['≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '≈0', '≈0'])
      assert.ok(query(m.container, '.lc-donut-track'), 'an all-zero ring draws the neutral track')
      await m.unmount()
    }
  })
})

describe('StatsTokens — the cache-hit corner figure', () => {
  test('a billed session shows its cache-hit share; an unbilled or unreported session renders no figure', async () => {
    const m = await mount(h(StatsTokens, { usage: USAGE, current: CURRENT, breakdown: null }))
    const rate = query(m.container, '.lc-card-rate')
    assert.equal(rate?.textContent, 'Cache Hit 25.00%', '100 reads over the 400 billed')
    assert.ok(rate?.getAttribute('title')?.includes('Cumulative cache-read share'))
    await m.unmount()

    const zero: TokenUsage = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    for (const usage of [null, zero] as (TokenUsage | null)[]) {
      const bare = await mount(h(StatsTokens, { usage, current: CURRENT, breakdown: null }))
      assert.equal(queryAll(bare.container, '.lc-card-rate').length, 0, JSON.stringify(usage))
      await bare.unmount()
    }
  })
})
})

describe('donut', () => {

function HoverHarness(props: { segments: DonutSegment[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return h(Donut, { segments: props.segments, centerTop: 'x', hoverKey, onHoverKey: setHoverKey })
}

describe('Donut', () => {
  test('segments render one circle each, in order, with accumulating offsets', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 30 },
        { key: 'b', color: '#00ff00', value: 70 },
      ],
      centerTop: '2h 14m',
      centerSub: 'active time',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 2)
    const dash = (el: Element): string => el.getAttribute('stroke-dasharray') ?? ''
    const offset = (el: Element): number => Number(el.getAttribute('stroke-dashoffset'))
    assert.equal(dash(circles[0]), '29.5 70.5')
    assert.equal(offset(circles[0]), 124.75)
    assert.equal(dash(circles[1]), '69.5 30.5')
    assert.equal(offset(circles[1]), 94.75)
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '2h 14m')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'active time')
    await m.unmount()
  })

  test('non-positive and non-finite values are skipped; the surviving positive slice paints alone', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 0 },
        { key: 'b', color: '#00ff00', value: -5 },
        { key: 'c', color: '#0000ff', value: Number.NaN },
        { key: 'd', color: '#ffffff', value: 100 },
      ],
      centerTop: 'x',
    }))
    const circles = queryAll(m.container, 'circle')
    assert.equal(circles.length, 1)
    assert.equal(circles[0].style.stroke, 'rgb(255, 255, 255)')
    await m.unmount()
  })
})

describe('Donut slice divider', () => {
  const lenOf = (el: Element): number => Number((el.getAttribute('stroke-dasharray') ?? '').split(' ')[0])

  test('a lone slice keeps a full ring, and a sliver is cut a quarter per end', async () => {
    const lone = await mount(h(Donut, { segments: [{ key: 'a', color: '#ff0000', value: 42 }], centerTop: 'x' }))
    assert.equal(lenOf(query(lone.container, '.lc-donut-seg')), 100)
    await lone.unmount()

    const sliver = await mount(h(Donut, {
      segments: [
        { key: 'tiny', color: '#ff0000', value: 0.2 },
        { key: 'rest', color: '#00ff00', value: 99.8 },
      ],
      centerTop: 'x',
    }))
    const [tiny, rest] = queryAll(sliver.container, '.lc-donut-seg')
    assert.ok(Math.abs(lenOf(tiny) - 0.1) < 1e-9)
    assert.ok(Math.abs(lenOf(rest) - 99.3) < 1e-9)
    await sliver.unmount()
  })
})

describe('Donut entrance sweep', () => {
  test('segments carry the sweep-in stagger slot in paint order', async () => {
    const m = await mount(h(Donut, {
      segments: [
        { key: 'a', color: '#ff0000', value: 30 },
        { key: 'b', color: '#00ff00', value: 70 },
      ],
      centerTop: 'x',
    }))
    const arcs = queryAll(m.container, '.lc-donut-seg')
    assert.equal((arcs[0] as HTMLElement).style.getPropertyValue('--lc-i'), '0')
    assert.equal((arcs[1] as HTMLElement).style.getPropertyValue('--lc-i'), '1')
    await m.unmount()
  })
})

describe('Donut hover link', () => {
  const SEGS: DonutSegment[] = [
    { key: 'a', color: '#ff0000', value: 30 },
    { key: 'b', color: '#00ff00', value: 70 },
  ]

  test('hovering an arc dims the ring and lights it; a ghost key or a relay-less ring stays at rest', async () => {
    const m = await mount(h(HoverHarness, { segments: SEGS }))
    const arcs = queryAll(m.container, '.lc-donut-seg')
    const cls = (el: Element): string => el.getAttribute('class') ?? ''
    await hover(arcs[0])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(cls(arcs[0]).includes('lc-donut-seg-on'))
    assert.ok(!cls(arcs[1]).includes('lc-donut-seg-on'))
    await unhover(query(m.container, '.lc-donut'))
    assert.ok(!query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok(!cls(arcs[0]).includes('lc-donut-seg-on'))
    await m.unmount()

    const ghost = await mount(h(Donut, { segments: SEGS, centerTop: 'x', hoverKey: 'ghost' }))
    assert.ok(!query(ghost.container, '.lc-donut').className.includes('lc-donut-dim'))
    await ghost.unmount()

    const inert = await mount(h(Donut, { segments: SEGS, centerTop: 'x' }))
    await hover(query(inert.container, '.lc-donut-seg'))
    await unhover(query(inert.container, '.lc-donut'))
    assert.ok(!query(inert.container, '.lc-donut').className.includes('lc-donut-dim'))
    await inert.unmount()
  })
})
})

describe('tip', () => {

describe('tipShiftOf', () => {
  test('shifts a centered tip back inside either edge and leaves a fitting one alone', () => {
    assert.equal(tipShiftOf(100, 80, 300), 0)
    assert.equal(tipShiftOf(10, 80, 300), 30)
    assert.equal(tipShiftOf(290, 80, 300), -30)
    assert.equal(tipShiftOf(45, 80, 300), 0)
  })
})

describe('clampTipLeft', () => {
  test('clamps the left edge to the frame on both sides, centers a fitting tip, and half-overflows an oversized one', () => {
    assert.equal(clampTipLeft(100, 80, 300), 60)
    assert.equal(clampTipLeft(0, 80, 300), 0)
    assert.equal(clampTipLeft(300, 80, 300), 220)
    assert.equal(clampTipLeft(150, 400, 300), -50)
  })
})

describe('tip transforms', () => {
  test('a zero shift keeps the plain centered transform and a signed one moves by pixels', () => {
    assert.equal(tipShiftTransform(0), 'translateX(-50%)')
    assert.equal(tipShiftTransform(6), 'translateX(calc(-50% + 6px))')
    assert.equal(tipShiftTransform(-6), 'translateX(calc(-50% - 6px))')
    assert.equal(tipShiftStyle(0), undefined)
    assert.deepEqual(tipShiftStyle(-6), { transform: 'translateX(calc(-50% - 6px))' })
  })
})

function ShiftProbe(props: { anchor: number | null }): ReactElement {
  const wrapRef = useRef<HTMLDivElement>(null)
  const tipRef = useRef<HTMLDivElement>(null)
  const shift = useTipShift(wrapRef, tipRef, props.anchor === null ? null : { unit: 'px', value: props.anchor })
  return h('div', { ref: wrapRef, className: 'probe-wrap' },
    h('div', { ref: tipRef, className: 'probe-tip' }),
    h('span', { className: 'probe-shift' }, String(shift)))
}

describe('useTipShift', () => {
  test('measures the frame and tip, shifts an edge anchor inside, and resets when the anchor clears', async () => {
    const m = await mount(h(ShiftProbe, { anchor: null }))
    pinRect(query(m.container, '.probe-wrap'), 300)
    pinRect(query(m.container, '.probe-tip'), 80)
    await m.update(h(ShiftProbe, { anchor: 10 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '30')
    await m.update(h(ShiftProbe, { anchor: null }))
    assert.equal(query(m.container, '.probe-shift').textContent, '0')
    await m.unmount()
  })

  test('percent anchors resolve against the frame width', async () => {
    function PctProbe(props: { leftPct: number }): ReactElement {
      const wrapRef = useRef<HTMLDivElement>(null)
      const tipRef = useRef<HTMLDivElement>(null)
      const shift = useTipShift(wrapRef, tipRef, { unit: 'pct', value: props.leftPct })
      return h('div', { ref: wrapRef, className: 'probe-wrap' },
        h('div', { ref: tipRef, className: 'probe-tip' }),
        h('span', { className: 'probe-shift' }, String(shift)))
    }
    const m = await mount(h(PctProbe, { leftPct: 50 }))
    pinRect(query(m.container, '.probe-wrap'), 300)
    pinRect(query(m.container, '.probe-tip'), 80)
    await m.update(h(PctProbe, { leftPct: 10 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '10')
    await m.update(h(PctProbe, { leftPct: 50 }))
    assert.equal(query(m.container, '.probe-shift').textContent, '0')
    await m.unmount()
  })
})

describe('TipBubble', () => {
  test('renders the head, figure and note as a tooltip only while shown', async () => {
    const tipRef = createRef<HTMLDivElement>()
    const m = await mount(h(TipBubble, {
      tipRef, className: 'lc-tip lc-bar-tip', onClass: 'lc-bar-tip-on', shown: true,
      style: { left: '25%' }, head: 'Head', figure: '42', note: 'Note',
    }))
    const bubble = query(m.container, '.lc-bar-tip')
    assert.equal(bubble.getAttribute('role'), 'tooltip')
    assert.equal(bubble.className, 'lc-tip lc-bar-tip lc-bar-tip-on')
    assert.equal(query(bubble, '.lc-bar-tip-head').textContent, 'Head')
    assert.equal(query(bubble, '.lc-bar-tip-fig').textContent, '42')
    assert.equal(query(bubble, '.lc-bar-tip-note').textContent, 'Note')
    await m.update(h(TipBubble, {
      tipRef, className: 'lc-tip lc-bar-tip', onClass: 'lc-bar-tip-on', shown: false,
      style: { left: '25%' }, head: 'Head', figure: '42',
    }))
    assert.equal(bubble.getAttribute('role'), null)
    assert.equal(bubble.className, 'lc-tip lc-bar-tip')
    assert.equal(bubble.childElementCount, 0)
    await m.unmount()
  })
})
})

describe('sliceList', () => {

function HoverHarness(props: { rows: SliceRow[] }) {
  const [hoverKey, setHoverKey] = useState<string | null>(null)
  return h(SliceList, { rows: props.rows, hoverKey, onHoverKey: setHoverKey })
}

describe('SliceList', () => {
  test('rows render the primary line and the secondary count line in order', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3m 20s · 9 runs' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows.length, 2)
    assert.equal(rows[0].querySelector('.lc-sl-pct')?.textContent, '84%')
    assert.equal(rows[0].querySelector('.lc-sl-dot')?.getAttribute('style'), 'background: rgb(255, 0, 0);')
    assert.equal(rows[0].querySelector('.lc-sl-label')?.textContent, 'Alpha')
    assert.equal(rows[0].querySelector('.lc-sl-sub')?.textContent, '204.9k')
    assert.equal(rows[1].querySelector('.lc-sl-pct')?.textContent, '<1%')
    assert.equal(rows[1].querySelector('.lc-sl-sub')?.textContent, '3m 20s · 9 runs')
    await m.unmount()
  })

  test('a row tip overrides the label tooltip and rides the row; a tipless row keeps the label title', async () => {
    const tip = 'Line one\n• Line two'
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '1%', count: '1', tip },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '1%', count: '1' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.equal(rows[0].getAttribute('title'), tip)
    assert.equal(rows[0].querySelector('.lc-sl-label')?.getAttribute('title'), tip)
    assert.equal(rows[1].getAttribute('title'), null)
    assert.equal(rows[1].querySelector('.lc-sl-label')?.getAttribute('title'), 'Beta')
    await m.unmount()
  })

  test('a zero-figure row dims; an empty count renders no secondary line', async () => {
    const m = await mount(h(SliceList, {
      rows: [
        { key: 'a', color: '#ff0000', label: 'Alpha', pct: '0%', count: '—', dim: true },
        { key: 'b', color: '#00ff00', label: 'Beta', pct: '—', count: '' },
      ],
    }))
    const rows = queryAll(m.container, '.lc-sl-row')
    assert.ok(rows[0].className.includes('lc-sl-row-dim'))
    assert.ok(!rows[1].className.includes('lc-sl-row-dim'))
    assert.equal(queryAll(m.container, '.lc-sl-sub').length, 1)
    assert.equal(queryAll(m.container, '.lc-sl-pct').length, 2)
    await m.unmount()
  })

  test('hovering a row lights it; leaving the list clears it; without a relay hovers stay inert', async () => {
    const rowsIn: SliceRow[] = [
      { key: 'a', color: '#ff0000', label: 'Alpha', pct: '84%', count: '204.9k' },
      { key: 'b', color: '#00ff00', label: 'Beta', pct: '<1%', count: '3m 20s · 9 runs' },
    ]
    const m = await mount(h(HoverHarness, { rows: rowsIn }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(rows[1].className.includes('lc-sl-row-on'))
    assert.ok(!rows[0].className.includes('lc-sl-row-on'))
    await unhover(query(m.container, '.lc-sl'))
    assert.ok(!rows[1].className.includes('lc-sl-row-on'))
    await m.unmount()

    const inert = await mount(h(SliceList, { rows: [{ key: 'a', color: '#ff0000', label: 'Alpha', pct: '1%', count: '1' }] }))
    await hover(query(inert.container, '.lc-sl-row'))
    await unhover(query(inert.container, '.lc-sl'))
    assert.equal(queryAll(inert.container, '.lc-sl-row-on').length, 0)
    await inert.unmount()
  })
})
})

describe('nodes', () => {

const kit = makeKit()
const nodeText = makeNodeText(kit)

describe('makeNodeText', () => {
  test('tool results name the tool; failures carry the warning glyph; a skill tag leads only off the tool arm', () => {
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash' }), 'Tool Result ← bash')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1 }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, tool: 'bash', err: true }), 'Tool Result ← bash ⚠')
    assert.equal(nodeText({ seq: 1, cat: 'tool', tokens: 1, skill: 'code-review' }), 'Tool Result')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, skill: 'code-review' }), 'Skill: code-review')
  })

  test('assistant replies show text, a calls breadcrumb, or the empty marker', () => {
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, text: 'hi' }), 'hi')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1, calls: ['bash', 'read'] }), 'Calls bash, read')
    assert.equal(nodeText({ seq: 1, cat: 'assistant', tokens: 1 }), '(empty reply)')
  })

  test('snapshot-form text gets the snapshot prefix; plain text shows as-is', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'snapshot', text: 'a, b' }), 'Snapshot: a, b')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1, text: 'plain' }), 'plain')
  })

  test('textless injects label their form; anything else is a non-text message', () => {
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1, form: 'notice' }), 'Notice')
    assert.equal(nodeText({ seq: 1, cat: 'inject', tokens: 1 }), 'Context Injection')
    assert.equal(nodeText({ seq: 1, cat: 'user', tokens: 1 }), '(non-text message)')
  })
})
})

describe('detailNote', () => {

const DetailNote = makeDetailNote(makeKit())

describe('DetailNote', () => {
  test('the loading strip names the pending read', async () => {
    const m = await mount(h(DetailNote, { state: 'loading' as const }))
    assert.equal(text(m.container), DICT_EN['detail.loading'])
    assert.equal(query(m.container, 'div').className, 'lc-empty', 'the default well class')
    await m.unmount()
  })

  test('the failed strip arms the retry button; the caller class applies', async () => {
    let retries = 0
    const m = await mount(h(DetailNote, {
      state: 'failed' as const,
      onRetry: () => { retries++ },
      className: 'lc-br-note',
    }))
    assert.equal(query(m.container, 'div').className, 'lc-br-note')
    await click(query(m.container, '.lc-br-retry'))
    assert.equal(retries, 1)
    await m.unmount()
  })

  test('a failed note without a retry callback renders the inert text', async () => {
    const m = await mount(h(DetailNote, { state: 'failed' as const }))
    assert.equal(text(m.container), DICT_EN['detail.loadFailed'])
    assert.equal(m.container.querySelector('button'), null)
    await m.unmount()
  })
})
})
