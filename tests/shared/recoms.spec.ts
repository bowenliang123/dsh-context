import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'vitest'
import { DEFAULT_RECOM, RECOM_REPOSITORY_ROOT, recomOf, recomsOfPayload } from '../../src/shared/recoms'

function entry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'example',
    name: 'Example',
    url: 'https://example.com',
    icon: 'docs/recoms/deepseek.svg',
    slogan: { en: 'Slogan', zh: '标语' },
    promotion: { en: 'Promo', zh: '推广' },
    tooltip: { en: 'Tip', zh: '说明' },
    ...over,
  }
}

describe('recom payload', () => {
  test('the repository data keeps the built-in DeepSeek fallback and drops no sponsor entry', async () => {
    const source = await readFile(new URL('../../data/recoms.json', import.meta.url), 'utf8')
    const payload = JSON.parse(source) as { id: string }[]
    const rows = recomsOfPayload(payload)
    assert.equal(rows.length, payload.length)
    assert.deepEqual(rows[0], DEFAULT_RECOM)
    assert.deepEqual(rows.map((row) => row.id), payload.map((item) => item.id))
  })

  test('relative icons resolve against the repository root and absolute links keep their form', () => {
    assert.equal(recomOf(entry())?.icon, RECOM_REPOSITORY_ROOT + 'docs/recoms/deepseek.svg')
    assert.equal(recomOf(entry({ icon: 'https://simpleicons.org/icons/deepseek.svg' }))?.icon, 'https://simpleicons.org/icons/deepseek.svg')
    assert.equal(recomOf(entry({ url: 'https://example.com/' }))?.url, 'https://example.com/')
  })

  test('non-list payloads and invalid entries are rejected without sacrificing valid siblings', () => {
    for (const value of [null, {}, 'list', 42]) assert.deepEqual(recomsOfPayload(value), [])
    const hostile = new Proxy({}, { get() { throw new Error('hostile') } })
    const rows = recomsOfPayload([null, 'bad', hostile, entry()])
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.id, 'example')
    assert.equal(recomsOfPayload([entry({ id: '' })]).length, 0)
  })

  test('identity, link, icon, and localized text guards reject every malformed shape', () => {
    for (const value of [null, [], 'row']) assert.equal(recomOf(value), null)
    const invalid: unknown[] = [
      entry({ id: 7 }), entry({ id: ' ' }), entry({ name: 7 }), entry({ name: '' }),
      entry({ url: 7 }), entry({ url: 'not a url' }), entry({ url: 'http://example.com' }),
      entry({ icon: 7 }), entry({ icon: '' }), entry({ icon: 'http://[' }),
      entry({ icon: 'http://evil.test/icon.svg' }), entry({ icon: 'data:image/svg+xml,x' }),
      entry({ slogan: null }), entry({ slogan: [] }), entry({ slogan: { en: 7, zh: '标语' } }),
      entry({ slogan: { en: '', zh: '标语' } }), entry({ slogan: { en: 'Slogan', zh: 7 } }),
      entry({ slogan: { en: 'Slogan', zh: ' ' } }), entry({ promotion: { en: '', zh: '推广' } }),
      entry({ tooltip: { en: 'Tip', zh: '' } }),
    ]
    for (const value of invalid) assert.equal(recomOf(value), null)
  })
})
