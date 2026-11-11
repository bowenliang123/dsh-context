import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { teamOfSnapshot, useFleetModel, type FleetModel } from '../../src/client/fleetModel'
import { invalidate, resetInvalidations } from '../../src/client/invalidation'
import { type AgentNode } from '../../src/client/agentTree'
import { type ContextTimeline, type ContextEventRecord } from '../../src/shared/types'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { flush, mount, until, query, text, wheel, makeKit, makeTranslate, queryAll } from './helpers/kit'
import { makeAgentHeads } from '../../src/client/agentHeads'
import { watchFleetTab } from '../../src/client/fleetTab'
import { createContextSettings } from '../../src/client/settings'
import { measureDock } from '../../src/client/dockMeasure'
import { containHorizontalOverscroll } from '../../src/client/overscroll'
import { activateViewTab, currentFleetMemberFocus, openContextSidebar, requestContextFocus, requestFleetMemberFocus, subscribeContextFocus, takeContextFocus, useFleetMemberFocus } from '../../src/client/viewFocus'
import { disposeRetention } from '../../src/client/retention'
import { DICT_EN } from '../../src/client/i18n'
import { makeViewKit } from '../../src/client/viewkit'
import { readFile } from 'node:fs/promises'
import { ContextIcon, InsightPanelIcon, makeContextTabTitle } from '../../src/client/icon'

describe('fleetModel', () => {

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
})

describe('fleetTab', () => {

const NS = 'dsh-context'

function view(): ReactElement {
  return h('div', { className: 'fleet-view' }, 'fleet')
}

function wire(ctx: TestClientCtx, settings = createContextSettings()): { dispose: () => void; settings: ReturnType<typeof createContextSettings> } {
  const t = ctx.locale.bind(NS)
  const dispose = watchFleetTab(asClientCtx(ctx), settings, view, t, NS)
  return { dispose, settings }
}

describe('watchFleetTab — the Fleet tab\'s own gate', () => {
  test('show (the default) registers the tab right of the Context tab', async () => {
    const ctx = new TestClientCtx()
    const { dispose } = wire(ctx)
    const entries = ctx.slots.of('conversation.view')
    assert.equal(entries.length, 1)
    const { registration, component } = entries[0]
    assert.equal(registration.name, 'conversation.view')
    assert.equal(registration.id, 'fleet')
    assert.equal(registration.order, 30, 'right of the Context tab (20)')
    assert.equal(registration.locale, NS)
    assert.equal(registration.label?.(), 'Fleet')
    const m = await mount(component({ sessionId: 's-1' }) as ReactElement)
    assert.equal(text(query(m.container, '.fleet-view')), 'fleet')
    await m.unmount()
    dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [], 'the watcher dispose unwinds the tab')
    ctx.dispose()

    const bare = new TestClientCtx()
    ;(bare.slots as unknown as { register: () => unknown }).register = () => undefined
    const guarded = wire(bare)
    guarded.settings.set('fleetTab', 'hide')
    guarded.settings.set('fleetTab', 'show')
    guarded.dispose()
    assert.deepEqual(bare.slots.of('conversation.view'), [], 'a no-disposer registry never throws')
    bare.dispose()
  })

  test('hide unwinds it live and show brings it back, with no churn in between', () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    const scope = {
      getSnapshot: () => ({ status: 'ready', value: { fleetTab: 'hide' }, writable: true }),
      subscribe: () => () => {},
      set: () => Promise.resolve(),
    }
    settings.attach(scope)
    assert.equal(settings.fleetTab(), 'hide')
    const { dispose } = wire(ctx, settings)
    assert.deepEqual(ctx.slots.of('conversation.view'), [], 'a hidden tab never registers')

    settings.set('defaultGranularity', 'turn')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])

    settings.set('fleetTab', 'show')
    assert.equal(ctx.slots.of('conversation.view').length, 1)
    assert.equal(ctx.slots.of('conversation.view')[0].registration.id, 'fleet')
    settings.set('fleetTab', 'hide')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    dispose()
    settings.set('fleetTab', 'show')
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    ctx.dispose()
  })

  test('the Context panel\'s placement never gates the tab', () => {
    const ctx = new TestClientCtx()
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'sidebar')
    const { dispose } = wire(ctx, settings)
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'a sidebar-only Context panel leaves the tab served')
    settings.set('defaultPlacement', 'all')
    assert.equal(ctx.slots.of('conversation.view').length, 1)
    settings.set('defaultPlacement', 'tab')
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'no placement churn')
    settings.set('defaultPlacement', 'hide')
    assert.equal(ctx.slots.of('conversation.view').length, 1, 'a hidden panel entry leaves the tab served')
    dispose()
    assert.deepEqual(ctx.slots.of('conversation.view'), [])
    ctx.dispose()
  })
})
})

