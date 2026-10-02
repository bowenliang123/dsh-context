// The timeline source (src/client/timelineSource.ts): the detail payload
// narrow, the Connection-RPC fetcher, the per-session detail store machine
// (debounce / single-flight / latest-wins / refold / retry / backoff), and
// the useTimelineSource hook merging both wire generations into the value
// the cards render.

import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi, afterEach } from 'vitest'
import type { ClientCtx } from '../../src/client/services'
import {
  DetailStore,
  detailOf,
  detailStoreOf,
  makeDetailFetcher,
  resetTimelineDetailStores,
  useTimelineSource,
} from '../../src/client/timelineSource'
import type { ContextTimeline, ContextTimelineDetail } from '../../src/shared/types'
import { TestClientCtx, asClientCtx } from './helpers/harness'
import { mount, text, until } from './helpers/kit'

afterEach(() => {
  resetTimelineDetailStores()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

/** A render-safe detail payload (the shape the host endpoint serves). */
function detail(rev: number, over: Record<string, unknown> = {}): ContextTimelineDetail {
  return {
    rev,
    requests: [{ seq: rev, time: 0, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 5, total: 15 }],
    events: [{ seq: rev, time: 0, kind: 'inject', form: 'context' }],
    nodes: [{ seq: rev, cat: 'user', tokens: 3 }],
    droppedNodes: 0,
    archive: [],
    ...over,
  }
}

/** A slim wire head (the split generation's pushed value). */
function slimHead(rev: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ok: true,
    model: 'm',
    current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
    counts: { turns: 1, steps: 1, injects: 1, compactions: 0, prunes: 0 },
    last: { seq: 9, total: 15, prompt: 14 },
    detailRev: rev,
    ...over,
  }
}

/**
 * Stub the global fetch with a programmable detail reply (the transport the
 * detail reader POSTs) and return a bare ctx — the reader never touches the
 * ctx's services for the read itself.
 */
function ctxWithCall(behavior: () => { status?: number; body?: unknown }): ClientCtx {
  vi.stubGlobal('fetch', async () => {
    const outcome = await behavior()
    const status = outcome.status ?? 200
    return { ok: status === 200, status, json: async () => outcome.body }
  })
  return asClientCtx(new TestClientCtx())
}

describe('detailOf', () => {
  test('rejects non-records and revision-less/negative/NaN payloads', () => {
    assert.equal(detailOf(null), null)
    assert.equal(detailOf(42), null)
    assert.equal(detailOf({}), null)
    assert.equal(detailOf({ rev: '1' }), null)
    assert.equal(detailOf({ rev: -1 }), null)
    assert.equal(detailOf({ rev: NaN }), null)
  })

  test('narrows a served payload: collections re-proved per item, floors conditional', () => {
    const d = detail(3, {
      requests: [{ seq: 3 }, null, 'junk'],
      nodes: [null, { seq: 2 }],
      droppedNodes: 'many',
      surfaceFloor: 7,
      archiveFloor: 'no',
    })
    const narrowed = detailOf(d)
    assert.ok(narrowed !== null)
    assert.equal(narrowed.rev, 3)
    assert.deepEqual(narrowed.requests, [{ seq: 3 }])
    assert.deepEqual(narrowed.nodes, [{ seq: 2 }])
    assert.equal(narrowed.droppedNodes, 0, 'a wrong-typed scalar zeroes')
    assert.equal(narrowed.surfaceFloor, 7)
    assert.equal(narrowed.archiveFloor, undefined, 'a wrong-typed floor stays absent')
    // A numeric archiveFloor rides through.
    assert.equal(detailOf(detail(1, { archiveFloor: 9 }))?.archiveFloor, 9)
    // The op log and its floor ride through, per-item guarded.
    const withOps = detailOf(detail(1, {
      fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }, null],
      fileOpsFloor: 4,
    }))
    assert.equal(withOps?.fileOps?.length, 1, 'junk entries drop')
    assert.equal(withOps?.fileOpsFloor, 4)
    // The timing strip's painted spans ride through, per-item guarded too.
    const withSpans = detailOf(detail(1, {
      spans: [{ kind: 'ttft', start: 0, end: 100 }, null],
    }))
    assert.equal(withSpans?.spans?.length, 1, 'junk span entries drop')
    // Absent stays absent (the legacy inline generation's marker).
    assert.equal(detailOf(detail(1))?.fileOps, undefined)
    assert.equal(detailOf(detail(1))?.spans, undefined)
  })

  test('the slim head rides through sanitized; a malformed head drops alone', () => {
    // A well-formed head passes through (the Agent network's cold-ring fetch).
    const served = detailOf(detail(2, { head: slimHead(2) }))
    assert.ok(served?.head !== undefined)
    assert.equal(served.head.current.total, 15)
    assert.equal(served.head.model, 'm')
    // A non-record head drops without rejecting the payload the cards consume.
    const junkHead = detailOf(detail(2, { head: 'nope' }))
    assert.ok(junkHead !== null)
    assert.equal(junkHead.head, undefined)
    assert.ok(junkHead.requests.length > 0)
    // Absent stays absent.
    assert.equal(detailOf(detail(2))?.head, undefined)
  })
})

