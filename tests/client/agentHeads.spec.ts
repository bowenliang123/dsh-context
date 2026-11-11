import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeAgentHeads, makeBatchHeadFetcher, makeHeadFetcher, headsOf, readHeads, useSessionsSnapshot } from '../../src/client/agentHeads'
import { invalidate, resetInvalidations } from '../../src/client/invalidation'
import { disposeRetention } from '../../src/client/retention'
import { act, createElement as h } from 'react'
import { type SessionsFaceLike, type AgentNode } from '../../src/client/agentTree'
import { mount } from './helpers/kit'
import { type CommsAgent } from '../../src/client/commsModel'
import { type CommsRow, type FleetDelegationRow } from '../../src/client/fleetDetail'
import { type FleetTeam } from '../../src/client/fleetTeam'
import { layoutPulse, pulseDependencyChainOf, pulseEventGroupOf, pulseEventItemsOf, pulseEventMatchesOf, pulseLaneVisibility, pulseTaskBadgeOf, pulseTaskLaneIdsOf, pulseTasksByAgent, pulseTimelineItemsOf, pulseWorkGroupsOf, pulseWorkItemsOf, pulseWorkPhaseOf } from '../../src/client/pulseModel'

describe('agentHeads', () => {

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


describe('useSessionsSnapshot coalescing', () => {
  test('a missing face reads null and subscribes to nothing', async () => {
    const box: { current: unknown } = { current: {} }
    function Probe(): null {
      box.current = useSessionsSnapshot(null, 0)
      return null
    }
    const m = await mount(h(Probe))
    assert.equal(box.current, null)
    await m.unmount()
  })

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


describe('headsOf and the batch heads channel', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function batchResponse(ids: string[]): unknown {
    const value: Record<string, unknown> = {}
    for (const id of ids) value[id] = { head: { ok: true, current: { system: 0, tools: 0, user: 1, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } } }
    return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
  }

  test('decodes a heads envelope, dropping unusable rows', () => {
    assert.equal(headsOf(null), null)
    assert.equal(headsOf(42), null)
    const decoded = headsOf({ a: { head: { ok: true, current: { system: 0, tools: 0, user: 1, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } } }, b: { head: null }, c: 7 })
    assert.equal(decoded?.size, 1)
    assert.equal(decoded?.get('a')?.current.total, 1)
  })

  test('the batch fetcher posts the ids once and rejects malformed envelopes', async () => {
    const bodies: unknown[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return batchResponse(['a', 'b'])
    })
    const fetcher = makeBatchHeadFetcher(['a', 'b'])
    const heads = await fetcher()
    assert.equal(heads?.size, 2)
    assert.deepEqual(bodies, [{ ids: ['a', 'b'] }])
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    assert.equal(await makeBatchHeadFetcher(['a']) (), null)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: { a: { head: 7 } } }) }))
    assert.equal((await makeBatchHeadFetcher(['a'])())?.size, 0, 'unusable rows are dropped instead of failing the batch')
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500 }))
    await assert.rejects(makeBatchHeadFetcher(['a'])())
  })

  test('headOfMany batches the cold ids once, joins concurrent asks, and replays cached heads', async () => {
    const bodies: { ids?: string[] }[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return batchResponse(JSON.parse(init.body).ids)
    })
    const heads = makeAgentHeads()
    const many = heads.headOfMany
    assert.ok(many !== undefined)
    const first = await many.call(heads, ['a', 'b'])
    assert.deepEqual([...first.keys()].sort(), ['a', 'b'])
    assert.deepEqual(bodies, [{ ids: ['a', 'b'] }])
    const replay = await many.call(heads, ['a', 'b', 'a', ''])
    assert.deepEqual([...replay.keys()].sort(), ['a', 'b'])
    assert.equal(bodies.length, 1, 'cached heads replay without a read')
    const none = await many.call(heads, [])
    assert.equal(none.size, 0)
  })

  test('a wide fleet splits its head reads into 64-id chunks', async () => {
    const bodies: { ids: string[] }[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      bodies.push(JSON.parse(init.body))
      return batchResponse(JSON.parse(init.body).ids)
    })
    const heads = makeAgentHeads()
    const ids = Array.from({ length: 130 }, (_, i) => 'wide-' + i)
    const reads = await heads.headOfMany!(ids)
    assert.equal(reads.size, 130, 'every child head lands')
    assert.deepEqual(bodies.map(body => body.ids.length), [64, 64, 2])
    assert.deepEqual(bodies.flatMap(body => body.ids), ids)
  })

  test('an invalidation during a batch read drops the batch and keeps callers served', async () => {
    const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = []
    let calls = 0
    vi.stubGlobal('fetch', () => new Promise((resolve, reject) => {
      calls++
      pending.push({ resolve, reject })
    }))
    const heads = makeAgentHeads()
    const many = heads.headOfMany!
    const batch = many.call(heads, ['b1', 'b2'])
    invalidate('heads')
    const fresh = many.call(heads, ['b1'])
    assert.equal(calls, 2)
    pending[0].resolve(batchResponse(['b1', 'b2']))
    assert.deepEqual([...(await batch).keys()].sort(), ['b1', 'b2'], 'the caller still receives its read')
    pending[1].resolve(batchResponse(['b1']))
    assert.equal((await fresh).get('b1')?.current.total, 1, 'the fresh batch is cached')
    const failing = many.call(heads, ['b3'])
    invalidate('heads')
    pending[2].reject('offline')
    await assert.rejects(failing, /heads read failed/)
    disposeRetention()
    resetInvalidations()
  })

  test('concurrent batches for the same cold ids join the in-flight reads', async () => {
    let release!: () => void
    let calls = 0
    vi.stubGlobal('fetch', () => {
      calls++
      return new Promise((resolve) => {
        release = () => resolve(batchResponse(['x']))
      })
    })
    const heads = makeAgentHeads()
    const many = heads.headOfMany!
    const one = many.call(heads, ['x'])
    const two = many.call(heads, ['x'])
    await Promise.resolve()
    release()
    const [a, b] = await Promise.all([one, two])
    assert.equal(a.get('x')?.current.total, 1)
    assert.equal(b.get('x')?.current.total, 1)
    assert.equal(calls, 1)
  })

  test('a batch joins a single in-flight read and drops a null head', async () => {
    let release!: () => void
    vi.stubGlobal('fetch', () => new Promise((resolve) => {
      release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) })
    }))
    const heads = makeAgentHeads()
    const single = heads.headOf('x')
    const many = heads.headOfMany!
    const joined = many.call(heads, ['x'])
    release()
    assert.equal(await single, null)
    assert.equal((await joined).size, 0)
  })

  test('a failed batch rejects every ask and a later batch retries', async () => {
    let fail = true
    vi.stubGlobal('fetch', async () => {
      if (fail) throw new Error('offline')
      return batchResponse(['x'])
    })
    const heads = makeAgentHeads()
    const many = heads.headOfMany!
    await assert.rejects(many.call(heads, ['x']), /offline/)
    fail = false
    const retried = await many.call(heads, ['x'])
    assert.equal(retried.get('x')?.current.total, 1)
    vi.stubGlobal('fetch', async () => { throw 'offline-string' })
    await assert.rejects(many.call(heads, ['y']), /heads read failed/)
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: null }) }))
    const absent = await many.call(heads, ['gone'])
    assert.equal(absent.size, 0)
    const again = await many.call(heads, ['gone'])
    assert.equal(again.size, 0)
  })
})


