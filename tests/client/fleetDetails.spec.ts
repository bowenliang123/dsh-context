import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import {
  agentPromptOf,
  agentReplyOf,
  mergedDetailOf,
  useFleetDetails,
  type FleetDetailState,
  type FleetFact,
} from '../../src/client/fleetModel'
import { FleetDetailCache } from '../../src/client/fleetDetail'
import type { FleetBatch } from '../../src/client/fleetDetail'
import { invalidate, resetInvalidations } from '../../src/client/invalidation'
import type { FleetDetail, FleetSummary } from '../../src/shared/types'
import { flush, mount, until } from './helpers/kit'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetInvalidations()
})

function rootSummary(over: Partial<FleetSummary> = {}): FleetSummary {
  return {
    rootId: 'root',
    detail: { messages: [], truncated: false },
    members: [],
    familySize: 1,
    counts: {},
    ...over,
  }
}

function batchOf(rows: Record<string, FleetDetail>, missing: readonly string[] = []): {
  rows: ReadonlyMap<string, FleetDetail>
  missing: readonly string[]
  total: number
} {
  return { rows: new Map(Object.entries(rows)), missing, total: Object.keys(rows).length + missing.length }
}

function detailWith(over: Partial<FleetDetail> = {}): FleetDetail {
  return { messages: [], truncated: false, ...over }
}

function probeDetails(cache: FleetDetailCache, options: { scopeKey?: string } = {}): {
  box: { current: FleetDetailState | null }
  Probe: () => null
} {
  const box: { current: FleetDetailState | null } = { current: null }
  function Probe(): null {
    box.current = useFleetDetails(cache, options)
    return null
  }
  return { box, Probe }
}

function familyRequest(entries: readonly { id: string; updatedAt: number }[], over: Partial<Parameters<FleetDetailState['requestFamily']>[0]> = {}): Parameters<FleetDetailState['requestFamily']>[0] {
  return { rootId: 'root', rootStamp: 1, entries, ...over }
}

async function advance(ms: number): Promise<void> {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms) })
}

