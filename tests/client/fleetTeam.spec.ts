import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import {
  memberIdByName,
  taskOwnerIdOf,
  tasksOfOwnerId,
  teammateNameOf,
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
  test('a well-formed projection parses whole; optional fields stay absent rather than materializing empty', () => {
    const team = teamOf(teamValue({ failure: 'bad record' }))
    assert.ok(team !== null)
    assert.equal(team.members.length, 3)
    assert.equal(team.tasks.length, 4)
    assert.equal(team.failure, 'bad record')
    assert.deepEqual(team.tasks[1].warnings, ['overlap with task-3'])

    const bare = teamOf({ members: [{ id: 'r', name: 'lead', role: 'lead', phase: 'active' }] })
    assert.ok(bare !== null)
    assert.equal(bare.members[0].error, undefined)
    assert.equal(bare.failure, undefined)
    assert.deepEqual(bare.tasks, [])

    const modern = teamOf({
      enabled: true,
      tasks: [{ id: 'task-7', subject: 'modern', description: '', status: 'pending', ownerId: 'w1', blockedBy: [], writeScopes: [], ready: true }],
    })
    assert.ok(modern !== null)
    assert.deepEqual(modern.members, [])
    assert.equal(modern.tasks[0].ownerId, 'w1')
    assert.equal(modern.tasks[0].subject, 'modern')
    assert.deepEqual(teamOf({ tasks: [] })?.tasks, [])
    assert.equal(teamOf({ enabled: false, tasks: [] }), null)

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

})

describe('fleetTeam helpers', () => {
  const team = teamOf(teamValue()) as FleetTeam

  test('the helpers join by id and by name, name teammates only, and keep board order', () => {
    assert.equal(teamMemberOf(team, 'w1')?.name, 'worker-bee')
    assert.equal(teamMemberOf(team, 'nobody'), null)
    assert.equal(teamMemberOf(null, 'w1'), null)
    const current = { isCurrent: true, id: 'w1' } as never
    const teammate = { isCurrent: false, id: 'w1' } as never
    const lead = { isCurrent: false, id: 'root' } as never
    const outsider = { isCurrent: false, id: 's9' } as never
    assert.equal(teammateNameOf(team, teammate), 'worker-bee')
    assert.equal(teammateNameOf(team, current), undefined)
    assert.equal(teammateNameOf(team, lead), undefined, 'the lead card keeps the session title')
    assert.equal(teammateNameOf(team, outsider), undefined)
    assert.equal(teammateNameOf(null, teammate), undefined)
    assert.equal(memberIdByName(team, 'worker-bee'), 'w1')
    assert.equal(memberIdByName(team, 'ghost'), undefined)
    assert.equal(memberIdByName(team, undefined), undefined)
    assert.equal(memberIdByName(null, 'worker-bee'), undefined)
    assert.equal(taskOwnerIdOf(team, team.tasks[0]), 'w1')
    assert.deepEqual(tasksOfOwnerId(team, 'w1').map(task => task.id), ['task-1', 'task-2'])
    assert.deepEqual(tasksOfOwnerId(team, 'nobody'), [])
    assert.deepEqual(tasksOfOwnerId(null, 'w1'), [])
  })
})
