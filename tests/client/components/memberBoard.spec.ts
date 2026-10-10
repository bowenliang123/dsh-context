// MemberBoard — the team roster as full cards: identity, status, model, duty description, latest
// reply, and the owner-filter interlock with the task board.

import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { MemberBoard, type MemberBoardProps } from '../../../src/client/components/memberBoard'
import type { AgentForest, AgentNode } from '../../../src/client/agentTree'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import type { FleetDetail } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

const FOREST: AgentForest = {
  nodes: [
    nodeOf('root', { isCurrent: true, running: true, model: 'deepseek-v4' }),
    nodeOf('w1', { running: true }),
    nodeOf('w2'),
  ],
  edges: [],
  overflow: 0,
  solo: false,
}

function teamOf(): FleetTeam {
  return {
    members: [
      { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
      { id: 'w2', name: 'flaky-one', role: 'teammate', phase: 'failed', error: 'provider blew up' },
      { id: 'w3', name: 'new-joiner', role: 'teammate', phase: 'provisioning' },
    ],
    tasks: [
      { id: 'task-1', subject: 'schema', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
      { id: 'task-2', subject: 'done work', description: '', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
    ],
  }
}

const LEAD_DETAIL: FleetDetail = {
  roster: [
    { name: 'worker-bee', description: '维度2：代码质量', provider: 'spawn', context: 'fresh' },
    { name: 'flaky-one', description: '维度3：稳定性' },
  ],
  messages: [],
  truncated: false,
}

function propsOf(over: Partial<MemberBoardProps> = {}): MemberBoardProps {
  return {
    team: teamOf(),
    forest: FOREST,
    leadDetail: LEAD_DETAIL,
    detailOf: () => undefined,
    pinnedId: null,
    onPin: () => {},
    onHover: () => {},
    onOpen: () => {},
    ownerFilter: null,
    onOwnerFilter: () => {},
    t: kit.t,
    ...over,
  }
}

describe('MemberBoard', () => {
  test('cards render identity, status, duty, model, reply, and task counts', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { lastReply: { time: 100, text: 'schema parser landed' }, messages: [], truncated: false } }],
    ])
    const m = await mount(h(MemberBoard, propsOf({
      detailOf: id => details.get(id),
      pinnedId: 'w1',
    })))
    const cards = queryAll(m.container, '.lc-member-card')
    assert.equal(cards.length, 4)

    const lead = cards[0]
    assert.ok(text(lead).includes('lead'))
    assert.ok(text(lead).includes('current'))
    assert.ok(text(lead).includes('deepseek-v4'))
    assert.ok(text(lead).includes('running'))
    // The lead is the current session: no open button.
    assert.equal(queryAll(lead, '.lc-member-open').length, 0)

    const worker = cards[1]
    assert.ok(worker.className.includes('lc-member-pinned'))
    assert.ok(text(worker).includes('维度2：代码质量'))
    assert.ok(text(worker).includes('schema parser landed'))
    assert.ok(text(worker).includes('1 active tasks'))
    // The completed task does not count toward the active chip.

    const flaky = cards[2]
    assert.ok(flaky.className.includes('lc-member-failed'))
    assert.ok(text(flaky).includes('provider blew up'))

    const joiner = cards[3]
    assert.ok(text(joiner).includes('provisioning'))
    assert.ok(text(joiner).includes('no active tasks'))
    await m.unmount()
  })

  test('card click pins, task chip filters the board, open jumps', async () => {
    const pins = new Array<string | null>()
    const opened = new Array<string>()
    const hovers = new Array<string | null>()
    // The owner filter is a controlled prop: the wrapper plays the view, holding its state.
    let ownerFilter: string | null = null
    const filters = new Array<string | null>()
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        ownerFilter,
        onPin: id => { pins.push(id) },
        onOwnerFilter: (name) => {
          ownerFilter = name
          filters.push(name)
        },
        onOpen: id => { opened.push(id) },
        onHover: id => { hovers.push(id) },
      }))
    }
    const m = await mount(h(Controlled))
    const worker = queryAll(m.container, '.lc-member-card')[1]
    await hover(worker)
    await click(worker)
    await unhover(worker)
    assert.deepEqual([...pins], ['w1'])
    assert.deepEqual([...hovers], ['w1', null])

    // The task chip filters without disturbing the pin; a re-click clears (controlled state).
    await click(query(worker, '.lc-member-tasks'))
    assert.deepEqual([...pins], ['w1'])
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee'])
    assert.ok(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks').className.includes('lc-member-tasks-on'))
    await click(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks'))
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee', null])

    await click(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-open'))
    assert.deepEqual([...opened], ['w1'])
    assert.deepEqual([...pins], ['w1'], 'open never pins')
    await m.unmount()
  })

  test('clicking the pinned card releases the pin', async () => {
    const pins = new Array<string | null>()
    const m = await mount(h(MemberBoard, propsOf({ pinnedId: 'w1', onPin: id => { pins.push(id) } })))
    const pinned = queryAll(m.container, '.lc-member-card')[1]
    await click(pinned)
    assert.deepEqual([...pins], [null])
    await m.unmount()
  })

  test('keyboard pins; the failure badge and an empty roster render', async () => {
    const pins = new Array<string | null>()
    // The pin is a controlled prop: the wrapper plays the view, holding its state.
    let pinned: string | null = 'w1'
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        team: { ...teamOf(), failure: 'bad row' },
        pinnedId: pinned,
        onPin: (id) => {
          pins.push(id)
          pinned = id
        },
      }))
    }
    const m = await mount(h(Controlled))
    assert.ok(text(m.container).includes(DICT_EN['fleet.team.failureShort']))
    // The card starts pinned (w1): Enter releases, Space re-pins, an unrelated key is inert.
    const card = (): HTMLElement => queryAll(m.container, '.lc-member-card')[1]
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })) })
    assert.deepEqual([...pins], [null, 'w1'])
    await m.unmount()
  })

  test('model falls back to the descriptor when the node lists none; a member outside the forest renders bare', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { descriptor: { mode: 'continuable', label: 'w', agentModel: 'flash-lite' }, messages: [], truncated: false } }],
    ])
    const forest: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], overflow: 0, solo: false }
    const m = await mount(h(MemberBoard, propsOf({
      forest,
      detailOf: id => details.get(id),
      leadDetail: null,
    })))
    const cards = queryAll(m.container, '.lc-member-card')
    // No roster facts: no duty descriptions; the descriptor model stands in.
    assert.ok(text(cards[1]).includes('flash-lite'))
    assert.equal(queryAll(cards[1], '.lc-member-desc').length, 0)
    // Members without a forest node get no open button.
    assert.equal(queryAll(m.container, '.lc-member-open').length, 0)
    await m.unmount()
  })
})
