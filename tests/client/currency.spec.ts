// The display-currency preference store (src/client/currency.ts): the language rule under `auto`,
// the explicit override, and the subscription that repaints an open figure.

import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'vitest'
import { displayCurrencyFor, resetDisplayCurrencyPreference, setDisplayCurrencyPreference, useDisplayCurrency } from '../../src/client/currency'
import { resolveCurrency } from '../../src/client/cost'
import { mount, text } from './helpers/kit'

afterEach(() => {
  resetDisplayCurrencyPreference()
})

describe('resolveCurrency', () => {
  test('auto follows the language rule, including a plain locale code', () => {
    assert.equal(resolveCurrency('auto', 'zh'), 'cny')
    assert.equal(resolveCurrency('auto', 'en'), 'usd')
    assert.equal(resolveCurrency('auto', 'ru'), 'usd')
  })

  test('a locale service without getLocale reads as en', () => {
    assert.equal(resolveCurrency('auto', {} as never), 'usd')
  })

  test('an explicit preference overrides the locale', () => {
    assert.equal(resolveCurrency('cny', 'en'), 'cny')
    assert.equal(resolveCurrency('usd', 'zh'), 'usd')
  })
})

describe('useDisplayCurrency', () => {
  test('the preference change repaints the mounted figure', async () => {
    function Probe(): ReturnType<typeof h> {
      return h('span', null, useDisplayCurrency('en'))
    }
    const m = await mount(h(Probe))
    assert.equal(text(m.container), 'usd')
    await act(async () => { setDisplayCurrencyPreference('cny') })
    assert.equal(text(m.container), 'cny')
    await act(async () => { setDisplayCurrencyPreference('auto') })
    assert.equal(text(m.container), 'usd')
    await m.unmount()
  })

  test('displayCurrencyFor reads the same store', () => {
    setDisplayCurrencyPreference('cny')
    assert.equal(displayCurrencyFor('en'), 'cny')
    resetDisplayCurrencyPreference()
    assert.equal(displayCurrencyFor('zh'), 'cny')
  })
})
