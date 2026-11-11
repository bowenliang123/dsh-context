import { act, createElement as h } from 'react'
import { createRoot } from 'react-dom/client'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { type OverviewRequest, type OverviewScope } from '../../src/shared/types'
import { cleanupMounts, flush, mount, settle, type Mounted } from './helpers/kit'
import { BASE_COVERAGE, coverageOf, daysValue, pageValue, summaryRaw, summaryValue, tallyValue } from './helpers/overviewWire'
import { currentSessionOf, projectOf, UNGROUPED_KEY } from '../../src/client/overviewModel'
import { dayRangeWindow, orderedDayRange, rangeWindowOf } from '../../src/client/overviewQuery'

describe('overviewSource', () => {

const OVERVIEW_ROUTE = 'api/dsh-context/overview'

const BACKFILL_ROUTE = 'api/dsh-context/backfill'

const POLL_MS = 30_000

interface Modules {
  source: typeof import('../../src/client/overviewSource')
  invalidation: typeof import('../../src/client/invalidation')
}

async function fresh(): Promise<Modules> {
  vi.resetModules()
  const source = await import('../../src/client/overviewSource')
  const invalidation = await import('../../src/client/invalidation')
  return { source, invalidation }
}

interface Call {
  route: string
  body: Record<string, unknown>
  method: string | undefined
}

type Handler = (call: Call, index: number) => unknown

function stubRoutes(handler: Handler): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (input: unknown, init?: { body?: string; method?: string }) => {
    const call: Call = {
      route: String(input),
      body: init?.body === undefined ? {} : JSON.parse(String(init.body)) as Record<string, unknown>,
      method: init?.method,
    }
    calls.push(call)
    const value = await handler(call, calls.length - 1)
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  return calls
}

function stubFailing(failure: 'thrown' | 'http' | 'envelope' | 'malformed'): void {
  if (failure === 'thrown') {
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    return
  }
  if (failure === 'http') {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 500, json: async () => ({}) }))
    return
  }
  if (failure === 'envelope') {
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: false }) }))
    return
  }
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ ok: true, value: { revision: 'r1', pricingReady: true, nope: 1 } }),
  }))
}

function stubServed(payload: (scope: OverviewScope) => Record<string, unknown>): Call[] {
  const served = new Set<string>()
  return stubRoutes((call) => {
    const scope = call.body.scope as OverviewScope
    const key = JSON.stringify([call.body.part, scope])
    if (call.body.revision === 'r1' && served.has(key)) return { revision: 'r1', unchanged: true }
    served.add(key)
    return payload(scope)
  })
}

function stubDeferred(): { bodies: Record<string, unknown>[]; releases: ((value: unknown) => void)[] } {
  const bodies: Record<string, unknown>[] = []
  const releases: ((value: unknown) => void)[] = []
  vi.stubGlobal('fetch', async (_input: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(String(init.body)) as Record<string, unknown>)
    const value = await new Promise<unknown>((resolve) => { releases.push(resolve) })
    return { ok: true, json: async () => ({ ok: true, value }) }
  })
  return { bodies, releases }
}

interface SummaryProbe {
  states: import('../../src/client/overviewSource').OverviewSummaryState[]
  m: Mounted
  update: (next: OverviewScope | null, nextEnabled?: boolean) => Promise<void>
}

