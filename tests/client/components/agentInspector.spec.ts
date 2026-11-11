import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, afterEach, vi } from 'vitest'
import { AgentInspector, type AgentInspectorProps } from '../../../src/client/components/agentInspector'
import { type AgentNode } from '../../../src/client/agentTree'
import { type FleetTeam } from '../../../src/client/fleetTeam'
import { type CommsRow } from '../../../src/client/fleetDetail'
import { type FleetDetail } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text, keydown, flush } from '../helpers/kit'
import { makeUpgradeGate } from '../../../src/client/components/upgradeGate'
import { disposeRetention } from '../../../src/client/retention'
import { type makePluginInfo as makePluginInfoFn } from '../../../src/client/components/pluginInfo'
import { TestClientCtx, asClientCtx } from '../helpers/harness'

describe('agentInspector', () => {

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
    assert.ok(text(el).includes(DICT_EN['fleet.role.teammate']))
    assert.ok(text(el).includes('维度2：代码质量'))
    const tasks = queryAll(el, '.lc-inspector-task')
    assert.equal(tasks.length, 4)
    assert.ok(text(tasks[0]).includes('completed'))
    assert.ok(text(tasks[3]).includes('pending'))
    await click(query(tasks[0], '.lc-inspector-task-link'))
    assert.deepEqual([...focused], ['task-1'])
    await m.unmount()
  })

  test('a modern ownerId team without a roster still lists the agent’s tasks', async () => {
    const focused = new Array<string | null>()
    const team: FleetTeam = {
      members: [],
      tasks: [{ id: 'task-7', subject: 'modern task', description: '', status: 'in_progress', ownerId: 'w1', blockedBy: [], writeScopes: [], ready: false, warnings: [] }],
    }
    const m = await mount(h(AgentInspector, propsOf({ node: nodeOf('w1'), team, onFocusTask: id => { focused.push(id) } })))
    const tasks = queryAll(query(m.container, '.lc-inspector'), '.lc-inspector-task')
    assert.equal(tasks.length, 1)
    assert.ok(text(tasks[0]).includes('modern task'))
    await click(query(tasks[0], '.lc-inspector-task-link'))
    assert.deepEqual([...focused], ['task-7'])
    await m.unmount()
  })

  test('the lead row, a failed member with its error, and a provisioning member', async () => {
    for (const [id, marker] of [['root', 'lead'], ['w2', 'provider blew up'], ['w3', 'provisioning']] as const) {
      const m = await mount(h(AgentInspector, propsOf({ node: nodeOf(id), team: TEAM })))
      const el = query(m.container, '.lc-inspector')
      assert.ok(text(el).includes(marker), `${id} shows ${marker}`)
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

  test('descriptor and prompt render off the landed detail; the config line dedupes the model; the reply carries its clock', async () => {
    const m = await mount(h(AgentInspector, propsOf({
      node: nodeOf('w1', { model: 'deepseek-flash', reasoningEffort: 'max' }),
      detail: { detail: DETAIL },
    })))
    const el = query(m.container, '.lc-inspector')
    assert.ok(text(el).includes('deepseek-flash (max) · fork · deepseek-v4 · careful reviewer'))
    assert.ok(text(el).includes('Review the diff carefully.'))
    assert.equal(queryAll(el, '.lc-inspector-btn').length, 1, 'only the open button')
    await m.unmount()

    const deduped = await mount(h(AgentInspector, propsOf({
      node: nodeOf('w1', { model: 'deepseek-v4' }),
      detail: { detail: { descriptor: { mode: 'continuable', label: 'w', agentModel: 'deepseek-v4' }, messages: [], truncated: false } },
    })))
    const dedupedEl = query(deduped.container, '.lc-inspector')
    assert.ok(text(dedupedEl).includes(DICT_EN['fleet.config']))
    assert.equal(text(dedupedEl).match(/deepseek-v4/g)?.length, 1)
    await deduped.unmount()

    const reply = await mount(h(AgentInspector, propsOf({
      detail: { detail: { lastReply: { time: 1_700_000_000_000, text: '报告完毕' }, messages: [], truncated: false } },
    })))
    const replyEl = query(reply.container, '.lc-inspector')
    assert.ok(text(replyEl).includes(DICT_EN['fleet.members.reply']))
    assert.ok(text(replyEl).includes('报告完毕'))
    await reply.unmount()
  })

  test('a clamped prompt expands and collapses', async () => {
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
    { key: 'w1:9', to: 'w1', seq: 9, time: 100, kind: 'relay', from: 'root', text: 'how far along?' },
    { key: 'root:4', to: 'root', seq: 4, time: 90, kind: 'settled', from: 'w1', text: 'w1 finished' },
    { key: 'w1:3', to: 'w1', seq: 3, time: 80, kind: 'mailbox', fromName: 'lead', text: 'old school' },
    { key: 'w1:2', to: 'w1', seq: 2, time: 70, kind: 'relay', text: 'anonymous relay' },
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
    assert.ok(text(rows[1]).includes('worker-bee'))
    assert.ok(text(rows[1]).includes('Main Agent'))
    assert.ok(text(rows[2]).includes('lead'))
    assert.ok(text(rows[3]).includes('worker-bee'))
    await click(query(rows[0], 'button.lc-inspector-comm-peer'))
    await click(query(rows[1], 'button.lc-inspector-comm-peer'))
    assert.deepEqual(pins, ['root', 'root'])
    await m.unmount()
  })

  test('settled notices render the localized variant with the raw text on the tooltip', async () => {
    const settled: CommsRow[] = [
      { key: 'root:4', to: 'root', seq: 4, time: 90, kind: 'settled', from: 'w1', text: 'Background subagent w1 finished and will do no further work unless you send it more.' },
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
      key: `w1:${i}`, to: 'w1', seq: i, time: i, kind: 'relay' as const, from: 'root', text: `m${i}`,
    }))
    const m = await mount(h(AgentInspector, propsOf({ comms: many })))
    assert.equal(queryAll(m.container, '.lc-inspector-comm').length, 6)
    await m.unmount()
  })
})
})