describe('dockMeasure', () => {

function chainOf(...ancestors: HTMLElement[]): HTMLElement {
  for (let i = 0; i < ancestors.length - 1; i++) ancestors[i].appendChild(ancestors[i + 1])
  return ancestors[ancestors.length - 1]
}

function frameEl(template: string): HTMLDivElement {
  const el = document.createElement('div')
  el.style.gridTemplateColumns = template
  return el
}

afterEach(() => { vi.unstubAllGlobals() })

describe('measureDock', () => {
  test('resolves to the full mask without a start element or without an ancestor carrying an inline template', () => {
    assert.deepEqual(measureDock(null), { left: 0, right: 0, frame: null })
    const start = chainOf(document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
  })

  test('parses the sidebar tracks off the frame ancestor (fixed right track)', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px minmax(0, 1fr) 360px')
    const start = chainOf(frame, document.createElement('div'), document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 360, frame })
  })

  test('parses the minmax spelling: the right panel open and closed', () => {
    vi.stubGlobal('innerWidth', 1280)
    const openFrame = frameEl('280px minmax(400px, 1fr) minmax(0px, 576px)')
    assert.deepEqual(measureDock(chainOf(openFrame, document.createElement('div'))), { left: 280, right: 576, frame: openFrame })
    const closedFrame = frameEl('280px minmax(0px, 1fr) minmax(0px, 0px)')
    assert.deepEqual(measureDock(chainOf(closedFrame, document.createElement('div'))), { left: 280, right: 0, frame: closedFrame })
  })

  test('clamps the trailing bound to the space the centre minimum leaves (the grid squeeze)', () => {
    vi.stubGlobal('innerWidth', 1100)
    const frame = frameEl('280px minmax(400px, 1fr) minmax(0px, 576px)')
    assert.deepEqual(measureDock(chainOf(frame, document.createElement('div'))), { left: 280, right: 420, frame })

    vi.stubGlobal('innerWidth', 640)
    const starved = frameEl('280px minmax(400px, 1fr) minmax(0px, 360px)')
    assert.deepEqual(measureDock(chainOf(starved, document.createElement('div'))), { left: 280, right: 0, frame: starved })
  })

  test('parses a fractional track and a collapsed 0px rail', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('264.5px minmax(0, 1fr) 0px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 264.5, right: 0, frame })

    assert.deepEqual(measureDock(chainOf(frameEl('0px minmax(0, 1fr) 0px'), document.createElement('div'))).left, 0)
  })

  test('a centre track without a declared minimum leaves the whole remainder to the right panel', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px 1fr 360px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 360, frame })
  })

  test('a template of the leading track alone insets no right edge', () => {
    vi.stubGlobal('innerWidth', 1024)
    const frame = frameEl('280px')
    const start = chainOf(frame, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 280, right: 0, frame })
  })

  test('resolves to the full mask when the frame template is unparsable', () => {
    for (const template of ['', 'minmax(0, 1fr)', 'auto 1fr', 'auto 1fr 360px']) {
      const start = chainOf(frameEl(template), document.createElement('div'))
      assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
    }
  })

  test('a hostile ancestor degrades to the full mask instead of throwing', () => {
    const hostile = document.createElement('div')
    Object.defineProperty(hostile, 'style', { get() { throw new Error('hostile') } })
    const start = chainOf(hostile, document.createElement('div'))
    assert.deepEqual(measureDock(start), { left: 0, right: 0, frame: null })
  })
})
})

