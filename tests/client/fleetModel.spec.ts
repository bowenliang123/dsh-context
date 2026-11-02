import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import {
  teamOfSnapshot,
  useFleetDetails,
  useFleetModel,
  type FleetDetailState,
  type FleetModel,
} from '../../src/client/fleetModel'
import { FleetDetailCache } from '../../src/client/fleetDetail'
import type { AgentNode } from '../../src/client/agentTree'
import type { FleetDetail } from '../../src/shared/types'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { flush, mount } from './helpers/kit'
import { makeAgentHeads } from '../../src/client/agentHeads'

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

describe('teamOfSnapshot', () => {
  const team = { members: [{ id: 'root', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] }

  test('the first carrying family row wins — DFS pre-order starts at the root', () => {
    const forest = { nodes: [nodeOf('root'), nodeOf('kid', { parentId: 'root' })], edges: [], solo: false }
    const snapshot = {
      byId: {
        kid: { projectionValues: { agentTeam: { members: [{ id: 'kid', name: 'k', role: 'lead', phase: 'active' }], tasks: [] } } },
        root: { projectionValues: { agentTeam: team } },
      },
    }
    assert.equal(teamOfSnapshot(snapshot, forest)?.members[0]?.id, 'root')
  })

  test('degrades: no forest, no byId, no carrier row, or a malformed value', () => {
    const forest = { nodes: [nodeOf('root')], edges: [], solo: true }
    assert.equal(teamOfSnapshot(null, forest), null)
    assert.equal(teamOfSnapshot({}, forest), null)
    assert.equal(teamOfSnapshot({ byId: null }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: {} } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: { projectionValues: { agentTeam: 'junk' } } } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: null } }, forest), null)
    assert.equal(teamOfSnapshot({ byId: { root: { projectionValues: { agentTeam: team } } } }, null), null)
  })
})

describe('useFleetModel', () => {
  function sessionsFace(byId: Record<string, unknown>, refreshed: string[]) {
    const snapshot = { byId }
    return {
      list: {
        getSnapshot: (): unknown => snapshot,
        subscribe: (): (() => void) => () => {},
      },
      refreshSubagents: (id: string) => {
        refreshed.push(id)
        return Promise.resolve()
      },
    }
  }

  test('inactive stays inert: no snapshot read, no refresh, no forest', async () => {
    const refreshed: string[] = []
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace({ s1: { running: true, updatedAt: 1 } }, refreshed) } })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, false)
      return null
    }
    const m = await mount(h(Probe))
    assert.equal(box.current?.forest, null)
    assert.equal(box.current?.team, null)
    assert.deepEqual(refreshed, [])
    await m.unmount()
    ctx.dispose()
  })

  test('active derives the forest and the team, and discovers the child catalog', async () => {
    const refreshed: string[] = []
    const byId = {
      s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
      kid: {
        parentId: 's1', origin: 'subagent', running: true, updatedAt: 2,
        projectionValues: { agentTeam: { members: [{ id: 's1', name: 'lead', role: 'lead', phase: 'active' }], tasks: [] } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, refreshed) } })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    assert.equal(box.current?.forest?.nodes.length, 2)
    assert.equal(box.current?.team?.members[0]?.name, 'lead')
    assert.equal(box.current?.titles.get('s1'), 'Main')
    assert.deepEqual(refreshed, ['s1'])
    await m.unmount()
    ctx.dispose()
  })

  test('a rejecting catalog refresh is swallowed', async () => {
    const snapshot = { byId: { s1: { running: true, updatedAt: 1 } } }
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: { getSnapshot: () => snapshot, subscribe: () => () => {} },
          refreshSubagents: () => Promise.reject(new Error('nope')),
        },
      },
    })
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), makeAgentHeads(), 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    assert.ok(box.current?.forest !== null)
    await flush()
    await m.unmount()
    ctx.dispose()
  })
})

function probeDetails(cache: FleetDetailCache, options?: { concurrency?: number; refreshDelayMs?: number; scopeKey?: string }): { box: { current: FleetDetailState | null }; Probe: () => null } {
  const box: { current: FleetDetailState | null } = { current: null }
  function Probe(): null {
    box.current = useFleetDetails(cache, options)
    return null
  }
  return { box, Probe }
}