async function mountSummary(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<SummaryProbe> {
  const states: SummaryProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewSummary(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m, update: (next, nextEnabled = enabled) => m.update(h(Probe, { scope: next, enabled: nextEnabled })) }
}

interface DaysProbe {
  states: import('../../src/client/overviewSource').PartState<{ days: import('../../src/shared/types').OverviewDay[]; pricingReady: boolean }>[]
  m: Mounted
}

async function mountDays(mod: Modules, scope: OverviewScope | null, enabled = true): Promise<DaysProbe> {
  const states: DaysProbe['states'] = []
  function Probe(props: { scope: OverviewScope | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewDays(props.scope, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { scope, enabled }))
  return { states, m }
}

interface PageProbe {
  states: import('../../src/client/overviewSource').PartState<{ page: import('../../src/shared/types').OverviewPage; pricingReady: boolean }>[]
  m: Mounted
}

async function mountPage(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<PageProbe> {
  const states: PageProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewPage(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

interface TallyProbe {
  states: import('../../src/client/overviewSource').PartState<{ tally: import('../../src/shared/types').OverviewTally; pricingReady: boolean }>[]
  m: Mounted
}

async function mountTally(mod: Modules, request: Omit<OverviewRequest, 'revision'> | null, enabled = true): Promise<TallyProbe> {
  const states: TallyProbe['states'] = []
  function Probe(props: { request: Omit<OverviewRequest, 'revision'> | null; enabled: boolean }): null {
    states.push(mod.source.useOverviewTally(props.request, props.enabled))
    return null
  }
  const m = await mount(h(Probe, { request, enabled }))
  return { states, m }
}

function lastOf<T>(states: T[]): T {
  const found = states[states.length - 1]
  assert.ok(found !== undefined, 'the probe rendered')
  return found
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

afterEach(async () => {
  await cleanupMounts()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  vi.resetModules()
  vi.restoreAllMocks()
})

describe('useOverviewSummary', () => {
  test('the first load posts the scope with a null revision and paints the summary and coverage', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const scope: OverviewScope = { range: '7d', coverage: 'all' }
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountSummary(mod, scope)
    await advance(0)
    const state = lastOf(probe.states)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { part: 'summary', scope, revision: null }, method: 'POST' }])
    assert.equal(state.pending, false)
    assert.equal(state.stale, false)
    assert.equal(state.error, false)
    assert.equal(state.revision, 'r1')
    assert.equal(state.data?.pricingReady, true)
    assert.equal(state.data?.summary.tokens, 1800)
    assert.deepEqual(state.coverage, BASE_COVERAGE)
    await probe.m.unmount()
  })

  test('the held revision rides the next fetch; an unchanged reply keeps the painted data', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes((_call, index) => (index === 0 ? summaryValue() : { revision: 'r1', unchanged: true }))
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]?.body, { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    const state = lastOf(probe.states)
    assert.equal(state.data?.summary.sessions, 2, 'the unchanged reply leaves the painted summary in place')
    assert.equal(state.revision, 'r1', 'the held revision survives the unchanged reply')
    assert.equal(state.pending, false)
    assert.equal(state.stale, false)
    await probe.m.unmount()
  })

  test('invalidation coalesces into one refresh and only overview-carrying kinds trigger it', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(calls.length, 1)
    mod.invalidation.invalidate('fleet')
    mod.invalidation.invalidate('heads')
    await advance(250)
    assert.equal(calls.length, 1, 'unrelated invalidations never refetch')
    mod.invalidation.invalidate('sessions')
    mod.invalidation.invalidate('pricing')
    mod.invalidation.invalidate('overview')
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(calls.length, 2, 'repeated invalidations inside the coalesce window share one read')
    await advance(250)
    assert.equal(calls.length, 2, 'one invalidation refetches once')
    await probe.m.unmount()
  })

  test('polls while the document is visible and stays quiet while hidden', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    const calls = stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(calls.length, 1)
    await advance(POLL_MS)
    assert.equal(calls.length, 2, 'the visible poll refreshes')
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
    try {
      await advance(POLL_MS)
      assert.equal(calls.length, 2, 'a hidden document skips the poll tick')
    } finally {
      Reflect.deleteProperty(document, 'visibilityState')
    }
    await advance(POLL_MS)
    assert.equal(calls.length, 3, 'the poll resumes once visible again')
    await probe.m.unmount()
  })

  test('a remount with no painted data posts a cold revision instead of claiming the retained one', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubServed(() => summaryValue())
    const first = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(lastOf(first.states).data?.summary.sessions, 2)
    await first.m.unmount()
    const second = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(calls.length, 2)
    assert.deepEqual(calls[1]?.body, { part: 'summary', scope: { range: 'all' }, revision: null })
    assert.equal(lastOf(second.states).data?.summary.sessions, 2, 'the reopened panel paints instead of staying blank')
    await second.m.unmount()
  })

  test('a scope switch posts cold and never keeps another scope\'s numbers', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubServed(scope => summaryValue({
      revision: 'r1',
      summary: summaryRaw({ sessions: scope.range === 'today' ? 1 : 3 }),
    }))
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.deepEqual(calls[1]?.body, { part: 'summary', scope: { range: 'all' }, revision: null })
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.update({ range: 'today' })
    await advance(0)
    assert.equal(calls.length, 3)
    assert.deepEqual(calls[2]?.body, { part: 'summary', scope: { range: 'today' }, revision: null })
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1, 'the earlier scope repaints its own numbers')
    await probe.m.unmount()
  })

  test('a scope change drops the previous scope data while the new read is in flight', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const { releases } = stubDeferred()
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    await act(async () => { releases[0]?.(summaryValue({ summary: summaryRaw({ sessions: 1 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).data?.summary.sessions, 1)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(lastOf(probe.states).data, null, 'the previous scope data is not painted under the new scope')
    assert.equal(lastOf(probe.states).pending, true)
    await act(async () => { releases[1]?.(summaryValue({ summary: summaryRaw({ sessions: 3 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).data?.summary.sessions, 3)
    await probe.m.unmount()
  })

  test('a late reply from the previous scope never clears the new read\'s pending flag', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const { releases } = stubDeferred()
    const probe = await mountSummary(mod, { range: 'today' })
    await advance(0)
    await probe.update({ range: 'all' })
    await advance(0)
    assert.equal(releases.length, 2)
    await act(async () => { releases[0]?.(summaryValue({ summary: summaryRaw({ sessions: 1 }) })) })
    await flush()
    const state = lastOf(probe.states)
    assert.equal(state.data, null, 'the previous scope payload is dropped')
    assert.equal(state.pending, true, 'the new scope read is still in flight')
    await act(async () => { releases[1]?.(summaryValue({ summary: summaryRaw({ sessions: 3 }) })) })
    await flush()
    assert.equal(lastOf(probe.states).pending, false)
    await probe.m.unmount()
  })

  test('disabled or scope-less hooks never fetch and clear their pending flag', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const disabled = await mountSummary(mod, { range: 'all' }, false)
    await advance(0)
    assert.equal(lastOf(disabled.states).pending, false)
    assert.equal(lastOf(disabled.states).data, null)
    const scopeless = await mountSummary(mod, null)
    await advance(0)
    assert.equal(calls.length, 0, 'neither a disabled hook nor a null scope posts')
    await disabled.m.unmount()
    await scopeless.m.unmount()
  })

  test('an error keeps the painted data and raises the stale flag until the next success', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    stubRoutes(() => summaryValue())
    await advance(0)
    assert.equal(lastOf(probe.states).data?.summary.sessions, 2)
    vi.stubGlobal('fetch', async () => { throw new Error('offline') })
    mod.invalidation.invalidate('overview')
    await advance(250)
    let state = lastOf(probe.states)
    assert.equal(state.error, true)
    assert.equal(state.stale, true)
    assert.equal(state.pending, false)
    assert.equal(state.data?.summary.sessions, 2, 'the last good summary survives a failed refresh')
    stubRoutes(() => summaryValue({ revision: 'r3' }))
    mod.invalidation.invalidate('overview')
    await advance(250)
    state = lastOf(probe.states)
    assert.equal(state.error, false)
    assert.equal(state.stale, false)
    assert.equal(state.revision, 'r3')
    await probe.m.unmount()
  })

  test('an HTTP failure, a failed envelope, a malformed part, and a value-less reply all read as errors', async () => {
    for (const failure of ['http', 'envelope', 'malformed'] as const) {
      vi.useFakeTimers()
      const mod = await fresh()
      const probe = await mountSummary(mod, { range: 'all' })
      stubFailing(failure)
      await advance(0)
      const state = lastOf(probe.states)
      assert.equal(state.error, true, `${failure} reads as an error`)
      assert.equal(state.stale, true)
      assert.equal(state.data, null)
      await probe.m.unmount()
      vi.useRealTimers()
    }
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => ({ ok: true, value: null }) }))
    await advance(0)
    assert.equal(lastOf(probe.states).error, true, 'a null value reads as a failed read')
    await probe.m.unmount()
  })

  test('a reply for another part leaves the summary unpainted', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const probe = await mountSummary(mod, { range: 'all' })
    stubRoutes(() => daysValue())
    await advance(0)
    const state = lastOf(probe.states)
    assert.equal(state.data, null)
    assert.equal(state.error, false, 'a well-formed reply of the wrong part is not an error')
    await probe.m.unmount()
  })

  test('an invalidation during an in-flight read queues one follow-up read instead of racing', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const { bodies, releases } = stubDeferred()
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(bodies.length, 1)
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(bodies.length, 1, 'the queued refresh waits for the in-flight read')
    assert.equal(lastOf(probe.states).pending, true)
    await act(async () => { releases[0]?.(summaryValue({ revision: 'r1' })) })
    await flush()
    assert.equal(bodies.length, 2, 'the queued read fires right after the first settles')
    assert.deepEqual(bodies[1], { part: 'summary', scope: { range: 'all' }, revision: 'r1' })
    await act(async () => { releases[1]?.(summaryValue({ revision: 'r2' })) })
    await flush()
    assert.equal(lastOf(probe.states).revision, 'r2')
    await probe.m.unmount()
  })

  test('an unmount drops the late reply and clears the armed refresh', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let release: ((value: unknown) => void) | null = null
    const calls = stubRoutes(() => new Promise<unknown>((resolve) => { release = resolve }))
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(calls.length, 1)
    mod.invalidation.invalidate('overview')
    await probe.m.unmount()
    await advance(250)
    assert.equal(calls.length, 1, 'the pending coalesced refresh is cleared with the hook')
    await act(async () => { release?.(summaryValue()) })
    await flush()
    assert.equal(lastOf(probe.states).data, null, 'the late reply never paints')
  })

  test('a rejection that lands after unmount never touches state', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let rejectLate: ((err: Error) => void) | null = null
    vi.stubGlobal('fetch', () => new Promise<never>((_resolve, reject) => { rejectLate = reject }))
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await probe.m.unmount()
    await act(async () => {
      rejectLate?.(new Error('late'))
      await Promise.resolve()
    })
    await flush()
    assert.equal(lastOf(probe.states).error, false, 'the late rejection is dropped with the unmounted hook')
    assert.equal(lastOf(probe.states).stale, false)
  })

  test('an unmount during dispatch makes the removed listener inert', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const states: ReturnType<typeof mod.source.useOverviewSummary>[] = []
    function Probe(): null {
      states.push(mod.source.useOverviewSummary({ range: 'all' }, true))
      return null
    }
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    stubRoutes(() => summaryValue())
    mod.invalidation.subscribeInvalidations(() => { root.unmount() })
    await act(async () => { root.render(h(Probe, {})) })
    await advance(0)
    assert.equal(states[states.length - 1]?.data?.summary.sessions, 2)
    const calls = stubRoutes(() => summaryValue({ revision: 'r2' }))
    await act(async () => { mod.invalidation.invalidate('overview') })
    container.remove()
    await advance(250)
    assert.equal(calls.length, 0, 'the listener removed mid-dispatch never refetches')
  })
})