describe('makeDetailFetcher', () => {
  test('no session id yields no fetcher', () => {
    assert.equal(makeDetailFetcher(ctxWithCall(() => ({ body: null })), ''), undefined)
  })

  test('the envelope contract: not-ok rejects, null value means absent, malformed value rejects', async () => {
    const failed = makeDetailFetcher(ctxWithCall(() => ({ body: { ok: false, error: { code: 'x', message: 'm', details: {} } } })), 's1')!
    await assert.rejects(() => failed(), /detail read failed/)

    const absent = makeDetailFetcher(ctxWithCall(() => ({ body: { ok: true, value: null } })), 's1')!
    assert.equal(await absent(), null)

    const malformed = makeDetailFetcher(ctxWithCall(() => ({ body: { ok: true, value: { no: 'rev' } } })), 's1')!
    await assert.rejects(() => malformed(), /detail read malformed/)

    const transport = makeDetailFetcher(ctxWithCall(() => {
      throw new Error('offline')
    }), 's1')!
    await assert.rejects(() => transport(), /offline/)

    // A non-200 answer (the route absent on an inline-generation host) rejects.
    const missing = makeDetailFetcher(ctxWithCall(() => ({ status: 404, body: 'not found' })), 's1')!
    await assert.rejects(() => missing(), /HTTP 404/)
  })

  test('a good read resolves the narrowed detail and POSTs the declared route', async () => {
    const seen: { url?: unknown; body?: unknown } = {}
    vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
      seen.url = url
      seen.body = JSON.parse(String(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(4) }) }
    })
    const d = await makeDetailFetcher(asClientCtx(new TestClientCtx()), 's1')!()
    assert.equal(d?.rev, 4)
    assert.equal(seen.url, '/api/dsh-context/detail')
    assert.deepEqual(seen.body, { sessionId: 's1' })
  })
})

