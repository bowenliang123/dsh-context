import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { isNewerVersion } from '../../src/client/versionSource'
import { cleanupMounts, flush, mount } from './helpers/kit'

const HOUR_MS = 60 * 60 * 1000
const RETRY_MS = 30_000
const ROUTE = 'api/dsh-context/version'

interface Call {
  url: string
  body: unknown
}

interface Envelope {
  ok: boolean
  json: () => Promise<{ ok: boolean; value: unknown }>
}

function reply(value: unknown): Envelope {
  return { ok: true, json: async () => ({ ok: true, value }) }
}

function stubVersion(handler: (call: number) => unknown): { calls: Call[] } {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init: { body: string; method?: string }) => {
    calls.push({ url: String(input), body: JSON.parse(String(init.body)) })
    return reply(handler(calls.length - 1))
  })
  return { calls }
}

function versionBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ready: true, failed: false, checkedAt: 1, current: '1.0.0', latest: '1.1.0', ...over }
}

type Module = typeof import('../../src/client/versionSource')

async function fresh(version?: string): Promise<Module> {
  vi.resetModules()
  const globals = globalThis as Record<string, unknown>
  if (version === undefined) delete globals.__DSH_CTX_VERSION__
  else globals.__DSH_CTX_VERSION__ = version
  return await import('../../src/client/versionSource')
}

interface Probe {
  settled: () => string
  unmount: () => Promise<void>
}

async function probe(module: Module): Promise<Probe> {
  const { useNewerVersion } = module
  const seen: string[] = []
  function VersionProbe(): null {
    seen.push(useNewerVersion() ?? '')
    return null
  }
  const m = await mount(h(VersionProbe, {}))
  await flush()
  return { settled: () => seen[seen.length - 1], unmount: () => m.unmount() }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  delete (globalThis as Record<string, unknown>).__DSH_CTX_VERSION__
})

describe('isNewerVersion', () => {
  test('segments compare numerically, ignoring a v prefix, pre-release suffixes, padding, and garbage', () => {
    assert.equal(isNewerVersion('1.2.3', '1.2.2'), true)
    assert.equal(isNewerVersion('1.2.3', '1.2.3'), false)
    assert.equal(isNewerVersion('1.2.2', '1.2.3'), false)
    assert.equal(isNewerVersion('v1.3.0', '1.2.9'), true)
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.3.0'), false)
    assert.equal(isNewerVersion('1.3.0-rc.1', '1.2.0'), true)
    assert.equal(isNewerVersion('1.2', '1.2.1'), false)
    assert.equal(isNewerVersion('1.2.1', '1.2'), true)
    assert.equal(isNewerVersion('x.y', '0.0.0'), false)
  })
})

