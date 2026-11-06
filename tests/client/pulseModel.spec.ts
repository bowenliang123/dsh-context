import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import type { AgentNode } from '../../src/client/agentTree'
import type { CommsAgent } from '../../src/client/commsModel'
import type { CommsRow, FleetDelegationRow } from '../../src/client/fleetDetail'
import type { FleetTeam } from '../../src/client/fleetTeam'
import {
  layoutPulse,
  pulseDependencyChainOf,
  pulseEventGroupOf,
  pulseEventItemsOf,
  pulseEventMatchesOf,
  pulseLaneVisibility,
  pulseTaskBadgeOf,
  pulseTaskLaneIdsOf,
  pulseTasksByAgent,
  pulseTimelineItemsOf,
  pulseWorkGroupsOf,
  pulseWorkItemsOf,
  pulseWorkPhaseOf,
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

  test('the event stream reverses the natural order and groups and matches per kind', () => {
    const settledRow = { ...row(400, 'event-400'), kind: 'settled' as const, summary: 'it finished', report: 'all done' }
    const items = pulseEventItemsOf(
      [settledRow, row(100), row(250)],
      [delegation(150, 'create-side', 'side'), delegation(300, 'create-bee')],
    )
    assert.deepEqual(items.map(item => item.key), ['event-400', 'create-bee', 'event-250', 'create-side', 'event-100'])
    assert.deepEqual(items.map(item => pulseEventGroupOf(item)), ['report', 'delegation', 'message', 'delegation', 'message'])
    assert.deepEqual(pulseEventMatchesOf(items[0]), ['event-400', 'it finished', 'all done'])
    assert.deepEqual(pulseEventMatchesOf(items[1]), ['Initial create-bee'])
    assert.deepEqual(pulseEventMatchesOf(items[2]), ['event-250', undefined, undefined])
    assert.deepEqual(
      pulseEventItemsOf([row(100, 'b'), row(100, 'a')], []).map(item => item.key),
      ['a', 'b'],
    )
    assert.deepEqual(
      pulseEventItemsOf([row(100, 'a'), row(100, 'b')], []).map(item => item.key),
      ['a', 'b'],
    )
    assert.deepEqual(pulseEventItemsOf([], []), [])
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
      ['lead', 0, 68, 34],
      ['bee', 68, 68, 102],
    ])
    assert.equal(layout.height, 136)
    assert.equal(layout.width, 144)
    assert.deepEqual(layout.points.map(point => [point.key, point.x, point.y]), [
      ['a', 24, 102],
      ['b', 56, 102],
      ['d', 88, 34],
      ['c', 120, 102],
    ])
    assert.deepEqual(layoutPulse([], ['lead']), {
      width: 16,
      lanes: [{ id: 'lead', top: 0, height: 68, center: 34 }],
      points: [],
      height: 68,
    })
    assert.equal(layoutPulse(pulseTimelineItemsOf([row(1, 'hidden', 'outside')], []), ['bee']).points.length, 0)
  })

  test('keeps the complete sequence available for horizontal scrolling', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index, `event-${index}`))
    const layout = layoutPulse(pulseTimelineItemsOf(rows, []), ['bee'])
    assert.equal(layout.points.length, 500)
    assert.equal(layout.width, 16_016)
    assert.equal(layout.points[499].x, 15_992)
    const window = layoutPulse(pulseTimelineItemsOf(rows.slice(490), []), ['bee'], 500, 490)
    assert.equal(window.points.length, 10)
    assert.equal(window.points[0].x, 15_704)
    assert.equal(window.points[9].x, 15_992)
    assert.equal(window.width, 16_016)
  })
})

