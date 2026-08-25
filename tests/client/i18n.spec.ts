// Dictionaries (src/client/i18n.ts): both locales carry exactly the same
// keys, every value is a non-empty string, and interpolation placeholders
// agree between locales for every parametrized key.

import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

describe('dictionaries', () => {
  test('zh and en carry exactly the same key set', () => {
    assert.deepEqual(Object.keys(DICT_ZH).sort(), Object.keys(DICT_EN).sort())
  })

  test('every value is a non-empty string', () => {
    for (const dict of [DICT_ZH, DICT_EN]) {
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', key)
        assert.ok(value.length > 0, key)
      }
    }
  })

  test('interpolation placeholders agree between locales for every key', () => {
    for (const key of Object.keys(DICT_EN)) {
      // 'block.line' is the one documented asymmetry: the en singular form
      // is the fixed literal '1 line' while zh keeps the {n} measure word.
      if (key === 'block.line') {
        assert.deepEqual(placeholders(DICT_ZH[key]), ['n'])
        assert.deepEqual(placeholders(DICT_EN[key]), [])
        continue
      }
      assert.deepEqual(placeholders(DICT_ZH[key]), placeholders(DICT_EN[key]), key)
    }
  })
})
