// FleetList — the roster panel: text/status filtering, sorting, pin-on-click, hover-feed, and
// the per-row session jump.

import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { FleetList, type FleetListProps } from '../../../src/client/components/fleetList'
import type { AgentForest, AgentNode } from '../../../src/client/agentTree'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import { DICT_EN } from '../../../src/client/i18n'
import { click, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()

/** React's controlled input needs the native setter for the change to register. */
async function typeIn(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

/** A controlled select flips through the same native-setter idiom. */
async function selectIn(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: true, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

const TEAM: FleetTeam = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
  ],
  tasks: [],
}

function forestOf(nodes: AgentNode[]): AgentForest {
  return { nodes, edges: [], overflow: 0, solo: false }
}

function familyForest(): AgentForest {
  return forestOf([
    nodeOf('root', { isCurrent: true, running: true, head: { tokens: 500, window: 1000, pct: 50, parts: [] }, requests: 3, durationMs: 60000, updatedAt: 10 }),
    nodeOf('w1', { label: 'worker-bee', running: true, model: 'deepseek-flash', head: { tokens: 800, window: 1000, pct: 80, parts: [] }, requests: 5, durationMs: 42000, updatedAt: 8 }),
    nodeOf('w2', { label: 'done-bot', completed: true, head: { tokens: 200, window: 1000, pct: 20, parts: [] }, requests: 1, durationMs: 9000, updatedAt: 6 }),
    nodeOf('w3', { label: 'idle-one', updatedAt: 4 }),
  ])
}

function propsOf(over: Partial<FleetListProps> = {}): FleetListProps {
  return {
    forest: familyForest(),
    team: null,
    pinnedId: null,
    onPin: () => {},
    onHover: () => {},
    onOpen: () => {},
    t: kit.t,
    fmt: kit.fmt,
    ...over,
  }
}

function rowLabels(container: HTMLElement): string[] {
  return queryAll(container, '.lc-fleet-row-label').map(el => el.textContent ?? '')
}

describe('FleetList — rows', () => {
  test('every family agent lists with its meta, pct, and badges', async () => {
    const m = await mount(h(FleetList, propsOf({ team: TEAM })))
    assert.deepEqual(rowLabels(m.container), ['root', 'worker-bee', 'done-bot', 'idle-one'])
    const root = query(m.container, '.lc-fleet-row-self')
    assert.ok(text(root).includes('current'))
    assert.ok(text(root).includes('500 · 1m00s · 3 steps'))
    // The model rides the meta line when the row's timeline head serves one.
    assert.ok(text(queryAll(m.container, '.lc-fleet-row')[1]).includes('deepseek-flash'))
    assert.ok(text(root).includes('50%'))
    // The current row never offers the open jump.
    assert.equal(queryAll(root, '.lc-fleet-row-open').length, 0)
    // Team badges: the member name for teammates, the role for the lead.
    assert.ok(text(queryAll(m.container, '.lc-fleet-row')[1]).includes('worker-bee'))
    assert.ok(text(root).includes('lead'))
    // An idle node draws the placeholder dot, and a stat-less row no meta.
    const idle = queryAll(m.container, '.lc-fleet-row')[3]
    assert.equal(queryAll(idle, '.lc-fleet-dot-idle').length, 1)
    assert.equal(query(idle, '.lc-fleet-row-meta').textContent, '')
    await m.unmount()
  })

  test('a row click pins (and re-click unpins); the open button jumps without pinning', async () => {
    const pins = new Array<string | null>()
    const opened: string[] = []
    const hovers: (string | null)[] = []
    const m = await mount(h(FleetList, propsOf({
      onPin: id => { pins.push(id) },
      onOpen: id => { opened.push(id) },
      onHover: id => { hovers.push(id) },
    })))
    const row = queryAll(m.container, '.lc-fleet-row')[1]
    await hover(row)
    await click(row)
    await click(query(row, '.lc-fleet-row-open'))
    await unhover(row)
    assert.deepEqual([...pins], ['w1'])
    assert.deepEqual(opened, ['w1'])
    assert.deepEqual(hovers, ['w1', null])

    // Pinned state rings the row; a second click releases it.
    await m.unmount()
    const m2 = await mount(h(FleetList, propsOf({ pinnedId: 'w1', onPin: (id: string | null) => { pins.push(id) } })))
    const pinnedRow = queryAll(m2.container, '.lc-fleet-row')[1]
    assert.ok(pinnedRow.className.includes('lc-fleet-row-pinned'))
    // Keyboard on the pinned row releases the pin too.
    pinnedRow.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await click(pinnedRow)
    assert.deepEqual([...pins], ['w1', null, null])
    await m2.unmount()
  })

  test('keyboard: Enter and Space pin the focused row', async () => {
    const pins = new Array<string | null>()
    const m = await mount(h(FleetList, propsOf({ onPin: id => { pins.push(id) } })))
    const row = queryAll(m.container, '.lc-fleet-row')[2]
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }))
    assert.deepEqual([...pins], ['w2', 'w2'])
    await m.unmount()
  })
})

