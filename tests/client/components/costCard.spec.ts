import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { costGroupsOf, makeCostCard } from '../../../src/client/components/costCard'
import { BOOK_PREFS, type CostModelLine } from '../../../src/client/cost'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const CostCard = makeCostCard(makeKit())

const RATE = { hit: 0.014, miss: 0.14, write: 0, out: 0.28 }

function priced(provider: string, model: string, tokens: number, cost: number, mid = model): CostModelLine {
  return { provider, model, tokens, cost, pid: provider, mid, rate: RATE }
}

function unpriced(provider: string, model: string, tokens: number, reason: 'no-book' | 'unknown-model' | 'ambiguous' = 'unknown-model'): CostModelLine {
  return { provider, model, tokens, cost: null, pid: null, mid: null, rate: null, reason }
}

async function open(props: { lines: readonly CostModelLine[]; currency?: 'cny' | 'usd' }) {
  return mount(h(CostCard, { lines: props.lines, currency: props.currency ?? 'usd', prefs: BOOK_PREFS }))
}

describe('costGroupsOf', () => {
  test('folds lines under their provider, keeping the breakdown order between groups', () => {
    const groups = costGroupsOf([
      priced('b', 'm1', 100, 2),
      priced('a', 'm2', 50, 1),
      priced('b', 'm3', 10, 0.5),
    ])
    assert.deepEqual(groups.map(g => g.provider), ['b', 'a'], 'first-seen order, not alphabetical')
    assert.equal(groups[0].lines.length, 2)
    assert.equal(groups[0].tokens, 110, 'the group sums its lines')
    assert.equal(groups[0].cost, 2.5)
    assert.equal(groups[0].unpriced, 0)
  })

  test('a group sums only its priced lines and counts the rest', () => {
    const groups = costGroupsOf([priced('a', 'm1', 100, 2), unpriced('a', 'm2', 30), unpriced('a', 'm3', 5)])
    assert.equal(groups[0].cost, 2)
    assert.equal(groups[0].unpriced, 2)
    assert.equal(groups[0].tokens, 135)
  })

  test('a group with nothing priced carries a null total', () => {
    const groups = costGroupsOf([unpriced('a', 'm1', 10, 'no-book'), unpriced('a', 'm2', 10, 'ambiguous')])
    assert.equal(groups[0].cost, null)
    assert.equal(groups[0].unpriced, 2)
  })

  test('no lines fold to no groups', () => {
    assert.deepEqual(costGroupsOf([]), [])
  })
})