describe('DetailStore', () => {
  /** A fetcher with a call log and a programmable queue of outcomes. */
  function scriptedFetcher(outcomes: (ContextTimelineDetail | null | Error)[]): { fetcher: () => Promise<ContextTimelineDetail | null>; calls: number[] } {
    const calls: number[] = []
    return {
      calls,
      fetcher: async () => {
        calls.push(Date.now())
        const next = outcomes.length > 0 ? outcomes.shift() : null
        if (next instanceof Error) throw next
        return next ?? null
      },
    }
  }

  async function settle(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 5))
  }

  test('request schedules the trailing-edge read; the snapshot transitions pending → landed', async () => {
    const { fetcher, calls } = scriptedFetcher([detail(1)])
    const store = new DetailStore(fetcher, 0)
    const seen: string[] = []
    store.subscribe(() => seen.push('change'))
    assert.equal(store.getSnapshot().pending, false)
    store.request(1)
    assert.equal(store.getSnapshot().pending, true, 'the debounce window is armed')
    await settle()
    assert.equal(store.getSnapshot().detail?.rev, 1)
    assert.equal(store.getSnapshot().pending, false)
    assert.equal(store.getSnapshot().failed, false)
    assert.equal(calls.length, 1)
    assert.ok(seen.length > 0, 'listeners fired')
    // The same revision asks for nothing new.
    store.request(1)
    await settle()
    assert.equal(calls.length, 1, 'a covered revision does not refetch')
  })

  test('unsubscribe stops the notifications', async () => {
    const { fetcher } = scriptedFetcher([detail(1)])
    const store = new DetailStore(fetcher, 0)
    const seen: string[] = []
    const off = store.subscribe(() => seen.push('change'))
    off()
    store.request(1)
    await settle()
    assert.equal(seen.length, 0)
  })

  test('a rev bump during the in-flight read re-reads after settle (trailing edge)', async () => {
    let gate!: () => void
    const first = new Promise<ContextTimelineDetail | null>(resolve => { gate = () => resolve(detail(1)) })
    let call = 0
    const store = new DetailStore(() => {
      call++
      return call === 1 ? first : Promise.resolve(detail(2))
    }, 0)
    store.request(1)
    await vi.waitFor(() => { assert.equal(call, 1) })
    store.request(2)
    gate()
    await until(() => store.getSnapshot().detail?.rev === 2, 'the trailing read never landed')
    assert.equal(call, 2)
  })

  test('latest-wins: a stale response (behind the served rev, off-target) drops; the trail re-reads', async () => {
    const { fetcher, calls } = scriptedFetcher([detail(3), detail(2), detail(4)])
    const store = new DetailStore(fetcher, 0)
    store.request(3)
    await settle()
    assert.equal(store.getSnapshot().detail?.rev, 3)
    store.request(4)
    await until(() => store.getSnapshot().detail?.rev === 4, 'the trail never converged')
    assert.equal(calls.length, 3, 'the stale rev-2 answer burned one read before the rev-4 landing')
  })

  test('a rev DECREASE means the host refolded: the ledger resets and refetches', async () => {
    const { fetcher } = scriptedFetcher([detail(5), detail(2)])
    const store = new DetailStore(fetcher, 0)
    store.request(5)
    await settle()
    assert.equal(store.getSnapshot().detail?.rev, 5)
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the refold reset never refetched')
  })

  for (const outcome of ['detail', 'absent', 'failure'] as const) {
    for (const timerFired of [false, true]) {
      test(`a refold ignores an old ${outcome} before a new read (timer fired: ${String(timerFired)})`, async () => {
        vi.useFakeTimers()
        let resolve!: (value: ContextTimelineDetail | null) => void
        let reject!: (reason: Error) => void
        let calls = 0
        const first = new Promise<ContextTimelineDetail | null>((res, rej) => {
          resolve = res
          reject = rej
        })
        const store = new DetailStore(() => {
          calls++
          return calls === 1 ? first : Promise.resolve(detail(2))
        }, 10)
        store.request(5)
        await vi.advanceTimersByTimeAsync(10)
        store.request(2)
        if (timerFired) await vi.advanceTimersByTimeAsync(10)
        assert.equal(calls, 1, 'the reset never stacks a concurrent read')

        if (outcome === 'failure') reject(new Error('offline'))
        else resolve(outcome === 'detail' ? detail(5) : null)
        await vi.advanceTimersByTimeAsync(0)
        assert.equal(store.getSnapshot().detail, null, 'old collections must not land under the new head')
        assert.equal(store.getSnapshot().failed, false, 'old absence or failure must not fail the new generation')
        assert.equal(store.getSnapshot().pending, true, 'the new generation still needs its read')

        await vi.advanceTimersByTimeAsync(10)
        assert.equal(calls, 2)
        assert.equal(store.getSnapshot().detail?.rev, 2)
        assert.equal(store.getSnapshot().failed, false)
        assert.equal(store.getSnapshot().pending, false)
      })
    }
  }

  test('several refolds during one read converge to the latest generation', async () => {
    vi.useFakeTimers()
    let resolve!: (value: ContextTimelineDetail | null) => void
    let calls = 0
    const first = new Promise<ContextTimelineDetail | null>(res => { resolve = res })
    const store = new DetailStore(() => {
      calls++
      return calls === 1 ? first : Promise.resolve(detail(1))
    }, 10)
    store.request(5)
    await vi.advanceTimersByTimeAsync(10)
    store.request(3)
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    resolve(detail(5))
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail, null)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls, 2)
    assert.equal(store.getSnapshot().detail?.rev, 1)
  })

  test('a transport failure with no detail arms the failed state; the backoff trailing recovers on its own', async () => {
    const { fetcher, calls } = scriptedFetcher([new Error('offline'), detail(1)])
    const store = new DetailStore(fetcher, 20)
    store.request(1)
    await until(() => store.getSnapshot().failed === true, 'the failure never surfaced')
    assert.equal(store.getSnapshot().detail, null)
    // No manual retry: the trailing edge re-reads after the backoff window.
    await until(() => store.getSnapshot().detail?.rev === 1, 'the trailing recovery never landed')
    assert.equal(store.getSnapshot().failed, false)
    assert.equal(calls.length, 2)
  })

  test('a transport failure WITH detail keeps the served value (no flicker to failed), then recovers', async () => {
    const { fetcher, calls } = scriptedFetcher([detail(1), new Error('offline'), detail(2)])
    const store = new DetailStore(fetcher, 0)
    store.request(1)
    await until(() => store.getSnapshot().detail?.rev === 1, 'the first read never landed')
    store.request(2)
    // Mid-way: the failed read settles with the last good detail still serving
    // (>=: the zero-debounce trail can land the recovery between two polls).
    await until(() => calls.length >= 2, 'the second read never fired')
    await until(() => store.getSnapshot().detail?.rev === 2, 'the trailing recovery never landed')
    assert.equal(store.getSnapshot().failed, false, 'the failed read never flipped the cards to failed')
  })

  test('an absent answer stops the trailing; a fresh rev asks again', async () => {
    const { fetcher, calls } = scriptedFetcher([null, detail(2)])
    const store = new DetailStore(fetcher, 0)
    store.request(1)
    await settle()
    assert.equal(store.getSnapshot().failed, true, 'absent with nothing to show arms the note')
    await settle()
    assert.equal(calls.length, 1, 'absence stops the self-trailing')
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the fresh rev never refetched')
    assert.equal(store.getSnapshot().failed, false)
  })

  test('retry with no armed timer refires directly (the stopped-trailing shape)', async () => {
    // Absence stops the trailing timer; the manual retry must not wait on one.
    const { fetcher, calls } = scriptedFetcher([null, detail(1)])
    const store = new DetailStore(fetcher, 0)
    store.request(1)
    await until(() => store.getSnapshot().failed === true, 'the absent read never settled')
    assert.equal(calls.length, 1)
    store.retry()
    await until(() => store.getSnapshot().detail?.rev === 1, 'the timer-less retry never fired')
    assert.equal(calls.length, 2)
  })

  test('retry during an in-flight read does not stack a second call', async () => {
    let release!: (d: ContextTimelineDetail | null) => void
    let started = false
    const store = new DetailStore(() => {
      started = true
      return new Promise<ContextTimelineDetail | null>(resolve => { release = resolve })
    }, 0)
    store.request(1)
    await until(() => started, 'the read never started')
    store.retry()
    release(detail(1))
    await until(() => store.getSnapshot().detail?.rev === 1, 'the in-flight read never landed')
    assert.equal(store.getSnapshot().failed, false)
  })

  test('absence with a served detail keeps it and stays silent', async () => {
    const { fetcher } = scriptedFetcher([detail(1), null])
    const store = new DetailStore(fetcher, 0)
    store.request(1)
    await settle()
    store.request(2)
    await until(() => store.getSnapshot().pending === false, 'the absent read never settled')
    assert.equal(store.getSnapshot().detail?.rev, 1)
    assert.equal(store.getSnapshot().failed, false)
  })

  test('without a fetcher the store types the failure (the empty-session-id path)', async () => {
    const store = new DetailStore(undefined, 0)
    store.request(1)
    await settle()
    assert.equal(store.getSnapshot().failed, true)
    assert.equal(store.getSnapshot().detail, null)
  })

  test('retry re-arms immediately and resets the backoff', async () => {
    const { fetcher, calls } = scriptedFetcher([new Error('offline'), detail(1)])
    const store = new DetailStore(fetcher, 1000)
    store.request(1)
    await vi.waitFor(() => { assert.equal(calls.length, 1) }, { timeout: 3000 })
    await until(() => store.getSnapshot().failed === true, 'the failure never settled')
    store.retry()
    await until(() => store.getSnapshot().detail?.rev === 1, 'the retry never refetched')
    assert.equal(calls.length, 2)
    // A retry with a served detail is a no-op.
    store.retry()
    await settle()
    assert.equal(calls.length, 2)
  })

  test('consecutive failures back the debounce off exponentially', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([new Error('a'), new Error('b'), detail(1)])
    const store = new DetailStore(fetcher, 10)
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls.length, 1, 'the first read fires after the base window')
    assert.equal(store.getSnapshot().failed, true)
    // The failed read's trailing edge waits out the DOUBLED window.
    await vi.advanceTimersByTimeAsync(19)
    assert.equal(calls.length, 1, 'the trailing read waits out the doubled window')
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls.length, 2)
    // Second failure: the window doubles again (40).
    await vi.advanceTimersByTimeAsync(39)
    assert.equal(calls.length, 2)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls.length, 3, 'the recovered read lands')
  })

  test('a rev bump arriving while a read is in flight waits out the flight, then trails', async () => {
    // The in-flight guard: the bumped rev's timer fires DURING the first read
    // and must not stack a second call; the settle re-arms it.
    let release!: (d: ContextTimelineDetail | null) => void
    let call = 0
    const store = new DetailStore(() => {
      call++
      if (call === 1) return new Promise<ContextTimelineDetail | null>(resolve => { release = resolve })
      return Promise.resolve(detail(2))
    }, 0)
    store.request(1)
    await vi.waitFor(() => { assert.equal(call, 1) })
    store.request(2)
    await settle()
    assert.equal(call, 1, 'no stacked read while the first is in flight')
    release(detail(1))
    await until(() => store.getSnapshot().detail?.rev === 2, 'the trailing read never landed')
    assert.equal(call, 2)
  })
})

