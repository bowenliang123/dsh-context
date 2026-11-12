import { act, createElement as h, useState, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { StepPick } from '../../../src/client/components/browserPick'
import type { StepPickOption } from '../../../src/client/components/browserHelpers'
import { click, hover, keydown, mount, press, query, queryAll, text, typeText, type Mounted } from '../helpers/kit'

const OPTIONS = [
  { value: 'live', label: 'Live' },
  { value: '20', label: 'T2 · S0' },
  { value: '10', label: 'T1 · S0' },
]

function searchOptions(queryText: string): StepPickOption[] {
  const q = queryText.trim().toLowerCase()
  return OPTIONS.filter(option => `${option.label} ${option.value}`.toLowerCase().includes(q))
}

function Harness(props: { initial?: string; onChange?: (next: string) => void }): ReactElement {
  const [value, setValue] = useState(props.initial ?? 'live')
  return h(StepPick, {
    value,
    options: OPTIONS,
    search: searchOptions,
    searchPlaceholder: 'Filter steps…',
    emptyLabel: 'No matching steps',
    clearLabel: 'Clear input',
    ariaLabel: 'Pick a step',
    onChange: (next) => { setValue(next); props.onChange?.(next) },
  })
}

function trigger(m: Mounted): HTMLButtonElement {
  return query<HTMLButtonElement>(m.container, '.lc-br-pick')
}

function search(m: Mounted): HTMLInputElement {
  return query<HTMLInputElement>(m.container, '.lc-br-pick-search')
}

function labels(m: Mounted): string[] {
  return queryAll(m.container, '.lc-br-pick-opt').map(option => text(option))
}

describe('StepPick', () => {
  test('opens a searchable list, marks the current step, and picks a row', async () => {
    const changed: string[] = []
    const m = await mount(h(Harness, { onChange: (next) => { changed.push(next) } }))
    try {
      assert.equal(trigger(m).dataset.value, 'live')
      assert.equal(text(trigger(m)), 'Live')
      assert.equal(trigger(m).getAttribute('aria-label'), 'Pick a step: Live')
      await click(trigger(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
      assert.equal(document.activeElement, search(m), 'the filter takes the keyboard on open')
      assert.deepEqual(labels(m), ['Live', 'T2 · S0', 'T1 · S0'])
      const selected = query(m.container, '.lc-br-pick-opt[data-value="live"]')
      assert.equal(selected.getAttribute('aria-selected'), 'true')
      assert.equal(selected.getAttribute('tabindex'), '-1')
      assert.equal(search(m).getAttribute('role'), 'combobox')
      assert.equal(search(m).getAttribute('aria-expanded'), 'true')
      assert.equal(search(m).getAttribute('aria-controls'), query(m.container, '.lc-br-pick-list').id)
      assert.equal(search(m).getAttribute('aria-activedescendant'), selected.id)
      await click(query(m.container, '.lc-br-pick-opt[data-value="20"]'))
      assert.deepEqual(changed, ['20'])
      assert.equal(trigger(m).dataset.value, '20')
      assert.equal(m.container.querySelector('.lc-br-pick-list'), null)
      assert.equal(document.activeElement, trigger(m), 'the pick hands focus back to the trigger')
    } finally {
      await m.unmount()
    }
  })

  test('the trigger opens from the arrow keys and ignores other keys', async () => {
    const m = await mount(h(Harness, {}))
    try {
      await keydown('Escape', trigger(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
      await keydown('ArrowDown', trigger(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
      await keydown('Escape', search(m))
      await keydown('ArrowUp', trigger(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'true')
    } finally {
      await m.unmount()
    }
  })

  test('filters by label or seq, clears on the first Escape, and closes on the second', async () => {
    const m = await mount(h(Harness, {}))
    try {
      await click(trigger(m))
      await typeText(search(m), 'T2')
      assert.deepEqual(labels(m), ['T2 · S0'])
      await typeText(search(m), '20')
      assert.deepEqual(labels(m), ['T2 · S0'], 'the seq itself matches too')
      await typeText(search(m), 'zzz')
      assert.deepEqual(labels(m), [])
      assert.ok(text(m.container).includes('No matching steps'))
      await keydown('Escape', search(m))
      assert.equal(search(m).value, '', 'the first Escape clears the filter')
      assert.equal(queryAll(m.container, '.lc-br-pick-opt').length, 3)
      await keydown('Escape', search(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
      assert.equal(document.activeElement, trigger(m))
    } finally {
      await m.unmount()
    }
  })

  test('walks the highlighted row with the arrow keys and settles it with Enter', async () => {
    const changed: string[] = []
    const m = await mount(h(Harness, { onChange: (next) => { changed.push(next) } }))
    try {
      await click(trigger(m))
      await keydown('ArrowUp', search(m))
      assert.ok(query(m.container, '.lc-br-pick-opt[data-value="10"]').className.includes('lc-br-pick-opt-on'), 'ArrowUp wraps to the last row')
      await keydown('ArrowDown', search(m))
      assert.ok(query(m.container, '.lc-br-pick-opt[data-value="live"]').className.includes('lc-br-pick-opt-on'), 'ArrowDown wraps to the first row')
      await keydown('ArrowDown', search(m))
      await keydown('Enter', search(m))
      assert.deepEqual(changed, ['20'])
      assert.equal(trigger(m).dataset.value, '20')
    } finally {
      await m.unmount()
    }
  })

  test('an empty filter ignores the arrow keys and Enter, and Tab leaves the list', async () => {
    const changed: string[] = []
    const m = await mount(h(Harness, { onChange: (next) => { changed.push(next) } }))
    try {
      await click(trigger(m))
      await typeText(search(m), 'zzz')
      await keydown('ArrowDown', search(m))
      await keydown('ArrowUp', search(m))
      await keydown('Enter', search(m))
      assert.deepEqual(changed, [], 'nothing to settle in an empty list')
      const tab = await press(search(m), { key: 'Tab' })
      assert.equal(tab.reachedDocument, true, 'Tab keeps its native traversal')
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    } finally {
      await m.unmount()
    }
  })

  test('dismisses on an outside press, toggles from the trigger, and ignores a non-node target', async () => {
    const m = await mount(h(Harness, {}))
    try {
      await click(trigger(m))
      await act(async () => { trigger(m).dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'true', 'a press inside the control keeps it open')
      await click(trigger(m))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false', 'a second trigger click closes')
      await click(trigger(m))
      window.dispatchEvent(new MouseEvent('pointerdown'))
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'true', 'a window target is not an outside press')
      await act(async () => { document.body.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true })) })
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    } finally {
      await m.unmount()
    }
  })

  test('a viewport resize closes the list', async () => {
    const m = await mount(h(Harness, {}))
    try {
      await click(trigger(m))
      await act(async () => { window.dispatchEvent(new Event('resize')) })
      assert.equal(trigger(m).getAttribute('aria-expanded'), 'false')
    } finally {
      await m.unmount()
    }
  })

  test('hover moves the highlight, a value outside the window still shows, and rows scroll into view', async () => {
    const scroll = vi.fn()
    const original = Element.prototype.scrollIntoView
    const m = await mount(h(Harness, { initial: '99' }))
    try {
      Element.prototype.scrollIntoView = scroll
      assert.equal(text(trigger(m)), '99', 'a value outside the window still shows')
      await click(trigger(m))
      assert.ok(scroll.mock.calls.length > 0, 'the list scrolls the highlighted row into view')
      await hover(query(m.container, '.lc-br-pick-opt[data-value="10"]'))
      assert.ok(query(m.container, '.lc-br-pick-opt[data-value="10"]').className.includes('lc-br-pick-opt-on'))
    } finally {
      await m.unmount()
      Element.prototype.scrollIntoView = original
    }
  })
})
