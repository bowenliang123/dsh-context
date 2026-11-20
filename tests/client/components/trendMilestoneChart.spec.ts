import assert from 'node:assert/strict'
import { createElement as h } from 'react'
import { describe, test } from 'vitest'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { aggregateByTurn } from '../../../src/client/components/trendModel'
import { click, hover, keydown, mount, query, queryAll, settle, unhover } from '../helpers/kit'
import { TrendChart, kit, makeSpies, propsOf, req, scrollEvent, scrollTo, type LayoutEl } from './trendChartHarness'

const EXPANDED = 25

function manyRequests(): RequestRecord[] {
  return Array.from({ length: EXPANDED }, (_, i) => req(i + 1, {
    turn: 1 + Math.floor(i / 5),
    step: i % 5,
    total: 1000 + i * 100 + (i >= 19 ? 5000 : 0),
    activeMs: i === 9 ? 9000 : 100,
  }))
}

function allEvents(): ContextEventRecord[] {
  return [
    { seq: 4, time: 1, kind: 'compaction', count: 2, tokens: 1000, turn: 1, step: 3 },
    { seq: 4, time: 2, kind: 'compaction', count: 1, tokens: 200, turn: 1, step: 3 },
    { seq: 6, time: 3, kind: 'model' },
    { seq: 7, time: 4, kind: 'inject' },
    { seq: 8, time: 5, kind: 'prune', tokens: 0 },
    { seq: 10, time: 6, kind: 'inject', sub: 'skill' },
    { seq: 12, time: 7, kind: 'inject', sub: 'skill', name: 'review' },
    { seq: 12, time: 8, kind: 'inject', sub: 'skill', name: 'review' },
    { seq: 14, time: 9, kind: 'model', from: 'a' },
    { seq: 16, time: 10, kind: 'inject', form: 'relay', agent: 'worker' },
    { seq: 18, time: 11, kind: 'model', to: 'b' },
    { seq: 20, time: 12, kind: 'model', from: 'a', to: 'b' },
    { seq: 24, time: 13, kind: 'agent', form: 'spawn', name: 'explorer' },
    { seq: 99, time: 14, kind: 'compaction' },
  ]
}

function headAt(root: HTMLElement, idx: number, anchor: 'boundary' | 'bar'): HTMLElement {
  return query<HTMLElement>(root, `.lc-ms[data-target-idx="${idx}"][data-anchor="${anchor}"] .lc-ms-head`)
}

function tipText(root: HTMLElement): string[] {
  return queryAll(query(root, '.lc-chart-tip'), 'span').map(row => row.textContent ?? '')
}

