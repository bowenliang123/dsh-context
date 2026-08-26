// Latest-version check (src/client/latestVersion.ts): registry fetch with a
// 1h TTL and the semver comparator. The fetch is stubbed per test — the
// suite never hits the network — and each fetch test re-imports the module
// (vi.resetModules) to reset the module-level cache. Two registries are
// tried in order (official npm, then npmmirror as a fallback).

import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { isNewerVersion } from '../../src/client/latestVersion'

const HOUR_MS = 60 * 60 * 1000

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
})

async function freshModule(): Promise<typeof import('../../src/client/latestVersion')> {
  vi.resetModules()
  return await import('../../src/client/latestVersion')
}

describe('fetchLatestVersion', () => {
  test('an ok response with a string version resolves to it', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: '9.9.9' }) }))
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '9.9.9')
  })

  test('an ok response without a version resolves to null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({}) }))
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), null)
  })

  test('an ok response with a non-string version resolves to null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ version: 9 }) }))
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), null)
  })

  test('a non-ok response resolves to null', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, json: async () => ({ version: '9.9.9' }) }))
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), null)
  })

  test('a rejected fetch resolves to null', async () => {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), null)
  })

  test('a second call within the TTL does not refetch', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches++
      return { ok: true, json: async () => ({ version: '1.0.0' }) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '1.0.0')
    vi.setSystemTime(1_000_000 + HOUR_MS - 1)
    assert.equal(await fetchLatestVersion(), '1.0.0')
    assert.equal(fetches, 1)
  })

  test('a call after the TTL expires refetches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    let fetches = 0
    vi.stubGlobal('fetch', async () => {
      fetches++
      return { ok: true, json: async () => ({ version: '1.0.' + fetches }) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '1.0.1')
    vi.setSystemTime(1_000_000 + HOUR_MS)
    assert.equal(await fetchLatestVersion(), '1.0.2')
    assert.equal(fetches, 2)
  })

  test('falls back to npmmirror when the official registry fails', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('https://registry.npmjs.org/')) {
        return { ok: false, json: async () => ({}) }
      }
      return { ok: true, json: async () => ({ version: '2.0.0' }) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '2.0.0')
    assert.deepEqual(urls, [
      'https://registry.npmjs.org/dsh-context/latest',
      'https://registry.npmmirror.com/dsh-context/latest',
    ])
  })

  test('falls back to npmmirror when the official fetch rejects', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      if (url.startsWith('https://registry.npmjs.org/')) {
        throw new Error('offline')
      }
      return { ok: true, json: async () => ({ version: '3.0.0' }) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), '3.0.0')
    assert.equal(urls.length, 2)
  })

  test('resolves to null when every source fails', async () => {
    const urls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      urls.push(url)
      return { ok: false, json: async () => ({}) }
    })
    const { fetchLatestVersion } = await freshModule()
    assert.equal(await fetchLatestVersion(), null)
    assert.equal(urls.length, 2)
  })
})

describe('isNewerVersion', () => {
  test('a strictly newer version is newer', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.2'), true)
  })

  test('equal and lower versions are not newer', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false)
    assert.equal(isNewerVersion('1.2.2', '1.2.3'), false)
  })

  test('a v prefix is stripped', () => {
    assert.equal(isNewerVersion('v1.3.0', '1.2.9'), true)
  })

  test('a pre-release suffix is ignored', () => {
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.3.0'), false)
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.2.0'), true)
  })

  test('missing segments compare as zero', () => {
    assert.equal(isNewerVersion('1.2', '1.2.1'), false)
    assert.equal(isNewerVersion('1.2.1', '1.2'), true)
  })

  test('garbage segments parse as zero', () => {
    assert.equal(isNewerVersion('x.y', '0.0.0'), false)
  })
})
