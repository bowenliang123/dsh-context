// The Context Dashboard panel (src/client/components/overviewPanel.tsx) —
// full renders through the standard-kit seams: KPI band, heatmap day-pin,
// filters/sorts, pagination, session open + close paths, and the
// degraded states.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { overviewStore } from '../../../src/client/overviewStore'
import { dayKeyOf } from '../../../src/shared/days'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, keydown, makeKit, mount, query, queryAll, text, until, type Mounted } from '../helpers/kit'

const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
}

const NOW = Date.now()
const TODAY = dayKeyOf(NOW) ?? ''
const YESTERDAY = dayKeyOf(NOW - 86_400_000) ?? ''

/** A wire-shaped timeline head. */
function timeline(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
    contextWindow: 1000,
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    counts: { turns: 3, steps: 5, injects: 1, compactions: 0, prunes: 0 },
    cost: { deepseek: { 'deepseek-v4-flash': { peak: { uncached: 1000, cacheRead: 500, cacheWrite: 0, output: 250 } } } },
    timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolCalls: 7 },
    ...over,
  }
}

/** The three-session snapshot: current + folded, older + cheap, stale + bare. */
function sessionsSnapshot(): { ids: string[]; byId: Record<string, Record<string, unknown>>; current: string; phase: string } {
  return {
    ids: ['a', 'b', 'c'],
    byId: {
      a: {
        displayTitle: 'alpha session',
        cwd: '/repo/alpha',
        updatedAt: NOW - 3_600_000,
        running: true,
        projectionValues: {
          contextTimeline: timeline(),
          contextActivity: { days: { [TODAY]: { tokens: 100, requests: 2 }, [YESTERDAY]: { tokens: 50, requests: 1 } } },
        },
      },
      b: {
        displayTitle: 'beta session',
        cwd: '/repo/beta',
        updatedAt: NOW - 10 * 86_400_000,
        projectionValues: {
          contextTimeline: timeline({ current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }, cost: undefined }),
          contextActivity: { days: { [YESTERDAY]: { tokens: 25, requests: 1 } } },
        },
      },
      c: {
        title: 'gamma session',
        updatedAt: NOW - 40 * 86_400_000,
      },
    },
    current: 'a',
    phase: 'ready',
  }
}

const workspacesSnapshotValue = {
  items: [{ workspaceId: 'w1', title: 'workspace-one', path: '/repo', sessionIds: ['a'] }],
  archivedSessionIds: [],
  state: 'idle',
  phase: 'ready',
}

const useHookOf = (snapshot: unknown) => (<T>(sel: (s: unknown) => T): T => sel(snapshot))

function makeCtx(sessions: Record<string, unknown> = {}): TestClientCtx {
  return new TestClientCtx({ services: { sessions } })
}

async function openPanel(
  ctx: TestClientCtx,
  props: Record<string, unknown> = {},
): Promise<{ m: Mounted; Panel: ReturnType<typeof makeOverviewPanel> }> {
  overviewStore.set(false)
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit())
  const allProps = {
    useSessions: useHookOf(sessionsSnapshot()),
    useWorkspaces: useHookOf(workspacesSnapshotValue),
    ...props,
  }
  const m = await mount(h(Panel, allProps))
  assert.equal(m.container.textContent, '', 'closed renders nothing')
  await act(async () => {
    overviewStore.set(true)
  })
  // The price book's first fetch resolves a microtask or two behind the store
  // flip; a second act window keeps its notify inside act.
  await flush()
  return { m, Panel }
}

/** The fetch calls the panel fired (the warm-up trigger POST), per test. */
const backfillPosts: string[] = []

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
  backfillPosts.length = 0
  // The header's balance capsule POSTs its own route on open (client/balance.ts);
  // only the warm-up trigger is this spec's subject.
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const route = String(url)
    if (route.endsWith('/backfill')) backfillPosts.push(route)
    return { ok: true, json: async () => ({}) }
  })
})

afterEach(async () => {
  overviewStore.set(false)
  resetModelPrices()
  vi.unstubAllGlobals()
  await new Promise(resolve => setTimeout(resolve, 1))
})

