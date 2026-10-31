import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeOverviewSkills, skillColorOf } from '../../../src/client/components/overviewSkills'
import { setSkillCopier } from '../../../src/client/skills'
import type { SkillInfo } from '../../../src/shared/types'
import { click, flush, hover, makeKit, mount, query, queryAll, text, unhover } from '../helpers/kit'
import { statOf } from '../overview.fixtures'

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