async function eventually(fn: () => boolean, message: string): Promise<void> {
  for (let i = 0; i < 800; i++) {
    if (fn()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
  }
  if (fn()) return
  throw new Error(message)
}

function entriesOf(count: number, stampOf: (index: number) => number = index => 100 - index): { id: string; updatedAt: number }[] {
  return Array.from({ length: count }, (_, index) => ({ id: `n${index}`, updatedAt: stampOf(index) }))
}

function familyOf(count: number): { id: string; updatedAt: number }[] {
  return [{ id: 'root', updatedAt: 1 }, ...entriesOf(count)]
}

describe('useFleetDetails — progressive family loading', () => {
  test('loads the summary root, then batches in updatedAt order, automatically continuing with exact totals', async () => {
    const cache = new FleetDetailCache()
    const summary = rootSummary()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(summary)
    const calls: { ids: readonly string[]; mode: string; rootId?: string }[] = []
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode, rootId) => {
      calls.push({ ids: [...ids], mode, ...(rootId === undefined ? {} : { rootId }) })
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        rows[id] = detailWith({
          messages: [{ seq: 1, time: 1, kind: 'relay', text: 'm-' + id }],
          delegations: [{ seq: 2, time: 2, to: 'kid-' + id, mode: 'continuable', label: 'duty' }],
        })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(20))) })
    await until(() => box.current?.family.loaded === 21, 'the family never finished loading')
    assert.equal(box.current?.landed.has('root'), true)
    assert.equal(box.current?.summary?.rootId, 'root')
    assert.equal(box.current?.family.pending, 0)
    assert.equal(box.current?.family.failed, 0)
    assert.equal(box.current?.family.messages, 20)
    assert.equal(box.current?.family.delegations, 20)
    assert.deepEqual(calls.map(call => call.ids.length), [16, 4])
    assert.deepEqual(calls[0]?.ids.slice(0, 3), ['n0', 'n1', 'n2'], 'updatedAt order picks the newest first')
    assert.ok(calls.every(call => call.mode === 'preview' && call.rootId === 'root'))
    await m.unmount()
  })

  test('priority members jump the queue and payload release keeps the compact facts and totals', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const calls: string[][] = []
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      calls.push([...ids])
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        rows[id] = detailWith({
          messages: [{ seq: 1, time: 1, kind: 'relay', text: 'x'.repeat(500_000) }],
          initialPrompt: 'prompt-' + id,
          delegations: [{ seq: 2, time: 2, to: 'kid-' + id, mode: 'continuable' }],
        })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => {
      ;(box.current as FleetDetailState).requestFamily(familyRequest(familyOf(20), { priority: new Set(['n19']) }))
    })
    await until(() => calls.length > 0, 'no batch ever fired')
    assert.equal(calls[0]?.[0], 'n19', 'the priority member leads the first batch')
    await until(() => box.current?.family.loaded === 21, 'the family never finished loading')
    assert.ok((box.current?.landed.size ?? 0) < 20, 'the byte budget released the off-screen payloads')
    assert.equal(box.current?.facts.size, 21, 'the compact facts survive the payload release')
    assert.equal(box.current?.family.messages, 20)
    const prompt = agentPromptOf(box.current as FleetDetailState, 'n19')
    assert.ok(prompt === 'prompt-n19' || prompt === undefined)
    await act(async () => { (box.current as FleetDetailState).prioritize('n5') })
    await m.unmount()
  })

  test('a click flood keeps the priority set bounded and stale stamp keys pruned', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockResolvedValue(batchOf({}))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => {
      for (let index = 0; index < 90; index++) (box.current as FleetDetailState).prioritize(`p${index}`)
    })
    act(() => {
      ;(box.current as FleetDetailState).requestFamily(familyRequest(familyOf(3)))
    })
    await flush()
    assert.ok((box.current as FleetDetailState) !== null)
    await m.unmount()
  })

  test('missing members retry with backoff until they land', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const attempts = new Map<string, number>()
    const batches: string[][] = []
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      batches.push([...ids])
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        if (mode === 'preview') {
          const count = (attempts.get(id) ?? 0) + 1
          attempts.set(id, count)
          if (id === 'n1' && count < 3) continue
        }
        rows[id] = detailWith({ messagesTotal: 1 })
      }
      return Promise.resolve(batchOf(rows, [...ids].filter(id => rows[id] === undefined)))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(3))) })
    await advance(2000)
    assert.equal(box.current?.family.loaded, 4, 'the retried member never landed')
    assert.equal(attempts.get('n1'), 3)
    assert.ok(batches.length >= 3)
    await m.unmount()
  })

  test('a member that exhausts its retries surfaces as failed and retryFamily clears the failure', async () => {
    const failing = new FleetDetailCache()
    vi.spyOn(failing, 'fetchSummary').mockResolvedValue(rootSummary())
    const failedAttempts = vi.fn(() => Promise.resolve(batchOf({}, ['n0'])))
    vi.spyOn(failing, 'fetchBatch').mockImplementation(failedAttempts)
    const failBox = probeDetails(failing)
    const failingMount = await mount(h(failBox.Probe))
    vi.useFakeTimers()
    act(() => { (failBox.box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(2000)
    assert.equal(failBox.box.current?.family.failed, 1, 'the member never exhausted its retries')
    assert.equal(failedAttempts.mock.calls.length, 3)
    assert.equal(failBox.box.current?.family.messages, null, 'an incomplete family never paints an exact total')
    act(() => { (failBox.box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(0)
    assert.equal(failBox.box.current?.family.failed, 1, 'a repeated family request keeps the failure')
    act(() => { (failBox.box.current as FleetDetailState).retryFamily() })
    await advance(2000)
    assert.equal(failedAttempts.mock.calls.length, 6, 'the manual retry never re-read the family')
    await failingMount.unmount()
  })

  test('auto-loads complete history and a stale history can never shadow a newer preview', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    let previewStamp = 1
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        rows[id] = mode === 'history'
          ? detailWith({ messages: Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, time: i + 1, kind: 'relay' as const, text: 'old-' + String(i) })) })
          : detailWith({ messages: [{ seq: 1, time: 1, kind: 'relay', text: 'preview-' + String(previewStamp) }], messagesTotal: 5 })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.historyLanded.get('n0') !== undefined, 'the complete history never landed')
    assert.equal(mergedDetailOf(box.current as FleetDetailState, 'n0')?.messages.length, 5)
    assert.equal(box.current?.family.messages, 5)

    previewStamp = 2
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }, { id: 'n0', updatedAt: 101 }])) })
    await eventually(() => box.current?.landed.get('n0')?.updatedAt === 101, 'the refreshed preview never landed')
    assert.equal(box.current?.landed.get('n0')?.detail?.messages[0]?.text, 'preview-2', 'the refreshed preview landed at its newer stamp')
    await eventually(() => box.current?.historyLanded.get('n0')?.updatedAt === 101, 'the refreshed history never landed')
    assert.equal(mergedDetailOf(box.current as FleetDetailState, 'n0')?.messages.length, 5)
    await m.unmount()
  })

  test('summary counts seed exact totals before any member detail lands', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary({
      detail: detailWith({ messagesTotal: 2 }),
      counts: {
        root: { readAt: 10, messagesTotal: 2, delegationsCount: 1 },
        n0: { readAt: 10, messagesTotal: 7, delegationsCount: 2 },
        other: { readAt: 10, messagesTotal: 9, delegationsCount: 0 },
        unknown: { readAt: 10, messagesTotal: 4, delegationsCount: 0 },
      },
    }))
    const never = vi.fn(() => new Promise<never>(() => {}))
    vi.spyOn(cache, 'fetchBatch').mockImplementation(never)
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => {
      ;(box.current as FleetDetailState).requestFamily(familyRequest([
        { id: 'n0', updatedAt: 5 },
        { id: 'other', updatedAt: 5 },
      ]))
    })
    await until(() => box.current?.summary !== null, 'the summary never landed')
    assert.equal(box.current?.family.messages, 7 + 9)
    assert.equal(box.current?.family.delegations, 2)
    assert.equal(box.current?.family.loaded, 0)
    assert.equal(box.current?.family.pending, 2)
    act(() => {
      ;(box.current as FleetDetailState).requestFamily(familyRequest([
        { id: 'n0', updatedAt: 5 },
        { id: 'other', updatedAt: 5 },
        { id: 'never', updatedAt: 5 },
      ]))
    })
    await flush()
    assert.equal(box.current?.family.messages, null, 'an unobserved member keeps the total unknown')
    await m.unmount()
  })

  test('the legacy single-session protocol serves the family when the host lacks the batch kinds', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(null)
    vi.spyOn(cache, 'fetch').mockImplementation((id: string) => Promise.resolve(detailWith({
      messages: [{ seq: 1, time: 1, kind: 'relay', text: 'single-' + id }],
      messagesTotal: 2,
      delegations: [{ seq: 2, time: 2, to: 'kid-' + id, mode: 'continuable' }],
    })))
    vi.spyOn(cache, 'fetchHistory').mockResolvedValue(detailWith({
      messages: Array.from({ length: 2 }, (_, i) => ({ seq: i + 1, time: i + 1, kind: 'relay' as const, text: 'history' })),
    }))
    const batch = vi.spyOn(cache, 'fetchBatch')
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => box.current?.family.loaded === 3, 'the legacy path never completed the family')
    assert.equal(batch.mock.calls.length, 0, 'the legacy path never retries the unsupported batch kind')
    assert.equal(box.current?.family.messages, 2 + 2 + 2)
    await until(() => box.current?.historyLanded.size === 3, 'the legacy history reads never landed')
    await m.unmount()
  })

  test('a rejected batch read falls back to single reads without losing the family', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    let rejected = 0
    vi.spyOn(cache, 'fetchBatch').mockImplementation(() => {
      rejected += 1
      return Promise.reject(new Error('HTTP 404'))
    })
    vi.spyOn(cache, 'fetch').mockImplementation((id: string) => Promise.resolve(detailWith({ messagesTotal: 1, initialPrompt: id })))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => box.current?.family.loaded === 3, 'the fallback singles never completed the family')
    assert.equal(rejected, 1, 'one failed batch read downgrades the scope to the legacy protocol')
    assert.equal(box.current?.family.messages, 2)
    await m.unmount()
  })

  test('a scope switch aborts in-flight work and clears every ledger', async () => {
    const cache = new FleetDetailCache()
    const signals: AbortSignal[] = []
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((_ids, _mode, _root, signal) => {
      if (signal !== undefined) signals.push(signal)
      return new Promise(() => {})
    })
    const options: { scopeKey?: string } = { scopeKey: 'one' }
    const { box, Probe } = probeDetails(cache, options)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => signals.length === 1, 'the batch never started')
    options.scopeKey = 'two'
    await m.update(h(Probe))
    assert.equal(signals[0]?.aborted, true, 'the in-flight batch was aborted')
    assert.equal(box.current?.landed.size, 0)
    assert.equal(box.current?.facts.size, 0)
    assert.equal(box.current?.family.total, 0)
    await m.unmount()
  })

  test('a fleet invalidation refreshes the family without a user action', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const batch = vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 1 })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => box.current?.family.loaded === 3, 'the family never loaded')
    const before = batch.mock.calls.length
    await act(async () => { invalidate('overview') })
    await act(async () => { invalidate('fleet', { sessionId: 'other' }) })
    assert.equal(batch.mock.calls.length, before, 'an unrelated fleet invalidation is ignored')
    await act(async () => { invalidate('fleet', { sessionId: 'root' }) })
    await until(() => batch.mock.calls.length > before, 'the fleet invalidation never refreshed the members')
    await m.unmount()
  })

  test('requestFull reads once per stamp, retries a null result on re-open, and never blanks the excerpt', async () => {
    const cache = new FleetDetailCache()
    let fullReads = 0
    let serve: FleetDetail | null = null
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 1, initialPrompt: 'preview' })
      return Promise.resolve(batchOf(rows))
    })
    vi.spyOn(cache, 'fetch').mockImplementation(() => {
      fullReads += 1
      return Promise.resolve(serve)
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.landed.has('n0') === true, 'the preview never landed')
    assert.equal(agentPromptOf(box.current as FleetDetailState, 'n0'), 'preview')
    act(() => { (box.current as FleetDetailState).requestFull('n0') })
    act(() => { (box.current as FleetDetailState).requestFull('n0') })
    assert.equal(fullReads, 1, 'an in-flight full read is shared')
    assert.equal(box.current?.fullPending.has('n0'), true, 'a pending full read keeps the preview prompt')
    assert.equal(agentPromptOf(box.current as FleetDetailState, 'n0'), 'preview')
    await act(async () => {})
    assert.equal(fullReads, 1)
    assert.equal(box.current?.fullLanded.has('n0'), false, 'a null read does not land as a success')
    assert.equal(box.current?.fullPending.size, 0)
    assert.equal(box.current?.landed.get('n0')?.detail?.initialPrompt, 'preview', 'the excerpt ledger was never touched')
    serve = detailWith({ messagesTotal: 1, initialPrompt: 'full', lastReply: { time: 2, text: 'report' } })
    act(() => { (box.current as FleetDetailState).requestFull('n0') })
    await act(async () => {})
    assert.equal(fullReads, 2, 'a settled null is retried on the next open')
    assert.equal(agentPromptOf(box.current as FleetDetailState, 'n0'), 'full')
    assert.equal(agentReplyOf(box.current as FleetDetailState, 'n0')?.text, 'report')
    act(() => { (box.current as FleetDetailState).requestFull('n0') })
    await act(async () => {})
    assert.equal(fullReads, 2, 'a landed full read replays')
    assert.equal(agentReplyOf(box.current as FleetDetailState, 'absent'), undefined)
    await m.unmount()
  })

  test('history reads respect the entry bound and a landing after unmount is inert', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 2, messages: [{ seq: 1, time: 1, kind: 'relay', text: 'x' }] })
      return Promise.resolve(batchOf(rows))
    })
    let releaseHistory: (batch: FleetBatch | null) => void = () => {}
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      if (mode === 'history') return new Promise((resolve) => { releaseHistory = resolve })
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 2, messages: [{ seq: 1, time: 1, kind: 'relay', text: 'x' }] })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => (box.current?.historyPending.size ?? 0) > 0, 'the history reads never started')
    assert.equal(box.current?.family.messages, 4, 'preview counts already serve the exact total')
    await m.unmount()
    releaseHistory({ rows: new Map(), missing: [], total: 0 })
    await flush()
    assert.equal(box.current?.historyLanded.size, 0)
  })

  test('a family with a single member releases an oversized fact without crashing', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 1, initialPrompt: 'p'.repeat(5 * 1024 * 1024) })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.family.loaded === 2, 'the oversized member never landed')
    assert.equal(box.current?.family.messages, 1, 'the count core survives the prose release')
    assert.equal(box.current?.facts.size, 2)
    await m.unmount()
  })
})

