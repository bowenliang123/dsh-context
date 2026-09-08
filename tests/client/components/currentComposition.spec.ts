// CurrentComposition (src/client/components/currentComposition.tsx) rendered
// with real React over the real StackedBar/Legend pair.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makeCurrentComposition } from '../../../src/client/components/currentComposition'
import { makeLegend, makeStackedBar } from '../../../src/client/components/stackedBar'
import type { Headline } from '../../../src/client/headline'
import { createContextSettings, type SettingsScopeLike } from '../../../src/client/settings'
import { hover, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const CurrentComposition = makeCurrentComposition(kit, makeStackedBar(kit), makeLegend(kit))

class TestSettingsScope implements SettingsScopeLike {
  private snapshot: { status: string; value: unknown; writable: boolean }
  private readonly listeners = new Set<() => void>()

  constructor(snapshot: { status: string; value: unknown; writable: boolean }) {
    this.snapshot = snapshot
  }

  getSnapshot(): { status: string; value: unknown; writable: boolean } {
    return this.snapshot
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  set(): Promise<void> {
    return Promise.resolve()
  }

  emit(snapshot: { status: string; value: unknown; writable: boolean }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

const PARTS = [{ key: 'user', color: '#123456', value: 5000 }]

function headOf(over: Partial<Headline> = {}): Headline {
  return { tokens: 5000, pct: null, parts: PARTS, ...over }
}

describe('CurrentComposition header', () => {
  test('windowed head: tokens/window figure, used percentage, reserve band, subtitle', async () => {
    const m = await mount(h(CurrentComposition, {
      head: headOf({ window: 10000, pct: 50 }),
      subtitle: 'deepseek-v4-flash',
    }))
    assert.ok(text(m.container).includes('Current Context'))
    assert.equal(query(m.container, '.lc-card-sub').textContent, 'deepseek-v4-flash')
    const num = query(m.container, '.lc-overview-num')
    assert.ok(text(num).includes('5.0k / 10.0k tokens'))
    assert.equal(query(num, '.lc-overview-pct b').textContent, '50%')
    assert.ok(text(num).includes('of context used'))
    // The reserve band mirrors the 80% auto-compaction threshold (unset default).
    const band = query(m.container, '.lc-reserve')
    await hover(band)
    const tip = query(m.container, '.lc-bar-tip')
    assert.ok(tip.textContent!.includes('Auto-compact reserve'))
    assert.ok(tip.textContent!.includes('80%'))
    await m.unmount()
  })

  test('the reserve band follows the tune bar\'s tuned threshold live', async () => {
    const settings = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })
    settings.attach(scope)
    const Tuned = makeCurrentComposition(kit, makeStackedBar(kit), makeLegend(kit), settings)
    const m = await mount(h(Tuned, { head: headOf({ window: 10000, pct: 50 }) }))
    // Unset: the band starts at the 80% default.
    assert.ok((query(m.container, '.lc-reserve').getAttribute('style') ?? '').includes('left: 80%'))
    await act(async () => { scope.emit({ status: 'ready', value: { compactionThresholdRatio: 0.3 }, writable: true }) })
    const band = query(m.container, '.lc-reserve')
    assert.ok((band.getAttribute('style') ?? '').includes('left: 30%'), 'the band tracks the tuned ratio')
    await hover(band)
    assert.ok(query(m.container, '.lc-bar-tip').textContent!.includes('30%'))
    // Clearing the override reverts the band to the default line.
    await act(async () => { scope.emit({ status: 'ready', value: {}, writable: true }) })
    assert.ok((query(m.container, '.lc-reserve').getAttribute('style') ?? '').includes('left: 80%'))
    await m.unmount()
  })

  test('windowless head: estimate label, no percentage, no reserve, no subtitle', async () => {
    const m = await mount(h(CurrentComposition, { head: headOf() }))
    assert.ok(text(m.container).includes('tokens (estimated)'))
    assert.equal(queryAll(m.container, '.lc-overview-pct').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    // An empty subtitle renders nothing either; a zero window stays reserve-free.
    await m.update(h(CurrentComposition, { head: headOf({ window: 0 }), subtitle: '' }))
    assert.equal(queryAll(m.container, '.lc-card-sub').length, 0)
    assert.equal(queryAll(m.container, '.lc-reserve').length, 0)
    assert.ok(text(m.container).includes('tokens (estimated)'))
    await m.unmount()
  })
})