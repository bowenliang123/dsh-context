import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterAll, beforeAll, describe, test } from 'vitest'
import type { ContextEventRecord, RequestRecord } from '../../../src/shared/types'
import { makeTimelineOverview, type TimelineOverviewProps } from '../../../src/client/components/timelineOverview'
import { click, hover, keydown, mount, query, queryAll, unhover } from '../helpers/kit'
import { kit, req } from './timelineChartHarness'

const TimelineOverview = makeTimelineOverview(kit)

let chartWidth = 400
const originalRect = HTMLElement.prototype.getBoundingClientRect

beforeAll(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
    if (this.classList.contains('lc-chart')) {
      return {
        top: 0, left: 0, right: chartWidth, bottom: 148,
        width: chartWidth, height: 148, x: 0, y: 0, toJSON: () => null,
      } as DOMRect
    }
    return originalRect.call(this)
  }
})

afterAll(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect
})

function propsOf(requests: RequestRecord[], over: Partial<TimelineOverviewProps> = {}): TimelineOverviewProps {
  return {
    requests,
    events: [],
    selectedSeq: null,
    hoveredSeq: null,
    activeTurn: null,
    granularity: 'step',
    mode: 'total',
    hoverCat: null,
    onSelect: () => {},
    onHover: () => {},
    onHoverTurn: () => {},
    onPickTurn: () => {},
    ...over,
  }
}

function paced(count: number): RequestRecord[] {
  return Array.from({ length: count }, (_, i) => req(i + 1, {
    turn: 1 + Math.floor(i / 5),
    step: i % 5,
    total: 1000 + i * 100,
  }))
}

function flat(count: number): RequestRecord[] {
  return paced(count).map(record => ({ ...record, total: 100 }))
}

function headOf(container: HTMLElement, targetIdx: number): HTMLElement {
  return query<HTMLElement>(container, `.lc-ms[data-target-idx="${targetIdx}"] .lc-ms-head`)
}

function tipRows(container: HTMLElement): string[] {
  return queryAll(query(container, '.lc-chart-tip'), 'span').map(row => row.textContent ?? '')
}

function near(actual: string, expected: number): void {
  assert.ok(Math.abs(parseFloat(actual) - expected) < 0.01, `${actual} != ${expected}`)
}

