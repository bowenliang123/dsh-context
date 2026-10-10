// fleetTeam.ts — the `agentTeam` projection's sanitizing parse and its roster/task helpers.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  memberIdByName,
  tasksOfOwner,
  teamMemberOf,
  teamOf,
  type FleetTeam,
} from '../../src/client/fleetTeam'

function teamValue(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      { id: 'w2', name: 'flaky-one', role: 'teammate', phase: 'failed', error: 'provider blew up' },
    ],
    tasks: [
      { id: 'task-1', subject: 'schema parsing', description: 'parse the spec', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: ['src/api/'], ready: false, writeScopeWarnings: [] },
      { id: 'task-2', subject: 'wire the view', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: ['task-1'], writeScopes: [], ready: false, writeScopeWarnings: ['overlap with task-3'] },
      { id: 'task-3', subject: 'polish', description: '', status: 'pending', blockedBy: ['task-2'], writeScopes: [], ready: false },
      { id: 'task-4', subject: 'docs', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true },
    ],
    ...over,
  }
}

describe('teamOf — the sanitizing parse', () => {
  test('a well-formed projection parses whole', () => {
    const team = teamOf(teamValue({ failure: 'bad record' }))
    assert.ok(team !== null)
    assert.equal(team.members.length, 3)
    assert.equal(team.tasks.length, 4)
    assert.equal(team.failure, 'bad record')
    assert.deepEqual(team.tasks[1].warnings, ['overlap with task-3'])
  })

  test('absent and shapeless values degrade to null', () => {
    assert.equal(teamOf(undefined), null)
    assert.equal(teamOf(null), null)
    assert.equal(teamOf('team'), null)
    assert.equal(teamOf({}), null)
    assert.equal(teamOf({ members: 'nope' }), null)
  })

  test('malformed members and tasks drop alone', () => {
    const team = teamOf({
      members: [
        null,
        42,
        { id: '', name: 'x', role: 'teammate', phase: 'active' },
        { id: 'x', name: '', role: 'teammate', phase: 'active' },
        { id: 'x', name: 'x', role: 'captain', phase: 'active' },
        { id: 'x', name: 'x', role: 'teammate', phase: 'zombie' },
        { id: 'w9', name: 'nine', role: 'teammate', phase: 'provisioning', error: '' },
      ],
      tasks: [
        null,
        'task',
        { id: '', subject: 's', status: 'pending' },
        { id: 'task-9', subject: '', status: 'pending' },
        { id: 'task-9', subject: 's', status: 'deleted' },
        { id: 'task-10', subject: 'kept', description: 7, status: 'pending', blockedBy: ['a', 1, ''], writeScopes: 'nope', ready: 'yes', revision: 'r' },
      ],
      failure: 42,
    })
    assert.ok(team !== null)
    assert.deepEqual(team.members, [{ id: 'w9', name: 'nine', role: 'teammate', phase: 'provisioning' }])
    assert.equal(team.tasks.length, 1)
    assert.deepEqual(team.tasks[0], {
      id: 'task-10', subject: 'kept', description: '', status: 'pending',
      blockedBy: ['a'], writeScopes: [], ready: false, warnings: [],
    })
    assert.equal(team.failure, undefined)
  })

  test('optional fields stay absent rather than materializing empty', () => {
    const team = teamOf({ members: [{ id: 'r', name: 'lead', role: 'lead', phase: 'active' }] })
    assert.ok(team !== null)
    assert.equal(team.members[0].error, undefined)
    assert.equal(team.failure, undefined)
    // A missing tasks array serves an empty board.
    assert.deepEqual(team.tasks, [])
  })
})

describe('fleetTeam helpers', () => {
  const team = teamOf(teamValue()) as FleetTeam

  test('teamMemberOf joins by session id', () => {
    assert.equal(teamMemberOf(team, 'w1')?.name, 'worker-bee')
    assert.equal(teamMemberOf(team, 'nobody'), null)
    assert.equal(teamMemberOf(null, 'w1'), null)
  })

  test('memberIdByName joins the task board onto roster names', () => {
    assert.equal(memberIdByName(team, 'worker-bee'), 'w1')
    assert.equal(memberIdByName(team, 'ghost'), undefined)
    assert.equal(memberIdByName(team, undefined), undefined)
    assert.equal(memberIdByName(null, 'worker-bee'), undefined)
  })

  test('tasksOfOwner keeps board order', () => {
    assert.deepEqual(tasksOfOwner(team, 'worker-bee').map(task => task.id), ['task-1', 'task-2'])
    assert.deepEqual(tasksOfOwner(team, 'lead'), [])
    assert.deepEqual(tasksOfOwner(team, undefined), [])
    assert.deepEqual(tasksOfOwner(null, 'worker-bee'), [])
  })
})