describe('TrendChart milestone flags', () => {
  test('every event kind and both metric peaks render one mast with the event rows in the tip', async () => {
    const reqs = manyRequests()
    const events = allEvents()
    const { spies, handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, events })))

    assert.equal(queryAll(m.container, '.lc-ms').length, 10)
    assert.equal(queryAll(m.container, '.lc-ms-flag').length, 12)
    assert.equal(queryAll(m.container, '.lc-bar-marker').length, 0)

    const cases: [number, 'boundary' | 'bar', string, string[]][] = [
      [3, 'boundary', 'compaction', ['Compacted ×2 · −' + kit.fmt(1200)]],
      [5, 'boundary', 'model', ['Model']],
      [7, 'boundary', 'prune', ['Pruned']],
      [9, 'boundary', 'longest', ['Longest step · ' + kit.fmtDuration(9000), 'Skill']],
      [11, 'boundary', 'skill', ['Skill · ×2', 'review, review']],
      [13, 'boundary', 'model', ['Model · a → ?']],
      [15, 'boundary', 'agent', [kit.t('trend.ms.agent') + ' · worker']],
      [17, 'boundary', 'model', ['Model · ? → b']],
      [19, 'boundary', 'growth', ['Most context added · +' + kit.fmt(5100), 'Model · a → b']],
      [23, 'boundary', 'spawn', [kit.t('trend.ms.spawn') + ' · explorer']],
    ]
    for (const [idx, anchor, kind, rows] of cases) {
      const head = headAt(m.container, idx, anchor)
      await hover(head)
      const tip = query<HTMLElement>(m.container, '.lc-chart-tip')
      assert.equal(query(head, '.lc-ms-flag').getAttribute('data-kind'), kind)
      const text = tipText(m.container)
      assert.equal(text.at(-1), kit.t('trend.ms.open'))
      assert.deepEqual(text.slice(1, -1), rows)
      const target = reqs[idx]
      const expectedHead = kit.t('tip.step', { t: target.turn ?? 0, s: target.step ?? 0, n: 5 })
      assert.equal(text[0], expectedHead)
      assert.equal(spies.hover.at(-1), target.seq)
      assert.equal(tip.style.transform, `translate(${idx * 16 + (anchor === 'bar' ? 7 : -1)}px, 0)`)
      await unhover(head)
      assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    }
    await m.unmount()
  })

  test('clicking, pressing Enter or Space picks the landing step; a selected or in-turn target lights its mast', async () => {
    const reqs = manyRequests()
    const events = allEvents()
    const { spies, handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, events })))

    const compaction = headAt(m.container, 3, 'boundary')
    await click(compaction)
    assert.deepEqual(spies.select, [4])
    await keydown('Enter', headAt(m.container, 15, 'boundary'))
    await keydown(' ', headAt(m.container, 23, 'boundary'))
    await keydown('a', headAt(m.container, 7, 'boundary'))
    assert.deepEqual(spies.select, [4, 16, 24])

    await m.update(h(TrendChart, propsOf(reqs, { ...handlers, events, selectedSeq: 4, activeTurn: 1 })))
    const compMast = query(m.container, '.lc-ms[data-target-idx="3"]')
    assert.ok(compMast.className.includes('lc-ms-selected'))
    assert.ok(compMast.className.includes('lc-ms-in-turn'))
    assert.equal(query(compMast, '.lc-ms-head').getAttribute('aria-pressed'), 'true')
    assert.ok(!query(m.container, '.lc-ms[data-target-idx="7"]').className.includes('lc-ms-in-turn'))
    assert.ok(query(m.container, '.lc-ms[data-target-idx="3"] .lc-ms-head').getAttribute('aria-label')?.includes(kit.t('trend.ms.open')))
    await m.unmount()
  })

  test('workflow milestones share their step masts and expose their own rows', async () => {
    const reqs = Array.from({ length: 8 }, (_, i) => req(i + 1))
    const events: ContextEventRecord[] = [
      { seq: 2, time: 1, kind: 'goal-create', name: 'Ship the redesign', count: 1 },
      { seq: 2, time: 2, kind: 'todo-add', count: 2 },
      { seq: 4, time: 3, kind: 'ask', count: 1, items: ['Which approach?'], name: 'Which approach?' },
      { seq: 6, time: 4, kind: 'team-task-complete', name: 'Build the parser', count: 1 },
      { seq: 6, time: 5, kind: 'todo-done', count: 1, items: ['write code'], name: 'write code' },
      { seq: 8, time: 6, kind: 'goal-complete', name: 'Ship the redesign', count: 1 },
      { seq: 8, time: 7, kind: 'team-task-create', count: 1 },
    ]
    const { spies, handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, events })))

    assert.equal(queryAll(m.container, '.lc-ms').length, 4)
    assert.equal(queryAll(m.container, '.lc-ms-flag').length, 7)

    const cases: [number, string, string[]][] = [
      [1, 'goal-create', ['Goal created · Ship the redesign', 'Todo added · ×2']],
      [3, 'ask', ['Asked user · Which approach?']],
      [5, 'team-task-complete', ['Team task done · Build the parser', 'Todo done · write code']],
      [7, 'goal-complete', ['Goal completed · Ship the redesign', 'Team task created']],
    ]
    for (const [idx, kind, rows] of cases) {
      const head = headAt(m.container, idx, 'boundary')
      await hover(head)
      assert.equal(query(head, '.lc-ms-flag').getAttribute('data-kind'), kind)
      assert.deepEqual(tipText(m.container).slice(1, -1), rows)
      await unhover(head)
    }

    await click(headAt(m.container, 5, 'boundary'))
    assert.deepEqual(spies.select, [6])
    await keydown('Enter', headAt(m.container, 7, 'boundary'))
    assert.deepEqual(spies.select, [6, 8])
    await m.unmount()
  })

  test('a bar hover replaces a milestone tip, and leaving the chart clears the active mast', async () => {
    const reqs = manyRequests()
    const events = allEvents()
    const { spies, handlers } = makeSpies()
    const m = await mount(h(TrendChart, propsOf(reqs, { ...handlers, events })))

    const head = headAt(m.container, 3, 'boundary')
    await hover(head)
    assert.ok(query(m.container, '.lc-ms[data-target-idx="3"]').className.includes('lc-ms-active'))
    assert.equal(spies.hover.at(-1), 4)

    await unhover(head)
    await hover(queryAll(m.container, '.lc-bar')[4])
    assert.ok(!query(m.container, '.lc-ms[data-target-idx="3"]').className.includes('lc-ms-active'))
    assert.equal(spies.hover.at(-1), 5)
    assert.equal(query(m.container, '.lc-chart-tip').textContent, kit.t('tip.step', { t: 1, s: 4, n: 5 }) + kit.t('tip.total', { n: kit.fmt(reqs[4].total) }))

    await unhover(query(m.container, '.lc-chart'))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    assert.equal(spies.hover.at(-1), null)
    await m.unmount()
  })

  test('turn granularity labels the longest turn and the turn growth peak', async () => {
    const agg = aggregateByTurn([
      req(1, { turn: 1, step: 0, total: 1000, activeMs: 1000 }),
      req(2, { turn: 1, step: 1, total: 2000, activeMs: 2000 }),
      req(3, { turn: 2, step: 0, total: 2500, activeMs: 500 }),
    ])
    const events: ContextEventRecord[] = [
      { seq: 2, time: 1, kind: 'compaction', turn: 1 },
      { seq: 3, time: 2, kind: 'agent', form: 'spawn', name: 'worker', turn: 2 },
    ]
    const m = await mount(h(TrendChart, propsOf(agg, { granularity: 'turn', events })))
    assert.equal(queryAll(m.container, '.lc-ms').length, 2)

    await hover(headAt(m.container, 0, 'boundary'))
    assert.deepEqual(tipText(m.container), [
      kit.t('tip.turn', { t: 1, n: 2 }),
      kit.t('trend.ms.compaction'),
      kit.t('trend.ms.longestTurn') + ' · ' + kit.fmtDuration(3000),
      kit.t('trend.ms.open'),
    ])
    await unhover(headAt(m.container, 0, 'boundary'))

    await hover(headAt(m.container, 1, 'boundary'))
    assert.deepEqual(tipText(m.container), [
      kit.t('tip.turn1', { t: 2 }),
      kit.t('trend.ms.growthTurn') + ' · +' + kit.fmt(500),
      kit.t('trend.ms.spawn') + ' · worker',
      kit.t('trend.ms.open'),
    ])
    await m.unmount()
  })

  test('turnless steps and turnless turns floor their labels at zero', async () => {
    const step = await mount(h(TrendChart, propsOf(
      [req(1, { turn: undefined, step: undefined })],
      { events: [{ seq: 1, time: 1, kind: 'compaction' }] },
    )))
    await hover(headAt(step.container, 0, 'boundary'))
    assert.equal(tipText(step.container)[0], kit.t('tip.step', { t: 0, s: 0, n: 1 }))
    await step.unmount()

    const one = aggregateByTurn([req(1, { turn: undefined, total: 100, activeMs: 1000 })])
    const single = await mount(h(TrendChart, propsOf(one, { granularity: 'turn' })))
    await hover(headAt(single.container, 0, 'bar'))
    assert.equal(tipText(single.container)[0], kit.t('tip.turn1', { t: 0 }))
    await single.unmount()

    const two = aggregateByTurn([
      req(1, { turn: undefined, total: 100, activeMs: 1000 }),
      req(2, { turn: undefined, total: 200, activeMs: 500 }),
    ])
    const pairs = await mount(h(TrendChart, propsOf(two, { granularity: 'turn' })))
    await hover(headAt(pairs.container, 0, 'bar'))
    assert.equal(tipText(pairs.container)[0], kit.t('tip.turn', { t: 0, n: 2 }))
    await pairs.unmount()
  })

  test('a scrolled-away mast loses its tip when the virtualization window drops it', async () => {
    const reqs = Array.from({ length: 300 }, (_, i) => req(i + 1, { turn: 1, step: i, total: 100 }))
    const events: ContextEventRecord[] = [{ seq: 6, time: 1, kind: 'compaction' }]
    const m = await mount(h(TrendChart, propsOf(reqs, { events })))
    const scroll = query<LayoutEl>(m.container, '.lc-chart-scroll')
    assert.equal(queryAll(m.container, '.lc-ms').length, 0, 'the event sits before the initial window')

    await scrollTo(scroll, 0)
    await settle(20)
    assert.equal(queryAll(m.container, '.lc-ms').length, 1)
    const head = headAt(m.container, 5, 'boundary')
    await hover(head)
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)

    await scrollTo(scroll, 1600)
    await settle(20)
    assert.equal(queryAll(m.container, '.lc-ms').length, 0)
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    await scrollEvent(scroll)
    await m.unmount()
  })
})
