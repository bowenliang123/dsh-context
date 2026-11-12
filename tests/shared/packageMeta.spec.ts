import { readFile, readdir } from 'node:fs/promises'
import { DICTS } from '../../src/client/i18n'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'

interface PackageManifest {
  exports: Record<string, string>
  files: string[]
  icon?: string
}

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest
const locales = Object.keys(DICTS).sort()

describe('package meta localization', () => {
  test('every supported locale ships, resolves, and carries well-formed meta', async () => {
    const names = (await readdir('locale')).filter(name => name.endsWith('.json')).sort()
    assert.deepEqual(names, locales.map(locale => `${locale}.json`).sort())
    for (const name of names) {
      assert.match(name, /^en\.json$|^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*\.json$/, `${name}: language-id filename`)
      const parsed = JSON.parse(await readFile(`locale/${name}`, 'utf8')) as {
        meta?: { title?: unknown; description?: unknown; detail?: unknown }
      }
      assert.equal(typeof parsed.meta?.title, 'string', `${name}: meta.title`)
      assert.equal(typeof parsed.meta?.description, 'string', `${name}: meta.description`)
      const detail = parsed.meta?.detail
      assert.ok(typeof detail === 'string', `${name}: meta.detail`)
      assert.equal(detail, name === 'zh.json' ? 'README.md' : `README_${name.slice(0, -5)}.md`, `${name}: meta.detail`)
      await readFile(detail, 'utf8')
    }
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'the locale exports pattern')
    assert.equal(manifest.exports['./package.json'], './package.json', 'the meta reader resolves the manifest itself')
    assert.ok(manifest.files.includes('locale/*.json'), 'the dictionaries ship')
    assert.ok(manifest.files.includes('README*.md'), 'the localized READMEs ship')
  })

  test('every localized dictionary translates the complete English meta shape', async () => {
    const en = JSON.parse(await readFile('locale/en.json', 'utf8')) as { meta: Record<string, string> }
    for (const locale of locales.filter(locale => locale !== 'en')) {
      const dict = JSON.parse(await readFile(`locale/${locale}.json`, 'utf8')) as { meta: Record<string, string> }
      assert.deepEqual(Object.keys(dict.meta).sort(), Object.keys(en.meta).sort(), locale)
      for (const field of Object.keys(en.meta).filter(field => field !== 'detail')) {
        assert.notEqual(dict.meta[field], en.meta[field], `${locale} ${field} is translated`)
      }
    }
  })

  test('the icon declaration stays aligned with the manifest and the shipped file', async () => {
    assert.equal(manifest.icon, 'icon.svg')
    assert.ok(manifest.files.includes('icon.svg'), 'the icon ships')
    const svg = await readFile('icon.svg', 'utf8')
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024">/)
  })
})