describe('overscroll', () => {

function scroller(scrollLeft: number, clientWidth: number, scrollWidth: number): HTMLDivElement {
  const el = document.createElement('div')
  let left = scrollLeft
  Object.defineProperties(el, {
    scrollLeft: { configurable: true, get: () => left, set: (v: number) => { left = v } },
    clientWidth: { configurable: true, get: () => clientWidth },
    scrollWidth: { configurable: true, get: () => scrollWidth },
  })
  return el
}

describe('containHorizontalOverscroll', () => {
  test('cancels only the horizontal gestures the scroller cannot consume', () => {
    const el = scroller(100, 100, 300)
    const release = containHorizontalOverscroll(el)

    assert.equal(wheel(el, 30, 0), false, 'rightward mid-scroll')
    assert.equal(wheel(el, -30, 0), false, 'leftward mid-scroll')
    assert.equal(wheel(el, 30, 120), false, 'vertical-dominant at the edge')
    assert.equal(wheel(el, 0, 0), false, 'no horizontal component')
    el.scrollLeft = 200
    assert.equal(wheel(el, 30, 0), true, 'right edge')
    assert.equal(wheel(el, -30, 0), false, 'leftward off the right edge scrolls back')
    el.scrollLeft = 0
    assert.equal(wheel(el, -30, 0), true, 'left edge')
    assert.equal(wheel(el, 30, 0), false, 'rightward off the left edge scrolls on')
    el.scrollLeft = 199.5
    assert.equal(wheel(el, 30, 0), true, 'right edge with a fractional offset')

    release()
    assert.equal(wheel(el, 30, 0), false, 'the disposer removed the listener')
  })
})
})

describe('viewFocus', () => {

describe('context focus relay', () => {
  test('one request survives until taken; a fresh request replaces it and sessions are isolated', () => {
    requestContextFocus('sv-relay', 42)
    assert.equal(takeContextFocus('sv-relay'), 42)
    assert.equal(takeContextFocus('sv-relay'), null, 'one-shot: a second take finds nothing')
    requestContextFocus('sv-race', 7)
    requestContextFocus('sv-race', 9)
    assert.equal(takeContextFocus('sv-race'), 9, 'the latest click wins')
    requestContextFocus('sv-other', 1)
    assert.equal(takeContextFocus('sv-other'), 1)
    assert.equal(takeContextFocus('sv-unknown'), null)
  })
})

describe('context focus subscription', () => {
  test('every record wakes the subscriber; the unsubscribe stops delivery', () => {
    let hits = 0
    const off = subscribeContextFocus(() => { hits++ })
    requestContextFocus('sv-a', 1)
    assert.equal(hits, 1)
    requestContextFocus('sv-b', 2)
    assert.equal(hits, 2, 'other-session records wake the view too — it takes only its own entry')
    off()
    requestContextFocus('sv-a', 3)
    assert.equal(hits, 2, 'the detached listener hears nothing')
    takeContextFocus('sv-a')
    takeContextFocus('sv-b')
  })

  test('a listener unsubscribing another mid-notify skips it (later records do not re-run it)', () => {
    let late = 0
    let offLate: () => void = () => {}
    const offRemover = subscribeContextFocus(() => { offLate() })
    offLate = subscribeContextFocus(() => { late++ })
    requestContextFocus('sv-mid', 1)
    assert.equal(late, 0, 'an element removed before iteration reaches it never runs')
    requestContextFocus('sv-mid', 2)
    assert.equal(late, 0, 'and it stays detached')
    offRemover()
    takeContextFocus('sv-mid')
  })
})

describe('openContextSidebar', () => {
  test('opens the registered kind through the sidebarRight face; absent or verb-less faces report false', () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openTab: (kind: string) => { opened.push(kind) } } } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), true)
    assert.deepEqual(opened, ['dsh-context'])

    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx())), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: {} } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: null } }))), false)
    assert.equal(openContextSidebar(asClientCtx(new TestClientCtx({ services: { sidebarRight: 'x' } }))), false)
  })

  test('a hostile face — throwing read or openTab — reports false, never throws', () => {
    const throwingRead = {
      get(_name: string): unknown { throw new Error('boom') },
    } as unknown as TestClientCtx
    assert.equal(openContextSidebar(asClientCtx(throwingRead)), false)
    const ctx = new TestClientCtx({ services: {
      sidebarRight: { openTab: () => { throw new Error('no session surface mounted') } },
    } })
    assert.equal(openContextSidebar(asClientCtx(ctx)), false)
  })
})