describe('readHeads — the batch-or-single seam', () => {
  const timeline = (): never => ({ ok: true, current: { system: 0, tools: 0, user: 1, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }) as never

  test('prefers the batch face when the channel provides one', async () => {
    const calls: string[][] = []
    const reads = await readHeads({
      headOf: () => { throw new Error('single reads must not run') },
      headOfMany: (ids) => { calls.push([...ids]); return Promise.resolve(new Map(ids.map(id => [id, timeline()] as const))) },
    }, ['a', 'b'])
    assert.deepEqual(calls, [['a', 'b']])
    assert.equal(reads.size, 2)
  })

  test('falls back to single reads, dropping absent heads and reporting a failure', async () => {
    const calls: string[] = []
    const fallback = {
      headOf: (id: string) => { calls.push(id); return Promise.resolve(id === 'a' ? timeline() : null) },
    }
    const reads = await readHeads(fallback, ['a', 'b'])
    assert.deepEqual(calls, ['a', 'b'])
    assert.deepEqual([...reads.keys()], ['a'])
    await assert.rejects(readHeads({ headOf: (id: string) => id === 'b' ? Promise.reject(new Error('bad')) : Promise.resolve(timeline()) }, ['a', 'b']), /bad/)
    await assert.rejects(readHeads({ headOf: () => Promise.reject('plain') }, ['a']), /heads read failed/)
  })
})

describe('makeAgentHeads freshness', () => {
  afterEach(() => {
    disposeRetention()
    resetInvalidations()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  test('heads expire after their ttl so a moved projection is re-read', async () => {
    vi.useFakeTimers()
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return headResponse('m' + String(calls))
    })
    const heads = makeAgentHeads()
    assert.equal((await heads.headOf('s1'))?.model, 'm1')
    assert.equal((await heads.headOf('s1'))?.model, 'm1')
    assert.equal(calls, 1)
    vi.advanceTimersByTime(60_000)
    assert.equal((await heads.headOf('s1'))?.model, 'm2')
    assert.equal(calls, 2)

    let absent = 0
    vi.stubGlobal('fetch', async () => {
      absent++
      return { ok: true, status: 200, json: async () => ({ ok: true, value: null }) }
    })
    assert.equal(await heads.headOf('gone'), null)
    assert.equal(await heads.headOf('gone'), null)
    assert.equal(absent, 1)
    vi.advanceTimersByTime(60_000)
    assert.equal(await heads.headOf('gone'), null)
    assert.equal(absent, 2)
  })

  test('pricing readiness clears the heads so cost-bearing heads refetch', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return headResponse()
    })
    const heads = makeAgentHeads()
    await heads.headOf('priced')
    invalidate('pricing')
    await heads.headOf('priced')
    assert.equal(calls, 2, 'the stale cost-less head was dropped')
    await heads.headOf('priced')
    assert.equal(calls, 2, 'the refetched head replays')
  })

  test('heads invalidation clears only the named session or everything', async () => {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (_url: unknown, init: { body: string }) => {
      calls.push((JSON.parse(init.body) as { sessionId: string }).sessionId)
      return headResponse()
    })
    const heads = makeAgentHeads()
    await heads.headOf('a')
    await heads.headOf('b')
    invalidate('fleet')
    await heads.headOf('a')
    assert.deepEqual(calls, ['a', 'b'], 'another kind leaves heads alone')
    invalidate('heads', { sessionId: 'a' })
    await heads.headOf('a')
    await heads.headOf('b')
    assert.deepEqual(calls, ['a', 'b', 'a'], 'only the named session is re-read')
    invalidate('heads')
    await heads.headOf('a')
    await heads.headOf('b')
    assert.deepEqual(calls, ['a', 'b', 'a', 'a', 'b'], 'a full invalidation re-reads every head')
  })

  test('an invalidation during a read drops that result and the next ask re-reads', async () => {
    const pending: { resolve: (value: unknown) => void; reject: (reason: unknown) => void }[] = []
    let calls = 0
    vi.stubGlobal('fetch', () => new Promise((resolve, reject) => {
      calls++
      pending.push({ resolve, reject })
    }))
    const heads = makeAgentHeads()
    const first = heads.headOf('s1')
    invalidate('heads')
    const second = heads.headOf('s1')
    assert.equal(calls, 2)
    pending[0].resolve(headResponse('old'))
    assert.equal((await first)?.model, 'old', 'the caller still receives its read')
    pending[1].resolve(headResponse('new'))
    assert.equal((await second)?.model, 'new')
    await heads.headOf('s1')
    assert.equal(calls, 2, 'the fresh result is cached')

    const failing = heads.headOf('bad')
    invalidate('heads')
    pending[2].reject(new Error('down'))
    await assert.rejects(failing)
  })
})

