import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeCurrentComposition } from '../../../src/client/components/currentComposition'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import type { Headline } from '../../../src/client/headline'
import { hover, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const CurrentComposition = makeCurrentComposition(kit, makeStackedBar(kit), makeLegend(kit))

const PARTS = [{ key: 'user', color: '#123456', value: 5000 }]

function headOf(over: Partial<Headline> = {}): Headline {
  return { tokens: 5000, pct: null, parts: PARTS, ...over }
}

describe('CurrentComposition header', () => {
  test('windowed head: tokens/window figure, used percentage, reserve band, subtitle', async () => {
    const m = await mount(h(CurrentComposition, {
      head: headOf({ window: 10000, pct: 50.4 }),
      subtitle: 'deepseek-v4-flash',
    }))
    assert.ok(text(m.container).includes('Current Context'))
    assert.equal(query(m.container, '.lc-card-sub').textContent, 'deepseek-v4-flash')
    const num = query(m.container, '.lc-overview-num')
    assert.ok(text(num).includes('5.0k / 10.0k tokens'))
    // The reading keeps one decimal, a whole tenth included (headline.ts).
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.4%')
    await m.update(h(CurrentComposition, { head: headOf({ window: 10000, pct: 50 }) }))
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50.0%')
    assert.ok(text(num).includes('of context used'))
    // The reserve band mirrors the 80% auto-compaction threshold.
    const band = query(m.container, '.lc-reserve')
    await hover(band)
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.textContent!.includes('Auto-compaction reserve'))
    assert.ok(tip.textContent!.includes('80%'))
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

  test('wire gap: the provider-carried reading appears while a near sample stays hidden', async () => {
    const m = await mount(h(CurrentComposition, {
      head: headOf({ tokens: 1_000_000, window: 1_000_000, pct: 100, sampled: 300_000 }),
    }))
    const wire = query(m.container, '.lc-overview-wire')
    assert.ok(text(wire).includes('300.0k'))
    assert.ok(text(wire).includes('carried by the last request'))
    assert.ok(wire.getAttribute('title')?.includes('wire-side compression') ?? false)
    // No wide divergence: the reading stays off the card.
    await m.update(h(CurrentComposition, {
      head: headOf({ tokens: 5_000, sampled: 4_000 }),
    }))
    assert.equal(queryAll(m.container, '.lc-overview-wire').length, 0)
    // A sample ABOVE the headline (the heuristic underpricing direction) never flags either.
    await m.update(h(CurrentComposition, {
      head: headOf({ tokens: 300_000, sampled: 500_000 }),
    }))
    assert.equal(queryAll(m.container, '.lc-overview-wire').length, 0)
    await m.unmount()
  })

  test('wire gap reading renders in zh from its own dictionary', async () => {
    const zhCurrentComposition = makeCurrentComposition(makeKit('zh'), makeStackedBar(makeKit('zh')), makeLegend(makeKit('zh')))
    const m = await mount(h(zhCurrentComposition, {
      head: headOf({ tokens: 1_000_000, window: 1_000_000, pct: 100, sampled: 300_000 }),
    }))
    const wire = query(m.container, '.lc-overview-wire')
    assert.ok(text(wire).includes('上次请求实际携带'))
    assert.ok(wire.getAttribute('title')?.includes('外部压缩代理') ?? false)
    await m.unmount()
  })
})