describe('CostCard', () => {
  test('renders nothing without usage', async () => {
    const m = await open({ lines: [] })
    assert.equal(m.container.innerHTML, '')
    await m.unmount()
  })

  test('one closed row per provider carrying its aggregate; the models stay folded', async () => {
    const m = await open({
      lines: [priced('azure', 'gpt-6.1', 1_500_000, 3), priced('deepseek', 'v4.1-flash', 420_000, 1.25)],
    })
    const card = query(m.container, '.lc-ov-cost-card')
    assert.ok(text(card).includes('Pricing detail'))
    assert.ok(text(card).includes('2 providers · 2 models'))
    const rows = queryAll<HTMLButtonElement>(card, '.lc-ov-cost-prow')
    assert.deepEqual(rows.map(r => r.querySelector('.lc-ov-cost-pname')?.textContent), ['azure', 'deepseek'])
    assert.ok(text(rows[0]).includes('1 model(s)'))
    assert.equal(rows[0].getAttribute('aria-expanded'), 'false')
    assert.equal(query(card, '.lc-ov-cost-ptokens').textContent, '1.5M')
    assert.equal(query(card, '.lc-ov-cost-pcost').textContent, '$3.00')
    assert.equal(queryAll(card, '.lc-ov-cost-table').length, 0, 'every group starts collapsed')
    await m.unmount()
  })

  test('the unpriced count rides the provider row only when it has any', async () => {
    const m = await open({ lines: [priced('a', 'm1', 100, 2), unpriced('a', 'm2', 30)] })
    const rows = queryAll(m.container, '.lc-ov-cost-prow')
    assert.ok(text(rows[0]).includes('1 unpriced'))
    await m.unmount()
    const clean = await open({ lines: [priced('a', 'm1', 100, 2)] })
    assert.equal(queryAll(clean.container, '.lc-ov-cost-tag').length, 0)
    await clean.unmount()
  })

  test('opening a group discloses its models: tokens, cost, unit rate, and the book face', async () => {
    const m = await open({
      lines: [priced('azure', 'gpt-6.1', 1_500_000, 3, 'gpt-6.1-sol'), unpriced('azure', 'mystery', 500)],
    })
    const row = query<HTMLButtonElement>(m.container, '.lc-ov-cost-prow')
    await click(row)
    assert.equal(row.getAttribute('aria-expanded'), 'true')
    const table = query(m.container, '.lc-ov-cost-table')
    const cells = queryAll(table, 'tbody tr').map(tr => queryAll(tr, 'td').map(td => td.textContent))
    assert.deepEqual(cells[0].slice(0, 3), ['gpt-6.1 gpt-6.1-sol', '1.5M', '$3.00'])
    // Unit rates convert into the display currency, in miss · hit · out order.
    assert.equal(cells[0][3], '$0.14 · $0.014 · $0.28')
    assert.equal(cells[0][4], 'azure · gpt-6.1-sol')
    // The unpriced line keeps the face hunt's verdict, and dashes its rate.
    assert.deepEqual(cells[1], ['mystery', '500', '—', '—', 'Model not in the price book'])
    assert.ok(queryAll(queryAll(table, 'tbody tr')[1], 'td')[4].classList.contains('lc-ov-cost-muted'))
    await m.unmount()
  })

  test('an exact face hit takes no registry annotation', async () => {
    const m = await open({ lines: [priced('a', 'm1', 10, 1)] })
    await click(query(m.container, '.lc-ov-cost-prow'))
    assert.equal(queryAll(m.container, '.lc-ov-cost-face').length, 0)
    await m.unmount()
  })

  test('a second click folds the group back', async () => {
    const m = await open({ lines: [priced('a', 'm1', 10, 1)] })
    const row = query<HTMLButtonElement>(m.container, '.lc-ov-cost-prow')
    await click(row)
    assert.equal(queryAll(m.container, '.lc-ov-cost-table').length, 1)
    await click(row)
    assert.equal(queryAll(m.container, '.lc-ov-cost-table').length, 0)
    await m.unmount()
  })

  test('groups open independently: one stays folded while its neighbour opens', async () => {
    const m = await open({ lines: [priced('a', 'm1', 10, 1), priced('b', 'm2', 20, 2)] })
    const rows = queryAll<HTMLButtonElement>(m.container, '.lc-ov-cost-prow')
    await click(rows[1])
    assert.deepEqual(rows.map(r => r.getAttribute('aria-expanded')), ['false', 'true'])
    assert.equal(queryAll(m.container, '.lc-ov-cost-table').length, 1)
    // The open group is the one carrying the second provider's model.
    assert.ok(text(query(m.container, '.lc-ov-cost-table')).includes('m2'))
    await m.unmount()
  })

  test('a group with nothing priced dashes its total but still opens', async () => {
    const m = await open({ lines: [unpriced('a', 'm1', 10, 'no-book')] })
    const row = query<HTMLButtonElement>(m.container, '.lc-ov-cost-prow')
    assert.equal(query(m.container, '.lc-ov-cost-pcost').textContent, '—')
    assert.ok(query(m.container, '.lc-ov-cost-pcost').classList.contains('lc-ov-cost-muted'))
    await click(row)
    assert.ok(text(m.container).includes('Price book not loaded'))
    await m.unmount()
  })

  test('the cny locale prices rates and totals in ¥', async () => {
    const m = await open({ lines: [priced('a', 'm1', 1_000_000, 1)], currency: 'cny' })
    // The breakdown already priced in the display currency; only the book's USD rates convert here.
    assert.equal(query(m.container, '.lc-ov-cost-pcost').textContent, '¥1.00')
    await click(query(m.container, '.lc-ov-cost-prow'))
    const cells = queryAll(m.container, 'tbody td')
    assert.equal(cells[2].textContent, '¥1.00')
    assert.ok(cells[3].textContent?.startsWith('¥0.93 · ¥0.093 · ¥1.87'), cells[3].textContent ?? '')
    await m.unmount()
  })
})
