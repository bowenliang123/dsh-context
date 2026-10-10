import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeAgentGraph } from '../../../src/client/components/agentGraph'
import { DICT_EN } from '../../../src/client/i18n'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import type { AgentSelfStats } from '../../../src/client/agentTree'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { blur, click, flush, focus, hover, makeKit, mount, query, queryAll, text, unhover, until, wheel } from '../helpers/kit'

const kit = makeKit()

// The price book's loader stays pending by default, so no card shows a cost
// estimate unless a test arms the fixture itself.
beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => new Promise(() => {}))
})

afterEach(() => {
  resetModelPrices()
})

/** The price-book fixture (the stats board specs' own): deepseek-v4-flash at $0.15/$0.6/$0.003 per 1M. */
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
  refreshed: string[] = []
  rejectRefresh = false
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

  refreshSubagents(parentSessionId: string): Promise<void> {
    this.refreshed.push(parentSessionId)
    return this.rejectRefresh ? Promise.reject(new Error('catalog unavailable')) : Promise.resolve()
  }

  setState(byId: Record<string, unknown>): void {
    this.state = { byId }
    for (const fn of this.listeners) fn()
  }
}

function makeView(sessions: unknown, options: { locale?: 'en' | 'zh' } = {}) {
  // The session jump rides the view owner's verb (uiWorkspace.openSession).
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
  test('no sessions service renders nothing (and mounts/unmounts cleanly)', async () => {
    const ctx = new TestClientCtx()
    const View = makeAgentGraph(asClientCtx(ctx), kit)
    const m = await mount(h(View, { sessionId: 's1', self: selfStats() }))
    assert.equal(text(m.container), '')
    await m.unmount()
  })

  test('a service without the list feed renders nothing', async () => {
    const View = makeView({ open: () => {} })
    const m = await mount(h(View, { sessionId: 's1' }))
    assert.equal(text(m.container), '')
    await m.unmount()
  })

  test('missing or empty session id anchors nothing', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m1 = await mount(h(View, { self: selfStats() }))
    assert.equal(text(m1.container), '')
    await m1.unmount()
    const m2 = await mount(h(View, { sessionId: '', self: selfStats() }))
    assert.equal(text(m2.container), '')
    await m2.unmount()
    assert.deepEqual(face.refreshed, [])
  })
})

