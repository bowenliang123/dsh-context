// One session card in the overview grid (src/client/components/
// overviewCard.tsx): the full-data rendering (donut, occupancy, mini
// stats), the metadata-only degradation, the markers, and the open relay.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewCard } from '../../../src/client/components/overviewCard'
import type { OverviewRow } from '../../../src/client/overview'
import type { ContextActivity, ContextTimeline } from '../../../src/shared/types'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Card = makeOverviewCard(kit)
const NOW = new Date(2026, 8, 16, 12).getTime()

function rowOf(over: Partial<OverviewRow> = {}): OverviewRow {
  return {
    id: 's1',
    title: 'refactor the parser',
    updatedAt: NOW - 3 * 3_600_000,
    running: false,
    current: false,
    timeline: null,
    activity: null,
    ...over,
  }
}

const TIMELINE = {
  current: { system: 100, tools: 50, user: 30, inject: 10, skill: 10, assistant: 200, tool: 100, total: 500 },
  contextWindow: 1000,
  requests: [{}, {}],
  counts: { turns: 9, steps: 12, injects: 1, compactions: 0, prunes: 0 },
  cost: { deepseek: { m: { peak: { uncached: 1000, cacheRead: 500, cacheWrite: 0, output: 250 } } } },
} as unknown as ContextTimeline

