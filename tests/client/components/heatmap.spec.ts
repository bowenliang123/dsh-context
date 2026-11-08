import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { gridOf, makeHeatmap, todayKey } from '../../../src/client/components/heatmap'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Heatmap = makeHeatmap(kit)

const TODAY = '2026-09-16'

describe('gridOf', () => {
  test('lays out weeks of Sunday-first columns ending at today’s week', () => {
    const grid = gridOf(TODAY, 2)
    assert.ok(grid !== null)
    assert.equal(grid.length, 2)
    assert.equal(grid[0][0].key, '2026-09-06', 'the first column opens one week earlier')
    assert.equal(grid[1][0].key, '2026-09-13', 'the last column is today’s Sunday')
    assert.equal(grid[1][3].key, TODAY)
    assert.equal(grid[1][3].future, false)
    assert.equal(grid[1][4].future, true, 'days after today render as future placeholders')
    assert.equal(grid[1][6].key, '2026-09-19')
  })

  test('degraded inputs read null (the card then shows its empty note)', () => {
    assert.equal(gridOf('', 2), null)
    assert.equal(gridOf('garbage', 2), null)
    assert.equal(gridOf(TODAY, 0), null, 'no columns to draw')
    assert.equal(gridOf(TODAY, 3000), null, 'a window reaching before the epoch has no first Sunday')
    assert.equal(gridOf('9999-12-31', 2), null, 'the final week of the representable range overflows')
  })
})