describe('AgentGraph — the family tree', () => {
  test('renders cards, chips, links, inspector, and the legend', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    const cards = queryAll(m.container, '.lc-agent-card')
    assert.equal(cards.length, 3)
    assert.deepEqual(face.refreshed, ['root'])

    // Chips: 3 agents, 2 running, combined context tokens (self 500 + 830 + 950).
    const rendered = text(m.container)
    assert.ok(rendered.includes('3 agents'))
    assert.ok(rendered.includes('2 running'))
    assert.ok(rendered.includes('2.3k tokens in context'))

    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.equal(self.getAttribute('data-agent'), 'root')
    // The current card is inert: no button role, no tab stop.
    assert.equal(self.getAttribute('role'), null)
    assert.equal(self.getAttribute('tabindex'), null)
    assert.ok(text(self).includes('50%'))
    // The headline figure is the CONSUMED tokens (self billed 1200), not the context size.
    assert.ok(text(self).includes('1.2k'))
    assert.ok(self.querySelector('.lc-agent-self-badge') !== null)
    assert.ok(query(m.container, '[data-agent="worker"]').querySelector('.lc-agent-self-badge') === null)

    // Links join both children as bezier curves out of the root card's foot
    // (x=276: the natural slot pitch, with the root centered over the two leaf slots)
    // with joint plugs at both ends; the running one layers a flowing pulse over the solid lineage stroke.
    const links = queryAll(m.container, 'path.lc-agents-link')
    assert.equal(links.length, 2)
    assert.ok(links.every(l => l.getAttribute('d')?.startsWith('M 276 ')))
    assert.ok(links.every(l => l.getAttribute('d')?.includes(' C ')))
    assert.equal(queryAll(m.container, 'path.lc-agents-link-live').length, 1)
    assert.equal(queryAll(m.container, 'path.lc-agents-flow').length, 1)
    assert.equal(queryAll(m.container, 'circle.lc-agents-joint').length, 4)

    const worker = query(m.container, '[data-agent="worker"]')
    assert.equal(worker.getAttribute('role'), 'button')
    assert.ok(text(worker).includes('worker-bee'))
    assert.ok(text(worker).includes('83%'))
    // The headline is the billed consumption (150); the activity footer carries the duration and the step count.
    assert.ok(text(worker).includes('150'))
    assert.ok(text(worker).includes('42s'))
    assert.equal(query(worker, '.lc-agent-meta-text').textContent, '42s · 5 steps')
    // The current agent writes no subagent-timing projection: the tab's own active time
    // (AgentSelfStats.durationMs) is what fills its footer, beside the step count.
    assert.equal(query(self, '.lc-agent-meta-text').textContent, '6m27s · 3 steps')
    // Every card shares one pitch — the root claims no extra room.
    assert.equal(self.style.width, worker.style.width)
    // Timeline composition → one bar segment per non-empty category.
    assert.equal(worker.querySelectorAll('.lc-agent-bar-seg').length, 3)

    const done = query(m.container, '[data-agent="done"]')
    // The work state rides the harness's own glyphs: the popup's spinner while an agent runs,
    // its green dot once it is done.
    assert.equal(query(self, '.lc-agent-state').getAttribute('data-state'), 'ongoing')
    assert.equal(query(worker, '.lc-agent-state').getAttribute('data-state'), 'ongoing')
    assert.equal(query(done, '.lc-agent-state').getAttribute('data-state'), 'done')
    // Pressure-only: a single threshold-colored fill; no consumption data → a dash headline,
    // and the meta row carries just the occupancy at its right.
    assert.equal(done.querySelectorAll('.lc-agent-bar-seg').length, 1)
    assert.ok(text(done).includes('—'))
    // Its settled turn gives it the duration too; the occupancy keeps the right edge.
    assert.equal(query(done, '.lc-agent-meta-text').textContent, '9s')
    assert.equal(query(done, '.lc-agent-meta').textContent, '9s95%')

    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('Main Agent'))
    assert.ok(text(inspector).includes('current'))
    assert.ok(text(inspector).includes('500 / 1.0k · 50%'))
    assert.ok(text(inspector).includes('3 steps'))
    assert.ok(text(inspector).includes('1.2k billed'))
    assert.ok(!text(inspector).includes(DICT_EN['fleet.open']))
    // The composition readout mirrors the inspected node's bar.
    assert.ok(text(inspector).includes('User Messages'))
    assert.ok(text(inspector).includes('≈500 (100%)'))

    assert.equal(queryAll(m.container, '.lc-agents-legend-item').length, 9)

    // The stage cancels a horizontal swipe it cannot consume, so the browser never reads it as a history swipe
    // (jsdom reports zero scroll metrics, so a horizontal-dominant gesture always sits at the edge).
    const stage = query(m.container, '.lc-agents-stage')
    assert.equal(wheel(stage, 30, 0), true, 'horizontal swipe canceled at the stage edge')
    assert.equal(wheel(stage, 30, 120), false, 'vertical-dominant gestures stay with the page')

    await m.unmount()
  })

  test('the current card goes green once its own session stops running', async () => {
    // A parent session never carries a subagent-timing projection, so the tab's own folded
    // steps are the only proof of finished work it can offer.
    const idle = family() as { root: { running: boolean } }
    idle.root.running = false
    const View = makeView(new FakeSessions(idle))
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.equal(query(m.container, '.lc-agent-card.lc-agent-self .lc-agent-state').getAttribute('data-state'), 'done')
    await m.unmount()

    // A session that has never folded a step claims nothing at all.
    const fresh = await mount(h(
      makeView(new FakeSessions({ root: { displayTitle: 'Main Agent', running: false, updatedAt: 10 } })),
      { sessionId: 'root', self: { head: null, billed: null, requests: 0 } },
    ))
    assert.equal(queryAll(fresh.container, '.lc-agent-state').length, 0)
    await fresh.unmount()
  })

  test('hover moves the inspector, click/Enter opens the session', async () => {
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
    // The hovered node's composition readout lists every category share.
    assert.ok(text(inspector).includes('System Prompt'))
    assert.ok(text(inspector).includes('≈800 (96%)'))
    assert.ok(worker.classList.contains('lc-agent-hover'))
    // Lineage focus: the hovered card's own link lights up, its sibling's stays dim.
    assert.ok(query(m.container, '.lc-agents-links').classList.contains('lc-agents-focus'))
    const lit = queryAll(m.container, 'g.lc-agents-on')
    assert.equal(lit.length, 1)
    await unhover(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('Main Agent'))
    assert.equal(queryAll(m.container, 'g.lc-agents-on').length, 0)
    assert.ok(!query(m.container, '.lc-agents-links').classList.contains('lc-agents-focus'))

    // Hovering the root lights its whole subtree (every link).
    await hover(query(m.container, '[data-agent="root"]'))
    assert.equal(queryAll(m.container, 'g.lc-agents-on').length, 2)
    await unhover(query(m.container, '[data-agent="root"]'))

    // Keyboard focus drives the same inspector + lineage affordance.
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
    // A pressure-only node has no composition row.
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
  })

  test('list updates re-render the tree live', async () => {
    const face = new FakeSessions({ root: { displayTitle: 'Main', running: false, updatedAt: 1 } })
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.ok(text(m.container).includes('No subagents yet'))
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 1)

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

    await m.unmount()
  })

  test('a family with no token data at all hides the totals chip', async () => {
    const View = makeView(new FakeSessions({ root: { displayTitle: 'Main', running: false, updatedAt: 1 } }))
    const m = await mount(h(View, { sessionId: 'root', self: { head: null, billed: null, requests: 0 } }))
    assert.ok(text(m.container).includes('1 agents'))
    assert.ok(!text(m.container).includes('tokens in context'))
    await m.unmount()
  })

  test('overflow chip when the family exceeds the cap', async () => {
    const byId: Record<string, unknown> = { root: { displayTitle: 'Main', running: false, updatedAt: 1 } }
    for (let i = 0; i < 30; i++) byId['kid' + i] = { parentId: 'root', updatedAt: i }
    const View = makeView(new FakeSessions(byId))
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.ok(text(m.container).includes('6 more not shown'))
    assert.ok(text(m.container).includes('31 agents'))
    await m.unmount()
  })

  test('a rejected catalog refresh is swallowed', async () => {
    const face = new FakeSessions(family())
    face.rejectRefresh = true
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(face.refreshed, ['root'])
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 3)
    await m.unmount()
  })

  test('a face without refreshSubagents still renders', async () => {
    const face = new FakeSessions(family())
    const bare: unknown = { list: face.list }
    const View = makeView(bare)
    const m = await mount(h(View, { sessionId: 'root' }))
    assert.equal(queryAll(m.container, '.lc-agent-card').length, 3)
    // No self stats: the current node falls back to its list-row timeline (230 tokens ≈ 23%).
    const self = query(m.container, '.lc-agent-card.lc-agent-self')
    assert.ok(text(self).includes('23%'))
    await m.unmount()
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
      // Pressure sample without a window: tokens with no denominator, no percentage.
      // Its settled time still fills the meta row (duration without an occupancy figure).
      windowless: {
        parentId: 'root', origin: 'subagent', updatedAt: 5,
        projectionValues: {
          contextPressure: { pressureTokens: 640 },
          subagentTiming: { settledMs: 5000 },
        },
      },
      // Usage reported but all-zero: the billed bit stays out of the inspector.
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
    // Zero occupancy on a known window: just the free track, no segments.
    assert.equal(zero.querySelectorAll('.lc-agent-bar-seg').length, 0)

    // Long labels wrap in full — no ellipsis truncation.
    assert.ok(text(query(m.container, '[data-agent="longname"]')).includes('a-very-long-descriptor-label'))

    await hover(bare)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('bare'))
    assert.equal(query(inspector, '.lc-agents-inspector-stats').textContent, '—')

    // Windowless pressure: a bare token figure, no ' / window' and no percentage; the settled time trails it.
    await hover(query(m.container, '[data-agent="windowless"]'))
    assert.equal(query(m.container, '.lc-agents-inspector-stats').textContent, '640 · 5s')
    const windowlessCard = query(m.container, '[data-agent="windowless"]')
    assert.ok(!text(windowlessCard).includes('%'))
    // The meta row carries the settled duration alone (no occupancy at its right).
    assert.equal(query(windowlessCard, '.lc-agent-meta').textContent, '5s')

    await hover(query(m.container, '[data-agent="flatusage"]'))
    assert.ok(!text(query(m.container, '.lc-agents-inspector')).includes('billed'))

    assert.ok(text(query(m.container, '.lc-agent-card.lc-agent-self')).includes('—'))

    await m.unmount()
  })

  test('zh locale renders translated chrome', async () => {
    const View = makeView(new FakeSessions(family()), { locale: 'zh' })
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    const rendered = text(m.container)
    assert.ok(rendered.includes('Agent 网络'))
    assert.ok(rendered.includes('3 个 Agent'))
    assert.ok(rendered.includes('当前'))
    assert.equal(query(m.container, '.lc-agent-card.lc-agent-self .lc-agent-meta-text').textContent, '6m27s · 3 步')
    await hover(query(m.container, '[data-agent="worker"]'))
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('多轮'))
    await m.unmount()
  })

  /** peak: (1M uncached × $0.15 + 0.5M output × $0.6) × DeepSeek's peak factor 2 = $0.90 (¥6.00). */
  const COST_LEDGER = { 'deepseek-official': { 'deepseek-v4-flash': { peak: { uncached: 1_000_000, cacheRead: 0, cacheWrite: 0, output: 500_000 } } } }

  test('the headline prices the consumed tokens once the price book lands', async () => {
    setModelPricesLoader(() => Promise.resolve(PROVIDERS))
    const rows = family() as {
      worker: { projectionValues: Record<string, unknown> }
    }
    // worker: both the tokenUsage tally and the cost ledger → '150 · $0.90'.
    rows.worker.projectionValues.contextTimeline = { ...(timeline(800, 5) as Record<string, unknown>), cost: COST_LEDGER }
    const byId: Record<string, unknown> = {
      ...rows,
      // cold: no tokenUsage tally at all — the fold's own cost ledger stands in (1.5M tokens priced).
      cold: {
        parentId: 'root', origin: 'subagent', running: false, updatedAt: 4,
        projectionValues: { contextTimeline: { ...(timeline(100, 0) as Record<string, unknown>), cost: COST_LEDGER } },
      },
    }
    const View = makeView(new FakeSessions(byId))
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(m.container, '[data-agent="worker"]')).includes('$0.90'), 'worker cost estimate')
    // The tally wins over the ledger when both exist (150, not 1.5M); the ledger stands in for a tally-less node.
    assert.ok(text(query(m.container, '[data-agent="worker"]')).includes('150 · $0.90'))
    assert.ok(text(query(m.container, '[data-agent="cold"]')).includes('1.5M · $0.90'))
    await m.unmount()

    // zh reads the price in CNY.
    const ViewZh = makeView(new FakeSessions(byId), { locale: 'zh' })
    const mz = await mount(h(ViewZh, { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(mz.container, '[data-agent="worker"]')).includes('¥6.00'), 'zh cost estimate')
    await mz.unmount()

    // A locale face without getLocale falls back to USD.
    const bare = new TestClientCtx({
      services: { sessions: new FakeSessions(byId), uiWorkspace: { openSession: () => {} } },
    })
    Object.defineProperty(bare, 'locale', { value: {} })
    const mb = await mount(h(makeAgentGraph(asClientCtx(bare), kit), { sessionId: 'root', self: selfStats() }))
    await until(() => text(query(mb.container, '[data-agent="worker"]')).includes('$0.90'), 'usd fallback')
    await mb.unmount()
  })
})

