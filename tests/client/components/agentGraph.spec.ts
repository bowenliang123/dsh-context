import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { makeAgentGraph } from '../../../src/client/components/agentGraph'
import { DICT_EN } from '../../../src/client/i18n'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { LEAD_HUE, agentForestOf, familyHue, type AgentNode, type AgentSelfStats } from '../../../src/client/agentTree'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { blur, click, flush, focus, hover, makeKit, mount, query, queryAll, text, unhover, until, wheel } from '../helpers/kit'

const kit = makeKit()

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => new Promise(() => {}))
})

afterEach(() => {
  resetModelPrices()
})

const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 0.15, output: 0.6, cache_read: 0.003 } } } },
}

function timeline(total: number, requests = 0): unknown {
  return {
    ok: true,
    contextWindow: 1000,
    current: { system: 10, tools: 20, user: total, inject: 0, assistant: 0, tool: 0, total: total + 30 },
    requests: Array.from({ length: requests }, (_, i) => ({
      seq: i + 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1,
    })),
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
}

class FakeSessions {
  opened: string[] = []
  private listeners = new Set<() => void>()
  state: unknown

  constructor(byId: Record<string, unknown>) {
    this.state = { byId }
  }

  readonly list = {
    getSnapshot: (): unknown => this.state,
    subscribe: (fn: () => void): () => void => {
      this.listeners.add(fn)
      return () => this.listeners.delete(fn)
    },
  }

  openSession(id: string): void {
    this.opened.push(id)
  }

  setState(byId: Record<string, unknown>): void {
    this.state = { byId }
    for (const fn of this.listeners) fn()
  }
}

function makeView(sessions: unknown, options: { locale?: 'en' | 'zh' } = {}) {
  const nav = { openSession: (id: string) => (sessions as { openSession?: (id: string) => void }).openSession?.(id) }
  const ctx = new TestClientCtx({ locale: options.locale, services: { sessions, uiWorkspace: nav } })
  return makeAgentGraph(asClientCtx(ctx), options.locale === 'zh' ? makeKit('zh') : kit)
}

function selfStats(over: Partial<AgentSelfStats> = {}): AgentSelfStats {
  return {
    head: { tokens: 500, window: 1000, pct: 50, parts: [{ key: 'user', color: '#22c55e', value: 500 }] },
    billed: 1200,
    requests: 3,
    durationMs: 387_000,
    ...over,
  }
}

function family(): Record<string, unknown> {
  return {
    root: {
      displayTitle: 'Main Agent', running: true, updatedAt: 10,
      projectionValues: { contextTimeline: timeline(200, 2) },
    },
    worker: {
      parentId: 'root', origin: 'subagent', running: true, updatedAt: 8,
      projectionValues: {
        contextTimeline: timeline(800, 5),
        subagent: { mode: 'continuable', label: 'worker-bee' },
        subagentTiming: { settledMs: 42000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0 },
      },
    },
    done: {
      parentId: 'root', origin: 'subagent', running: false, updatedAt: 6,
      projectionValues: {
        contextPressure: { projectedTokens: 950, contextWindow: 1000 },
        subagent: { mode: 'one-shot' },
        subagentTiming: { settledMs: 9000, lastTurnCompleted: true },
      },
    },
  }
}

describe('AgentGraph — degrade arms', () => {
  test('renders nothing without a sessions face or a session id', async () => {
    const noService = makeAgentGraph(asClientCtx(new TestClientCtx()), kit)
    const View = makeView(new FakeSessions(family()))
    for (const [Component, props] of [
      [noService, { sessionId: 's1', self: selfStats() }],
      [makeView({ open: () => {} }), { sessionId: 's1' }],
      [View, { self: selfStats() }],
      [View, { sessionId: '', self: selfStats() }],
    ] as const) {
      const m = await mount(h(Component, props))
      assert.equal(text(m.container), '')
      await m.unmount()
    }
  })
})

describe('AgentGraph — the family tree', () => {
  test('renders cards, chips, links, inspector, and the legend', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    const cards = queryAll(m.container, '.lc-agent-card')
    assert.equal(cards.length, 3)

    const rendered = text(m.container)
    assert.ok(rendered.includes('3 agents'))
    assert.ok(rendered.includes('2 running'))
    assert.ok(rendered.includes('2.3k tokens in context'))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(self.getAttribute('data-agent'), 'root')
    assert.equal(self.getAttribute('role'), null)
    assert.equal(self.getAttribute('tabindex'), null)
    assert.ok(text(self).includes('50%'))
    assert.ok(text(self).includes('1.2k'))
    assert.ok(self.querySelector('.lc-agent-self-badge') !== null)
    assert.ok(query(m.container, '[data-agent="worker"]').querySelector('.lc-agent-self-badge') === null)

    assert.equal(queryAll(m.container, 'path.lc-agents-link').length, 2)
    assert.equal(queryAll(m.container, 'path.lc-agents-link-live').length, 1)
    assert.equal(queryAll(m.container, 'path.lc-agents-flow').length, 1)

    const worker = query(m.container, '[data-agent="worker"]')
    assert.equal(worker.getAttribute('role'), 'button')
    assert.ok(text(worker).includes('worker-bee'))
    assert.ok(text(worker).includes('83%'))
    assert.ok(text(worker).includes('150'))
    assert.ok(text(worker).includes('42s'))
    assert.equal(query(worker, '.lc-agent-meta-text').textContent, '42s · 5 steps')
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    assert.equal(self.style.width, worker.style.width)
    assert.equal(worker.querySelectorAll('.lc-agent-bar-seg').length, 3)

    const done = query(m.container, '[data-agent="done"]')
    assert.equal(query(self, '.lc-agent-state').getAttribute('data-state'), 'ongoing')
    assert.equal(query(worker, '.lc-agent-state').getAttribute('data-state'), 'ongoing')
    assert.equal(query(done, '.lc-agent-state').getAttribute('data-state'), 'done')
    assert.equal(done.querySelectorAll('.lc-agent-bar-seg').length, 1)
    assert.ok(text(done).includes('—'))
    assert.equal(query(done, '.lc-agent-meta-text').textContent, '9s')
    assert.equal(query(done, '.lc-agent-meta').textContent, '9s95%')

    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('Main Agent'))
    assert.ok(text(inspector).includes('current'))
    assert.ok(text(inspector).includes('500 / 1.0k · 50%'))
    assert.ok(text(inspector).includes('3 steps'))
    assert.ok(text(inspector).includes('1.2k billed'))
    assert.ok(!text(inspector).includes(DICT_EN['fleet.open']))
    assert.ok(text(inspector).includes('User Messages'))
    assert.ok(text(inspector).includes('≈500 (100%)'))

    assert.equal(queryAll(m.container, '.lc-agents-legend-item').length, 9)

    const stage = query(m.container, '.lc-agents-stage')
    assert.equal(wheel(stage, 30, 0), true, 'horizontal swipe canceled at the stage edge')
    assert.equal(wheel(stage, 30, 120), false, 'vertical-dominant gestures stay with the page')

    await m.unmount()
  })

  test('the current card goes green once its own session stops running', async () => {
    const idle = family() as { root: { running: boolean } }
    idle.root.running = false
    const View = makeView(new FakeSessions(idle))
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.equal(query(m.container, '.lc-agent-card.lc-agent-self .lc-agent-state').getAttribute('data-state'), 'done')
    await m.unmount()

    const fresh = await mount(h(
      makeView(new FakeSessions({ root: { displayTitle: 'Main Agent', running: false, updatedAt: 10 } })),
      { sessionId: 'root', self: { head: null, billed: null, requests: 0 } },
    ))
    assert.equal(queryAll(fresh.container, '.lc-agent-state').length, 0)
    assert.ok(!text(fresh.container).includes('tokens in context'), 'no token data at all hides the totals chip')
    await fresh.unmount()
  })

  test('hover and focus move the inspector, click/Enter opens the session, and an external focusId lights the member card', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    const worker = query(m.container, '[data-agent="worker"]')
    await hover(worker)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('worker-bee'))
    assert.ok(text(inspector).includes('continuable'))
    assert.ok(text(inspector).includes('5 steps'))
    assert.ok(text(inspector).includes('150 billed'))
    assert.ok(text(inspector).includes('42s'))
    assert.ok(text(inspector).includes(DICT_EN['fleet.open']))
    assert.ok(text(inspector).includes('System Prompt'))
    assert.ok(text(inspector).includes('≈800 (96%)'))
    assert.ok(worker.classList.contains('lc-agent-hover'))
    assert.ok(query(m.container, '.lc-agents-canvas').classList.contains('lc-agents-focus'))
    assert.ok(worker.classList.contains('lc-agent-on'))
    assert.ok(query(m.container, '[data-agent="root"]').classList.contains('lc-agent-on'))
    assert.ok(!query(m.container, '[data-agent="done"]').classList.contains('lc-agent-on'))
    const lit = queryAll(m.container, 'g.lc-agents-on')
    assert.equal(lit.length, 1)
    await unhover(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('Main Agent'))
    assert.equal(queryAll(m.container, 'g.lc-agents-on').length, 0)
    assert.ok(!query(m.container, '.lc-agents-canvas').classList.contains('lc-agents-focus'))

    await hover(query(m.container, '[data-agent="root"]'))
    assert.equal(queryAll(m.container, 'g.lc-agents-on').length, 2)
    await unhover(query(m.container, '[data-agent="root"]'))

    await focus(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('worker-bee'))
    assert.equal(queryAll(m.container, 'g.lc-agents-on').length, 1)
    await blur(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('Main Agent'))

    await click(worker)
    assert.deepEqual(face.opened, ['worker'])

    await hover(query(m.container, '[data-agent="done"]'))
    const doneInspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(doneInspector).includes('one-shot'))
    assert.ok(text(doneInspector).includes('950 / 1.0k · 95%'))
    assert.equal(doneInspector.querySelector('.lc-agents-inspector-parts'), null)
    await unhover(query(m.container, '[data-agent="done"]'))
    await act(async () => {
      query(m.container, '[data-agent="done"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(face.opened, ['worker', 'done'])
    await act(async () => {
      query(m.container, '[data-agent="worker"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(face.opened, ['worker', 'done'])
    await click(query(m.container, '[data-agent="root"]'))
    assert.deepEqual(face.opened, ['worker', 'done'])

    await m.unmount()

    const focused = await mount(h(View, { sessionId: 'root', self: selfStats(), focusId: 'done' }))
    const done = query(focused.container, '[data-agent="done"]')
    assert.ok(done.classList.contains('lc-agent-hover'), 'the focused card lights like a pointed-at one')
    assert.ok(done.classList.contains('lc-agent-on'), 'its direct relations light too')
    assert.ok(query(focused.container, '[data-agent="root"]').classList.contains('lc-agent-on'))
    assert.ok(query(focused.container, '.lc-agents-canvas').classList.contains('lc-agents-focus'))
    assert.equal(queryAll(focused.container, 'g.lc-agents-on').length, 1)
    await hover(query(focused.container, '[data-agent="worker"]'))
    assert.ok(!done.classList.contains('lc-agent-hover'), 'the live hover takes the slot')
    await unhover(query(focused.container, '[data-agent="worker"]'))
    assert.ok(done.classList.contains('lc-agent-hover'), 'the resting focus returns after the sweep')
    await focused.unmount()
  })

  test('list updates re-render the tree live, and a tall family offers Show all until expanded', async () => {
    const face = new FakeSessions({ root: { displayTitle: 'Main', running: false, updatedAt: 1 } })
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.ok(text(m.container).includes('No subagents yet'))
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 1)
    assert.ok(!query<HTMLElement>(m.container, '.lc-agents-stage').className.includes('lc-agents-stage-tall'))

    await act(async () => {
      face.setState({
        root: { displayTitle: 'Main', running: false, updatedAt: 1 },
        kid: { parentId: 'root', origin: 'subagent', running: true, updatedAt: 2 },
      })
    })
    await flush()
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 2)
    assert.ok(!text(m.container).includes('No subagents yet'))
    assert.ok(text(m.container).includes('2 agents'))
    assert.equal(queryAll(m.container, '.lc-agents-toggle').length, 0)
    await m.unmount()

    const byId: Record<string, unknown> = { root: { displayTitle: 'Main', running: false, updatedAt: 1 } }
    let parent = 'root'
    for (let i = 0; i < 4; i++) {
      byId['level' + i] = { parentId: parent, origin: 'subagent', updatedAt: 10 }
      parent = 'level' + i
    }
    for (let i = 0; i < 45; i++) byId['kid' + i] = { parentId: parent, origin: 'subagent', updatedAt: i }
    const TallView = makeView(new FakeSessions(byId))
    const tall = await mount(h(TallView, { sessionId: 'root', self: selfStats() }))
    assert.equal(queryAll(tall.container, '.lc-agent-card').length, 50)
    assert.ok(text(tall.container).includes('50 agents'))
    assert.ok(query<HTMLElement>(tall.container, '.lc-agents-stage').className.includes('lc-agents-stage-tall'))
    assert.equal(text(query(tall.container, '.lc-agents-toggle')), 'Show all')
    await click(query<HTMLElement>(tall.container, '.lc-agents-toggle'))
    assert.ok(query<HTMLElement>(tall.container, '.lc-agents-stage').className.includes('lc-agents-stage-all'))
    assert.equal(text(query(tall.container, '.lc-agents-toggle')), 'Show less')
    await click(query<HTMLElement>(tall.container, '.lc-agents-toggle'))
    assert.ok(!query<HTMLElement>(tall.container, '.lc-agents-stage').className.includes('lc-agents-stage-all'))
    assert.equal(text(query(tall.container, '.lc-agents-toggle')), 'Show all')
    await tall.update(h(TallView, { sessionId: 'other', self: selfStats() }))
    await flush()
    assert.equal(queryAll(tall.container, '.lc-agents-toggle').length, 0)
    await tall.unmount()
  })

  test('stat-less nodes render dashes; zero occupancy draws no bar fill', async () => {
    const View = makeView(new FakeSessions({
      root: { displayTitle: 'Main', running: false, updatedAt: 1 },
      bare: { parentId: 'root', origin: 'subagent', updatedAt: 2 },
      zero: {
        parentId: 'root', origin: 'subagent', updatedAt: 3,
        projectionValues: { contextPressure: { projectedTokens: 0, contextWindow: 1000 } },
      },
      longname: {
        parentId: 'root', origin: 'subagent', updatedAt: 4,
        projectionValues: { subagent: { mode: 'one-shot', label: 'a-very-long-descriptor-label' } },
      },
      windowless: {
        parentId: 'root', origin: 'subagent', updatedAt: 5,
        projectionValues: {
          contextPressure: { pressureTokens: 640 },
          subagentTiming: { settledMs: 5000 },
        },
      },
      flatusage: {
        parentId: 'root', origin: 'subagent', updatedAt: 6,
        projectionValues: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    }))
    const m = await mount(h(View, { sessionId: 'root', self: { head: null, billed: null, requests: 0 } }))

    const bare = query(m.container, '[data-agent="bare"]')
    assert.ok(text(bare).includes('—'))
    assert.equal(bare.querySelectorAll('.lc-agent-bar-seg').length, 0)

    const zero = query(m.container, '[data-agent="zero"]')
    assert.ok(text(zero).includes('0%'))
    assert.equal(zero.querySelectorAll('.lc-agent-bar-seg').length, 0)

    assert.ok(text(query(m.container, '[data-agent="longname"]')).includes('a-very-long-descriptor-label'))

    await hover(bare)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('bare'))
    assert.equal(query(inspector, '.lc-agents-inspector-stats').textContent, '—')

    await hover(query(m.container, '[data-agent="windowless"]'))
    assert.equal(query(m.container, '.lc-agents-inspector-stats').textContent, '640 · 5s')
    const windowlessCard = query(m.container, '[data-agent="windowless"]')
    assert.ok(!text(windowlessCard).includes('%'))
    assert.equal(query(windowlessCard, '.lc-agent-meta').textContent, '5s')

    await hover(query(m.container, '[data-agent="flatusage"]'))
    assert.ok(!text(query(m.container, '.lc-agents-inspector')).includes('billed'))

    assert.ok(text(query(m.container, '.lc-agent-card.lc-agent-self')).includes('—'))

    await m.unmount()
  })

  const COST_LEDGER = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000 } } } }

  test('the headline prices the consumed tokens once the price book lands', async () => {
    setModelPricesLoader(() => Promise.resolve(PROVIDERS))
    const rows = family() as {
      worker: { projectionValues: Record<string, unknown> }
    }
    rows.worker.projectionValues.contextTimeline = { ...(timeline(800, 5) as Record<string, unknown>), cost: COST_LEDGER }
    const byId: Record<string, unknown> = {
      ...rows,
      cold: {
        parentId: 'root', origin: 'subagent', running: false, updatedAt: 4,
        projectionValues: { contextTimeline: { ...(timeline(100, 0) as Record<string, unknown>), cost: COST_LEDGER } },
      },
    }
    const View = makeView(new FakeSessions(byId))
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(m.container, '[data-agent="worker"]')).includes('$0.90'), 'worker cost estimate')
    assert.ok(text(query(m.container, '[data-agent="worker"]')).includes('150 · $0.90'))
    assert.ok(text(query(m.container, '[data-agent="cold"]')).includes('1.5M · $0.90'))
    await m.unmount()

    const ViewZh = makeView(new FakeSessions(byId), { locale: 'zh' })
    const mz = await mount(h(ViewZh, { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(mz.container, '[data-agent="worker"]')).includes('¥6.00'), 'zh cost estimate')
    assert.ok(text(mz.container).includes('Agent 网络'), 'the zh title')
    assert.ok(text(mz.container).includes('当前'), 'the zh self marker')
    assert.ok(text(mz.container).includes('4 个 Agent'), 'the zh kit localizes the chips')
    await hover(query(mz.container, '[data-agent="worker"]'))
    assert.ok(text(query(mz.container, '.lc-agents-inspector')).includes('多轮'), 'the zh inspector copy')
    await mz.unmount()

    const bare = new TestClientCtx({
      services: { sessions: new FakeSessions(byId), uiWorkspace: { openSession: () => {} } },
    })
    Object.defineProperty(bare, 'locale', { value: {} })
    const mb = await mount(h(makeAgentGraph(asClientCtx(bare), kit), { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(mb.container, '[data-agent="worker"]')).includes('$0.90'), 'usd fallback')
    await mb.unmount()
  })
})

