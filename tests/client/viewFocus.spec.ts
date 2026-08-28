// viewFocus (src/client/viewFocus.ts) — the chat→Context jump relay and the
// Context-tab activation, driven against a real jsdom tab bar.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { activateContextTab, requestContextFocus, takeContextFocus } from '../../src/client/viewFocus'

describe('context focus relay', () => {
  test('one request survives until taken, then the map entry is consumed', () => {
    requestContextFocus('sv-relay', 42)
    assert.equal(takeContextFocus('sv-relay'), 42)
    assert.equal(takeContextFocus('sv-relay'), null, 'one-shot: a second take finds nothing')
  })

  test('a fresh request replaces an unconsumed one; sessions are isolated', () => {
    requestContextFocus('sv-race', 7)
    requestContextFocus('sv-race', 9)
    assert.equal(takeContextFocus('sv-race'), 9, 'the latest click wins')
    requestContextFocus('sv-other', 1)
    assert.equal(takeContextFocus('sv-other'), 1)
    assert.equal(takeContextFocus('sv-unknown'), null)
  })
})

describe('activateContextTab', () => {
  test('clicks the inactive tab matching the label, skips the active one, and reports misses', () => {
    type Counted = HTMLElement & { __clicks: () => number }
    const bar = document.createElement('div')
    const mk = (label: string, selected: boolean): Counted => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      if (selected) b.setAttribute('aria-selected', 'true')
      b.textContent = label
      let clicks = 0
      b.addEventListener('click', () => { clicks++ })
      const counted = Object.assign(b, { __clicks: () => clicks })
      bar.appendChild(counted)
      return counted
    }
    const chat = mk('Chat', true)
    const context = mk('Context', false)
    const trajectory = mk('Trajectory', false)
    document.body.appendChild(bar)
    try {
      assert.equal(activateContextTab('Context'), true)
      assert.equal(context.__clicks(), 1)
      assert.equal(chat.__clicks(), 0)

      // Already-active: reported success without a redundant click.
      context.setAttribute('aria-selected', 'true')
      assert.equal(activateContextTab('Context'), true)
      assert.equal(context.__clicks(), 1)

      // Whitespace-padded label text still matches the trimmed comparison.
      context.setAttribute('aria-selected', 'false')
      context.textContent = '  Context '
      assert.equal(activateContextTab('Context'), true)
      assert.equal(context.__clicks(), 2)

      // No tab carries the label → nothing clicked, false.
      assert.equal(activateContextTab('Missing'), false)
      assert.equal(trajectory.__clicks(), 0)
    } finally {
      bar.remove()
    }
  })
})
