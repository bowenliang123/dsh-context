// The package's Plugins-page metadata (locale/en.json, locale/zh.json): the
// localized title/description the Host's package-meta reader serves to the
// Plugins page and settings inventory, keyed by the active locale with `en`
// as the fallback. The specs pin the files' shape AND their declaration in
// package.json — a file the exports/files lists miss would work from a
// linked checkout and silently vanish from the published package.

import { readFile, readdir } from 'node:fs/promises'
import assert from 'node:assert/strict'
import { describe, test } from 'vitest'

interface PackageManifest {
  exports: Record<string, string>
  files: string[]
  icon?: string
}

const manifest = JSON.parse(await readFile('package.json', 'utf8')) as PackageManifest

describe('package meta localization', () => {
  test('the locale directory carries well-formed meta dictionaries', async () => {
    const names = (await readdir('locale')).filter(name => name.endsWith('.json')).sort()
    assert.ok(names.includes('en.json'), 'en.json is the fallback dictionary and gates the meta scan')
    for (const name of names) {
      assert.match(name, /^en\.json$|^[A-Za-z]{2,8}(-[A-Za-z0-9]{1,8})*\.json$/, `${name}: language-id filename`)
      const parsed = JSON.parse(await readFile(`locale/${name}`, 'utf8')) as {
        meta?: { title?: unknown; description?: unknown }
      }
      assert.equal(typeof parsed.meta?.title, 'string', `${name}: meta.title`)
      assert.equal(typeof parsed.meta?.description, 'string', `${name}: meta.description`)
    }
  })

  test('the zh dictionary is a real translation of the en one', async () => {
    // The Host resolves the active locale against these entries with `en`
    // as the final fallback — a copy-pasted zh file would read as English.
    const en = JSON.parse(await readFile('locale/en.json', 'utf8')) as { meta: Record<string, string> }
    const zh = JSON.parse(await readFile('locale/zh.json', 'utf8')) as { meta: Record<string, string> }
    assert.deepEqual(Object.keys(zh.meta).sort(), Object.keys(en.meta).sort())
    for (const field of Object.keys(en.meta)) {
      assert.notEqual(zh.meta[field], en.meta[field], `zh ${field} is translated`)
    }
  })

  test('package.json resolves and ships the locale dictionaries', async () => {
    // The exports entry is a PATTERN the Node resolver matches each
    // dictionary's full specifier (`dsh-context/locale/zh.json`) against.
    assert.equal(manifest.exports['./locale/*.json'], './locale/*.json', 'the locale exports pattern')
    const names = (await readdir('locale')).filter(name => name.endsWith('.json'))
    for (const name of names) {
      assert.match(name.slice(0, -'.json'.length), /^[A-Za-z][A-Za-z0-9-]*$/, `locale/${name}: matchable id`)
    }
    assert.equal(manifest.exports['./package.json'], './package.json', 'the meta reader resolves the manifest itself')
    assert.ok(manifest.files.includes('locale/*.json'), 'the dictionaries ship')
  })

  test('the icon declaration stays aligned with the manifest and the shipped file', async () => {
    assert.equal(manifest.icon, 'icon.svg')
    assert.ok(manifest.files.includes('icon.svg'), 'the icon ships')
    const svg = await readFile('icon.svg', 'utf8')
    assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 36 36" fill="none">/)
  })
})
