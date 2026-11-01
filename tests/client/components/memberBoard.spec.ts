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

async function typeIn(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function selectIn(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

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
    nodeOf('s1', { label: 'scout', running: true, model: 'deepseek-flash', reasoningEffort: 'max', head: { tokens: 800, window: 1000, pct: 80, parts: [] }, requests: 5, durationMs: 42000, updatedAt: 8 }),
    nodeOf('s2', { label: 'archivist', completed: true, head: { tokens: 200, window: 1000, pct: 20, parts: [] }, requests: 1, durationMs: 9000, updatedAt: 6 }),
    nodeOf('s3', { label: 'lounger', updatedAt: 4 }),
  ],
  edges: [],
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
    onEnter: () => {},
    onOpen: () => {},
    ownerFilter: null,
    onOwnerFilter: () => {},
    t: kit.t,
    fmt: kit.fmt,
    ...over,
  }
}

describe('MemberBoard — team cards', () => {
  test('cards render identity, status, duty, model, reply, and task counts', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { lastReply: { time: 100, text: 'schema parser landed' }, messages: [], truncated: false } }],
    ])
    const m = await mount(h(MemberBoard, propsOf({
      detailOf: id => details.get(id),
      pinnedId: 'w1',
    })))
    const cards = queryAll(m.container, '.lc-member-card')
    assert.equal(cards.length, 7)

    const lead = cards[0]
    assert.ok(text(lead).includes('lead'))
    assert.ok(text(lead).includes('current'))
    assert.ok(text(lead).includes('deepseek-v4'))
    assert.ok(text(lead).includes('running'))
    assert.equal(queryAll(lead, '.lc-member-opens').length, 0)
    const leadAvatar = query(lead, '.lc-comms-avatar')
    assert.equal(text(leadAvatar), 'LE')
    assert.ok(leadAvatar?.className.includes('lc-comms-avatar-self'), 'the current member wears the self ring')
    assert.ok(leadAvatar?.getAttribute('style')?.includes('--lc-comms-hue'))

    const worker = cards[1]
    assert.ok(worker.className.includes('lc-member-pinned'))
    assert.ok(text(worker).includes('维度2：代码质量'))
    assert.ok(text(worker).includes('schema parser landed'))
    assert.ok(text(worker).includes('1 active tasks'))
    assert.equal(text(query(worker, '.lc-comms-avatar')), 'WB')

    const flaky = cards[2]
    assert.ok(flaky.className.includes('lc-member-failed'))
    assert.ok(text(flaky).includes('provider blew up'))

    const joiner = cards[3]
    assert.ok(text(joiner).includes('provisioning'))
    assert.ok(text(joiner).includes('no active tasks'))
    await m.unmount()
  })

  test('card click pins, task chip filters the board, the enter and aside buttons navigate', async () => {
    const pins = new Array<string | null>()
    const entered = new Array<string>()
    const opened = new Array<string>()
    const hovers = new Array<string | null>()
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
        onEnter: id => { entered.push(id) },
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

    await click(query(worker, '.lc-member-tasks'))
    assert.deepEqual([...pins], ['w1'])
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee'])
    assert.ok(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks').className.includes('lc-member-tasks-on'))
    await click(query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-tasks'))
    await m.update(h(Controlled))
    assert.deepEqual([...filters], ['worker-bee', null])

    const foot = query(queryAll(m.container, '.lc-member-card')[1], '.lc-member-opens')
    await click(query(foot, '.lc-member-aside'))
    assert.deepEqual([...opened], ['w1'])
    await click(query(foot, '.lc-member-enter'))
    assert.deepEqual([...entered], ['w1'])
    assert.deepEqual([...pins], ['w1'], 'neither button pins')
    await m.unmount()
  })

  test('keyboard picks report the id; the failure badge and an empty roster render', async () => {
    const pins = new Array<string>()
    let pinned: string | null = 'w1'
    function Controlled(): ReactElement {
      return h(MemberBoard, propsOf({
        team: { ...teamOf(), failure: 'bad row' },
        pinnedId: pinned,
        onPin: (id) => {
          pins.push(id)
          pinned = pinned === id ? null : id
        },
      }))
    }
    const m = await mount(h(Controlled))
    assert.ok(text(m.container).includes(DICT_EN['fleet.team.failureShort']))
    const card = (): HTMLElement => queryAll(m.container, '.lc-member-card')[1]
    assert.equal(card().getAttribute('aria-pressed'), 'true')
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    assert.equal(card().getAttribute('aria-pressed'), 'false')
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    await m.update(h(Controlled))
    assert.equal(card().getAttribute('aria-pressed'), 'true')
    await act(async () => { card().dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })) })
    assert.deepEqual([...pins], ['w1', 'w1'])
    await m.unmount()
  })

  test('model falls back to the descriptor when the node lists none; a member outside the forest renders bare', async () => {
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['w1', { detail: { descriptor: { mode: 'continuable', label: 'w', agentModel: 'flash-lite', agentReasoningEffort: 'high' }, messages: [], truncated: false } }],
    ])
    const forest: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], solo: false }
    const m = await mount(h(MemberBoard, propsOf({
      forest,
      detailOf: id => details.get(id),
      leadDetail: null,
    })))
    const cards = queryAll(m.container, '.lc-member-card')
    assert.ok(text(cards[1]).includes('flash-lite (high)'))
    assert.equal(queryAll(cards[1], '.lc-member-desc').length, 0)
    assert.equal(queryAll(m.container, '.lc-member-opens').length, 0)
    await m.unmount()
  })
})