describe('activateViewTab', () => {
  test('clicks the inactive tab matching the label, skips the active one, and reports misses', () => {
    type Counted = HTMLElement & { __clicks: () => number }
    const bar = document.createElement('div')
    const mk = (label: string, selected: boolean): Counted => {
      const b = document.createElement('button')
      b.setAttribute('role', 'tab')
      if (selected) b.setAttribute('aria-selected', 'true')
      b.textContent = label
      let clicks = 0
      b.addEventListener('click', () => { clicks++ })
      const counted = Object.assign(b, { __clicks: () => clicks })
      bar.appendChild(counted)
      return counted
    }
    const chat = mk('Chat', true)
    const context = mk('Context', false)
    const trajectory = mk('Trajectory', false)
    document.body.appendChild(bar)
    try {
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)
      assert.equal(chat.__clicks(), 0)

      context.setAttribute('aria-selected', 'true')
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 1)

      context.setAttribute('aria-selected', 'false')
      context.textContent = '  Context '
      assert.equal(activateViewTab('Context'), true)
      assert.equal(context.__clicks(), 2)

      assert.equal(activateViewTab('Missing'), false)
      assert.equal(trajectory.__clicks(), 0)
    } finally {
      bar.remove()
    }
  })
})

describe('focus relays stay bounded and release on dispose', () => {
  test('the pending focus map keeps only its newest sixteen sessions', () => {
    for (let i = 0; i < 17; i++) requestContextFocus('focus-cap-' + i, i)
    assert.equal(takeContextFocus('focus-cap-0'), null)
    assert.equal(takeContextFocus('focus-cap-16'), 16)
  })

  test('the member focus map keeps only its newest eight sessions', () => {
    for (let i = 0; i < 9; i++) requestFleetMemberFocus('member-cap-' + i, 'm' + i)
    assert.equal(currentFleetMemberFocus('member-cap-0'), null)
    assert.equal(currentFleetMemberFocus('member-cap-8'), 'm8')
  })

  test('dispose clears pending relays and listeners', () => {
    let hits = 0
    subscribeContextFocus(() => { hits++ })
    requestContextFocus('focus-dispose', 3)
    requestFleetMemberFocus('member-dispose', 'm')
    disposeRetention()
    assert.equal(takeContextFocus('focus-dispose'), null)
    assert.equal(currentFleetMemberFocus('member-dispose'), null)
    const before = hits
    requestContextFocus('focus-after-1', 1)
    requestContextFocus('focus-after-2', 2)
    assert.equal(hits, before, 'the disposed listeners hear nothing')
    takeContextFocus('focus-after-1')
    takeContextFocus('focus-after-2')
  })
})