describe('OverviewPanel', () => {
  test('renders the KPI band, heatmap, and session cards; summons the warm-up and refreshes the list on open', async () => {
    let pulls = 0
    const ctx = makeCtx({ refresh: () => { pulls++; return Promise.resolve() } })
    const { m } = await openPanel(ctx)
    assert.equal(pulls, 1, 'the baseline re-pull fires on open')
    assert.deepEqual(backfillPosts, ['/api/dsh-context/backfill'], 'the warm-up trigger POST fires on open')
    assert.ok(text(m.container).includes('Context Insights'))
    // KPI band: 2 sessions in the 30d range, 1750 tokens billed, priced cost, cache hit.
    const labels = queryAll(m.container, '.lc-stat-label').map(el => el.textContent)
    assert.deepEqual(labels, ['Active Sessions', 'Tokens Used', 'Cost', 'Cache Hit', 'Tool Calls', 'Active Time'])
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(values[0], '2')
    assert.equal(values[1], '1.8k')
    assert.ok(values[2].startsWith('$'), 'priced from the book')
    assert.equal(values[3], '33.33%')
    // Tools + active time: both timed sessions fold into the band (7 calls each).
    assert.equal(values[4], '14')
    assert.equal(values[5], '3m0s')
    assert.ok(text(m.container).includes('tool runs 40.0s'), 'the tool calls cell qualifies with the summed run time')
    assert.ok(text(m.container).includes('8 model calls'), 'the active-time cell qualifies with the model-call count')
    // Cost and cache hit qualify with the session count each figure covers
    // (only session a carries usage; b folds no cost at all).
    const subs = queryAll(m.container, '.lc-stat-sub').map(el => el.textContent)
    assert.deepEqual(subs.slice(2, 4), ['across 1 sessions', 'across 1 sessions'])
    // The aggregate stats row: the range's Token Stats ring folded into the
    // Context tab's OWN composition categories (every fixture category is
    // billed > 0 here, output exact) beside the Timing Stats ring (the summed
    // totals, un-split — no fixture carries a decode split).
    const statsCards = queryAll(m.container, '.lc-ov-stats > .lc-card')
    assert.equal(statsCards.length, 2)
    assert.equal(query(statsCards[0], '.lc-donut-center b').textContent, '1.8k')
    assert.deepEqual(queryAll(statsCards[0], '.lc-sl-label').map(el => el.textContent), [
      'System Prompt', 'Tool Schemas', 'User Messages', 'Injected Context',
      'Skill Injections', 'Assistant Messages', 'Tool Results', 'Output',
    ])
    assert.equal(query(statsCards[1], '.lc-donut-center b').textContent, '3m0s')
    assert.ok(text(statsCards[1]).includes('LLM Gen'))
    // Heatmap drew cells for the two ledger days.
    assert.ok(queryAll(m.container, 'button.lc-heat-cell').length >= 2)
    // Cards: a (current, running, grouped), b, and c is outside the 30d range.
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 2)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(cards[0]).includes('workspace-one'), 'the breadcrumb group joined')
    assert.ok(text(cards[0]).includes('alpha'), 'the project basename joined')
    await m.unmount()
  })

  test('archived sessions drop from every band, not just the card grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {
      useWorkspaces: useHookOf({ ...workspacesSnapshotValue, archivedSessionIds: ['b'] }),
    })
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(values[0], '1', 'the archived session leaves the KPI band')
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    await m.unmount()
  })

  test('range switching re-scopes the KPI band and the grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.equal(rangeButtons.length, 4)
    await click(rangeButtons[3]) // All
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 3, 'the stale session joins')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '3')
    await click(rangeButtons[0]) // Last 24 hours
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, 'only the hour-fresh session stays')
    await click(rangeButtons[1]) // Last 7 days
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, 'only the freshest stays')
    await click(rangeButtons[2]) // back to 30d
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()
  })

  test('the heatmap day pin filters the grid and the chip clears it', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const cells = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    const todayCell = cells.find(c => c.getAttribute('aria-label')?.startsWith(TODAY))
    assert.ok(todayCell !== undefined, 'today has a data cell')
    await click(todayCell)
    assert.ok(query(m.container, '.lc-ov-day-chip'), 'the day chip appears')
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'), 'only the session active that day stays')
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-day-chip'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'the chip clear restores')
    // Pin and unpin via the cell itself.
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'both sessions were active yesterday')
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-day-chip').length, 0)
    await m.unmount()
  })

  test('the metric toggle re-prices the heatmap between steps and sessions', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const todayCellClass = (): string | undefined =>
      queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
        .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))?.className
    // Steps (the default): today's pair of steps IS the window's steps peak.
    assert.ok(todayCellClass()?.includes('lc-heat-4'), 'steps mode (default): today holds the steps peak')
    const metricButtons = queryAll<HTMLButtonElement>(m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.deepEqual(metricButtons.map(b => b.textContent), ['Sessions', 'Steps'])
    assert.ok(metricButtons[1].className.includes('lc-gran-on'), 'steps starts selected')
    await click(metricButtons[0])
    const after = queryAll<HTMLButtonElement>(m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.ok(after[0].className.includes('lc-gran-on'), 'the click selects sessions')
    assert.ok(!after[1].className.includes('lc-gran-on'))
    // Sessions: today had one of the window's two active sessions.
    assert.ok(todayCellClass()?.includes('lc-heat-2'), 'sessions mode re-prices today down its own scale')
    await m.unmount()
  })

  test('search and sort steer the grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({
        ...sessionsSnapshot(),
        ids: ['a', 'b', 'c'],
        byId: {
          ...sessionsSnapshot().byId,
          c: { ...(sessionsSnapshot().byId.c as object), updatedAt: NOW - 86_400_000 },
        },
      }),
    })
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    // Query by title.
    await actType(input, 'beta')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    assert.ok(text(m.container).includes('beta session'))
    // Query by path.
    await actType(input, '/repo/a')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    // No match → the filtered empty note.
    await actType(input, 'zzz')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    assert.ok(text(m.container).includes('No sessions match'))
    await actType(input, '')
    // Sort: tokens puts the billed session first; context puts the largest current first.
    const sortButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-list-head .lc-gran-btn')
    assert.equal(sortButtons.length, 3)
    await click(sortButtons[1]) // Tokens
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[2]) // Context
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[0]) // Recent
    await m.unmount()
  })

  test('the group chips filter the grid (All / workspace / Ungrouped), toggling on and off', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All2', 'workspace-one1', 'Ungrouped1'])
    // Select the workspace group: only its claimed session stays.
    await click(chips[1])
    let cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1].className.includes('lc-ov-chip-on'))
    // Switch to the ungrouped bucket: only the claimless one stays.
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('beta session'))
    // Toggle the active chip off → the whole scoped set returns.
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    // The All chip clears an active selection too.
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[0])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()
  })

  test('a selection whose group fell out of scope keeps a phantom chip (one click out)', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1]) // workspace-one
    // Filter everything away with a query: the selection's chip stays, lit, at 0.
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    await actType(input, 'zzz')
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All0', 'workspace-one0'])
    assert.ok(chips[1].className.includes('lc-ov-chip-on'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    await m.unmount()
  })

  test('a card click opens the session through the harness verb and closes the panel', async () => {
    const opened: string[] = []
    const ctx = makeCtx({ open: (id: string) => { opened.push(id) } })
    const { m } = await openPanel(ctx)
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-grid > .lc-ov-session'))
    assert.deepEqual(opened, ['a'])
    assert.equal(overviewStore.getSnapshot(), false)
    assert.equal(m.container.textContent, '', 'the panel unmounted')
    await m.unmount()
  })

  test('the settings row under the activity card runs the preferences jump and closes the panel', async () => {
    // The harness chrome the jump drives (settingsJump.ts): the Plugins panel
    // entry first, then the bundle card's open control (the one non-switch
    // button inside the card), both click-tracked.
    const clicks: string[] = []
    const chrome = document.createElement('div')
    chrome.innerHTML = `
      <button aria-label="Plugins"></button>
      <div data-plugin-package="dsh-context">
        <button role="switch"></button>
        <button>Context</button>
      </div>`
    for (const b of [...chrome.querySelectorAll('button')]) {
      b.addEventListener('click', () => { clicks.push(b.getAttribute('aria-label') ?? (b.textContent ?? '')) })
    }
    document.body.appendChild(chrome)
    try {
      const ctx = makeCtx()
      const { m } = await openPanel(ctx)
      const row = query<HTMLButtonElement>(m.container, '.lc-ov-settings')
      assert.equal(row.textContent, 'SettingsOpen plugin settings')
      await click(row)
      assert.equal(overviewStore.getSnapshot(), false, 'the panel closed so the jump lands visible')
      assert.equal(m.container.textContent, '', 'the panel unmounted')
      assert.deepEqual(clicks, ['Plugins'], 'the jump clicked the Plugins panel entry synchronously')
      await until(() => clicks.length > 1, 'the jump never reached the bundle card open control')
      assert.equal(clicks[1], 'Context')
      await m.unmount()
    } finally {
      chrome.remove()
    }
  })

  test('Escape and the backdrop close; the card body swallows clicks', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    await keydown('Escape')
    assert.equal(overviewStore.getSnapshot(), false)
    await m.unmount()

    const second = await openPanel(ctx)
    await click(query(second.m.container, '.lc-ov-card'))
    assert.equal(overviewStore.getSnapshot(), true, 'a card-body click does not close')
    await click(query(second.m.container, '.lc-ov-backdrop'))
    assert.equal(overviewStore.getSnapshot(), false)
    await second.m.unmount()

    const third = await openPanel(ctx)
    await click(query<HTMLButtonElement>(third.m.container, '.lc-modal-close'))
    assert.equal(overviewStore.getSnapshot(), false)
    await third.m.unmount()
  })

  test('degraded states: unavailable list, empty list, no activity', async () => {
    const ctx = makeCtx()
    // No sessions seat at all → the unavailable note.
    const bare = await openPanel(ctx, { useSessions: undefined, useWorkspaces: undefined })
    assert.ok(text(bare.m.container).includes('The session list is unavailable'))
    await bare.m.unmount()

    // An empty-but-ready list → the empty note.
    const empty = await openPanel(ctx, {
      useSessions: useHookOf({ ids: [], byId: {}, phase: 'ready' }),
      useWorkspaces: useHookOf({ items: [] }),
    })
    assert.ok(text(empty.m.container).includes('No sessions yet'))
    assert.ok(text(empty.m.container).includes('No activity yet'))
    await empty.m.unmount()

    // Sessions without any timeline → cards render metadata-only.
    const noTimeline = await openPanel(ctx, {
      useSessions: useHookOf({
        ids: ['x'],
        byId: { x: { displayTitle: 'plain session', updatedAt: NOW - 1000 } },
        phase: 'ready',
      }),
    })
    assert.ok(text(noTimeline.m.container).includes('No context data yet'))
    const kpiValues = queryAll(noTimeline.m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(kpiValues[1], '0')
    assert.equal(kpiValues[2], '—', 'nothing priced without cost buckets')
    assert.equal(kpiValues[3], '—', 'no cache hit without billed input')
    assert.equal(kpiValues[4], '0', 'no tool calls without timing')
    assert.equal(kpiValues[5], '—', 'no active time without timing')
    // The aggregate cards degrade to their empty notes.
    assert.ok(text(noTimeline.m.container).includes('No billed tokens in this range'))
    assert.ok(text(noTimeline.m.container).includes('No timing data yet'))
    await noTimeline.m.unmount()
  })

  test('the zh locale renders translated chrome and CNY cost', async () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit('zh'))
    const m = await mount(h(Panel, {
      useSessions: useHookOf(sessionsSnapshot()),
      useWorkspaces: useHookOf(workspacesSnapshotValue),
    }))
    await act(async () => {
      overviewStore.set(true)
    })
    await flush()
    assert.ok(text(m.container).includes('上下文洞察'))
    assert.ok(text(m.container).includes('活跃会话'))
    assert.ok(text(m.container).includes('Token 统计'), 'the aggregate stats row rides the zh dictionary too')
    assert.ok(text(m.container).includes('系统提示词'), 'the Context tab\'s composition categories render in zh')
    assert.ok(text(m.container).includes('打开插件设置'), 'the settings row rides the zh dictionary too')
    await flush() // the price book lands
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.ok(values[2].startsWith('¥'), 'CNY under the zh locale')
    await m.unmount()
  })

  test('a hostile session seat degrades to the unavailable note instead of an error card', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, { useSessions: () => { throw new Error('boom') } })
    assert.ok(text(m.container).includes('The session list is unavailable'))
    await m.unmount()
  })

  test('an unpriceable model dashes the card cost', async () => {
    const ctx = makeCtx()
    const sparse = timeline({
      current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      cost: { deepseek: { 'no-such-model': { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({
        ids: ['s'],
        byId: {
          s: { displayTitle: 'sparse session', updatedAt: NOW - 1000, projectionValues: { contextTimeline: sparse } },
        },
        phase: 'ready',
      }),
    })
    await flush() // the price book lands
    // The card's cost: buckets exist but the book prices no such model → the dash.
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.equal(values[2], '—')
    await m.unmount()
  })

  test('a locale service without getLocale falls back to USD', async () => {
    // A hand-rolled ctx: the locale face carries no getLocale at all.
    const bare = {
      locale: {
        register: () => () => {},
        bind: () => makeKit().t,
      },
      get: () => undefined,
    }
    const Panel = makeOverviewPanel(bare as never, makeKit())
    const m = await mount(h(Panel, {
      useSessions: useHookOf(sessionsSnapshot()),
      useWorkspaces: useHookOf(workspacesSnapshotValue),
    }))
    await act(async () => {
      overviewStore.set(true)
    })
    await flush()
    await flush() // the price book lands
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.ok(values[2].startsWith('$'), 'USD when the locale face cannot report an active locale')
    await m.unmount()
  })

  test('the grid pages at 12 cards; the pager steps and a filter change re-anchors it', async () => {
    const ctx = makeCtx()
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    const byId: Record<string, Record<string, unknown>> = {}
    ids.forEach((id, i) => { byId[id] = { displayTitle: `session ${i}`, updatedAt: NOW - i * 60_000 } })
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({ ids, byId, current: 's0', phase: 'ready' }),
      useWorkspaces: useHookOf({ items: [] }),
    })
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 12, 'the first page caps at 12 cards')
    assert.ok(text(m.container).includes('Page 1 of 3'))
    const btns = () => queryAll<HTMLButtonElement>(m.container, '.lc-ov-pager-btn')
    assert.ok(btns()[0].disabled, 'prev sits out on the first page')
    await click(btns()[1])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 12, 'the middle page is full')
    await click(btns()[1])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 6, 'the tail page renders the rest')
    assert.ok(text(m.container).includes('Page 3 of 3'))
    assert.ok(btns()[1].disabled, 'next sits out on the last page')
    await click(btns()[0])
    assert.ok(text(m.container).includes('Page 2 of 3'), 'prev steps back')
    // Typing while on the last page: the reset lands on the first page of the narrowed set.
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), 'session 2')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 11, "'session 2' matches 2 and 20–29")
    assert.ok(!text(m.container).includes('Page 2 of 3'), 'the pager drops once one page remains')
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), '')
    assert.ok(text(m.container).includes('Page 1 of 3'), 'clearing the query lands on the first page, not the stale one')
    await m.unmount()
  })

  test('typing keeps the search input focused (the escape hook never re-fires its focus restore)', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    input.focus()
    await actType(input, 'beta')
    await actType(input, 'bet')
    assert.equal(document.activeElement, input, 'every re-render leaves the focused input alone')
    await m.unmount()
  })
})

/** Type into an input through the React change path (native setter + input event, act-wrapped). */
async function actType(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