describe('useFleetDetails', () => {
  function detailCache(serve: (id: string) => FleetDetail | null): FleetDetailCache {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((id: string) => Promise.resolve(serve(id)))
    return cache
  }

  test('request lands the detail, dedupes by stamp, and pending drains', async () => {
    const cache = detailCache(id => ({ messages: [], truncated: false, initialPrompt: `prompt of ${id}` }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.request('a', 1) })
    assert.equal(box.current?.pending.has('a'), true)
    await act(async () => {})
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.get('a')?.detail?.initialPrompt, 'prompt of a')

    act(() => { state.request('a', 1) })
    assert.equal(box.current?.pending.size, 0)
    act(() => { state.request('a', 2) })
    await act(async () => {})
    assert.equal(box.current?.landed.get('a')?.updatedAt, 2)
    await m.unmount()
  })

  test('two in-flight reads for one session: the stale landing is dropped and the latest drains pending', async () => {
    const cache = new FleetDetailCache()
    const releases: Array<(d: FleetDetail | null) => void> = []
    vi.spyOn(cache, 'fetch').mockImplementation(() => new Promise((resolve) => { releases.push(resolve) }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.request('a', 1) })
    act(() => { state.request('a', 2) })
    assert.equal(box.current?.pending.size, 1)
    await act(async () => { releases[0](null) })
    assert.equal(box.current?.pending.size, 1, 'the older stamp must not drain the newer read')
    assert.equal(box.current?.landed.get('a'), undefined)
    await act(async () => { releases[1]({ messages: [], truncated: false }) })
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.get('a')?.updatedAt, 2)
    await m.unmount()
  })

  test('a newer excerpt stamp lets the opened card refetch its full text once', async () => {
    const stamps: number[] = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, stamp: number, full?: boolean) => {
      if (full === true) stamps.push(stamp)
      return Promise.resolve({ messages: [], truncated: false })
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.request('a', 1) })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.deepEqual(stamps, [1], 'the same stamp replays from the full ledger')

    act(() => { state.request('a', 2) })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.deepEqual(stamps, [1, 2], 'a newer session stamp refreshes the open card')
    await m.unmount()
  })

  test('a landing after unmount updates nothing, for the excerpt and full ledgers alike', async () => {
    for (const full of [false, true]) {
      const cache = new FleetDetailCache()
      let release: (d: FleetDetail | null) => void = () => {}
      vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, isFull?: boolean) => {
        if (full && isFull !== true) return Promise.resolve(null)
        return new Promise((resolve) => { release = resolve })
      })
      const { box, Probe } = probeDetails(cache)
      const m = await mount(h(Probe))
      const state = box.current as FleetDetailState
      act(() => {
        if (full) state.requestFull('a')
        else state.request('a', 1)
      })
      await m.unmount()
      release(null)
      await flush()
      assert.equal(box.current?.landed.size, 0)
      assert.equal(box.current?.fullLanded.size, 0)
    }
  })

  test('requestFull reads once per session, lands a detail or null, and never touches the excerpt ledger', async () => {
    let fullReads = 0
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((id: string, _stamp: number, full?: boolean) => {
      if (full !== true) return Promise.resolve(null)
      fullReads += 1
      return Promise.resolve(id === 'a' ? { messages: [], truncated: false, lastReply: { time: 1, text: 'FULL' } } : null)
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.requestFull('a') })
    assert.equal(box.current?.fullPending.has('a'), true)
    act(() => { state.requestFull('a') })
    await act(async () => {})
    assert.equal(fullReads, 1)
    assert.equal(box.current?.fullPending.size, 0)
    assert.equal(box.current?.fullLanded.get('a')?.lastReply?.text, 'FULL')
    assert.equal(box.current?.landed.size, 0, 'the excerpt ledger stays untouched')

    act(() => { state.requestFull('b') })
    await act(async () => {})
    assert.equal(box.current?.fullLanded.get('b') ?? null, null, 'the absence path lands as null')
    assert.equal(box.current?.fullPending.size, 0)
    act(() => { state.requestFull('b') })
    await act(async () => {})
    assert.equal(fullReads, 2, 'a settled ask is deduped even when it read nothing')
    await m.unmount()
  })

  test('the full state keeps only the most recently opened cards and replays an evicted one', async () => {
    let reads = 0
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation(() => {
      reads += 1
      return Promise.resolve({ messages: [], truncated: false })
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => {
      for (let i = 0; i < 9; i++) state.requestFull(`s${i}`)
    })
    await act(async () => {})
    assert.equal(box.current?.fullLanded.size, 8)
    assert.equal(box.current?.fullLanded.has('s0'), false)
    assert.equal(box.current?.fullLanded.has('s8'), true)
    assert.equal(box.current?.fullPending.size, 0)
    assert.equal(reads, 9)

    act(() => { (box.current as FleetDetailState).requestFull('s0') })
    await act(async () => {})
    assert.equal(reads, 10, 'the evicted card replays from the cache')
    assert.equal(box.current?.fullLanded.has('s0'), true)
    assert.equal(box.current?.fullLanded.size, 8)
    assert.equal(box.current?.fullLanded.has('s1'), false)
    await m.unmount()
  })

  test('a stale full landing is dropped; the latest drains pending exactly once', async () => {
    const releases: Array<(d: FleetDetail | null) => void> = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, _stamp: number, full?: boolean) => {
      if (full !== true) return Promise.resolve(null)
      return new Promise((resolve) => { releases.push(resolve) })
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState

    act(() => { state.request('a', 5) })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    act(() => { state.request('a', 6) })
    await act(async () => {})
    act(() => { state.requestFull('a') })
    assert.equal(releases.length, 2)
    assert.equal(box.current?.fullPending.size, 1)

    const stale: FleetDetail = { messages: [], truncated: false, lastReply: { time: 1, text: 'stale' } }
    await act(async () => { releases[0]!(stale) })
    assert.equal(box.current?.fullLanded.get('a'), undefined, 'the older stamp is stale')
    assert.equal(box.current?.fullPending.size, 1)

    const latest: FleetDetail = { messages: [], truncated: false, lastReply: { time: 2, text: 'latest' } }
    await act(async () => { releases[1]!(latest) })
    assert.equal(box.current?.fullLanded.get('a')?.lastReply?.text, 'latest')
    assert.equal(box.current?.fullPending.size, 0)
    await m.unmount()
  })

})

