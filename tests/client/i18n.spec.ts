import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, test } from 'vitest'
import { DICTS, DICT_EN, type DictKey } from '../../src/client/i18n'

const SRC = join(process.cwd(), 'src/client')

const I18N_MODULE = /^i18n(?:[A-Z][a-z]+)?\.ts$/

const DYNAMIC_PREFIXES = [
  'browser.kind.', 'browser.search.', 'cat.', 'cmds.filter.', 'cmds.sort.', 'ev.mode.',
  'files.kind.', 'files.sort.', 'fleet.comms.detail.', 'fleet.comms.kind.', 'fleet.kind.',
  'fleet.pulse.mode.', 'fleet.settled.', 'fleet.settledShort.', 'fleet.task.', 'form.',
  'kind.', 'ov.cover.', 'ov.date.wd.', 'ov.heat.metric.', 'ov.heat.mon.', 'ov.list.sort.',
  'ov.range.', 'tool.sort.',
]

function sourceText(): string {
  const files = readdirSync(SRC, { recursive: true, encoding: 'utf8' })
    .filter(file => /\.tsx?$/.test(file) && !I18N_MODULE.test(file))
  return files.map(file => readFileSync(join(SRC, file), 'utf8')).join('\n')
}

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

  test('every dictionary key is reachable from a literal or an enumerated dynamic namespace', () => {
    const source = sourceText()
    const literal = new Set(
      [...source.matchAll(/'([A-Za-z][\w.-]*)'|"([A-Za-z][\w.-]*)"/g)].map(match => match[1] ?? match[2]),
    )
    const unread = Object.keys(DICT_EN).filter(key => !literal.has(key)
      && !DYNAMIC_PREFIXES.some(prefix => key.startsWith(prefix)))
    assert.deepEqual(unread, [], 'dead keys: no literal use and no enumerated dynamic namespace')
  })

  test('every literal t() key exists in the dictionary', () => {
    const missing = new Set<string>()
    for (const match of sourceText().matchAll(/\bt\(\s*'([^']+)'/g)) {
      const key = match[1]
      if (key.endsWith('.')) continue
      if (!(key in DICT_EN)) missing.add(key)
    }
    assert.deepEqual([...missing], [], 'typo keys: a literal t() key the dictionaries do not carry')
  })

  test('interpolation placeholders agree between every locale and English', () => {
    for (const key of Object.keys(DICT_EN) as DictKey[]) {
      for (const [locale, dict] of Object.entries(DICTS)) {
        assert.deepEqual(placeholders(dict[key]), placeholders(DICT_EN[key]), `${locale}:${key}`)
      }
    }
  })
})