describe('pulse lane visibility', () => {
  const lanes = Array.from({ length: 10 }, (_, index) => ({
    agent: agent(`a${index}`, `Agent ${index}`),
    active: index === 1,
  }))

  test('folds quiet lanes around active traffic', () => {
    const rows = [row(1, 'traffic', 'a2', 'a3')]
    assert.deepEqual(pulseLaneVisibility(lanes, rows, [], null, '', false).visible, ['a1', 'a2', 'a3'])
    assert.deepEqual(pulseLaneVisibility(lanes, rows, [], null, '', true).visible, lanes.map(lane => lane.agent.id))
    assert.equal(pulseLaneVisibility(lanes, rows, [], null, '', false).matched.size, 0)
    assert.equal(pulseLaneVisibility(lanes, rows, [], null, '', true).matched.size, 0)
  })

  test('a selected agent keeps only itself and its directly linked lanes', () => {
    assert.deepEqual(pulseLaneVisibility(lanes, [], [], 'a4', '', false).visible, ['a4'])
    const links = [
      { from: 'a4', to: 'a7' },
      { from: 'a2', to: 'a4' },
      { from: 'a0', to: 'a1' },
    ]
    assert.deepEqual(pulseLaneVisibility(lanes, [], links, 'a4', '', false).visible, ['a2', 'a4', 'a7'])
    assert.deepEqual(pulseLaneVisibility(lanes.slice(0, 3), [], [], 'a1', '', false).visible, ['a1'])
  })

  test('a search keeps the matched lanes and the lanes linked to them', () => {
    const described = lanes.map(lane => ({ ...lane, agent: { ...lane.agent } }))
    described[8].agent.description = 'special duty'
    const links = [
      { from: 'a8', to: 'a6' },
      { from: 'a3', to: 'a8' },
      { from: 'a0', to: 'a1' },
    ]
    const special = pulseLaneVisibility(described, [], links, null, 'special', false)
    assert.deepEqual(special.visible, ['a3', 'a6', 'a8'])
    assert.deepEqual([...special.matched], ['a8'])
    const byName = pulseLaneVisibility(described, [], links, null, 'agent 5', false)
    assert.deepEqual(byName.visible, ['a5'])
    assert.deepEqual([...byName.matched], ['a5'])
    const unmatched = pulseLaneVisibility(described, [], links, null, 'nobody', false)
    assert.deepEqual(unmatched.visible, [])
    assert.equal(unmatched.matched.size, 0)
  })

  test('a lane search stays inside the related lanes of a selected agent', () => {
    const described = lanes.map(lane => ({ ...lane, agent: { ...lane.agent } }))
    described[8].agent.description = 'special duty'
    const links = [
      { from: 'a8', to: 'a6' },
      { from: 'a3', to: 'a8' },
      { from: 'a0', to: 'a1' },
    ]
    const focused = pulseLaneVisibility(described, [], links, 'a3', 'special', false)
    assert.deepEqual(focused.visible, ['a3', 'a8'])
    assert.deepEqual([...focused.matched], ['a8'])
    const outside = pulseLaneVisibility(described, [], links, 'a3', 'agent 5', false)
    assert.deepEqual(outside.visible, [])
  })

  test('small fleets never lose quiet lanes', () => {
    const small = lanes.slice(0, 3)
    assert.deepEqual(pulseLaneVisibility(small, [], [], null, '', false).visible, ['a0', 'a1', 'a2'])
  })
})