describe('useFleetDetails history and scope', () => {
  test('complete history lands once, dedupes, refreshes and resets by scope', async () => {
    const reads: number[] = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchHistory').mockImplementation((_id: string, stamp: number) => {
      reads.push(stamp)
      return Promise.resolve({ messages: [{ seq: stamp, time: stamp, kind: 'relay', text: `history ${stamp}` }], truncated: false })
    })
    const options = { scopeKey: 'one', refreshDelayMs: 10 }
    const { box, Probe } = probeDetails(cache, options)
    const mounted = await mount(h(Probe))
    const state = box.current as FleetDetailState
    vi.useFakeTimers()
    act(() => { state.requestHistory('a', 1) })
    assert.equal(box.current?.historyPending.has('a'), true)
    await act(async () => {})
    assert.equal(box.current?.historyLanded.get('a')?.detail?.messages[0]?.text, 'history 1')
    assert.equal(box.current?.historyPending.size, 0)
    act(() => { state.requestHistory('a', 1) })
    assert.deepEqual(reads, [1])
    act(() => { (box.current as FleetDetailState).requestHistory('a', 2) })
    await act(async () => { await vi.advanceTimersByTimeAsync(5) })
    act(() => { (box.current as FleetDetailState).requestHistory('a', 3) })
    await act(async () => { await vi.advanceTimersByTimeAsync(15) })
    assert.deepEqual(reads, [1, 3])
    act(() => { state.request('a', 2) })
    act(() => { state.requestFull('a') })
    await act(async () => {})
    act(() => { (box.current as FleetDetailState).requestHistory('a', 4) })
    options.scopeKey = 'two'
    await mounted.update(h(Probe))
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    assert.ok(!reads.includes(4))
    assert.equal(box.current?.landed.size, 0)
    assert.equal(box.current?.historyLanded.size, 0)
    assert.equal(box.current?.fullLanded.size, 0)
    await mounted.unmount()
    vi.useRealTimers()
  })

  test('history landing after unmount is inert', async () => {
    let release: (detail: FleetDetail | null) => void = () => {}
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchHistory').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { box, Probe } = probeDetails(cache)
    const mounted = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.requestHistory('a', 1) })
    await mounted.unmount()
    release({ messages: [], truncated: false })
    await flush()
    assert.equal(box.current?.historyLanded.size, 0)
  })
  test('a rejected history read settles pending without landing', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchHistory').mockRejectedValue(new Error('offline'))
    const { box, Probe } = probeDetails(cache)
    const mounted = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.requestHistory('a', 1) })
    await act(async () => {})
    assert.equal(box.current?.historyPending.size, 0)
    assert.equal(box.current?.historyLanded.size, 0)
    await mounted.unmount()
  })
})

