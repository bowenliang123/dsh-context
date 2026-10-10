// AgentInspector — the network card's right column: identity, figures, composition, team
// membership and owned tasks, descriptor/prompt off the fleet-detail read, and the agent's comms.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { AgentInspector, type AgentInspectorProps } from '../../../src/client/components/agentInspector'
import type { AgentNode } from '../../../src/client/agentTree'
import type { FleetTeam } from '../../../src/client/fleetTeam'
import type { CommsRow } from '../../../src/client/fleetDetail'
import type { FleetDetail } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    label: id,
    depth: 0,
    family: 0,
    isCurrent: false,
    running: false,
    completed: false,
    subagent: true,
    updatedAt: 0,
    head: {
      tokens: 500,
      window: 1000,
      pct: 50,
      parts: [{ key: 'user', color: '#22c55e', value: 500 }],
    },
    requests: 5,
    billed: 150,
    costUsage: null,
    durationMs: 42000,
    identity: { mode: 'continuable', label: id },
    ...over,
  }
}

const TEAM: FleetTeam = {
  members: [
    { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
    { id: 'w1', name: 'worker-bee', role: 'teammate', phase: 'active' },
    { id: 'w2', name: 'flaky-one', role: 'teammate', phase: 'failed', error: 'provider blew up' },
    { id: 'w3', name: 'new-joiner', role: 'teammate', phase: 'provisioning' },
  ],
  tasks: [
    { id: 'task-1', subject: 'schema parsing', description: '', status: 'completed', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
    { id: 'task-2', subject: 'wire the view', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
    { id: 'task-3', subject: 'polish', description: '', status: 'pending', ownerName: 'worker-bee', blockedBy: ['task-2'], writeScopes: [], ready: true, warnings: [] },
    { id: 'task-4', subject: 'blocked work', description: '', status: 'pending', ownerName: 'worker-bee', blockedBy: ['task-2'], writeScopes: [], ready: false, warnings: [] },
  ],
}

function propsOf(over: Partial<AgentInspectorProps> = {}): AgentInspectorProps {
  return {
    node: nodeOf('w1'),
    pinned: false,
    team: null,
    detail: { detail: null },
    roster: [],
    comms: [],
    labelOf: id => id,
    onOpen: () => {},
    onPin: () => {},
    onFocusTask: () => {},
    t: kit.t,
    fmt: kit.fmt,
    catLabel: kit.catLabel,
    ...over,
  }
}

describe('AgentInspector — identity and figures', () => {
  test('the stats core renders badges, figures, and composition shares', async () => {
    const m = await mount(h(AgentInspector, propsOf({ node: nodeOf('w1', { running: true }) })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes('w1'))
    assert.ok(text(el).includes('continuable'))
    assert.ok(text(el).includes('running'))
    assert.ok(text(el).includes('500 / 1.0k · 50%'))
    assert.ok(text(el).includes('5 steps'))
    assert.ok(text(el).includes('150 billed'))
    assert.ok(text(el).includes('42s'))
    assert.ok(text(el).includes('User Messages'))
    assert.ok(text(el).includes('≈500 (100%)'))
    await m.unmount()
  })

  test('a bare node renders the dash and no parts; the current session gets no open button', async () => {
    const m = await mount(h(AgentInspector, propsOf({
      node: nodeOf('bare', { head: null, requests: 0, billed: null, durationMs: null, identity: null, isCurrent: true }),
    })))
    const el = query(m.container, '.lc-inspector')
    assert.equal(query(el, '.lc-agents-inspector-stats').textContent, '—')
    assert.equal(queryAll(el, '.lc-agents-part').length, 0)
    assert.ok(text(el).includes('current'))
    assert.equal(queryAll(el, '.lc-inspector-open').length, 0)
    await m.unmount()
  })

  test('pin/unpin and open ride the callbacks', async () => {
    const opened: string[] = []
    const pins: (string | null)[] = []
    const m = await mount(h(AgentInspector, propsOf({
      pinned: true,
      onOpen: id => { opened.push(id) },
      onPin: id => { pins.push(id) },
    })))
    await click(query(m.container, '.lc-inspector-open'))
    await click(query(m.container, `.lc-inspector-btn:not(.lc-inspector-open)`))
    assert.deepEqual(opened, ['w1'])
    assert.deepEqual(pins, [null])
    assert.ok(query(m.container, '.lc-inspector')!.hasAttribute('data-pinned'))
    await m.unmount()
  })
})

describe('AgentInspector — team membership', () => {
  test('a teammate renders its roster name, duty description, owned tasks, and the task link flashes the board', async () => {
    const focused = new Array<string | null>()
    const m = await mount(h(AgentInspector, propsOf({
      node: nodeOf('w1'),
      team: TEAM,
      roster: [{ name: 'worker-bee', description: '维度2：代码质量' }],
      onFocusTask: id => { focused.push(id) },
    })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes(DICT_EN['fleet.membership']))
    assert.ok(text(el).includes('worker-bee'))
    assert.ok(text(el).includes('teammate'))
    assert.ok(text(el).includes('维度2：代码质量'))
    const tasks = queryAll(el, '.lc-inspector-task')
    assert.equal(tasks.length, 4)
    assert.ok(text(tasks[0]).includes('completed'))
    assert.ok(text(tasks[3]).includes('pending'))
    await click(query(tasks[0], '.lc-inspector-task-link'))
    assert.deepEqual([...focused], ['task-1'])
    await m.unmount()
  })

  test('the lead row, a failed member with its error, and a provisioning member', async () => {
    for (const [id, marker] of [['root', 'lead'], ['w2', 'provider blew up'], ['w3', 'provisioning']] as const) {
      const m = await mount(h(AgentInspector, propsOf({ node: nodeOf(id), team: TEAM })))
      const el = query(m.container, '.lc-inspector')
      assert.ok(text(el).includes(marker), `${id} shows ${marker}`)
      // No owned tasks for these members.
      assert.equal(queryAll(el, '.lc-inspector-task').length, 0)
      await m.unmount()
    }
  })
})

describe('AgentInspector — the fleet-detail sections', () => {
  const DETAIL: FleetDetail = {
    descriptor: { mode: 'continuable', label: 'worker-bee', provider: 'fork', agentModel: 'deepseek-v4', persona: 'careful reviewer' },
    initialPrompt: 'Review the diff carefully.',
    messages: [],
    truncated: false,
  }

  test('descriptor and prompt render off the landed detail; the node model joins the config', async () => {
    const m = await mount(h(AgentInspector, propsOf({
      node: nodeOf('w1', { model: 'deepseek-flash' }),
      detail: { detail: DETAIL },
    })))
    const el = query(m.container, '.lc-inspector')
    // The node's own model leads; the descriptor's distinct model follows, deduped.
    assert.ok(text(el).includes('deepseek-flash · fork · deepseek-v4 · careful reviewer'))
    assert.ok(text(el).includes('Review the diff carefully.'))
    // jsdom reports no clamping: the expand toggle stays hidden.
    assert.equal(queryAll(el, '.lc-inspector-btn').length, 1, 'only the open button')
    await m.unmount()
  })

  test('the config line dedupes the descriptor model against the node model and skips absent fields', async () => {
    const m = await mount(h(AgentInspector, propsOf({
      node: nodeOf('w1', { model: 'deepseek-v4' }),
      detail: { detail: { descriptor: { mode: 'continuable', label: 'w', agentModel: 'deepseek-v4' }, messages: [], truncated: false } },
    })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes(DICT_EN['fleet.config']))
    // One model mention only — the descriptor's identical model dedupes, no provider listed.
    assert.equal(text(el).match(/deepseek-v4/g)?.length, 1)
    await m.unmount()
  })

  test('the latest reply renders with its clock', async () => {
    const m = await mount(h(AgentInspector, propsOf({
      detail: { detail: { lastReply: { time: 1_700_000_000_000, text: '报告完毕' }, messages: [], truncated: false } },
    })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes(DICT_EN['fleet.members.reply']))
    assert.ok(text(el).includes('报告完毕'))
    await m.unmount()
  })

  test('a clamped prompt expands and collapses', async () => {
    // Fake layout: the prompt box measures taller than its clamp.
    const realScroll = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight')
    const realClient = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 100 } })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 20 } })
    try {
      const m = await mount(h(AgentInspector, propsOf({ detail: { detail: DETAIL } })))
      const el = query(m.container, '.lc-inspector')
      const buttons = queryAll(el, '.lc-inspector-btn').filter(b => text(b) === DICT_EN['fleet.expand'])
      assert.equal(buttons.length, 1)
      await click(buttons[0])
      assert.ok(query(el, '.lc-inspector-prompt')!.className.includes('lc-inspector-prompt-open'))
      await click(queryAll(el, '.lc-inspector-btn').filter(b => text(b) === DICT_EN['fleet.collapse'])[0])
      assert.ok(!query(el, '.lc-inspector-prompt')!.className.includes('lc-inspector-prompt-open'))
      await m.unmount()
    } finally {
      if (realScroll !== undefined) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', realScroll)
      if (realClient !== undefined) Object.defineProperty(HTMLElement.prototype, 'clientHeight', realClient)
    }
  })

  test('an in-flight read notes itself; a detail without descriptor hides the section', async () => {
    const m = await mount(h(AgentInspector, propsOf({ detail: undefined })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.detailLoading']))
    await m.unmount()
    const m2 = await mount(h(AgentInspector, propsOf({ detail: { detail: { messages: [], truncated: false } } })))
    assert.ok(!text(m2.container).includes(DICT_EN['fleet.config']))
    assert.ok(!text(m2.container).includes(DICT_EN['fleet.prompt']))
    await m2.unmount()
  })
})

describe('AgentInspector — comms', () => {
  const COMMS: CommsRow[] = [
    { key: 'w1:9', to: 'w1', time: 100, kind: 'relay', from: 'root', text: 'how far along?' },
    { key: 'root:4', to: 'root', time: 90, kind: 'settled', from: 'w1', text: 'w1 finished' },
    { key: 'w1:3', to: 'w1', time: 80, kind: 'mailbox', fromName: 'lead', text: 'old school' },
    // Neither an id nor a name: the arrow alone introduces the recipient.
    { key: 'w1:2', to: 'w1', time: 70, kind: 'relay', text: 'anonymous relay' },
  ]

  test('rows render with peer links; clicking a peer pins it', async () => {
    const pins: (string | null)[] = []
    const m = await mount(h(AgentInspector, propsOf({
      comms: COMMS,
      labelOf: id => ({ root: 'Main Agent', w1: 'worker-bee' })[id] ?? id,
      onPin: id => { pins.push(id) },
    })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes(DICT_EN['fleet.messages']))
    const rows = queryAll(el, '.lc-inspector-comm')
    assert.equal(rows.length, 4)
    assert.ok(text(rows[0]).includes('Main Agent'))
    // The self side (this inspector's agent) renders as plain text, its peer as a button.
    assert.ok(text(rows[1]).includes('worker-bee'))
    assert.ok(text(rows[1]).includes('Main Agent'))
    // The historical mailbox row names its sender without an id join.
    assert.ok(text(rows[2]).includes('lead'))
    assert.ok(text(rows[3]).includes('worker-bee'))
    await click(query(rows[0], 'button.lc-inspector-comm-peer'))
    // The settled row's self side is plain text; its one button pins the recipient.
    await click(query(rows[1], 'button.lc-inspector-comm-peer'))
    assert.deepEqual(pins, ['root', 'root'])
    await m.unmount()
  })

  test('settled notices render the localized variant with the raw text on the tooltip', async () => {
    const settled: CommsRow[] = [
      { key: 'root:4', to: 'root', time: 90, kind: 'settled', from: 'w1', text: 'Background subagent w1 finished and will do no further work unless you send it more.' },
    ]
    const m = await mount(h(AgentInspector, propsOf({ comms: settled, labelOf: id => ({ root: 'Main Agent', w1: 'worker-bee' })[id] ?? id })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes(DICT_EN['fleet.settled.finished']))
    assert.ok(!text(el).includes('Background subagent'), 'the raw boilerplate stays on the tooltip only')
    assert.ok(text(el).includes('worker-bee'))
    assert.ok(text(el).includes('Main Agent'))
    await m.unmount()
  })

  test('more than six rows clamp to six', async () => {
    const many: CommsRow[] = Array.from({ length: 8 }, (_, i) => ({
      key: `w1:${i}`, to: 'w1', time: i, kind: 'relay' as const, from: 'root', text: `m${i}`,
    }))
    const m = await mount(h(AgentInspector, propsOf({ comms: many })))
    assert.equal(queryAll(m.container, '.lc-inspector-comm').length, 6)
    await m.unmount()
  })
})
