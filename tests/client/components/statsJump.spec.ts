// StatsJump (src/client/components/statsJump.tsx) — the stats-line jump:
// the invisible dock anchor decorates the harness stats row beside it, the
// row's click/keys open the Context tab through the real viewFocus module,
// and every hostile or absent dock shape degrades to a silent feature-off.
// jsdom supplies the real dock DOM and its live MutationObserver.

import assert from 'node:assert/strict'
import { act } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, test } from 'vitest'
import { makeStatsJump, statsRowOf, wireDock } from '../../../src/client/components/statsJump'
import { DICT_EN } from '../../../src/client/i18n'
import { h } from '../../../src/client/react'
import { makeKit } from '../helpers/kit'

const StatsJump = makeStatsJump(makeKit())

/** Let jsdom deliver pending MutationObserver records. */
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

/** A bare dock element carrying `rowCount` shipped stats rows. */
function dockEl(rowCount = 1): { dock: HTMLElement; rows: HTMLElement[] } {
  const dock = document.createElement('div')
  dock.setAttribute('data-slot', 'conversation.composer.dock')
  const rows: HTMLElement[] = []
  for (let i = 0; i < rowCount; i++) {
    const row = document.createElement('div')
    row.textContent = `1 turns · ${i + 1} steps`
    dock.appendChild(row)
    rows.push(row)
  }
  document.body.appendChild(dock)
  return { dock, rows }
}

/**
 * A faithful dock for the full component: the harness slot anchor rendered
 * by React in ONE commit — the shipped stats row(s) and the plugin entry as
 * siblings inside it, the way the conversation shell mounts them (rendering
 * straight into a pre-populated container would let React 18 clear the
 * pre-existing row). `renderRows` re-renders to simulate the stats row
 * mounting, unmounting, or being replaced by its own entry.
 */
async function mountDock(rowCount = 1): Promise<{
  dock: HTMLElement
  rows(): HTMLElement[]
  renderRows(count: number): Promise<void>
  un(): Promise<void>
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const renderRows = async (count: number): Promise<void> => {
    const rows: ReactNode[] = []
    for (let i = 0; i < count; i++) rows.push(h('div', { key: i }, `1 turns · ${i + 1} steps`))
    await act(async () => {
      root.render(h('div', { 'data-slot': 'conversation.composer.dock' }, ...rows, h(StatsJump, {})))
    })
  }
  const un = async (): Promise<void> => {
    await act(async () => {
      root.unmount()
    })
    container.remove()
  }
  await renderRows(rowCount)
  const dock = container.firstElementChild as HTMLElement
  const rows = (): HTMLElement[] =>
    [...dock.children].filter(el => !el.classList.contains('lc-stats-jump') && el.getAttribute('role') !== 'tooltip') as HTMLElement[]
  return { dock, rows, renderRows, un }
}

/** A Context tab button the jump can activate, with its native click count. */
function contextTab(): { el: HTMLButtonElement; count(): number } {
  const el = document.createElement('button')
  el.setAttribute('role', 'tab')
  el.textContent = 'Context'
  let n = 0
  el.addEventListener('click', () => { n++ })
  document.body.appendChild(el)
  return { el, count: () => n }
}

/** The full decoration the wiring must leave on a live stats row. */
function assertWired(row: Element): void {
  assert.ok(row.classList.contains('lc-stats-jump-row'), 'the row carries the jump class')
  assert.equal(row.getAttribute('role'), 'button')
  assert.equal(row.getAttribute('tabindex'), '0')
  assert.equal(row.getAttribute('aria-label'), DICT_EN['jump.statsLine'])
}

describe('statsRowOf', () => {
  afterEach(() => {
    document.body.textContent = ''
  })

  test('answers the single non-bubble element child beside the anchor', () => {
    const { dock, rows } = dockEl()
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    const bubble = document.createElement('span')
    bubble.setAttribute('role', 'tooltip')
    dock.appendChild(bubble)
    assert.equal(statsRowOf(anchor), rows[0])
  })

  test('answers null for a detached anchor and for ambiguous docks', () => {
    assert.equal(statsRowOf(document.createElement('span')), null)
    const { dock } = dockEl(2)
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    assert.equal(statsRowOf(anchor), null, 'two live candidates: decorate nothing')
  })

  test('skips a hostile child that throws on attribute access', () => {
    const { dock, rows } = dockEl()
    const hostile = document.createElement('div')
    Object.defineProperty(hostile, 'getAttribute', { get() { throw new Error('boom') } })
    dock.appendChild(hostile)
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    assert.equal(statsRowOf(anchor), rows[0])
  })
})