describe('useFleetMemberFocus', () => {
  test('follows the recorded member and detaches on a session change', async () => {
    const box: { current: string | null } = { current: null }
    function Probe(props: { sessionId?: string }): null {
      box.current = useFleetMemberFocus(props.sessionId)
      return null
    }
    const m = await mount(h(Probe, { sessionId: 'member-session' }))
    try {
      assert.equal(box.current, null, 'no focus recorded yet')
      await act(async () => { requestFleetMemberFocus('member-session', 'm1') })
      assert.equal(box.current, 'm1')
      await m.update(h(Probe, { sessionId: '' }))
      await act(async () => { requestFleetMemberFocus('member-session', 'm2') })
      assert.equal(box.current, 'm1', 'the detached probe hears nothing')
    } finally {
      await m.unmount()
    }
  })
})
})

describe('viewkit', () => {

describe('makeViewKit', () => {
  test('catLabel maps through the dictionary', () => {
    const kit = makeKit()
    assert.equal(kit.catLabel('system'), DICT_EN['cat.system'])
    assert.equal(kit.catLabel('tool'), DICT_EN['cat.tool'])
  })

  test('eventLabel delegates to makeEventText (compaction with a count)', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 1, time: 1000, kind: 'compaction', count: 3, turn: 2, step: 4 }
    assert.equal(kit.eventLabel(ev), DICT_EN['ev.compaction'].replace('{n}', '3'))
  })

  test('eventAt is null for an event without a turn/step anchor', () => {
    const kit = makeKit()
    const ev: ContextEventRecord = { seq: 2, time: 1000, kind: 'inject', form: 'notice' }
    assert.equal(kit.eventAt(ev), null)
  })

  test('useLocaleTick is inert without a locale service and re-renders on a locale change with one', async () => {
    const plain = makeKit()
    const Plain = (): ReturnType<typeof h> => {
      plain.useLocaleTick()
      return h('span', null, plain.t('files.title'))
    }
    const m = await mount(h(Plain))
    assert.ok(text(m.container).includes('File Activity'))
    await m.unmount()

    let active = 'en'
    const listeners = new Set<() => void>()
    const locale = {
      register: () => () => {},
      bind: () => makeTranslate('en') as never,
      getLocale: () => ({ active }),
      subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn) } },
    }
    const dicts: Record<'en' | 'zh', Record<string, string>> = { en: { 'files.title': 'File Activity' }, zh: { 'files.title': '文件活动' } }
    const liveT = (key: string, params?: Record<string, string | number>): string => {
      let s = dicts[active as 'en' | 'zh'][key] ?? key
      if (params) for (const k in params) s = s.replace('{' + k + '}', String(params[k]))
      return s
    }
    const kit = makeViewKit(liveT, locale as never)
    const Live = (): ReturnType<typeof h> => {
      kit.useLocaleTick()
      return h('span', null, kit.t('files.title'))
    }
    const m2 = await mount(h(Live))
    assert.ok(text(m2.container).includes('File Activity'))
    active = 'zh'
    await act(async () => { for (const fn of listeners) fn() })
    assert.ok(text(m2.container).includes('文件活动'))
    await m2.unmount()

    active = 'en'
    const bare = { subscribe: (_fn: () => void) => () => {} }
    const bareKit = makeViewKit(liveT, bare as never)
    const Bare = (): ReturnType<typeof h> => {
      bareKit.useLocaleTick()
      return h('span', null, bareKit.t('files.title'))
    }
    const m3 = await mount(h(Bare))
    assert.ok(text(m3.container).includes('File Activity'))
    await m3.unmount()
  })
})
})