describe('OverviewCard', () => {
  test('a folded session renders the donut, occupancy, and the three figures', async () => {
    const m = await mount(h(Card, { row: rowOf({ timeline: TIMELINE }), costLabel: '$0.02', now: NOW, onOpen: () => {} }))
    const card = query(m.container, 'button.lc-ov-session')
    assert.ok(!card.className.includes('lc-ov-session-current'))
    assert.equal(query(m.container, '.lc-ov-session-title').textContent, 'refactor the parser')
    assert.equal(query(m.container, '.lc-ov-session-time').textContent, '3h ago')
    // The mini donut: center carries the current total and the window share.
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '500')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, '50.0%')
    // The three mini stats: turns+steps lead, then total billed, then cost.
    const labels = queryAll(m.container, '.lc-ov-mini-label').map(el => el.textContent)
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.deepEqual(labels, ['Turns', 'Total', 'Cost'])
    assert.deepEqual(values, ['9 turns · 12 steps', '1.8k', '$0.02'])
    await m.unmount()
  })

  test('a session without a window shows the total without a share; unbilled dashes', async () => {
    const bare = { current: TIMELINE.current, requests: [{}] } as unknown as ContextTimeline
    const m = await mount(h(Card, { row: rowOf({ timeline: bare }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '500')
    assert.equal(queryAll(m.container, '.lc-donut-center span').length, 0, 'no occupancy without the window')
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.deepEqual(values, ['1', '—', '—'], 'a counts-less head names the bare turns; no cost buckets')
    await m.unmount()
  })

  test('the created line shows the first active day; absent without a ledger', async () => {
    const ledger = { days: { '2026-09-16': { tokens: 5, requests: 1 }, '2026-09-10': { tokens: 1, requests: 1 } } } as ContextActivity
    const withLedger = await mount(h(Card, { row: rowOf({ activity: ledger }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(withLedger.container, '.lc-ov-session-time').textContent, '3h ago')
    assert.equal(query(withLedger.container, '.lc-ov-session-created').textContent, '2026-09-10', 'the earliest day, not the latest')
    await withLedger.unmount()
    const noLedger = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(noLedger.container, '.lc-ov-session-created').length, 0)
    await noLedger.unmount()
  })

  test('a session with no timeline degrades to the metadata-only note', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/repo/app', title: 'plain' }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.ok(text(m.container).includes('No context data yet'))
    assert.equal(queryAll(m.container, '.lc-donut').length, 0)
    await m.unmount()
  })

  test('the breadcrumb shows group and project; the full path stays on the tip', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'workspace-one',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    const crumb = query(m.container, '.lc-ov-session-crumb')
    assert.equal(crumb.getAttribute('title'), '/Users/bw/dev/dsh-context')
    assert.equal(query(m.container, '.lc-ov-crumb-group').textContent, 'workspace-one')
    assert.equal(query(m.container, '.lc-ov-crumb-sep').textContent, '/')
    assert.equal(query(m.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await m.unmount()
  })

  test('a workspace titled like the project shows the name once (never "x / x")', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'dsh-context',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(queryAll(m.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(queryAll(m.container, '.lc-ov-crumb-sep').length, 0)
    assert.equal(query(m.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await m.unmount()
  })

  test('the breadcrumb degrades per part: project alone, group alone, neither drops the row', async () => {
    const projectOnly = await mount(h(Card, { row: rowOf({ cwd: '/repo/app' }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(projectOnly.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(queryAll(projectOnly.container, '.lc-ov-crumb-sep').length, 0)
    assert.equal(query(projectOnly.container, '.lc-ov-crumb-project').textContent, 'app')
    await projectOnly.unmount()

    const groupOnly = await mount(h(Card, { row: rowOf(), group: 'workspace-one', costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(groupOnly.container, '.lc-ov-crumb-group').textContent, 'workspace-one')
    assert.equal(queryAll(groupOnly.container, '.lc-ov-crumb-project').length, 0)
    await groupOnly.unmount()

    const bare = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-crumb').length, 0)
    await bare.unmount()
  })

  test('the crumb trails the title on the head line instead of owning a row', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'workspace-one',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.ok(query(m.container, '.lc-ov-session-head > .lc-ov-session-crumb'))
    await m.unmount()
  })

  test('a scoped grid drops the crumb segments its workspace chip already asserts', async () => {
    // The single-repo case (group == project == scope): the whole crumb goes.
    const same = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'dsh-context',
      workspaceScope: 'dsh-context',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(queryAll(same.container, '.lc-ov-session-crumb').length, 0)
    await same.unmount()

    // The scope asserts the workspace only; the project still discriminates.
    const scoped = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'workspace-one',
      workspaceScope: 'workspace-one',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(queryAll(scoped.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(queryAll(scoped.container, '.lc-ov-crumb-sep').length, 0)
    assert.equal(query(scoped.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await scoped.unmount()

    // Another chip's scope leaves the crumb alone.
    const other = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }),
      group: 'workspace-one',
      workspaceScope: 'workspace-two',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(query(other.container, '.lc-ov-crumb-group').textContent, 'workspace-one')
    assert.equal(query(other.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await other.unmount()
  })

  test('running and current markers render', async () => {
    const m = await mount(h(Card, { row: rowOf({ running: true, current: true }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.ok(query(m.container, '.lc-ov-running'))
    assert.equal(query(m.container, '.lc-ov-current').textContent, 'current')
    assert.ok(query(m.container, 'button.lc-ov-session').className.includes('lc-ov-session-current'))
    await m.unmount()
  })

  test('the last-user-message footer renders the labeled preview with the full text on the tip; absent stays absent', async () => {
    const withPreview = await mount(h(Card, {
      row: rowOf({ timeline: { ...TIMELINE, lastUser: 'fix the flaky spec' } as unknown as ContextTimeline }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    const preview = query(withPreview.container, '.lc-ov-session-preview')
    assert.equal(preview.getAttribute('title'), 'fix the flaky spec')
    assert.equal(query(withPreview.container, '.lc-ov-session-preview-label').textContent, 'Last message')
    assert.equal(query(withPreview.container, '.lc-ov-session-preview-text').textContent, 'fix the flaky spec')
    await withPreview.unmount()
    const bare = await mount(h(Card, { row: rowOf({ timeline: TIMELINE }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-preview').length, 0, 'no preview line without the fold field')
    await bare.unmount()
  })

  test('clicking relays the session id', async () => {
    const opened: string[] = []
    const m = await mount(h(Card, { row: rowOf({ id: 'xyz' }), costLabel: '—', now: NOW, onOpen: (id) => { opened.push(id) } }))
    await click(query(m.container, 'button.lc-ov-session'))
    assert.deepEqual(opened, ['xyz'])
    await m.unmount()
  })

  test('the zh locale renders translated stats', async () => {
    const ZhCard = makeOverviewCard(makeKit('zh'))
    const m = await mount(h(ZhCard, { row: rowOf({ timeline: TIMELINE }), costLabel: '¥0.13', now: NOW, onOpen: () => {} }))
    const labels = queryAll(m.container, '.lc-ov-mini-label').map(el => el.textContent)
    assert.deepEqual(labels, ['轮次', '总用量', '费用'])
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.equal(values[0], '9 轮 12 步')
    assert.equal(query(m.container, '.lc-ov-session-time').textContent, '3 小时前')
    await m.unmount()
  })
})
