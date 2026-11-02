import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { LEAD_HUE, familyHue, type AgentNode } from '../../src/client/agentTree'
import { agentResolverOf, attestedNamesOf, commsAgentsOf, fallbackAgentOf } from '../../src/client/fleetAgents'
import { NAME_PARTY_PREFIX, NEUTRAL_HUE, UNKNOWN_PARTY } from '../../src/client/commsModel'
import type { CommsRow } from '../../src/client/fleetDetail'
import type { FleetTeam } from '../../src/client/fleetTeam'
import type { FleetMemberInfo } from '../../src/shared/types'
import { makeKit } from './helpers/kit'

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

function commsRow(over: Partial<CommsRow> & { key: string; to: string; time: number; text: string }): CommsRow {
  return { seq: 1, kind: 'relay', ...over }
}

describe('attestedNamesOf', () => {
  test('the newest name per sender wins; a row needs both an id and a name', () => {
    const names = attestedNamesOf([
      commsRow({ key: '1', to: 'a', time: 4, text: 'x', from: 'w1', fromName: 'host-cleaner' }),
      commsRow({ key: '2', to: 'a', time: 3, text: 'x', from: 'w1', fromName: 'renamed' }),
      commsRow({ key: '3', to: 'a', time: 2, text: 'x', fromName: 'legacy' }),
      commsRow({ key: '4', to: 'a', time: 1, text: 'x', from: 'w2' }),
      commsRow({ key: '5', to: 'a', time: 0, text: 'x' }),
    ])
    assert.deepEqual([...names.entries()], [['w1', 'host-cleaner']])
  })
})

const TEAM: FleetTeam = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    { id: 'w3', name: 'tests-a', role: 'teammate', phase: 'active' },
    { id: 'w9', name: 'ghost-nine', role: 'teammate', phase: 'active' },
    { id: 'w10', name: 'ghost-plain', role: 'teammate', phase: 'active' },
    { id: 'w6', name: 'w6', role: 'teammate', phase: 'active' },
    { id: 'remote-lead', name: 'lead', role: 'lead', phase: 'active' },
  ],
  tasks: [],
}

const ROSTER: FleetMemberInfo[] = [
  { name: 'worker-bee', description: 'schema duty' },
  { name: 'tests-a', description: 'tests-a' },
  { name: 'ghost-nine', description: 'ghost duty' },
  { name: 'ghost-plain', description: '' },
  { name: 'w6', description: '' },
]

describe('commsAgentsOf — team branch', () => {
  test('roster names, duties, and the lead hue resolve over attested names and node labels', () => {
    const agents = commsAgentsOf(
      [
        nodeOf('root', { label: 'Main Agent', isCurrent: true }),
        nodeOf('w1', { label: 'worker-duty', family: 1 }),
        nodeOf('w2', { label: 'side-quest', family: 2 }),
        nodeOf('w3', { label: 'tests-a', family: 3 }),
        nodeOf('w4', { label: 'cold-scout', family: 4 }),
        nodeOf('w6', { label: 'w6', family: 6 }),
      ],
      TEAM,
      ROSTER,
      new Map([
        ['root', 'lead'],
        ['w1', 'bee'],
        ['w2', 'side-quest'],
        ['w3', 'tests-a'],
        ['w9', 'ghost-attested'],
      ]),
      kit.t,
    )
    assert.deepEqual(agents.get('root'), {
      id: 'root', name: 'Lead', role: 'lead', self: true, hue: LEAD_HUE, initials: 'LE2', description: 'Main Agent',
    })
    assert.deepEqual(agents.get('w1'), {
      id: 'w1', name: 'worker-bee', role: 'teammate', self: false, hue: familyHue(1), initials: 'WB', description: 'schema duty',
    })
    assert.deepEqual(agents.get('w2'), {
      id: 'w2', name: 'side-quest', role: 'teammate', self: false, hue: familyHue(2), initials: 'SQ',
    })
    assert.deepEqual(agents.get('w3'), {
      id: 'w3', name: 'tests-a', role: 'teammate', self: false, hue: familyHue(2), initials: 'TA',
    })
    assert.deepEqual(agents.get('w4'), {
      id: 'w4', name: 'cold-scout', role: 'subagent', self: false, hue: familyHue(4), initials: 'CS',
    })
    assert.deepEqual(agents.get('w6'), {
      id: 'w6', name: 'w6', role: 'teammate', self: false, hue: familyHue(5), initials: 'W6',
    })
    assert.deepEqual(agents.get('w9'), {
      id: 'w9', name: 'ghost-nine', role: 'teammate', self: false, hue: familyHue(3), initials: 'GN', description: 'ghost duty',
    })
    assert.deepEqual(agents.get('w10'), {
      id: 'w10', name: 'ghost-plain', role: 'teammate', self: false, hue: familyHue(4), initials: 'GP',
    })
    assert.deepEqual(agents.get('remote-lead'), {
      id: 'remote-lead', name: 'Lead', role: 'lead', self: false, hue: LEAD_HUE, initials: 'LE1',
    })
  })
})