describe('useFleetDetails — defaults and degradation', () => {
  test('an owned cache and the default options load through the real fetchers', async () => {
    vi.stubGlobal('fetch', (_url: unknown, init: { body: string }) => {
      const body = JSON.parse(init.body) as { summary?: boolean; batch?: { ids: string[] } }
      if (body.summary === true) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { rootId: 'root', detail: { messages: [], truncated: false }, members: [], familySize: 1, counts: {} } }) } as Response)
      }
      const rows: Record<string, unknown> = {}
      for (const id of body.batch?.ids ?? []) rows[id] = { messages: [], messagesTotal: 1, truncated: false }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, value: { rows, missing: [], total: Object.keys(rows).length } }) } as Response)
    })
    const box: { current: FleetDetailState | null } = { current: null }
    function Probe(): null {
      box.current = useFleetDetails()
      return null
    }
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(2))) })
    await until(() => box.current?.family.loaded === 3, 'the real fetchers never completed the family')
    assert.equal(box.current?.family.messages, 2)
    act(() => { (box.current as FleetDetailState).retryFamily() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await m.unmount()
  })

  test('a request without a root or entries stays inert, and a summary transport error retries later', async () => {
    const cache = new FleetDetailCache()
    const summary = vi.spyOn(cache, 'fetchSummary')
    summary.mockRejectedValueOnce(new Error('offline'))
    summary.mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetch').mockResolvedValue(null)
    vi.spyOn(cache, 'fetchBatch').mockResolvedValue(batchOf({}))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }])) })
    await flush()
    assert.equal(summary.mock.calls.length, 1, 'the summary read failed once')
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }])) })
    await flush()
    assert.equal(summary.mock.calls.length, 2, 'the next family request retries the summary')
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([], { rootId: '' })) })
    await flush()
    await m.unmount()
  })

  test('a fallback single read resolving after unmount updates nothing', async () => {
    const cache = new FleetDetailCache()
    let resolveSummary: (summary: FleetSummary | null) => void = () => {}
    vi.spyOn(cache, 'fetchSummary').mockImplementation(() => new Promise((resolve) => { resolveSummary = resolve }))
    let release: (detail: FleetDetail | null) => void = () => {}
    vi.spyOn(cache, 'fetch').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await act(async () => {})
    await m.unmount()
    resolveSummary(null)
    await act(async () => {})
    release(detailWith({ messagesTotal: 1 }))
    await flush()
    assert.equal(box.current?.landed.size, 0)
  })

  test('a summary read that lands null serves the root through the single-session fallback', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(null)
    vi.spyOn(cache, 'fetch').mockResolvedValue(null)
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([])) })
    await until(() => box.current?.summary === null, 'the summary never settled')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(box.current?.landed.size, 0)
    await m.unmount()
  })
})

