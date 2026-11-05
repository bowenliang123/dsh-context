import { act, createElement as h, useState } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makePluginConfigCard } from '../../../src/client/components/settingsCard'
import type { SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { blur, click, focus, keydown, makeKit, mount, press, query, queryAll, text, typeText } from '../helpers/kit'

const kit = makeKit()
const PluginConfigCard = makePluginConfigCard(kit)

function hookFor(state: SettingsState) {
  return <T,>(sel: (s: SettingsState) => T): T => sel(state)
}

function stateOf(partial: Partial<SettingsState> = {}): SettingsState {
  return { status: 'ready', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', overviewAutoSteps: '100', overviewRange: '30d', fleetTab: 'show', promptPrefix: '', promptSuffix: '', writable: true, ...partial }
}

function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

const stepsLabel = (n: number): string => DICT_EN['settings.overviewAutoSteps'].replace('{n}', String(n))

const clearOf = (area: HTMLTextAreaElement): HTMLElement | null =>
  area.closest('.lc-settings-textrow')?.querySelector('.lc-settings-textx') ?? null

describe('PluginConfigCard (the Plugins-page seat)', () => {
  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(PluginConfigCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('a settings seat that appears or disappears after mount keeps the card rendering without shifting its hooks', async () => {
    function useSettings<T>(sel: (s: SettingsState) => T): T {
      useState(0)
      return sel(stateOf())
    }
    const m = await mount(h(PluginConfigCard, {}))
    assert.equal(m.container.childElementCount, 0)
    await m.update(h(PluginConfigCard, { useContextSettings: useSettings }))
    assert.ok(query(m.container, '.lc-settings-prefs'))
    const before = m.container.firstElementChild
    await m.update(h(PluginConfigCard, { useContextSettings: hookFor(stateOf()), set: () => {} }))
    assert.equal(m.container.firstElementChild, before, 'a stable seat presence keeps the mounted card')
    await m.update(h(PluginConfigCard, {}))
    assert.equal(m.container.childElementCount, 0)
    await m.unmount()
  })

  test('renders the eleven selects and the two prompt text rows across three titled groups — no card chrome', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    assert.equal(m.container.querySelector('.lc-settings-card'), null, 'no settings-section chrome')
    assert.ok(query(m.container, '.lc-settings-prefs'))
    const groups = queryAll(m.container, '.lc-settings-group')
    assert.equal(groups.length, 3)
    assert.deepEqual(groups.map(g => g.getAttribute('aria-label')), [
      DICT_EN['settings.group.entry'],
      DICT_EN['settings.group.view'],
      DICT_EN['settings.group.prompt'],
    ])
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.equal(selects.length, 11)
    assert.ok(selects.every(s => s.disabled), 'loading is not ready: the rows are disabled')
    const textareas = queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea')
    assert.equal(textareas.length, 2)
    assert.ok(textareas.every(t => t.disabled), 'loading is not ready: the text rows are disabled')
    assert.ok(text(groups[2]).includes(DICT_EN['settings.promptHint']), 'the prompt hint lives inside the prompt group')
    assert.equal(m.container.querySelector('[role="status"]'), null, 'no read-only notice while loading')
    await m.unmount()
  })

  test('ready+writable: enabled selects pick through the real portaled Menu', async () => {
    const calls: [string, string][] = []
    const expected: [string, string][] = []
    const commit = (field: string, value: string): void => {
      expected.push([field, value])
      assert.deepEqual(calls, expected)
    }
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.ok(selects.every(s => !s.disabled))
    assert.equal(m.container.querySelector('[role="status"]'), null, 'writable: no read-only notice')
    assert.ok(text(m.container).includes(DICT_EN['settings.placement']))
    assert.ok(text(selects[0]).includes(DICT_EN['placement.all']))
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    const placementItems = menuItems()
    assert.equal(placementItems.length, 4)
    assert.deepEqual(placementItems.map(i => text(i)), [
      DICT_EN['placement.all'],
      DICT_EN['placement.tab'],
      DICT_EN['placement.sidebar'],
      DICT_EN['placement.hide'],
    ])
    await click(placementItems[2])
    commit('defaultPlacement', 'sidebar')
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    assert.ok(text(m.container).includes(DICT_EN['settings.insightsEntry']))
    assert.ok(text(selects[1]).includes(DICT_EN['showHide.show']))
    await click(selects[1])
    const entryItems = menuItems()
    assert.deepEqual(entryItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(entryItems[1])
    commit('insightsEntry', 'hide')

    assert.ok(text(m.container).includes(DICT_EN['settings.fleetTab']))
    assert.ok(text(selects[2]).includes(DICT_EN['showHide.show']))
    await click(selects[2])
    const fleetItems = menuItems()
    assert.deepEqual(fleetItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(fleetItems[1])
    commit('fleetTab', 'hide')

    assert.ok(text(m.container).includes(DICT_EN['settings.overviewRange']))
    assert.ok(text(selects[3]).includes(DICT_EN['ov.range.30d']))
    assert.ok(text(selects[4]).includes(DICT_EN['gran.step']))
    assert.ok(text(selects[5]).includes(DICT_EN['gran.total']))
    assert.ok(text(m.container).includes(DICT_EN['settings.durationCurve']))
    assert.ok(text(selects[6]).includes(DICT_EN['showHide.show']))
    assert.ok(text(m.container).includes(DICT_EN['settings.overviewAuto']))
    assert.ok(text(selects[7]).includes(stepsLabel(100)))
    assert.ok(text(m.container).includes(DICT_EN['settings.deltaBase']))
    assert.ok(text(selects[8]).includes(DICT_EN['browser.base.step']))
    assert.ok(text(m.container).includes(DICT_EN['settings.toolSort']))
    assert.ok(text(selects[9]).includes(DICT_EN['tool.sort.count']))
    assert.ok(text(m.container).includes(DICT_EN['settings.fileSort']))
    assert.ok(text(selects[10]).includes(DICT_EN['files.sort.count']))

    await click(selects[4])
    const items = menuItems()
    assert.deepEqual(items.map(i => text(i)), [DICT_EN['gran.step'], DICT_EN['gran.turn']])
    await click(items[1])
    commit('defaultGranularity', 'turn')

    await click(selects[5])
    const modeItems = menuItems()
    assert.deepEqual(modeItems.map(i => text(i)), [DICT_EN['gran.total'], DICT_EN['gran.delta']])
    await click(modeItems[1])
    commit('defaultTrendMode', 'delta')

    await click(selects[6])
    const curveItems = menuItems()
    assert.deepEqual(curveItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(curveItems[1])
    commit('defaultDurationCurve', 'hide')

    await click(selects[7])
    const overviewItems = menuItems()
    assert.deepEqual(overviewItems.map(i => text(i)), [stepsLabel(100), stepsLabel(200), stepsLabel(300), DICT_EN['settings.overviewAutoOff']])
    await click(overviewItems[3])
    commit('overviewAutoSteps', 'off')

    await click(selects[8])
    const baseItems = menuItems()
    assert.deepEqual(baseItems.map(i => text(i)), [DICT_EN['browser.base.step'], DICT_EN['browser.base.turn']])
    await click(baseItems[1])
    commit('defaultDeltaBase', 'turn')

    await click(selects[9])
    const toolItems = menuItems()
    assert.deepEqual(toolItems.map(i => text(i)), [
      DICT_EN['tool.sort.size'],
      DICT_EN['tool.sort.count'],
      DICT_EN['tool.sort.name'],
    ])
    await click(toolItems[2])
    commit('defaultToolSort', 'name')

    await click(selects[10])
    const sortItems = menuItems()
    assert.deepEqual(sortItems.map(i => text(i)), [
      DICT_EN['files.sort.count'],
      DICT_EN['files.sort.lines'],
      DICT_EN['files.sort.latest'],
      DICT_EN['files.sort.path'],
      DICT_EN['files.sort.name'],
    ])
    await click(sortItems[4])
    commit('defaultFileSort', 'name')

    await click(selects[3])
    const rangeItems = menuItems()
    assert.deepEqual(rangeItems.map(i => text(i)), [
      DICT_EN['ov.range.today'],
      DICT_EN['ov.range.7d'],
      DICT_EN['ov.range.30d'],
      DICT_EN['ov.range.all'],
    ])
    await click(rangeItems[1])
    commit('defaultOverviewRange', '7d')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    const picked = calls.length
    await click(selects[0])
    await keydown('Escape', document.body)
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    assert.equal(calls.length, picked)
    await m.unmount()
  })

  test('ready+readonly: disabled selects and the read-only note', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ writable: false, promptPrefix: 'served' })) }))
    const note = query(m.container, '.lc-settings-note')
    assert.equal(note.getAttribute('role'), 'status')
    assert.equal(text(note), DICT_EN['settings.readOnly'])
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-settings-select').every(s => s.disabled))
    assert.ok(queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea').every(t => t.disabled))
    assert.equal(m.container.querySelector('.lc-settings-textx'), null, 'disabled rows hide the clear control')
    await m.unmount()
  })

  test('prompt text rows: the × clears the draft, keeps focus, and commits empty on blur', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptPrefix: 'served' })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const textareas = queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea')
    const clear = clearOf(textareas[0]) as HTMLButtonElement
    assert.equal(textareas[0].getAttribute('data-lc-clearable'), '')
    assert.equal(clear.getAttribute('aria-label'), DICT_EN['field.clear'])
    assert.equal(clear.title, DICT_EN['field.clear'])
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { clear.dispatchEvent(down) })
    assert.equal(down.defaultPrevented, true, 'the press never steals focus from the textarea')
    await click(clear)
    assert.equal(textareas[0].value, '')
    assert.equal(document.activeElement, textareas[0])
    assert.equal(clearOf(textareas[0]), null)
    await blur(textareas[0])
    assert.deepEqual(calls, [['promptPrefix', '']], 'the cleared draft commits on blur')
    await m.unmount()

    const escCalls: [string, string][] = []
    const escMount = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptSuffix: 'served' })),
      set: (field, value) => { escCalls.push([field, value]) },
    }))
    const area = queryAll<HTMLTextAreaElement>(escMount.container, '.lc-settings-textarea')[1]
    await focus(area)
    await typeText(area, 'Sign as Atlas.')
    assert.ok(clearOf(area), 'typing keeps the control present')
    const composing = await press(area, { key: 'Escape', isComposing: true })
    assert.equal(area.value, 'Sign as Atlas.', 'Escape during IME composition stays with the IME')
    assert.equal(composing.ev.defaultPrevented, false)
    assert.equal(composing.reachedDocument, true)
    const esc = await press(area, { key: 'Escape' })
    assert.equal(area.value, '')
    assert.equal(esc.ev.defaultPrevented, true)
    assert.equal(esc.reachedDocument, false, 'the settings dialog must not also close')
    assert.equal(clearOf(area), null)
    const emptyEsc = await press(area, { key: 'Escape' })
    assert.equal(emptyEsc.ev.defaultPrevented, false, 'an empty field lets Escape close the dialog')
    assert.equal(emptyEsc.reachedDocument, true)
    await blur(area)
    assert.deepEqual(escCalls, [['promptSuffix', '']], 'the cleared suffix commits on blur')
    await escMount.unmount()
  })

  test('prompt text rows: typing stays local, the blur commits, an unmount without a blur commits too', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const textareas = queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea')
    assert.ok(textareas.every(t => !t.disabled))
    assert.equal(textareas[0].placeholder, DICT_EN['settings.promptPlaceholder'])

    await focus(textareas[0])
    await typeText(textareas[0], 'Be terse.')
    assert.equal(textareas[0].value, 'Be terse.')
    assert.deepEqual(calls, [], 'typing does not write the wire')

    await blur(textareas[0])
    assert.deepEqual(calls, [['promptPrefix', 'Be terse.']], 'the blur commits the draft')

    await blur(textareas[1])
    assert.deepEqual(calls, [['promptPrefix', 'Be terse.']], 'blurring an untouched row commits nothing')

    await focus(textareas[1])
    await typeText(textareas[1], 'Sign as Atlas.')
    await m.unmount()
    assert.deepEqual(calls, [['promptPrefix', 'Be terse.'], ['promptSuffix', 'Sign as Atlas.']], 'the unmount commits a pending draft')
  })

  test('prompt text rows: a committed draft is not re-committed; an idle row follows the served value; a focused row is never clobbered', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptPrefix: 'served' })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const prefix = query<HTMLTextAreaElement>(m.container, '.lc-settings-textarea')
    assert.equal(prefix.value, 'served')

    await focus(prefix)
    await typeText(prefix, 'served!')
    await m.update(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptPrefix: 'pushed' })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    assert.equal(query<HTMLTextAreaElement>(m.container, '.lc-settings-textarea').value, 'served!', 'the in-progress draft survives the push')
    await blur(query(m.container, '.lc-settings-textarea'))
    assert.deepEqual(calls, [['promptPrefix', 'served!']])

    await m.update(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptPrefix: 'pushed' })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    assert.equal(query<HTMLTextAreaElement>(m.container, '.lc-settings-textarea').value, 'pushed')
    await m.unmount()
    assert.deepEqual(calls, [['promptPrefix', 'served!']], 'no re-commit of an already served value')
  })

  test('a value matching no option falls back to the raw id; a missing set never throws', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ placement: 'weird' as never })) }))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.ok(text(selects[0]).includes('weird'))
    await click(selects[0])
    await click(menuItems()[1])
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })
})
