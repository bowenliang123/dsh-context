import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { makePluginConfigCard } from '../../../src/client/components/settingsCard'
import type { SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { blur, click, focus, keydown, makeKit, mount, query, queryAll, text, typeText } from '../helpers/kit'

const kit = makeKit()
const PluginConfigCard = makePluginConfigCard(kit)

function hookFor(state: SettingsState) {
  return <T,>(sel: (s: SettingsState) => T): T => sel(state)
}

function stateOf(partial: Partial<SettingsState> = {}): SettingsState {
  return { status: 'ready', placement: 'all', granularity: 'step', mode: 'total', deltaBase: 'step', toolSort: 'count', fileSort: 'count', insightsEntry: 'show', durationCurve: 'show', overviewAutoSteps: '200', overviewRange: '30d', fleetTab: 'show', usageWindow: '7d', costFxRate: 'official', costPeakFactor: '2', costMultiplier: '1', costActualPrice: 'hide', promptPrefix: '', promptSuffix: '', writable: true, ...partial }
}

/** Menu items portaled into document.body while a select is open. */
function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

/** The auto-overview row's option labels (the shared step-count template). */
const stepsLabel = (n: number): string => DICT_EN['settings.overviewAutoSteps'].replace('{n}', String(n))

describe('PluginConfigCard (the Plugins-page seat)', () => {
  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(PluginConfigCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('renders the sixteen selects and the two prompt text rows across four titled groups — no card chrome', async () => {
    const m = await mount(h(PluginConfigCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    assert.equal(m.container.querySelector('.lc-settings-card'), null, 'no settings-section chrome')
    assert.ok(query(m.container, '.lc-settings-prefs'))
    const groups = queryAll(m.container, '.lc-settings-group')
    assert.equal(groups.length, 4)
    assert.deepEqual(groups.map(g => g.getAttribute('aria-label')), [
      DICT_EN['settings.group.entry'],
      DICT_EN['settings.group.view'],
      DICT_EN['settings.group.cost'],
      DICT_EN['settings.group.prompt'],
    ])
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.equal(selects.length, 16)
    assert.ok(selects.every(s => s.disabled), 'loading is not ready: the rows are disabled')
    const textareas = queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea')
    assert.equal(textareas.length, 2)
    assert.ok(textareas.every(t => t.disabled), 'loading is not ready: the text rows are disabled')
    assert.ok(text(groups[3]).includes(DICT_EN['settings.promptHint']), 'the prompt hint lives inside the prompt group')
    assert.equal(m.container.querySelector('[role="status"]'), null, 'no read-only notice while loading')
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
    assert.equal(m.container.querySelector('[role="status"]'), null, 'writable: no read-only notice')
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

    // The overview range row opens the view group, reusing the page's own preset labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.overviewRange']))
    assert.ok(text(selects[3]).includes(DICT_EN['ov.range.30d']))
    assert.ok(text(selects[4]).includes(DICT_EN['gran.step']))
    assert.ok(text(selects[5]).includes(DICT_EN['gran.total']))
    // The duration-curve row follows the trend-mode one, reusing the entry's show/hide labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.durationCurve']))
    assert.ok(text(selects[6]).includes(DICT_EN['showHide.show']))
    // The auto-overview row follows the curve one, naming its step threshold (or Off).
    assert.ok(text(m.container).includes(DICT_EN['settings.overviewAuto']))
    assert.ok(text(selects[7]).includes(stepsLabel(200)))
    // The delta-baseline row leads the tool-sort one, reusing the toolbar's option labels.
    assert.ok(text(m.container).includes(DICT_EN['settings.deltaBase']))
    assert.ok(text(selects[8]).includes(DICT_EN['browser.base.step']))
    assert.ok(text(m.container).includes(DICT_EN['settings.toolSort']))
    assert.ok(text(selects[9]).includes(DICT_EN['tool.sort.count']))
    assert.ok(text(m.container).includes(DICT_EN['settings.fileSort']))
    assert.ok(text(selects[10]).includes(DICT_EN['files.sort.count']))

    await click(selects[4])
    const items = menuItems()
    assert.deepEqual(items.map(i => text(i)), [DICT_EN['gran.step'], DICT_EN['gran.turn']])
    await click(items[1]) // 'Turn'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
    ])

    await click(selects[5])
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

    await click(selects[6])
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

    await click(selects[7])
    const overviewItems = menuItems()
    assert.deepEqual(overviewItems.map(i => text(i)), [stepsLabel(100), stepsLabel(200), stepsLabel(300), DICT_EN['settings.overviewAutoOff']])
    await click(overviewItems[3]) // 'Off'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
    ])

    await click(selects[8])
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
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
    ])

    await click(selects[9])
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
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
    ])

    await click(selects[10])
    const sortItems = menuItems()
    assert.deepEqual(sortItems.map(i => text(i)), [
      DICT_EN['files.sort.count'],
      DICT_EN['files.sort.latest'],
      DICT_EN['files.sort.path'],
      DICT_EN['files.sort.name'],
    ])
    await click(sortItems[3]) // 'By name'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'name'],
    ])

    // The cost group follows the view one: the usage chart's window, the fx presets,
    // the peak factor, the actual-price multiplier, and that multiplier's on/off gate.
    assert.ok(text(m.container).includes(DICT_EN['settings.group.cost']))
    assert.ok(text(m.container).includes(DICT_EN['settings.usageWindow']))
    assert.ok(text(selects[11]).includes(DICT_EN['ov.usage.title']))
    await click(selects[11])
    const windowItems = menuItems()
    assert.deepEqual(windowItems.map(i => text(i)), [DICT_EN['ov.usage.title'], DICT_EN['ov.usage.title30']])
    await click(windowItems[1]) // 'Last 30 Days'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'name'],
      ['usageWindow', '30d'],
    ])

    assert.ok(text(m.container).includes(DICT_EN['settings.costFxRate']))
    assert.ok(text(selects[12]).includes(DICT_EN['settings.costFxOfficial']))
    await click(selects[12])
    const fxItems = menuItems()
    assert.deepEqual(fxItems.map(i => text(i)), [
      DICT_EN['settings.costFxOfficial'],
      DICT_EN['settings.costFxAt'].replace('{r}', '7.0'),
      DICT_EN['settings.costFxAt'].replace('{r}', '7.2'),
      DICT_EN['settings.costFxAt'].replace('{r}', '7.4'),
    ])
    await click(fxItems[2]) // 1 USD = 7.2 CNY
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'name'],
      ['usageWindow', '30d'],
      ['costFxRate', '7.2'],
    ])

    assert.ok(text(m.container).includes(DICT_EN['settings.costPeak']))
    await click(selects[13])
    const peakItems = menuItems()
    assert.deepEqual(peakItems.map(i => text(i)), [
      DICT_EN['settings.costTimes'].replace('{n}', '1'),
      DICT_EN['settings.costTimes'].replace('{n}', '1.5'),
      DICT_EN['settings.costTimes'].replace('{n}', '2'),
    ])
    await click(peakItems[0]) // 1×
    assert.ok(text(m.container).includes(DICT_EN['settings.costMultiplier']))
    await click(selects[14])
    const multItems = menuItems()
    assert.deepEqual(multItems.map(i => text(i)), ['1', '0.95', '0.9', '0.8', '0.7', '0.5'].map(n => DICT_EN['settings.costTimes'].replace('{n}', n)))
    await click(multItems[3]) // 0.8×
    assert.ok(text(m.container).includes(DICT_EN['settings.costActualPrice']))
    await click(selects[15])
    const actualItems = menuItems()
    assert.deepEqual(actualItems.map(i => text(i)), [DICT_EN['showHide.show'], DICT_EN['showHide.hide']])
    await click(actualItems[0]) // 'Show'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'name'],
      ['usageWindow', '30d'],
      ['costFxRate', '7.2'],
      ['costPeakFactor', '1'],
      ['costMultiplier', '0.8'],
      ['costActualPrice', 'show'],
    ])

    await click(selects[3])
    const rangeItems = menuItems()
    assert.deepEqual(rangeItems.map(i => text(i)), [
      DICT_EN['ov.range.today'],
      DICT_EN['ov.range.7d'],
      DICT_EN['ov.range.30d'],
      DICT_EN['ov.range.all'],
    ])
    await click(rangeItems[1]) // 'Last 7 days'
    assert.deepEqual(calls, [
      ['defaultPlacement', 'sidebar'],
      ['insightsEntry', 'hide'],
      ['fleetTab', 'hide'],
      ['defaultGranularity', 'turn'],
      ['defaultTrendMode', 'delta'],
      ['defaultDurationCurve', 'hide'],
      ['overviewAutoSteps', 'off'],
      ['defaultDeltaBase', 'turn'],
      ['defaultToolSort', 'name'],
      ['defaultFileSort', 'name'],
      ['usageWindow', '30d'],
      ['costFxRate', '7.2'],
      ['costPeakFactor', '1'],
      ['costMultiplier', '0.8'],
      ['costActualPrice', 'show'],
      ['defaultOverviewRange', '7d'],
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
    assert.ok(queryAll<HTMLTextAreaElement>(m.container, '.lc-settings-textarea').every(t => t.disabled))
    await m.unmount()
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
    // A host push lands while the row is being edited.
    await m.update(h(PluginConfigCard, {
      useContextSettings: hookFor(stateOf({ promptPrefix: 'pushed' })),
      set: (field, value) => { calls.push([field, value]) },
    }))
    assert.equal(query<HTMLTextAreaElement>(m.container, '.lc-settings-textarea').value, 'served!', 'the in-progress draft survives the push')
    await blur(query(m.container, '.lc-settings-textarea'))
    assert.deepEqual(calls, [['promptPrefix', 'served!']])

    // Idle again: the next push is followed.
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
    // props.set undefined: picking still closes the menu, no throw.
    await click(selects[0])
    await click(menuItems()[1])
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })
})
