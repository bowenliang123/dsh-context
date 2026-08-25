// Plugin self-metadata (src/client/meta.ts): the build-time define fallbacks
// and the define-armed variants. Each variant sets the globals BEFORE its own
// dynamic import (vi.resetModules clears the module cache so the constants
// are re-evaluated), then restores the globals.

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'

const globals = globalThis as Record<string, unknown>

afterEach(() => {
  delete globals.__DSH_CTX_VERSION__
  delete globals.__DSH_CTX_REPO__
  vi.resetModules()
})

async function importMeta(): Promise<typeof import('../../src/client/meta')> {
  vi.resetModules()
  return await import('../../src/client/meta')
}

describe('meta', () => {
  test('without build defines the dev/test fallbacks apply', async () => {
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_NAME, 'dsh-context')
    assert.equal(meta.PLUGIN_VERSION, '0.0.0-dev')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'bowenliang123/dsh-context')
  })

  test('a version define wins over the dev fallback', async () => {
    globals.__DSH_CTX_VERSION__ = '9.9.9'
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_VERSION, '9.9.9')
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/bowenliang123/dsh-context')
  })

  test('a repo define wins and the short form strips the github prefix', async () => {
    globals.__DSH_CTX_REPO__ = 'https://github.com/acme/widget'
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO, 'https://github.com/acme/widget')
    assert.equal(meta.PLUGIN_REPO_SHORT, 'acme/widget')
  })

  test('a non-github repo keeps its full URL as the short form', async () => {
    globals.__DSH_CTX_REPO__ = 'http://git.example.com/acme/widget'
    const meta = await importMeta()
    assert.equal(meta.PLUGIN_REPO_SHORT, 'http://git.example.com/acme/widget')
  })
})
