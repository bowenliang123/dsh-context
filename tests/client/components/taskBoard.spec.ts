// TaskBoard — the shared task DAG as a status-grouped list: readiness ordering, inline dependency
// chips with the blocker's own dot, owner pinning, owner filtering, and the focus flash.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { TaskBoard, type TaskBoardProps } from '../../../src/client/components/taskBoard'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

function teamOf(over: Partial<FleetTeam> = {}): FleetTeam {
  return {
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      { id: 'task-1', subject: 'schema parsing', description: 'Parse the spec into the internal shape.', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/api/'], ready: false, warnings: [] },
      { id: 'task-2', subject: 'wire the view', description: '', status: 'in_progress', blockedBy: ['task-1'], writeScopes: [], ready: false, warnings: ['overlapping scope'] },
      { id: 'task-3', subject: 'polish', description: '', status: 'pending', blockedBy: ['task-2'], writeScopes: [], ready: false, warnings: [] },
      { id: 'task-4', subject: 'docs', description: '', status: 'pending', ownerName: 'ghost', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      // A dependency on a task the board does not serve (deleted/hostile) renders the bare chip.
      { id: 'task-5', subject: 'orphan dep', description: '', status: 'pending', blockedBy: ['task-99'], writeScopes: [], ready: false, warnings: [] },
    ],
    ...over,
  }
}

function propsOf(over: Partial<TaskBoardProps> = {}): TaskBoardProps {
  return {
    team: teamOf(),
    ownerFilter: null,
    onOwnerFilter: () => {},
    focusTaskId: null,
    onFocusTask: () => {},
    onPinMember: () => {},
    t: kit.t,
    ...over,
  }
}

describe('TaskBoard', () => {
  test('groups by status with counts; the pending pool reads ready-first', async () => {
    const m = await mount(h(TaskBoard, propsOf()))
    const heads = queryAll(m.container, '.lc-tasks-group-head')
    assert.deepEqual(heads.map(el => text(el)), ['In progress1', 'Pending3', 'Done1'])
    // Ready (docs) ahead of blocked (polish) within pending.
    const pendingRows = queryAll(m.container, '.lc-tasks-group-pending .lc-team-task-subject')
    assert.deepEqual(pendingRows.map(el => el.textContent), ['docs', 'polish', 'orphan dep'])
    // The dependency line carries the blocker's own status dot.
    const deps = queryAll(m.container, '.lc-team-task-deps')
    assert.equal(deps.length, 3)
    assert.ok(text(deps[0]).includes('task-1'))
    assert.ok(deps[0].querySelector('span') !== null, 'the blocker dot renders')
    // The unknown blocker chips no dot.
    assert.equal(deps[2].querySelectorAll('span').length, 0)
    // Status badges, scopes, warning, id.
    assert.ok(text(m.container).includes('ready'))
    assert.ok(text(m.container).includes('blocked'))
    assert.ok(text(m.container).includes('Write scopes: src/api/'))
    assert.ok(text(m.container).includes('overlapping scope'))
    await m.unmount()
  })

  test('the owner chip pins the member; an owner off the roster is inert', async () => {
    const pins = new Array<string | null>()
    const m = await mount(h(TaskBoard, propsOf({ onPinMember: id => { pins.push(id) } })))
    const owners = queryAll(m.container, '.lc-team-task-owner')
    await click(owners[0])
    await click(owners[1])
    assert.deepEqual([...pins], ['w1'])
    await m.unmount()
  })

  test('the unowned badge stands in when a task has no owner', async () => {
    const bare = teamOf()
    bare.tasks[1] = { ...bare.tasks[1], ownerName: undefined } as never
    const m = await mount(h(TaskBoard, propsOf({ team: bare })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.taskUnowned']))
    await m.unmount()
  })

  test('a blocker chip flashes its row and toggles off; the focused row scrolls into view', async () => {
    const focuses = new Array<string | null>()
    const m = await mount(h(TaskBoard, propsOf({ onFocusTask: id => { focuses.push(id) } })))
    const dep = queryAll(m.container, '.lc-team-task-dep')[0]
    await click(dep)
    assert.deepEqual([...focuses], ['task-1'])
    await m.unmount()

    // Focused on task-2: clicking task-3's blocker chip (task-2) toggles the ring off.
    const focused = await mount(h(TaskBoard, propsOf({ focusTaskId: 'task-2', onFocusTask: id => { focuses.push(id) } })))
    assert.ok(query(focused.container, '[data-task="task-2"]').className.includes('lc-team-task-focus'))
    await click(query(focused.container, '[data-task="task-3"] .lc-team-task-dep'))
    assert.deepEqual([...focuses].slice(-1), [null])
    await focused.unmount()
  })

  test('the owner filter narrows the board and clears from the chip', async () => {
    const filters = new Array<string | null>()
    const m = await mount(h(TaskBoard, propsOf({ ownerFilter: 'worker-bee', onOwnerFilter: name => { filters.push(name) } })))
    assert.deepEqual(queryAll(m.container, '.lc-team-task-subject').map(el => el.textContent), ['schema parsing'])
    assert.ok(text(query(m.container, '.lc-tasks-filter')).includes('worker-bee'))
    await click(query(m.container, '.lc-tasks-filter'))
    assert.deepEqual([...filters], [null])
    await m.unmount()

    // A filter matching nothing names it.
    const none = await mount(h(TaskBoard, propsOf({ ownerFilter: 'lead' })))
    assert.ok(text(none.container).includes(DICT_EN['fleet.tasks.noMatch']))
    await none.unmount()
  })

  test('descriptions clamp and expand; the empty board says so', async () => {
    const m = await mount(h(TaskBoard, propsOf()))
    const expandBtn = query(m.container, '[data-task="task-1"] .lc-inspector-btn')
    await click(expandBtn)
    assert.ok(query(m.container, '[data-task="task-1"] .lc-team-task-desc').className.includes('lc-team-task-desc-open'))
    await click(query(m.container, '[data-task="task-1"] .lc-inspector-btn'))
    assert.ok(!query(m.container, '[data-task="task-1"] .lc-team-task-desc').className.includes('lc-team-task-desc-open'))
    await m.unmount()

    const empty = await mount(h(TaskBoard, propsOf({ team: teamOf({ tasks: [] }) })))
    assert.ok(text(empty.container).includes(DICT_EN['fleet.team.empty']))
    await empty.unmount()
  })
})
