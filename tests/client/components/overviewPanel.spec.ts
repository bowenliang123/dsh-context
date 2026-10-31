import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { resetModelPrices, setModelPricesLoader } from '../../../src/client/modelPrices'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import type { DefaultOverviewRange } from '../../../src/shared/types'
import { dayKeyOf } from '../../../src/shared/days'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover, type Mounted } from '../helpers/kit'

const PROVIDERS = {
  deepseek: { models: { 'deepseek-v4-flash': { cost: { input: 1, output: 2, cache_read: 0.1 } } } },
}

const NOW = Date.now()
const TODAY = dayKeyOf(NOW) ?? ''
const YESTERDAY = dayKeyOf(NOW - 86_400_000) ?? ''
const MIDNIGHT = new Date(new Date(NOW).setHours(0, 0, 0, 0)).getTime()

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
    timing: { wallMs: 90_000, ttftMs: 1_000, genMs: 30_000, calls: 4, toolsMs: 20_000, toolBusyMs: 15_000, toolCalls: 7 },
    ...over,
  }
}

function sessionsSnapshot(): { ids: string[]; byId: Record<string, Record<string, unknown>>; phase: string } {
  return {
    ids: ['a', 'b', 'c'],
    byId: {
      a: {
        displayTitle: 'alpha session',
        cwd: '/repo/alpha',
        updatedAt: MIDNIGHT,
        running: true,
        projectionValues: {
          contextTimeline: timeline(),
          contextActivity: {
            days: {
              [TODAY]: {
                tokens: 100,
                requests: 2,
                turns: 2,
                toolCalls: 4,
                toolsMs: 10_000,
                wallMs: 45_000,
                tools: { read: { n: 3, last: NOW - 1000 }, bash: { n: 1, last: NOW - 2000 } },
                cmds: { git: { n: 2, last: NOW - 1500 } },
                cost: { deepseek: { 'deepseek-v4-flash': { peak: { uncached: 1000, cacheRead: 500, cacheWrite: 0, output: 250 } } } },
              },
              [YESTERDAY]: {
                tokens: 50,
                requests: 1,
                turns: 1,
                toolCalls: 3,
                toolsMs: 10_000,
                wallMs: 45_000,
                tools: { read: { n: 2, last: NOW - 3000 }, grep: { n: 1, last: NOW - 4000 } },
                cmds: { pnpm: { n: 1, last: NOW - 5000 } },
              },
            },
          },
        },
      },
      b: {
        displayTitle: 'beta session',
        cwd: '/repo/beta',
        updatedAt: NOW - 10 * 86_400_000,
        projectionValues: {
          contextTimeline: timeline({ current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 }, cost: undefined }),
          contextActivity: {
            days: {
              [YESTERDAY]: {
                tokens: 25,
                requests: 1,
                turns: 1,
                toolCalls: 3,
                toolsMs: 5_000,
                wallMs: 60_000,
                tools: { grep: { n: 3, last: NOW - 6000 } },
                cmds: { node: { n: 1, last: NOW - 7000 } },
              },
            },
          },
        },
      },
      c: {
        title: 'gamma session',
        updatedAt: NOW - 40 * 86_400_000,
      },
    },
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

function settingsWith(range?: DefaultOverviewRange): ContextSettings {
  const settings = createContextSettings()
  if (range !== undefined) {
    settings.attach({
      getSnapshot: () => ({ status: 'ready', value: { defaultOverviewRange: range }, writable: true }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
    })
  }
  return settings
}

function writableSettings(range: DefaultOverviewRange = '30d', writable = true): {
  settings: ContextSettings
  sets: { field: string; value: unknown }[]
} {
  let value: Record<string, unknown> = { defaultOverviewRange: range }
  const listeners = new Set<() => void>()
  const sets: { field: string; value: unknown }[] = []
  const settings = createContextSettings()
  settings.attach({
    getSnapshot: () => ({ status: 'ready', value, writable }),
    subscribe: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    set: async (field, next) => {
      sets.push({ field, value: next })
      value = { ...value, [field]: next }
      for (const listener of listeners) listener()
    },
  })
  return { settings, sets }
}

function makeCtx(sessions: Record<string, unknown> = {}): TestClientCtx {
  return new TestClientCtx({ services: { sessions } })
}

async function openPanel(
  ctx: TestClientCtx,
  props: Record<string, unknown> = {},
  settings: ContextSettings = settingsWith(),
): Promise<{ m: Mounted; Panel: ReturnType<typeof makeOverviewPanel> }> {
  const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), settings)
  const allProps = {
    useSessions: useHookOf(sessionsSnapshot()),
    useWorkspaces: useHookOf(workspacesSnapshotValue),
    ...props,
  }
  const m = await mount(h(Panel, allProps))
  await flush()
  return { m, Panel }
}

