import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { browserRows, browserView } from '../../src/tui/browser'
import { translatorOf } from '../../src/tui/i18n'
import { sessionRows, timingRows, tokenRows } from '../../src/tui/stats'
import { stepBrief, trendColumns, trendGeometry, visibleRange } from '../../src/tui/trend'
import { headersFixture, timelineFixture } from './helpers'

const t = translatorOf('en')

describe('trend', () => {
  test('one stacked column per step in category order, ✂ on the step a compaction landed on', () => {
    const columns = trendColumns(timelineFixture(), 'step')
    assert.deepEqual(columns.map(c => [c.seq, c.turn, c.step, c.marker]), [[3, 1, 1, undefined], [6, 1, 2, undefined], [10, 2, 1, '✂']])
    assert.deepEqual(columns[1].segments.map(s => s.value), [1000, 2000, 100, 50, 20, 40, 500])
    assert.deepEqual(columns[0].segments.map(s => s.color), [0, 1, 2, 3, 4, 5, 6])
    assert.equal(columns[0].segments[4].value, 0, 'a record folded before the skill category reads 0')
  })

  test('turn granularity collapses each turn onto its last step', () => {
    const columns = trendColumns(timelineFixture(), 'turn')
    assert.deepEqual(columns.map(c => [c.seq, c.stepCount, c.marker]), [[6, 2, undefined], [10, 1, '✂']])
  })

  test('unstamped records pool under turn 0, step 0', () => {
    const timeline = timelineFixture()
    const columns = trendColumns({ ...timeline, requests: [{ ...timeline.requests[0], turn: undefined, step: undefined }] }, 'step')
    assert.deepEqual([columns[0].turn, columns[0].step], [0, 0])
  })

  test('trendGeometry widens the columns to the width, and windows them once they outnumber it', () => {
    assert.deepEqual(trendGeometry(24, 96), { columnWidth: 3, gap: 1, capacity: 24 })
    assert.deepEqual(trendGeometry(3, 170), { columnWidth: 4, gap: 1, capacity: 34 })
    assert.deepEqual(trendGeometry(40, 96), { columnWidth: 2, gap: 0, capacity: 48 })
    assert.deepEqual(trendGeometry(200, 96), { columnWidth: 1, gap: 0, capacity: 96 })
    assert.deepEqual(trendGeometry(0, 10), { columnWidth: 4, gap: 1, capacity: 2 })
  })

  test('visibleRange pins the newest end until the selection walks off it', () => {
    assert.deepEqual(visibleRange(5, 4, 10), { start: 0, end: 5 })
    assert.deepEqual(visibleRange(100, 99, 10), { start: 90, end: 100 })
    assert.deepEqual(visibleRange(100, 20, 10), { start: 15, end: 25 })
    assert.deepEqual(visibleRange(100, 0, 10), { start: 0, end: 10 })
  })

  test('the step brief names the opener, the step inputs and the response', () => {
    const timeline = timelineFixture({
      nodes: [...timelineFixture().nodes, { seq: 6, cat: 'assistant' as const, tokens: 10, text: 'done' }].sort((a, b) => a.seq - b.seq),
    })
    assert.deepEqual(stepBrief(timeline, 6), { user: 'fix the bug', inputs: ['→ read', 'read: export const a = 1'], response: 'done' })
    assert.deepEqual(stepBrief(timeline, 3), { user: 'fix the bug', inputs: [] })
    assert.deepEqual(stepBrief(timeline, 999), { inputs: [] }, 'a step outside the retained log has no brief')
    assert.deepEqual(stepBrief({ ...timeline, nodes: timeline.nodes.filter(n => n.cat !== 'user') }, 6).user, undefined, 'no opener retained')
  })
})

