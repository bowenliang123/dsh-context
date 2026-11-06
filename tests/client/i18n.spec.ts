import assert from 'node:assert/strict'
import { describe, test } from 'vitest'
import { DICTS, DICT_EN, type DictKey } from '../../src/client/i18n'

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort()
}

describe('dictionaries', () => {
  test('every supported locale has the complete key set and non-empty values', () => {
    const keys = Object.keys(DICT_EN).sort()
    assert.deepEqual(Object.keys(DICTS).sort(), ['de', 'en', 'es', 'fr', 'ja', 'pt', 'ru', 'zh'])
    for (const [locale, dict] of Object.entries(DICTS)) {
      assert.deepEqual(Object.keys(dict).sort(), keys, locale)
      for (const [key, value] of Object.entries(dict)) {
        assert.equal(typeof value, 'string', `${locale}:${key}`)
        assert.ok(value.length > 0, `${locale}:${key}`)
      }
    }
  })

  test('interpolation placeholders agree between every locale and English', () => {
    for (const key of Object.keys(DICT_EN) as DictKey[]) {
      for (const [locale, dict] of Object.entries(DICTS)) {
        assert.deepEqual(placeholders(dict[key]), placeholders(DICT_EN[key]), `${locale}:${key}`)
      }
    }
  })
})
