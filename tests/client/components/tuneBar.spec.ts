// TuneBar (src/client/components/tuneBar.tsx) rendered with real React and
// the real DICT_EN strings, bound onto a REAL createContextSettings() store
// attached to a faithful in-memory scope. Covers the draft/apply/discard
// flow, the two sliders' shared invariant (tail strictly below the trigger),
// the tooltip faces, and the read-only degradation.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { act } from 'react'
import { makeTuneBar } from '../../../src/client/components/tuneBar'
import { createContextSettings, type SettingsScopeLike } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

class TestSettingsScope implements SettingsScopeLike {
  private snapshot: { status: string; value: unknown; writable: boolean }
  private readonly listeners = new Set<() => void>()
  readonly sets: { field: string; value: unknown }[] = []

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

  set(field: string, value: unknown): Promise<void> {
    this.sets.push({ field, value })
    return Promise.resolve()
  }

  emit(snapshot: { status: string; value: unknown; writable: boolean }): void {
    this.snapshot = snapshot
    for (const listener of this.listeners) listener()
  }
}

async function mountBar(settings = createContextSettings(), scope = new TestSettingsScope({ status: 'ready', value: {}, writable: true })) {
  settings.attach(scope)
  const TuneBar = makeTuneBar(kit, settings)
  const m = await mount(h(TuneBar))
  return { m, settings, scope }
}