describe('useFleetDetails — facts and merged detail helpers', () => {
  test('mergedDetailOf prefers history only when it is at least as fresh as the preview', () => {
    const facts = new Map<string, FleetFact>()
    const preview: FleetDetail = detailWith({ messages: [{ seq: 1, time: 1, kind: 'relay', text: 'preview' }] })
    const history: FleetDetail = detailWith({ messages: [{ seq: 2, time: 2, kind: 'relay', text: 'history' }] })
    const details = {
      summary: null,
      landed: new Map([['a', { detail: preview, updatedAt: 5 }]]),
      historyLanded: new Map([['a', { detail: history, updatedAt: 4 }]]),
      fullLanded: new Map(),
      pending: new Set(), historyPending: new Set(), fullPending: new Set(),
      facts,
      family: { total: 0, loaded: 0, pending: 0, failed: 0, messages: null, delegations: null },
      requestFamily: vi.fn(), requestFull: vi.fn(), prioritize: vi.fn(), retryFamily: vi.fn(),
    } as unknown as FleetDetailState
    assert.equal(mergedDetailOf(details, 'a')?.messages[0]?.text, 'preview')
    details.historyLanded = new Map([['a', { detail: history, updatedAt: 5 }]])
    assert.equal(mergedDetailOf(details, 'a')?.messages[0]?.text, 'history')
    assert.equal(mergedDetailOf(details, 'missing'), null)
  })

  test('prompt and reply read the full read while it is landed and the compact facts otherwise', () => {
    const facts = new Map<string, FleetFact>([
      ['a', { updatedAt: 1, messagesTotal: 2, needsHistory: false, delegations: [], initialPrompt: 'fact prompt', lastReply: { time: 1, text: 'fact reply' } }],
    ])
    const details = {
      summary: null,
      landed: new Map(),
      historyLanded: new Map(),
      fullLanded: new Map(),
      pending: new Set(), historyPending: new Set(), fullPending: new Set(),
      facts,
      family: { total: 0, loaded: 0, pending: 0, failed: 0, messages: null, delegations: null },
      requestFamily: vi.fn(), requestFull: vi.fn(), prioritize: vi.fn(), retryFamily: vi.fn(),
    } as unknown as FleetDetailState
    assert.equal(agentPromptOf(details, 'a'), 'fact prompt')
    assert.equal(agentReplyOf(details, 'a')?.text, 'fact reply')
    details.fullLanded = new Map([['a', detailWith({ messagesTotal: 2, initialPrompt: 'full prompt' })]])
    assert.equal(agentPromptOf(details, 'a'), 'full prompt')
    details.fullLanded = new Map([['a', detailWith({ messagesTotal: 2 })]])
    assert.equal(agentPromptOf(details, 'a'), 'fact prompt', 'a promptless full read falls back to the compact fact')
    details.fullLanded = new Map([['a', detailWith({ messagesTotal: 2, initialPrompt: 'full prompt' })]])
    assert.equal(agentReplyOf(details, 'a')?.text, 'fact reply')
    details.fullPending = new Set(['a'])
    assert.equal(agentPromptOf(details, 'a'), 'fact prompt')
    assert.equal(agentReplyOf(details, 'a')?.text, 'fact reply')
    assert.equal(agentPromptOf(details, 'unknown'), undefined)
    assert.equal(agentReplyOf(details, 'unknown'), undefined)
  })
})

