import { act, createElement as h, Profiler, useCallback, useRef, useState, useSyncExternalStore } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { makeOverviewPanel } from '../../../src/client/components/overviewPanel'
import { makeCtx, openPanel, propsOf, settingsWith } from './overviewPanelHarness'
import { resetInvalidations } from '../../../src/client/invalidation'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import type { DefaultOverviewRange } from '../../../src/shared/types'
import { dayKeyOf } from '../../../src/shared/days'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, flush, hover, makeKit, mount, query, queryAll, settle, text, unhover } from '../helpers/kit'
import {
  NOW, TODAY, YESTERDAY, panelDaysValue as daysValueFor, panelRows, panelRowsWithArchivedBeta,
  panelSessionsSnapshot as sessionsSnapshot, panelSummaryRaw as summaryRaw, panelSummaryValue as summaryValueFor, scopeOf,
  panelPageValue as pageValueFor, panelTallies as talliesValue,
  panelTalliesZero as talliesZero, pinCurrentSession, stubPanelRoutes as stubRoutes, overviewBodies, useHookOf,
} from '../overview.fixtures'
import { dayRangeWindow } from '../../../src/client/overview'

function bodyOf(calls: readonly RequestCall[], part: string): Record<string, unknown>[] {
  return overviewBodies(calls as never, part)
}

function lastBodyOf(calls: readonly RequestCall[], part: string): Record<string, unknown> {
  const bodies = bodyOf(calls, part)
  const last = bodies[bodies.length - 1]
  assert.ok(last !== undefined, `a ${part} request was made`)
  return last
}

function cardsOf(container: HTMLElement): HTMLElement[] {
  return queryAll(container, '.lc-ov-grid > .lc-ov-session')
}

function cardWith(container: HTMLElement, title: string): HTMLElement {
  const card = cardsOf(container).find(c => text(c).includes(title))
  assert.ok(card !== undefined, `the grid drew ${title}`)
  return card
}

function miniValues(card: HTMLElement): (string | null)[] {
  return queryAll(card, '.lc-ov-mini-value').map(el => el.textContent)
}

interface RequestCall {
  route: string
  body: Record<string, unknown>
}

