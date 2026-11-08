import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { flush, makeKit, mount, query, queryAll } from '../helpers/kit'

;(globalThis as Record<string, unknown>).__DSH_CTX_VERSION__ = '1.0.0'
const { resetVersionSource } = await import('../../../src/client/versionSource')
const { makeUpdatePill } = await import('../../../src/client/components/updatePill')

const UpdatePill = makeUpdatePill(makeKit())

function stubVersion(latest: string): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve({
    ok: true,
    json: async () => ({ ok: true, value: { ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest } }),
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

beforeEach(() => {
  resetVersionSource()
})

afterEach(() => {
  vi.unstubAllGlobals()
  resetVersionSource()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('UpdatePill', () => {
  test('a newer version paints the capsule linking the release notes', async () => {
    const fetchMock = stubVersion('1.1.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    assert.equal(fetchMock.mock.calls.length, 1)
    assert.equal(String(fetchMock.mock.calls[0]?.[0]), 'api/dsh-context/version')
    assert.deepEqual(JSON.parse(String((fetchMock.mock.calls[0]?.[1] as { body: string }).body)), {})
    const pill = query(m.container, '.lc-ov-update')
    assert.equal(pill.getAttribute('href'), 'https://github.com/bowenliang123/dsh-context/releases/latest')
    assert.equal(pill.getAttribute('target'), '_blank')
    assert.equal(pill.getAttribute('rel'), 'noreferrer')
    assert.equal(query(pill, '.lc-ov-update-label').textContent, 'Update')
    assert.equal(query(pill, '.lc-ov-update-version').textContent, '↑ v1.1.0')
    assert.equal(pill.getAttribute('data-lc-tip'), 'Update v1.1.0 is available — click for the release notes')
    assert.equal(pill.getAttribute('data-lc-tip-side'), 'bottom')
    assert.equal(pill.getAttribute('aria-label'), pill.getAttribute('data-lc-tip'))
    await m.unmount()
  })

  test('the build being current leaves the head unpainted', async () => {
    stubVersion('1.0.0')
    const m = await mount(h(UpdatePill, {}))
    await flush()
    assert.equal(queryAll(m.container, '.lc-ov-update').length, 0)
    await m.unmount()
  })
})
