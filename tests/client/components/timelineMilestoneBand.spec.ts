import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { describe, test } from 'vitest'
import { blur, click, focus, hover, keydown, mount, query, queryAll, unhover } from '../helpers/kit'
import { TimelineMilestoneBand } from '../../../src/client/components/timelineMilestoneBand'
import type { MilestoneBandItem, MilestoneGroup } from '../../../src/client/components/timelineMilestones'

function group(over: Partial<MilestoneGroup> = {}): MilestoneGroup {
  return {
    key: 'b:1',
    targetIdx: 1,
    targetSeq: 2,
    targetTurn: 1,
    anchor: 'boundary',
    leadKind: 'compaction',
    entries: [
      { kind: 'compaction', events: [] },
      { kind: 'skill', events: [] },
    ],
    count: 3,
    ...over,
  }
}

function item(over: Partial<MilestoneBandItem> = {}): MilestoneBandItem {
  return { key: 'b:1', x: 15, maxIcons: 1, group: group(), ...over }
}

describe('TimelineMilestoneBand', () => {
  test('renders a mast per group with capped icons, count badge, state classes, and aria labels', async () => {
    const items = [
      item(),
      item({
        key: 'm:1',
        x: 23,
        maxIcons: 3,
        group: group({
          key: 'm:1',
          anchor: 'bar',
          leadKind: 'longest',
          entries: [{ kind: 'longest', value: 20 }],
          count: 1,
        }),
      }),
    ]
    const labels = new Map(items.map(it => [it.key, 'label-' + it.key]))
    const m = await mount(h(TimelineMilestoneBand, {
      items,
      activeKey: 'b:1',
      selectedSeq: 2,
      activeTurn: 1,
      bandLabel: 'Milestones',
      labelOf: (it) => labels.get(it.key) ?? '',
      onHoverItem: () => {},
      onLeaveItem: () => {},
      onPickItem: () => {},
    }))
    const root = query(m.container, '.lc-milestones')
    assert.equal(root.getAttribute('aria-label'), 'Milestones')
    const masts = queryAll(m.container, '.lc-ms')
    assert.equal(masts.length, 2)
    assert.ok(masts[0].className.includes('lc-ms-active'))
    assert.ok(masts[0].className.includes('lc-ms-selected'))
    assert.ok(masts[0].className.includes('lc-ms-in-turn'))
    assert.equal(masts[0].style.left, '15px')
    assert.equal(masts[0].getAttribute('data-anchor'), 'boundary')
    assert.equal(masts[0].getAttribute('data-target-idx'), '1')
    assert.equal(masts[0].getAttribute('data-target-seq'), '2')
    const heads = queryAll(m.container, '.lc-ms-head')
    assert.equal(heads[0].getAttribute('aria-label'), 'label-b:1')
    assert.equal(heads[0].getAttribute('aria-pressed'), 'true')
    assert.equal(queryAll(masts[0], '.lc-ms-flag').length, 1, 'maxIcons caps the visible chips')
    assert.equal(query(masts[0], '.lc-ms-count').textContent, '3')
    assert.equal(queryAll(masts[1], '.lc-ms-flag').length, 1)
    assert.equal(masts[1].getAttribute('data-anchor'), 'bar')
    assert.equal(queryAll(masts[1], '.lc-ms-count').length, 0)
    assert.equal(queryAll(masts[1], '.lc-ms-flag')[0].getAttribute('data-kind'), 'longest')
    assert.ok(query(masts[1], '.lc-ms-flag svg') instanceof SVGElement)
    assert.ok(query(masts[0], '.lc-ms-pole'))
    assert.ok(query(masts[0], '.lc-ms-foot'))
    await m.unmount()
  })

  test('hover, focus, click, keyboard, and leave all drive the callbacks', async () => {
    const hovered: string[] = []
    const left: string[] = []
    const picked: string[] = []
    const it = item()
    const m = await mount(h(TimelineMilestoneBand, {
      items: [it],
      activeKey: null,
      selectedSeq: null,
      activeTurn: 2,
      bandLabel: 'Milestones',
      labelOf: () => 'label',
      onHoverItem: (x) => { hovered.push(x.key) },
      onLeaveItem: () => { left.push('leave') },
      onPickItem: (x) => { picked.push(x.key) },
    }))
    const head = query(m.container, '.lc-ms-head')
    const mast = query(m.container, '.lc-ms')
    assert.ok(!mast.className.includes('lc-ms-active'))
    assert.ok(!mast.className.includes('lc-ms-selected'))
    assert.ok(!mast.className.includes('lc-ms-in-turn'), 'a different active turn does not light this mast')
    assert.equal(head.getAttribute('aria-pressed'), 'false')

    await hover(head)
    await focus(head)
    await unhover(head)
    await blur(head)
    assert.deepEqual(hovered, ['b:1', 'b:1'])
    assert.deepEqual(left, ['leave', 'leave'])

    await click(head)
    await keydown('Enter', head)
    await keydown(' ', head)
    await keydown('a', head)
    assert.deepEqual(picked, ['b:1', 'b:1', 'b:1'], 'Enter and Space pick; other keys pass through')
    await m.unmount()
  })

  test('a null active turn and an empty item list render quietly', async () => {
    const empty = await mount(h(TimelineMilestoneBand, {
      items: [],
      activeKey: null,
      selectedSeq: null,
      activeTurn: null,
      bandLabel: 'Milestones',
      labelOf: () => '',
      onHoverItem: () => {},
      onLeaveItem: () => {},
      onPickItem: () => {},
    }))
    assert.equal(queryAll(empty.container, '.lc-ms').length, 0)
    await empty.unmount()

    const m = await mount(h(TimelineMilestoneBand, {
      items: [item({ maxIcons: 3 })],
      activeKey: null,
      selectedSeq: null,
      activeTurn: null,
      bandLabel: 'Milestones',
      labelOf: () => '',
      onHoverItem: () => {},
      onLeaveItem: () => {},
      onPickItem: () => {},
    }))
    assert.ok(!query(m.container, '.lc-ms').className.includes('lc-ms-in-turn'))
    assert.equal(queryAll(m.container, '.lc-ms-flag').length, 2)
    await m.unmount()
  })

  test('the head consumes pointer, focus, and key events before the chart beneath sees them', async () => {
    const calls: string[] = []
    const it = item()
    const Shell = (): ReactElement => h('div', {
      onClick: () => { calls.push('click') },
      onMouseMove: () => { calls.push('move') },
      onFocus: () => { calls.push('focus') },
      onBlur: () => { calls.push('blur') },
      onKeyDown: () => { calls.push('key') },
    }, h(TimelineMilestoneBand, {
      items: [it],
      activeKey: null,
      selectedSeq: null,
      activeTurn: null,
      bandLabel: 'Milestones',
      labelOf: () => 'label',
      onHoverItem: () => { calls.push('hover') },
      onLeaveItem: () => { calls.push('leave') },
      onPickItem: () => { calls.push('pick') },
    }))
    const m = await mount(h(Shell))
    const head = query(m.container, '.lc-ms-head')
    await click(head)
    await act(async () => { head.dispatchEvent(new MouseEvent('mousemove', { bubbles: true })) })
    await focus(head)
    await keydown('a', head)
    await blur(head)
    assert.ok(calls.includes('pick'))
    assert.ok(!calls.some(call => ['click', 'move', 'focus', 'blur', 'key'].includes(call)), calls.join(','))
    await m.unmount()
  })
})