describe('useOverviewDays', () => {
  test('posts the days part and paints the day totals', async () => {
    const mod = await fresh()
    const scope: OverviewScope = { coverage: 'active' }
    const calls = stubRoutes(() => daysValue())
    const probe = await mountDays(mod, scope)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { part: 'days', scope, revision: null }, method: 'POST' }])
    const state = lastOf(probe.states)
    assert.deepEqual(state.data, {
      days: [{ key: '2026-09-16', tokens: 10, sessions: 1, costUsd: 0.1 }],
      pricingReady: true,
    })
    assert.equal(state.pending, false)
    await probe.m.unmount()
  })

  test('a reply for another part leaves the days unpainted; a disabled hook never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => tallyValue())
    const probe = await mountDays(mod, { coverage: 'all' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const disabled = await mountDays(mod, { coverage: 'all' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled days hook posts nothing')
    assert.equal(lastOf(disabled.states).pending, false)
    await probe.m.unmount()
    await disabled.m.unmount()
  })
})

describe('useOverviewPage', () => {
  test('posts the page request with sort, page, and revision; paints the page', async () => {
    const mod = await fresh()
    const request: Omit<OverviewRequest, 'revision'> = { part: 'page', scope: { range: '7d' }, sort: 'tokens', page: 2 }
    const calls = stubRoutes(() => pageValue())
    const probe = await mountPage(mod, request)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { ...request, revision: null }, method: 'POST' }])
    const state = lastOf(probe.states)
    assert.equal(state.data?.page.total, 1)
    assert.equal(state.data?.pricingReady, false)
    await probe.m.unmount()
  })

  test('a request for another part leaves the page unpainted; a null request never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountPage(mod, { part: 'page' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const empty = await mountPage(mod, null)
    await settle(5)
    assert.equal(calls.length, 1, 'a null request posts nothing')
    const disabled = await mountPage(mod, { part: 'page' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled page hook posts nothing')
    await probe.m.unmount()
    await empty.m.unmount()
    await disabled.m.unmount()
  })
})