describe('pulse task lanes', () => {
  const team: FleetTeam = {
    members: [
      { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'bee', name: 'worker-bee', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      { id: 'task-1', subject: 'Parse schema', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      { id: 'task-2', subject: 'Scan docs', description: '', status: 'pending', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
    ],
  }
  const tasksByAgent = pulseTasksByAgent(team)

  test('collects both endpoints of the records the filtered task owns, and nothing else', () => {
    const items = pulseTimelineItemsOf(
      [row(400, 'reply', 'lead', 'side'), row(300, 'note', 'side', 'bee'), row(200, 'aside', 'side', 'side')],
      [delegation(100, 'create-bee')],
    )
    assert.equal(pulseTaskLaneIdsOf(items, tasksByAgent, null), null)
    assert.deepEqual([...pulseTaskLaneIdsOf(items, tasksByAgent, 'task-1')!], ['lead', 'bee', 'side'])
    assert.deepEqual([...pulseTaskLaneIdsOf(items, tasksByAgent, 'task-2')!], ['side', 'lead'])
    assert.equal(pulseTaskLaneIdsOf(items, tasksByAgent, 'task-9')!.size, 0)
    assert.equal(pulseTaskLaneIdsOf([], tasksByAgent, 'task-1')!.size, 0)
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
        ownerState: 'running',
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
        ownerState: 'latest_complete',
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

  test('modern ownerId tasks need no roster, keep one row per owner, and do not promote ordinary sessions to completed', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [{
        id: 'task-7',
        subject: 'Modern owner',
        description: '',
        status: 'in_progress',
        ownerId: 'bee',
        blockedBy: [],
        writeScopes: [],
        ready: false,
        warnings: [],
      }],
    }
    const forest = {
      solo: false,
      edges: [],
      nodes: [
        node('root', { isCurrent: false, subagent: false, completed: true, label: 'root' }),
        node('bee', { running: true, label: 'worker-bee', model: 'deepseek-flash', reasoningEffort: 'low' }),
        node('idle', { label: 'idle-one' }),
      ],
    }
    const items = pulseWorkItemsOf(forest, team)
    assert.deepEqual(items.map(item => [item.key, item.ownerId, item.ownerState]), [
      ['team:task-7', 'bee', 'running'],
      ['agent:root', 'root', 'idle'],
      ['agent:idle', 'idle', 'idle'],
    ])
    assert.equal(items[0].ownerName, 'worker-bee')
    assert.equal(items[0].ownerModel, 'deepseek-flash (low)')
    assert.deepEqual([...pulseTasksByAgent(team).keys()], ['bee'])
    assert.deepEqual(pulseTasksByAgent(team).get('bee')?.map(task => task.id), ['task-7'])
  })

  test('groups owners in first-seen order with unowned last, normalizes phases, and walks the full dependency chain', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [
        { id: 'task-1', subject: 'A', description: '', status: 'pending', ownerId: 'a', blockedBy: ['task-2'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-2', subject: 'B', description: '', status: 'completed', ownerId: 'b', blockedBy: ['task-3'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-3', subject: 'C', description: '', status: 'completed', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
      ],
    }
    const items = pulseWorkItemsOf({ solo: false, edges: [], nodes: [] }, team)
    assert.deepEqual(pulseWorkGroupsOf(items).map(group => [group.key, group.items.length]), [
      ['id:a', 1],
      ['id:b', 1],
      ['unowned', 1],
    ])
    assert.equal(pulseWorkPhaseOf(items.find(item => item.id === 'task-1')!), 'pending')
    assert.equal(pulseWorkPhaseOf(items.find(item => item.id === 'task-2')!), 'completed')
    assert.deepEqual([...pulseDependencyChainOf(items, 'task-1')].sort(), ['task-2', 'task-3'])
    assert.equal(pulseTaskBadgeOf('task-12'), '12')
    assert.equal(pulseTaskBadgeOf('task-alpha'), 'task-alpha')
    assert.equal(pulseTaskBadgeOf('free'), 'free')
  })

  test('dependency walk tolerates missing blockers and cycles without inventing nodes', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [
        { id: 'task-c', subject: 'C', description: '', status: 'pending', blockedBy: ['task-d'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-d', subject: 'D', description: '', status: 'pending', blockedBy: ['task-c', 'ghost'], writeScopes: [], ready: false, warnings: [] },
      ],
    }
    const items = pulseWorkItemsOf(null, team)
    assert.deepEqual([...pulseDependencyChainOf(items, 'task-c')].sort(), ['ghost', 'task-c', 'task-d'])
    assert.deepEqual([...pulseDependencyChainOf(items, 'missing')], [])
  })
})
