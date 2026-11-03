import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import type { AgentGraphProps } from '../../../src/client/components/agentGraph'
import { MissionPulse } from '../../../src/client/components/missionPulse'
import { makeRichText } from '../../../src/client/components/richText'
import type { AgentForest, AgentNode } from '../../../src/client/agentTree'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { CommsRow } from '../../../src/client/fleetDetail'
import type { CommsAgent } from '../../../src/client/commsModel'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import { click, makeKit, mount, pinScroll, query, queryAll, text, typeText, until } from '../helpers/kit'

const kit = makeKit()
const graph = () => null

function makeDetails(fullLanded = new Map()) {
  return {
    landed: new Map(),
    historyLanded: new Map(),
    fullLanded,
    pending: new Set<string>(),
    historyPending: new Set<string>(),
    fullPending: new Set<string>(),
    request: vi.fn(),
    requestHistory: vi.fn(),
    requestFull: vi.fn(),
  }
}

function pulseOf(comms: CommsRow[], forest: AgentForest | null = null) {
  return h(MissionPulse, {
    graph,
    forest,
    team: null,
    details: makeDetails(),
    landedDetails: new Map(),
    comms,
    delegations: [],
    agents: new Map(),
    titles: new Map(),
    attested: new Map(),
    focusMember: null,
    currency: 'usd',
    onOpen: () => {},
    onEnter: () => {},
    rich: makeRichText(kit),
    t: kit.t,
  })
}

function pinBox(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top, bottom: top + height, left: 0, right: 0, width: 0, height }),
  })
}