describe('AgentGraph — the Fleet seat', () => {
  const TEAM = {
    members: [{ id: 'root', name: 'lead', role: 'lead' as const, phase: 'active' as const }],
    tasks: [],
  }

  test('the team prop surfaces the chip and a teammate’s roster name; the pin rings both cards; an explicit null wins', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const team = { ...TEAM, members: [...TEAM.members, { id: 'worker', name: 'architect', role: 'teammate' as const, phase: 'active' as const }] }
    const m = await mount(h(View, { sessionId: 'root', self: selfStats(), team, pinnedId: 'worker', inspector: false, compact: true }))
    assert.ok(query(m.container, '.lc-agents').classList.contains('lc-agents-compact'))
    assert.ok(text(m.container).includes('2 members'))
    assert.ok(query(m.container, '[data-agent="worker"]').className.includes('lc-agent-pinned'))
    const worker = query(m.container, '[data-agent="worker"]')
    assert.ok(worker.getAttribute('style')?.includes('--lc-member-hue'))
    assert.equal(text(query(worker, '.lc-agent-label')), 'architect')
    assert.equal(text(query(worker, '.lc-agent-duty')), 'worker-bee')
    assert.equal(text(query(worker, '.lc-comms-avatar')), 'AR', 'the card wears the roster initials')
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.ok(self.getAttribute('style')?.includes(`--lc-member-hue: ${LEAD_HUE}`))
    assert.equal(queryAll(self, '.lc-agent-duty').length, 0)
    assert.equal(text(query(self, '.lc-comms-avatar')), 'LE', 'the lead card wears the shared role initials')
    assert.ok(query(self, '.lc-comms-avatar')?.className.includes('lc-comms-avatar-self'), 'the self card rings its avatar')
    const done = query(m.container, '[data-agent="done"]')
    assert.ok(done.getAttribute('style')?.includes('--lc-member-hue'))
    assert.equal(text(query(done, '.lc-agent-label')), 'done')
    assert.equal(queryAll(done, '.lc-agent-duty').length, 0)
    assert.equal(queryAll(m.container, '.lc-inspector').length, 0, 'the Fleet seat paints the graph alone')
    await m.unmount()

    const m2 = await mount(h(View, { sessionId: 'root', self: selfStats(), team: null }))
    assert.ok(!query(m2.container, '.lc-agents').classList.contains('lc-agents-compact'))
    assert.ok(!text(m2.container).includes('members ·'))
    assert.ok(query(m2.container, '.lc-inspector') !== null)
    await m2.unmount()
  })

  test('a current teammate and the incoming link keep the roster hue', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const team = { ...TEAM, members: [...TEAM.members, { id: 'worker', name: 'architect', role: 'teammate' as const, phase: 'active' as const }] }
    const m = await mount(h(View, { sessionId: 'worker', self: selfStats(), team, inspector: false }))
    const worker = query(m.container, '[data-agent="worker"]')
    assert.equal(worker.style.getPropertyValue('--lc-member-hue'), familyHue(1))
    const targetHues = ['worker', 'done'].map(id => query(m.container, `[data-agent="${id}"]`).style.getPropertyValue('--lc-member-hue'))
    assert.deepEqual(queryAll(m.container, 'path.lc-agents-link').map(el => el.getAttribute('stroke')), targetHues)
    await m.unmount()
  })

  test('a controlled forest and hover stay independent of the internal model', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const forest = agentForestOf({ byId: family() }, 'root', selfStats())
    const onHover = vi.fn()
    const m = await mount(h(View, { sessionId: 'root', forest, hoverId: 'done', onHover, inspector: false }))
    assert.ok(query(m.container, '[data-agent="done"]').className.includes('lc-agent-hover'))
    await hover(query(m.container, '[data-agent="worker"]'))
    expect(onHover).toHaveBeenCalledWith('worker')
    assert.ok(query(m.container, '[data-agent="done"]').className.includes('lc-agent-hover'))
    await m.unmount()
    const hidden = await mount(h(View, { sessionId: 'root', forest: null }))
    assert.equal(text(hidden.container), '')
    await hidden.unmount()
  })

  test('select mode highlights instead of jumping, while open mode keeps the jump copy and the inert current card', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const selected = new Array<string>()
    const m = await mount(h(View, { sessionId: 'root', self: selfStats(), team: TEAM, pinnedId: 'worker', inspector: false, onSelect: (id: string) => { selected.push(id) }, }))

    assert.ok(text(m.container).includes(DICT_EN['agents.subSelect']))
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(self.getAttribute('role'), 'button')
    assert.equal(self.getAttribute('aria-pressed'), 'false')
    await click(self)
    const worker = query(m.container, '[data-agent="worker"]')
    assert.equal(worker.getAttribute('aria-pressed'), 'true')
    assert.equal(query(m.container, '[data-agent="done"]').getAttribute('aria-pressed'), 'false')
    await click(worker)
    assert.deepEqual([...selected], ['root', 'worker'])
    assert.deepEqual(face.opened, [], 'a pick never jumps')

    await act(async () => {
      query(m.container, '[data-agent="done"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    await act(async () => {
      query(m.container, '[data-agent="done"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual([...selected], ['root', 'worker', 'done'])
    assert.deepEqual(face.opened, [], 'no card corner jump: the boards carry the open buttons')
    await m.unmount()

    const openFace = new FakeSessions(family())
    const open = await mount(h(makeView(openFace), { sessionId: 'root', self: selfStats() }))
    assert.ok(text(open.container).includes(DICT_EN['agents.sub']))
    assert.equal(query(open.container, '.lc-agent-card.lc-agent-self').getAttribute('role'), null)
    assert.equal(query(open.container, '[data-agent="worker"]').getAttribute('aria-pressed'), null)
    await click(query(open.container, '[data-agent="worker"]'))
    assert.deepEqual(openFace.opened, ['worker'])
    await open.unmount()
  })
})

describe('AgentGraph — cold-relative composition fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function composedHead(): unknown {
    return {
      ok: true,
      contextWindow: 1000,
      current: { system: 100, tools: 50, user: 200, inject: 50, skill: 0, assistant: 150, tool: 50, total: 600 },
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
    }
  }

  function detailValue(head: unknown): Record<string, unknown> {
    return {
      rev: 1,
      ...(head !== undefined ? { head } : {}),
      requests: [],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
    }
  }

  function detailFetch(options: { reject?: boolean; head?: unknown; nullValue?: boolean; defer?: boolean } = {}) {
    const calls: string[] = []
    let release: ((value: unknown) => void) | undefined
    vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
      const sessionId = (JSON.parse(String(init?.body)) as { sessionId?: unknown }).sessionId
      calls.push(`${String(url)}:${String(sessionId)}`)
      if (options.reject) throw new Error('transport down')
      if (options.defer) {
        return await new Promise((resolve) => { release = resolve })
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ ok: true, value: options.nullValue ? null : detailValue(options.head) }),
      }
    })
    return { calls, release: (value: unknown) => release?.(value) }
  }

  function makeFetchingView(): { View: ReturnType<typeof makeView>; face: FakeSessions } {
    const face = new FakeSessions(family())
    const ctx = new TestClientCtx({ services: { sessions: face } })
    return { View: makeAgentGraph(asClientCtx(ctx), kit), face }
  }

  test('pressure-only relatives fetch their head and re-render composed', async () => {
    const rpc = detailFetch({ defer: true })
    const { View, face } = makeFetchingView()
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'])
    assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)

    await act(async () => {
      face.setState(family())
    })
    await flush()

    await act(async () => {
      rpc.release({ ok: true, status: 200, json: async () => ({ ok: true, value: detailValue(composedHead()) }) })
    })
    await flush()
    const composed = query(m.container, '[data-agent="done"]')
    assert.equal(composed.querySelectorAll('.lc-agent-bar-seg').length, 6)
    assert.ok(text(composed).includes('95%'), 'the pressure-anchored occupancy never changes')

    await act(async () => {
      face.setState(family())
    })
    await flush()
    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'])

    await m.unmount()
    const remounted = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'], 'the cache never re-fetches')
    const replayed = query(remounted.container, '[data-agent="done"]')
    assert.equal(replayed.querySelectorAll('.lc-agent-bar-seg').length, 6, 'the cached head replays into the fresh instance')
    await remounted.unmount()
  })

  test('a failing fetch degrades to the pressure-only fill and never retries', async () => {
    const rpc = detailFetch({ reject: true })
    const { View, face } = makeFetchingView()
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'])
    assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)
    await act(async () => {
      face.setState(family())
    })
    await flush()
    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'], 'the sticky failure never re-fetches')
    await m.unmount()
  })

  test('a hostile head, a null value, or an empty id degrades to the pressure-only fill (the empty id without fetching)', async () => {
    for (const options of [{ head: 'garbage' }, { nullValue: true }]) {
      const rpc = detailFetch(options)
      const { View } = makeFetchingView()
      const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
      await flush()
      assert.deepEqual(rpc.calls, ['api/dsh-context/detail:done'])
      assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)
      assert.ok(text(query(m.container, '[data-agent="done"]')).includes('95%'))
      await m.unmount()
    }

    const rpc = detailFetch({ head: composedHead() })
    const face = new FakeSessions({
      root: { displayTitle: 'Main', running: false, updatedAt: 10 },
      '': {
        parentId: 'root', origin: 'subagent', updatedAt: 2,
        projectionValues: { contextPressure: { projectedTokens: 400, contextWindow: 1000 } },
      },
    })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const View = makeAgentGraph(asClientCtx(ctx), kit)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(rpc.calls, [], 'an empty id never opens the detail route')
    assert.equal(query(m.container, '[data-agent=""]').querySelectorAll('.lc-agent-bar-seg').length, 1)
    await m.unmount()
  })

  test('a head with no occupancy anchor still composes from the fold alone', async () => {
    const rpc = detailFetch({ head: composedHead(), defer: true })
    const face = new FakeSessions({
      root: { displayTitle: 'Main', running: false, updatedAt: 10 },
      cold: {
        parentId: 'root', origin: 'subagent', updatedAt: 2,
        projectionValues: { subagent: { mode: 'one-shot', label: 'chill' } },
      },
    })
    const ctx = new TestClientCtx({ services: { sessions: face } })
    const View = makeAgentGraph(asClientCtx(ctx), kit)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.equal(query(m.container, '[data-agent="cold"]').querySelectorAll('.lc-agent-bar-seg').length, 0)
    assert.deepEqual(rpc.calls, ['api/dsh-context/detail:cold'])

    await act(async () => {
      rpc.release({ ok: true, status: 200, json: async () => ({ ok: true, value: detailValue(composedHead()) }) })
    })
    await flush()
    const composed = query(m.container, '[data-agent="cold"]')
    assert.equal(composed.querySelectorAll('.lc-agent-bar-seg').length, 6, 'six category segments (no pressure fill)')
    assert.ok(text(composed).includes('60%'), 'the fold total prices against the head window')
    await m.unmount()
  })
})