describe('detailStoreOf', () => {
  test('one store per session, shared by every consumer; reset drops the cache', () => {
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: detail(1) } }))
    const a = detailStoreOf(ctx, 's1')
    assert.equal(a, detailStoreOf(ctxWithCall(() => ({ body: { ok: true, value: null } })), 's1'), 'the session key wins, the first fetcher keeps serving')
    assert.notEqual(a, detailStoreOf(ctx, 's2'))
    resetTimelineDetailStores()
    assert.notEqual(detailStoreOf(ctx, 's1'), a, 'a reset store is a fresh instance')
  })
})

/** A probe component rendering the source's observable surface as text. */
function SourceProbe(props: { ctx: ClientCtx; sessionId: string; value?: unknown; useProjection?: (key: string) => unknown }): ReactElement {
  const useProjection = props.useProjection ?? ((key: string) => (key === 'contextTimeline' ? props.value : undefined))
  const source = useTimelineSource(props.ctx, {
    sessionId: props.sessionId,
    useProjection,
  })
  const data = source.data
  return h('div', null,
    h('span', { 'data-k': 'state' }, source.detailState),
    h('span', { 'data-k': 'steps' }, data === null ? 'null' : String(data.requests.length)),
    h('span', { 'data-k': 'turns' }, String(data?.counts?.turns ?? 'x')),
    h('span', { 'data-k': 'rev' }, String(data?.detailRev ?? 'x')),
    h('span', { 'data-k': 'floors' }, `${String(data?.surfaceFloor ?? 'x')}/${String(data?.archiveFloor ?? 'x')}`),
    h('span', { 'data-k': 'ops' }, String(data?.fileOps?.length ?? 'x')),
    h('span', { 'data-k': 'spans' }, String(data?.spans?.length ?? 'x')),
    h('span', { 'data-k': 'model' }, data?.model ?? 'x'),
    h('button', { 'data-k': 'retry', onClick: source.retryDetail }, 'retry'))
}