describe('makeAgentHeads per-id detail fallback', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  function stubRoutes(detail: (id: string) => Promise<unknown>, batchIds: (ids: string[]) => void = () => {}): { heads: number; details: string[] } {
    const log = { heads: 0, details: [] as string[] }
    vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { ids?: string[]; sessionId?: string }
      if (String(url).includes('heads')) {
        log.heads++
        batchIds(body.ids ?? [])
        return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
      }
      const id = body.sessionId as string
      log.details.push(id)
      try {
        const value = await detail(id)
        return { ok: true, status: 200, json: async () => ({ ok: true, value }) }
      } catch {
        return { ok: false, status: 500, json: async () => ({}) }
      }
    })
    return log
  }

  test('missing batch heads land through the per-id head read and are cached', async () => {
    const log = stubRoutes(async id => ({ rev: 1, head: { ok: true, current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 0, total: 10 }, model: 'detail-' + id } }))
    const heads = makeAgentHeads()
    const reads = await heads.headOfMany!(['a', 'b'])
    assert.deepEqual([...reads.keys()].sort(), ['a', 'b'])
    assert.equal(reads.get('a')?.model, 'detail-a')
    assert.equal(log.heads, 1)
    assert.deepEqual(log.details.sort(), ['a', 'b'])
    log.details.length = 0
    const again = await heads.headOfMany!(['a', 'b'])
    assert.equal(again.size, 2)
    assert.deepEqual(log.details, [], 'the fallback heads replay from the cache')
  })

  test('a null, failed or capped fallback drops only what cannot land', async () => {
    stubRoutes(async (id) => {
      if (id === 'null') return null
      if (id === 'throw') throw new Error('down')
      return { rev: 1, head: { ok: true, current: { system: 1, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } } }
    })
    const heads = makeAgentHeads()
    const reads = await heads.headOfMany!(['ok', 'null', 'throw'])
    assert.deepEqual([...reads.keys()], ['ok'])
    const many = Array.from({ length: 80 }, (_, i) => `cap-${i}`)
    const capped = await makeAgentHeads().headOfMany!(many)
    assert.equal(capped.size, 64, 'the per-id fallback is capped at one full batch')
  })

  test('an invalidation while a fallback head is in flight never poisons the cache', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    let detailCalls = 0
    vi.stubGlobal('fetch', async (url: unknown) => {
      if (String(url).includes('heads')) {
        return { ok: true, status: 200, json: async () => ({ ok: true, value: {} }) }
      }
      detailCalls++
      await gate
      return { ok: true, status: 200, json: async () => ({ ok: true, value: { rev: 1, head: { ok: true, current: { system: 1, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 1 } } } }) }
    })
    const heads = makeAgentHeads()
    const pending = heads.headOfMany!(['a'])
    await new Promise(resolve => setTimeout(resolve, 0))
    invalidate('heads')
    release()
    const reads = await pending
    assert.equal(reads.size, 1, 'the in-flight answer still serves this caller')
    await heads.headOfMany!(['a'])
    assert.ok(detailCalls >= 2, 'the invalidated answer is not cached')
  })
})
})