describe('the version route', () => {
  test('posts an empty body to the version route, decodes ready/current/latest, and paints a newer version', async () => {
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => versionBody({ current: '1.0.0', latest: '1.2.3' }))
    const p = await probe(module)
    assert.equal(p.settled(), '1.2.3')
    assert.deepEqual(calls, [{ url: ROUTE, body: {} }])
    await p.unmount()
  })

  test('a dev build never checks the version route and paints nothing', async () => {
    const module = await fresh()
    const { calls } = stubVersion(() => versionBody())
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.deepEqual(calls, [])
    await p.unmount()
  })

  test('a same or older version paints nothing and does not poll again', async () => {
    for (const latest of ['1.0.0', '0.9.0']) {
      vi.useFakeTimers()
      const module = await fresh('1.0.0')
      const { calls } = stubVersion(() => versionBody({ latest }))
      const p = await probe(module)
      assert.equal(p.settled(), '', `${latest} is not newer than the build`)
      assert.equal(calls.length, 1)
      assert.equal(vi.getTimerCount(), 0)
      await advance(10 * RETRY_MS)
      assert.equal(calls.length, 1, 'a ready answer stops the polling')
      await p.unmount()
    }
  })

  test('a not-ready reply retries after 30s and paints once the host turns ready', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => (call === 0 ? versionBody({ ready: false, failed: true }) : versionBody()))
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.equal(calls.length, 1)
    await advance(RETRY_MS)
    assert.equal(calls.length, 2, 'the retryable cache expires exactly at the retry delay')
    assert.equal(p.settled(), '1.1.0')
    assert.equal(vi.getTimerCount(), 0)
    await p.unmount()
  })

  test('a not-ready read is served from the retry-window cache until it expires', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => versionBody({ ready: false, failed: false }))
    const first = await probe(module)
    await first.unmount()
    const second = await probe(module)
    assert.equal(calls.length, 1, 'a second read inside the retry window reuses the cached answer')
    await advance(RETRY_MS)
    assert.equal(calls.length, 2, 'the retry window is the 30s retry delay')
    await second.unmount()
  })

  test('a malformed or empty reply never paints and keeps retrying', async () => {
    const replies: unknown[] = [[], { ready: 'yes' }, {}, null, 'junk']
    for (const bad of replies) {
      vi.useFakeTimers()
      const module = await fresh('1.0.0')
      const { calls } = stubVersion(call => (call === 0 ? bad : versionBody()))
      const p = await probe(module)
      assert.equal(p.settled(), '', `malformed reply ${JSON.stringify(bad)} paints nothing`)
      assert.equal(calls.length, 1)
      await advance(RETRY_MS)
      assert.equal(calls.length, 2, `malformed reply ${JSON.stringify(bad)} retries`)
      await p.unmount()
      vi.useRealTimers()
    }
  })

  test('a ready reply without usable current/latest fields paints nothing', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => (call === 0
      ? { ready: true, failed: false, checkedAt: 1, current: 42, latest: '' }
      : versionBody()))
    const p = await probe(module)
    assert.equal(p.settled(), '', 'a ready reply without a latest version cannot paint')
    assert.equal(calls.length, 1)
    assert.equal(vi.getTimerCount(), 1)
    for (let i = 0; i < 5; i++) await advance(RETRY_MS)
    assert.equal(vi.getTimerCount(), 0, 'the hook still gives up after five attempts')
    assert.equal(p.settled(), '')
    await p.unmount()
  })

  test('a second read within the TTL reuses the answer; after the TTL it refetches', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => versionBody({ latest: call === 0 ? '1.1.0' : '1.2.0' }))
    const first = await probe(module)
    assert.equal(first.settled(), '1.1.0')
    await first.unmount()
    vi.setSystemTime(1_000_000 + HOUR_MS - 1)
    const second = await probe(module)
    assert.equal(second.settled(), '1.1.0', 'the cached answer serves the second mount')
    assert.equal(calls.length, 1)
    await second.unmount()
    vi.setSystemTime(1_000_000 + HOUR_MS)
    const third = await probe(module)
    assert.equal(third.settled(), '1.2.0', 'an expired answer refetches')
    assert.equal(calls.length, 2)
    await third.unmount()
  })

  test('concurrent mounts share one in-flight version read', async () => {
    const module = await fresh('1.0.0')
    const calls: unknown[] = []
    let release: (res: Envelope) => void = () => {}
    vi.stubGlobal('fetch', (_input: unknown, init: { body: string; method?: string }) => {
      calls.push({ body: JSON.parse(String(init.body)), method: init.method })
      return new Promise<Envelope>((resolve) => { release = resolve })
    })
    const a = await probe(module)
    const b = await probe(module)
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0], { body: {}, method: 'POST' })
    await act(async () => {
      release(reply(versionBody()))
      await Promise.resolve()
    })
    await flush()
    assert.equal(a.settled(), '1.1.0')
    assert.equal(b.settled(), '1.1.0')
    await a.unmount()
    await b.unmount()
  })

  test('gives up after five failed attempts instead of polling forever', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => {
      throw new Error('offline')
    })
    const p = await probe(module)
    assert.equal(p.settled(), '')
    assert.equal(calls.length, 1)
    for (let i = 0; i < 4; i++) {
      await advance(RETRY_MS)
      assert.equal(calls.length, 2 + i)
    }
    assert.equal(vi.getTimerCount(), 0, 'no timer survives the fifth attempt')
    await advance(10 * RETRY_MS)
    assert.equal(calls.length, 5, 'five attempts, then silence')
    await p.unmount()
  })

  test('an unmount drops a late answer and clears the armed retry', async () => {
    vi.useFakeTimers()
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(() => {
      throw new Error('offline')
    })
    const p = await probe(module)
    assert.equal(vi.getTimerCount(), 1)
    await p.unmount()
    assert.equal(vi.getTimerCount(), 0, 'the pending retry is cleared with the hook')
    await advance(10 * RETRY_MS)
    assert.equal(calls.length, 1)

    const pendingCalls: unknown[] = []
    let release: (res: Envelope) => void = () => {}
    vi.stubGlobal('fetch', (_input: unknown, init: { body: string }) => {
      pendingCalls.push(JSON.parse(String(init.body)))
      return new Promise<Envelope>((resolve) => { release = resolve })
    })
    const late = await probe(module)
    await late.unmount()
    release(reply(versionBody()))
    await flush()
    assert.equal(late.settled(), '', 'the late result is dropped')
    assert.equal(pendingCalls.length, 1)
  })

  test('resetVersionSource clears the ready cache so the next read refetches', async () => {
    const module = await fresh('1.0.0')
    const { calls } = stubVersion(call => versionBody({ latest: call === 0 ? '1.1.0' : '1.2.0' }))
    const first = await probe(module)
    assert.equal(first.settled(), '1.1.0')
    await first.unmount()
    module.resetVersionSource()
    const second = await probe(module)
    assert.equal(second.settled(), '1.2.0')
    assert.equal(calls.length, 2)
    await second.unmount()
  })

  test('resetVersionSource clears an in-flight read so a later mount refetches', async () => {
    const module = await fresh('1.0.0')
    const releases: ((res: Envelope) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Envelope>((resolve) => { releases.push(resolve) }))
    const first = await probe(module)
    assert.equal(releases.length, 1)
    module.resetVersionSource()
    const second = await probe(module)
    assert.equal(releases.length, 2, 'the reset dropped the in-flight handle and the mount fetched again')
    await act(async () => {
      releases[0]?.(reply(versionBody({ latest: '1.1.0' })))
      releases[1]?.(reply(versionBody({ latest: '1.2.0' })))
      await Promise.resolve()
    })
    await flush()
    assert.equal(first.settled(), '1.1.0')
    assert.equal(second.settled(), '1.2.0')
    await first.unmount()
    await second.unmount()
  })
})
