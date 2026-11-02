import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { AgentNode } from '../../src/client/agentTree'
import type { CommsAgent } from '../../src/client/commsModel'
import type { CommsRow, FleetDelegationRow } from '../../src/client/fleetDetail'
import type { FleetTeam } from '../../src/client/fleetTeam'
import {
  layoutPulse,
  pulseTimelineItemsOf,
  pulseVisibleLaneIds,
  pulseWorkItemsOf,
} from '../../src/client/pulseModel'

function row(time: number, key = `event-${time}`, to = 'bee', from = 'lead'): CommsRow {
  return { seq: time, time, kind: 'relay', from, text: key, key, to }
}

function delegation(time: number, key: string, to = 'bee', from = 'lead'): FleetDelegationRow {
  return { key, time, seq: time, to, from, mode: 'continuable', label: `Initial ${key}` }
}

function agent(id: string, name = id): CommsAgent {
  return { id, name, role: 'subagent', self: false, hue: 'red' }
}

function node(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    label: id,
    depth: 1,
    family: 1,
    isCurrent: false,
    running: false,
    completed: false,
    subagent: true,
    updatedAt: 1,
    head: null,
    billed: null,
    costUsage: null,
    durationMs: null,
    identity: null,
    requests: 0,
    ...over,
  }
}

describe('pulse timeline records', () => {
  test('orders messages and durable delegations naturally without inventing records', () => {
    const items = pulseTimelineItemsOf(
      [row(400), row(100), row(250)],
      [delegation(150, 'create-side', 'side'), delegation(100, 'create-bee')],
    )
    assert.deepEqual(items.map(item => [item.key, item.kind]), [
      ['create-bee', 'delegation'],
      ['event-100', 'message'],
      ['create-side', 'delegation'],
      ['event-250', 'message'],
      ['event-400', 'message'],
    ])
    assert.equal(items[0].from, 'lead')
    assert.equal(items[0].to, 'bee')
    assert.deepEqual(pulseTimelineItemsOf([], []), [])
  })

  test('uses deterministic ordering within equal timestamps and record kinds', () => {
    const items = pulseTimelineItemsOf(
      [row(100, 'event-b'), row(100, 'event-a')],
      [delegation(100, 'create-b'), delegation(100, 'create-a')],
    )
    assert.deepEqual(items.map(item => item.key), ['create-a', 'create-b', 'event-a', 'event-b'])
    assert.deepEqual(pulseTimelineItemsOf([row(50, 'early')], [delegation(100, 'later')]).map(item => item.key), ['early', 'later'])
  })
})

describe('pulse lane layout', () => {
  test('uses fixed natural-order slots and one baseline per lane', () => {
    const items = pulseTimelineItemsOf([
      row(0, 'a', 'bee'),
      row(1, 'b', 'bee'),
      row(100, 'c', 'bee'),
      row(50, 'd', 'lead', 'bee'),
    ], [])
    const layout = layoutPulse(items, ['lead', 'bee'])
    assert.deepEqual(layout.lanes.map(lane => [lane.id, lane.top, lane.height, lane.center]), [
      ['lead', 0, 56, 28],
      ['bee', 56, 56, 84],
    ])
    assert.equal(layout.height, 112)
    assert.equal(layout.width, 168)
    assert.deepEqual(layout.points.map(point => [point.key, point.x, point.y]), [
      ['a', 36, 84],
      ['b', 68, 84],
      ['d', 100, 28],
      ['c', 132, 84],
    ])
    assert.deepEqual(layoutPulse([], ['lead']), {
      width: 40,
      lanes: [{ id: 'lead', top: 0, height: 56, center: 28 }],
      points: [],
      height: 56,
    })
    assert.equal(layoutPulse(pulseTimelineItemsOf([row(1, 'hidden', 'outside')], []), ['bee']).points.length, 0)
  })

  test('keeps the complete sequence available for horizontal scrolling', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index, `event-${index}`))
    const layout = layoutPulse(pulseTimelineItemsOf(rows, []), ['bee'])
    assert.equal(layout.points.length, 500)
    assert.equal(layout.width, 16_040)
    assert.equal(layout.points[499].x, 16_004)
    const window = layoutPulse(pulseTimelineItemsOf(rows.slice(490), []), ['bee'], 500, 490)
    assert.equal(window.points.length, 10)
    assert.equal(window.points[0].x, 15_716)
    assert.equal(window.points[9].x, 16_004)
    assert.equal(window.width, 16_040)
  })
})