describe('pulseModel', () => {

function row(time: number, key = `event-${time}`, to = 'bee', from = 'lead'): CommsRow {
  return { seq: time, time, kind: 'relay', from, text: key, key, to }
}

function delegation(time: number, key: string, to = 'bee', from = 'lead'): FleetDelegationRow {
  return { key, time, seq: time, to, from, mode: 'continuable', label: `Initial ${key}` }
}

function agent(id: string, name = id): CommsAgent {
  return { id, name, role: 'subagent', self: false, hue: 'red' }
}

function node(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id,
    label: id,
    depth: 1,
    family: 1,
    isCurrent: false,
    running: false,
    completed: false,
    subagent: true,
    updatedAt: 1,
    head: null,
    billed: null,
    costUsage: null,
    durationMs: null,
    identity: null,
    requests: 0,
    ...over,
  }
}

describe('pulse timeline records', () => {
  test('orders messages and durable delegations naturally without inventing records', () => {
    const items = pulseTimelineItemsOf(
      [row(400), row(100), row(250)],
      [delegation(150, 'create-side', 'side'), delegation(100, 'create-bee')],
    )
    assert.deepEqual(items.map(item => [item.key, item.kind]), [
      ['create-bee', 'delegation'],
      ['event-100', 'message'],
      ['create-side', 'delegation'],
      ['event-250', 'message'],
      ['event-400', 'message'],
    ])
    assert.equal(items[0].from, 'lead')
    assert.equal(items[0].to, 'bee')
    assert.deepEqual(pulseTimelineItemsOf([], []), [])
  })

  test('uses deterministic ordering within equal timestamps and record kinds', () => {
    const items = pulseTimelineItemsOf(
      [row(100, 'event-b'), row(100, 'event-a')],
      [delegation(100, 'create-b'), delegation(100, 'create-a')],
    )
    assert.deepEqual(items.map(item => item.key), ['create-a', 'create-b', 'event-a', 'event-b'])
    assert.deepEqual(pulseTimelineItemsOf([row(50, 'early')], [delegation(100, 'later')]).map(item => item.key), ['early', 'later'])
  })

  test('the event stream reverses the natural order and groups and matches per kind', () => {
    const settledRow = { ...row(400, 'event-400'), kind: 'settled' as const, summary: 'it finished', report: 'all done' }
    const items = pulseEventItemsOf(
      [settledRow, row(100), row(250)],
      [delegation(150, 'create-side', 'side'), delegation(300, 'create-bee')],
    )
    assert.deepEqual(items.map(item => item.key), ['event-400', 'create-bee', 'event-250', 'create-side', 'event-100'])
    assert.deepEqual(items.map(item => pulseEventGroupOf(item)), ['report', 'delegation', 'message', 'delegation', 'message'])
    assert.deepEqual(pulseEventMatchesOf(items[0]), ['event-400', 'it finished', 'all done'])
    assert.deepEqual(pulseEventMatchesOf(items[1]), ['Initial create-bee'])
    assert.deepEqual(pulseEventMatchesOf(items[2]), ['event-250', undefined, undefined])
    assert.deepEqual(
      pulseEventItemsOf([row(100, 'b'), row(100, 'a')], []).map(item => item.key),
      ['a', 'b'],
    )
    assert.deepEqual(
      pulseEventItemsOf([row(100, 'a'), row(100, 'b')], []).map(item => item.key),
      ['a', 'b'],
    )
    assert.deepEqual(pulseEventItemsOf([], []), [])
  })
})

describe('pulse lane layout', () => {
  test('uses fixed natural-order slots and one baseline per lane', () => {
    const items = pulseTimelineItemsOf([
      row(0, 'a', 'bee'),
      row(1, 'b', 'bee'),
      row(100, 'c', 'bee'),
      row(50, 'd', 'lead', 'bee'),
    ], [])
    const layout = layoutPulse(items, ['lead', 'bee'])
    assert.deepEqual(layout.lanes.map(lane => [lane.id, lane.top, lane.height, lane.center]), [
      ['lead', 0, 68, 34],
      ['bee', 68, 68, 102],
    ])
    assert.equal(layout.height, 136)
    assert.equal(layout.width, 144)
    assert.deepEqual(layout.points.map(point => [point.key, point.x, point.y]), [
      ['a', 24, 102],
      ['b', 56, 102],
      ['d', 88, 34],
      ['c', 120, 102],
    ])
    assert.deepEqual(layoutPulse([], ['lead']), {
      width: 16,
      lanes: [{ id: 'lead', top: 0, height: 68, center: 34 }],
      points: [],
      height: 68,
    })
    assert.equal(layoutPulse(pulseTimelineItemsOf([row(1, 'hidden', 'outside')], []), ['bee']).points.length, 0)
  })

  test('keeps the complete sequence available for horizontal scrolling', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index, `event-${index}`))
    const layout = layoutPulse(pulseTimelineItemsOf(rows, []), ['bee'])
    assert.equal(layout.points.length, 500)
    assert.equal(layout.width, 16_016)
    assert.equal(layout.points[499].x, 15_992)
    const window = layoutPulse(pulseTimelineItemsOf(rows.slice(490), []), ['bee'], 500, 490)
    assert.equal(window.points.length, 10)
    assert.equal(window.points[0].x, 15_704)
    assert.equal(window.points[9].x, 15_992)
    assert.equal(window.width, 16_016)
  })
})