describe('FleetList — filtering and sorting', () => {
  test('the text search matches labels and ids, case-insensitively', async () => {
    const m = await mount(h(FleetList, propsOf()))
    const search = query(m.container, '.lc-fleet-search') as HTMLInputElement
    await typeIn(search, 'BOT')
    assert.deepEqual(rowLabels(m.container), ['done-bot'])
    await typeIn(search, 'zzz')
    assert.ok(text(m.container).includes(DICT_EN['fleet.list.empty']))
    await m.unmount()
  })

  test('the status chips filter with live counts', async () => {
    const m = await mount(h(FleetList, propsOf()))
    const chips = queryAll(m.container, '.lc-fleet-filters .lc-gran-btn')
    assert.deepEqual(chips.map(c => text(c)), ['All4', 'Running2', 'Done1', 'Idle1'])
    await click(chips[2])
    assert.deepEqual(rowLabels(m.container), ['done-bot'])
    await click(queryAll(m.container, '.lc-fleet-filters .lc-gran-btn')[3])
    assert.deepEqual(rowLabels(m.container), ['idle-one'])
    await click(queryAll(m.container, '.lc-fleet-filters .lc-gran-btn')[0])
    assert.equal(rowLabels(m.container).length, 4)
    await m.unmount()
  })

  test('each sort key reorders the rows', async () => {
    const m = await mount(h(FleetList, propsOf()))
    const select = query(m.container, '.lc-fleet-sort') as HTMLSelectElement
    await selectIn(select, 'tokens')
    assert.deepEqual(rowLabels(m.container), ['worker-bee', 'root', 'done-bot', 'idle-one'])
    await selectIn(select, 'duration')
    assert.deepEqual(rowLabels(m.container), ['root', 'worker-bee', 'done-bot', 'idle-one'])
    await selectIn(select, 'steps')
    assert.deepEqual(rowLabels(m.container), ['worker-bee', 'root', 'done-bot', 'idle-one'])
    await selectIn(select, 'recent')
    assert.deepEqual(rowLabels(m.container), ['root', 'worker-bee', 'done-bot', 'idle-one'])
    await selectIn(select, 'spawn')
    assert.deepEqual(rowLabels(m.container), ['root', 'worker-bee', 'done-bot', 'idle-one'])
    await m.unmount()
  })

  test('sorting a bare pair covers the null arms of the comparators', async () => {
    const bare = forestOf([
      nodeOf('a', { head: null, durationMs: null, requests: 0, updatedAt: 1 }),
      nodeOf('b', { head: { tokens: 10, window: 100, pct: 10, parts: [] }, durationMs: 5000, requests: 2, updatedAt: 2 }),
    ])
    const m = await mount(h(FleetList, propsOf({ forest: bare })))
    const select = query(m.container, '.lc-fleet-sort') as HTMLSelectElement
    await selectIn(select, 'tokens')
    assert.deepEqual(rowLabels(m.container), ['b', 'a'])
    await selectIn(select, 'duration')
    assert.deepEqual(rowLabels(m.container), ['b', 'a'])
    await m.unmount()
  })
})
