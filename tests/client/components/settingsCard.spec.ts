import { act, createElement as h, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test, afterEach } from 'vitest'
import { makePluginConfigCard } from '../../../src/client/components/settingsCard'
import { type SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { blur, click, focus, keydown, makeKit, mount, press, query, queryAll, text, typeText, hover, type Mounted } from '../helpers/kit'
import { makeDateRange, monthLabelOf, type DateRangeProps } from '../../../src/client/components/dateRange'
import { type DayRange } from '../../../src/client/overview'
import { ClearableInput } from '../../../src/client/components/clearableInput'

describe('settingsCard', () => {

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
})

describe('dateRange', () => {

const TODAY = '2026-10-09'

const DateRange = makeDateRange(makeKit())

const mounted: Mounted[] = []

function panel(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.lc-dp-panel')
}

function trigger(m: Mounted): HTMLElement {
  return query(m.container, '.lc-dp-trigger')
}

function cell(m: Mounted, key: string): HTMLElement {
  const found = queryAll(document.body, '.lc-dp-cell').find(el => el.getAttribute('aria-label') === key)
  if (found === undefined) throw new Error(`no day cell: ${key}`)
  return found
}

async function fireWindow(ev: Event): Promise<void> {
  await act(async () => { window.dispatchEvent(ev) })
}

interface Harness {
  m: Mounted
  changes: (DayRange | null)[]
  set: (next: Partial<DateRangeProps>) => Promise<void>
}

async function open(over: Partial<DateRangeProps> = {}): Promise<Harness> {
  const changes: (DayRange | null)[] = []
  let props: DateRangeProps = {
    value: null,
    picked: false,
    onChange: (range) => { changes.push(range) },
    today: TODAY,
    locale: 'en',
    ...over,
  }
  const m = await mount(h(DateRange, props))
  mounted.push(m)
  return {
    m,
    changes,
    async set(next) {
      props = { ...props, ...next }
      await m.update(h(DateRange, props))
    },
  }
}

async function toggle(m: Mounted): Promise<void> {
  await click(trigger(m))
}

afterEach(async () => {
  while (mounted.length > 0) await mounted.pop()?.unmount()
})

describe('monthLabelOf', () => {
  test('the panel header names the month in the active locale', () => {
    assert.match(monthLabelOf('2026-10', 'en'), /2026/)
    assert.match(monthLabelOf('2026-10', 'zh'), /2026/)
    assert.equal(monthLabelOf('not-a-month', 'en'), 'not-a-month', 'a key that will not convert falls back to itself')
  })
})

describe('the trigger', () => {
  test('carries the scope’s two ends, or the two placeholders', async () => {
    const { m, set } = await open()
    const halves = () => queryAll(m.container, '.lc-dp-half').map(el => el.textContent)
    assert.deepEqual(halves(), ['Start date', 'End date'], 'an unbounded scope has no span to print')
    assert.match(query(m.container, '.lc-dp-trigger').getAttribute('aria-label') ?? '', /custom date range/)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    await toggle(m)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
    assert.ok(panel() !== null, 'the panel is portaled to the body')

    await set({ value: { from: '2026-09-10', to: '2026-10-09' } })
    assert.deepEqual(halves(), ['2026-09-10', '2026-10-09'])
    assert.ok(!trigger(m).className.includes('lc-dp-trigger-on'))
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 0, 'nothing to clear while a preset is in charge')

    await set({ picked: true })
    assert.match(trigger(m).className, /lc-dp-trigger-on/)
    assert.equal(queryAll(panel()!, '.lc-dp-clear').length, 1, 'a pick grows the way back')

    await toggle(m)
    assert.ok(panel() === null, 'a press while open closes it again')
  })
})

describe('picking a range', () => {
  test('a hover previews nothing before the anchor and the end after it; the second click commits the sorted pair', async () => {
    const { m, changes } = await open()
    await toggle(m)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/)
    const untouched = cell(m, '2026-10-07').className
    await hover(cell(m, '2026-10-07'))
    assert.equal(cell(m, '2026-10-07').className, untouched, 'a hover before any anchor previews nothing')
    await click(cell(m, '2026-10-03'))
    assert.deepEqual(changes, [], 'the first click only anchors')
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
    assert.match(cell(m, '2026-10-03').className, /lc-dp-edge/, 'the anchor is the start until the end lands')
    assert.match(text(query(m.container, '.lc-dp-half')), /2026-10-03/, 'the head reads the anchor as it lands')

    await hover(cell(m, '2026-10-09'))
    assert.match(text(queryAll(m.container, '.lc-dp-half')[1]), /2026-10-09/, 'the head previews the end under the cursor')
    assert.match(cell(m, '2026-10-05').className, /lc-dp-in/, 'the band runs to the hovered day')
    assert.match(cell(m, '2026-10-09').className, /lc-dp-edge/, 'the hovered day previews where the end would land')
    await hover(cell(m, '2026-10-01'))
    assert.match(cell(m, '2026-10-02').className, /lc-dp-in/, 'hovering back past the anchor previews the swapped band')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-edge/, 'the swap moves the previewed end to the near side')
    await click(cell(m, '2026-10-09'))
    assert.deepEqual(changes, [{ from: '2026-10-03', to: '2026-10-09' }])
    assert.ok(panel() === null, 'the pick answers the page immediately')
  })

  test('a reversed pair sorts, and the same day twice is a one-day range', async () => {
    const reversed = await open()
    await toggle(reversed.m)
    await click(cell(reversed.m, '2026-10-09'))
    await click(cell(reversed.m, '2026-10-03'))
    assert.deepEqual(reversed.changes, [{ from: '2026-10-03', to: '2026-10-09' }])

    const same = await open()
    await toggle(same.m)
    await click(cell(same.m, '2026-10-05'))
    await click(cell(same.m, '2026-10-05'))
    assert.deepEqual(same.changes, [{ from: '2026-10-05', to: '2026-10-05' }])
  })

  test('the live scope opens highlighted; a future day and a blank pad are inert', async () => {
    const live = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(live.m)
    assert.match(cell(live.m, '2026-10-04').className, /lc-dp-in/)
    assert.match(cell(live.m, '2026-10-03').className, /lc-dp-edge/)
    assert.match(cell(live.m, '2026-10-06').className, /lc-dp-edge/)
    assert.match(cell(live.m, '2026-10-09').className, /lc-dp-today/)
    assert.match(cell(live.m, '2026-10-07').textContent ?? '', /^7$/, 'each cell prints its own day of the month')
    await click(cell(live.m, '2026-10-08'))
    assert.equal(cell(live.m, '2026-10-04').className.includes('lc-dp-in'), false)
    assert.match(text(query(panel()!, '.lc-dp-hint')), /end date/)
    await live.m.unmount()

    const future = await open()
    await toggle(future.m)
    const futureDay = cell(future.m, '2026-10-10')
    assert.match(futureDay.className, /lc-dp-future/)
    assert.equal(futureDay.getAttribute('aria-disabled'), 'true')
    await click(futureDay)
    assert.deepEqual(future.changes, [])
    assert.match(text(query(panel()!, '.lc-dp-hint')), /start date/, 'the future day did not anchor')
    await hover(futureDay)
    assert.ok(queryAll(panel()!, '.lc-dp-blank').length > 0, 'the month pads its weeks')
    await future.m.unmount()
  })

  test('the clear button hands the scope back to the presets', async () => {
    const { m, changes } = await open({ value: { from: '2026-10-03', to: '2026-10-06' }, picked: true })
    await toggle(m)
    await click(query(panel()!, '.lc-dp-clear'))
    assert.deepEqual(changes, [null])
  })
})