function probeRead(container: HTMLElement, key: string): string {
  return text(container.querySelector(`[data-k="${key}"]`) as HTMLElement)
}

describe('useTimelineSource', () => {
  test('a refold never merges the previous generation into the pushed head', async () => {
    vi.useFakeTimers()
    const response = (value: ContextTimelineDetail) => ({ ok: true, json: async () => ({ ok: true, value }) })
    let resolve!: (value: ReturnType<typeof response>) => void
    let calls = 0
    const first = new Promise<ReturnType<typeof response>>(res => { resolve = res })
    vi.stubGlobal('fetch', () => {
      calls++
      return calls === 1 ? first : Promise.resolve(response(detail(2)))
    })
    const ctx = asClientCtx(new TestClientCtx())
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(5) }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await m.update(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(2) }))
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await act(async () => {
        resolve(response(detail(5)))
        await vi.advanceTimersByTimeAsync(0)
      })
      assert.equal(probeRead(m.container, 'rev'), '2')
      assert.equal(probeRead(m.container, 'state'), 'loading')
      assert.equal(probeRead(m.container, 'steps'), '0', 'no rows from the discarded generation')
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      assert.equal(calls, 2)
      assert.equal(probeRead(m.container, 'state'), 'ready')
      assert.equal(detailStoreOf(ctx, 's1').getSnapshot().detail?.rev, 2)
    } finally {
      await m.unmount()
    }
  })

  test('the inline generation passes through untouched and never fetches', async () => {
    let calls = 0
    const ctx = ctxWithCall(() => {
      calls++
      return { body: { ok: true, value: detail(1) } }
    })
    const inline: ContextTimeline = {
      ok: true,
      model: 'inline-m',
      current: { system: 1, tools: 2, user: 3, inject: 0, skill: 0, assistant: 4, tool: 5, total: 15 },
      requests: [{ seq: 1, time: 0, system: 1, tools: 2, user: 3, inject: 0, assistant: 4, tool: 5, total: 15 }],
      events: [],
      nodes: [],
      droppedNodes: 0,
      archive: [],
    }
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: inline }))
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(probeRead(m.container, 'state'), 'legacy')
    assert.equal(probeRead(m.container, 'steps'), '1')
    assert.equal(probeRead(m.container, 'model'), 'inline-m')
    assert.equal(calls, 0, 'the inline generation never opens the detail channel')
    // The legacy retry is the inert no-op (the cards show no note).
    await act(async () => {
      ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
    })
    await m.unmount()
  })

  test('the cold start: no pushed value opens the channel itself and renders from the read', async () => {
    let calls = 0
    const ctx = ctxWithCall(() => {
      calls++
      return { body: { ok: true, value: detail(2, { head: slimHead(2) }) } }
    })
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: undefined }))
    // The first paint waits on the cold read — then the read's own slim head
    // stands in for the never-pushed projection value.
    assert.equal(probeRead(m.container, 'state'), 'loading')
    await until(() => probeRead(m.container, 'state') === 'ready', 'the cold read never landed')
    assert.equal(probeRead(m.container, 'model'), 'm', 'the read head renders')
    assert.equal(probeRead(m.container, 'rev'), '2')
    assert.equal(probeRead(m.container, 'steps'), '1', 'the read collections merge')
    assert.ok(calls >= 1)
    await m.unmount()
  })

  test('a pushed head arriving after the cold read takes the channel back', async () => {
    // The stub folds the served rev per the latest requested revision — the
    // production route folds the requested session at its current watermark.
    let servedRev = 1
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: detail(servedRev, { head: slimHead(servedRev, { model: servedRev === 1 ? 'cold-m' : 'pushed-m' }) }) }) }))
    const ctx = asClientCtx(new TestClientCtx())
    // The probe reads `useProjection` through a mutable capture so an update
    // rerender sees the freshly pushed head (the real seat reads per render).
    let pushed: unknown = undefined
    function PushProbe(): ReactElement {
      return h(SourceProbe, {
        ctx,
        sessionId: 's1',
        useProjection: (key: string) => (key === 'contextTimeline' ? pushed : undefined),
      })
    }
    const m = await mount(h(PushProbe, null))
    await until(() => probeRead(m.container, 'state') === 'ready', 'the cold read never landed')
    assert.equal(probeRead(m.container, 'model'), 'cold-m')
    // The pushed head outruns the cold read's revision: same per-session
    // store, one trailing refetch, the pushed value renders.
    servedRev = 2
    pushed = slimHead(2, { model: 'pushed-m' })
    await m.update(h(PushProbe, null))
    assert.equal(probeRead(m.container, 'model'), 'pushed-m', 'the pushed head wins at once')
    assert.equal(probeRead(m.container, 'rev'), '2', 'the pushed revision renders')
    await until(() => detailStoreOf(ctx, 's1').getSnapshot().detail?.rev === 2, 'the pushed head never trailed the channel')
    await m.unmount()
  })

  test('the cold read failing arms the retry affordance instead of stalling', async () => {
    let online = false
    const ctx = ctxWithCall(() => {
      if (!online) throw new Error('offline')
      return { body: { ok: true, value: detail(1, { head: slimHead(1) }) } }
    })
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: undefined }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'the cold failure never surfaced')
    assert.equal(probeRead(m.container, 'steps'), 'null')
    online = true
    await act(async () => {
      ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
    })
    await until(() => probeRead(m.container, 'state') === 'ready', 'the retry never recovered')
    await m.unmount()
  })

  test('a cold payload without its head types the failure (nothing renderable, no stall)', async () => {
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: detail(1) } }))
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: undefined }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'the headless payload never surfaced')
    await m.unmount()
  })

  test('an absent cold answer (the session left the live set) surfaces the failed note', async () => {
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: null } }))
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: undefined }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'absence never surfaced')
    await m.unmount()
  })

  test('no session id to read for: the cold start types the failure, not an eternal spinner', async () => {
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: detail(1, { head: slimHead(1) }) } }))
    const m = await mount(h(SourceProbe, { ctx, sessionId: '', value: undefined }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'the empty-id cold start never surfaced')
    await m.unmount()
  })

  test('the split generation: counters render off the head immediately, the detail lands through the channel', async () => {
    let calls = 0
    const ctx = ctxWithCall(() => {
      calls++
      return {
        body: {
          ok: true,
          value: detail(3, {
            surfaceFloor: 2,
            archiveFloor: 5,
            fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
            fileOpsFloor: 4,
            spans: [{ kind: 'ttft', start: 0, end: 100 }, { kind: 'other', start: 100, end: 1_400 }],
          }),
        },
      }
    })
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(3) }))
    // The first paint: the head's counters with the detail still pending.
    assert.equal(probeRead(m.container, 'state'), 'loading')
    assert.equal(probeRead(m.container, 'turns'), '1', 'the head counters render before the detail lands')
    assert.equal(probeRead(m.container, 'steps'), '0', 'the collections wait for the channel')
    assert.equal(probeRead(m.container, 'floors'), 'x/x', 'no floors before the detail')
    await until(() => probeRead(m.container, 'state') === 'ready', 'the detail never landed')
    assert.equal(probeRead(m.container, 'steps'), '1', 'the merged requests serve')
    assert.equal(probeRead(m.container, 'rev'), '3')
    assert.equal(probeRead(m.container, 'floors'), '2/5', 'the detail floors merge')
    assert.equal(probeRead(m.container, 'ops'), '1', 'the op log merges')
    assert.equal(probeRead(m.container, 'spans'), '2', 'the strip spans merge')
    assert.ok(calls >= 1)
    await m.unmount()
  })

  test('a rev bump on the pushed head refetches the detail', async () => {
    let served = 3
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: detail(served) } }))
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(3) }))
    await until(() => probeRead(m.container, 'state') === 'ready', 'the first read never landed')
    assert.equal(detailStoreOf(ctx, 's1').getSnapshot().detail?.rev, 3)
    served = 4
    await m.update(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(4) }))
    // The probe's rev cell reads the HEAD's marker (4 as pushed); the store's
    // served detail proves the refetch.
    assert.equal(probeRead(m.container, 'rev'), '4')
    await until(() => detailStoreOf(ctx, 's1').getSnapshot().detail?.rev === 4, 'the refetch never landed')
    await m.unmount()
  })

  test('the failed read arms the retry affordance, which refires the read', async () => {
    let online = false
    let calls = 0
    const ctx = ctxWithCall(() => {
      calls++
      if (!online) throw new Error('offline')
      return { body: { ok: true, value: detail(1) } }
    })
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(1) }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'the failure never surfaced')
    online = true
    await act(async () => {
      ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
    })
    await until(() => probeRead(m.container, 'state') === 'ready', 'the retry never recovered')
    assert.ok(calls >= 2)
    await m.unmount()
  })

  test('an absent answer (the session left the live set) surfaces the failed note', async () => {
    const ctx = ctxWithCall(() => ({ body: { ok: true, value: null } }))
    const m = await mount(h(SourceProbe, { ctx, sessionId: 's1', value: slimHead(1) }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'absence never surfaced')
    await m.unmount()
  })
})
