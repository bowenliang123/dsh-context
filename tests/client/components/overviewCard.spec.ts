import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewCard, type OverviewCardRow } from '../../../src/client/components/overviewCard'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const Card = makeOverviewCard(kit)
const NOW = new Date(2026, 8, 16, 12).getTime()

function rowOf(over: Partial<OverviewCardRow> = {}): OverviewCardRow {
  return {
    id: 's1',
    title: 'refactor the parser',
    updatedAt: NOW - 3 * 3_600_000,
    running: false,
    current: false,
    archived: false,
    parts: [
      { key: 'system', value: 100 },
      { key: 'tools', value: 50 },
      { key: 'user', value: 30 },
      { key: 'inject', value: 10 },
      { key: 'skill', value: 10 },
      { key: 'assistant', value: 200 },
      { key: 'tool', value: 100 },
    ],
    total: 500,
    contextWindow: 1000,
    turns: 9,
    steps: 12,
    tokens: 1800,
    costUsd: 0.02,
    ...over,
  }
}

describe('OverviewCard', () => {
  test('the hosted page row renders the donut, occupancy, and figures; without a window it shows the total and the raw figures', async () => {
    const opened: string[] = []
    const m = await mount(h(Card, { row: rowOf(), costLabel: '$0.02', now: NOW, onOpen: id => { opened.push(id) } }))
    const card = query(m.container, 'button.lc-ov-session')
    assert.ok(!card.className.includes('lc-ov-session-current'))
    assert.equal(query(m.container, '.lc-ov-session-title').textContent, 'refactor the parser')
    assert.equal(query(m.container, '.lc-ov-session-time').textContent, '3h ago')
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '500')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, '50.0%')
    const labels = queryAll(m.container, '.lc-ov-mini-label').map(el => el.textContent)
    const values = queryAll(m.container, '.lc-ov-mini-value').map(el => el.textContent)
    assert.deepEqual(labels, ['Turns', 'Total Tokens', 'Total Est. Cost'])
    assert.deepEqual(values, ['9 turns · 12 steps', '1.8k', '$0.02'])
    await click(card)
    assert.deepEqual(opened, ['s1'], 'clicking relays the session id')
    await m.unmount()

    const windowless = await mount(h(Card, {
      row: rowOf({ contextWindow: undefined, steps: undefined }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(query(windowless.container, '.lc-donut-center b').textContent, '500')
    assert.equal(queryAll(windowless.container, '.lc-donut-center span').length, 0, 'no occupancy without the window')
    assert.deepEqual(queryAll(windowless.container, '.lc-ov-mini-value').map(el => el.textContent), ['9', '1.8k', '—'])
    await windowless.unmount()
  })

  test('the donut segments follow the row parts and skip zero values with a fallback color for unknown keys', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ parts: [{ key: 'system', value: 100 }, { key: 'mystery', value: 50 }, { key: 'zero', value: 0 }], total: 150 }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    const segments = queryAll<SVGCircleElement>(m.container, 'circle.lc-donut-seg')
    assert.equal(segments.length, 2, 'only the positive values paint a segment')
    const strokes = segments.map(el => el.style.stroke)
    assert.ok(strokes.some(stroke => stroke.includes('--color-indigo-500')), 'a known category takes its token color')
    assert.ok(strokes.some(stroke => stroke.includes('--color-gray-400')), 'an unknown category falls back')
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '150')
    await m.unmount()
  })

  test('a row without drawable parts degrades to the metadata-only note', async () => {
    const m = await mount(h(Card, { row: rowOf({ parts: [], total: 0, tokens: 0 }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.ok(text(m.container).includes('No context data yet'))
    assert.equal(queryAll(m.container, '.lc-donut').length, 0)
    await m.unmount()
    const zeroed = await mount(h(Card, { row: rowOf({ parts: [{ key: 'system', value: 0 }], total: 0 }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(zeroed.container, '.lc-donut').length, 0, 'zero-width parts paint no body')
    await zeroed.unmount()
  })

  test('the created line and last-user preview render only when the row carries them', async () => {
    const withExtras = await mount(h(Card, {
      row: rowOf({ createdDay: '2026-09-10', lastUser: 'fix the flaky spec' }),
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(query(withExtras.container, '.lc-ov-session-created').textContent, '2026-09-10')
    const preview = query(withExtras.container, '.lc-ov-session-preview')
    assert.equal(preview.getAttribute('title'), 'fix the flaky spec')
    assert.equal(query(withExtras.container, '.lc-ov-session-preview-label').textContent, 'Last message')
    assert.equal(query(withExtras.container, '.lc-ov-session-preview-text').textContent, 'fix the flaky spec')
    await withExtras.unmount()
    const bare = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-created').length, 0)
    assert.equal(queryAll(bare.container, '.lc-ov-session-preview').length, 0)
    await bare.unmount()
  })

  test('running and current markers render', async () => {
    const m = await mount(h(Card, { row: rowOf({ running: true, current: true }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.ok(query(m.container, '.lc-ov-running'))
    assert.equal(query(m.container, '.lc-ov-current').textContent, 'current')
    assert.ok(query(m.container, 'button.lc-ov-session').className.includes('lc-ov-session-current'))
    const zh = await mount(h(makeOverviewCard(makeKit('zh')), { row: rowOf({ current: true }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(query(zh.container, '.lc-ov-current').textContent, '当前')
    await zh.unmount()
    let opened = 0
    const archived = await mount(h(Card, { row: rowOf({ archived: true }), costLabel: '—', now: NOW, onOpen: () => { opened += 1 } }))
    assert.ok(text(archived.container).includes(DICT_EN['ov.card.archived']))
    await click(query(archived.container, 'button.lc-ov-session'))
    assert.equal(opened, 0, 'an archived card never opens')
    await archived.unmount()
    await m.unmount()
  })

  test('the breadcrumb shows the row group and project, deduping a same-named workspace and degrading per part', async () => {
    const m = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context', group: 'workspace-one' }),
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

    const same = await mount(h(Card, {
      row: rowOf({ cwd: '/Users/bw/dev/dsh-context', group: 'dsh-context' }),
      group: 'dsh-context',
      costLabel: '—',
      now: NOW,
      onOpen: () => {},
    }))
    assert.equal(queryAll(same.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(queryAll(same.container, '.lc-ov-crumb-sep').length, 0)
    assert.equal(query(same.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await same.unmount()

    const projectOnly = await mount(h(Card, { row: rowOf({ cwd: '/Users/bw/dev/dsh-context' }), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(projectOnly.container, '.lc-ov-crumb-group').length, 0)
    assert.equal(query(projectOnly.container, '.lc-ov-crumb-project').textContent, 'dsh-context')
    await projectOnly.unmount()

    const bare = await mount(h(Card, { row: rowOf(), costLabel: '—', now: NOW, onOpen: () => {} }))
    assert.equal(queryAll(bare.container, '.lc-ov-session-crumb').length, 0)
    await bare.unmount()
  })
})
