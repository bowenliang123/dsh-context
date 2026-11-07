import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeAgentHeads, makeHeadFetcher } from '../../src/client/agentHeads'

function headResponse(model = 'deepseek-v4-flash'): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      ok: true,
      value: { rev: 1, head: { ok: true, current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 0, total: 10 }, model } },
    }),
  }
}

describe('makeHeadFetcher', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('head-only bodies re-prove the served head; absent, failed, and malformed reads resolve null or reject', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const head = await makeHeadFetcher('s1')!()
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
    assert.equal(head?.model, 'deepseek-v4-flash')
    assert.equal(head?.current.total, 10)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await makeHeadFetcher('s1')!(), null)
    assert.equal(makeHeadFetcher(''), undefined)
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    await assert.rejects(makeHeadFetcher('s1')!())
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      json: async () => ({ ok: true, value: { rev: 1, head: 7 } }),
    }))
    await assert.rejects(makeHeadFetcher('s1')!(), /malformed/)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: false }) }))
    await assert.rejects(makeHeadFetcher('s1')!())
  })
})

describe('makeAgentHeads', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  test('one read per id replays the cached promise and the entry map is bounded', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return headResponse()
    })
    const heads = makeAgentHeads()
    const first = heads.headOf('s1')
    assert.ok(await first !== null)
    assert.ok(heads.headOf('s1') === first, 'the cached promise replays')
    assert.deepEqual(bodies, [{ sessionId: 's1', head: true }])
    for (let i = 0; i < 130; i++) void heads.headOf(`bounded-${i}`)
    const refetched: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      refetched.push((JSON.parse(init.body) as { sessionId: string }).sessionId)
      return headResponse()
    })
    await heads.headOf('bounded-129')
    await heads.headOf('bounded-0')
    assert.deepEqual(refetched, ['bounded-0'], 'only the demoted oldest id refetched')
    const newer = heads.headOf('bounded-129')
    assert.ok(newer === heads.headOf('bounded-129'), 'the newest stays cached')
  })

  test('a concurrent ask joins the in-flight read; a rejected read retries instead of hiding the child', async () => {
    let release!: () => void
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls++
      return new Promise((resolve) => {
        release = () => resolve(headResponse())
      })
    })
    const heads = makeAgentHeads()
    const first = heads.headOf('slow')
    const second = heads.headOf('slow')
    assert.equal(first, second, 'the in-flight read is shared, not stacked')
    assert.equal(calls, 1)
    release()
    assert.ok(await first !== null)
    assert.equal(calls, 1)

    let failures = 0
    vi.stubGlobal('fetch', async () => {
      failures++
      if (failures === 1) throw new Error('down')
      return headResponse()
    })
    const flaky = makeAgentHeads()
    await assert.rejects(flaky.headOf('bad'))
    assert.ok(await flaky.headOf('bad') !== null, 'the retry serves the head once the route recovers')
    assert.equal(failures, 2)
  })

  test('an absent head is cached as absent, so only a new stamp asks again', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ ok: true, value: null }) }
    })
    const heads = makeAgentHeads()
    assert.equal(await heads.headOf('gone'), null)
    assert.equal(await heads.headOf('gone'), null)
    assert.equal(calls, 1, 'absence replays from the cache instead of hammering the route')
    assert.equal(await heads.headOf(''), null, 'an empty id has no fetcher')
    assert.equal(calls, 1, 'the empty id never reaches the route')
  })

  test('the byte budget demotes the oldest oversized head', async () => {
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      const id = (JSON.parse(init.body) as { sessionId: string }).sessionId
      fetched.push(id)
      return headResponse('m'.repeat(700_000))
    })
    const heads = makeAgentHeads()
    await heads.headOf('huge-0')
    await heads.headOf('huge-1')
    await heads.headOf('huge-0')
    assert.deepEqual(fetched, ['huge-0', 'huge-1', 'huge-0'], 'the first oversized head was demoted by the byte budget')
  })
})

import { act, createElement as h } from 'react'
import { useSessionsSnapshot } from '../../src/client/agentHeads'
import type { SessionsFaceLike } from '../../src/client/agentTree'
import { mount } from './helpers/kit'

describe('useSessionsSnapshot coalescing', () => {
  test('one trailing notification per window while the snapshot read stays latest-wins', async () => {
    vi.useFakeTimers()
    let snapshot: unknown = { ids: ['a'] }
    const listeners = new Set<() => void>()
    const face: SessionsFaceLike = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
    }
    const box: { current: unknown } = { current: null }
    let renders = 0
    function Probe(): null {
      renders++
      box.current = useSessionsSnapshot(face, 50)
      return null
    }
    const m = await mount(h(Probe))
    assert.deepEqual(box.current, { ids: ['a'] })
    const before = renders
    snapshot = { ids: ['a', 'b'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['a'] }, 'the urgent render keeps the old snapshot')
    snapshot = { ids: ['a', 'b', 'c'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.equal(renders, before, 'notifications coalesce before the window')
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    assert.deepEqual(box.current, { ids: ['a', 'b', 'c'] }, 'the trailing read serves the latest snapshot')
    await m.unmount()
    vi.useRealTimers()
  })

  test('an uncoalesced face notifies immediately; unmount clears an armed window', async () => {
    vi.useFakeTimers()
    let snapshot: unknown = { ids: [] }
    const listeners = new Set<() => void>()
    const face: SessionsFaceLike = {
      list: {
        getSnapshot: () => snapshot,
        subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
      },
    }
    const box: { current: unknown } = { current: null }
    function Probe(props: { ms?: number }): null {
      box.current = useSessionsSnapshot(face, props.ms)
      return null
    }
    const m = await mount(h(Probe, null))
    snapshot = { ids: ['x'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['x'] })
    await m.update(h(Probe, { ms: 100 }))
    snapshot = { ids: ['y'] }
    act(() => { for (const fn of [...listeners]) fn() })
    assert.deepEqual(box.current, { ids: ['x'] }, 'the window holds')
    await m.unmount()
    await vi.advanceTimersByTimeAsync(200)
    assert.equal(listeners.size, 0)
    vi.useRealTimers()
  })
})