describe('Heatmap', () => {
  test('an empty ledger or a corrupt today key renders the empty note, no grid', async () => {
    const m = await mount(h(Heatmap, { days: {}, today: TODAY }))
    assert.ok(text(m.container).includes('No activity yet'))
    assert.equal(queryAll(m.container, '.lc-heat-cell').length, 0)
    await m.unmount()

    const corrupt = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 5, sessions: 1, cost: null } }, today: 'junk' }))
    assert.ok(text(corrupt.container).includes('No activity yet'))
    await corrupt.unmount()
  })

  test('cells draw with depth levels; data days are buttons with labels', async () => {
    const days = {
      '2026-09-16': { tokens: 100, sessions: 2, cost: null },
      '2026-09-15': { tokens: 50, sessions: 1, cost: null },
      '2026-09-14': { tokens: 25, sessions: 1, cost: null },
      '2026-09-10': { tokens: 30, sessions: 1, cost: null },
      '2026-09-09': { tokens: 75, sessions: 3, cost: null },
      '2026-09-08': { tokens: 1, sessions: 1, cost: null },
      '2026-09-06': { tokens: 0, sessions: 1, cost: null },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    const buttons = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    assert.equal(buttons.length, 7)
    const byKey = new Map(buttons.map(b => [b.getAttribute('aria-label')?.split('\n')[0], b]))
    assert.ok(byKey.get('2026-09-16')?.className.includes('lc-heat-4'), 'the maximum day is deepest')
    assert.ok(byKey.get('2026-09-15')?.className.includes('lc-heat-2'))
    assert.ok(byKey.get('2026-09-14')?.className.includes('lc-heat-1'))
    assert.ok(byKey.get('2026-09-10')?.className.includes('lc-heat-2'), '30 of the 100-token peak draws level 2')
    assert.ok(byKey.get('2026-09-09')?.className.includes('lc-heat-3'))
    assert.ok(byKey.get('2026-09-08')?.className.includes('lc-heat-1'), 'a crumb is never invisible')
    assert.ok(byKey.get('2026-09-06')?.className.includes('lc-heat-0'), 'a sessions-only day is active at the zero token level')
    assert.equal(byKey.get('2026-09-16')?.getAttribute('aria-label'), '2026-09-16\n2 active sessions\n100 tokens')
    assert.equal(byKey.get('2026-09-10')?.getAttribute('aria-label'), '2026-09-10\n1 active sessions\n30 tokens')
    const spans = queryAll(m.container, 'span.lc-heat-cell')
    assert.ok(spans.length > 0)
    assert.ok(spans.some(s => s.className.includes('lc-heat-future')), 'future placeholders present')
    const wds = queryAll(m.container, '.lc-heat-wd')
    assert.deepEqual(wds.map(w => w.textContent), ['', 'Mon', '', 'Wed', '', 'Fri', ''])
    await m.unmount()
  })

  test('a requests-only day is no activity: it renders as an inert tip cell, never a button', async () => {
    const days = {
      '2026-09-16': { tokens: 10, sessions: 1, cost: null },
      '2026-09-15': { tokens: 0, sessions: 0, cost: null },
      '2026-09-14': { tokens: 0, sessions: 2, cost: null },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    const buttons = queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    assert.deepEqual(buttons.map(b => b.getAttribute('aria-label')?.split('\n')[0]), ['2026-09-14', '2026-09-16'])
    const inert = queryAll(m.container, 'span.lc-heat-cell').find(el => el.getAttribute('data-lc-tip') === '2026-09-15')
    assert.ok(inert !== undefined, 'the requests-only day keeps its bare-date tip but no button')
    await m.unmount()
  })

  test('month labels mark the columns where a month begins', async () => {
    const days = { '2026-09-16': { tokens: 10, sessions: 1, cost: null } }
    const m = await mount(h(Heatmap, { days, today: TODAY }))
    assert.deepEqual(queryAll(m.container, '.lc-heat-mon').map(s => s.textContent), ['Aug', 'Sep'])
    await m.unmount()
    const m2 = await mount(h(Heatmap, { days, today: TODAY, weeks: 2 }))
    assert.deepEqual(queryAll(m2.container, '.lc-heat-mon').map(s => s.textContent), ['Sep'])
    await m2.unmount()
    const m3 = await mount(h(Heatmap, { days: { '2026-02-03': { tokens: 1, sessions: 1, cost: null } }, today: '2026-02-03', weeks: 2 }))
    assert.deepEqual(queryAll(m3.container, '.lc-heat-mon').map(s => s.textContent), ['Jan', 'Feb'])
    await m3.unmount()
  })

  test('the sessions metric depths on each day’s distinct sessions, independently of tokens', async () => {
    const days = {
      '2026-09-16': { tokens: 100, sessions: 2, cost: null },
      '2026-09-09': { tokens: 75, sessions: 3, cost: null },
    }
    const m = await mount(h(Heatmap, { days, today: TODAY, weeks: 2, metric: 'sessions' }))
    const byKey = new Map(queryAll<HTMLButtonElement>(m.container, 'button.lc-heat-cell').map(b => [b.getAttribute('aria-label')?.split('\n')[0], b]))
    assert.ok(byKey.get('2026-09-16')?.className.includes('lc-heat-3'), 'two of the three-session peak draws level 3')
    assert.ok(byKey.get('2026-09-09')?.className.includes('lc-heat-4'), 'the sessions peak depths level 4 that its smaller token share never would')
    await m.unmount()
  })

  test('cells carry the page hover tip in data attributes (date, sessions, tokens; an empty day the bare date)', async () => {
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, sessions: 3, cost: null } },
      today: TODAY,
      weeks: 2,
    }))
    assert.equal(
      query<HTMLButtonElement>(m.container, 'button.lc-heat-cell').getAttribute('data-lc-tip'),
      '2026-09-16\n3 active sessions\n10 tokens',
    )
    assert.match(query(m.container, 'span.lc-heat-0').getAttribute('data-lc-tip') ?? '', /^\d{4}-\d{2}-\d{2}$/)
    await m.unmount()
  })

  test('clicking a data day pins it; clicking again releases; without a relay the cells stay inert', async () => {
    const picked: (string | null)[] = []
    const record = (day: string | null): void => { picked.push(day) }
    const m = await mount(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, sessions: 1, cost: null } },
      today: TODAY,
      weeks: 2,
      selected: null,
      onSelect: record,
    }))
    const cell = query<HTMLButtonElement>(m.container, 'button.lc-heat-cell')
    await click(cell)
    assert.deepEqual(picked, ['2026-09-16'])
    await m.update(h(Heatmap, {
      days: { '2026-09-16': { tokens: 10, sessions: 1, cost: null } },
      today: TODAY,
      weeks: 2,
      selected: '2026-09-16',
      onSelect: record,
    }))
    assert.ok(query(m.container, 'button.lc-heat-cell').className.includes('lc-heat-on'))
    assert.equal(query(m.container, 'button.lc-heat-cell').getAttribute('aria-pressed'), 'true')
    await click(query<HTMLButtonElement>(m.container, 'button.lc-heat-cell'))
    assert.deepEqual(picked, ['2026-09-16', null], 'the second click releases the pin')
    await m.unmount()

    const inert = await mount(h(Heatmap, { days: { '2026-09-16': { tokens: 10, sessions: 1, cost: null } }, today: TODAY, weeks: 2 }))
    const inertCell = query<HTMLButtonElement>(inert.container, 'button.lc-heat-cell')
    await click(inertCell)
    assert.ok(!inertCell.className.includes('lc-heat-on'))
    await inert.unmount()
  })

  test('todayKey keys the render day (the panel’s runtime call)', () => {
    assert.match(todayKey(), /^\d{4}-\d{2}-\d{2}$/)
  })
})
