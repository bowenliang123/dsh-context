// AgentGraph (src/client/components/agentGraph.tsx) — the Agent network card
// rendered for real against a faithful in-memory sessions face: tree
// rendering with donut/ring geometry, hover inspector, click/keyboard
// navigation, catalog refresh, live snapshot updates, and every degrade arm
// (no service, no anchor, no stats).

import assert from 'node:assert/strict'
import { act } from 'react'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeAgentGraph, ringColorOf } from '../../../src/client/components/agentGraph'
import type { AgentSelfStats } from '../../../src/client/agentTree'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'

const kit = makeKit()

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

/** Click an SVG node (jsdom's SVGElement has no HTMLElement.click). */
async function clickEl(el: Element): Promise<void> {
  await act(async () => {
    el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
  })
}

/** A faithful in-memory `ctx.sessions` double: snapshot feed + navigation + catalog refresh. */
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

  open(id: string): void {
    this.opened.push(id)
  }

  refreshSubagents(parentSessionId: string): Promise<void> {
    this.refreshed.push(parentSessionId)
    return this.rejectRefresh ? Promise.reject(new Error('catalog unavailable')) : Promise.resolve()
  }

  /** Swap the snapshot and notify (act-wrapped by the caller via flush). */
  setState(byId: Record<string, unknown>): void {
    this.state = { byId }
    for (const fn of this.listeners) fn()
  }
}

function makeView(sessions: unknown, options: { locale?: 'en' | 'zh' } = {}) {
  const ctx = new TestClientCtx({ locale: options.locale, services: { sessions } })
  return makeAgentGraph(asClientCtx(ctx), options.locale === 'zh' ? makeKit('zh') : kit)
}

function selfStats(over: Partial<AgentSelfStats> = {}): AgentSelfStats {
  return {
    head: { tokens: 500, window: 1000, pct: 50, parts: [{ key: 'user', color: '#22c55e', value: 500 }] },
    billed: 1200,
    requests: 3,
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
      parentId: 'root', origin: 'subagent', running: true, completed: false, updatedAt: 8,
      projectionValues: {
        contextTimeline: timeline(800, 5),
        subagent: { mode: 'continuable', label: 'worker-bee' },
        subagentTiming: { settledMs: 42000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0 },
      },
    },
    done: {
      parentId: 'root', origin: 'subagent', running: false, completed: true, updatedAt: 6,
      projectionValues: {
        contextPressure: { projectedTokens: 950, contextWindow: 1000 },
        subagent: { mode: 'one-shot' },
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
    // Neither mount touched the catalog.
    assert.deepEqual(face.refreshed, [])
  })
})

