// SettingsCard (src/client/components/settingsCard.tsx) rendered with real
// React against the real DICT_EN strings; the select rows open the REAL
// Menu primitive (portaled into document.body) and pick through it.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { h } from '../../../src/client/react'
import { makeSettingsCard } from '../../../src/client/components/settingsCard'
import type { SettingsState } from '../../../src/client/settings'
import { DICT_EN } from '../../../src/client/i18n'
import { click, keydown, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()
const SettingsCard = makeSettingsCard(kit)

function hookFor(state: SettingsState) {
  return <T,>(sel: (s: SettingsState) => T): T => sel(state)
}

function stateOf(partial: Partial<SettingsState> = {}): SettingsState {
  return { status: 'ready', granularity: 'step', mode: 'total', writable: true, ...partial }
}

/** Menu items portaled into document.body while a select is open. */
function menuItems(): HTMLElement[] {
  return queryAll(document.body, '[role="menu"] [role="menuitem"]')
}

describe('SettingsCard', () => {
  test('renders nothing without a settings hook or when the namespace is unavailable', async () => {
    const m1 = await mount(h(SettingsCard, {}))
    assert.equal(m1.container.childElementCount, 0)
    await m1.unmount()

    const m2 = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ status: 'unavailable' })) }))
    assert.equal(m2.container.childElementCount, 0)
    await m2.unmount()
  })

  test('loading state renders the card with disabled selects; the head toggles the body', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ status: 'loading', writable: false })) }))
    const card = query(m.container, '.lc-settings-card')
    assert.ok(!card.className.includes('lc-settings-open'))
    const head = query(m.container, '.lc-settings-head')
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    assert.equal(head.getAttribute('aria-label'), `${DICT_EN['settings.expand']}: ${DICT_EN['settings.title']}`)
    assert.ok(text(m.container).includes(DICT_EN['settings.desc']))
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 0)

    await click(head)
    assert.equal(head.getAttribute('aria-expanded'), 'true')
    assert.equal(head.getAttribute('aria-label'), `${DICT_EN['settings.collapse']}: ${DICT_EN['settings.title']}`)
    assert.ok(card.className.includes('lc-settings-open'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.equal(selects.length, 2)
    assert.ok(selects.every(s => (s as HTMLButtonElement).disabled))
    // Loading is not ready: no read-only note.
    assert.equal(m.container.querySelector('.lc-settings-note'), null)

    await click(head)
    assert.equal(head.getAttribute('aria-expanded'), 'false')
    assert.ok(!card.className.includes('lc-settings-open'))
    assert.equal(queryAll(m.container, '.lc-settings-select').length, 0)
    await m.unmount()
  })

  test('ready+writable: enabled selects pick through the real portaled Menu', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll<HTMLButtonElement>(m.container, '.lc-settings-select')
    assert.ok(selects.every(s => !s.disabled))
    assert.equal(m.container.querySelector('.lc-settings-note'), null)
    // Active option labels resolve through the options list.
    assert.ok(text(selects[0]).includes(DICT_EN['gran.step']))
    assert.ok(text(selects[1]).includes(DICT_EN['gran.total']))

    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    const items = menuItems()
    assert.equal(items.length, 2)
    assert.deepEqual(items.map(i => text(i)), [DICT_EN['gran.step'], DICT_EN['gran.turn']])

    await click(items[1]) // 'Turn'
    assert.deepEqual(calls, [['defaultGranularity', 'turn']])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // The trend-mode row writes the other field.
    await click(selects[1])
    const modeItems = menuItems()
    assert.deepEqual(modeItems.map(i => text(i)), [DICT_EN['gran.total'], DICT_EN['gran.delta']])
    await click(modeItems[1]) // 'Delta'
    assert.deepEqual(calls, [['defaultGranularity', 'turn'], ['defaultTrendMode', 'delta']])
    assert.equal(document.body.querySelector('[role="menu"]'), null)

    // Anchor toggles shut too (setOpen(v => !v) back edge).
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'true')
    await click(selects[0])
    assert.equal(selects[0].getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })

  test('Menu onClose (Escape) closes an open select without picking', async () => {
    const calls: [string, string][] = []
    const m = await mount(h(SettingsCard, {
      useContextSettings: hookFor(stateOf()),
      set: (field, value) => { calls.push([field, value]) },
    }))
    await click(query(m.container, '.lc-settings-head'))
    const select = query(m.container, '.lc-settings-select')
    await click(select)
    assert.equal(select.getAttribute('aria-expanded'), 'true')
    assert.equal(menuItems().length, 2)
    await keydown('Escape', document.body)
    assert.equal(select.getAttribute('aria-expanded'), 'false')
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    assert.deepEqual(calls, [])
    await m.unmount()
  })

  test('ready+readonly: disabled selects and the read-only note when open', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ writable: false })) }))
    // Note only renders once the body is open.
    await click(query(m.container, '.lc-settings-head'))
    const note = query(m.container, '.lc-settings-note')
    assert.equal(note.getAttribute('role'), 'status')
    assert.equal(text(note), DICT_EN['settings.readOnly'])
    assert.ok(queryAll<HTMLButtonElement>(m.container, '.lc-settings-select').every(s => s.disabled))
    await m.unmount()
  })

  test('a value matching no option falls back to the raw id; a missing set never throws', async () => {
    const m = await mount(h(SettingsCard, { useContextSettings: hookFor(stateOf({ granularity: 'weird' as never })) }))
    await click(query(m.container, '.lc-settings-head'))
    const selects = queryAll(m.container, '.lc-settings-select')
    assert.ok(text(selects[0]).includes('weird'))
    // props.set undefined: picking still closes the menu, no throw.
    await click(selects[0])
    await click(menuItems()[1])
    assert.equal(document.body.querySelector('[role="menu"]'), null)
    await m.unmount()
  })
})