describe('MemberBoard — the other-agents cards', () => {
  function otherCards(container: HTMLElement): HTMLElement[] {
    const head = queryAll(container, '.lc-board-section-head')
      .find(h => text(h).includes(DICT_EN['fleet.board.others']))
    return queryAll((head?.nextElementSibling ?? container) as HTMLElement, '.lc-member-card')
  }
  function otherNames(container: HTMLElement): string[] {
    return otherCards(container).map(c => text(query(c, '.lc-member-name')))
  }

  test('non-member family agents render as member cards with status, meta, and the enter/aside buttons', async () => {
    const pins = new Array<string | null>()
    const entered: string[] = []
    const opened: string[] = []
    const hovers: (string | null)[] = []
    const details = new Map<string, { detail: FleetDetail | null }>([
      ['s2', { detail: { lastReply: { time: 100, text: 'archive sealed' }, messages: [], truncated: false } }],
    ])
    const m = await mount(h(MemberBoard, propsOf({
      detailOf: id => details.get(id),
      onPin: id => { pins.push(id) },
      onEnter: id => { entered.push(id) },
      onOpen: id => { opened.push(id) },
      onHover: id => { hovers.push(id) },
    })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.board.others']))
    assert.deepEqual(otherNames(m.container), ['scout', 'archivist', 'lounger'])
    const cards = otherCards(m.container)
    assert.ok(text(cards[0]).includes('42s · 5 steps'))
    assert.ok(!text(cards[0]).includes('%'))
    assert.ok(text(cards[0]).includes('deepseek-flash (max)'))
    assert.ok(text(cards[0]).includes('running'))
    assert.ok(text(cards[1]).includes('archive sealed'), 'the landed latest reply fills the card')
    assert.equal(queryAll(cards[2], '.lc-member-meta').length, 0)
    assert.ok(text(cards[2]).includes(DICT_EN['fleet.memberInactive']))

    await hover(cards[0])
    await click(cards[0])
    await unhover(cards[0])
    assert.deepEqual([...pins], ['s1'])
    assert.deepEqual(hovers, ['s1', null])
    const foot = query(cards[0], '.lc-member-opens')
    await click(query(foot, '.lc-member-aside'))
    assert.deepEqual(opened, ['s1'])
    await click(query(foot, '.lc-member-enter'))
    assert.deepEqual(entered, ['s1'])
    assert.deepEqual([...pins], ['s1'], 'neither button pins')

    await act(async () => { cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })) })
    await act(async () => { cards[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })) })
    assert.deepEqual([...pins], ['s1', 's1'])
    await m.unmount()

    const again = new Array<string>()
    const m2 = await mount(h(MemberBoard, propsOf({ pinnedId: 's1', onPin: id => { again.push(id) } })))
    const pinnedCard = otherCards(m2.container)[0]
    assert.ok(pinnedCard.className.includes('lc-member-pinned'))
    assert.equal(pinnedCard.getAttribute('aria-pressed'), 'true')
    await click(pinnedCard)
    await act(async () => { pinnedCard.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })) })
    assert.deepEqual([...again], ['s1', 's1'])
    await m2.unmount()
  })

  test('the controlled hover lifts the matching card in either section', async () => {
    const m = await mount(h(MemberBoard, propsOf({ hoverId: 'w2' })))
    const cards = queryAll(m.container, '.lc-member-card')
    assert.equal(cards.filter(c => c.className.includes('lc-member-hover')).length, 1)
    assert.ok(cards[2].className.includes('lc-member-hover'), 'the roster card lifts')
    await m.update(h(MemberBoard, propsOf({ hoverId: 's1' })))
    assert.ok(otherCards(m.container)[0].className.includes('lc-member-hover'), 'the other-agents card lifts')
    assert.ok(!queryAll(m.container, '.lc-member-card')[2].className.includes('lc-member-hover'))
    await m.update(h(MemberBoard, propsOf({})))
    assert.equal(queryAll(m.container, '.lc-member-card').filter(c => c.className.includes('lc-member-hover')).length, 0)
    await m.unmount()
  })

  test('the toolbar searches, filters by status, and sorts — across both sections', async () => {
    const m = await mount(h(MemberBoard, propsOf()))
    const filters = queryAll(m.container, '.lc-fleet-filters .lc-gran-btn')
    await click(filters[1])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['lead', 'worker-bee', 'scout'])
    await click(filters[2])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['archivist'])
    await click(filters[3])
    assert.deepEqual(queryAll(m.container, '.lc-member-card').map(c => text(query(c, '.lc-member-name'))), ['flaky-one', 'new-joiner', 'lounger'])
    await click(filters[0])

    await m.unmount()

    const flipped: AgentForest = { ...FOREST, nodes: [FOREST.nodes[0], FOREST.nodes[1], FOREST.nodes[2], FOREST.nodes[3], FOREST.nodes[5], FOREST.nodes[4]] }
    const m2 = await mount(h(MemberBoard, propsOf({ forest: flipped })))
    assert.deepEqual(otherNames(m2.container), ['scout', 'lounger', 'archivist'], 'spawn order follows the forest')
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'tokens')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'duration')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'steps')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await selectIn(query(m2.container, '.lc-fleet-sort'), 'recent')
    assert.deepEqual(otherNames(m2.container), ['scout', 'archivist', 'lounger'])
    await m2.unmount()

    const searched = await mount(h(MemberBoard, propsOf()))
    await typeIn(query(searched.container, '.lc-fleet-search'), 'worker')
    assert.equal(queryAll(searched.container, '.lc-member-card').length, 1)
    await typeIn(query(searched.container, '.lc-fleet-search'), 'zzz-no-match')
    assert.equal(queryAll(searched.container, '.lc-member-card').length, 0)
    assert.ok(text(searched.container).includes(DICT_EN['fleet.list.empty']))
    await searched.unmount()
  })
})