describe('the month nav', () => {
  test('steps a month at a time, stops at this month, and reopens on this month rather than the browsed one', async () => {
    const { m } = await open()
    await toggle(m)
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /2026/)
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'the panel opens on this month, so next is spent')

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), false, 'back a month, next serves again')
    await click(queryAll(panel()!, '.lc-dp-navbtn')[1])
    assert.equal(queryAll(panel()!, '.lc-dp-navbtn')[1].hasAttribute('disabled'), true, 'no month past this one')
    assert.equal(queryAll(panel()!, '.lc-dp-cell').length, 42, 'a six-week grid, the trailing all-blank week included')

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    const away = query(panel()!, '.lc-dp-month').textContent
    await toggle(m)
    await toggle(m)
    assert.notEqual(query(panel()!, '.lc-dp-month').textContent, away, 'the panel came back on today, not the browsed month')
    await m.unmount()

    const early = await open({ today: '1970-01-05' })
    await toggle(early.m)
    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(query(panel()!, '.lc-dp-month').textContent ?? '', /1970/)
  })

  test('a malformed today opens no panel and claims no expansion', async () => {
    const { m } = await open({ today: 'garbage' })
    await toggle(m)
    assert.ok(panel() === null)
    assert.equal(trigger(m).getAttribute('aria-expanded'), 'false', 'nothing rendered, so nothing reported as open')
  })
})

