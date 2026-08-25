// ErrorBoundary (src/client/components/errorBoundary.tsx): real subtree
// errors degrade to the styled error card; Retry resets the boundary.
// React logs caught errors to console — silenced with a spy, never mocked.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { h } from '../../../src/client/react'
import { makeErrorBoundary } from '../../../src/client/components/errorBoundary'
import { click, makeKit, mount, query, text } from '../helpers/kit'

const kit = makeKit()
const ErrorBoundary = makeErrorBoundary(kit.t)

let consoleSpy: ReturnType<typeof vi.spyOn> | null = null

afterEach(() => {
  consoleSpy?.mockRestore()
  consoleSpy = null
})

function silenceConsoleError(): void {
  consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
}

describe('ErrorBoundary', () => {
  test('passes children through when nothing throws', async () => {
    const m = await mount(h(ErrorBoundary, {}, h('div', { className: 'healthy' }, 'all good')))
    assert.equal(text(m.container), 'all good')
    await m.unmount()
  })

  test('a render error degrades to the error card; Retry resumes a healthy child', async () => {
    silenceConsoleError()
    let shouldThrow = true
    function Bomb() {
      if (shouldThrow) throw new Error('kaboom')
      return h('div', { className: 'healthy' }, 'recovered')
    }
    const m = await mount(h(ErrorBoundary, {}, h(Bomb, {})))
    const card = query(m.container, '.lc-error')
    assert.ok(text(card).includes('Failed to read context data:'))
    assert.equal(query(card, '.lc-error-msg').textContent, 'kaboom')
    const retry = query(card, '.lc-error-retry')
    assert.equal(retry.textContent, 'Retry')
    shouldThrow = false
    await click(retry)
    assert.equal(text(m.container), 'recovered')
    await m.unmount()
  })

  test('a non-Error throw is stringified into the card', async () => {
    silenceConsoleError()
    function Bomb(): never {
      throw 'string failure' // deliberate non-Error throw
    }
    const m = await mount(h(ErrorBoundary, {}, h(Bomb, {})))
    assert.equal(query(m.container, '.lc-error-msg').textContent, 'string failure')
    await m.unmount()
  })
})