/** Drag a range input to a percent, through React's onChange (native input event). */
async function drag(el: HTMLInputElement, pct: number): Promise<void> {
  await act(async () => {
    // Set through the PROTOTYPE setter: React's instance-level value tracker
    // would swallow a direct assignment as "no change" and drop the event.
    const desc = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')
    desc?.set?.call(el, String(pct))
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function sliders(container: HTMLElement): HTMLInputElement[] {
  return queryAll(container, 'input[type="range"]') as HTMLInputElement[]
}

describe('TuneBar', () => {
  test('rests at the engine defaults with "default" chips while both fields are unset', async () => {
    const { m } = await mountBar()
    const [threshold, retain] = sliders(m.container)
    assert.equal(threshold.value, '80', 'unset trigger rests at the built-in 80%')
    assert.equal(retain.value, '16', 'unset tail rests at the built-in 16%')
    assert.equal(queryAll(m.container, '.lc-tune-chip').length, 2)
    assert.ok(text(m.container).includes(DICT_EN['tune.default']))
    // Both unset and nothing drafted: Reset is disabled.
    assert.equal((query(m.container, '.lc-tune-reset') as HTMLButtonElement).disabled, true)
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0, 'no Apply/Discard while settled')
    await m.unmount()
  })

  test('labels and chips carry explanatory tooltips', async () => {
    const { m } = await mountBar()
    const tags = queryAll(m.container, '.lc-tune-tag')
    assert.equal(tags[0].getAttribute('title'), DICT_EN['tune.thresholdHint'])
    assert.equal(tags[1].getAttribute('title'), DICT_EN['tune.retainHint'])
    const chip = query(m.container, '.lc-tune-chip')
    assert.equal(chip.getAttribute('title'), DICT_EN['tune.defaultHint'])
    assert.equal(query(m.container, '.lc-tune-name').getAttribute('title'), DICT_EN['tune.hint'])
    await m.unmount()
  })

  test('a drag only drafts: nothing writes until Apply, Discard reverts the thumb', async () => {
    const { m, scope } = await mountBar()
    const [threshold] = sliders(m.container)
    await drag(threshold, 50)
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 1, 'the Apply/Discard pair appears while dirty')
    assert.deepEqual(scope.sets, [], 'a drag alone never writes')

    await click(query(m.container, '.lc-tune-discard'))
    assert.equal(threshold.value, '80', 'Discard snaps the thumb back')
    assert.deepEqual(scope.sets, [], 'Discard never writes')
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0)

    await drag(threshold, 50)
    await click(query(m.container, '.lc-tune-apply'))
    assert.deepEqual(scope.sets, [{ field: 'compactionThresholdRatio', value: 0.5 }], 'Apply writes the drafted ratio')
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0)
    await m.unmount()
  })

  test('the tail stays strictly below the trigger: dragging the trigger pulls the tail along', async () => {
    const { m, scope } = await mountBar()
    const [threshold, retain] = sliders(m.container)
    // Drag the trigger below the stored tail (default ghost 16): the tail thumb follows.
    await drag(threshold, 15)
    assert.equal(retain.value, '14', 'the tail is pinned one point below the trigger')
    assert.equal(retain.max, '14', 'the tail ceiling trails the drafted trigger')
    await click(query(m.container, '.lc-tune-apply'))
    assert.deepEqual(scope.sets, [
      { field: 'compactionThresholdRatio', value: 0.15 },
      { field: 'compactionRetainRatio', value: 0.14 },
    ], 'the pulled pair applies together, in engine-valid form')
    await m.unmount()
  })

  test('the tail slider refuses the 0 that the engine would reject; dragging back neutralizes', async () => {
    const { m, scope } = await mountBar()
    const [, retain] = sliders(m.container)
    assert.equal(retain.min, '1', '0 is off the scale: the engine rejects an empty tail')
    await drag(retain, 20)
    await click(query(m.container, '.lc-tune-apply'))
    assert.deepEqual(scope.sets, [{ field: 'compactionRetainRatio', value: 0.2 }])
    // The scope echoes the stored section; dragging back to it settles the
    // draft entirely — no Apply/Discard pair, no write.
    scope.emit({ status: 'ready', value: { compactionRetainRatio: 0.2 }, writable: true })
    await drag(retain, 20)
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0, 'dragging back to the stored value settles the draft')
    assert.equal(scope.sets.length, 1)
    await m.unmount()
  })

  test('Apply writes only the fields that actually changed', async () => {
    const { m, scope } = await mountBar()
    const [, retain] = sliders(m.container)
    await drag(retain, 30)
    await click(query(m.container, '.lc-tune-apply'))
    assert.deepEqual(scope.sets, [{ field: 'compactionRetainRatio', value: 0.3 }], 'an untouched trigger stays unset')
    await m.unmount()
  })

  test('stored values render as facts (no default chip); Reset clears both fields at once', async () => {
    const settings = createContextSettings()
    const { m, scope } = await mountBar(settings)
    // Land explicit values through the same flow, then let the scope echo them.
    const [threshold, retain] = sliders(m.container)
    await drag(threshold, 60)
    await drag(retain, 10)
    await click(query(m.container, '.lc-tune-apply'))
    scope.emit({ status: 'ready', value: { compactionThresholdRatio: 0.6, compactionRetainRatio: 0.1 }, writable: true })
    assert.equal(threshold.value, '60')
    assert.equal(queryAll(m.container, '.lc-tune-chip').length, 0, 'no default chips once customized')
    assert.equal((query(m.container, '.lc-tune-reset') as HTMLButtonElement).disabled, false)

    await click(query(m.container, '.lc-tune-reset'))
    assert.deepEqual(scope.sets.slice(2), [
      { field: 'compactionThresholdRatio', value: null },
      { field: 'compactionRetainRatio', value: null },
    ], 'Reset clears both overrides back to "follow the engine"')
    await m.unmount()
  })

  test('read-only and unavailable scopes render the strip disabled with a note', async () => {
    for (const scope of [
      new TestSettingsScope({ status: 'ready', value: {}, writable: false }),
      new TestSettingsScope({ status: 'unavailable', value: undefined, writable: false }),
    ]) {
      const settings = createContextSettings()
      settings.attach(scope)
      const TuneBar = makeTuneBar(kit, settings)
      const m = await mount(h(TuneBar))
      const [threshold, retain] = sliders(m.container)
      assert.ok(threshold.disabled && retain.disabled)
      assert.ok(text(m.container).includes(DICT_EN['tune.readOnly']) || text(m.container).includes(DICT_EN['tune.unavailable']))
      await drag(threshold, 50)
      await drag(retain, 30)
      assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0, 'a disabled slider never drafts')
      await m.unmount()
    }
  })

  test('drafting both sliders keeps the pair consistent through Apply', async () => {
    const { m, scope } = await mountBar()
    const [threshold, retain] = sliders(m.container)
    await drag(threshold, 50)
    await drag(retain, 20)
    await click(query(m.container, '.lc-tune-apply'))
    assert.deepEqual(scope.sets, [
      { field: 'compactionThresholdRatio', value: 0.5 },
      { field: 'compactionRetainRatio', value: 0.2 },
    ])
    await m.unmount()
  })

  test('dragging a slider back to its stored value settles the whole draft', async () => {
    const { m } = await mountBar()
    const [threshold] = sliders(m.container)
    await drag(threshold, 50)
    await drag(threshold, 80)
    assert.equal(queryAll(m.container, '.lc-tune-actions').length, 0, 'nothing drafted, nothing to apply')
    await m.unmount()
  })

  test('the 100% trigger position explains itself (pressure effectively off)', async () => {
    const settings = createContextSettings()
    const scope = new TestSettingsScope({ status: 'ready', value: { compactionThresholdRatio: 1 }, writable: true })
    settings.attach(scope)
    const TuneBar = makeTuneBar(kit, settings)
    const m = await mount(h(TuneBar))
    const value = query(m.container, '.lc-tune-val')
    assert.equal(value.textContent, '100%')
    assert.equal(value.getAttribute('title'), DICT_EN['tune.off'])
    await m.unmount()
  })
})