describe('AgentGraph — Fleet extras', () => {
  const TEAM = {
    members: [{ id: 'root', name: 'lead', role: 'lead' as const, phase: 'active' as const }],
    tasks: [],
  }

  function extras(team: import('../../../src/client/fleetTeam').FleetTeam | null) {
    return {
      team,
      pinnedId: 'worker',
      onPin: () => {},
      detailOf: () => ({ detail: null }),
      commsOf: () => [],
      labelOf: (id: string) => id,
      roster: [],
      onFocusTask: () => {},
    }
  }

  test('the extras team surfaces the chip when the team prop is absent; an explicit null wins', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    // extras alone: the chip reads the extras team; the pinned card rings.
    const m = await mount(h(View, { sessionId: 'root', self: selfStats(), extras: extras(TEAM) }))
    assert.ok(text(m.container).includes('1 members'))
    assert.ok(query(m.container, '[data-agent="worker"]').className.includes('lc-agent-pinned'))
    await m.unmount()

    // extras with a null team hides the chip.
    const m2 = await mount(h(View, { sessionId: 'root', self: selfStats(), extras: extras(null) }))
    assert.ok(!text(m2.container).includes('members ·'))
    await m2.unmount()
  })
})

describe('AgentGraph — cold-relative composition fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A multi-category slim head (the detail payload's cold-node field). */
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

  /** A detail payload without the head (the collections-only shape). */
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

    // The cold relative fetched at mount; until the read lands it wears the pressure-only fill.
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'])
    assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)

    // A snapshot tick while the read is in flight re-attaches the SAME
    // pending read; its duplicate landing settles on the identity bail-out instead of re-rendering.
    await act(async () => {
      face.setState(family())
    })
    await flush()

    await act(async () => {
      rpc.release({ ok: true, status: 200, json: async () => ({ ok: true, value: detailValue(composedHead()) }) })
    })
    await flush()
    // The head re-folds the bar: six composition segments, one per category.
    const composed = query(m.container, '[data-agent="done"]')
    assert.equal(composed.querySelectorAll('.lc-agent-bar-seg').length, 6)
    assert.ok(text(composed).includes('95%'), 'the pressure-anchored occupancy never changes')

    // A snapshot tick re-fetches nothing (the promise cache dedups).
    await act(async () => {
      face.setState(family())
    })
    await flush()
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'])

    // A remount (tab switch) resets the instance state but replays the
    // factory-cached read: the bar recomposes with no new request.
    await m.unmount()
    const remounted = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'], 'the cache never re-fetches')
    const replayed = query(remounted.container, '[data-agent="done"]')
    assert.equal(replayed.querySelectorAll('.lc-agent-bar-seg').length, 6, 'the cached head replays into the fresh instance')
    await remounted.unmount()
  })

  test('a failing fetch degrades to the pressure-only fill and never retries', async () => {
    const rpc = detailFetch({ reject: true })
    const { View, face } = makeFetchingView()
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    await flush()
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'])
    assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)
    // A later snapshot tick (fresh forest, still pressure-only) re-fetches nothing.
    await act(async () => {
      face.setState(family())
    })
    await flush()
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'], 'the sticky failure never re-fetches')
    await m.unmount()
  })

  test('a hostile head drops alone and a null value degrades the same way', async () => {
    for (const options of [{ head: 'garbage' }, { nullValue: true }]) {
      const rpc = detailFetch(options)
      const { View } = makeFetchingView()
      const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
      await flush()
      assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:done'])
      assert.equal(query(m.container, '[data-agent="done"]').querySelectorAll('.lc-agent-bar-seg').length, 1)
      assert.ok(text(query(m.container, '[data-agent="done"]')).includes('95%'))
      await m.unmount()
    }
  })

  test('a hostile empty session id degrades to the pressure-only fill without fetching', async () => {
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
    // No pressure on the row: the fetched head's fold total and window carry the bar.
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
    assert.deepEqual(rpc.calls, ['/api/dsh-context/detail:cold'])

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