const backfillPosts: string[] = []

function calendarDay(key: string): HTMLElement {
  const el = queryAll(document.body, '.lc-dp-cell').find(d => d.getAttribute('aria-label') === key)
  assert.ok(el !== undefined, `the calendar drew ${key}`)
  return el
}

beforeEach(() => {
  resetModelPrices()
  setModelPricesLoader(() => Promise.resolve(PROVIDERS))
  backfillPosts.length = 0
  vi.stubGlobal('fetch', async (url: string | URL) => {
    const route = String(url)
    if (route.endsWith('/backfill')) backfillPosts.push(route)
    return { ok: true, json: async () => ({}) }
  })
})

afterEach(async () => {
  resetModelPrices()
  vi.unstubAllGlobals()
  await new Promise(resolve => setTimeout(resolve, 1))
})

describe('OverviewPanel', () => {
  test('renders the KPI band, heatmap, and session cards; summons the warm-up and refreshes the list on mount', async () => {
    let pulls = 0
    const ctx = makeCtx({ refresh: () => { pulls++; return Promise.resolve() } })
    const { m } = await openPanel(ctx)
    assert.equal(pulls, 1, 'the baseline re-pull fires on mount')
    assert.deepEqual(backfillPosts, ['api/dsh-context/backfill'], 'the warm-up trigger POST fires on mount')
    assert.ok(text(m.container).includes('Context Insights'))
    const scrollRows = [...query(m.container, '.lc-ov-pagecontent').children].map(el => el.className.split(' ')[0])
    assert.deepEqual(scrollRows, ['lc-ov-pagehead', 'lc-ov-first', 'lc-ov-stats', 'lc-ov-body'])
    assert.ok(query(m.container, '.lc-ov-pagehead').hasAttribute('data-window-drag'), 'the head is the desktop window drag area')
    assert.ok(query(m.container, '.lc-ov-first > .lc-card.lc-ov-usage') !== null, 'the usage chart rides the row')
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(values[0], '2')
    assert.equal(values[1], '1.8k')
    assert.ok(values[2].startsWith('$'), 'priced from the book')
    assert.equal(values[3], '33.33%')
    assert.equal(values[4], '14')
    assert.equal(values[5], '3m0s')
    assert.ok(text(m.container).includes('tool runs 30.0s'), 'the tool calls cell qualifies with the busy union the timing card prints')
    assert.ok(text(m.container).includes('8 model calls'), 'the active-time cell qualifies with the family lifetime calls the timing card reads')
    const subs = queryAll(m.container, '.lc-stat-sub').map(el => el.textContent)
    assert.deepEqual(subs.slice(2, 4), ['1 of 2 sessions priced', 'across 1 sessions'])
    const statsCards = queryAll(m.container, '.lc-ov-stats > .lc-card')
    assert.equal(statsCards.length, 2)
    assert.equal(query(statsCards[0], '.lc-donut-center b').textContent, '1.8k')
    assert.equal(query(statsCards[1], '.lc-donut-center b').textContent, '3m0s')
    assert.equal(values[5], query(statsCards[1], '.lc-donut-center b').textContent, 'the band and the card share one active-time figure')
    assert.ok(text(statsCards[1]).includes('14 runs'), 'the card’s tool row carries the same lifetime tally the band’s tool cells print')
    assert.ok(text(statsCards[1]).includes('LLM Gen'))
    assert.ok(queryAll(m.container, 'button.lc-heat-cell').length >= 2)
    const tiles = queryAll(m.container, '.lc-ov-tiles > .lc-card')
    assert.equal(tiles.length, 4, 'the heat, skills, tools, and commands cards share one row')
    assert.ok(tiles[0].classList.contains('lc-ov-heat-card'))
    assert.equal(queryAll(tiles[1], 'button.lc-ov-tally').length, 0, 'no skill loads in this fixture')
    assert.equal(text(query(tiles[2], '.lc-ov-tally-note')), '3 tools · 10 calls')
    assert.deepEqual(queryAll(tiles[2], '.lc-ov-tally-name').map(el => text(el)), ['read', 'grep', 'bash'])
    assert.equal(text(query(tiles[3], '.lc-ov-tally-note')), '3 programs · 4 runs')
    assert.deepEqual(queryAll(tiles[3], '.lc-ov-tally-name').map(el => text(el)), ['git', 'pnpm', 'node'])
    const cards = queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 2)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(cards[0]).includes('workspace-one'), 'the breadcrumb group joined')
    assert.ok(text(cards[0]).includes('alpha'), 'the project basename joined')
    await m.unmount()
  })

  test('a tool or command row filters the session list and its chip releases the filter', async () => {
    const { m } = await openPanel(makeCtx())
    const tiles = queryAll(m.container, '.lc-ov-tiles > .lc-card')
    const readRow = queryAll<HTMLButtonElement>(tiles[2], 'button.lc-ov-tally').find(row => text(row).includes('read'))
    assert.ok(readRow !== undefined)
    await click(readRow)
    let cards = queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1, 'only the session that ran read in scope stays')
    assert.ok(text(cards[0]).includes('alpha session'))
    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the tool filter"]')
    assert.ok(text(chip).includes('Tool · read'))
    await click(readRow)
    assert.equal(queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session').length, 2, 'the pinned row releases its own filter')
    await click(readRow)
    assert.equal(queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session').length, 1)
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the tool filter"]'))
    assert.equal(queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session').length, 2)

    const gitRow = queryAll<HTMLButtonElement>(tiles[3], 'button.lc-ov-tally').find(row => text(row).includes('git'))
    assert.ok(gitRow !== undefined)
    await click(gitRow)
    cards = queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(query(m.container, '.lc-ov-day-chip[title="Clear the command filter"]')).includes('Command · git'))
    await click(queryAll<HTMLButtonElement>(tiles[3], 'button.lc-ov-tally').find(row => text(row).includes('git'))!)
    assert.equal(queryAll(m.container, '.lc-ov-list .lc-ov-grid > .lc-ov-session').length, 2, 'the pinned row releases its own filter')
    await m.unmount()
  })

  test('an empty scope keeps the tally cards’ summary and body, never a lone placeholder', async () => {
    const { m } = await openPanel(makeCtx(), {
      useSessions: useHookOf({
        ids: ['x'],
        byId: { x: { displayTitle: 'quiet session', updatedAt: NOW - 40 * 86_400_000 } },
        phase: 'ready',
      }),
    })
    const tiles = queryAll(m.container, '.lc-ov-tiles > .lc-card')
    assert.equal(tiles.length, 4)
    assert.equal(text(query(tiles[1], '.lc-ov-tally-note')), '0 skills · 0 loads')
    assert.equal(text(query(tiles[2], '.lc-ov-tally-note')), '0 tools · 0 calls')
    assert.equal(text(query(tiles[3], '.lc-ov-tally-note')), '0 programs · 0 runs')
    assert.ok(text(tiles[2]).includes('No tool calls in this range'))
    assert.ok(text(tiles[3]).includes('No commands in this range'))
    await m.unmount()
  })

  test('the coverage picker folds archived sessions in by default and its scopes split the page; an archived card never opens', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({
      services: { uiWorkspace: { openSession: (id: string) => { opened.push(id) } }, sessions: {} },
    })
    const { m } = await openPanel(ctx, {
      useWorkspaces: useHookOf({ ...workspacesSnapshotValue, archivedSessionIds: ['b'] }),
    })
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'incl. 1 archived')
    let cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 2)
    const betaCard = cards.find(c => text(c).includes('beta session'))
    assert.ok(betaCard !== undefined && text(betaCard).includes('Archived'), 'the archived card carries the tag')
    const select = query<HTMLSelectElement>(m.container, 'select.lc-ov-cover')
    assert.deepEqual([...select.options].map(o => o.textContent), ['All (show archived)', 'Hide archived', 'Archived only'])
    await actSelect(select, 'active')
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Active Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'of 3 total')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1', 'the archived session leaves the KPI band')
    cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    await actSelect(select, 'archived')
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Archived Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'of 3 total')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1')
    const archCards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(archCards.length, 1)
    assert.ok(text(archCards[0]).includes('beta session'))
    await click(archCards[0])
    assert.deepEqual(opened, [], 'the archived card never navigates')
    await m.unmount()
  })

  test('the configured default range selects the preset on mount — even when the settings section lands late', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {}, settingsWith('7d'))
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.ok(rangeButtons[1].className.includes('lc-gran-on'), 'the configured 7-day preset opens lit')
    assert.ok(!rangeButtons[2].className.includes('lc-gran-on'), 'the schema default stands down')
    assert.deepEqual(
      queryAll(m.container, '.lc-dp-half').map(el => el.textContent),
      [dayKeyOf(NOW - 7 * 86_400_000), TODAY],
      'the page opens on the configured window',
    )
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'the scope follows the preset')
    await m.unmount()

    const settings = createContextSettings()
    let ready = false
    let notify: (() => void) | undefined
    settings.attach({
      getSnapshot: () => ready
        ? { status: 'ready', value: { defaultOverviewRange: '7d' }, writable: true }
        : { status: 'loading', value: {}, writable: false },
      subscribe: (listener) => { notify = listener; return () => { notify = undefined } },
      set: () => Promise.resolve(),
    })
    const late = await openPanel(makeCtx(), {}, settings)
    const lateButtons = queryAll<HTMLButtonElement>(late.m.container, '.lc-ov-range .lc-gran-btn')
    assert.ok(lateButtons[2].className.includes('lc-gran-on'), 'the schema default opens while settings load')
    ready = true
    await act(async () => { notify?.() })
    assert.ok(lateButtons[1].className.includes('lc-gran-on'), 'the served default takes over once it lands')
    assert.ok(!lateButtons[2].className.includes('lc-gran-on'))
    await late.m.unmount()
  })

  test('picking a range writes it back as the default, so a remount keeps it', async () => {
    const { settings, sets } = writableSettings()
    const first = await openPanel(makeCtx(), {}, settings)
    const buttons = queryAll<HTMLButtonElement>(first.m.container, '.lc-ov-range .lc-gran-btn')
    await click(buttons[1])
    assert.deepEqual(sets, [{ field: 'defaultOverviewRange', value: '7d' }])
    assert.equal(settings.store.getSnapshot().overviewRange, '7d', 'the settings card reads the written default')
    assert.ok(buttons[1].className.includes('lc-gran-on'), 'the pick applies immediately')
    await first.m.unmount()

    const second = await openPanel(makeCtx(), {}, settings)
    const again = queryAll<HTMLButtonElement>(second.m.container, '.lc-ov-range .lc-gran-btn')
    assert.ok(again[1].className.includes('lc-gran-on'), 'the remount reads the written default')
    assert.deepEqual(
      queryAll(second.m.container, '.lc-dp-half').map(el => el.textContent),
      [dayKeyOf(NOW - 7 * 86_400_000), TODAY],
      'the remount opens on the written window',
    )
    await second.m.unmount()

    const readOnly = writableSettings('30d', false)
    const locked = await openPanel(makeCtx(), {}, readOnly.settings)
    const lockedButtons = queryAll<HTMLButtonElement>(locked.m.container, '.lc-ov-range .lc-gran-btn')
    await click(lockedButtons[1])
    assert.deepEqual(readOnly.sets, [], 'a read-only form is never written')
    assert.ok(lockedButtons[1].className.includes('lc-gran-on'), 'the pick still applies to this visit')
    assert.equal(readOnly.settings.store.getSnapshot().overviewRange, '30d', 'the stored default is untouched')
    await locked.m.unmount()
  })

  test('range presets and a picked calendar range re-scope the KPI band and the grid', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.equal(rangeButtons.length, 4)
    const span = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    const thirty = new Date(NOW - 30 * 86_400_000)
    assert.deepEqual(span(), [dayKeyOf(thirty.getTime()), TODAY], '30d shows the thirty days it covers')
    await click(rangeButtons[3])
    assert.deepEqual(span(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 3, 'the stale session joins')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '3')
    await click(rangeButtons[0])
    assert.deepEqual(span(), [TODAY, TODAY], "today's own day on both ends")
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1, "only today's session stays")
    await click(rangeButtons[1])
    assert.deepEqual(span(), [dayKeyOf(NOW - 7 * 86_400_000), TODAY])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'the yesterday-active session joins the prompt-fresh one')
    await click(rangeButtons[2])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await m.unmount()

    const calendar = await openPanel(ctx)
    const calendarButtons = queryAll<HTMLButtonElement>(calendar.m.container, '.lc-ov-range .lc-gran-btn')
    await click(query(calendar.m.container, '.lc-dp-trigger'))
    await click(calendarDay(YESTERDAY))
    await click(calendarDay(TODAY))
    assert.ok(query(calendar.m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'), 'the chip carries the picked range')
    assert.deepEqual(
      queryAll(calendar.m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the head names both ends, start first',
    )
    assert.equal(queryAll(calendar.m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    assert.equal(queryAll(calendar.m.container, '.lc-stat-value')[0].textContent, '2', 'the KPI band narrowed with it')
    assert.ok(
      calendarButtons.every(b => !b.className.includes('lc-gran-on')),
      'a picked range and a preset are never both lit',
    )
    await click(calendarButtons[3])
    assert.equal(queryAll(calendar.m.container, '.lc-ov-grid > .lc-ov-session').length, 3, 'the stale session joins again')
    assert.ok(!query(calendar.m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'))
    await calendar.m.unmount()

    const back = await openPanel(ctx)
    await click(query(back.m.container, '.lc-dp-trigger'))
    await click(calendarDay(TODAY))
    await click(calendarDay(YESTERDAY))
    assert.deepEqual(
      queryAll(back.m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the picked pair is sorted, start day first',
    )
    assert.equal(queryAll(back.m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'the same window a forward pick would have left')
    await back.m.unmount()
  })

  test('the heatmap day pin filters the grid and clears, and its metric toggle re-prices between tokens and sessions', async () => {
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
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2, 'both sessions were active yesterday')
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    assert.equal(queryAll(m.container, '.lc-ov-day-chip').length, 0)
    await m.unmount()

    const metric = await openPanel(ctx)
    const todayCellClass = (): string | undefined =>
      queryAll<HTMLButtonElement>(metric.m.container, 'button.lc-heat-cell')
        .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))?.className
    assert.ok(todayCellClass()?.includes('lc-heat-4'), 'tokens mode (default): today holds the token peak')
    const metricButtons = queryAll<HTMLButtonElement>(metric.m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.deepEqual(metricButtons.map(b => b.textContent), ['Sessions', 'Tokens'])
    assert.ok(metricButtons[1]!.className.includes('lc-gran-on'), 'tokens starts selected')
    await click(metricButtons[0]!)
    const after = queryAll<HTMLButtonElement>(metric.m.container, '.lc-heat-ctl .lc-gran-btn')
    assert.ok(after[0]!.className.includes('lc-gran-on'), 'the click selects sessions')
    assert.ok(!after[1]!.className.includes('lc-gran-on'))
    assert.ok(todayCellClass()?.includes('lc-heat-2'), 'sessions mode re-prices today down its own scale')
    const cell = queryAll<HTMLButtonElement>(metric.m.container, 'button.lc-heat-cell')
      .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))
    assert.ok(cell !== undefined)
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    const bubble = document.body.querySelector('#lc-hovertip-bubble')
    assert.ok(bubble !== null, 'the portaled bubble mounted')
    assert.ok(bubble.textContent!.startsWith(TODAY), 'the cell label rides the bubble')
    assert.equal(cell.getAttribute('aria-describedby'), 'lc-hovertip-bubble')
    await act(async () => {
      cell.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: metric.m.container }))
    })
    assert.equal(document.body.querySelector('#lc-hovertip-bubble'), null, 'leaving the anchor hides the bubble')
    assert.equal(cell.getAttribute('aria-describedby'), null)
    await metric.m.unmount()
  })

  test('the plugin-optional current row anchors the skill catalog; the card pins the skill’s loaders; the chip and row release it', async () => {
    const ctx = makeCtx()
    const snap = { ...sessionsSnapshot(), current: 'a' }
    const aDays = (snap.byId.a.projectionValues as { contextActivity: { days: Record<string, Record<string, unknown>> } }).contextActivity.days
    aDays[TODAY] = { ...aDays[TODAY], skills: { tdd: { n: 2, last: NOW - 1000 } } }
    const skillPosts: unknown[] = []
    vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => {
      const route = String(url)
      if (route.endsWith('/skills')) {
        skillPosts.push(init?.body === undefined ? undefined : JSON.parse(String(init.body)))
        return {
          ok: true,
          json: async () => ({ ok: true, value: { skills: [{ name: 'tdd', description: 'Test-driven.', path: '/p/tdd/SKILL.md', source: 'user-agents' }] } }),
        }
      }
      return { ok: true, json: async () => ({}) }
    })
    const { m } = await openPanel(ctx, { useSessions: useHookOf(snap) })
    await flush()
    assert.deepEqual(skillPosts, [{ cwd: '/repo/alpha', sessionId: 'a' }], 'the catalog read anchors on the current session')
    const skillRow = query<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.ok(text(skillRow).includes('tdd'))
    await hover(skillRow)
    assert.ok(text(document.querySelector('#lc-skilltip-bubble') as HTMLElement).includes('Test-driven.'), 'the catalog’s description joins the hover card')
    await unhover(skillRow)
    await click(skillRow)
    const cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the skill filter"]')
    assert.ok(text(chip).includes('Skill · tdd'))
    assert.ok(text(query(m.container, '.lc-ov-skill-detail')).includes('/p/tdd/SKILL.md'))
    await click(chip)
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0, 'the detail block leaves with the pin')
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-tally'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-tally'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
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
    input.focus()
    await actType(input, 'beta')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    assert.ok(text(m.container).includes('beta session'))
    await actType(input, '/repo/a')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 1)
    await actType(input, 'zzz')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    assert.ok(text(m.container).includes('No sessions match'))
    await actType(input, '')
    const sortButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-list-head .lc-gran-btn')
    assert.equal(sortButtons.length, 3)
    await click(sortButtons[1])
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[2])
    assert.ok(text(queryAll(m.container, '.lc-ov-grid > .lc-ov-session')[0]).includes('alpha session'))
    await click(sortButtons[0])
    assert.equal(document.activeElement, input, 're-renders leave the focused input alone')
    await m.unmount()
  })

  test('the group chips filter the grid (All / workspace / Ungrouped), toggling on and off', async () => {
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All2', 'workspace-one1', 'Ungrouped1'])
    await click(chips[1])
    let cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1].className.includes('lc-ov-chip-on'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    cards = queryAll(m.container, '.lc-ov-grid > .lc-ov-session')
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('beta session'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[0])
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 2)

    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), 'zzz')
    const phantom = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(phantom.map(c => c.textContent), ['All0', 'workspace-one0'])
    assert.ok(phantom[1].className.includes('lc-ov-chip-on'))
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 0)
    await m.unmount()
  })

  test('a card click opens the session through the harness verb, and the settings chip runs the preferences jump', async () => {
    const opened: string[] = []
    const bundles: string[] = []
    const ctx = new TestClientCtx({
      services: {
        uiWorkspace: { openSession: (id: string) => { opened.push(id) } },
        pluginNavigation: { openBundle: (name: string) => { bundles.push(name) } },
      },
    })
    const { m } = await openPanel(ctx)
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-grid > .lc-ov-session'))
    assert.deepEqual(opened, ['a'])

    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-settings')
    assert.equal(chip.textContent, 'Plugin Settings')
    assert.equal(chip.title, 'Open plugin settings')
    const head = query(m.container, '.lc-ov-pagehead')
    assert.equal(head.children[0].className, 'lc-ov-pagetitle')
    assert.equal(head.children[1], chip)
    await click(chip)
    assert.deepEqual(bundles, ['dsh-context'], 'the chip jumps through the Plugins panel navigator')
    await m.unmount()
  })

  test('degraded states: unavailable list, empty list, no activity', async () => {
    const ctx = makeCtx()
    const bare = await openPanel(ctx, { useSessions: undefined, useWorkspaces: undefined })
    assert.ok(text(bare.m.container).includes('The session list is unavailable'))
    await bare.m.unmount()

    const empty = await openPanel(ctx, {
      useSessions: useHookOf({ ids: [], byId: {}, phase: 'ready' }),
      useWorkspaces: useHookOf({ items: [] }),
    })
    assert.ok(text(empty.m.container).includes('No sessions yet'))
    assert.ok(text(empty.m.container).includes('No activity yet'))
    await empty.m.unmount()

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
    assert.ok(text(noTimeline.m.container).includes('No billed tokens in this range'))
    assert.ok(text(noTimeline.m.container).includes('No timing data yet'))
    await noTimeline.m.unmount()

    const hostile = await openPanel(ctx, { useSessions: () => { throw new Error('boom') } })
    assert.ok(text(hostile.m.container).includes('The session list is unavailable'))
    await hostile.m.unmount()

    const sparse = timeline({
      current: { system: 10, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 10 },
      cost: { deepseek: { 'no-such-model': { peak: { uncached: 100, cacheRead: 0, cacheWrite: 0, output: 0 } } } },
    })
    const unpriceable = await openPanel(ctx, {
      useSessions: useHookOf({
        ids: ['s'],
        byId: { s: { displayTitle: 'sparse session', updatedAt: NOW - 1000, projectionValues: { contextTimeline: sparse } } },
        phase: 'ready',
      }),
    })
    await flush()
    assert.equal(queryAll(unpriceable.m.container, '.lc-ov-mini-value').map(el => el.textContent)[2], '—')
    await unpriceable.m.unmount()
  })

  test('the zh locale renders translated chrome and CNY cost', async () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit('zh'), settingsWith())
    const m = await mount(h(Panel, { useSessions: useHookOf(sessionsSnapshot()), useWorkspaces: useHookOf(workspacesSnapshotValue), }))
    await flush()
    assert.ok(text(m.container).includes('上下文洞察'))
    assert.ok(text(m.container).includes('全部会话'), 'the All default labels the sessions card and the coverage option')
    assert.ok(text(m.container).includes('仅显示已归档'), 'the coverage options ride the zh dictionary too')
    assert.ok(text(m.container).includes('Token 统计'), 'the aggregate stats row rides the zh dictionary too')
    assert.ok(text(m.container).includes('系统提示词'), 'the Context tab\'s composition categories render in zh')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-ov-settings').title, '打开插件设置', 'the settings chip rides the zh dictionary too')
    await flush()
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.ok(values[2].startsWith('¥'), 'CNY under the zh locale')
    await m.unmount()

    const bare = {
      locale: {
        register: () => () => {},
        bind: () => makeKit().t,
      },
      get: () => undefined,
    }
    const fallback = makeOverviewPanel(bare as never, makeKit(), settingsWith())
    const mf = await mount(h(fallback, { useSessions: useHookOf(sessionsSnapshot()), useWorkspaces: useHookOf(workspacesSnapshotValue), }))
    await flush()
    await flush()
    assert.ok(queryAll(mf.container, '.lc-stat-value').map(el => el.textContent)[2].startsWith('$'), 'USD when the locale face cannot report an active locale')
    await mf.unmount()
  })

  test('the grid pages at 12 cards; the pager steps and a filter change re-anchors it', async () => {
    const ctx = makeCtx()
    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    const byId: Record<string, Record<string, unknown>> = {}
    ids.forEach((id, i) => { byId[id] = { displayTitle: `session ${i}`, updatedAt: NOW - i * 60_000 } })
    const { m } = await openPanel(ctx, {
      useSessions: useHookOf({ ids, byId, phase: 'ready' }),
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
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), 'session 2')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-session').length, 11, "'session 2' matches 2 and 20–29")
    assert.ok(!text(m.container).includes('Page 2 of 3'), 'the pager drops once one page remains')
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), '')
    assert.ok(text(m.container).includes('Page 1 of 3'), 'clearing the query lands on the first page, not the stale one')
    await m.unmount()
  })

})

async function actType(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function actSelect(select: HTMLSelectElement, value: string): Promise<void> {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value')?.set
    setter?.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

describe('OverviewPanel — progressive body', () => {
  test('the grid waits behind its reserved slots until the lazy mount fires', async () => {
    class IdleObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', IdleObserver)
    const { m } = await openPanel(makeCtx())
    assert.equal(queryAll(m.container, '.lc-ov-grid').length, 0, 'the body has not mounted')
    assert.equal(queryAll(m.container, '.lc-ov-tiles > .lc-deferred-skeleton').length, 4, 'the tile row reserves its four cards')
    assert.equal(queryAll(m.container, '.lc-ov-body > .lc-deferred-skeleton').length, 1, 'the session list reserves its block')
    assert.ok(queryAll(m.container, '.lc-ov-first .lc-stat-value').length > 0, 'the KPI band is already live')
    await m.unmount()
  })
})