describe('AgentGraph — viewport windowing', () => {
  function chain(count: number): { nodes: AgentNode[]; edges: { from: string; to: string }[] } {
    const nodes: AgentNode[] = []
    const edges: { from: string; to: string }[] = []
    for (let index = 0; index < count; index++) {
      const id = `step-${index}`
      nodes.push({
        id,
        label: id,
        ...(index > 0 ? { parentId: `step-${index - 1}` } : {}),
        depth: index,
        family: 0,
        isCurrent: index === 0,
        running: false,
        completed: true,
        subagent: index > 0,
        updatedAt: index,
        head: null,
        requests: 0,
        billed: null,
        costUsage: null,
        durationMs: null,
        identity: null,
      })
      if (index > 0) edges.push({ from: `step-${index - 1}`, to: id })
    }
    return { nodes, edges }
  }

  test('renders only the cards in the stage band and reveals deeper cards on scroll', async () => {
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.push(callback); return frames.length })
    try {
      const { nodes, edges } = chain(70)
      const Graph = makeAgentGraph(asClientCtx(new TestClientCtx()), kit)
      const m = await mount(h(Graph, { forest: { nodes, edges, solo: false }, team: null }))
      assert.equal(queryAll(m.container, '.lc-agent-card').length, 70, 'an unmeasured stage keeps every card')
      const stage = query<HTMLElement>(m.container, '.lc-agents-stage')
      Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 560 })
      let scrollTop = 0
      Object.defineProperty(stage, 'scrollTop', { configurable: true, get: () => scrollTop, set: (next: number) => { scrollTop = next } })
      await act(async () => { stage.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      const visible = queryAll(m.container, '.lc-agent-card').length
      assert.ok(visible < 70, 'the measured stage bounds the cards')
      assert.ok(query(m.container, '[data-agent="step-0"]') !== null)
      assert.equal(queryAll(m.container, '[data-agent="step-60"]').length, 0)
      scrollTop = 10600
      await act(async () => { stage.dispatchEvent(new Event('scroll')) })
      await act(async () => { for (const frame of frames.splice(0)) frame(0) })
      assert.ok(query(m.container, '[data-agent="step-60"]') !== null, 'a deep card appears after scrolling')
      assert.equal(queryAll(m.container, '[data-agent="step-0"]').length, 0)
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