describe('MemberBoard — guidance states', () => {
  test('no team: the note names the mode and the family cards still list; solo states skip the toolbar', async () => {
    const m = await mount(h(MemberBoard, propsOf({ team: null })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.board.noTeam']))
    assert.deepEqual(
      queryAll(m.container, '.lc-member-card .lc-member-name').map(el => el.textContent),
      ['w1', 'w2', 'scout', 'archivist', 'lounger'],
    )
    await m.unmount()

    const soloForest: AgentForest = { nodes: [nodeOf('root', { isCurrent: true })], edges: [], solo: true }
    const solo = await mount(h(MemberBoard, propsOf({ team: null, forest: soloForest })))
    assert.ok(text(solo.container).includes(DICT_EN['fleet.board.solo']))
    assert.equal(queryAll(solo.container, '.lc-fleet-toolbar').length, 0)
    assert.equal(queryAll(solo.container, '.lc-member-card').length, 0)
    await solo.unmount()

    const one: FleetTeam = { members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }
    const lead = await mount(h(MemberBoard, propsOf({ team: one, forest: soloForest })))
    assert.equal(queryAll(lead.container, '.lc-member-card').length, 1, 'the lead card stands')
    assert.equal(queryAll(lead.container, '.lc-fleet-toolbar').length, 0)
    await lead.unmount()
  })
})
