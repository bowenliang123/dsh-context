import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  teamOfSnapshot,
  useFleetModel,
  type FleetModel,
} from '../../src/client/fleetModel'
import { invalidate, resetInvalidations } from '../../src/client/invalidation'
import type { AgentNode } from '../../src/client/agentTree'
import type { ContextTimeline } from '../../src/shared/types'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { flush, mount, until } from './helpers/kit'
import { makeAgentHeads } from '../../src/client/agentHeads'

function headTimeline(total: number, over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 0, tools: 0, user: total, inject: 0, skill: 0, assistant: 0, tool: 0, total },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetInvalidations()
})

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

  test('a wide fleet asks every child once through the batch head channel and keeps the landed ledger', async () => {
    const byId: Record<string, unknown> = { s1: { displayTitle: 'Main', running: true, updatedAt: 1 } }
    for (let i = 0; i < 130; i++) byId[`kid-${i}`] = { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, []) } })
    const batches: string[][] = []
    const heads = {
      headOf: (id: string) => {
        batches.push([id])
        return Promise.resolve(headTimeline(5))
      },
      headOfMany: (ids: readonly string[]) => {
        batches.push([...ids])
        return Promise.resolve(new Map(ids.map(id => [id, headTimeline(5)] as const)))
      },
    }
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), heads, 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    await until(() => box.current?.forest?.nodes.length === 131, 'the whole family never landed')
    assert.equal(batches.length, 1, 'one batch read covers the fleet')
    await flush()
    await m.unmount()
    ctx.dispose()
  })

  test('a failed head batch retries on the next snapshot change; an absent head re-asks only when its stamp advances', async () => {
    let snapshot: { byId: Record<string, unknown> } = {
      byId: {
        s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
        kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
        kid2: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
      },
    }
    const listeners = new Set<() => void>()
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: {
            getSnapshot: (): unknown => snapshot,
            subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
          },
        },
      },
    })
    let calls = 0
   let fail = true
    const heads = {
      headOf: (): Promise<ContextTimeline | null> => {
        calls += 1
        return Promise.resolve(null)
      },
      headOfMany: (): Promise<Map<string, ContextTimeline>> => {
        calls += 1
        if (fail) return Promise.reject(new Error('down'))
        return Promise.resolve(new Map())
      },
    }
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), heads, 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    await until(() => calls === 1, 'the first batch read never fired')
    fail = false
    await act(async () => {
      snapshot = { byId: { ...snapshot.byId, kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 3 } } }
      for (const fn of listeners) fn()
    })
    await until(() => calls === 2, 'the failed batch never retried')
    await flush()
    await act(async () => {
      snapshot = { byId: { ...snapshot.byId, kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 4 } } }
      for (const fn of listeners) fn()
    })
    await until(() => calls >= 3, 'the advanced child stamp re-asks the heads')
    await m.unmount()
    ctx.dispose()
  })

  test('an unrelated invalidation is ignored and a landed zero-token head is not re-asked on a version bump', async () => {
    const byId: Record<string, unknown> = {
      s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
      kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
    }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, []) } })
    const heads = { headOf: () => Promise.resolve(null), headOfMany: undefined as never }
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), heads, 's1', undefined, true)
      return null
    }
    const reads = vi.spyOn(heads, 'headOf')
    const m = await mount(h(Probe))
    await until(() => reads.mock.calls.length === 1, 'the absent head was never read')
    await flush()
    await act(async () => { invalidate('overview') })
    await act(async () => { invalidate('heads', { sessionId: 'other' }) })
    await flush()
    assert.equal(reads.mock.calls.length, 1, 'an absent head with an unchanged stamp is not re-read')
    await m.unmount()
    ctx.dispose()
  })

  test('a pricing invalidation refreshes the heads whose cost read is missing or not ready', async () => {
    const byId: Record<string, unknown> = {
      s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
      a: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
      b: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
    }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, []) } })
    const heads = {
      headOf: (id: string) => Promise.resolve(headTimeline(5, id === 'a' ? { costRead: { usd: 0.2, ready: true } } : {})),
      headOfMany: (ids: readonly string[]) => Promise.resolve(new Map(ids.map(id => [
        id,
        headTimeline(5, id === 'a' ? { costRead: { usd: 0.2, ready: true } } : {}),
      ] as const))),
    }
    const box: { current: FleetModel | null } = { current: null }
    function Probe(): null {
      box.current = useFleetModel(asClientCtx(ctx), heads, 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    await until(() => box.current?.forest?.nodes.length === 3, 'the family heads never landed')
    const batches = vi.spyOn(heads, 'headOfMany')
    const singles = vi.spyOn(heads, 'headOf')
    await act(async () => { invalidate('pricing') })
    await until(() => singles.mock.calls.length === 1, 'the stale-cost head never re-asked')
    assert.deepEqual(singles.mock.calls[0], ['b'])
    assert.equal(batches.mock.calls.length, 0, 'a single stale head reads alone')
    await act(async () => { invalidate('heads', { sessionId: 'a' }) })
    await flush()
    await act(async () => { invalidate('heads') })
    await flush()
    await m.unmount()
    ctx.dispose()
  })

  test('an absent single head read settles without landing and retries when its stamp advances', async () => {
    let snapshot: { byId: Record<string, unknown> } = {
      byId: {
        s1: { displayTitle: 'Main', running: true, updatedAt: 1 },
        kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
      },
    }
    const listeners = new Set<() => void>()
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: {
            getSnapshot: (): unknown => snapshot,
            subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
          },
        },
      },
    })
    const reads = vi.fn(() => Promise.resolve(null))
    const heads = { headOf: reads }
    function Probe(): null {
      useFleetModel(asClientCtx(ctx), heads, 's1', undefined, true)
      return null
    }
    const m = await mount(h(Probe))
    await until(() => reads.mock.calls.length === 1, 'the absent head was never read')
    await flush()
    snapshot = { byId: { ...snapshot.byId, kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 3 } } }
    await act(async () => { for (const fn of listeners) fn() })
    await until(() => reads.mock.calls.length === 2, 'the advanced stamp never re-read the absent head')
    await m.unmount()
    ctx.dispose()
  })

  test('switching sessions reads each session\'s own child and reuses the landed head on return', async () => {
    const byId: Record<string, unknown> = {
      s1: { displayTitle: 'One', running: true, updatedAt: 1 },
      s2: { displayTitle: 'Two', running: true, updatedAt: 1 },
      kid: { parentId: 's1', origin: 'subagent', running: false, updatedAt: 2 },
      kid2: { parentId: 's2', origin: 'subagent', running: false, updatedAt: 2 },
    }
    const ctx = new TestClientCtx({ services: { sessions: sessionsFace(byId, []) } })
    const calls: string[] = []
    const heads = { headOf: (id: string) => { calls.push(id); return Promise.resolve(headTimeline(5)) } }
    function Probe(props: { id: string }): null {
      useFleetModel(asClientCtx(ctx), heads, props.id, undefined, true)
      return null
    }
    const m = await mount(h(Probe, { id: 's1' }))
    await until(() => calls.length === 1, 'the first session child read never fired')
    await m.update(h(Probe, { id: 's2' }))
    await until(() => calls.length === 2, 'the second session child read never fired')
    assert.deepEqual(calls, ['kid', 'kid2'])
    await m.update(h(Probe, { id: 's1' }))
    await flush()
    assert.deepEqual(calls, ['kid', 'kid2'], 'the already-landed head serves the return')
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