describe('browser', () => {
  test('the live view: categories in order with deltas vs the newest request, items per category', () => {
    const view = browserView(timelineFixture(), headersFixture(), null, t)
    assert.equal(view.seq, null)
    assert.deepEqual(view.categories.map(c => [c.key, c.tokens, c.delta]), [
      ['system', 1000, 0], ['tools', 2000, 0], ['user', 300, 0], ['inject', 50, 0], ['skill', 20, 20], ['assistant', 90, 0], ['tool', 700, 0],
    ])
    const tools = view.categories[1].items
    assert.deepEqual(tools.map(i => [i.label, i.tokens, i.source]), [['bash', 1200, undefined], ['read', 800, '@deepseek-ai/dsh-tool-fs']])
    const toolNodes = view.categories[6].items
    assert.deepEqual(toolNodes.map(i => [i.id, i.err, i.content]), [
      ['node:5', undefined, 'export const a = 1'],
      ['node:11', true, undefined],
    ])
    assert.equal(view.categories[2].items[0].content, 'fix the bug')
    assert.deepEqual(view.categories[0].items, [], 'no system prompt node and no header price: nothing to list')
  })

  test('a step view reads that request, compares with the one before it, and lists only what it carried', () => {
    const timeline = timelineFixture({ systems: [{ seq: 0, time: 0, tokens: 1000 }] })
    const view = browserView(timeline, headersFixture(), 6, t)
    assert.equal(view.seq, 6)
    assert.deepEqual(view.categories.map(c => c.delta), [0, 0, 0, 0, 20, 40, 500])
    assert.deepEqual(view.categories[0].items, [{ id: 'system', label: 'System Prompt', tokens: 1000 }])
    assert.deepEqual(view.categories[2].items.map(i => i.id), ['node:1'])
    const first = browserView(timeline, null, 3, t)
    assert.ok(first.categories.every(c => c.delta === null), 'the first step has no predecessor')
    assert.deepEqual(first.categories[1].items, [])
  })

  test('a step that aged out of the retained log falls back to the live view', () => {
    assert.equal(browserView(timelineFixture(), null, 999, t).seq, null)
  })

  test('the dropped-node and retention notes carry through', () => {
    const timeline = timelineFixture({ droppedNodes: 4, surfaceFloor: 0, archiveFloor: 50 })
    assert.equal(browserView(timeline, null, null, t).missing, 4)
    assert.equal(browserView(timeline, null, 6, t).approximate, true)
  })

  test('rows expand categories to items, and an item to its wrapped preview lines', () => {
    const view = browserView(timelineFixture(), headersFixture(), null, t)
    const halves = (text: string) => [text.slice(0, 6), text.slice(6)]
    assert.equal(browserRows(view, new Set(), halves).length, 7)
    const rows = browserRows(view, new Set(['cat:tool', 'node:5', 'node:11']), halves)
    assert.deepEqual(rows.map(r => r.id).slice(6), ['cat:tool', 'node:5', 'node:5:0', 'node:5:1', 'node:11'])
    assert.deepEqual(rows.slice(8, 10), [
      { kind: 'line', id: 'node:5:0', itemId: 'node:5', text: 'export' },
      { kind: 'line', id: 'node:5:1', itemId: 'node:5', text: ' const a = 1' },
    ])
  })
})

describe('overview stats', () => {
  test('session counts come from the split head when served, else from the records', () => {
    const derived = sessionRows(timelineFixture(), t)
    assert.deepEqual(derived.map(r => r.value), ['2', '3', '1', '2', '2', '0', '1', '1', '0'])
    const head = sessionRows(timelineFixture({
      counts: { turns: 9, steps: 20, injects: 4, compactions: 2, prunes: 1, skills: 3 },
      answers: undefined, humanInputs: undefined, toolCalls: undefined,
    }), t)
    assert.deepEqual(head.map(r => r.value), ['9', '20', '0', '0', '0', '3', '4', '2', '1'])
    const noSkills = sessionRows(timelineFixture({ counts: { turns: 1, steps: 1, injects: 0, compactions: 0, prunes: 0 } }), t)
    assert.equal(noSkills[5].value, '0')
  })

  test('billed buckets with the cache-hit share, and the host cost figure', () => {
    const rows = tokenRows(timelineFixture(), { cost: { currency: 'USD', amount: 0.0123 } }, t)
    assert.deepEqual(rows.map(r => [r.label, r.value]), [
      ['Uncached input', '1.0k'], ['Cache input', '3.0k'], ['Cache write', '0'], ['Output', '200'], ['Total', '4.2k'],
      ['Cache Hit', '75.00%'], ['Cost', '$0.012'],
    ])
    assert.deepEqual(tokenRows(timelineFixture({ cost: undefined }), { cost: { currency: 'CNY', amount: 12.5 } }, t), [{ label: 'Cost', value: '¥12.50' }])
    assert.deepEqual(tokenRows(timelineFixture({ cost: undefined }), { cost: { currency: 'EUR', amount: 3 } }, t), [{ label: 'Cost', value: '3.00 EUR' }])
    const unbilled = tokenRows(timelineFixture({ cost: { p: { m: { peak: { uncached: 0, cacheRead: 0, cacheWrite: 0, output: 5 } } } } }), {}, t)
    assert.equal(unbilled.at(-1)?.value, '—')
  })

  test('timing totals, or nothing before the first step completes', () => {
    assert.deepEqual(timingRows(timelineFixture(), t).map(r => r.value), ['9.0s', '1.2s', '3.0s', '2.5s · 2 runs'])
    assert.deepEqual(timingRows(timelineFixture({ timing: undefined }), t), [])
  })
})