describe('useOverviewTally', () => {
  test('posts the tally request with its field and pick; paints the tally', async () => {
    const mod = await fresh()
    const request: Omit<OverviewRequest, 'revision'> = {
      part: 'tally',
      scope: { query: 'x', group: 'w' },
      tally: 'tools',
      pick: { field: 'tools', name: 'read' },
    }
    const calls = stubRoutes(() => tallyValue())
    const probe = await mountTally(mod, request)
    await settle(5)
    assert.deepEqual(calls, [{ route: OVERVIEW_ROUTE, body: { ...request, revision: null }, method: 'POST' }])
    assert.deepEqual(lastOf(probe.states).data, {
      tally: { field: 'tools', stats: [{ name: 'read', n: 2, sessions: 1, last: 5 }] },
      pricingReady: true,
    })
    await probe.m.unmount()
  })

  test('a reply for another part leaves the tally unpainted; a disabled hook never posts', async () => {
    const mod = await fresh()
    const calls = stubRoutes(() => summaryValue())
    const probe = await mountTally(mod, { part: 'tally' })
    await settle(5)
    assert.equal(lastOf(probe.states).data, null)
    assert.equal(calls.length, 1)
    const disabled = await mountTally(mod, { part: 'tally' }, false)
    await settle(5)
    assert.equal(calls.length, 1, 'a disabled tally hook posts nothing')
    await probe.m.unmount()
    await disabled.m.unmount()
  })
})