describe('icon', () => {

describe('ContextIcon', () => {
  test('draws the colourful sheet at the requested edge', async () => {
    const m = await mount(h(ContextIcon, { size: 16, className: 'lc-title-icon' }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '16')
    assert.equal(svg.getAttribute('height'), '16')
    assert.equal(svg.getAttribute('viewBox'), '0 0 1024 1024')
    assert.equal(svg.getAttribute('class'), 'lc-title-icon')
    assert.equal(svg.getAttribute('aria-hidden'), 'true')
    const paths = queryAll<SVGPathElement>(m.container, 'path')
    assert.equal(paths.length, 10)
    const fills = paths.map(p => p.getAttribute('fill'))
    assert.ok(fills.every(f => typeof f === 'string' && f.startsWith('#')))
    assert.equal(new Set(fills).size, 6, 'the six palette colours all appear')
    await m.unmount()
  })

  test('defaults to a size and can drop the class', async () => {
    const m = await mount(h(ContextIcon, {}))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '20')
    assert.equal(svg.getAttribute('height'), '20')
    assert.equal(svg.getAttribute('class'), null)
    await m.unmount()
  })

  test('the panel-list glyph defaults to the mono seat at 18px', async () => {
    const m = await mount(h(InsightPanelIcon))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.getAttribute('width'), '18')
    assert.ok(svg.innerHTML.includes('currentColor'), 'the mono mask inks the sheet')
    await m.unmount()
  })

  test('the mono seat inks the sheet in the current colour at the harness line weight', async () => {
    const m = await mount(h(ContextIcon, { mono: true }))
    const svg = query<SVGSVGElement>(m.container, 'svg')
    assert.equal(svg.innerHTML.match(/fill="#[0-9A-Fa-f]{6}"/g), null, 'no palette fill survives')
    const rects = queryAll<SVGRectElement>(m.container, 'rect')
    assert.equal(
      rects.filter(r => r.getAttribute('fill') === 'currentColor').length,
      1,
      'one current-colour shape carries the whole glyph',
    )
    assert.equal(queryAll<SVGPathElement>(m.container, 'path').length, 10)
    const [hole, thin] = queryAll<SVGMaskElement>(m.container, 'mask')
    assert.match(hole.id, /-hole$/)
    assert.match(thin.id, /-thin$/)
    const shifts = queryAll<SVGRectElement>(thin, 'rect').filter(r => r.getAttribute('fill') === '#000')
    assert.deepEqual(shifts.map(r => r.getAttribute('transform')), [
      'translate(17 0)', 'translate(-17 0)', 'translate(0 17)', 'translate(0 -17)',
    ])
    assert.ok(shifts.every(r => r.getAttribute('mask') === `url(#${hole.id})`))
    await m.unmount()
  })

  test('emblem instances never share mask defs', async () => {
    const a = await mount(h(ContextIcon, { mono: true }))
    const b = await mount(h(ContextIcon, { mono: true }))
    const idsOf = (m: { container: HTMLElement }): string[] =>
      queryAll<SVGMaskElement>(m.container, 'mask').map(mask => mask.id)
    const ids = [...idsOf(a), ...idsOf(b)]
    assert.equal(new Set(ids).size, ids.length, 'a duplicate id would strand one emblem on the other defs')
    await a.unmount()
    await b.unmount()
  })

  test('the package-root icon.svg stays in lockstep with the component', async () => {
    const raw = await readFile('icon.svg', 'utf8')
    const svgPaths = [...raw.matchAll(/<path d="([^"]+)" fill="([^"]+)"\/>/g)].map(([, d, fill]) => ({ d, fill }))
    const m = await mount(h(ContextIcon, {}))
    const componentPaths = queryAll<SVGPathElement>(m.container, 'path').map(p => ({
      d: p.getAttribute('d'),
      fill: p.getAttribute('fill'),
    }))
    await m.unmount()
    assert.ok(svgPaths.length >= 10)
    assert.deepEqual(svgPaths, componentPaths)
    assert.match(raw, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 1024 1024">/)
  })
})

describe('makeContextTabTitle — the chip-title seat', () => {
  test('renders the emblem beside the plugin label in the active locale', async () => {
    const { t } = makeKit()
    const Title = makeContextTabTitle(t)
    const m = await mount(h(Title))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    const label = query<HTMLSpanElement>(m.container, '.lc-title-label')
    assert.equal(text(label), 'Context')
    await m.unmount()
  })

  test('follows the bound translate at render (zh label)', async () => {
    const Title = makeContextTabTitle(makeKit('zh').t)
    const m = await mount(h(Title))
    assert.equal(text(m.container), '上下文')
    await m.unmount()
  })
})
})
