// The terminal half in the BUILT artifacts: its own lazily imported entry, never in the web bundle. Skipped when lib/ is absent.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, test } from 'vitest'
import * as staging from './staging'

const read = (file: string): string => readFileSync(join(staging.REPO, 'lib', file), 'utf8')
const MARKERS = ['tuiSessionData', 'tui.needsKit']

describe.skipIf(staging.artifactsMissing())('terminal half — the built lib/', () => {
  test('the web bundle carries none of it; the terminal entry carries all of it', () => {
    const client = read('client.js')
    const tui = read('tui.js')
    for (const marker of MARKERS) {
      assert.ok(tui.includes(marker), `tui.js carries ${marker}`)
      assert.ok(!client.includes(marker), `client.js never carries ${marker}`)
    }
  })

  test('the host entry reaches it only through a lazy import', () => {
    const index = read('index.js')
    assert.ok(index.includes('import(`./tui.js`)'), 'a dynamic import of the terminal entry')
    assert.ok(!/from\s*["']\.\/tui\.js["']/.test(index), 'no static import of the terminal entry')
  })

  test('the ./tui export resolves to the factories a headless harness mounts', async () => {
    const pkg = JSON.parse(readFileSync(join(staging.REPO, 'package.json'), 'utf8')) as { exports: Record<string, { default?: string }> }
    const target = pkg.exports['./tui'].default
    assert.equal(target, './lib/tui.js')
    const mod = await import(pathToFileURL(join(staging.REPO, target)).href) as Record<string, unknown>
    for (const name of ['createContextPanel', 'createContextCompact', 'createContextScene', 'createContextSource', 'mountTerminal', 'trendColumns']) {
      assert.equal(typeof mod[name], 'function', name)
    }
  })
})
