import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makePluginConfigCard } from '../../../src/client/components/settingsCard'
import type { SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { click, keydown, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const PluginConfigCard = makePluginConfigCard(kit)

function hookFor(state: SettingsState) {
  return <T,>(sel: (s: SettingsState) => T): T => sel(state)
}

function stateOf(partial: Partial<SettingsState> = {}): SettingsState {
  return { status: 'ready', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', fleetTab: 'show', writable: true, ...partial }
}

/** Menu items portaled into document.body while a select is open. */
function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

describe('PluginConfigCard (the Plugins-page seat)', () => {
  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(PluginConfigCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('renders the nine rows flat — no card chrome', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    assert.equal(m.container.querySelector('.lc-settings-card'), null, 'no settings-section chrome')
    assert.ok(query(m.container, '.lc-settings-prefs'))
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.equal(selects.length, 9)
    assert.ok(selects.every(s => s.disabled), 'loading is not ready: the rows are disabled')
    assert.equal(m.container.querySelector('.lc-settings-note'), null)
    await m.unmount()
  })

  test('ready+writable: enabled selects pick through the real portaled Menu', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.ok(selects.every(s => !s.disabled))
    assert.equal(m.container.querySelector('.lc-settings-note'), null)
    assert.ok(text(m.container).includes(DICT_EN['settings.placement']))
    assert.ok(text(selects[0]).includes(DICT_EN['placement.all']))
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    const placementItems = menuItems()
    assert.equal(placementItems.length, 3)
    assert.deepEqual(placementItems.map(i => text(i)), [
      DICT_EN['placement.all'],
      DICT_EN['placement.tab'],
      DICT_EN['placement.sidebar'],
    ])
    await click(placementItems[2]) // 'Sidebar'
    assert.deepEqual(calls, [['defaultPlacement', 'sidebar']])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    assert.ok(text(m.container).includes(DICT_EN['settings.insightsEntry']))
    assert.ok(text(selects[1]).includes(DICT_EN['showHide.show']))
    await click(selects[1])
    const entryItems = menuItems()
    assert.deepEqual(entryItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(entryItems[1]) // 'Hide'
    assert.deepEqual(calls, [['defaultPlacement', 'sidebar'], ['insightsEntry', 'hide']])

    // The Fleet-tab row follows the insights entry: the two view-visibility gates sit together.
    assert.ok(text(m.container).includes(DICT_EN['settings.fleetTab']))
    assert.ok(text(selects[2]).includes(DICT_EN['showHide.show']))
    await click(selects[2])
    const fleetItems = menuItems()
    assert.deepEqual(fleetItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(fleetItems[1]) // 'Hide'
    assert.deepEqual(calls, [['defaultPlacement', 'sidebar'], ['insightsEntry', 'hide'], ['fleetTab', 'hide']])

    assert.ok(text(selects[3]).includes(DICT_EN['gran.step']))
    assert.ok(text(selects[4]).includes(DICT_EN['gran.total']))
    // The duration-curve row follows the trend-mode one, reusing the entry's show/hide labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.durationCurve']))
    assert.ok(text(selects[5]).includes(DICT_EN['showHide.show']))
    // The delta-baseline row leads the tool-sort one, reusing the toolbar's option labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.deltaBase']))
    assert.ok(text(selects[6]).includes(DICT_EN['browser.base.step']))
    assert.ok(text(m.container).includes(DICT_EN['settings.toolSort']))
    assert.ok(text(selects[7]).includes(DICT_EN['tool.sort.count']))
    assert.ok(text(m.container).includes(DICT_EN['settings.fileSort']))
    assert.ok(text(selects[8]).includes(DICT_EN['files.sort.count']))

    await click(selects[3])
    const items = menuItems()
    assert.deepEqual(items.map(i => text(i)), [DICT_EN['gran.step'], DICT_EN['gran.turn']])
    await click(items[1]) // 'Turn'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
    ])

    await click(selects[4])
    const modeItems = menuItems()
    assert.deepEqual(modeItems.map(i => text(i)), [DICT_EN['gran.total'], DICT_EN['gran.delta']])
    await click(modeItems[1]) // 'Delta'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
    ])

    await click(selects[5])
    const curveItems = menuItems()
    assert.deepEqual(curveItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(curveItems[1]) // 'Hide'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
    ])

    await click(selects[6])
    const baseItems = menuItems()
    assert.deepEqual(baseItems.map(i => text(i)), [DICT_EN['browser.base.step'], DICT_EN['browser.base.turn']])
    await click(baseItems[1]) // 'prev turn'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['defaultDeltaBase', 'turn'],
    ])

    await click(selects[7])
    const toolItems = menuItems()
    assert.deepEqual(toolItems.map(i => text(i)), [
      DICT_EN['tool.sort.size'],
      DICT_EN['tool.sort.count'],
      DICT_EN['tool.sort.name'],
    ])
    await click(toolItems[2]) // 'By name'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
    ])

    await click(selects[8])
    const sortItems = menuItems()
    assert.deepEqual(sortItems.map(i => text(i)), [
      DICT_EN['files.sort.count'],
      DICT_EN['files.sort.latest'],
      DICT_EN['files.sort.path'],
    ])
    await click(sortItems[2]) // 'By path'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'path'],
    ])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })

  test('Menu onClose (Escape) closes an open select without picking', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    const select = query(m.container, '.lc-settings-select')
    await click(select)
    assert.equal(select.getAttribute('aria-expanded'), 'true')
    assert.equal(menuItems().length, 3, 'the placement row leads with three options')
    await keydown('Escape', document.body)
    assert.equal(select.getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    assert.deepEqual(calls, [])
    await m.unmount()
  })

  test('ready+readonly: disabled selects and the read-only note', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ writable: false })) }))
    const note = query(m.container, '.lc-settings-note')
    assert.equal(note.getAttribute('role'), 'status')
    assert.equal(text(note), DICT_EN['settings.readOnly'])
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-settings-select').every(s => s.disabled))
    await m.unmount()
  })

  test('a value matching no option falls back to the raw id; a missing set never throws', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ placement: 'weird' as never })) }))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.ok(text(selects[0]).includes('weird'))
    // props.set undefined: picking still closes the menu, no throw.
    await click(selects[0])
    await click(menuItems()[1])
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })
})