describe('useFleetDetails scheduling', () => {
  test('a bounded concurrency queue fills in order and drains pending exactly once', async () => {
    const cache = new FleetDetailCache()
    const releases: Array<{ id: string; release: (d: FleetDetail | null) => void }> = []
    vi.spyOn(cache, 'fetch').mockImplementation((id: string) => new Promise((resolve) => {
      releases.push({ id, release: resolve })
    }))
    const { box, Probe } = probeDetails(cache, { concurrency: 1 })
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => {
      state.request('a', 1)
      state.request('b', 1)
    })
    assert.equal(box.current?.pending.size, 2)
    assert.deepEqual(releases.map(r => r.id), ['a'])
    await act(async () => { releases[0].release({ messages: [], truncated: false }) })
    assert.deepEqual(releases.map(r => r.id), ['a', 'b'])
    assert.equal(box.current?.pending.has('a'), false)
    assert.equal(box.current?.pending.has('b'), true)
    await act(async () => { releases[1].release({ messages: [], truncated: false }) })
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.size, 2)
    await m.unmount()
  })

  test('a landed card debounces its refresh and keeps the old detail visible meanwhile', async () => {
    vi.useFakeTimers()
    const reads: number[] = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, stamp: number) => {
      reads.push(stamp)
      return Promise.resolve({ messages: [], truncated: false })
    })
    const { box, Probe } = probeDetails(cache, { refreshDelayMs: 50 })
    const m = await mount(h(Probe))
    const state = box.current as FleetDetailState
    act(() => { state.request('a', 1) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    assert.equal(box.current?.landed.get('a')?.updatedAt, 1)
    act(() => { (box.current as FleetDetailState).request('a', 2) })
    assert.equal(box.current?.pending.has('a'), false, 'a refresh never blanks a landed card')
    assert.deepEqual(reads, [1])
    await act(async () => { await vi.advanceTimersByTimeAsync(40) })
    assert.deepEqual(reads, [1], 'the window holds')
    await act(async () => { await vi.advanceTimersByTimeAsync(20) })
    assert.deepEqual(reads, [1, 2])
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    assert.equal(box.current?.landed.get('a')?.updatedAt, 2)
    await m.unmount()
    vi.useRealTimers()
  })
})

describe('useFleetDetails — failure and queue replacement', () => {
  test('a rejected read settles its pending mark without landing', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockRejectedValue(new Error('offline'))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).request('a', 1) })
    await act(async () => {})
    assert.equal(box.current?.pending.size, 0)
    assert.equal(box.current?.landed.size, 0)
    await m.unmount()
  })

  test('a queued id keeps only its newest stamp while the slot is busy', async () => {
    const cache = new FleetDetailCache()
    const releases: Array<{ id: string; stamp: number; release: (d: FleetDetail | null) => void }> = []
    vi.spyOn(cache, 'fetch').mockImplementation((id: string, stamp: number) => new Promise((resolve) => {
      releases.push({ id, stamp, release: resolve })
    }))
    const { box, Probe } = probeDetails(cache, { concurrency: 1 })
    const m = await mount(h(Probe))
    act(() => {
      ;(box.current as FleetDetailState).request('a', 1)
      ;(box.current as FleetDetailState).request('b', 1)
      ;(box.current as FleetDetailState).request('b', 2)
    })
    assert.deepEqual(releases.map(r => `${r.id}@${r.stamp}`), ['a@1'])
    await act(async () => { releases[0].release(null) })
    assert.deepEqual(releases.map(r => `${r.id}@${r.stamp}`), ['a@1', 'b@2'])
    await act(async () => { releases[1].release(null) })
    assert.equal(box.current?.landed.get('b')?.updatedAt, 2)
    await m.unmount()
  })
})

describe('useFleetDetails — refresh window edges', () => {
  test('a newer stamp resets the armed window, and unmount cancels it', async () => {
    vi.useFakeTimers()
    const reads: number[] = []
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetch').mockImplementation((_id: string, stamp: number) => {
      reads.push(stamp)
      return Promise.resolve({ messages: [], truncated: false })
    })
    const { box, Probe } = probeDetails(cache, { refreshDelayMs: 50 })
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).request('a', 1) })
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => { (box.current as FleetDetailState).request('a', 2) })
    await act(async () => { await vi.advanceTimersByTimeAsync(30) })
    act(() => { (box.current as FleetDetailState).request('a', 3) })
    await act(async () => { await vi.advanceTimersByTimeAsync(40) })
    assert.deepEqual(reads, [1], 'the first window was reset by the newer stamp')
    await act(async () => { await vi.advanceTimersByTimeAsync(10) })
    assert.deepEqual(reads, [1, 3])
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    act(() => { (box.current as FleetDetailState).request('a', 4) })
    await m.unmount()
    await vi.advanceTimersByTimeAsync(100)
    assert.deepEqual(reads, [1, 3], 'an unmounted card never fires its pending refresh')
    vi.useRealTimers()
  })
})