describe('commsAgentsOf — no team', () => {
  test('attested leads and teammates, current agents, and plain subagents all resolve', () => {
    const agents = commsAgentsOf(
      [
        nodeOf('root', { label: 'Main Agent', isCurrent: true, family: 0 }),
        nodeOf('w2', { label: 'side-quest', family: 2 }),
        nodeOf('w3', { label: 'side-quest', family: 3 }),
        nodeOf('w4', { label: 'cold-scout', family: 4 }),
        nodeOf('solo', { label: 'Solo session', isCurrent: true, family: 0 }),
      ],
      null,
      undefined,
      new Map([
        ['root', 'lead'],
        ['w2', 'scout'],
        ['w3', 'side-quest'],
      ]),
      kit.t,
    )
    assert.deepEqual(agents.get('root'), {
      id: 'root', name: 'Lead', role: 'lead', self: true, hue: LEAD_HUE, initials: 'LE', description: 'Main Agent',
    })
    assert.deepEqual(agents.get('w2'), {
      id: 'w2', name: 'scout', role: 'teammate', self: false, hue: familyHue(2), initials: 'SC', description: 'side-quest',
    })
    assert.deepEqual(agents.get('w3'), {
      id: 'w3', name: 'side-quest', role: 'teammate', self: false, hue: familyHue(3), initials: 'SQ',
    })
    assert.deepEqual(agents.get('w4'), {
      id: 'w4', name: 'cold-scout', role: 'subagent', self: false, hue: familyHue(4), initials: 'CS',
    })
    assert.deepEqual(agents.get('solo'), {
      id: 'solo', name: 'Solo session', role: 'agent', self: true, hue: LEAD_HUE, initials: 'SS',
    })
  })
})

describe('fallback identity', () => {
  const titles = new Map([['session-titled', 'Titled Session']])
  const attested = new Map([['session-attested', 'legacy-worker']])

  test('a mailbox name, an attested id, a session title, an unknown party, and a short id each resolve', () => {
    assert.deepEqual(fallbackAgentOf(NAME_PARTY_PREFIX + 'Bee', titles, attested, kit.t), {
      id: NAME_PARTY_PREFIX + 'Bee', name: 'Bee', role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('session-attested', titles, attested, kit.t), {
      id: 'session-attested', name: 'legacy-worker', role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('session-titled', titles, attested, kit.t), {
      id: 'session-titled', name: 'Titled Session', role: 'other', self: false, hue: NEUTRAL_HUE,
      description: 'session-titled',
    })
    assert.deepEqual(fallbackAgentOf(UNKNOWN_PARTY, titles, attested, kit.t), {
      id: UNKNOWN_PARTY, name: kit.t('fleet.comms.unknown'), role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    assert.deepEqual(fallbackAgentOf('deadbeef-0000-1111-2222-333333333333', titles, attested, kit.t), {
      id: 'deadbeef-0000-1111-2222-333333333333', name: kit.t('fleet.comms.agentId', { id: 'deadbeef…' }), role: 'other', self: false, hue: NEUTRAL_HUE,
    })
    const known = new Map([['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: LEAD_HUE }]])
    const resolve = agentResolverOf(known, titles, attested, kit.t)
    assert.equal(resolve('root').name, 'Lead')
    assert.equal(resolve('session-attested').name, 'legacy-worker')
  })
})