describe('MissionPulse boundary parties', () => {
  test('renders unknown parties and keeps the excerpt when the full log no longer contains the event', async () => {
    const row: CommsRow = {
      key: 'unknown-target:1:1000:relay',
      to: 'unknown-target',
      seq: 1,
      time: 1000,
      kind: 'relay',
      from: 'unknown-sender',
      text: 'outside excerpt…',
      clipped: true,
    }
    const selfRow: CommsRow = {
      key: 'self:2:500:relay',
      to: 'self',
      seq: 2,
      time: 500,
      kind: 'relay',
      from: 'self',
      text: 'note to self',
    }
    const details = makeDetails(new Map([['unknown-target', { messages: [{ seq: 99, time: 2000, kind: 'relay' as const, text: 'unrelated' }], truncated: false }]]))
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details,
      landedDetails: new Map(),
      comms: [row, selfRow],
      delegations: [],
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-label').length, 3)
    assert.equal(query(mounted.container, '[data-pulse-stat="agents"]').textContent, '3')
    await click(query(mounted.container, '.lc-pulse-event'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('outside excerpt…'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.comms.detail.excerptOnly')))
    await mounted.unmount()
  })

  test('renders durable delegations in natural order with colored solid links and useful inspection', async () => {
    const rows: CommsRow[] = [
      { key: 'child:2:2000:relay', to: 'child', seq: 2, time: 2000, kind: 'relay', from: 'root', text: 'second' },
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'first' },
    ]
    const delegation = {
      key: 'root:4:child',
      time: 500,
      seq: 4,
      from: 'root',
      to: 'child',
      mode: 'continuable' as const,
      label: 'Map host boundaries',
    }
    const agents = new Map([
      ['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: 'red' }],
      ['child', { id: 'child', name: 'Child', role: 'subagent' as const, self: false, hue: 'blue' }],
    ])
    const pulse = (comms: CommsRow[]) => h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms,
      delegations: [delegation],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    })
    const mounted = await mount(pulse(rows))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    assert.ok(query(mounted.container, '[data-comms-key="child:2:2000:relay"]').className.includes('lc-comms-event-open'))
    const scroller = query<HTMLElement>(mounted.container, '[data-sequence-scroller]')
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 120, writable: true },
    })
    assert.equal(scroller.scrollLeft, 0)
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.equal(query<HTMLElement>(mounted.container, '.lc-pulse-lane-labels-rows').style.transform, 'translateY(-120px)')
    const laneButton = query<HTMLButtonElement>(mounted.container, '[data-agent="child"]')
    scroller.scrollTop = 0
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 136)
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 })
    scroller.scrollTop = 120
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 68)
    scroller.scrollTop = 0
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 0)
    scroller.scrollLeft = 300
    await mounted.update(pulse([...rows]))
    assert.equal(scroller.scrollLeft, 300)
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.deepEqual(events.map(event => event.dataset.eventKey), ['root:4:child', 'child:1:1000:relay', 'child:2:2000:relay'])
    assert.equal(events[0].dataset.record, 'delegation')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-a'), 'red')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-b'), 'blue')
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-baseline').length, 2)
    const laneLabel = query<HTMLElement>(mounted.container, '[data-lane-label="root"]')
    const laneTrack = query<HTMLElement>(mounted.container, '[data-lane="root"]')
    assert.equal(laneLabel.style.getPropertyValue('--lc-lane-hue'), 'red')
    assert.equal(laneTrack.style.getPropertyValue('--lc-lane-hue'), 'red')
    await act(async () => { laneLabel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(laneLabel.className.includes('lc-pulse-lane-hover'))
    assert.ok(laneTrack.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneLabel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!laneLabel.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneTrack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(laneTrack.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneTrack.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!laneTrack.className.includes('lc-pulse-lane-hover'))
    for (const line of queryAll(mounted.container, '.lc-pulse-edge-line')) {
      assert.equal(line.getAttribute('stroke'), 'red')
      assert.equal(line.getAttribute('stroke-dasharray'), null)
    }
    const edge = query(mounted.container, '[data-edge-key="child:1:1000:relay"]')
    await act(async () => { edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(events[1].className.includes('lc-pulse-event-hover'))
    assert.ok(edge.getAttribute('class')!.includes('lc-pulse-arrow-hover'))
    await act(async () => { edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    assert.ok(!edge.getAttribute('class')!.includes('lc-pulse-arrow-hover'))
    const otherEdge = query(mounted.container, '[data-edge-key="child:2:2000:relay"]')
    await act(async () => {
      edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      otherEdge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    assert.ok(events[2].className.includes('lc-pulse-event-hover'))
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    await act(async () => { otherEdge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    await act(async () => {
      edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      otherEdge.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      edge.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    assert.ok(events[2].className.includes('lc-pulse-event-hover'))
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    await act(async () => { otherEdge.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.ok(!events[2].className.includes('lc-pulse-event-hover'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await act(async () => { query(edge, '.lc-pulse-edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    const [firstButton, latestButton] = queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-sequence-actions button')
    assert.ok(firstButton.className.includes('lc-gran-on'))
    assert.ok(!latestButton.className.includes('lc-gran-on'))
    scroller.scrollLeft = 800
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(!firstButton.className.includes('lc-gran-on'))
    assert.ok(latestButton.className.includes('lc-gran-on'))
    scroller.scrollLeft = 400
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(latestButton.className.includes('lc-gran-on'))
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1000 })
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(latestButton.className.includes('lc-gran-on'))
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    await click(firstButton)
    assert.equal(scroller.scrollLeft, 0)
    assert.ok(firstButton.className.includes('lc-gran-on'))
    await click(latestButton)
    assert.equal(scroller.scrollLeft, 1000)
    assert.ok(latestButton.className.includes('lc-gran-on'))
    await click(events[0])
    const inspector = query(mounted.container, '.lc-pulse-delegation-detail')
    assert.ok(text(inspector).includes('Map host boundaries'))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.delegationNote')))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.mode.continuable')))
    await click(query(inspector, '.lc-comms-detail-close'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await mounted.unmount()
  })

  test('filters, searches, and opens durable delegations without a roster', async () => {
    const open = vi.fn()
    const enter = vi.fn()
    const delegations = [
      { key: 'parent:1:child', time: 500, seq: 1, from: 'parent', to: 'child', mode: 'one-shot' as const },
      { key: 'other:2:peer', time: 600, seq: 2, from: 'other', to: 'peer', mode: 'external' as const, label: 'Peer duty' },
    ]
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: [],
      delegations,
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: open,
      onEnter: enter,
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.equal(events.length, 2)
    await click(events[0])
    const actions = queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-delegation-actions button')
    await click(actions[0])
    assert.equal(query(mounted.container, '[data-agent="child"]').getAttribute('aria-pressed'), 'true')
    assert.ok(text(actions[0]).includes(kit.t('fleet.comms.detail.unfilter')))
    await click(actions[0])
    assert.equal(query(mounted.container, '[data-agent="child"]').getAttribute('aria-pressed'), 'false')
    await click(actions[1])
    await click(actions[2])
    assert.deepEqual(open.mock.calls, [['child']])
    assert.deepEqual(enter.mock.calls, [['child']])
    await click(events[0])
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.pulse.selectEvent')))
    const laneSearch = query<HTMLInputElement>(mounted.container, '.lc-pulse-timeline .lc-pulse-search')
    await typeText(laneSearch, 'peer')
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '[data-lane-label]').map(el => el.dataset.laneLabel),
      ['other', 'peer'],
    )
    assert.ok(query(mounted.container, '[data-lane-label="peer"]').className.includes('lc-pulse-lane-match'))
    assert.ok(text(query(mounted.container, '[data-lane-label="other"]')).includes(kit.t('fleet.pulse.linked')))
    await typeText(laneSearch, '')
    const search = query<HTMLInputElement>(mounted.container, '.lc-pulse-event-tools .lc-pulse-search')
    await typeText(search, 'peer duty')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 1)
    assert.equal(query(mounted.container, '.lc-pulse-event').dataset.eventKey, 'other:2:peer')
    await click(query(mounted.container, '.lc-pulse-event'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-delegation-actions button').length, 1)
    assert.deepEqual(open.mock.calls, [['child']])
    assert.deepEqual(enter.mock.calls, [['child']])
    await typeText(search, 'parent')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 1)
    assert.equal(query(mounted.container, '.lc-pulse-event').dataset.eventKey, 'parent:1:child')
    await typeText(search, 'no matching record')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-timeline')).includes(kit.t('fleet.pulse.emptyTimeline')))
    await mounted.unmount()
  })

  test('marks each record with the team task owned by its recipient', async () => {
    const team: FleetTeam = {
      members: [
        { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'child', name: 'child', role: 'teammate', phase: 'active' },
      ],
      tasks: [
        { id: 'task-1', subject: 'Parse it', description: '', status: 'in_progress', ownerName: 'child', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      ],
    }
    const rows: CommsRow[] = [
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'go' },
      { key: 'root:2:2000:relay', to: 'root', seq: 2, time: 2000, kind: 'relay', from: 'child', text: 'done' },
      { key: 'root:3:3000:relay', to: 'root', seq: 3, time: 3000, kind: 'relay', from: 'root', text: 'note' },
    ]
    const agents = new Map([
      ['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: 'red' }],
      ['child', { id: 'child', name: 'child', role: 'teammate' as const, self: false, hue: 'blue' }],
    ])
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: rows,
      delegations: [],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    assert.ok(text(query(mounted.container, '.lc-pulse-task-lane-label')).includes(kit.t('fleet.pulse.taskLane')))
    const chips = queryAll<HTMLElement>(mounted.container, '[data-task-chip]')
    assert.deepEqual(chips.map(chip => chip.dataset.taskChip), ['task-1', 'task-1'])
    assert.deepEqual(chips.map(chip => chip.style.left), ['24px', '56px'])
    assert.equal(text(chips[0]), '1')
    assert.ok(chips[0].title.includes('task-1 · Parse it'))
    const workItem = query<HTMLElement>(mounted.container, '[data-task="task-1"]')
    assert.equal(text(query(workItem, '.lc-pulse-work-id')), '1')
    const otherLabel = query<HTMLElement>(mounted.container, '[data-lane-label="child"]')
    const otherTrack = query<HTMLElement>(mounted.container, '[data-lane="child"]')
    const laneLabel = query<HTMLElement>(mounted.container, '[data-lane-label="root"]')
    const laneTrack = query<HTMLElement>(mounted.container, '[data-lane="root"]')
    await act(async () => { chips[0].dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(workItem.className.includes('lc-pulse-work-task-hover'))
    await act(async () => { chips[0].dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!workItem.className.includes('lc-pulse-work-task-hover'))
    await act(async () => { workItem.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(chips[0].className.includes('lc-pulse-task-chip-hover'))
    await act(async () => { workItem.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!chips[0].className.includes('lc-pulse-task-chip-hover'))
    await act(async () => { chips[0].dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.ok(chips[0].className.includes('lc-pulse-task-chip-hover'))
    await act(async () => { chips[0].dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.ok(!chips[0].className.includes('lc-pulse-task-chip-hover'))
    await act(async () => { laneLabel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await act(async () => {
      otherLabel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      laneLabel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    assert.ok(otherLabel.className.includes('lc-pulse-lane-hover'))
    assert.ok(!laneLabel.className.includes('lc-pulse-lane-hover'))
    await act(async () => { otherLabel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    await act(async () => { laneTrack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    await act(async () => {
      otherTrack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      laneTrack.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    assert.ok(otherTrack.className.includes('lc-pulse-lane-hover'))
    assert.ok(!laneTrack.className.includes('lc-pulse-lane-hover'))
    await act(async () => { otherTrack.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    await click(chips[0])
    assert.ok(workItem.className.includes('lc-pulse-work-focused'))
    assert.equal(query(workItem, '.lc-pulse-work-focus').getAttribute('aria-expanded'), 'true')
    await click(query(workItem, '.lc-pulse-work-chev'))
    assert.ok(!workItem.className.includes('lc-pulse-work-focused'))
    assert.equal(query(workItem, '.lc-pulse-work-chev').getAttribute('aria-expanded'), 'false')
    await click(query(workItem, '.lc-pulse-work-chev'))
    assert.ok(workItem.className.includes('lc-pulse-work-focused'))
    await click(query(mounted.container, '[data-agent="root"]'))
    assert.ok(text(query(mounted.container, '.lc-pulse-tasks')).includes(kit.t('fleet.tasks.noMatch')))
    await mounted.unmount()
  })

  test('groups tasks by owning agent with status, task number, filters, dependency chain, and boxed detail', async () => {
    const team: FleetTeam = {
      members: [],
      tasks: [
        { id: 'task-3', subject: 'Build the board', description: 'Restore the old board.', status: 'in_progress', ownerId: 'child', blockedBy: ['task-4'], writeScopes: ['src/client'], ready: false, warnings: [] },
        { id: 'task-4', subject: 'Prepare data', description: '', status: 'pending', ownerId: 'child', blockedBy: ['task-9'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-9', subject: 'Research layout', description: '', status: 'completed', ownerId: 'child', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      ],
    }
    const forest: AgentForest = {
      solo: false,
      edges: [],
      nodes: [{
        id: 'child',
        label: 'worker-bee',
        depth: 1,
        family: 0,
        isCurrent: false,
        running: true,
        completed: false,
        subagent: true,
        updatedAt: 1,
        head: null,
        billed: null,
        costUsage: null,
        durationMs: null,
        identity: null,
        requests: 0,
        model: 'deepseek-flash',
        reasoningEffort: 'low',
      }],
    }
    const details = makeDetails()
    details.landed.set('child', {
      updatedAt: 1,
      detail: {
        messages: [],
        truncated: false,
        initialPrompt: 'Restore the old board.',
        lastReply: { time: 3000, text: 'Board restored.' },
      },
    })
    details.fullLanded.set('child', {
      messages: [],
      truncated: false,
      initialPrompt: 'Restore the old board.',
      lastReply: { time: 3000, text: 'Board restored.' },
    })
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest,
      team,
      details,
      landedDetails: new Map(),
      comms: [{ key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'go' }],
      delegations: [],
      agents: new Map([['child', { id: 'child', name: 'worker-bee', role: 'teammate' as const, self: false, hue: 'blue' }]]),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const group = query(mounted.container, '[data-owner-group="id:child"]')
    assert.ok(text(query(group, '.lc-pulse-work-group-head')).includes('worker-bee'))
    assert.ok(text(query(group, '.lc-pulse-work-group-head')).includes(kit.t('agents.running')))
    assert.ok(text(query(group, '.lc-pulse-work-group-head')).includes('3'))
    const workItem = query<HTMLElement>(group, '[data-task="task-3"]')
    assert.equal(text(query(workItem, '.lc-pulse-work-id')), '3')
    assert.equal(text(query(workItem, '.lc-pulse-work-subject')), 'Build the board')
    assert.ok(text(query(workItem, '.lc-pulse-work-identity')).includes('worker-bee'))
    assert.ok(text(query(workItem, '.lc-pulse-work-identity')).includes(kit.t('agents.running')))
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '[data-work-phase]').map(button => [button.dataset.workPhase, text(button)]),
      [
        ['all', kit.t('fleet.tasks.filterAll') + '3'],
        ['in_progress', kit.t('fleet.tasks.filterInProgress') + '1'],
        ['pending', kit.t('fleet.tasks.filterPending') + '1'],
        ['completed', kit.t('fleet.tasks.filterCompleted') + '1'],
      ],
    )
    await click(query(workItem, '.lc-pulse-work-focus'))
    assert.ok(workItem.className.includes('lc-pulse-work-focused'))
    assert.ok(query(group, '[data-task="task-4"]').className.includes('lc-pulse-work-chain'))
    assert.ok(query(group, '[data-task="task-9"]').className.includes('lc-pulse-work-chain'))
    assert.ok(text(query(workItem, '.lc-pulse-work-deps')).includes('4'))
    const detail = query(workItem, '.lc-pulse-work-detail')
    assert.ok(text(detail).includes(kit.t('fleet.tasks.brief')))
    assert.ok(text(detail).includes(kit.t('fleet.tasks.agentBox')))
    assert.ok(text(detail).includes(kit.t('fleet.tasks.reply')))
    assert.ok(text(detail).includes('Restore the old board.'))
    assert.ok(text(detail).includes('Board restored.'))
    assert.ok(text(detail).includes('deepseek-flash (low)'))
    await click(query(mounted.container, '[data-work-phase="completed"]'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 1)
    await click(query(mounted.container, '[data-task-chip]'))
    assert.equal(query(mounted.container, '[data-work-phase="all"]').getAttribute('aria-pressed'), 'true')
    assert.ok(query(mounted.container, '[data-task="task-3"]').className.includes('lc-pulse-work-focused'))
    await click(query(mounted.container, '[data-task="task-3"] .lc-pulse-work-owner'))
    assert.equal(query(mounted.container, '[data-task="task-3"] .lc-pulse-work-owner').getAttribute('aria-pressed'), 'true')
    await click(query(mounted.container, '[data-work-phase="all"]'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 3)
    await mounted.unmount()
  })

  test('keeps an off-roster owner name visible without inventing a selectable agent', async () => {
    const team: FleetTeam = {
      members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }],
      tasks: [{ id: 'task-5', subject: 'Ghost task', description: '', status: 'pending', ownerName: 'ghost', blockedBy: [], writeScopes: [], ready: true, warnings: [] }],
    }
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: [],
      delegations: [],
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    assert.equal(text(query(mounted.container, '.lc-pulse-work-group-name')), 'ghost')
    const task = query<HTMLElement>(mounted.container, '[data-task="task-5"]')
    assert.equal(text(query(task, '.lc-pulse-work-owner-name')), 'ghost')
    assert.equal(queryAll(task, '.lc-pulse-work-owner').length, 0)
    assert.ok(text(query(task, '.lc-pulse-work-agent-state')).includes(kit.t('fleet.pulse.statusUnknown')))
    await click(query(task, '.lc-pulse-work-focus'))
    assert.ok(text(query(task, '.lc-pulse-work-agentbox')).includes('ghost'))
    assert.equal(queryAll(task, '.lc-pulse-work-agentbox .lc-comms-avatar').length, 0)
    await mounted.unmount()
  })

  test('resolves a nameless modern owner through the shared agent map and reports a pending full reply', async () => {
    const team: FleetTeam = {
      members: [],
      tasks: [{ id: 'task-6', subject: 'Modern unnamed owner', description: '', status: 'in_progress', ownerId: 'child', blockedBy: [], writeScopes: [], ready: false, warnings: [] }],
    }
    const details = makeDetails()
    details.fullPending.add('child')
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team,
      details,
      landedDetails: new Map(),
      comms: [],
      delegations: [],
      agents: new Map([['child', { id: 'child', name: 'worker-bee', role: 'teammate' as const, self: false, hue: 'blue' }]]),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const task = query<HTMLElement>(mounted.container, '[data-task="task-6"]')
    assert.ok(text(query(mounted.container, '.lc-pulse-work-group-owner')).includes('worker-bee'))
    assert.ok(text(query(task, '.lc-pulse-work-owner')).includes('worker-bee'))
    assert.ok(text(query(task, '.lc-pulse-work-identity')).includes(kit.t('fleet.pulse.statusUnknown')))
    await click(query(task, '.lc-pulse-work-focus'))
    assert.ok(text(query(task, '.lc-pulse-work-reply')).includes(kit.t('fleet.tasks.replyFull')))
    await mounted.unmount()
  })

  test('clears the linked task hover when the hovered node leaves the forest', async () => {
    const child: AgentNode = {
      id: 'child',
      label: 'child',
      depth: 1,
      family: 1,
      isCurrent: false,
      running: true,
      completed: false,
      subagent: true,
      updatedAt: 1,
      head: null,
      requests: 0,
      billed: null,
      costUsage: null,
      durationMs: null,
      identity: null,
    }
    const team: FleetTeam = {
      members: [],
      tasks: [{ id: 'task-1', subject: 'Linked', description: '', status: 'in_progress', ownerId: 'child', blockedBy: [], writeScopes: [], ready: false, warnings: [] }],
    }
    const HoverGraph = (props: AgentGraphProps) => h('button', {
      type: 'button',
      'data-hover-node': 'child',
      onMouseEnter: () => { props.onHover?.('child') },
    }, 'hover')
    const props = {
      graph: HoverGraph,
      team,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: [],
      delegations: [],
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd' as const,
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }
    const mounted = await mount(h(MissionPulse, { ...props, forest: { nodes: [child], edges: [], solo: false } }))
    await act(async () => { query(mounted.container, '[data-hover-node="child"]').dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-linked').length, 1)
    await mounted.update(h(MissionPulse, { ...props, forest: { nodes: [], edges: [], solo: false } }))
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-linked').length, 0)
    await mounted.unmount()
  })

  test('the collaboration and work-queue headers search their own content', async () => {
    const team: FleetTeam = {
      members: [
        { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'child', name: 'child', role: 'teammate', phase: 'active' },
      ],
      tasks: [
        { id: 'task-1', subject: 'Parse schema', description: '', status: 'in_progress', ownerName: 'child', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
        { id: 'task-2', subject: 'Ship docs', description: '', status: 'pending', ownerName: 'root', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      ],
    }
    const rows: CommsRow[] = [
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'go' },
      { key: 'root:2:2000:relay', to: 'root', seq: 2, time: 2000, kind: 'relay', from: 'child', text: 'done' },
      { key: 'delta:3:1500:relay', to: 'delta', seq: 3, time: 1500, kind: 'relay', from: 'root', text: 'aside' },
    ]
    const agents = new Map([
      ['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: 'red' }],
      ['child', { id: 'child', name: 'child', role: 'teammate' as const, self: false, hue: 'blue' }],
      ['delta', { id: 'delta', name: 'Delta', role: 'teammate' as const, self: false, hue: 'gold' }],
    ])
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: rows,
      delegations: [],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const laneSearch = query<HTMLInputElement>(mounted.container, '.lc-pulse-timeline .lc-pulse-search')
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '.lc-pulse-event').map(el => [el.dataset.to, el.style.left]),
      [['root', '88px'], ['child', '24px'], ['delta', '56px']],
    )
    await typeText(laneSearch, 'child')
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '.lc-pulse-lane-label').map(el => el.dataset.laneLabel),
      ['root', 'child'],
    )
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '.lc-pulse-event').map(el => [el.dataset.to, el.style.left]),
      [['root', '56px'], ['child', '24px']],
    )
    const matchedLane = query<HTMLElement>(mounted.container, '[data-lane-label="child"]')
    assert.ok(matchedLane.className.includes('lc-pulse-lane-match'))
    assert.ok(!text(matchedLane).includes(kit.t('fleet.pulse.linked')))
    assert.ok(query<HTMLElement>(mounted.container, '[data-lane="child"]').className.includes('lc-pulse-lane-track-match'))
    const linkedLane = query<HTMLElement>(mounted.container, '[data-lane-label="root"]')
    assert.ok(!linkedLane.className.includes('lc-pulse-lane-match'))
    assert.ok(text(linkedLane).includes(kit.t('fleet.pulse.linked')))
    assert.ok(!query<HTMLElement>(mounted.container, '[data-lane="root"]').className.includes('lc-pulse-lane-track-match'))
    assert.ok(text(query(mounted.container, '.lc-pulse-timeline')).includes(
      kit.t('fleet.pulse.timelineSub', { shown: 2, total: 3, lanes: 2 }),
    ))
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 2)
    await typeText(laneSearch, 'no such agent')
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-label').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-timeline')).includes(kit.t('fleet.pulse.noLaneMatch')))
    await typeText(laneSearch, '')
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-label').length, 3)
    const workSearch = query<HTMLInputElement>(mounted.container, '.lc-pulse-tasks .lc-pulse-search')
    await typeText(workSearch, 'ship')
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 1)
    assert.ok(text(query(mounted.container, '.lc-pulse-work-item')).includes('Ship docs'))
    await typeText(workSearch, 'no such task')
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-tasks')).includes(kit.t('fleet.tasks.noMatch')))
    await click(query(mounted.container, '[data-task-chip="task-1"]'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 2)
    assert.ok(query(mounted.container, '.lc-pulse-work-item').className.includes('lc-pulse-work-focused'))
    await typeText(workSearch, '')
    assert.equal(queryAll(mounted.container, '.lc-pulse-work-item').length, 2)
    await mounted.unmount()

    const quiet = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: [],
      delegations: [],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    await typeText(query<HTMLInputElement>(quiet.container, '.lc-pulse-timeline .lc-pulse-search'), 'child')
    const quietTimeline = text(query(quiet.container, '.lc-pulse-timeline'))
    assert.ok(quietTimeline.includes(kit.t('fleet.comms.empty')))
    assert.ok(!quietTimeline.includes(kit.t('fleet.pulse.noLaneMatch')))
    await quiet.unmount()
  })

  test('scrolls the selected record to the top of the event list', async () => {
    const rows: CommsRow[] = [
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'first' },
      { key: 'child:2:2000:relay', to: 'child', seq: 2, time: 2000, kind: 'relay', from: 'root', text: 'second' },
    ]
    const mounted = await mount(pulseOf(rows))
    const list = query<HTMLElement>(mounted.container, '.lc-pulse-event-list')
    const target = query<HTMLElement>(mounted.container, '[data-comms-key="child:2:2000:relay"]')
    pinBox(list, 0, 300)
    pinBox(target, 220, 40)
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 0, writable: true })
    await click(query(mounted.container, '[data-event-key="child:2:2000:relay"]'))
    assert.equal(list.scrollTop, 220)
    pinBox(target, 400, 40)
    await mounted.update(pulseOf([...rows]))
    assert.equal(list.scrollTop, 220)
    await click(query(mounted.container, '[data-event-key="child:2:2000:relay"]'))
    await click(query(mounted.container, '[data-event-key="child:2:2000:relay"]'))
    assert.equal(list.scrollTop, 620)
    const first = query<HTMLElement>(mounted.container, '[data-comms-key="child:1:1000:relay"]')
    pinBox(first, 500, 40)
    list.scrollTop = 0
    await click(query(first, '.lc-comms-hit'))
    assert.equal(list.scrollTop, 0)
    assert.ok(first.className.includes('lc-comms-event-open'))
    await click(query(first, '.lc-comms-hit'))
    await click(query(mounted.container, '[data-event-key="child:1:1000:relay"]'))
    assert.equal(list.scrollTop, 500)
    await mounted.unmount()
  })

  test('jumps to a selected record the windowed event list has not rendered', async () => {
    const rows: CommsRow[] = Array.from({ length: 70 }, (_, index) => ({
      key: `child:${index + 1}:${(index + 1) * 1000}:relay`,
      to: 'child',
      seq: index + 1,
      time: (index + 1) * 1000,
      kind: 'relay' as const,
      from: 'root',
      text: `event ${index}`,
    }))
    const mounted = await mount(pulseOf(rows))
    const list = query<HTMLElement>(mounted.container, '.lc-pulse-event-list')
    Object.defineProperty(list, 'clientHeight', { configurable: true, value: 640 })
    Object.defineProperty(list, 'scrollTop', { configurable: true, value: 0, writable: true })
    pinBox(list, 0, 640)
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll(mounted.container, '[data-comms-key]').length < 70, 'event list never windowed')
    await click(query(mounted.container, '[data-event-key="child:41:41000:relay"]'))
    assert.equal(list.scrollTop, 40 * 64)
    await mounted.unmount()
  })

  test('stacks the model, usage and work counts under each agent name', async () => {
    resetModelPrices()
    setModelPricesLoader(() => Promise.resolve({
      deepseek: { models: { 'deepseek-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
    }))
    const node = (id: string, over: Partial<AgentNode>): AgentNode => ({
      id,
      label: id,
      depth: 1,
      family: 1,
      isCurrent: false,
      running: true,
      completed: false,
      subagent: true,
      updatedAt: 1,
      head: null,
      requests: 3,
      billed: null,
      costUsage: null,
      durationMs: null,
      identity: null,
      ...over,
    })
    const forest: AgentForest = {
      nodes: [
        node('child', {
          model: 'deepseek-flash',
          reasoningEffort: 'high',
          billed: 12_300,
          costUsage: { deepseek: { 'deepseek-flash': { off: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
        }),
        node('plain', {}),
      ],
      edges: [],
      solo: false,
    }
    const mounted = await mount(pulseOf([
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'go' },
      { key: 'plain:2:2000:relay', to: 'plain', seq: 2, time: 2000, kind: 'relay', from: 'root', text: 'note' },
    ], forest))
    await until(() => text(query(mounted.container, '[data-lane-label="child"]')).includes('$0.15'), 'lane cost never priced')
    const child = text(query(mounted.container, '[data-lane-label="child"]'))
    assert.ok(child.includes('deepseek-flash (high)'))
    assert.ok(child.includes('12.3k tokens'))
    assert.ok(child.includes('0 tasks · 1 events'))
    const plain = text(query(mounted.container, '[data-lane-label="plain"]'))
    assert.ok(!plain.includes('tokens'))
    assert.ok(plain.includes('0 tasks · 1 events'))
    await mounted.unmount()
    resetModelPrices()
  })
})

describe('Fleet pane virtualization', () => {
  function manyAgents(count: number): { agents: Map<string, CommsAgent>; comms: CommsRow[] } {
    const agents = new Map<string, CommsAgent>()
    const comms: CommsRow[] = []
    for (let index = 0; index < count; index++) {
      const id = `agent-${index}`
      agents.set(id, { id, name: `Worker ${index}`, role: 'subagent', self: false, hue: `hsl(${index} 50% 50%)` })
      comms.push({ key: `${id}:1:${1000 + index}:relay`, to: id, seq: 1, time: 1000 + index, kind: 'relay', from: 'root', text: `note ${index}` })
    }
    return { agents, comms }
  }

  function pinViewport(el: HTMLElement, height: number): void {
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: height })
  }


  async function flushFrames(frames: FrameRequestCallback[]): Promise<void> {
    await act(async () => { for (const frame of frames.splice(0)) frame(0) })
  }

  test('windows a very large lane set and follows its measured scroll range', async () => {
    const { agents, comms } = manyAgents(241)
    const mounted = await mount(h(MissionPulse, { graph, forest: null, team: null, details: makeDetails(), landedDetails: new Map(), comms, delegations: [], agents, titles: new Map(), attested: new Map(), focusMember: null, currency: 'usd', onOpen: () => {}, onEnter: () => {}, rich: makeRichText(kit), t: kit.t }))
    const scroller = query<HTMLElement>(mounted.container, '[data-sequence-scroller]')
    pinViewport(scroller, 200)
    scroller.scrollTop = 1900
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(queryAll(mounted.container, '[data-lane-label]').length < 100)
    const grown = manyAgents(242)
    await mounted.update(h(MissionPulse, { graph, forest: null, team: null, details: makeDetails(), landedDetails: new Map(), comms: grown.comms, delegations: [], agents: grown.agents, titles: new Map(), attested: new Map(), focusMember: null, currency: 'usd', onOpen: () => {}, onEnter: () => {}, rich: makeRichText(kit), t: kit.t }))
    assert.ok(query(mounted.container, '[data-lane-label="agent-30"]') !== null)
    await mounted.unmount()
  })

  test('windows the work board and scrolls a task revealed from another lane into view', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const { agents, comms } = manyAgents(40)
      const team: FleetTeam = {
        members: [{ id: 'root', name: 'Lead', role: 'lead', phase: 'active' }],
        tasks: Array.from({ length: 40 }, (_, index) => ({
          id: `task-${index}`,
          subject: `task ${index}`,
          description: 'work',
          status: index === 39 ? 'completed' as const : 'pending' as const,
          ownerId: `agent-${index}`,
          blockedBy: [],
          writeScopes: [],
          ready: true,
          warnings: [],
        })),
      }
      const mounted = await mount(h(MissionPulse, {
        graph, forest: null, team, details: makeDetails(), landedDetails: new Map(),
        comms, delegations: [], agents, titles: new Map(), attested: new Map(), focusMember: null,
        currency: 'usd', onOpen: () => {}, onEnter: () => {}, rich: makeRichText(kit), t: kit.t,
      }))
      const body = query<HTMLElement>(mounted.container, '.lc-pulse-work-body')
      pinScroll(body)
      pinViewport(body, 200)
      body.scrollTop = 0
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await flushFrames(frames)
      assert.ok(queryAll(mounted.container, '.lc-pulse-work-item').length < 40, 'the measured board bounds its rows')
      assert.equal(queryAll(mounted.container, '[data-task="task-39"]').length, 0, 'the trailing task starts outside the window')
      const scroller = query<HTMLElement>(mounted.container, '[data-sequence-scroller]')
      pinViewport(scroller, 200)
      scroller.scrollTop = 2500
      await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
      await flushFrames(frames)
      const chip = query<HTMLElement>(mounted.container, '[data-task-chip="task-39"]')
      await act(async () => { chip.click() })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await flushFrames(frames)
      assert.ok(query(mounted.container, '[data-task="task-39"]') !== null, 'the revealed task renders')
      assert.ok(body.scrollTop > 0, 'the board scrolls itself to the revealed task')
      const scrolled = body.scrollTop
      const owner = queryAll<HTMLElement>(mounted.container, '.lc-pulse-work-item [data-owner]')[0]
      await act(async () => { owner.click() })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await flushFrames(frames)
      assert.equal(body.scrollTop, scrolled, 'a focus the filters hide leaves the board where it is')
      await mounted.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('Fleet work board — large owner groups', () => {
  test('splits one owner’s long task list into windowed segments that still reach the last task', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const agents = new Map<string, CommsAgent>()
      const comms: CommsRow[] = []
      for (let index = 0; index < 40; index++) {
        const id = `agent-${index}`
        agents.set(id, { id, name: `Worker ${index}`, role: 'subagent', self: false, hue: `hsl(${index} 50% 50%)` })
        comms.push({ key: `${id}:1:${1000 + index}:relay`, to: id, seq: 1, time: 1000 + index, kind: 'relay', from: 'root', text: `note ${index}` })
      }
      const team: FleetTeam = {
        members: [{ id: 'root', name: 'Lead', role: 'lead', phase: 'active' }],
        tasks: Array.from({ length: 40 }, (_, index) => ({
          id: `task-${index}`,
          subject: `owned ${index}`,
          description: '',
          status: 'pending' as const,
          ownerId: 'agent-0',
          blockedBy: [],
          writeScopes: [],
          ready: true,
          warnings: [],
        })),
      }
      const mounted = await mount(h(MissionPulse, {
        graph, forest: null, team, details: makeDetails(), landedDetails: new Map(),
        comms, delegations: [], agents, titles: new Map(), attested: new Map(), focusMember: null,
        currency: 'usd', onOpen: () => {}, onEnter: () => {}, rich: makeRichText(kit), t: kit.t,
      }))
      const body = query<HTMLElement>(mounted.container, '.lc-pulse-work-body')
      pinScroll(body)
      Object.defineProperty(body, 'clientHeight', { configurable: true, value: 200 })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(queryAll(mounted.container, '.lc-pulse-work-item').length < 40, 'one long owner list is windowed too')
      body.scrollTop = 4000
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(queryAll(mounted.container, '[data-task="task-39"]').length > 0, 'the last task is reachable by scrolling')
      body.scrollTop = 0
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      await act(async () => { query<HTMLElement>(mounted.container, '[data-work-phase="completed"]').click() })
      await act(async () => { query<HTMLElement>(mounted.container, '[data-task-chip="task-0"]').click() })
      await act(async () => { body.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(queryAll(mounted.container, '[data-task="task-0"]').length > 0, 'a phase reset restores the focused task')
      await mounted.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