describe('the keyboard cursor', () => {
  test('arrows walk the shown month and Enter picks the day under them', async () => {
    const { m, changes } = await open()
    await toggle(m)
    const grid = query(panel()!, '.lc-dp-grid')
    assert.equal(grid.getAttribute('aria-activedescendant'), 'lc-dp-day')
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor opens on the month’s first day')

    await keydown('ArrowRight', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid)
    assert.match(cell(m, '2026-10-09').className, /lc-dp-cursor/)
    await keydown('ArrowUp', grid)
    assert.match(cell(m, '2026-10-02').className, /lc-dp-cursor/)
    await keydown('ArrowLeft', grid)
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/)

    await keydown('Enter', grid)
    await keydown(' ', grid)
    assert.deepEqual(changes, [{ from: '2026-10-01', to: '2026-10-01' }], 'Enter anchors, Space closes the pair')
  })

  test('the cursor never leaves the shown month or enters the future', async () => {
    const { m } = await open()
    await toggle(m)
    const grid = () => query(panel()!, '.lc-dp-grid')
    await keydown('ArrowUp', grid())
    assert.match(cell(m, '2026-10-01').className, /lc-dp-cursor/, 'the cursor stays inside the shown month')
    for (let i = 0; i < 40; i++) await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)
    await keydown('ArrowRight', grid())
    assert.match(cell(m, TODAY).className, /lc-dp-cursor/)

    await click(queryAll(panel()!, '.lc-dp-navbtn')[0])
    assert.match(cell(m, '2026-09-01').className, /lc-dp-cursor/, 'a month step re-seats the cursor on the 1st')
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-08').className, /lc-dp-cursor/)
    await keydown('ArrowDown', grid())
    assert.match(cell(m, '2026-09-15').className, /lc-dp-cursor/)
    await keydown('Tab', grid())
    await keydown('a', grid())
    assert.match(cell(m, '2026-09-15').className, /lc-dp-cursor/)
  })
})

describe('the panel seat', () => {
  test('sits under its trigger, inside the viewport, and flips when it would fall off', async () => {
    const size = { w: 240, h: 300 }
    const own = (name: string): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const width = own('offsetWidth')
    const height = own('offsetHeight')
    const restore = (name: string, was: PropertyDescriptor | undefined): void => {
      if (was === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
      else Object.defineProperty(HTMLElement.prototype, name, was)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => size.w })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => size.h })
    try {
      const { m } = await open()
      const rect = { left: 800, right: 900, top: 680, bottom: 700 }
      query(m.container, '.lc-dp').getBoundingClientRect = () =>
        ({ ...rect, x: rect.left, y: rect.top, width: 100, height: 20, toJSON: () => '' }) as DOMRect

      await toggle(m)
      const seated = panel()!
      assert.equal(seated.style.visibility, '', 'measured before paint, so no hidden stage is left')
      assert.notEqual(seated.style.left, '0px')
      assert.equal(seated.style.left, '660px', 'right-aligned to the trigger')
      assert.equal(seated.style.top, '374px', 'flipped above: below the trigger there is no room for 300px')

      rect.left = 10
      rect.right = 110
      await toggle(m)
      await toggle(m)
      const clamped = panel()!
      assert.equal(clamped.style.left, '8px', 'clamped inside the viewport')
      assert.equal(clamped.style.top, '374px')
    } finally {
      restore('offsetWidth', width)
      restore('offsetHeight', height)
    }
  })
})

describe('leaving the panel', () => {
  test('Escape closes it and puts focus back on the trigger', async () => {
    const { m } = await open()
    await toggle(m)
    trigger(m).focus()
    await keydown('Escape')
    assert.ok(panel() === null)
    assert.equal(document.activeElement?.className, trigger(m).className, 'focus comes back to the trigger')
  })

  test('a press outside closes it; presses inside the trigger tree or the panel, and a targetless event, do not', async () => {
    const { m } = await open()
    await toggle(m)
    await act(async () => { query(m.container, '.lc-dp').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'the tree the panel was opened from stays open')
    await m.unmount()
    const inside = await open()
    await toggle(inside.m)
    await act(async () => { cell(inside.m, '2026-10-03').dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'a press inside the portaled panel is not an outside press')
    await inside.m.unmount()
    const targetless = await open()
    await toggle(targetless.m)
    await fireWindow(new MouseEvent('mousedown'))
    assert.ok(panel() !== null, 'an event with no node target is ignored')
    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() === null)
    await targetless.m.unmount()
  })

  test('a scroll or a resize retracts it rather than floating off the anchor', async () => {
    const { m } = await open()
    await toggle(m)
    await fireWindow(new Event('scroll'))
    assert.ok(panel() === null)

    await toggle(m)
    await fireWindow(new Event('resize'))
    assert.ok(panel() === null)
  })
})
})