describe('wireDock', () => {
  afterEach(() => {
    document.body.textContent = ''
  })

  test('a missing or detached anchor wires nothing and stays a no-op teardown', () => {
    assert.doesNotThrow(wireDock(null, 'label', () => {}))
    const lone = document.createElement('i')
    let activated = 0
    const off = wireDock(lone, 'label', () => { activated++ })
    lone.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(activated, 0)
    assert.doesNotThrow(off)
  })

  test('a row that throws at the first mark stays unwired and swallows the throw', () => {
    const { dock, rows } = dockEl()
    const { count } = contextTab()
    Object.defineProperty(rows[0], 'classList', { get() { throw new Error('boom') } })
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    const teardown = wireDock(anchor, 'label', () => {})
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 0, 'no listener survived the failed wiring')
    assert.equal(rows[0].getAttribute('role'), null)
    teardown()
  })

  test('a row that throws partway leaves a half-dressed row with no active jump', () => {
    const { dock, rows } = dockEl()
    const { count } = contextTab()
    Object.defineProperty(rows[0], 'setAttribute', { get() { throw new Error('boom') } })
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    const teardown = wireDock(anchor, 'label', () => {})
    assert.ok(rows[0].classList.contains('lc-stats-jump-row'), 'the class mark landed before the throw')
    assert.equal(rows[0].getAttribute('role'), null)
    rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 0)
    teardown()
  })

  test('an exotic non-HTML candidate is not the stats row: feature off', () => {
    const { dock } = dockEl(0)
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    dock.appendChild(svg)
    const anchor = document.createElement('span')
    dock.appendChild(anchor)
    const teardown = wireDock(anchor, 'label', () => {})
    assert.equal(svg.getAttribute('role'), null)
    teardown()
  })
})

describe('StatsJump — wiring and activation', () => {
  afterEach(() => {
    document.body.textContent = ''
  })

  test('renders only an invisible anchor beside the row', async () => {
    const { dock, un } = await mountDock()
    const anchor = dock.querySelector('span.lc-stats-jump')
    assert.ok(anchor !== null)
    assert.equal(anchor.getAttribute('hidden'), '')
    assert.equal(anchor.getAttribute('aria-hidden'), 'true')
    assert.equal(anchor.textContent, '')
    await un()
  })

  test('decorates the row at mount; click and Enter/Space open the Context tab', async () => {
    const { rows, un } = await mountDock()
    const { count } = contextTab()
    const row = rows()[0]
    assert.ok(row !== undefined)
    assertWired(row)

    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 1, 'a plain click activates the jump')

    const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    row.dispatchEvent(enter)
    assert.equal(count(), 2)
    assert.ok(enter.defaultPrevented)

    const space = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true })
    row.dispatchEvent(space)
    assert.equal(count(), 3)
    assert.ok(space.defaultPrevented, 'space does not scroll the page')

    const other = new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true })
    row.dispatchEvent(other)
    assert.equal(count(), 3, 'other keys do not activate')
    assert.ok(!other.defaultPrevented)
    await un()
  })

  test('a stats row that mounts after the entry is spotted through the observer', async () => {
    const { dock, un } = await mountDock(0)
    const { count } = contextTab()
    const row = document.createElement('div')
    row.textContent = '1 turns · 1 steps'
    dock.appendChild(row)
    await tick()
    assertWired(row)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 1)
    await un()
  })

  test('tooltip-bubble churn keeps exactly one listener on the row', async () => {
    const { dock, rows, un } = await mountDock()
    const { count } = contextTab()
    const bubble = document.createElement('span')
    bubble.setAttribute('role', 'tooltip')
    dock.appendChild(bubble)
    await tick()
    dock.removeChild(bubble)
    await tick()
    const row = rows()[0]
    assert.ok(row !== undefined)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 1, 'the rescans rewired nothing')
    await un()
  })

  test('a replaced row is unwired whole and its successor takes over', async () => {
    const { dock, rows, renderRows, un } = await mountDock()
    const { count } = contextTab()
    const retired = rows()[0]
    assert.ok(retired !== undefined)
    assertWired(retired)
    await renderRows(0)
    const fresh = document.createElement('div')
    dock.appendChild(fresh)
    await tick()
    assert.equal(retired.className, '', 'the retired row is stripped clean')
    assert.equal(retired.getAttribute('role'), null)
    retired.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 0, 'the retired row lost its listener')
    assertWired(fresh)
    fresh.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 1)
    assert.equal(rows().length, 1, 'only the fresh row remains a candidate')
    await un()
  })

  test('an ambiguous dock decorates nothing', async () => {
    const { rows, un } = await mountDock(2)
    for (const row of rows()) assert.equal(row.getAttribute('role'), null)
    await un()
  })

  test('a drag-selection click does not switch tabs', async () => {
    const { rows, un } = await mountDock()
    const { count } = contextTab()
    const row = rows()[0]
    assert.ok(row !== undefined)
    const doc = document as unknown as { getSelection: () => unknown }
    const original = doc.getSelection
    doc.getSelection = () => ({ isCollapsed: false })
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 0, 'an open selection swallows the click')
    doc.getSelection = original
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 1, 'a clean click still activates')
    await un()
  })

  test('unmount strips the marks, the listeners, and the observer', async () => {
    const { dock, rows, un } = await mountDock()
    const { count } = contextTab()
    const row = rows()[0]
    assert.ok(row !== undefined)
    assertWired(row)
    await un()
    assert.equal(row.className, '')
    assert.equal(row.getAttribute('role'), null)
    assert.equal(row.getAttribute('tabindex'), null)
    assert.equal(row.getAttribute('aria-label'), null)
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    assert.equal(count(), 0, 'the listener went with the wiring')
    const fresh = document.createElement('div')
    dock.appendChild(fresh)
    await tick()
    assert.equal(fresh.className, '', 'the disconnected observer decorates nothing')
  })
})