describe('useFleetDetails — facts, ordering and edge states', () => {
  test('compact facts keep replies and rosters, and the entry bound drops the oldest member', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        rows[id] = detailWith({
          messagesTotal: 1,
          lastReply: { time: 2, text: 'reply-' + id },
          roster: [{ name: 'name-' + id, description: 'duty' }],
        })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(3))) })
    await until(() => box.current?.family.loaded === 4, 'the family never loaded')
    assert.equal(agentReplyOf(box.current as FleetDetailState, 'n0')?.text, 'reply-n0')
    assert.equal(box.current?.facts.get('n0')?.roster?.[0]?.name, 'name-n0')
    await m.unmount()
  })

  test('more than the facts bound keeps the newest entries and reports unknown totals', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 1 })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const entries = [{ id: 'root', updatedAt: 1 }, ...Array.from({ length: 1024 }, (_, i) => ({ id: `m${i}`, updatedAt: 1000 - i }))]
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(entries)) })
    await eventually(() => box.current?.facts.size === 1024, 'the facts bound never engaged')
    assert.equal(box.current?.facts.size, 1024)
    assert.equal(box.current?.family.messages, null, 'one evicted member keeps the total unknown')
    await m.unmount()
  })

  test('equal updatedAt members order by id while the priority member leads the history pass', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const previewIds: string[][] = []
    const historyIds: string[][] = []
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      const rows: Record<string, FleetDetail> = {}
      if (mode === 'history') {
        historyIds.push([...ids])
        for (const id of ids) rows[id] = detailWith({ messages: [{ seq: 1, time: 1, kind: 'relay', text: 'h' }], messagesTotal: 2 })
      } else {
        previewIds.push([...ids])
        for (const id of ids) rows[id] = detailWith({ messagesTotal: 2, messages: [{ seq: 1, time: 1, kind: 'relay', text: 'p' }] })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const entries = [
      { id: 'root', updatedAt: 1 },
      { id: 'zz', updatedAt: 5 },
      { id: 'aa', updatedAt: 5 },
      { id: 'bb', updatedAt: 5 },
      { id: 'mm', updatedAt: 5 },
    ]
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(entries, { priority: new Set(['mm']) })) })
    await eventually(() => historyIds.length > 0, 'the history pass never started')
    assert.deepEqual(previewIds[0], ['mm', 'aa', 'bb', 'zz'])
    assert.equal(historyIds[0]?.[0], 'mm', 'the priority member leads the history pass')
    await m.unmount()
  })

  test('a failing history read leaves the preview standing and stops retrying', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const history = vi.fn(() => Promise.resolve(batchOf({}, ['n0'])))
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      if (mode === 'history') return history() as Promise<FleetBatch>
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 3, messages: [{ seq: 1, time: 1, kind: 'relay', text: 'p' }] })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(2000)
    assert.equal(history.mock.calls.length, 3, 'the history read never exhausted its retries')
    assert.equal(box.current?.landed.get('n0')?.detail?.messagesTotal, 3, 'the preview stands')
    assert.equal(box.current?.historyLanded.size, 0)
    await m.unmount()
  })

  test('retryFamily and a fleet invalidation before any family request stay inert', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).retryFamily() })
    await act(async () => { invalidate('fleet') })
    assert.equal(box.current?.family.total, 0)
    await m.unmount()
  })

  test('a full read for a member outside the family reads at stamp zero and lands once', async () => {
    const cache = new FleetDetailCache()
    const fetch = vi.spyOn(cache, 'fetch').mockResolvedValue(detailWith({ initialPrompt: 'outside', messagesTotal: 1 }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFull('outside') })
    await act(async () => {})
    assert.deepEqual(fetch.mock.calls[0], ['outside', 0, true])
    assert.equal(box.current?.fullLanded.get('outside')?.initialPrompt, 'outside')
    await m.unmount()
  })

  test('a full landing after unmount updates nothing', async () => {
    const cache = new FleetDetailCache()
    let release: (detail: FleetDetail | null) => void = () => {}
    vi.spyOn(cache, 'fetch').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFull('a') })
    await m.unmount()
    release(detailWith({ messagesTotal: 1 }))
    await flush()
    assert.equal(box.current?.fullLanded.size, 0)
  })

  test('removing a member clears its retry ledger so a returning member starts fresh', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const attempts = vi.fn(() => Promise.resolve(batchOf({}, ['n0'])))
    vi.spyOn(cache, 'fetchBatch').mockImplementation(attempts)
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(2000)
    assert.equal(box.current?.family.failed, 1)
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }])) })
    await advance(0)
    const before = attempts.mock.calls.length
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }, { id: 'n0', updatedAt: 100 }])) })
    await advance(2000)
    assert.ok(attempts.mock.calls.length > before, 'the returning member was never re-read')
    assert.equal(box.current?.family.failed, 1, 'a still-unreadable member fails again after its fresh attempts')
    await m.unmount()
  })

  test('a repeated family request keeps the pending retry keys it still needs', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockImplementation(() => Promise.resolve(batchOf({}, ['n0'])))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(200)
    const before = box.current?.family.failed
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(2000)
    assert.notEqual(before, undefined)
    assert.equal(box.current?.family.failed, 1)
    await m.unmount()
  })

  test('a summary landing after unmount or an aborted scope updates nothing', async () => {
    const cache = new FleetDetailCache()
    let release: (summary: FleetSummary | null) => void = () => {}
    vi.spyOn(cache, 'fetchSummary').mockImplementation(() => new Promise((resolve) => { release = resolve }))
    const options: { scopeKey?: string } = { scopeKey: 'one' }
    const { box, Probe } = probeDetails(cache, options)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await m.unmount()
    release(rootSummary())
    await flush()
    assert.equal(box.current?.landed.size, 0)

    const aborting = new FleetDetailCache()
    let settle: (summary: FleetSummary | null) => void = () => {}
    vi.spyOn(aborting, 'fetchSummary').mockImplementation(() => new Promise((resolve) => { settle = resolve }))
    const scope: { scopeKey?: string } = { scopeKey: 'one' }
    const probe = probeDetails(aborting, scope)
    const aborted = await mount(h(probe.Probe))
    act(() => { (probe.box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    scope.scopeKey = 'two'
    await aborted.update(h(probe.Probe))
    settle(rootSummary())
    await flush()
    assert.equal(probe.box.current?.landed.size, 0)
    await aborted.unmount()
  })

  test('an emptied family cancels pending retries and unmount cancels the timer', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    const attempts = vi.fn(() => Promise.resolve(batchOf({}, ['n0'])))
    vi.spyOn(cache, 'fetchBatch').mockImplementation(attempts)
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await advance(0)
    assert.ok(attempts.mock.calls.length >= 1, 'the first attempt never fired')
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([])) })
    await advance(1000)
    assert.equal(attempts.mock.calls.length, 1, 'the emptied family stopped the retry')
    await m.unmount()
  })
})

