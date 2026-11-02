import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { AgentNode } from '../../src/client/agentTree'
import type { CommsAgent } from '../../src/client/commsModel'
import type { CommsRow } from '../../src/client/fleetDetail'
import type { FleetTeam } from '../../src/client/fleetTeam'
import {
  layoutPulse,
  pulseBinsOf,
  pulseDomainOf,
  pulsePositionOf,
  pulseTimelineRowsOf,
  pulseVisibleLaneIds,
  pulseWorkItemsOf,
} from '../../src/client/pulseModel'

function row(time: number, key = `event-${time}`, to = 'bee', from = 'lead'): CommsRow {
  return { seq: time, time, kind: 'relay', from, text: key, key, to }
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

describe('pulse time model', () => {
  test('positions real timestamps across the domain and centers a single instant', () => {
    const rows = [row(400), row(100), row(250)]
    const domain = pulseDomainOf(rows)
    assert.deepEqual(domain, { start: 100, end: 400 })
    assert.equal(pulsePositionOf(100, domain!), 0)
    assert.equal(pulsePositionOf(250, domain!), 50)
    assert.equal(pulsePositionOf(400, domain!), 100)
    assert.equal(pulsePositionOf(100, pulseDomainOf([row(100)])!), 50)
    assert.equal(pulsePositionOf(100, null), 50)
    assert.equal(pulseDomainOf([]), null)
  })

  test('bins expose bursts without inventing event timestamps', () => {
    const domain = pulseDomainOf([row(0), row(100)])!
    const bins = pulseBinsOf([row(0), row(10), row(11), row(89), row(100)], domain, 5)
    assert.deepEqual(bins.map(bin => bin.count), [3, 0, 0, 0, 2])
    assert.deepEqual(bins.map(bin => [bin.start, bin.end]), [
      [0, 20], [20, 40], [40, 60], [60, 80], [80, 100],
    ])
    assert.deepEqual(pulseBinsOf([row(25)], pulseDomainOf([row(25)])!, 5), [
      { index: 0, start: 25, end: 25, count: 1 },
    ])
    assert.deepEqual(pulseBinsOf([], null), [])
    assert.equal(pulseBinsOf([row(-10), row(50)], domain, 0)[0].count, 2)
  })
})

describe('pulse lane layout', () => {
  test('uses chronological positions and stacks collisions within the recipient lane', () => {
    const layout = layoutPulse([
      row(0, 'a', 'bee'),
      row(1, 'b', 'bee'),
      row(100, 'c', 'bee'),
      row(50, 'd', 'lead', 'bee'),
    ], ['lead', 'bee'], 4)
    assert.deepEqual(layout.lanes.map(lane => [lane.id, lane.top, lane.height]), [
      ['lead', 0, 40],
      ['bee', 40, 54],
    ])
    assert.equal(layout.height, 94)
    assert.deepEqual(layout.points.map(point => [point.key, point.x, point.y, point.level]), [
      ['d', 50, 20, 0],
      ['a', 0, 60, 0],
      ['b', 1, 74, 1],
      ['c', 100, 60, 0],
    ])
    assert.deepEqual(layout.bins.map(bin => bin.count), [2, 0, 1, 1])
    assert.deepEqual(layoutPulse([], ['lead']).lanes, [
      { id: 'lead', top: 0, height: 40, center: 20 },
    ])
    const stacked = layoutPulse([
      row(0, 'b'), row(0, 'a'), row(0.5, 'c'), row(1, 'd'), row(100, 'e'),
    ], ['bee', 'quiet'], 4)
    assert.deepEqual(stacked.points.map(point => [point.key, point.level]), [['a', 0], ['b', 1], ['c', 2], ['d', 3], ['e', 0]])
    assert.deepEqual(stacked.lanes.map(lane => [lane.id, lane.height]), [['bee', 82], ['quiet', 40]])
  })
})

describe('pulse timeline bounds', () => {
  test('defaults to the latest burst, filters by stable starts, and keeps the selected event', () => {
    const rows = Array.from({ length: 250 }, (_, index) => row(index, `event-${index}`))
    const bins = pulseBinsOf(rows, pulseDomainOf(rows), 4)
    const latest = pulseTimelineRowsOf(rows, bins, null, null)
    assert.equal(latest.length, bins[bins.length - 1].count)
    assert.ok(latest.length < rows.length)
    const first = pulseTimelineRowsOf(rows, bins, bins[0].start, 'event-249', 2)
    assert.deepEqual(first.map(row => row.key), ['event-0', 'event-1', 'event-249'])
    const layout = layoutPulse(rows.slice(0, 2), ['bee'], 4, { start: 0, end: 249 })
    assert.deepEqual(layout.domain, { start: 0, end: 249 })
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