describe('clearableInput', () => {

function Field(props: {
  initial?: string
  type?: 'search' | 'text'
  onKeyDown?: (ev: ReactKeyboardEvent<HTMLInputElement>) => void
}): ReactElement {
  const [value, setValue] = useState(props.initial ?? '')
  return h(ClearableInput, {
    value,
    onChange: setValue,
    className: 'lc-fa-search',
    placeholder: 'Filter…',
    clearLabel: 'Clear input',
    ...(props.type !== undefined ? { type: props.type } : {}),
    ...(props.onKeyDown !== undefined ? { onKeyDown: props.onKeyDown } : {}),
  })
}

describe('ClearableInput', () => {
  test('an empty field shows no clear control until typing fills it', async () => {
    const m = await mount(h(Field, {}))
    const box = query(m.container, '.lc-searchbox')
    assert.equal(box.className, 'lc-searchbox')
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    const input = query<HTMLInputElement>(m.container, 'input')
    assert.equal(input.className, 'lc-fa-search')
    assert.equal(input.getAttribute('data-lc-clearable'), '')
    assert.equal(input.type, 'text')
    assert.equal(input.getAttribute('aria-label'), 'Filter…', 'the placeholder names the field')
    await typeText(input, 'worker')
    assert.equal(input.value, 'worker')
    assert.equal(box.className, 'lc-searchbox lc-searchbox-on')
    assert.equal(query<HTMLButtonElement>(m.container, '.lc-searchbox-x').getAttribute('aria-label'), 'Clear input')
    await m.unmount()

    const seen: string[] = []
    const ref = { current: null as HTMLInputElement | null }
    function Bound(): ReactElement {
      return h(ClearableInput, {
        value: 'x',
        onChange: () => {},
        className: 'lc-ov-search',
        placeholder: 'Search',
        clearLabel: 'Clear input',
        type: 'search',
        inputRef: ref,
        onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => { seen.push(ev.key) },
      })
    }
    const bound = await mount(h(Bound, {}))
    const boundInput = query<HTMLInputElement>(bound.container, 'input')
    assert.equal(boundInput.type, 'search')
    assert.equal(ref.current, boundInput)
    await keydown('Enter', boundInput)
    assert.deepEqual(seen, ['Enter'])
    await bound.unmount()
  })

  test('the clear control empties the field and keeps focus in the input', async () => {
    const m = await mount(h(Field, { initial: 'worker' }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const clear = query<HTMLButtonElement>(m.container, '.lc-searchbox-x')
    assert.equal(clear.type, 'button')
    assert.equal(clear.title, 'Clear input')
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true })
    await act(async () => { clear.dispatchEvent(down) })
    assert.equal(down.defaultPrevented, true, 'the press never steals focus from the input')
    await click(clear)
    assert.equal(input.value, '')
    assert.equal(document.activeElement, input)
    assert.equal(m.container.querySelector('.lc-searchbox-x'), null)
    await m.unmount()
  })

  test('Escape clears typed content and stays away from the host overlay', async () => {
    const m = await mount(h(Field, { initial: 'worker' }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const { ev, reachedDocument } = await press(input, { key: 'Escape' })
    assert.equal(input.value, '')
    assert.equal(ev.defaultPrevented, true)
    assert.equal(reachedDocument, false, 'the overlay must not also close')
    await m.unmount()
  })

  test('Escape leaves an empty, composing, or modifier-held field to the host', async () => {
    const empty = await mount(h(Field, {}))
    const emptyInput = query<HTMLInputElement>(empty.container, 'input')
    const emptyEsc = await press(emptyInput, { key: 'Escape' })
    assert.equal(emptyEsc.ev.defaultPrevented, false)
    assert.equal(emptyEsc.reachedDocument, true)
    await empty.unmount()

    const filled = await mount(h(Field, { initial: 'x' }))
    const input = query<HTMLInputElement>(filled.container, 'input')
    const composing = await press(input, { key: 'Escape', isComposing: true })
    assert.equal(input.value, 'x', 'Escape during IME composition stays with the IME')
    assert.equal(composing.ev.defaultPrevented, false)
    assert.equal(composing.reachedDocument, true)
    const modifiers: KeyboardEventInit[] = [{ shiftKey: true }, { ctrlKey: true }, { altKey: true }, { metaKey: true }]
    for (const init of modifiers) {
      const { ev, reachedDocument } = await press(input, { key: 'Escape', ...init })
      assert.equal(input.value, 'x')
      assert.equal(ev.defaultPrevented, false)
      assert.equal(reachedDocument, true)
    }
    await filled.unmount()
  })

  test("a caller's preventDefault wins over Escape clearing", async () => {
    const m = await mount(h(Field, {
      initial: 'x',
      onKeyDown: (ev: ReactKeyboardEvent<HTMLInputElement>) => { if (ev.key === 'Escape') ev.preventDefault() },
    }))
    const input = query<HTMLInputElement>(m.container, 'input')
    const { ev, reachedDocument } = await press(input, { key: 'Escape' })
    assert.equal(input.value, 'x')
    assert.equal(ev.defaultPrevented, true)
    assert.equal(reachedDocument, true, 'the caller only prevented the default action')
    await m.unmount()
  })
})
})
