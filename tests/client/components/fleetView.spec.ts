import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { requestFleetMemberFocus, currentFleetMemberFocus } from '../../../src/client/viewFocus'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { click, makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { makeScroller, mountInScroller, projectionsFor, richTimeline } from './contextViewHarness'

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

function selfOnly(id: string) {
  const snapshot = { byId: { [id]: { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

function emptyFleetRoute(): void {
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, value: { messages: [], truncated: false } }),
  } as Response))
}

function makeView(ctx: TestClientCtx) {
  return makeFleetView(asClientCtx(ctx), kit, makeAgentHeads())
}

describe('FleetView Mission Pulse states', () => {
  test('a solo session keeps its tree, an empty timeline, and an empty work queue without the retired boards', async () => {
    emptyFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline()) }))

    assert.ok(text(query(m.container, '.lc-pulse-header')).includes(DICT_EN['fleet.pulse.title']))
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '1')
    assert.equal(query(m.container, '[data-pulse-stat="tasks"]').textContent, '0')
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label').length, 1)
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    await until(() => text(query(m.container, '.lc-pulse-events')).includes(DICT_EN['fleet.comms.empty']), 'the empty stream never settled')
    assert.ok(query(m.container, '.lc-pulse-main-graph .lc-agents.lc-agents-compact') !== null)
    assert.equal(queryAll(m.container, '.lc-col-graph .lc-agent-card').length, 1)
    assert.equal(queryAll(m.container, '.lc-members, .lc-summary, .lc-comms-channels').length, 0)
    assert.equal(queryAll(m.container, '.lc-foot').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a cold session names its retryable read instead of spinning', async () => {
    let reads = 0
    let release!: () => void
    vi.stubGlobal('fetch', () => {
      reads += 1
      if (reads === 1) return new Promise(res => { release = () => { res({ ok: false, status: 503 } as Response) } })
      return Promise.resolve({ ok: false, status: 503 } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-cold') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-cold', useProjection: () => undefined }))

    assert.equal(query(m.container, '.lc-empty').textContent, DICT_EN['loading'])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    const before = reads
    await click(query(m.container, '.lc-br-retry'))
    await until(() => reads > before, 'the retry never refired the read')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await m.unmount()
    ctx.dispose()
  })

  test('the baseline gate rides the Fleet tab too', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-gate') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-gate', useProjection: projectionsFor(richTimeline({ unsupported: { current: '0.1.0', minimum: '0.2.0-rc.2' } })) }))

    assert.ok(query(m.container, '.lc-gate-card') !== null)
    await m.unmount()
    ctx.dispose()
  })

  test('without a session id the empty mission still paints', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-none') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { useProjection: projectionsFor(richTimeline()) }))

    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '0')
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label').length, 0)
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    assert.equal(queryAll(m.container, '.lc-agents, .lc-foot').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a relayed member pick selects the same lane used by tasks and events', async () => {
    emptyFleetRoute()
    const id = 'sv-fleet-pick'
    const snapshot = {
      byId: {
        [id]: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { contextTimeline: richTimeline() } },
        worker: { parentId: id, origin: 'subagent', running: true, updatedAt: 8, projectionValues: { contextTimeline: richTimeline(), subagent: { mode: 'continuable', label: 'worker-bee' } } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: id, useProjection: projectionsFor(richTimeline()) }))
    await act(async () => { requestFleetMemberFocus(id, 'worker') })
    await until(() => query(m.container, '.lc-pulse-lane-agent[data-agent="worker"]').getAttribute('aria-pressed') === 'true', 'the relay never selected the lane')
    assert.equal(query(m.container, '.lc-agent-card[data-agent="worker"]').getAttribute('aria-pressed'), 'true')
    assert.ok(query(m.container, '[data-task="worker"]').className.includes('lc-pulse-work-related'))
    assert.equal(currentFleetMemberFocus(id), 'worker')
    await m.unmount()
    ctx.dispose()
  })
})

describe('FleetView shared scrollport', () => {
  test('mount and session switches claim the top of the scrollport', async () => {
    const props = { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline()) }
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const scroller = makeScroller()
    scroller.scrollTop = 3491
    const m = await mountInScroller(h(View, props), scroller)
    assert.equal(scroller.scrollTop, 0)
    scroller.scrollTop = 120
    await m.unmount()

    const next = makeScroller()
    next.scrollTop = 55
    const remounted = await mountInScroller(h(View, props), next)
    assert.equal(next.scrollTop, 0)
    await remounted.unmount()

    const switched = makeScroller()
    const switchView = await mountInScroller(h(View, props), switched)
    switched.scrollTop = 300
    await switchView.update(h(View, { sessionId: 'sv-other', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(switched.scrollTop, 0)
    await switchView.unmount()
    ctx.dispose()
  })
})