describe('useFleetDetails — in-flight scope and family changes', () => {
  test('a preview landing for a member removed mid-flight is dropped', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    let resolvePreview: (batch: FleetBatch | null) => void = () => {}
    vi.spyOn(cache, 'fetchBatch').mockImplementation(() => new Promise((resolve) => { resolvePreview = resolve }))
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.pending.size === 1, 'the preview read never started')
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }])) })
    resolvePreview(batchOf({ n0: detailWith({ messagesTotal: 1 }) }))
    await flush()
    assert.equal(box.current?.landed.has('n0'), false, 'the removed member is not resurrected')
    assert.equal(box.current?.facts.has('n0'), false)
    await m.unmount()
  })

  test('a history landing for a member removed mid-flight is dropped', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    let resolveHistory: (batch: FleetBatch | null) => void = () => {}
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      if (mode === 'history') return new Promise((resolve) => { resolveHistory = resolve })
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) rows[id] = detailWith({ messagesTotal: 2, messages: [{ seq: 1, time: 1, kind: 'relay', text: 'p' }] })
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.historyPending.size === 1, 'the history read never started')
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 1 }])) })
    resolveHistory(batchOf({ n0: detailWith({ messages: [] }) }))
    await flush()
    assert.equal(box.current?.historyLanded.has('n0'), false)
    await m.unmount()
  })

  test('an aborted rejecting batch never falls back to single reads', async () => {
    const cache = new FleetDetailCache()
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    let rejectBatch: (reason: Error) => void = () => {}
    vi.spyOn(cache, 'fetchBatch').mockImplementation(() => new Promise((_resolve, reject) => { rejectBatch = reject }))
    const singles = vi.spyOn(cache, 'fetch')
    const options: { scopeKey?: string } = { scopeKey: 'one' }
    const { box, Probe } = probeDetails(cache, options)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await until(() => box.current?.pending.size === 1, 'the batch never started')
    options.scopeKey = 'two'
    await m.update(h(Probe))
    rejectBatch(new Error('aborted request'))
    await flush()
    assert.equal(singles.mock.calls.length, 0, 'the aborted scope never downgraded to single reads')
    assert.equal(box.current?.landed.size, 0)
    await m.unmount()
  })
})

