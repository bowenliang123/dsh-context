// The platform React module table (src/client/react.ts): the plugin's React
// is the real react module, h creates elements, and ReactDOM exposes portals.

import assert from 'node:assert/strict'
import { createElement } from 'react'
import { describe, test } from 'vitest'
import { h, React, ReactDOM } from '../../src/client/react'

describe('react module table', () => {
  test('React is the real react module', () => {
    assert.equal(React.createElement, createElement)
  })

  test('h creates elements', () => {
    // Viewed structurally: React's public types hide $$typeof and the
    // children prop slot, but both are part of the real element shape.
    const el = h('div', { className: 'box' }, 'hi') as unknown as {
      $$typeof: symbol
      type: unknown
      props: Record<string, unknown>
    }
    assert.equal(el.$$typeof, Symbol.for('react.element'))
    assert.equal(el.type, 'div')
    assert.equal(el.props.className, 'box')
    assert.equal(el.props.children, 'hi')
  })

  test('ReactDOM exposes createPortal', () => {
    assert.equal(typeof ReactDOM.createPortal, 'function')
  })
})