function skillsBodyOf(calls: readonly RequestCall[]): Record<string, unknown> {
  const bodies = calls.filter(call => call.route.endsWith('/skills')).map(call => call.body)
  const last = bodies[bodies.length - 1]
  assert.ok(last !== undefined, 'a skill catalog read happened')
  return last
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

function calendarDay(key: string): HTMLElement {
  const el = queryAll(document.body, '.lc-dp-cell').find(d => d.getAttribute('aria-label') === key)
  assert.ok(el !== undefined, `the calendar drew ${key}`)
  return el
}

beforeEach(() => {
  pinCurrentSession('a')
})

afterEach(async () => {
  resetInvalidations()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  localStorage.clear()
  await new Promise(resolve => setTimeout(resolve, 1))
})

describe('OverviewPanel', () => {
  test('the host summary paints the KPI band, the host page draws the grid, and the host tallies feed the tiles', async () => {
    let pulls = 0
    const calls = stubRoutes()
    const ctx = makeCtx({ refresh: () => { pulls++; return Promise.resolve() } })
    const { m } = await openPanel(ctx)
    assert.equal(pulls, 0, 'the panel reads the live session store without re-listing the corpus')
    assert.equal(calls.filter(c => c.route.endsWith('/snapshot')).length, 0, 'the panel never reads the snapshot route')
    assert.equal(calls.filter(c => c.route.endsWith('/backfill')).length, 0, 'a complete coverage posts no warm-up trigger')
    assert.deepEqual(bodyOf(calls, 'summary')[0], { part: 'summary', scope: { range: '30d', coverage: 'all' } })
    assert.deepEqual(bodyOf(calls, 'days')[0], { part: 'days', scope: { coverage: 'all' } })
    assert.deepEqual(bodyOf(calls, 'page')[0], { part: 'page', scope: { range: '30d', coverage: 'all' }, sort: 'recent', page: 0 })
    const tallyBodies = bodyOf(calls, 'tally')
    assert.equal(tallyBodies.length, 3, 'skills, tools, and commands each read their own tally')
    assert.deepEqual(tallyBodies.map(body => [body.tally, body.scope]), [
      ['skills', { range: '30d', coverage: 'all' }],
      ['tools', { range: '30d', coverage: 'all' }],
      ['cmds', { range: '30d', coverage: 'all' }],
    ])
    assert.ok(text(m.container).includes('Context Insights'))
    const scrollRows = [...query(m.container, '.lc-ov-pagecontent').children].map(el => el.className.split(' ')[0])
    assert.deepEqual(scrollRows, ['lc-ov-pagehead', 'lc-ov-first', 'lc-ov-stats', 'lc-ov-body'])
    assert.ok(query(m.container, '.lc-ov-pagehead').hasAttribute('data-window-drag'), 'the head is the desktop window drag area')
    assert.ok(query(m.container, '.lc-ov-first > .lc-card.lc-ov-usage') !== null, 'the usage chart rides the row')
    const values = queryAll(m.container, '.lc-stat-value').map(el => el.textContent)
    assert.deepEqual(values, ['2', '1.8k', '$1.50', '33.33%', '14', '3m0s'])
    assert.ok(text(m.container).includes('tool runs 40.0s'), 'the tool calls cell qualifies with the windowed tool time')
    assert.ok(text(m.container).includes('8 model calls'), 'the active-time cell qualifies with the windowed call count')
    const subs = queryAll(m.container, '.lc-stat-sub').map(el => el.textContent)
    assert.deepEqual(subs.slice(0, 4), ['incl. 0 archived', 'Turns 5', '1 of 1 sessions priced', 'across 1 sessions'])
    const statsCards = queryAll(m.container, '.lc-ov-stats > .lc-card')
    assert.equal(statsCards.length, 2)
    assert.equal(query(statsCards[0], '.lc-donut-center b').textContent, '1.8k', 'the hosted token parts total rides the donut')
    assert.equal(query(statsCards[1], '.lc-donut-center b').textContent, '3m0s', 'the band and the card share one active-time figure')
    assert.ok(text(statsCards[1]).includes('14 runs'))
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
    const cards = cardsOf(m.container)
    assert.equal(cards.length, 2)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(cards[0]).includes('workspace-one'), 'the breadcrumb group joined')
    assert.ok(text(cards[0]).includes('alpha'), 'the project basename joined')
    assert.equal(query(cards[0], '.lc-donut-center b').textContent, '500', 'the host page row parts draw the donut')
    assert.deepEqual(miniValues(cards[0]), ['3 turns · 5 steps', '1.8k', '$0.72'])
    await m.unmount()
  })

  test('the KPI band dashes until the summary lands; the page drives the list and its cost labels meanwhile', async () => {
    let releaseSummary: ((value: unknown) => void) | null = null
    stubRoutes({ summary: () => new Promise<unknown>((resolve) => { releaseSummary = resolve }) })
    const { m } = await openPanel(makeCtx())
    const page = query(m.container, '.lc-ov-page')
    assert.equal(page.getAttribute('aria-busy'), 'true')
    assert.ok(page.className.includes('lc-ov-busy'))
    assert.deepEqual(queryAll(m.container, '.lc-stat-value').map(el => el.textContent), ['—', '—', '—', '—', '—', '—'])
    await act(async () => { releaseSummary?.(summaryValueFor({ scope: { range: '30d', coverage: 'all' } })) })
    await flush()
    await settle(1)
    assert.equal(page.getAttribute('aria-busy'), null)
    assert.ok(!page.className.includes('lc-ov-busy'))
    assert.deepEqual(queryAll(m.container, '.lc-stat-value').map(el => el.textContent), ['2', '1.8k', '$1.50', '33.33%', '14', '3m0s'])
    assert.equal(miniValues(cardWith(m.container, 'alpha session'))[2], '$0.72', 'the page row cost prices the card')
    assert.equal(miniValues(cardWith(m.container, 'beta session'))[2], '—', 'a null page cost dashes the card')
    await m.unmount()
  })

  test('a sessions seat that appears or disappears after mount keeps the panel rendering without shifting its hooks', async () => {
    stubRoutes()
    const ctx = makeCtx()
    const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit(), settingsWith())
    function useSeat<T>(sel: (s: unknown) => T): T {
      useState(0)
      return sel(sessionsSnapshot())
    }
    const m = await mount(h(Panel, {}))
    await flush()
    await settle(5)
    await m.update(h(Panel, { useSessions: useSeat }))
    await flush()
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    await m.update(h(Panel, {}))
    await flush()
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    await m.unmount()
  })

  test('a tool or command row filters the host page and its chip releases the filter', async () => {
    const calls = stubRoutes()
    const { m } = await openPanel(makeCtx())
    const tiles = queryAll(m.container, '.lc-ov-tiles > .lc-card')
    const readRow = queryAll<HTMLButtonElement>(tiles[2], 'button.lc-ov-tally').find(row => text(row).includes('read'))
    assert.ok(readRow !== undefined)
    await click(readRow)
    await settle(5)
    assert.deepEqual(lastBodyOf(calls, 'page').pick, { field: 'tools', name: 'read' }, 'the page request carries the tally pick')
    let cards = cardsOf(m.container)
    assert.equal(cards.length, 1, 'only the session that ran read in scope stays')
    assert.ok(text(cards[0]).includes('alpha session'))
    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the tool filter"]')
    assert.ok(text(chip).includes('Tool · read'))
    await click(readRow)
    await settle(5)
    assert.equal(lastBodyOf(calls, 'page').pick, undefined, 'the pinned row releases its own filter')
    assert.equal(cardsOf(m.container).length, 2)
    await click(readRow)
    await settle(5)
    assert.equal(cardsOf(m.container).length, 1)
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the tool filter"]'))
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)

    const gitRow = queryAll<HTMLButtonElement>(tiles[3], 'button.lc-ov-tally').find(row => text(row).includes('git'))
    assert.ok(gitRow !== undefined)
    await click(gitRow)
    await settle(5)
    assert.deepEqual(lastBodyOf(calls, 'page').pick, { field: 'cmds', name: 'git' })
    cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(text(query(m.container, '.lc-ov-day-chip[title="Clear the command filter"]')).includes('Command · git'))
    await click(queryAll<HTMLButtonElement>(tiles[3], 'button.lc-ov-tally').find(row => text(row).includes('git'))!)
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2, 'the pinned row releases its own filter')
    await m.unmount()
  })

  test('an empty corpus keeps the tally cards’ summary and body, never a lone placeholder', async () => {
    stubRoutes({ rows: [], tallies: talliesZero(), days: () => ({ revision: 'd0', pricingReady: true, days: [] }) })
    const { m } = await openPanel(makeCtx())
    const tiles = queryAll(m.container, '.lc-ov-tiles > .lc-card')
    assert.equal(tiles.length, 4)
    assert.equal(text(query(tiles[1], '.lc-ov-tally-note')), '0 skills · 0 loads')
    assert.equal(text(query(tiles[2], '.lc-ov-tally-note')), '0 tools · 0 calls')
    assert.equal(text(query(tiles[3], '.lc-ov-tally-note')), '0 programs · 0 runs')
    assert.ok(text(tiles[2]).includes('No tool calls in this range'))
    assert.ok(text(tiles[3]).includes('No commands in this range'))
    assert.ok(text(m.container).includes('No sessions yet'))
    assert.ok(text(m.container).includes('No activity yet'))
    await m.unmount()
  })

  test('the coverage picker re-scopes the hosted KPI band and the page; an archived card never opens', async () => {
    const opened: string[] = []
    const calls = stubRoutes({ rows: panelRowsWithArchivedBeta() })
    const ctx = new TestClientCtx({
      services: { uiWorkspace: { openSession: (id: string) => { opened.push(id) } }, sessions: {} },
    })
    const { m } = await openPanel(ctx)
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'incl. 1 archived')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '2')
    let cards = cardsOf(m.container)
    assert.equal(cards.length, 2)
    const betaCard = cards.find(c => text(c).includes('beta session'))
    assert.ok(betaCard !== undefined && text(betaCard).includes('Archived'), 'the archived card carries the tag')
    const select = query<HTMLSelectElement>(m.container, 'select.lc-ov-cover')
    assert.deepEqual([...select.options].map(o => o.textContent), ['All (show archived)', 'Hide archived', 'Archived only'])
    await actSelect(select, 'active')
    await settle(5)
    assert.deepEqual(lastBodyOf(calls, 'page').scope, { range: '30d', coverage: 'active' })
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Active Sessions')
    assert.deepEqual(queryAll(m.container, '.lc-stat-sub')[0].textContent, 'of 3 total')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1', 'the host summary re-scopes to the archived filter')
    cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    await actSelect(select, 'archived')
    await settle(5)
    assert.deepEqual(queryAll(m.container, '.lc-stat-label')[0].textContent, 'Archived Sessions')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1')
    const archCards = cardsOf(m.container)
    assert.equal(archCards.length, 1)
    assert.ok(text(archCards[0]).includes('beta session'))
    await click(archCards[0])
    assert.deepEqual(opened, [], 'the archived card never navigates')
    await m.unmount()
  })

  test('the configured default range selects the preset on mount — even when the settings section lands late', async () => {
    const calls = stubRoutes()
    const ctx = makeCtx()
    const { m } = await openPanel(ctx, {}, settingsWith('7d'))
    assert.deepEqual(lastBodyOf(calls, 'page').scope, { range: '7d', coverage: 'all' })
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.ok(rangeButtons[1].className.includes('lc-gran-on'), 'the configured 7-day preset opens lit')
    assert.ok(!rangeButtons[2].className.includes('lc-gran-on'), 'the schema default stands down')
    assert.deepEqual(
      queryAll(m.container, '.lc-dp-half').map(el => el.textContent),
      [dayKeyOf(NOW - 7 * 86_400_000), TODAY],
      'the page opens on the configured window',
    )
    assert.equal(cardsOf(m.container).length, 2, 'the scope follows the preset')
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

  test('picking a range writes it back as the default, so a remount keeps it; a loading or read-only form stays unwritten', async () => {
    stubRoutes()
    const { settings, sets } = writableSettings()
    const first = await openPanel(makeCtx(), {}, settings)
    const buttons = queryAll<HTMLButtonElement>(first.m.container, '.lc-ov-range .lc-gran-btn')
    await click(buttons[1])
    await settle(5)
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

    const loading = createContextSettings()
    loading.attach({
      getSnapshot: () => ({ status: 'loading', value: {}, writable: false }),
      subscribe: () => () => {},
      set: () => { throw new Error('a loading form must never be written') },
    })
    const loadingPanel = await openPanel(makeCtx(), {}, loading)
    const loadingButtons = queryAll<HTMLButtonElement>(loadingPanel.m.container, '.lc-ov-range .lc-gran-btn')
    await click(loadingButtons[1])
    assert.ok(loadingButtons[1].className.includes('lc-gran-on'), 'a loading form still applies the visit-local pick')
    await loadingPanel.m.unmount()
  })

  test('a failed page read shows the unavailable note while the summary and days keep loading', async () => {
    const calls = stubRoutes({ page: () => { throw new Error('page down') } })
    const { m } = await openPanel(makeCtx())
    assert.ok(text(m.container).includes('The session list is unavailable'))
    assert.equal(queryAll(m.container, '.lc-ov-kpi').length, 0)
    assert.equal(queryAll(m.container, '.lc-ov-grid').length, 0)
    assert.ok(bodyOf(calls, 'summary').length === 1 && bodyOf(calls, 'days').length === 1, 'the other parts still read')
    await m.unmount()
  })

  test('range presets and a picked calendar range re-scope the hosted KPI band and the page', async () => {
    const calls = stubRoutes()
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const rangeButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-range .lc-gran-btn')
    assert.equal(rangeButtons.length, 4)
    const span = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    const thirty = new Date(NOW - 30 * 86_400_000)
    assert.deepEqual(span(), [dayKeyOf(thirty.getTime()), TODAY], '30d shows the thirty days it covers')
    await click(rangeButtons[3])
    await settle(5)
    assert.deepEqual(lastBodyOf(calls, 'page').scope, { range: 'all', coverage: 'all' })
    assert.deepEqual(span(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.equal(cardsOf(m.container).length, 3, 'the stale session joins')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '3', 'the host summary follows the All preset')
    await click(rangeButtons[0])
    await settle(5)
    assert.deepEqual(span(), [TODAY, TODAY], "today's own day on both ends")
    assert.equal(cardsOf(m.container).length, 1, "only today's session stays")
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '1')
    await click(rangeButtons[1])
    await settle(5)
    assert.deepEqual(span(), [dayKeyOf(NOW - 7 * 86_400_000), TODAY])
    assert.equal(cardsOf(m.container).length, 2, 'the yesterday-active session joins the prompt-fresh one')
    assert.equal(queryAll(m.container, '.lc-stat-value')[0].textContent, '2')
    await click(rangeButtons[2])
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    await m.unmount()

    const calendar = await openPanel(ctx)
    const calendarButtons = queryAll<HTMLButtonElement>(calendar.m.container, '.lc-ov-range .lc-gran-btn')
    await click(query(calendar.m.container, '.lc-dp-trigger'))
    const spansMonths = YESTERDAY.slice(0, 7) !== TODAY.slice(0, 7)
    const navbtns = () => queryAll(document.body, '.lc-dp-navbtn')
    if (spansMonths) await click(navbtns()[0])
    await click(calendarDay(YESTERDAY))
    if (spansMonths) await click(navbtns()[1])
    await click(calendarDay(TODAY))
    await settle(5)
    const pickedWindow = dayRangeWindow({ from: YESTERDAY, to: TODAY })
    assert.ok(pickedWindow !== null)
    assert.deepEqual(lastBodyOf(calls, 'page').scope, {
      range: { start: pickedWindow.start, end: pickedWindow.end },
      coverage: 'all',
    }, 'the page request carries the picked window bounds')
    assert.ok(query(calendar.m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'), 'the chip carries the picked range')
    assert.deepEqual(
      queryAll(calendar.m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the head names both ends, start first',
    )
    assert.equal(cardsOf(calendar.m.container).length, 2)
    assert.equal(queryAll(calendar.m.container, '.lc-stat-value')[0].textContent, '2', 'the host summary takes the picked window')
    assert.ok(
      calendarButtons.every(b => !b.className.includes('lc-gran-on')),
      'a picked range and a preset are never both lit',
    )
    await click(calendarButtons[3])
    await settle(5)
    assert.equal(cardsOf(calendar.m.container).length, 3, 'the stale session joins again')
    assert.ok(!query(calendar.m.container, '.lc-dp-trigger').className.includes('lc-dp-trigger-on'))
    await calendar.m.unmount()

    const back = await openPanel(ctx)
    await click(query(back.m.container, '.lc-dp-trigger'))
    await click(calendarDay(TODAY))
    if (spansMonths) await click(queryAll(document.body, '.lc-dp-navbtn')[0])
    await click(calendarDay(YESTERDAY))
    await settle(5)
    assert.deepEqual(
      queryAll(back.m.container, '.lc-dp-trigger .lc-dp-half').map(el => el.textContent),
      [YESTERDAY, TODAY],
      'the picked pair is sorted, start day first',
    )
    assert.equal(cardsOf(back.m.container).length, 2, 'the same window a forward pick would have left')
    await back.m.unmount()
  })

  test('the hosted heatmap day pin re-scopes the page and tallies; its metric toggle re-prices between tokens and sessions', async () => {
    const calls = stubRoutes()
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const cells = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    const todayCell = cells.find(c => c.getAttribute('aria-label')?.startsWith(TODAY))
    assert.ok(todayCell !== undefined, 'today has a data cell')
    await click(todayCell)
    await settle(5)
    assert.equal(scopeOf(lastBodyOf(calls, 'page')).day, TODAY)
    assert.equal(scopeOf(lastBodyOf(calls, 'tally')).day, TODAY, 'the tallies follow the pinned day too')
    assert.ok(query(m.container, '.lc-ov-day-chip'), 'the day chip appears')
    const cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'), 'only the session active that day stays')
    await click(query<HTMLButtonElement>(m.container, '.lc-ov-day-chip'))
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2, 'the chip clear restores')
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2, 'both sessions were active yesterday')
    await click(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').find(c => c.getAttribute('aria-label')?.startsWith(YESTERDAY))!)
    await settle(5)
    assert.equal(queryAll(m.container, '.lc-ov-day-chip').length, 0)
    await m.unmount()

    const metric = await openPanel(ctx)
    const todayCellClass = (): string | undefined =>
      queryAll<HTMLButtonElement>(metric.m.container, 'button.lc-heat-cell')
        .find(c => c.getAttribute('aria-label')?.startsWith(TODAY))?.className
    assert.ok(todayCellClass()?.includes('lc-heat-4'), 'tokens mode (default): today holds the hosted token peak')
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

  test('the current session id marks its card and anchors the skill catalog; the card pins the skill’s loaders', async () => {
    const skillsCalls: unknown[] = []
    const calls = stubRoutes({
      tallies: { ...talliesValue(), skills: [{ name: 'tdd', n: 2, sessions: 1, last: NOW - 1000 }] },
      skills: (body) => {
        skillsCalls.push(body)
        return { skills: [{ name: 'tdd', description: 'Test-driven.', path: '/p/tdd/SKILL.md', source: 'user-agents' }] }
      },
    })
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    await flush()
    await settle(5)
    assert.deepEqual(skillsCalls, [{ cwd: '/repo/alpha', sessionId: 'a' }], 'the catalog read anchors on the current session')
    assert.ok(query(cardWith(m.container, 'alpha session'), '.lc-ov-current') !== null)
    assert.equal(queryAll(cardWith(m.container, 'beta session'), '.lc-ov-current').length, 0)
    const skillRow = query<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.ok(text(skillRow).includes('tdd'))
    await hover(skillRow)
    assert.ok(text(document.querySelector('#lc-skilltip-bubble') as HTMLElement).includes('Test-driven.'), 'the catalog’s description joins the hover card')
    await unhover(skillRow)
    await click(skillRow)
    await settle(5)
    assert.deepEqual(lastBodyOf(calls, 'page').pick, { field: 'skills', name: 'tdd' })
    const cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    const chip = query<HTMLButtonElement>(m.container, '.lc-ov-day-chip[title="Clear the skill filter"]')
    assert.ok(text(chip).includes('Skill · tdd'))
    assert.ok(text(query(m.container, '.lc-ov-skill-detail')).includes('/p/tdd/SKILL.md'))
    await click(chip)
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0, 'the detail block leaves with the pin')
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-tally'))
    await settle(5)
    assert.equal(cardsOf(m.container).length, 1)
    await click(query<HTMLButtonElement>(m.container, 'button.lc-ov-tally'))
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    await m.unmount()
  })

  test('a skill catalog that lands after unmount never paints, and a current id without a cwd reads the catalog by session', async () => {
    let releaseSkills: ((value: unknown) => void) | null = null
    const gatedCalls = stubRoutes({
      skills: () => new Promise<unknown>((resolve) => { releaseSkills = resolve }),
    })
    const { m } = await openPanel(makeCtx())
    assert.deepEqual(skillsBodyOf(gatedCalls), { cwd: '/repo/alpha', sessionId: 'a' })
    await m.unmount()
    await act(async () => { releaseSkills?.({ skills: [{ name: 'tdd', path: '/p/tdd/SKILL.md' }] }) })
    await flush()

    const noCwdCalls = stubRoutes()
    pinCurrentSession('b')
    const noCwd = await openPanel(makeCtx(), {
      useSessions: useHookOf({ ids: ['b'], byId: { b: {} } }),
    })
    assert.deepEqual(skillsBodyOf(noCwdCalls), { sessionId: 'b' }, 'a session without a cwd still anchors the catalog')
    assert.ok(query(cardWith(noCwd.m.container, 'beta session'), '.lc-ov-current') !== null)
    await noCwd.m.unmount()

    pinCurrentSession(null)
    const bareCalls = stubRoutes()
    const bare = await openPanel(makeCtx(), { useSessions: undefined })
    assert.deepEqual(skillsBodyOf(bareCalls), {}, 'no current session reads the default catalog')
    assert.equal(queryAll(bare.m.container, '.lc-ov-current').length, 0)
    await bare.m.unmount()
  })

  test('search, sort, and paging steer the hosted page request and the rendered list', async () => {
    const calls = stubRoutes()
    const ctx = makeCtx()
    const { m } = await openPanel(ctx)
    const input = query<HTMLInputElement>(m.container, 'input.lc-ov-search')
    input.focus()
    await actType(input, 'beta')
    await settle(5)
    assert.equal(scopeOf(lastBodyOf(calls, 'page')).query, 'beta')
    assert.equal(cardsOf(m.container).length, 1)
    assert.ok(text(m.container).includes('beta session'))
    await actType(input, '/repo/a')
    await settle(5)
    assert.equal(cardsOf(m.container).length, 1)
    await actType(input, 'zzz')
    await settle(5)
    assert.equal(cardsOf(m.container).length, 0)
    assert.ok(text(m.container).includes('No sessions match'))
    await actType(input, '')
    await settle(5)
    const sortButtons = queryAll<HTMLButtonElement>(m.container, '.lc-ov-list-head .lc-gran-btn')
    assert.equal(sortButtons.length, 3)
    await click(sortButtons[1])
    await settle(5)
    assert.equal(lastBodyOf(calls, 'page').sort, 'tokens')
    assert.ok(text(cardsOf(m.container)[0]).includes('alpha session'))
    await click(sortButtons[2])
    await settle(5)
    assert.equal(lastBodyOf(calls, 'page').sort, 'context')
    assert.ok(text(cardsOf(m.container)[0]).includes('alpha session'))
    await click(sortButtons[0])
    await settle(5)
    assert.equal(lastBodyOf(calls, 'page').sort, 'recent')
    assert.equal(document.activeElement, input, 're-renders leave the focused input alone')
    await m.unmount()

    const ids = Array.from({ length: 30 }, (_, i) => `s${i}`)
    const pagedRows = ids.map((id, i) => ({
      id,
      title: `session ${i}`,
      updatedAt: NOW - i * 60_000,
      tokens: 0,
      turns: 0,
      parts: [],
      total: 0,
      costUsd: null,
      activeDays: [TODAY],
    }))
    const pagedCalls = stubRoutes({ rows: pagedRows })
    const paged = await openPanel(ctx, { useSessions: useHookOf({ ids, byId: {}, phase: 'ready' }) })
    assert.equal(cardsOf(paged.m.container).length, 12, 'the first page caps at 12 cards')
    assert.ok(text(paged.m.container).includes('Page 1 of 3'))
    const btns = () => queryAll<HTMLButtonElement>(paged.m.container, '.lc-ov-pager-btn')
    assert.ok(btns()[0].disabled, 'prev sits out on the first page')
    await click(btns()[1])
    await settle(5)
    assert.equal(lastBodyOf(pagedCalls, 'page').page, 1)
    assert.equal(cardsOf(paged.m.container).length, 12, 'the middle page is full')
    await click(btns()[1])
    await settle(5)
    assert.equal(cardsOf(paged.m.container).length, 6, 'the tail page renders the rest')
    assert.ok(text(paged.m.container).includes('Page 3 of 3'))
    assert.ok(btns()[1].disabled, 'next sits out on the last page')
    await click(btns()[0])
    await settle(5)
    assert.ok(text(paged.m.container).includes('Page 2 of 3'), 'prev steps back')
    await actType(query<HTMLInputElement>(paged.m.container, 'input.lc-ov-search'), 'session 2')
    await settle(5)
    assert.equal(cardsOf(paged.m.container).length, 11, "'session 2' matches 2 and 20–29")
    assert.ok(!text(paged.m.container).includes('Page 2 of 3'), 'the pager drops once one page remains')
    await actType(query<HTMLInputElement>(paged.m.container, 'input.lc-ov-search'), '')
    await settle(5)
    assert.ok(text(paged.m.container).includes('Page 1 of 3'), 'clearing the query lands on the first page, not the stale one')
    await paged.m.unmount()
  })

  test('the group chips filter the page (All / workspace / Ungrouped), toggling on and off', async () => {
    const calls = stubRoutes()
    const { m } = await openPanel(makeCtx())
    const chips = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(chips.map(c => c.textContent), ['All2', 'workspace-one1', 'Ungrouped1'])
    await click(chips[1])
    await settle(5)
    assert.equal(scopeOf(lastBodyOf(calls, 'page')).group, 'workspace-one')
    let cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('alpha session'))
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1].className.includes('lc-ov-chip-on'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    await settle(5)
    assert.equal(scopeOf(lastBodyOf(calls, 'page')).group, '__ungrouped__', 'the ungrouped chip sends the host’s literal key')
    cards = cardsOf(m.container)
    assert.equal(cards.length, 1)
    assert.ok(text(cards[0]).includes('beta session'))
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[2])
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await settle(5)
    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[0])
    await settle(5)
    assert.equal(cardsOf(m.container).length, 2)

    await click(queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')[1])
    await settle(5)
    await actType(query<HTMLInputElement>(m.container, 'input.lc-ov-search'), 'zzz')
    await settle(5)
    const phantom = queryAll<HTMLButtonElement>(m.container, '.lc-ov-chip')
    assert.deepEqual(phantom.map(c => c.textContent), ['All0', 'workspace-one0'])
    assert.ok(phantom[1].className.includes('lc-ov-chip-on'))
    assert.equal(cardsOf(m.container).length, 0)
    await m.unmount()
  })

  test('a card click opens the session through the harness verb, and the settings chip runs the preferences jump', async () => {
    stubRoutes()
    const opened: string[] = []
    const bundles: string[] = []
    const ctx = new TestClientCtx({
      services: {
        uiWorkspace: { openSession: (id: string) => { opened.push(id) } },
        pluginNavigation: { openBundle: (name: string) => { bundles.push(name) } },
        sessions: {},
      },
    })
    const { m } = await openPanel(ctx)
    await click(cardsOf(m.container)[0]!)
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

  test('degraded states: no activity, hostile sessions seat, custom-range requests, and dashes for missing host data', async () => {
    stubRoutes({ days: () => daysValueFor() })
    const ctx = makeCtx()
    pinCurrentSession(null)
    const hostile = await openPanel(ctx, { useSessions: () => { throw new Error('boom') } })
    assert.equal(cardsOf(hostile.m.container).length, 2, 'a hostile sessions seat never blocks the hosted list')
    assert.equal(queryAll(hostile.m.container, '.lc-ov-current').length, 0)
    await hostile.m.unmount()

    stubRoutes({
      days: () => ({ revision: 'd1', pricingReady: true, days: [] }),
      summary: () => ({
        revision: 's1',
        pricingReady: true,
        summary: summaryRaw({
          sessions: 1, sessionsTotal: 1, tokens: 0, turns: 0, costUsd: null, costSessions: 0, usageSessions: 0,
          cacheHit: null, tokenParts: null, timing: null,
          windowTiming: { calls: 0, toolCalls: 0, toolsMs: 0, wallMs: 0 },
        }),
      }),
      rows: [{
        id: 'x',
        title: 'plain session',
        updatedAt: NOW - 1000,
        tokens: 0,
        turns: 0,
        parts: [],
        total: 0,
        costUsd: null,
        activeDays: [TODAY],
      }],
    })
    const noTimeline = await openPanel(ctx)
    assert.ok(text(noTimeline.m.container).includes('No context data yet'))
    const kpiValues = queryAll(noTimeline.m.container, '.lc-stat-value').map(el => el.textContent)
    assert.equal(kpiValues[1], '0')
    assert.equal(kpiValues[2], '—', 'the host prices nothing without cost buckets')
    assert.equal(kpiValues[3], '—', 'no cache hit without billed input')
    assert.equal(kpiValues[4], '0', 'no tool calls without timing')
    assert.equal(kpiValues[5], '—', 'no active time without timing')
    assert.ok(text(noTimeline.m.container).includes('No billed tokens in this range'))
    assert.ok(!text(noTimeline.m.container).includes('No timing data yet'), 'the timing card lays out zeros instead')
    assert.equal(queryAll(noTimeline.m.container, '.lc-sl-row').length, 4, 'the zero timing slots stay in place')
    await noTimeline.m.unmount()

    stubRoutes({ rows: panelRows().map(row => ({ ...row, costUsd: null })) })
    const unpriced = await openPanel(ctx)
    assert.equal(miniValues(cardWith(unpriced.m.container, 'alpha session'))[2], '—')
    await unpriced.m.unmount()
  })

  test('a failed summary read with an empty page states the empty claim instead of stalling', async () => {
    stubRoutes({ summary: () => null, rows: [] })
    const { m } = await openPanel(makeCtx())
    assert.ok(text(m.container).includes('No sessions yet'), 'the list names the empty scope')
    await m.unmount()
  })

  test('the zh locale renders translated chrome and CNY cost from the host USD; a bare locale falls back to USD', async () => {
    stubRoutes()
    const ctx = new TestClientCtx({ locale: 'zh', services: { sessions: {} } })
    const Panel = makeOverviewPanel(asClientCtx(ctx), makeKit('zh'), settingsWith())
    const m = await mount(h(Panel, propsOf()))
    await flush()
    await settle(5)
    assert.ok(text(m.container).includes('上下文洞察'))
    assert.ok(text(m.container).includes('全部会话'), 'the All default labels the sessions card and the coverage option')
    assert.ok(text(m.container).includes('仅显示已归档'), 'the coverage options ride the zh dictionary too')
    assert.ok(text(m.container).includes('Token 统计'), 'the aggregate stats row rides the zh dictionary too')
    assert.ok(text(m.container).includes('系统提示词'), 'the Context tab\'s composition categories render in zh')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-ov-settings').title, '打开插件设置', 'the settings chip rides the zh dictionary too')
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
    const mf = await mount(h(fallback, propsOf()))
    await flush()
    await settle(5)
    assert.ok(queryAll(mf.container, '.lc-stat-value').map(el => el.textContent)[2].startsWith('$'), 'USD when the locale face cannot report an active locale')
    await mf.unmount()
  })

  test('busy flags follow the days and page parts as well as the summary', async () => {
    let releaseDays: ((value: unknown) => void) | null = null
    stubRoutes({ days: () => new Promise<unknown>((resolve) => { releaseDays = resolve }) })
    const daysPending = await openPanel(makeCtx())
    assert.equal(query(daysPending.m.container, '.lc-ov-page').getAttribute('aria-busy'), 'true', 'a pending days part keeps the page busy')
    await act(async () => { releaseDays?.(daysValueFor()) })
    await flush()
    await settle(1)
    assert.equal(query(daysPending.m.container, '.lc-ov-page').getAttribute('aria-busy'), null)
    await daysPending.m.unmount()

    let releasePage: ((value: unknown) => void) | null = null
    stubRoutes({ page: () => new Promise<unknown>((resolve) => { releasePage = resolve }) })
    const pagePending = await openPanel(makeCtx())
    assert.equal(query(pagePending.m.container, '.lc-ov-page').getAttribute('aria-busy'), 'true', 'a pending page part keeps the page busy')
    assert.deepEqual(queryAll(pagePending.m.container, '.lc-stat-value').map(el => el.textContent), ['2', '1.8k', '$1.50', '33.33%', '14', '3m0s'], 'the KPI band paints without the page')
    await act(async () => { releasePage?.(pageValueFor({ part: 'page', scope: { range: '30d', coverage: 'all' }, sort: 'recent', page: 0 })) })
    await flush()
    await settle(1)
    assert.equal(query(pagePending.m.container, '.lc-ov-page').getAttribute('aria-busy'), null)
    await pagePending.m.unmount()
  })
})

describe('OverviewPanel — progressive body', () => {
  test('the grid and the tallies wait behind the reserved slots until the lazy mount fires', async () => {
    class IdleObserver {
      observe(): void {}
      disconnect(): void {}
    }
    vi.stubGlobal('IntersectionObserver', IdleObserver)
    const calls = stubRoutes()
    const { m } = await openPanel(makeCtx())
    assert.equal(queryAll(m.container, '.lc-ov-tiles > .lc-deferred-skeleton').length, 4, 'the tile row reserves its four cards')
    assert.equal(queryAll(m.container, '.lc-ov-grid > .lc-ov-skel-card').length, 12, 'the session list reserves its card grid')
    assert.ok(queryAll(m.container, '.lc-ov-first .lc-stat-value').length > 0, 'the KPI band is already live')
    assert.equal(bodyOf(calls, 'tally').length, 0, 'the tally parts wait for the tiles to mount')
    assert.equal(bodyOf(calls, 'page').length, 1, 'the list data is already on its way')
    await m.unmount()
  })
})

describe('OverviewPanel — session-store subscription', () => {
  test('session churn outside the current row never repaints the page', async () => {
    stubRoutes()
    pinCurrentSession('b')
    let snapshot: Record<string, unknown> = { byId: { a: { cwd: '/repo/a' }, b: {} }, ids: ['a', 'b'] }
    const listeners = new Set<() => void>()
    const subscribe = (fn: () => void): (() => void) => {
      listeners.add(fn)
      return () => { listeners.delete(fn) }
    }
    const getSnapshot = (): unknown => snapshot
    function useSeat<T>(select: (value: unknown) => T): T {
      const selectRef = useRef(select)
      selectRef.current = select
      const cache = useRef<{ has: boolean; value: T | undefined }>({ has: false, value: undefined })
      const getSelected = useCallback(() => {
        const next = selectRef.current(getSnapshot())
        if (!cache.current.has || !Object.is(cache.current.value, next)) cache.current = { has: true, value: next }
        return cache.current.value as T
      }, [])
      return useSyncExternalStore(subscribe, getSelected)
    }
    let commits = 0
    const Panel = makeOverviewPanel(asClientCtx(makeCtx()), makeKit(), settingsWith())
    const m = await mount(h(Profiler, { id: 'overview', onRender: () => { commits += 1 } }, h(Panel, { useSessions: useSeat })))
    await flush()
    await settle(5)
    commits = 0
    for (let index = 0; index < 10; index++) {
      snapshot = { byId: { a: { cwd: '/repo/a', displayTitle: `churn ${index}` }, b: {} }, ids: ['a', 'b'], phase: `p${index}` }
      await act(async () => { for (const listener of [...listeners]) listener() })
    }
    assert.equal(commits, 0, 'rows updating around the current session do not repaint the page')
    pinCurrentSession('a')
    snapshot = { byId: { a: { cwd: '/repo/a' }, b: {} }, ids: ['a', 'b'] }
    await act(async () => { for (const listener of [...listeners]) listener() })
    assert.ok(commits >= 1, 'switching the current session repaints')
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
