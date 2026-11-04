import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeOverviewModels } from '../../../src/client/components/overviewModels'
import type { ModelRankStat } from '../../../src/client/modelRank'
import { makeKit, mount, query, queryAll, text } from '../helpers/kit'

const Models = makeOverviewModels(makeKit('en'))

function statOf(over: Partial<ModelRankStat> & { model: string }): ModelRankStat {
  return {
    provider: 'opencsg',
    providerName: 'OpenCSG',
    name: over.name ?? over.model,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
    sessions: 0,
    active: true,
    ...over,
  }
}

describe('OverviewModels', () => {
  test('ranks the rows with their share bars, token counts, and session tip', async () => {
    const m = await mount(h(Models, {
      stats: [
        statOf({ model: 'glm-5.1', name: 'GLM-5.1', total: 300, sessions: 3 }),
        statOf({ model: 'glm-5.2', name: 'GLM-5.2', total: 100, sessions: 1 }),
      ],
    }))
    assert.equal(text(query(m.container, '.lc-card-title-text')), 'Model Usage')
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('2 models · 400 tokens'))
    const rows = queryAll<HTMLElement>(m.container, '.lc-ov-tally')
    assert.equal(rows.length, 2)
    assert.equal(text(query(rows[0], '.lc-ov-model-rank')), '1')
    assert.equal(text(query(rows[0], '.lc-ov-model-provider')), 'OpenCSG/')
    assert.equal(text(query(rows[0], '.lc-ov-model-label')), 'OpenCSG/GLM-5.1')
    assert.equal(text(query(rows[0], '.lc-ov-tally-name')), 'GLM-5.1')
    assert.equal(text(query(rows[0], '.lc-ov-tally-count')), '300')
    assert.equal(rows[0].title, 'OpenCSG · 300 tokens · 3 sessions')
    assert.ok(query<HTMLElement>(rows[0], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(100% - 12px)'))
    assert.ok(query<HTMLElement>(rows[1], '.lc-ov-tally-bar').getAttribute('style')?.includes('calc(33% - 3.96px)'))
    assert.equal(queryAll(rows[0], '.lc-ov-model-badge').length, 0)
    await m.unmount()
  })

  test('a route outside the configured catalog keeps its total and carries the removed badge', async () => {
    const m = await mount(h(Models, {
      stats: [statOf({ model: 'glm-5.0', total: 42, sessions: 2, active: false })],
    }))
    const row = query<HTMLElement>(m.container, '.lc-ov-tally')
    assert.ok(row.className.includes('lc-ov-model-off'))
    assert.equal(text(query(row, '.lc-ov-model-badge')), 'Removed')
    assert.equal(text(query(row, '.lc-ov-tally-count')), '42')
    await m.unmount()
  })

  test('every row labels its provider, including two routes that share a model id', async () => {
    const m = await mount(h(Models, {
      stats: [
        statOf({ provider: 'opencsg', providerName: 'OpenCSG', model: 'flash', name: 'flash', total: 20 }),
        statOf({ provider: 'qodercn', providerName: 'Qoder CN', model: 'flash', name: 'flash', total: 10, active: false }),
      ],
    }))
    const rows = queryAll<HTMLElement>(m.container, '.lc-ov-tally')
    assert.deepEqual(queryAll(rows[0], '.lc-ov-model-provider').map(el => text(el)), ['OpenCSG/'])
    assert.deepEqual(queryAll(rows[1], '.lc-ov-model-provider').map(el => text(el)), ['Qoder CN/'])
    assert.equal(rows[1].title, 'Qoder CN · 10 tokens · 0 sessions')
    await m.unmount()
  })

  test('an empty scope keeps the summary and the body note, and the day sub rides the title', async () => {
    const m = await mount(h(Models, { stats: [], day: '2026-09-20' }))
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('0 models · 0 tokens'))
    assert.ok(text(query(m.container, '.lc-card-sub')).includes('2026-09-20'))
    assert.ok(text(m.container).includes('No model usage in this range'))
    assert.equal(queryAll(m.container, '.lc-ov-tally').length, 0)
    await m.unmount()
  })

  test('the row list caps at 24 with a more note while the summary still counts every model', async () => {
    const stats = Array.from({ length: 30 }, (_, i) => statOf({ model: `glm-${i}`, total: 30 - i }))
    const m = await mount(h(Models, { stats }))
    assert.equal(queryAll(m.container, '.lc-ov-tally').length, 24)
    assert.ok(text(query(m.container, '.lc-ov-tally-more')).includes('6 more models'))
    assert.ok(text(query(m.container, '.lc-ov-tally-note')).includes('30 models'))
    await m.unmount()
  })
})