describe('summary coverage auto-backfill', () => {
  test('an incomplete coverage posts the backfill route after the bounded retry delay', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const backfills: Call[] = []
    const calls = stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills.push(call)
        return undefined
      }
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 2, covered: 1 }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    assert.equal(backfills.length, 0, 'the first paint arms no backfill before the read lands')
    await advance(2_000)
    assert.deepEqual(backfills.map(c => [c.route, c.method]), [[BACKFILL_ROUTE, 'POST']])
    assert.equal(calls.filter(c => c.route === OVERVIEW_ROUTE).length, 1)
    await probe.m.unmount()
  })

  test('a failing backfill POST is swallowed and a complete coverage stops the loop', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let coverage = coverageOf({ complete: false, remaining: 1, covered: 1 })
    let backfillAttempts = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfillAttempts++
        throw new Error('route absent')
      }
      return summaryValue({ summary: summaryRaw({ coverage }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await advance(2_000)
    assert.equal(backfillAttempts, 1, 'the rejected POST is swallowed')
    await flush()
    coverage = coverageOf()
    mod.invalidation.invalidate('overview')
    await advance(250)
    await advance(60_000)
    assert.equal(backfillAttempts, 1, 'a complete coverage never posts the backfill route again')
    assert.equal(vi.getTimerCount(), 1, 'only the poll interval stays armed')
    await probe.m.unmount()
    assert.equal(vi.getTimerCount(), 0)
  })

  test('each coverage change arms the next backfill attempt, capped after ten', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    const overviewCalls: Call[] = []
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) return undefined
      const callIndex = overviewCalls.length
      overviewCalls.push(call)
      return summaryValue({
        summary: summaryRaw({
          coverage: coverageOf({ complete: false, remaining: 20 - callIndex, covered: callIndex }),
        }),
      })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 9; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
    }
    assert.equal(overviewCalls.length, 10, 'ten summary reads armed ten attempts')
    mod.invalidation.invalidate('overview')
    await advance(250)
    assert.equal(overviewCalls.length, 11)
    await advance(60_000)
    await probe.m.unmount()
  })

  test('non-progress coverage churn still caps the backfill budget', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let calls = 0
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      calls++
      const running = calls % 2 === 0
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 5, covered: 2, running }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 40; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.ok(backfills > 0 && backfills <= 10, 'the attempt budget bounds the loader')
    const settled = backfills
    for (let i = 0; i < 10; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.equal(backfills, settled, 'a stagnant corpus stops at the attempt budget')
    await probe.m.unmount()
  })

  test('coverage progress refills the attempt budget so a slow corpus can finish', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let calls = 0
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      calls++
      return summaryValue({ summary: summaryRaw({ coverage: coverageOf({ complete: false, remaining: 30 - calls, covered: calls }) }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    for (let i = 0; i < 15; i++) {
      mod.invalidation.invalidate('overview')
      await advance(250)
      await advance(20_000)
    }
    assert.ok(backfills >= 14, `progress keeps the loader going (${backfills} backfills)`)
    await probe.m.unmount()
  })

  test('a complete coverage resets the attempt counter so a later incomplete run starts over', async () => {
    vi.useFakeTimers()
    const mod = await fresh()
    let coverage = coverageOf({ complete: false, remaining: 1, covered: 1 })
    let backfills = 0
    stubRoutes((call) => {
      if (call.route === BACKFILL_ROUTE) {
        backfills++
        return undefined
      }
      return summaryValue({ summary: summaryRaw({ coverage }) })
    })
    const probe = await mountSummary(mod, { range: 'all' })
    await advance(0)
    await advance(2_000)
    assert.equal(backfills, 1)
    coverage = coverageOf()
    mod.invalidation.invalidate('overview')
    await advance(250)
    coverage = coverageOf({ complete: false, remaining: 3, covered: 0 })
    mod.invalidation.invalidate('overview')
    await advance(250)
    await advance(2_000)
    assert.equal(backfills, 2, 'the reopened coverage posts again with a fresh attempt counter')
    await probe.m.unmount()
  })
})
})