describe('pulse lane visibility', () => {
  const lanes = Array.from({ length: 10 }, (_, index) => ({
    agent: agent(`a${index}`, `Agent ${index}`),
    active: index === 1,
  }))

  test('keeps active, communicating, selected, and search-matching lanes when quiet lanes fold', () => {
    const rows = [row(1, 'traffic', 'a2', 'a3')]
    assert.deepEqual(pulseVisibleLaneIds(lanes, rows, null, '', false), ['a1', 'a2', 'a3'])
    assert.deepEqual(pulseVisibleLaneIds(lanes, rows, 'a4', 'agent 5', false), ['a1', 'a2', 'a3', 'a4', 'a5'])
    assert.deepEqual(pulseVisibleLaneIds(lanes, rows, null, '', true), lanes.map(lane => lane.agent.id))
    const described = lanes.map(lane => ({ ...lane, agent: { ...lane.agent } }))
    described[8].agent.description = 'special duty'
    assert.deepEqual(pulseVisibleLaneIds(described, rows, null, 'special', false), ['a1', 'a2', 'a3', 'a8'])
  })

  test('small fleets never lose quiet lanes', () => {
    const small = lanes.slice(0, 3)
    assert.deepEqual(pulseVisibleLaneIds(small, [], null, '', false), ['a0', 'a1', 'a2'])
  })
})

describe('pulse work queue', () => {
  test('combines team tasks with only non-team delegations and resolves owner selection', () => {
    const team: FleetTeam = {
      members: [
        { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'bee', name: 'worker-bee', role: 'teammate', phase: 'active' },
      ],
      tasks: [{
        id: 'task-1',
        subject: 'Parse schema',
        description: 'All of it',
        status: 'in_progress',
        ownerName: 'worker-bee',
        blockedBy: ['task-0'],
        writeScopes: [],
        ready: false,
        warnings: [],
      }],
    }
    const forest = {
      solo: false,
      edges: [],
      nodes: [
        node('root', { isCurrent: true, subagent: false }),
        node('bee', { running: true }),
        node('side', { label: 'side-quest', completed: true }),
      ],
    }
    assert.deepEqual(pulseWorkItemsOf(forest, team), [
      {
        key: 'team:task-1',
        id: 'task-1',
        kind: 'team',
        subject: 'Parse schema',
        status: 'in_progress',
        ownerId: 'bee',
        ownerName: 'worker-bee',
        description: 'All of it',
        blockedBy: ['task-0'],
        writeScopes: [],
        warnings: [],
        ready: false,
      },
      {
        key: 'agent:side',
        id: 'side',
        kind: 'agent',
        subject: 'side-quest',
        status: 'latest_complete',
        ownerId: 'side',
        ownerName: 'side-quest',
        blockedBy: [],
        writeScopes: [],
        warnings: [],
        ready: false,
      },
    ])
  })

  test('keeps unowned tasks and idle delegations distinct and handles an empty model', () => {
    const team: FleetTeam = {
      members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }],
      tasks: [
        { id: 'done', subject: 'Done', description: '', status: 'completed', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
        { id: 'open', subject: 'Open', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      ],
    }
    const forest = { solo: false, edges: [], nodes: [node('root', { isCurrent: true }), node('idle')] }
    const items = pulseWorkItemsOf(forest, team)
    assert.deepEqual(items.map(item => [item.key, item.status]), [['team:open', 'pending'], ['agent:idle', 'idle'], ['team:done', 'completed']])
    assert.equal(items[0].ownerId, undefined)
    assert.equal(items[0].description, undefined)
    assert.deepEqual(pulseWorkItemsOf(null, null), [])
  })
})