describe('pulse lane visibility', () => {
  const lanes = Array.from({ length: 10 }, (_, index) => ({
    agent: agent(`a${index}`, `Agent ${index}`),
    active: index === 1,
  }))

  test('folds quiet lanes around active traffic', () => {
    const rows = [row(1, 'traffic', 'a2', 'a3')]
    assert.deepEqual(pulseLaneVisibility(lanes, rows, [], null, '', false).visible, ['a1', 'a2', 'a3'])
    assert.deepEqual(pulseLaneVisibility(lanes, rows, [], null, '', true).visible, lanes.map(lane => lane.agent.id))
    assert.equal(pulseLaneVisibility(lanes, rows, [], null, '', false).matched.size, 0)
    assert.equal(pulseLaneVisibility(lanes, rows, [], null, '', true).matched.size, 0)
  })

  test('a selected agent keeps only itself and its directly linked lanes', () => {
    assert.deepEqual(pulseLaneVisibility(lanes, [], [], 'a4', '', false).visible, ['a4'])
    const links = [
      { from: 'a4', to: 'a7' },
      { from: 'a2', to: 'a4' },
      { from: 'a0', to: 'a1' },
    ]
    assert.deepEqual(pulseLaneVisibility(lanes, [], links, 'a4', '', false).visible, ['a2', 'a4', 'a7'])
    assert.deepEqual(pulseLaneVisibility(lanes.slice(0, 3), [], [], 'a1', '', false).visible, ['a1'])
  })

  test('a search keeps the matched lanes and the lanes linked to them', () => {
    const described = lanes.map(lane => ({ ...lane, agent: { ...lane.agent } }))
    described[8].agent.description = 'special duty'
    const links = [
      { from: 'a8', to: 'a6' },
      { from: 'a3', to: 'a8' },
      { from: 'a0', to: 'a1' },
    ]
    const special = pulseLaneVisibility(described, [], links, null, 'special', false)
    assert.deepEqual(special.visible, ['a3', 'a6', 'a8'])
    assert.deepEqual([...special.matched], ['a8'])
    const byName = pulseLaneVisibility(described, [], links, null, 'agent 5', false)
    assert.deepEqual(byName.visible, ['a5'])
    assert.deepEqual([...byName.matched], ['a5'])
    const unmatched = pulseLaneVisibility(described, [], links, null, 'nobody', false)
    assert.deepEqual(unmatched.visible, [])
    assert.equal(unmatched.matched.size, 0)
  })

  test('a lane search stays inside the related lanes of a selected agent', () => {
    const described = lanes.map(lane => ({ ...lane, agent: { ...lane.agent } }))
    described[8].agent.description = 'special duty'
    const links = [
      { from: 'a8', to: 'a6' },
      { from: 'a3', to: 'a8' },
      { from: 'a0', to: 'a1' },
    ]
    const focused = pulseLaneVisibility(described, [], links, 'a3', 'special', false)
    assert.deepEqual(focused.visible, ['a3', 'a8'])
    assert.deepEqual([...focused.matched], ['a8'])
    const outside = pulseLaneVisibility(described, [], links, 'a3', 'agent 5', false)
    assert.deepEqual(outside.visible, [])
  })

  test('small fleets never lose quiet lanes', () => {
    const small = lanes.slice(0, 3)
    assert.deepEqual(pulseLaneVisibility(small, [], [], null, '', false).visible, ['a0', 'a1', 'a2'])
  })
})

