import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import type { makePluginInfo as makePluginInfoFn } from '../../../src/client/components/pluginInfo'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, query, queryAll, text } from '../helpers/kit'

const kit = makeKit()

function stubVersion(latest: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, value: { ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function loadPluginInfo(version?: string, ctx = new TestClientCtx()): Promise<ReturnType<typeof makePluginInfoFn>> {
  vi.resetModules()
  const globals = globalThis as Record<string, unknown>
  if (version === undefined) delete globals.__DSH_CTX_VERSION__
  else globals.__DSH_CTX_VERSION__ = version
  const { resetVersionSource } = await import('../../../src/client/versionSource')
  resetVersionSource()
  const mod = await import('../../../src/client/components/pluginInfo')
  return mod.makePluginInfo(kit, asClientCtx(ctx))
}

afterEach(() => {
  vi.unstubAllGlobals()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('PluginInfo', () => {
  test('dev build renders the static rows and never checks the version route', async () => {
    const fetchMock = stubVersion('9.9.9')
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { pluginNavigation: { openBundle: (name: string) => { opened.push(name) } } } })
    const PluginInfo = await loadPluginInfo(undefined, ctx)
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 0)
    const rows = queryAll(m.container, '.lc-pi-row')
    assert.equal(rows.length, 3)
    assert.deepEqual(rows.map(r => query(r, '.lc-pi-label').textContent), ['Plugin', 'GitHub', 'Plugin Settings'])
    for (const row of rows) assert.equal(queryAll(row, '.lc-pi-label .lc-pi-labelicon').length, 1)
    assert.equal(query(rows[0], '.lc-pi-value').textContent, 'dsh-context (v0.0.0-dev)')
    assert.equal(rows[0].getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(rows[0].getAttribute('target'), '_blank')
    assert.equal(rows[0].getAttribute('rel'), 'noreferrer')
    assert.equal(query(rows[1], '.lc-pi-value').textContent, 'bowenliang123/dsh-context')
    assert.equal(rows[2].getAttribute('href'), null)
    const hint = query(m.container, '.lc-pi-hint')
    assert.equal(hint.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context')
    assert.equal(hint.getAttribute('target'), '_blank')
    assert.equal(hint.getAttribute('rel'), 'noreferrer')
    assert.equal(queryAll(m.container, '.lc-pi-update').length, 0)
    rows[2].click()
    assert.deepEqual(opened, ['dsh-context'], 'the settings row jumps through the Plugins panel navigator')
    await m.unmount()
  })

  test('release build with a newer version appends the update chip', async () => {
    const fetchMock = stubVersion('1.1.0')
    const PluginInfo = await loadPluginInfo('1.0.0')
    const m = await mount(h(PluginInfo, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), 'api/dsh-context/version')
    assert.deepEqual(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)), {})
    assert.ok(text(m.container).includes('dsh-context (v1.0.0)'))
    assert.equal(query(m.container, '.lc-pi-update').textContent, '↑ v1.1.0')
    await m.unmount()
  })
})
