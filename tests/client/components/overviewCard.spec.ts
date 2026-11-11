import { createElement as h, act } from 'react'
import assert from 'node:assert/strict'
import { describe, test, afterEach, vi } from 'vitest'
import { makeOverviewCard, type OverviewCardRow } from '../../../src/client/components/overviewCard'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text, flush, hover, unhover, tipRows } from '../helpers/kit'
import { makeOverviewSkills, skillColorOf } from '../../../src/client/components/overviewSkills'
import { setSkillCopier } from '../../../src/client/skills'
import { type SkillInfo } from '../../../src/shared/types'
import { statOf } from '../overview.fixtures'
import { makeOverviewUsage, usageWindowOf } from '../../../src/client/components/overviewUsage'
import { type DayTotals, type TokenPartTotal } from '../../../src/client/overview'
import { makeOverviewTally } from '../../../src/client/components/overviewTally'
import { nameColorOf } from '../../../src/client/nameColor'
import { Donut } from '../../../src/client/components/donut'
import { makeOverviewTokens } from '../../../src/client/components/overviewTokens'
import { makeCurrentComposition } from '../../../src/client/components/currentComposition'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import { type Headline } from '../../../src/client/headline'

describe('overviewCard', () => {

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
})

describe('overviewSkills', () => {

const Skills = makeOverviewSkills(makeKit('en'))

const NOW = Date.UTC(2026, 8, 20, 12)

const CATALOG: ReadonlyMap<string, SkillInfo> = new Map([
  ['tdd', { name: 'tdd', description: 'Test-driven development.\nWrite the test first.', path: '/home/u/.agents/skills/tdd/SKILL.md', source: 'user-agents' }],
  ['grill-me', { name: 'grill-me', description: '', source: 'project-dsh' }],
  ['custom-skill', { name: 'custom-skill', description: ` ${'x'.repeat(200)} `, path: '/opt/skills/custom.md', source: 'team-registry' }],
])

function bubble(): HTMLElement | null {
  return document.querySelector('#lc-skilltip-bubble')
}

function mockRect(row: Element, rect: { left: number; top: number; width: number; bottom: number }): void {
  Object.defineProperty(row, 'getBoundingClientRect', { configurable: true, value: () => ({ ...rect, right: rect.left + rect.width, height: 20 }) })
}

afterEach(() => {
  setSkillCopier(null)
})

describe('skillColorOf', () => {
  test('the palette pick is stable and palette-bound', () => {
    assert.equal(skillColorOf('tdd'), skillColorOf('tdd'))
    for (const name of ['tdd', 'grill-me', 'ponytail', 'ask-matt', 'a']) {
      assert.ok(skillColorOf(name).startsWith('var(--color-'), name)
    }
  })
})

describe('OverviewSkills', () => {
  test('each row shows the dot, the name, the tally, and its share bar', async () => {
    const m = await mount(h(Skills, {
      stats: [statOf('tdd', 12, NOW - 3 * 3_600_000), statOf('grill-me', 3, NOW - 40_000)],
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.equal(rows.length, 2)
    assert.equal(text(query(rows[0], '.lc-ov-tally-name')), 'tdd')
    assert.equal(text(query(rows[0], '.lc-ov-tally-count')), '×12')
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-dot').getAttribute('style')?.includes(skillColorOf('tdd')))
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    assert.ok(query<HTMLElement>(rows[1], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(25% - 3px)'), 'the share of the heaviest row')
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('2 skills · 15 loads'))
    await m.unmount()

    const day = await mount(h(Skills, { stats: [statOf('tdd', 1, NOW)], day: '2026-09-19' }))
    assert.ok(text(query(day.container, '.lc-card-sub')).includes('2026-09-19'))
    await day.unmount()
  })

  test('the share bar scales to the heaviest row wherever the ordering puts it — never past the content edge', async () => {
    const m = await mount(h(Skills, { stats: [statOf('light', 1, NOW), statOf('heavy', 2, NOW)] }))
    const rows = queryAll<HTMLElement>(m.container, 'button.lc-ov-tally')
    assert.ok(query(rows[0], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(50% - 6px)'))
    assert.ok(query(rows[1], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    await m.unmount()
    const zero = await mount(h(Skills, { stats: [statOf('zero', 0, NOW)] }))
    assert.ok(query<HTMLElement>(zero.container, '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(0% - 0px)'))
    await zero.unmount()
  })

  test('a row click pins and releases through onSelect; the pinned row wraps with its detail into one unit', async () => {
    const picks: (string | null)[] = []
    const m = await mount(h(Skills, {
      stats: [statOf('tdd', 2, NOW), statOf('grill-me', 1, NOW)],
      selected: 'tdd',
      onSelect: (name) => { picks.push(name) },
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.ok((rows[0].parentElement as HTMLElement).className.includes('lc-ov-skill-unit'), 'the pinned row’s wrapper carries the ring')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true')
    assert.equal(rows[1].getAttribute('aria-pressed'), 'false')
    await click(rows[1])
    assert.deepEqual(picks, ['grill-me'])
    await click(rows[0])
    assert.deepEqual(picks, ['grill-me', null], 'clicking the pinned row releases the pin')
    await m.unmount()

    const inert = await mount(h(Skills, { stats: [statOf('tdd', 2, NOW)] }))
    await click(query(inert.container, 'button.lc-ov-tally'))
    await inert.unmount()
  })

  test('the hover card lays out the head, the description, the path, and the stats/action footer', async () => {
    const m = await mount(h(Skills, { stats: [statOf('tdd', 2, NOW - 3_600_000)], catalog: CATALOG }))
    assert.equal(bubble(), null, 'no card before a hover')
    const row = query(m.container, 'button.lc-ov-tally')
    await hover(row)
    const tip = bubble()
    assert.ok(tip, 'the card portals to <body>')
    assert.equal(row.getAttribute('aria-describedby'), 'lc-skilltip-bubble')
    assert.equal(text(query(tip!, '.lc-skilld-name')), 'tdd')
    assert.equal(text(query(tip!, '.lc-skilld-chip')), 'User')
    assert.equal(text(query(tip!, '.lc-skilld-desc')), 'Test-driven development. Write the test first.', 'the description flattens to one flow')
    assert.equal(text(query(tip!, '.lc-skilld-path')), '/home/u/.agents/skills/tdd/SKILL.md')
    assert.ok(/2 loads · 1 sessions · \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text(query(tip!, '.lc-skilld-foot'))))
    assert.equal(text(query(tip!, '.lc-skilld-hint')), 'Click to filter the sessions that loaded it')
    await unhover(row)
    assert.equal(bubble(), null, 'leaving the row retracts the card')
    assert.equal(row.getAttribute('aria-describedby'), null)
    await m.unmount()

    const bare = await mount(h(Skills, { stats: [statOf('ghost', 3, NOW)] }))
    await hover(query(bare.container, 'button.lc-ov-tally'))
    const bareTip = bubble()
    assert.ok(bareTip)
    assert.equal(text(query(bareTip!, '.lc-skilld-name')), 'ghost')
    assert.equal(queryAll(bareTip!, '.lc-skilld-chip').length, 0, 'no origin without a catalog entry')
    assert.equal(queryAll(bareTip!, '.lc-skilld-desc').length, 0)
    assert.equal(queryAll(bareTip!, '.lc-skilld-path').length, 0)
    assert.ok(text(query(bareTip!, '.lc-skilld-foot')).includes('3 loads'))
    await bare.unmount()
  })

  test('the origin buckets localize; the long description caps; the pinned row’s hint flips to release', async () => {
    const m = await mount(h(Skills, {
      stats: ['a-project', 'b-user', 'c-bundled', 'd-bare'].map(name => statOf(name, 1, NOW)),
      catalog: new Map<string, SkillInfo>([
        ['a-project', { name: 'a-project', description: '', source: 'project-agents' }],
        ['b-user', { name: 'b-user', description: '', source: 'user-dsh' }],
        ['c-bundled', { name: 'c-bundled', description: '', source: 'bundled' }],
        ['d-bare', { name: 'd-bare', description: '' }],
      ]),
      selected: 'a-project',
    }))
    const rows = queryAll(m.container, 'button.lc-ov-tally')
    const chipOf = async (row: Element): Promise<string> => {
      await hover(row)
      const chip = bubble()?.querySelector('.lc-skilld-chip')
      return chip === null || chip === undefined ? '' : (chip.textContent ?? '')
    }
    assert.equal(await chipOf(rows[0]), 'Project')
    assert.equal(text(query(bubble()!, '.lc-skilld-hint')), 'Click again to release the filter', 'the pinned row’s hint')
    assert.equal(await chipOf(rows[1]), 'User')
    assert.equal(await chipOf(rows[2]), 'Built-in')
    assert.equal(await chipOf(rows[3]), '', 'a source-less entry carries no chip')
    await unhover(rows[3])
    const m2 = await mount(h(Skills, { stats: [statOf('custom-skill', 1, NOW)], catalog: CATALOG }))
    await hover(query(m2.container, 'button.lc-ov-tally'))
    assert.equal(text(query(bubble()!, '.lc-skilld-chip')), 'team-registry')
    const desc = text(query(bubble()!, '.lc-skilld-desc'))
    assert.equal(desc.length, 161, 'the 160 cap plus the ellipsis')
    assert.ok(desc.endsWith('…'))
    await m2.unmount()
    await m.unmount()
  })

  test('the card measures against the row, retracts on scroll/resize/blur, and drops content on a scope change', async () => {
    const m = await mount(h(Skills, { stats: [statOf('tdd', 1, NOW)] }))
    const row = query(m.container, 'button.lc-ov-tally')
    await hover(row)
    let style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 8px'), style)
    assert.ok(style.includes('top: 6px'), style)
    await unhover(row)
    mockRect(row, { left: 500, top: 200, width: 100, bottom: 220 })
    await hover(row)
    style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 550px'), style)
    assert.ok(style.includes('top: 194px'), style)
    await unhover(row)
    mockRect(row, { left: 2000, top: 200, width: 100, bottom: 220 })
    await hover(row)
    style = bubble()?.getAttribute('style') ?? ''
    assert.ok(style.includes('left: 1016px'), style)

    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    assert.equal(bubble(), null, 'any scroll retracts')
    await hover(row)
    assert.ok(bubble())
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    assert.equal(bubble(), null, 'a resize retracts')
    await act(async () => { row.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.ok(bubble(), 'keyboard focus raises the card')
    await act(async () => { row.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.equal(bubble(), null, 'blur retracts')

    await hover(row)
    assert.ok(bubble())
    await m.update(h(Skills, { stats: [statOf('other', 1, NOW)] }))
    assert.equal(bubble(), null, 'the hovered skill left the scope — nothing to say')
    await m.unmount()
  })

  test('the pinned skill’s detail expands inline under its row: description first, then the fact grid with the copyable path', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      setSkillCopier(async (path) => { writes.push(path) })
      const m = await mount(h(Skills, {
        stats: [statOf('tdd', 2, NOW, 2), statOf('grill-me', 1, NOW)],
        selected: 'tdd',
        catalog: CATALOG,
      }))
      const row = query<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
      const detail = row.nextElementSibling as HTMLElement
      assert.ok(detail.classList.contains('lc-ov-skill-detail'), 'the detail hugs the pinned row, not the card bottom')
      assert.equal(queryAll(detail, '.lc-skilld-head').length, 0, 'the inline seat needs no head — the row above names the skill')
      assert.equal(text(query(detail, '.lc-skilld-desc')), 'Test-driven development. Write the test first.')
      assert.ok(detail.querySelector('.lc-skilld-desc + .lc-skilld-grid') !== null, 'the description leads, the grid follows')
      const grid = query(detail, '.lc-skilld-grid')
      assert.deepEqual(queryAll(grid, '.lc-skilld-k').map(k => text(k)), ['Source', 'Usage', 'Last', 'Path'])
      const values = queryAll(grid, '.lc-skilld-v')
      assert.equal(text(values[0]), 'User')
      assert.equal(text(values[1]), '2 loads · 2 sessions', 'the in-scope pin’s stats')
      assert.ok(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(text(values[2])), 'the exact last load')
      const pathBtn = query<HTMLButtonElement>(grid, 'button.lc-skilld-pathv')
      assert.equal(text(query(pathBtn, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md')
      assert.equal(pathBtn.getAttribute('data-lc-tip'), 'Click to copy the path')
      await click(pathBtn)
      await flush()
      assert.deepEqual(writes, ['/home/u/.agents/skills/tdd/SKILL.md'])
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied', 'the flash claims the landed copy')
      await click(query(m.container, 'button.lc-skilld-pathv'))
      await flush()
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied')
      await act(async () => { vi.advanceTimersByTime(1600) })
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md', 'the dwell passes, the path returns')
      await m.unmount()

      setSkillCopier(async () => { throw new Error('denied') })
      const failed = await mount(h(Skills, {
        stats: [statOf('tdd', 2, NOW)],
        selected: 'tdd',
        catalog: CATALOG,
      }))
      await click(query(failed.container, 'button.lc-skilld-pathv'))
      await flush()
      assert.equal(text(query(failed.container, '.lc-skilld-pathv-text')), '/home/u/.agents/skills/tdd/SKILL.md')
      await failed.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('an out-of-scope pin falls back to a detached block at the bottom, head included; moving the pin resets the flash', async () => {
    vi.useFakeTimers()
    try {
      setSkillCopier(async () => {})
      const m = await mount(h(Skills, { stats: [], selected: 'tdd', catalog: CATALOG }))
      assert.ok(text(m.container).includes('No skill loads in this range'), 'the scope stays empty')
      const detail = query(m.container, '.lc-ov-skill-detail')
      assert.equal(queryAll(m.container, 'button.lc-ov-tally').length, 0, 'no row to hug')
      assert.equal(text(query(detail, '.lc-skilld-head .lc-skilld-name')), 'tdd', 'the detached seat carries the head')
      assert.deepEqual(queryAll(detail, '.lc-skilld-k').map(k => text(k)), ['Source', 'Path'], 'no usage rows for an out-of-scope pin')
      await click(query(m.container, 'button.lc-skilld-pathv'))
      await flush()
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), 'Copied')
      await m.update(h(Skills, { stats: [], selected: 'custom-skill', catalog: CATALOG }))
      assert.equal(text(query(m.container, '.lc-skilld-grid .lc-skilld-v')), 'team-registry', 'the unknown source displays raw in the grid')
      assert.equal(text(query(m.container, '.lc-skilld-pathv-text')), '/opt/skills/custom.md')
      await m.update(h(Skills, { stats: [], selected: null, catalog: CATALOG }))
      assert.equal(queryAll(m.container, '.lc-ov-skill-detail').length, 0)
      await m.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  test('a catalog-less pin with in-scope tallies still shows its usage rows; a ghost pin renders nothing', async () => {
    const noCatalog = await mount(h(Skills, { stats: [statOf('tdd', 4, NOW)], selected: 'tdd', catalog: null }))
    const detail = query(noCatalog.container, '.lc-ov-skill-detail')
    assert.equal(queryAll(detail, '.lc-skilld-head').length, 0)
    assert.deepEqual(queryAll(detail, '.lc-skilld-k').map(k => text(k)), ['Usage', 'Last'], 'no source or path without the catalog')
    assert.ok(text(queryAll(detail, '.lc-skilld-v')[0]).includes('4 loads'))
    assert.equal(queryAll(detail, '.lc-skilld-pathv').length, 0)
    await noCatalog.unmount()
    const ghost = await mount(h(Skills, { stats: [statOf('tdd', 1, NOW)], selected: 'ghost', catalog: CATALOG }))
    assert.equal(queryAll(ghost.container, '.lc-ov-skill-detail').length, 0)
    await ghost.unmount()
  })

  test('a hostile instant degrades the stats line, never the row', async () => {
    const m = await mount(h(Skills, { stats: [statOf('tdd', 1, Number.NaN)] }))
    assert.equal(queryAll(m.container, 'button.lc-ov-tally').length, 1)
    await hover(query(m.container, 'button.lc-ov-tally'))
    const foot = text(query(bubble()!, '.lc-skilld-foot'))
    assert.ok(foot.includes('1 loads'), foot)
    assert.ok(!foot.includes('null') && !foot.includes('NaN'), foot)
    await m.unmount()
  })

  test('a pin beyond the row cap falls back to the detached block; the overflow line counts the capped rows', async () => {
    const stats = Array.from({ length: 25 }, (_, i) => statOf(`skill-${i}`, i + 1, NOW - i * 1000))
    stats.push(statOf('grill-me', 1, NOW))
    const m = await mount(h(Skills, { stats, selected: 'grill-me' }))
    assert.equal(queryAll(m.container, 'button.lc-ov-tally').length, 20)
    const detail = query(m.container, '.lc-ov-skill-detail')
    assert.equal(detail.closest('.lc-ov-skill-unit'), null, 'no inline seat without the pinned row')
    assert.equal(queryAll(detail, '.lc-skilld-head').length, 1, 'the detached seat carries the head')
    assert.ok(text(m.container).includes('6 more skills'), 'the overflow counts the capped rows')
    await m.unmount()
  })
})
})

describe('overviewUsage', () => {

const kit = makeKit()
const OverviewUsage = makeOverviewUsage(kit)

const TODAY = '2026-09-16'

function day(over: Partial<DayTotals> = {}): DayTotals {
  return { tokens: 0, sessions: 0, cost: null, ...over }
}

describe('usageWindowOf', () => {
  test('walks today and the six days before it, oldest first; a corrupt today key reads as an empty window', () => {
    assert.deepEqual(usageWindowOf(TODAY), [
      '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16',
    ])
    assert.deepEqual(usageWindowOf('junk'), [])
  })
})

describe('OverviewUsage', () => {
  test('an all-empty window or a corrupt today key renders the empty note, no bars', async () => {
    const cases: { days: Record<string, DayTotals>; today: string }[] = [
      { days: {}, today: TODAY },
      { days: { '2026-09-16': day({ tokens: 5 }) }, today: 'junk' },
    ]
    for (const props of cases) {
      const m = await mount(h(OverviewUsage, { currency: 'usd', ...props }))
      assert.ok(text(m.container).includes('No usage in the last 7 days'))
      assert.equal(queryAll(m.container, '.lc-ov-usage-bar').length, 0)
      await m.unmount()
    }
  })

  test('seven columns draw, out-of-window days are ignored, and the key names both series', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1200, cost: 0.5 }),
        '2026-09-10': day({ tokens: 300 }),
        '2026-09-09': day({ tokens: 999_999 }),
        '2026-09-01': day({ tokens: 50_000_000 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    const days = queryAll(m.container, '.lc-ov-usage-day').map(el => el.textContent)
    assert.deepEqual(days, ['09-10', '09-11', '09-12', '09-13', '09-14', '09-15', '09-16'])
    assert.ok(text(m.container).includes('Tokens'))
    assert.ok(text(m.container).includes('Cost'))
    await m.unmount()
  })

  test('bar heights scale on each series’ OWN window maximum, with a floor for tiny days', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 100, cost: 0.5 }),
        '2026-09-14': day({ tokens: 1, cost: 0.01 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    const heightOf = (col: number, cls: string): string =>
      (queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.' + cls) as HTMLElement).style.height
    assert.equal(heightOf(6, 'lc-ov-usage-tokens'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-tokens'), '10%')
    assert.equal(heightOf(4, 'lc-ov-usage-tokens'), '4%')
    assert.equal(heightOf(6, 'lc-ov-usage-cost'), '100%')
    assert.equal(heightOf(5, 'lc-ov-usage-cost'), '50%')
    assert.equal(heightOf(4, 'lc-ov-usage-cost'), '4%')
    await m.unmount()
  })

  test('the frame: gridlines share the bars’ box, with a solid baseline, and tick rails off the same maxima', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1000, cost: 1 }),
        '2026-09-15': day({ tokens: 250, cost: 0.25 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    const cols = query(m.container, '.lc-ov-usage-cols')
    assert.equal(queryAll(cols, '.lc-ov-usage-line').length, 5)
    assert.equal(queryAll(m.container, '.lc-ov-usage-grid > .lc-ov-usage-line').length, 0)
    const baseline = query(cols, '.lc-ov-usage-line-0') as HTMLElement
    assert.equal(baseline.style.bottom, '0%')
    const left = queryAll(m.container, '.lc-ov-usage-rail-l .lc-ov-usage-tick').map(el => el.textContent)
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(left, ['0', '250', '500', '750', '1.0k'])
    assert.deepEqual(right, ['0', '$0.25', '$0.50', '$0.75', '$1.00'])
    await m.unmount()
  })

  test('an unpriced window reads the cost rail as dashes; the bars stay', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 500, cost: null }) },
      currency: 'usd',
      today: TODAY,
    }))
    const right = queryAll(m.container, '.lc-ov-usage-rail-r .lc-ov-usage-tick').map(el => el.textContent)
    assert.deepEqual(right, ['—', '—', '—', '—', '—'])
    const col = queryAll(m.container, '.lc-ov-usage-col')[6]
    assert.equal((col.querySelector('.lc-ov-usage-tokens') as HTMLElement).style.height, '100%')
    assert.equal((col.querySelector('.lc-ov-usage-cost') as HTMLElement).style.height, '0%')
    await m.unmount()
  })

  test('a priced-but-free day draws no bars yet keeps the column (not the empty note)', async () => {
    const m = await mount(h(OverviewUsage, {
      days: { '2026-09-16': day({ tokens: 0, cost: 0 }) },
      currency: 'usd',
      today: TODAY,
    }))
    assert.equal(queryAll(m.container, '.lc-ov-usage-col').length, 7)
    assert.equal(text(m.container).includes('No usage in the last 7 days'), false)
    await m.unmount()
  })

  test('each tokens bar carries its own day’s figure, and only where there are tokens', async () => {
    const m = await mount(h(OverviewUsage, {
      days: {
        '2026-09-16': day({ tokens: 1_200_000 }),
        '2026-09-15': day({ tokens: 5000 }),
      },
      currency: 'usd',
      today: TODAY,
    }))
    const labelIn = (col: number): string | null =>
      queryAll(m.container, '.lc-ov-usage-col')[col].querySelector('.lc-ov-usage-value')?.textContent ?? null
    assert.equal(labelIn(6), '1.2M')
    assert.equal(labelIn(5), '5.0k')
    assert.equal(labelIn(4), null)
    assert.equal(queryAll(m.container, '.lc-ov-usage-value').length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-usage-bar.lc-ov-usage-tokens .lc-ov-usage-value').length, 2)
    assert.equal(queryAll(m.container, '.lc-ov-usage-cost .lc-ov-usage-value').length, 0)
    await m.unmount()
  })
})
})

describe('overviewTally', () => {

const Tally = makeOverviewTally(makeKit('en'))

const NOW = Date.UTC(2026, 8, 20, 12)

describe('OverviewTally', () => {
  test('a tool card renders the tally rows with the shared row parts and the tool summary', async () => {
    const m = await mount(h(Tally, {
      kind: 'tool',
      stats: [statOf('read', 8, NOW - 3600_000, 3), statOf('bash', 2, NOW - 40_000)],
    }))
    assert.equal(text(query(m.container, '.lc-card-title-text')), 'Tool Calls')
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('2 tools · 10 calls'))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.equal(rows.length, 2)
    assert.equal(text(query(rows[0], '.lc-ov-tally-name')), 'read')
    assert.equal(text(query(rows[0], '.lc-ov-tally-count')), '×8')
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-dot').getAttribute('style')?.includes(nameColorOf('read')))
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    assert.ok(query<HTMLElement>(rows[1], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(25% - 3px)'))
    assert.equal(rows[0].title, '8 calls · 3 sessions')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'false')
    await m.unmount()
  })

  test('a command card speaks in program runs and sessions', async () => {
    const m = await mount(h(Tally, {
      kind: 'command',
      stats: [statOf('git', 4, NOW - 5000), statOf('pnpm', 1, NOW - 10_000)],
    }))
    assert.equal(text(query(m.container, '.lc-card-title-text')), 'Command Executions')
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('2 programs · 5 runs'))
    assert.equal(query<HTMLElement>(m.container, 'button.lc-ov-tally').title, '4 runs · 1 sessions')
    await m.unmount()
  })

  test('a row click relays the pin and the pinned row releases it', async () => {
    const picks: (string | null)[] = []
    const m = await mount(h(Tally, {
      kind: 'tool',
      stats: [statOf('read', 3, NOW), statOf('grep', 1, NOW)],
      selected: 'read',
      onSelect: (name) => { picks.push(name) },
    }))
    const rows = queryAll<HTMLButtonElement>(m.container, 'button.lc-ov-tally')
    assert.equal(rows[0].getAttribute('aria-pressed'), 'true')
    await click(rows[1])
    assert.deepEqual(picks, ['grep'])
    await click(rows[0])
    assert.deepEqual(picks, ['grep', null])
    await m.unmount()
  })

  test('an empty scope keeps the summary line and the body note, and the day sub rides the title', async () => {
    const empty = await mount(h(Tally, { kind: 'command', stats: [], day: '2026-09-19' }))
    assert.ok(text(query(empty.container, '.lc-ov-tally-note')).includes('0 programs · 0 runs'))
    assert.ok(text(query(empty.container, '.lc-card-sub')).includes('2026-09-19'))
    assert.ok(text(empty.container).includes('No commands in this range'))
    assert.equal(queryAll(empty.container, 'button.lc-ov-tally').length, 0)
    await empty.unmount()
  })

  test('the row list caps at 24 with a more note; the summary still counts every tally', async () => {
    const stats = Array.from({ length: 30 }, (_, i) => statOf(`tool-${i}`, 30 - i, NOW - i * 1000))
    const m = await mount(h(Tally, { kind: 'tool', stats }))
    assert.equal(queryAll(m.container, 'button.lc-ov-tally').length, 24)
    assert.ok(text(query(m.container, '.lc-ov-tally-more')).includes('6 more tools'))
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('30 tools · 465 calls'))
    await m.unmount()

    const commands = await mount(h(Tally, { kind: 'command', stats }))
    assert.ok(text(query(commands.container, '.lc-ov-tally-more')).includes('6 more programs'))
    await commands.unmount()
  })
})
})

describe('overviewTokens', () => {

const kit = makeKit()
const Tokens = makeOverviewTokens(kit, Donut)

const PARTS: TokenPartTotal[] = [
  { key: 'system', color: 'var(--color-indigo-500)', value: 42 },
  { key: 'tools', color: 'var(--color-amber-500)', value: 16 },
  { key: 'user', color: 'var(--color-green-500)', value: 10 },
  { key: 'inject', color: 'var(--color-purple-500)', value: 3 },
  { key: 'skill', color: 'var(--color-orange-500)', value: 3 },
  { key: 'toolCalls', color: 'var(--color-teal-500)', value: 96 },
  { key: 'thinking', color: 'var(--color-violet-500)', value: 20 },
  { key: 'answers', color: 'var(--color-pink-500)', value: 20 },
]
const TOKENS = { parts: PARTS, total: 210 }

function rowOf(container: HTMLElement, i: number): { pct: string; label: string; count: string } {
  const row = queryAll(container, '.lc-sl-row')[i]
  return {
    pct: row.querySelector('.lc-sl-pct')?.textContent ?? '',
    label: row.querySelector('.lc-sl-label')?.textContent ?? '',
    count: row.querySelector('.lc-sl-sub')?.textContent ?? '',
  }
}

describe('OverviewTokens', () => {
  test('the donut center is the billed total; rows carry the Context tab\'s categories and ≈ estimates', async () => {
    const m = await mount(h(Tokens, { tokens: TOKENS }))
    assert.equal(query(m.container, '.lc-donut-center b').textContent, '210')
    assert.equal(query(m.container, '.lc-donut-center span').textContent, 'Total')
    const expected = [
      { pct: '20.0%', label: 'System Prompt', count: '≈42' },
      { pct: '7.6%', label: 'Tool Schemas', count: '≈16' },
      { pct: '4.8%', label: 'User Messages', count: '≈10' },
      { pct: '1.4%', label: 'Injected Context', count: '≈3' },
      { pct: '1.4%', label: 'Skill Injections', count: '≈3' },
      { pct: '45.7%', label: 'Tool Calls', count: '≈96' },
      { pct: '9.5%', label: 'Reasoning', count: '≈20' },
      { pct: '9.5%', label: 'Answers', count: '≈20' },
    ]
    expected.forEach((row, i) => assert.deepEqual(rowOf(m.container, i), row))
    await m.unmount()

    const sparse = {
      parts: [
        { key: 'system', color: 'var(--color-indigo-500)', value: 300 },
        { key: 'tools', color: 'var(--color-amber-500)', value: 0 },
        { key: 'user', color: 'var(--color-green-500)', value: 90 },
        { key: 'thinking', color: 'var(--color-violet-500)', value: 50 },
      ],
      total: 440,
    }
    const sparseMount = await mount(h(Tokens, { tokens: sparse }))
    assert.equal(query(sparseMount.container, '.lc-donut-center b').textContent, '440')
    assert.equal(queryAll(sparseMount.container, '.lc-sl-row').length, 3)
    assert.deepEqual(rowOf(sparseMount.container, 0), { pct: '68.2%', label: 'System Prompt', count: '≈300' })
    assert.deepEqual(rowOf(sparseMount.container, 1), { pct: '20.5%', label: 'User Messages', count: '≈90' })
    assert.deepEqual(rowOf(sparseMount.container, 2), { pct: '11.4%', label: 'Reasoning', count: '≈50' })
    await sparseMount.unmount()
  })

  test('nothing billed in the range renders the empty note, no ring', async () => {
    for (const tokens of [null, { parts: [{ key: 'system', color: 'x', value: 5 }], total: 0 }]) {
      const m = await mount(h(Tokens, { tokens }))
      assert.equal(queryAll(m.container, '.lc-donut').length, 0)
      assert.ok(text(m.container).includes('No billed tokens in this range'))
      await m.unmount()
    }
  })

  test('hovering a legend row lights its donut segment and the row itself', async () => {
    const m = await mount(h(Tokens, { tokens: TOKENS }))
    const rows = queryAll(m.container, '.lc-sl-row')
    await hover(rows[1])
    assert.ok(query(m.container, '.lc-donut').className.includes('lc-donut-dim'))
    assert.ok((queryAll(m.container, '.lc-donut-seg')[1]?.getAttribute('class') ?? '').includes('lc-donut-seg-on'))
    assert.ok(rows[1].className.includes('lc-sl-row-on'))
    await unhover(rows[1])
    assert.ok(!rows[1].className.includes('lc-sl-row-on'))
    await m.unmount()
  })
})
})

describe('currentComposition', () => {

const kit = makeKit()
const CurrentComposition = makeCurrentComposition(kit, makeStackedBar(kit), makeLegend(kit))

const PARTS = [{ key: 'user', color: '#123456', value: 5000 }]

function headOf(over: Partial<Headline> = {}): Headline {
  return { tokens: 5000, pct: null, parts: PARTS, ...over }
}

describe('CurrentComposition header', () => {
  test('windowed head: tokens/window figure, used percentage, reserve masks, subtitle', async () => {
    const m = await mount(h(CurrentComposition, {
      head: headOf({ window: 10000, pct: 50.4, reserve: { threshold: 8000, headroom: 1000, output: 1000 } }),
      subtitle: 'deepseek-v4-flash',
    }))
    assert.ok(text(m.container).includes('Current Context'))
    assert.equal(query(m.container, '.lc-card-sub').textContent, 'deepseek-v4-flash')
    const num = query(m.container, '.lc-overview-num')
    assert.ok(text(num).includes('5.0k / 10.0k tokens'))
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.4%')
    const headroom = query(m.container, '.lc-reserve-headroom')
    const output = query(m.container, '.lc-reserve-output')
    assert.equal(headroom.style.left, '80%')
    assert.equal(output.style.left, '90%')
    await hover(headroom)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['Compaction Headroom', '1.0k', 'Auto-compaction is expected to fire at 80% of the window'])
    await hover(output)
    assert.deepEqual(tipRows(query(m.container, '.lc-bar-tip')), ['LLM Output Reservation', '1.0k', 'The model\'s maximum output tokens'])
    await m.update(h(CurrentComposition, { head: headOf({ window: 10000, pct: 50 }) }))
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.0%')
    assert.ok(text(num).includes('of context used'))
    await m.unmount()
  })

  test('windowless head: estimate label, no percentage, no reserve, no subtitle', async () => {
    const m = await mount(h(CurrentComposition, { head: headOf() }))
    assert.ok(text(m.container).includes('tokens (estimated)'))
    assert.equal(queryAll(m.container, '.lc-overview-pct').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    await m.update(h(CurrentComposition, { head: headOf({ window: 0 }), subtitle: '' }))
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.ok(text(m.container).includes('tokens (estimated)'))
    await m.unmount()
  })
})
})