describe('AgentGraph — the family tree', () => {
  test('renders nodes, chips, links, inspector, and the legend', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    const nodes = queryAll(m.container, 'g.lc-agent-node')
    assert.equal(nodes.length, 3)
    assert.deepEqual(face.refreshed, ['root'])

    // Chips: 3 agents, 2 running, combined context tokens (self 500 + 830 + 950).
    const rendered = text(m.container)
    assert.ok(rendered.includes('3 agents'))
    assert.ok(rendered.includes('2 running'))
    assert.ok(rendered.includes('2.3k tokens in context'))

    // The current node wears the brand self-ring and shows the freshest stats.
    const self = query(m.container, 'g.lc-agent-self')
    assert.equal(self.getAttribute('data-agent'), 'root')
    assert.equal(self.getAttribute('role'), 'img')
    assert.ok(text(self).includes('50%'))
    assert.ok(self.querySelector('.lc-agent-self-badge') !== null)
    assert.ok(query(m.container, 'g[data-agent="worker"]').querySelector('.lc-agent-self-badge') === null)

    // Links join both children: the running one layers a flowing pulse over the solid lineage stroke.
    const links = queryAll(m.container, 'path.lc-agents-link')
    assert.equal(links.length, 2)
    assert.equal(queryAll(m.container, 'path.lc-agents-link-live').length, 1)
    assert.equal(queryAll(m.container, 'path.lc-agents-flow').length, 1)

    // The worker node: descriptor label, running halo class, fused ring (composition + free remainder).
    const worker = query(m.container, 'g[data-agent="worker"]')
    assert.ok(text(worker).includes('worker-bee'))
    assert.ok(text(worker).includes('83%'))
    assert.ok(worker.classList.contains('lc-agent-running'))
    const workerSegs = worker.querySelectorAll('circle.lc-agent-seg')
    assert.ok(workerSegs.length > 1)
    assert.ok(worker.querySelector('circle.lc-agent-free') !== null)

    // The one-shot child: no timeline → id label, pressure-only fused ring (arc + free), done halo class.
    const done = query(m.container, 'g[data-agent="done"]')
    assert.ok(text(done).includes('95%'))
    assert.ok(done.classList.contains('lc-agent-done'))
    const doneSegs = done.querySelectorAll('circle.lc-agent-seg')
    assert.equal(doneSegs.length, 2)
    assert.ok(done.querySelector('circle.lc-agent-free') !== null)

    // The inspector mirrors the current node by default, with the self badge.
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('Main Agent'))
    assert.ok(text(inspector).includes('current'))
    assert.ok(text(inspector).includes('500 / 1.0k · 50%'))
    assert.ok(text(inspector).includes('3 requests'))
    assert.ok(text(inspector).includes('1.2k billed'))
    assert.ok(!text(inspector).includes('click to open'))

    // The legend lists all six categories plus the free-window and running-edge keys.
    assert.equal(queryAll(m.container, '.lc-agents-legend-item').length, 8)

    await m.unmount()
  })

  test('hover moves the inspector, click/Enter opens the session', async () => {
    const face = new FakeSessions(family())
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))

    const worker = query(m.container, 'g[data-agent="worker"]')
    await hover(worker)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('worker-bee'))
    assert.ok(text(inspector).includes('continuable'))
    assert.ok(text(inspector).includes('5 requests'))
    assert.ok(text(inspector).includes('150 billed'))
    assert.ok(text(inspector).includes('42s'))
    assert.ok(text(inspector).includes('click to open'))
    assert.ok(worker.classList.contains('lc-agent-hover'))
    await unhover(worker)
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('Main Agent'))

    // Click and keyboard both navigate; the current node never navigates.
    await clickEl(worker)
    assert.deepEqual(face.opened, ['worker'])

    // The one-shot child's inspector shows its mode badge and sample-derived occupancy.
    await hover(query(m.container, 'g[data-agent="done"]'))
    const doneInspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(doneInspector).includes('one-shot'))
    assert.ok(text(doneInspector).includes('950 / 1.0k · 95%'))
    await unhover(query(m.container, 'g[data-agent="done"]'))
    await act(async () => {
      query(m.container, 'g[data-agent="done"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(face.opened, ['worker', 'done'])
    await act(async () => {
      query(m.container, 'g[data-agent="worker"]').dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true }),
      )
    })
    assert.deepEqual(face.opened, ['worker', 'done'])
    await clickEl(query(m.container, 'g[data-agent="root"]'))
    assert.deepEqual(face.opened, ['worker', 'done'])

    await m.unmount()
  })

  test('list updates re-render the tree live', async () => {
    const face = new FakeSessions({ root: { displayTitle: 'Main', running: false, updatedAt: 1 } })
    const View = makeView(face)
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    assert.ok(text(m.container).includes('No subagents yet'))
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 1)

    await act(async () => {
      face.setState({
        root: { displayTitle: 'Main', running: false, updatedAt: 1 },
        kid: { parentId: 'root', origin: 'subagent', running: true, updatedAt: 2 },
      })
    })
    await flush()
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 2)
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
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 3)
    await m.unmount()
  })

  test('a face without refreshSubagents still renders', async () => {
    const face = new FakeSessions(family())
    const bare: unknown = { list: face.list, open: (id: string) => face.open(id) }
    const View = makeView(bare)
    const m = await mount(h(View, { sessionId: 'root' }))
    assert.equal(queryAll(m.container, 'g.lc-agent-node').length, 3)
    // No self stats: the current node falls back to its list-row timeline (230 tokens ≈ 23%).
    const self = query(m.container, 'g.lc-agent-self')
    assert.ok(text(self).includes('23%'))
    await m.unmount()
  })

  test('stat-less nodes render dashes; zero occupancy draws no ring', async () => {
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
      windowless: {
        parentId: 'root', origin: 'subagent', updatedAt: 5,
        projectionValues: { contextPressure: { pressureTokens: 640 } },
      },
      // Usage reported but all-zero: the billed bit stays out of the inspector.
      flatusage: {
        parentId: 'root', origin: 'subagent', updatedAt: 6,
        projectionValues: { tokenUsage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      },
    }))
    const m = await mount(h(View, { sessionId: 'root', self: { head: null, billed: null, requests: 0 } }))

    const bare = query(m.container, 'g[data-agent="bare"]')
    assert.ok(text(bare).includes('—'))
    assert.equal(bare.querySelectorAll('circle.lc-agent-seg').length, 0)

    const zero = query(m.container, 'g[data-agent="zero"]')
    assert.ok(text(zero).includes('0%'))
    // Zero occupancy on a known window: just the free outline.
    const zeroSegs = zero.querySelectorAll('circle.lc-agent-seg')
    assert.equal(zeroSegs.length, 1)
    assert.ok(zero.querySelector('circle.lc-agent-free') !== null)

    // Long labels wrap in full — no ellipsis truncation.
    assert.ok(text(query(m.container, 'g[data-agent="longname"]')).includes('a-very-long-descriptor-label'))

    // The inspector for a stat-less node shows just the identity.
    await hover(bare)
    const inspector = query(m.container, '.lc-agents-inspector')
    assert.ok(text(inspector).includes('bare'))
    assert.equal(query(inspector, '.lc-agents-inspector-stats').textContent, '')

    // Windowless pressure: a bare token figure, no ' / window' and no percentage.
    await hover(query(m.container, 'g[data-agent="windowless"]'))
    assert.equal(query(m.container, '.lc-agents-inspector-stats').textContent, '640')

    // All-zero usage: no billed bit at all.
    await hover(query(m.container, 'g[data-agent="flatusage"]'))
    assert.ok(!text(query(m.container, '.lc-agents-inspector')).includes('billed'))

    // Self with no stats: no percentage, no chips tokens.
    assert.ok(text(query(m.container, 'g.lc-agent-self')).includes('—'))

    await m.unmount()
  })

  test('zh locale renders translated chrome', async () => {
    const View = makeView(new FakeSessions(family()), { locale: 'zh' })
    const m = await mount(h(View, { sessionId: 'root', self: selfStats() }))
    const rendered = text(m.container)
    assert.ok(rendered.includes('Agent 网络'))
    assert.ok(rendered.includes('3 个 Agent'))
    assert.ok(rendered.includes('当前'))
    // Hovering the continuable child surfaces its mode badge in the inspector.
    await hover(query(m.container, 'g[data-agent="worker"]'))
    assert.ok(text(query(m.container, '.lc-agents-inspector')).includes('多轮'))
    await m.unmount()
  })
})

describe('ringColorOf', () => {
  test('occupancy thresholds', () => {
    assert.equal(ringColorOf(null), 'var(--dsw-alias-border-l1)')
    assert.equal(ringColorOf(95), '#ef4444')
    assert.equal(ringColorOf(70), '#f59e0b')
    assert.equal(ringColorOf(12), '#22c55e')
  })
})