describe('pulse task lanes', () => {
  const team: FleetTeam = {
    members: [
      { id: 'lead', name: 'lead', role: 'lead', phase: 'active' },
      { id: 'bee', name: 'worker-bee', role: 'teammate', phase: 'active' },
    ],
    tasks: [
      { id: 'task-1', subject: 'Parse schema', description: '', status: 'in_progress', ownerName: 'worker-bee', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      { id: 'task-2', subject: 'Scan docs', description: '', status: 'pending', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
    ],
  }
  const tasksByAgent = pulseTasksByAgent(team)

  test('collects both endpoints of the records the filtered task owns, and nothing else', () => {
    const items = pulseTimelineItemsOf(
      [row(400, 'reply', 'lead', 'side'), row(300, 'note', 'side', 'bee'), row(200, 'aside', 'side', 'side')],
      [delegation(100, 'create-bee')],
    )
    assert.equal(pulseTaskLaneIdsOf(items, tasksByAgent, null), null)
    assert.deepEqual([...pulseTaskLaneIdsOf(items, tasksByAgent, 'task-1')!], ['lead', 'bee', 'side'])
    assert.deepEqual([...pulseTaskLaneIdsOf(items, tasksByAgent, 'task-2')!], ['side', 'lead'])
    assert.equal(pulseTaskLaneIdsOf(items, tasksByAgent, 'task-9')!.size, 0)
    assert.equal(pulseTaskLaneIdsOf([], tasksByAgent, 'task-1')!.size, 0)
  })
})

describe('pulse work queue', () => {
  test('combines team tasks with only non-team delegations and resolves owner selection', () => {
    const team: FleetTeam = {
      members: [
        { id: 'root', name: 'lead', role: 'lead', phase: 'active' },
        { id: 'bee', name: 'worker-bee', role: 'teammate', phase: 'active' },
      ],
      tasks: [{
        id: 'task-1',
        subject: 'Parse schema',
        description: 'All of it',
        status: 'in_progress',
        ownerName: 'worker-bee',
        blockedBy: ['task-0'],
        writeScopes: [],
        ready: false,
        warnings: [],
      }],
    }
    const forest = {
      solo: false,
      edges: [],
      nodes: [
        node('root', { isCurrent: true, subagent: false }),
        node('bee', { running: true }),
        node('side', { label: 'side-quest', completed: true }),
      ],
    }
    assert.deepEqual(pulseWorkItemsOf(forest, team), [
      {
        key: 'team:task-1',
        id: 'task-1',
        kind: 'team',
        subject: 'Parse schema',
        status: 'in_progress',
        ownerId: 'bee',
        ownerName: 'worker-bee',
        ownerState: 'running',
        description: 'All of it',
        blockedBy: ['task-0'],
        writeScopes: [],
        warnings: [],
        ready: false,
      },
      {
        key: 'agent:side',
        id: 'side',
        kind: 'agent',
        subject: 'side-quest',
        status: 'latest_complete',
        ownerId: 'side',
        ownerName: 'side-quest',
        ownerState: 'latest_complete',
        blockedBy: [],
        writeScopes: [],
        warnings: [],
        ready: false,
      },
    ])
  })

  test('keeps unowned tasks and idle delegations distinct and handles an empty model', () => {
    const team: FleetTeam = {
      members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }],
      tasks: [
        { id: 'done', subject: 'Done', description: '', status: 'completed', ownerName: 'lead', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
        { id: 'open', subject: 'Open', description: '', status: 'pending', blockedBy: [], writeScopes: [], ready: true, warnings: [] },
      ],
    }
    const forest = { solo: false, edges: [], nodes: [node('root', { isCurrent: true }), node('idle')] }
    const items = pulseWorkItemsOf(forest, team)
    assert.deepEqual(items.map(item => [item.key, item.status]), [['team:open', 'pending'], ['agent:idle', 'idle'], ['team:done', 'completed']])
    assert.equal(items[0].ownerId, undefined)
    assert.equal(items[0].description, undefined)
    assert.deepEqual(pulseWorkItemsOf(null, null), [])
  })

  test('modern ownerId tasks need no roster, keep one row per owner, and do not promote ordinary sessions to completed', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [{
        id: 'task-7',
        subject: 'Modern owner',
        description: '',
        status: 'in_progress',
        ownerId: 'bee',
        blockedBy: [],
        writeScopes: [],
        ready: false,
        warnings: [],
      }],
    }
    const forest = {
      solo: false,
      edges: [],
      nodes: [
        node('root', { isCurrent: false, subagent: false, completed: true, label: 'root' }),
        node('bee', { running: true, label: 'worker-bee', model: 'deepseek-flash', reasoningEffort: 'low' }),
        node('idle', { label: 'idle-one' }),
      ],
    }
    const items = pulseWorkItemsOf(forest, team)
    assert.deepEqual(items.map(item => [item.key, item.ownerId, item.ownerState]), [
      ['team:task-7', 'bee', 'running'],
      ['agent:root', 'root', 'idle'],
      ['agent:idle', 'idle', 'idle'],
    ])
    assert.equal(items[0].ownerName, 'worker-bee')
    assert.equal(items[0].ownerModel, 'deepseek-flash (low)')
    assert.deepEqual([...pulseTasksByAgent(team).keys()], ['bee'])
    assert.deepEqual(pulseTasksByAgent(team).get('bee')?.map(task => task.id), ['task-7'])
  })

  test('groups owners in first-seen order with unowned last, normalizes phases, and walks the full dependency chain', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [
        { id: 'task-1', subject: 'A', description: '', status: 'pending', ownerId: 'a', blockedBy: ['task-2'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-2', subject: 'B', description: '', status: 'completed', ownerId: 'b', blockedBy: ['task-3'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-3', subject: 'C', description: '', status: 'completed', blockedBy: [], writeScopes: [], ready: false, warnings: [] },
      ],
    }
    const items = pulseWorkItemsOf({ solo: false, edges: [], nodes: [] }, team)
    assert.deepEqual(pulseWorkGroupsOf(items).map(group => [group.key, group.items.length]), [
      ['id:a', 1],
      ['id:b', 1],
      ['unowned', 1],
    ])
    assert.equal(pulseWorkPhaseOf(items.find(item => item.id === 'task-1')!), 'pending')
    assert.equal(pulseWorkPhaseOf(items.find(item => item.id === 'task-2')!), 'completed')
    assert.deepEqual([...pulseDependencyChainOf(items, 'task-1')].sort(), ['task-2', 'task-3'])
    assert.equal(pulseTaskBadgeOf('task-12'), '12')
    assert.equal(pulseTaskBadgeOf('task-alpha'), 'task-alpha')
    assert.equal(pulseTaskBadgeOf('free'), 'free')
  })

  test('dependency walk tolerates missing blockers and cycles without inventing nodes', () => {
    const team: FleetTeam = {
      members: [],
      tasks: [
        { id: 'task-c', subject: 'C', description: '', status: 'pending', blockedBy: ['task-d'], writeScopes: [], ready: false, warnings: [] },
        { id: 'task-d', subject: 'D', description: '', status: 'pending', blockedBy: ['task-c', 'ghost'], writeScopes: [], ready: false, warnings: [] },
      ],
    }
    const items = pulseWorkItemsOf(null, team)
    assert.deepEqual([...pulseDependencyChainOf(items, 'task-c')].sort(), ['ghost', 'task-c', 'task-d'])
    assert.deepEqual([...pulseDependencyChainOf(items, 'missing')], [])
  })
})
})