describe('overviewSupport', () => {

const NOW = Date.UTC(2026, 10, 8, 12, 0, 0)

const CURRENT_SESSION_KEY = 'dsh.sessions.current'

function pin(id: string | null): void {
  if (id === null) localStorage.removeItem(CURRENT_SESSION_KEY)
  else localStorage.setItem(CURRENT_SESSION_KEY, JSON.stringify({ sessionId: id }))
}

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('overview current-session seat', () => {
  test('the persisted ui-workspace selection anchors the id and the sessions seat supplies its cwd', () => {
    const selectOf = (snapshot: unknown) => ({ useSessions: (select: (value: unknown) => unknown) => select(snapshot) })
    pin('a')
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: { cwd: '/repo/a' } } })), { id: 'a', cwd: '/repo/a' })
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: {} } })), { id: 'a' })
    assert.deepEqual(currentSessionOf(selectOf({ byId: {} })), { id: 'a' })
    pin('b')
    assert.deepEqual(currentSessionOf(selectOf({ byId: { a: { cwd: '/repo/a' } } })), { id: 'b' })
    assert.deepEqual(currentSessionOf(selectOf(null)), { id: 'b' })
    assert.deepEqual(currentSessionOf({}), { id: 'b' })
    assert.deepEqual(currentSessionOf({ useSessions: 7 }), { id: 'b' })
    assert.deepEqual(currentSessionOf({ useSessions: () => { throw new Error('seat down') } }), { id: 'b' })
  })

  test('a missing, malformed or inaccessible selection degrades to no current session', () => {
    pin(null)
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, 'not json')
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, '{"sessionId":7}')
    assert.equal(currentSessionOf({}), null)
    localStorage.setItem(CURRENT_SESSION_KEY, '{"sessionId":""}')
    assert.equal(currentSessionOf({}), null)
    vi.stubGlobal('localStorage', undefined)
    assert.equal(currentSessionOf({}), null)
  })

  test('equivalent snapshots produce the same selector key, so unrelated session updates cannot repaint', () => {
    pin('a')
    const keyOf = (snapshot: unknown): unknown => {
      let key: unknown
      const read = (select: (value: unknown) => unknown): unknown => { key = select(snapshot); return key }
      currentSessionOf({ useSessions: read })
      return key
    }
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' } }, ids: ['a'] }), 'a\u0000/repo/a')
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' } }, ids: ['a', 'b'] }), 'a\u0000/repo/a')
    pin('b')
    assert.equal(keyOf({ byId: { a: { cwd: '/repo/a' }, b: { cwd: '/repo/b' } }, ids: ['a', 'b'] }), 'b\u0000/repo/b')
  })

  test('projectOf folds a workspace path to its title and treats the bare root as unnamed', () => {
    assert.equal(projectOf(undefined), undefined)
    assert.equal(projectOf(''), undefined)
    assert.equal(projectOf('/'), undefined)
    assert.equal(projectOf('/Users/bw/dev/dsh-context'), 'dsh-context')
    assert.equal(UNGROUPED_KEY, '__ungrouped__')
  })
})

describe('overview range windows', () => {
  test('range windows start at midnight, the period floor or never', () => {
    assert.deepEqual(rangeWindowOf('all', NOW), { start: null, end: null })
    assert.deepEqual(rangeWindowOf('today', NOW), { start: new Date(NOW).setHours(0, 0, 0, 0), end: null })
    assert.deepEqual(rangeWindowOf('7d', NOW), { start: NOW - 7 * 86_400_000, end: null })
    assert.deepEqual(rangeWindowOf('30d', NOW), { start: NOW - 30 * 86_400_000, end: null })
  })

  test('day ranges order both ends and reject unreadable keys', () => {
    assert.deepEqual(orderedDayRange('2026-09-16', '2026-09-10'), { from: '2026-09-10', to: '2026-09-16' })
    assert.deepEqual(orderedDayRange('2026-09-10', '2026-09-16'), { from: '2026-09-10', to: '2026-09-16' })
    assert.equal(dayRangeWindow({ from: 'junk', to: '2026-09-16' }), null)
    const window = dayRangeWindow({ from: '2026-09-10', to: '2026-09-16' })
    assert.ok(window !== null)
    assert.ok((window.start ?? 0) < (window.end ?? 0))
  })
})
})