describe('useFleetDetails — summary refresh pacing', () => {
  test('a family refresh debounces the summary re-read and a scope switch cancels it', async () => {
    const cache = new FleetDetailCache()
    const summary = vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary())
    vi.spyOn(cache, 'fetchBatch').mockResolvedValue(batchOf({}))
    const options: { scopeKey?: string } = { scopeKey: 'one' }
    const { box, Probe } = probeDetails(cache, options)
    const m = await mount(h(Probe))
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(familyOf(1))) })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(summary.mock.calls.length, 1, 'the first paint loads the summary immediately')
    vi.useFakeTimers()
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 2 }], { rootStamp: 2 })) })
    await advance(700)
    assert.equal(summary.mock.calls.length, 1, 'a live stamp advance waits for the refresh window')
    await advance(100)
    assert.equal(summary.mock.calls.length, 2)
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest([{ id: 'root', updatedAt: 3 }], { rootStamp: 3 })) })
    options.scopeKey = 'two'
    await m.update(h(Probe))
    await advance(1000)
    assert.equal(summary.mock.calls.length, 2, 'a scope switch cancels the pending summary refresh')
    await m.unmount()
  })
})

describe('useFleetDetails — full-scope totals with a capped payload ledger', () => {
  test('a wide family keeps exact message and delegation totals after payload release', async () => {
    const cache = new FleetDetailCache()
    const members = 120
    vi.spyOn(cache, 'fetchSummary').mockResolvedValue(rootSummary({
      detail: detailWith({ messagesTotal: 3 }),
      counts: { root: { readAt: Date.now(), messagesTotal: 3, delegationsCount: 1 } },
    }))
    vi.spyOn(cache, 'fetchBatch').mockImplementation((ids, mode) => {
      const rows: Record<string, FleetDetail> = {}
      for (const id of ids) {
        rows[id] = mode === 'history'
          ? detailWith({ messages: Array.from({ length: 5 }, (_, i) => ({ seq: i + 1, time: i + 1, kind: 'relay' as const, text: 'event-' + String(i) })) })
          : detailWith({
            messagesTotal: 5,
            messages: [{ seq: 1, time: 1, kind: 'relay', text: 'preview' }],
            delegations: [{ seq: 2, time: 2, to: 'kid-' + id, mode: 'continuable' }],
          })
      }
      return Promise.resolve(batchOf(rows))
    })
    const { box, Probe } = probeDetails(cache)
    const m = await mount(h(Probe))
    const entries = [{ id: 'root', updatedAt: 1 }, ...Array.from({ length: members }, (_, i) => ({ id: `m${i}`, updatedAt: 1000 - i }))]
    act(() => { (box.current as FleetDetailState).requestFamily(familyRequest(entries)) })
    await until(() => box.current?.family.loaded === members + 1 && box.current?.facts.size === members + 1, 'the full family never converged')
    assert.equal(box.current?.family.failed, 0)
    assert.equal(box.current?.family.messages, members * 5 + 3, 'the message total comes from host counts, not the capped payload ledger')
    assert.equal(box.current?.family.delegations, members)
    assert.ok((box.current?.landed.size ?? 0) < members, 'the payload ledger stayed bounded')
    await m.unmount()
  })
})