describe('upgradeGate', () => {

const kit = makeKit()
const Gate = makeUpgradeGate(kit)

function render(sessionId: string | undefined, extra: { current?: string; minimum?: string } = {}) {
  return mount(h(Gate, { sessionId, current: extra.current ?? '0.1.1-rc.2', minimum: extra.minimum ?? '0.2.0-rc.2' }))
}

describe('UpgradeGate', () => {
  test('renders both versions and the upgrade prompt', async () => {
    const en = await render('s-en')
    try {
      assert.match(text(en.container), /Update DeepSeek Harness/)
      assert.match(text(en.container), /dsh-context supports DeepSeek Harness v0\.2\.0-rc\.2 or newer\./)
      assert.match(text(en.container), /v0\.1\.1-rc\.2/)
      assert.match(text(en.container), /Current/)
      assert.match(text(en.container), /Minimum required/)
    } finally {
      await en.unmount()
    }
    const zh = await mount(h(makeUpgradeGate(makeKit('zh')), { sessionId: 's-zh', current: '0.1.1-rc.2', minimum: '0.2.0-rc.2' }))
    assert.ok(text(zh.container).includes('请更新 DeepSeek Harness 版本'))
    await zh.unmount()
  })

  test('OK dismisses and the dismissal survives a remount; ×, a backdrop click, and Escape dismiss; a card click and other keys do not', async () => {
    const first = await render('s-ok')
    await click(query(first.container, '.lc-gate-ok'))
    assert.equal(first.container.querySelector('.lc-modal-backdrop'), null)
    await first.unmount()
    const second = await render('s-ok')
    assert.equal(second.container.querySelector('.lc-modal-backdrop'), null, 'the ledger keeps it closed')
    await second.unmount()

    const x = await render('s-x')
    await click(query(x.container, '.lc-modal-close'))
    assert.equal(x.container.querySelector('.lc-modal-backdrop'), null)
    await x.unmount()

    const backdrop = await render('s-backdrop')
    await click(query(backdrop.container, '.lc-gate-card'))
    assert.ok(backdrop.container.querySelector('.lc-modal-backdrop') !== null, 'card clicks stay inside')
    await click(query(backdrop.container, '.lc-modal-backdrop'))
    assert.equal(backdrop.container.querySelector('.lc-modal-backdrop'), null)
    await backdrop.unmount()

    const esc = await render('s-esc')
    await keydown('Enter')
    assert.ok(esc.container.querySelector('.lc-modal-backdrop') !== null)
    await keydown('Escape')
    assert.equal(esc.container.querySelector('.lc-modal-backdrop'), null)
    await keydown('Escape')
    assert.equal(esc.container.querySelector('.lc-modal-backdrop'), null)
    await esc.unmount()
  })

  test('an in-place session switch re-evaluates the ledger', async () => {
    const m = await render('s-switch-a')
    await click(query(m.container, '.lc-gate-ok'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.update(h(Gate, { sessionId: 's-switch-b', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await m.update(h(Gate, { sessionId: 's-switch-a', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })

  test('a missing sessionId still renders and dismisses', async () => {
    const m = await render(undefined)
    assert.ok(m.container.querySelector('.lc-modal-backdrop') !== null)
    await click(query(m.container, '.lc-gate-ok'))
    assert.equal(m.container.querySelector('.lc-modal-backdrop'), null)
    await m.unmount()
  })
})

describe('UpgradeGate retention', () => {
  test('the dismissed ledger is bounded and dispose forgets dismissals', async () => {
    const gate = makeUpgradeGate(makeKit())
    for (let i = 0; i < 65; i++) {
      const m = await mount(h(gate, { sessionId: 'gate-cap-' + i, current: '0.1.0', minimum: '0.2.0-rc.2' }))
      await click(query(m.container, '.lc-gate-ok'))
      await m.unmount()
    }
    const evicted = await mount(h(gate, { sessionId: 'gate-cap-0', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(evicted.container.querySelector('.lc-modal-backdrop') !== null, 'the oldest dismissal fell out of the ledger')
    await evicted.unmount()

    const kept = await mount(h(gate, { sessionId: 'gate-cap-64', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.equal(kept.container.querySelector('.lc-modal-backdrop'), null, 'the newest dismissal survives')
    await kept.unmount()

    disposeRetention()
    const forgotten = await mount(h(gate, { sessionId: 'gate-cap-64', current: '0.1.0', minimum: '0.2.0-rc.2' }))
    assert.ok(forgotten.container.querySelector('.lc-modal-backdrop') !== null, 'dispose forgets dismissals')
    await forgotten.unmount()
  })
})
})

describe('pluginInfo', () => {

const kit = makeKit()

function stubVersion(latest: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, value: { ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loadPluginInfo(version?: string, ctx = new TestClientCtx()): Promise<ReturnType<typeof makePluginInfoFn>> {
  vi.resetModules()
  const globals = globalThis as Record<string, unknown>
  if (version === undefined) delete globals.__DSH_CTX_VERSION__
  else globals.__DSH_CTX_VERSION__ = version
  const { resetVersionSource } = await import('../../../src/client/versionSource')
  resetVersionSource()
  const mod = await import('../../../src/client/components/pluginInfo')
  return mod.makePluginInfo(kit, asClientCtx(ctx))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('PluginInfo', () => {
  test('dev build renders the static rows and never checks the version route', async () => {
    const fetchMock = stubVersion('9.9.9')
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { pluginNavigation: { openBundle: (name: string) => { opened.push(name) } } } })
    const PluginInfo = await loadPluginInfo(undefined, ctx)
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 0)
    const rows = queryAll(m.container, '.lc-pi-row')
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(r => query(r, '.lc-pi-label').textContent), ['Plugin', 'GitHub', 'Plugin Settings'])
    for (const row of rows) assert.equal(queryAll(row, '.lc-pi-label .lc-pi-labelicon').length, 1)
    assert.equal(query(rows[0], '.lc-pi-value').textContent, 'dsh-context (v0.0.0-dev)')
    assert.equal(rows[0].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(rows[0].getAttribute('target'), '_blank')
    assert.equal(rows[0].getAttribute('rel'), 'noreferrer')
    assert.equal(query(rows[1], '.lc-pi-value').textContent, 'bowenliang123/dsh-context')
    assert.equal(rows[2].getAttribute('href'), null)
    const hint = query(m.container, '.lc-pi-hint')
    assert.equal(hint.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(hint.getAttribute('target'), '_blank')
    assert.equal(hint.getAttribute('rel'), 'noreferrer')
    assert.equal(queryAll(m.container, '.lc-pi-update').length, 0)
    rows[2].click()
    assert.deepEqual(opened, ['dsh-context'], 'the settings row jumps through the Plugins panel navigator')
    await m.unmount()
  })

  test('release build with a newer version appends the update chip', async () => {
    const fetchMock = stubVersion('1.1.0')
    const PluginInfo = await loadPluginInfo('1.0.0')
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), 'api/dsh-context/version')
    assert.deepEqual(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)), {})
    assert.ok(text(m.container).includes('dsh-context (v1.0.0)'))
    assert.equal(query(m.container, '.lc-pi-update').textContent, '↑ v1.1.0')
    await m.unmount()
  })
})
})