describe('TimelineOverview milestone bands', () => {
  test('places event and metric masts by their session fraction and opens the detailed step', async () => {
    chartWidth = 400
    const reqs = paced(10)
    reqs[3] = { ...reqs[3], activeMs: 9000 }
    reqs[7] = { ...reqs[7], total: reqs[6].total + 5000 }
    const events: ContextEventRecord[] = [
      { seq: 2, time: 1, kind: 'compaction', tokens: 1000, turn: 1, step: 1 },
      { seq: 6, time: 2, kind: 'agent', form: 'spawn', name: 'explorer', turn: 2, step: 0 },
    ]
    const spies = {
      pick: [] as number[],
      select: [] as (number | null)[],
      hover: [] as (number | null)[],
      cat: [] as string[],
    }
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onPickMilestone: (seq) => { spies.pick.push(seq) },
      onSelect: (seq) => { spies.select.push(seq) },
      onHover: (seq) => { spies.hover.push(seq) },
      onPickCat: (cat) => { spies.cat.push(cat) },
    })))
    const masts = queryAll(m.container, '.lc-ms')
    assert.equal(masts.length, 4)
    near(masts[0].style.left, 400 / 18)
    near(masts[1].style.left, 400 / 3)
    near(masts[2].style.left, 200)
    near(masts[3].style.left, 2800 / 9)
    assert.deepEqual(masts.map(mast => query(mast, '.lc-ms-flag').getAttribute('data-kind')), [
      'compaction', 'longest', 'spawn', 'growth',
    ])

    const compaction = headOf(m.container, 1)
    await hover(compaction)
    assert.deepEqual(tipRows(m.container), [
      kit.t('tip.step', { t: 1, s: 1, n: 5 }),
      'Compacted · −' + kit.fmt(1000),
      kit.t('timeline.ms.open'),
    ])
    assert.equal(spies.hover.at(-1), 2)
    assert.equal(query<HTMLElement>(m.container, '.lc-fit-cursor').style.left, `${1 / 9 * 100}%`)
    await click(compaction)
    assert.deepEqual(spies.pick, [2])
    assert.deepEqual(spies.select, [], 'the flag consumes the chart click')
    assert.deepEqual(spies.cat, [], 'the flag never opens a category')
    await unhover(compaction)

    await keydown('Enter', headOf(m.container, 5))
    await keydown(' ', headOf(m.container, 3))
    assert.deepEqual(spies.pick, [2, 6, 4])
    await m.unmount()
  })

  test('a selected flag stays pressed and only its own turn stays lit', async () => {
    chartWidth = 400
    const reqs = flat(10)
    const events: ContextEventRecord[] = [{ seq: 2, time: 1, kind: 'compaction', turn: 1, step: 1 }]
    const m = await mount(h(TimelineOverview, propsOf(reqs, { events, selectedSeq: 2, activeTurn: 1 })))
    const masts = queryAll(m.container, '.lc-ms')
    assert.ok(masts[0].className.includes('lc-ms-selected'))
    assert.ok(masts[0].className.includes('lc-ms-in-turn'))
    assert.equal(query(masts[0], '.lc-ms-head').getAttribute('aria-pressed'), 'true')
    assert.ok(query(masts[0], '.lc-ms-head').getAttribute('aria-label')?.includes(kit.t('timeline.ms.open')))
    await m.unmount()
  })

  test('clusters a dense run into one mast, merges its rows, and keeps the highest-priority target', async () => {
    chartWidth = 400
    const reqs = flat(40)
    const events: ContextEventRecord[] = [
      { seq: 2, time: 1, kind: 'compaction', tokens: 100, turn: 1, step: 1 },
      { seq: 3, time: 2, kind: 'compaction', tokens: 50, turn: 1, step: 2 },
      { seq: 4, time: 3, kind: 'prune', tokens: 0, turn: 1, step: 3 },
      { seq: 5, time: 4, kind: 'agent', form: 'spawn', name: 'worker', turn: 1, step: 4 },
    ]
    const picks: number[] = []
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onPickMilestone: (seq) => { picks.push(seq) },
    })))
    assert.equal(queryAll(m.container, '.lc-ms').length, 1)
    const mast = query(m.container, '.lc-ms')
    assert.equal(queryAll(mast, '.lc-ms-flag').length, 3)
    assert.equal(query(mast, '.lc-ms-flag[data-kind="compaction"] .lc-ms-count').textContent, '2')
    assert.equal(queryAll(mast, '.lc-ms-count').length, 1, 'each flag carries its own badge')
    assert.equal(mast.getAttribute('data-target-idx'), '1')
    near(mast.style.left, (400 * (0.5 + 1.5 + 2.5 + 3.5) / 4) / 39)

    await hover(query(mast, '.lc-ms-head'))
    assert.deepEqual(tipRows(m.container), [
      kit.t('tip.step', { t: 1, s: 1, n: 5 }),
      kit.t('timeline.ms.cluster'),
      'Compacted ×2 · −' + kit.fmt(150),
      'Pruned',
      kit.t('timeline.ms.spawn') + ' · worker',
      kit.t('timeline.ms.open'),
    ])
    await click(query(mast, '.lc-ms-head'))
    assert.deepEqual(picks, [2])
    await m.unmount()
  })

  test('workflow milestones place their masts and list every name', async () => {
    chartWidth = 400
    const reqs = flat(10)
    const events: ContextEventRecord[] = [
      { seq: 2, time: 1, kind: 'goal-create', name: 'Ship the redesign', count: 1 },
      { seq: 2, time: 2, kind: 'todo-add', count: 2 },
      { seq: 6, time: 3, kind: 'ask', count: 1, items: ['Which approach?'], name: 'Which approach?' },
      { seq: 6, time: 4, kind: 'team-task-complete', name: 'Build the parser', count: 1 },
    ]
    const picks: number[] = []
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onPickMilestone: (seq) => { picks.push(seq) },
    })))
    const masts = queryAll(m.container, '.lc-ms')
    assert.equal(masts.length, 2)
    near(masts[0].style.left, 200 / 9)
    near(masts[1].style.left, 200)
    assert.deepEqual(queryAll(masts[0], '.lc-ms-flag').map(flag => flag.getAttribute('data-kind')), [
      'goal-create', 'todo-add',
    ])
    assert.deepEqual(queryAll(masts[1], '.lc-ms-flag').map(flag => flag.getAttribute('data-kind')), [
      'team-task-complete', 'ask',
    ])

    await hover(query(masts[0], '.lc-ms-head'))
    assert.deepEqual(tipRows(m.container).slice(1, -1), [
      'Goal created · Ship the redesign',
      'Todo added · ×2',
    ])
    await click(query(masts[1], '.lc-ms-head'))
    assert.deepEqual(picks, [6])
    await m.unmount()
  })

  test('an unmeasured pane shows no flags, and a removed cluster drops its tip', async () => {
    chartWidth = 0
    const reqs = flat(6)
    const events: ContextEventRecord[] = [{ seq: 2, time: 1, kind: 'compaction', turn: 1, step: 1 }]
    const zero = await mount(h(TimelineOverview, propsOf(reqs, { events })))
    assert.equal(queryAll(zero.container, '.lc-ms').length, 0)
    await zero.unmount()

    chartWidth = 400
    const m = await mount(h(TimelineOverview, propsOf(reqs, { events })))
    await hover(headOf(m.container, 1))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    await m.update(h(TimelineOverview, propsOf(reqs, { events: [] })))
    assert.equal(queryAll(m.container, '.lc-ms').length, 0)
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 0)
    await m.unmount()
  })

  test('a chart move clears the milestone tip and hands hover back to the nearest record', async () => {
    chartWidth = 400
    const reqs = flat(10)
    const events: ContextEventRecord[] = [{ seq: 2, time: 1, kind: 'compaction', turn: 1, step: 1 }]
    const hovered: (number | null)[] = []
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onHover: (seq) => { hovered.push(seq) },
    })))
    await hover(headOf(m.container, 1))
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    const surface = query<HTMLElement>(m.container, '.lc-chart')
    await act(async () => { surface.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 300, clientY: 48 })) })
    assert.equal(queryAll(m.container, '.lc-chart-tip').length, 1)
    assert.equal(tipRows(m.container)[0], kit.t('tip.step', { t: 2, s: 2, n: 5 }))
    assert.equal(tipRows(m.container).at(-1), kit.t('tip.total', { n: kit.fmt(reqs[7].total) }))
    assert.equal(hovered.at(-1), reqs[7].seq)
    await m.unmount()
  })

  test('a chart click clears the milestone tip and still selects the nearest record', async () => {
    chartWidth = 400
    const reqs = flat(10)
    const events: ContextEventRecord[] = [{ seq: 2, time: 1, kind: 'compaction', turn: 1, step: 1 }]
    const selected: (number | null)[] = []
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onSelect: (seq) => { selected.push(seq) },
    })))
    await hover(headOf(m.container, 1))
    assert.ok(tipRows(m.container).includes(kit.t('timeline.ms.open')))
    const surface = query<HTMLElement>(m.container, '.lc-chart')
    await act(async () => {
      surface.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 200, clientY: 48 }))
    })
    assert.deepEqual(selected, [reqs[5].seq])
    assert.ok(!tipRows(m.container).includes(kit.t('timeline.ms.open')))
    await m.unmount()
  })

  test('without a milestone picker the flag falls back to selecting the step', async () => {
    chartWidth = 400
    const reqs = flat(6)
    const events: ContextEventRecord[] = [{ seq: 2, time: 1, kind: 'compaction', turn: 1, step: 1 }]
    const selected: (number | null)[] = []
    const m = await mount(h(TimelineOverview, propsOf(reqs, {
      events,
      onSelect: (seq) => { selected.push(seq) },
    })))
    await click(headOf(m.container, 1))
    assert.deepEqual(selected, [2])
    await m.unmount()
  })
})
