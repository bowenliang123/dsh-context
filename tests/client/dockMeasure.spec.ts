// measureDock (src/client/dockMeasure.ts) — the /context modal's sidebar
// inset: the ancestor walk to the app frame's inline grid template, the
// leading-px parse, and every degrade-to-full-mask branch.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { measureDock } from '../../src/client/dockMeasure'

const TEMPLATE = '280px minmax(0, 1fr) 360px'

/** A start element buried at the bottom of an ancestor chain (outermost first). */
function chainOf(...ancestors: HTMLElement[]): HTMLElement {
  for (let i = 0; i < ancestors.length - 1; i++) ancestors[i].appendChild(ancestors[i + 1])
  return ancestors[ancestors.length - 1]
}

function frameEl(template: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.gridTemplateColumns = template
  return el
}

describe('measureDock', () => {
  test('resolves to the full mask without a start element', () => {
    assert.deepEqual(measureDock(null), { left: 0, frame: null })
  })

  test('resolves to the full mask when no ancestor carries an inline template', () => {
    const start = chainOf(document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, frame: null })
  })

  test('parses the leading px track off the frame ancestor', () => {
    const frame = frameEl(TEMPLATE)
    const start = chainOf(frame, document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, frame })
  })

  test('parses a fractional track and a collapsed 0px rail', () => {
    const frame = frameEl('264.5px minmax(0, 1fr) 0px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 264.5, frame })

    assert.deepEqual(measureDock(chainOf(frameEl('0px minmax(0, 1fr) 0px'), document.createElement('div'))).left, 0)
  })

  test('resolves to the full mask when the frame template is unparsable', () => {
    for (const template of ['', 'minmax(0, 1fr)', 'auto 1fr']) {
      const start = chainOf(frameEl(template), document.createElement('div'))
      assert.deepEqual(measureDock(start), { left: 0, frame: null })
    }
  })

  test('a hostile ancestor degrades to the full mask instead of throwing', () => {
    const hostile = document.createElement('div')
    Object.defineProperty(hostile, 'style', { get() { throw new Error('hostile') } })
    const start = chainOf(hostile, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, frame: null })
  })
})
