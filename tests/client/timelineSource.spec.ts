import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi, afterEach, beforeEach } from 'vitest'
import {
  DetailStore,
  detailBytesOf,
  detailOf,
  detailStoreOf,
  makeDetailFetcher,
  resetTimelineDetailStores,
  useTimelineSource,
} from '../../src/client/timelineSource'
import type { ContextTimeline, ContextTimelineDetail } from '../../src/shared/types'
import { mount, text, until } from './helpers/kit'

afterEach(() => {
  resetTimelineDetailStores()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

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

function stubDetailFetch(behavior: () => { status?: number; body?: unknown }): void {
  vi.stubGlobal('fetch', async () => {
    const outcome = await behavior()
    const status = outcome.status ?? 200
    return { ok: status === 200, status, json: async () => outcome.body }
  })
}

describe('detailOf', () => {
  test('rejects non-records and revision-less/negative/NaN payloads; a served payload narrows per item', () => {
    assert.equal(detailOf(null), null)
    assert.equal(detailOf(42), null)
    assert.equal(detailOf({}), null)
    assert.equal(detailOf({ rev: '1' }), null)
    assert.equal(detailOf({ rev: -1 }), null)
    assert.equal(detailOf({ rev: NaN }), null)
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
    assert.equal(detailOf(detail(1, { archiveFloor: 9 }))?.archiveFloor, 9)
    const withOps = detailOf(detail(1, {
      fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }, null],
      fileOpsFloor: 4,
    }))
    assert.equal(withOps?.fileOps?.length, 1, 'junk entries drop')
    assert.equal(withOps?.fileOpsFloor, 4)
    const withSpans = detailOf(detail(1, {
      spans: [{ kind: 'ttft', start: 0, end: 100 }, null],
    }))
    assert.equal(withSpans?.spans?.length, 1, 'junk span entries drop')
    assert.equal(detailOf(detail(1))?.fileOps, undefined)
    assert.equal(detailOf(detail(1))?.spans, undefined)
  })

  test('the slim head rides through sanitized; a malformed head drops alone', () => {
    const served = detailOf(detail(2, { head: slimHead(2) }))
    assert.ok(served?.head !== undefined)
    assert.equal(served.head.current.total, 15)
    assert.equal(served.head.model, 'm')
    const junkHead = detailOf(detail(2, { head: 'nope' }))
    assert.ok(junkHead !== null)
    assert.equal(junkHead.head, undefined)
    assert.ok(junkHead.requests.length > 0)
    assert.equal(detailOf(detail(2))?.head, undefined)
  })
})

describe('makeDetailFetcher', () => {
  test('no session id yields no fetcher', () => {
    assert.equal(makeDetailFetcher(''), undefined)
  })

  test('the envelope contract: not-ok rejects, null value means absent, malformed value rejects', async () => {
    stubDetailFetch(() => ({ body: { ok: false, error: { code: 'x', message: 'm', details: {} } } }))
    const failed = makeDetailFetcher('s1')!
    await assert.rejects(() => failed(), /detail read failed/)

    stubDetailFetch(() => ({ body: { ok: true, value: null } }))
    const absent = makeDetailFetcher('s1')!
    assert.equal(await absent(), null)

    stubDetailFetch(() => ({ body: { ok: true, value: { no: 'rev' } } }))
    const malformed = makeDetailFetcher('s1')!
    await assert.rejects(() => malformed(), /detail read malformed/)

    stubDetailFetch(() => {
      throw new Error('offline')
    })
    const transport = makeDetailFetcher('s1')!
    await assert.rejects(() => transport(), /offline/)

    stubDetailFetch(() => ({ status: 404, body: 'not found' }))
    const missing = makeDetailFetcher('s1')!
    await assert.rejects(() => missing(), /HTTP 404/)
  })

  test('a good read resolves the narrowed detail and POSTs the declared route', async () => {
    const seen: { url?: unknown; body?: unknown } = {}
    vi.stubGlobal('fetch', async (url: unknown, init: { body: string }) => {
      seen.url = url
      seen.body = JSON.parse(String(init.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(4) }) }
    })
    const d = await makeDetailFetcher('s1')!()
    assert.equal(d?.rev, 4)
    assert.equal(seen.url, 'api/dsh-context/detail')
    assert.deepEqual(seen.body, { sessionId: 's1' })
  })
})

describe('DetailStore', () => {
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
    const { fetcher, calls } = scriptedFetcher([detail(1), detail(2)])
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
    store.request(1)
    await settle()
    assert.equal(calls.length, 1, 'a covered revision does not refetch')
    const off = store.subscribe(() => seen.push('late'))
    off()
    store.request(2)
    await settle()
    assert.equal(seen.includes('late'), false, 'an unsubscribed listener hears nothing')
  })

  test('a parked store arms no read; it parks only when its last subscriber leaves', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([detail(1)])
    const store = new DetailStore(fetcher, 10)
    const offTab = store.subscribe(() => {})
    const offModal = store.subscribe(() => {})
    store.request(1)
    assert.equal(store.getSnapshot().pending, true, 'the debounce window is armed')
    offTab()
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls.length, 1, 'the remaining subscriber still gets its read')
    offModal()
    assert.equal(store.getSnapshot().pending, false, 'parking drops the pending window')
    await vi.advanceTimersByTimeAsync(100)
    store.request(2)
    await vi.advanceTimersByTimeAsync(100)
    assert.equal(calls.length, 1, 'a parked store never reaches the fetcher')
    vi.useRealTimers()
  })

  test('a read settling after the last unsubscribe does not re-arm', async () => {
    vi.useFakeTimers()
    let reject!: (error: Error) => void
    let calls = 0
    const store = new DetailStore(() => {
      calls++
      return new Promise<ContextTimelineDetail | null>((_resolve, rej) => { reject = rej })
    }, 10)
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls, 1, 'the read is in flight')
    off()
    reject(new Error('offline'))
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls, 1, 'no retry is armed once nobody is subscribed')
    vi.useRealTimers()
  })

  test('a parked store resumes without a cached payload by reading again, and with one by serving the cache', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([new Error('offline'), detail(1)])
    const store = new DetailStore(fetcher, 10)
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls.length, 1)
    assert.equal(store.getSnapshot().failed, true)
    off()
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls.length, 1, 'the parked retry is dropped')
    store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls.length, 2, 'the resumed store reads instead of sticking on the note')
    vi.useRealTimers()

    const cached = scriptedFetcher([detail(1)])
    const cachedStore = new DetailStore(cached.fetcher, 0)
    const offCached = cachedStore.subscribe(() => {})
    cachedStore.request(1)
    await until(() => cachedStore.getSnapshot().detail?.rev === 1, 'the first read never landed')
    offCached()
    cachedStore.subscribe(() => {})
    cachedStore.request(1)
    await settle()
    assert.equal(cached.calls.length, 1, 'the cached payload still covers the rev')
  })

  test('release drops the cached payload and any armed window', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([detail(1), detail(2)])
    const store = new DetailStore(fetcher, 10)
    store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(store.hasPayload, true)
    store.request(2)
    assert.equal(store.getSnapshot().pending, true, 'a second window is armed')
    store.release()
    assert.equal(store.hasPayload, false)
    assert.equal(store.getSnapshot().pending, false)
    await vi.advanceTimersByTimeAsync(100)
    assert.equal(calls.length, 1, 'the released store arms nothing')
    vi.useRealTimers()
  })

  test('a rev bump during an in-flight read stacks nothing, then trails after settle', async () => {
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
    await settle()
    assert.equal(call, 1, 'no stacked read while the first is in flight')
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

  test('a detail revision ahead of the head (legacy checkpoint) never suppresses later head bumps', async () => {
    const { fetcher, calls } = scriptedFetcher([detail(5), detail(5), detail(6)])
    const store = new DetailStore(fetcher, 0)
    store.request(3)
    await settle()
    assert.equal(store.getSnapshot().detail?.rev, 5, 'the detail fold runs ahead of the legacy head')
    store.request(4)
    await settle()
    assert.equal(calls.length, 2, 'a head revision below the served detail still refetches')
    store.request(6)
    await until(() => store.getSnapshot().detail?.rev === 6, 'the head eventually overtook the detail')
    assert.equal(calls.length, 3)
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

  test('a refold ignores an old detail, absence, or failure before a new read, whether or not its timer fired', async () => {
    vi.useFakeTimers()
    for (const outcome of ['detail', 'absent', 'failure'] as const) {
      for (const timerFired of [false, true]) {
        const label = `old ${outcome} (timer fired: ${String(timerFired)})`
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
        assert.equal(calls, 1, `${label}: the reset never stacks a concurrent read`)

        if (outcome === 'failure') reject(new Error('offline'))
        else resolve(outcome === 'detail' ? detail(5) : null)
        await vi.advanceTimersByTimeAsync(0)
        assert.equal(store.getSnapshot().detail, null, `${label}: old collections must not land under the new head`)
        assert.equal(store.getSnapshot().failed, false, `${label}: old absence or failure must not fail the new generation`)
        assert.equal(store.getSnapshot().pending, true, `${label}: the new generation still needs its read`)

        await vi.advanceTimersByTimeAsync(10)
        assert.equal(calls, 2, label)
        assert.equal(store.getSnapshot().detail?.rev, 2, label)
        assert.equal(store.getSnapshot().failed, false, label)
        assert.equal(store.getSnapshot().pending, false, label)
      }
    }
    let resolveMany!: (value: ContextTimelineDetail | null) => void
    let callsMany = 0
    const firstMany = new Promise<ContextTimelineDetail | null>(res => { resolveMany = res })
    const many = new DetailStore(() => {
      callsMany++
      return callsMany === 1 ? firstMany : Promise.resolve(detail(1))
    }, 10)
    many.request(5)
    await vi.advanceTimersByTimeAsync(10)
    many.request(3)
    many.request(1)
    await vi.advanceTimersByTimeAsync(10)
    resolveMany(detail(5))
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(many.getSnapshot().detail, null)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(callsMany, 2)
    assert.equal(many.getSnapshot().detail?.rev, 1, 'several refolds during one read converge to the latest generation')
    vi.useRealTimers()
  })

  test('a transport failure with no detail arms the failed state; the backoff trailing recovers on its own', async () => {
    const { fetcher, calls } = scriptedFetcher([new Error('offline'), detail(1)])
    const store = new DetailStore(fetcher, 20)
    store.request(1)
    await until(() => store.getSnapshot().failed === true, 'the failure never surfaced')
    assert.equal(store.getSnapshot().detail, null)
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

  test('retry refires at once and a landed detail absorbs later retries', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([new Error('offline'), detail(1)])
    const store = new DetailStore(fetcher, 1000)
    store.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls.length, 1)
    assert.equal(store.getSnapshot().failed, true, 'the failure settled')
    store.retry()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1, 'the retry refetched at once')
    assert.equal(calls.length, 2)
    store.retry()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls.length, 2)
    vi.useRealTimers()
  })

  test('consecutive failures back the debounce off exponentially', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = scriptedFetcher([new Error('a'), new Error('b'), detail(1)])
    const store = new DetailStore(fetcher, 10)
    store.request(1)
    await vi.advanceTimersByTimeAsync(10)
    assert.equal(calls.length, 1, 'the first read fires after the base window')
    assert.equal(store.getSnapshot().failed, true)
    await vi.advanceTimersByTimeAsync(19)
    assert.equal(calls.length, 1, 'the trailing read waits out the doubled window')
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls.length, 2)
    await vi.advanceTimersByTimeAsync(39)
    assert.equal(calls.length, 2)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls.length, 3, 'the recovered read lands')
  })

})

describe('detailStoreOf', () => {
  beforeEach(() => { vi.useFakeTimers() })

  test('the store map stays bounded while an ACTIVE store is never dropped', async () => {
    stubDetailFetch(() => ({ body: { ok: true, value: detail(1) } }))
    const held = detailStoreOf('held')
    const off = held.subscribe(() => {})
    for (let i = 0; i < 80; i++) await visitStore(`idle-${i}`)
    assert.equal(detailStoreOf('held'), held, 'the active store keeps its identity (no forked ledger)')
    off()
    held.release()
  })

  test('one store per session, shared by every consumer; reset drops the cache', () => {
    stubDetailFetch(() => ({ body: { ok: true, value: detail(1) } }))
    const a = detailStoreOf('s1')
    assert.equal(a, detailStoreOf('s1'), 'the session key wins, the first fetcher keeps serving')
    assert.notEqual(a, detailStoreOf('s2'))
    resetTimelineDetailStores()
    assert.notEqual(detailStoreOf('s1'), a, 'a reset store is a fresh instance')
  })

  function countingFetch(): Map<string, number> {
    const calls = new Map<string, number>()
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      if (init?.body === undefined) return { ok: false, status: 404, json: async () => null }
      const id = (JSON.parse(init.body) as { sessionId: string }).sessionId
      calls.set(id, (calls.get(id) ?? 0) + 1)
      return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(1) }) }
    })
    return calls
  }

  async function visitStore(id: string): Promise<DetailStore> {
    const store = detailStoreOf(id)
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(store.hasPayload, true, `store ${id} never landed its read`)
    off()
    return store
  }

  test('the page cache bounds retained payloads; a demoted session reads again', async () => {
    const calls = countingFetch()
    const ids = Array.from({ length: 12 }, (_, i) => 'cap-' + i)
    for (const id of ids) await visitStore(id)
    assert.equal(detailStoreOf(ids[11]).hasPayload, true, 'the newest visit stays cached')
    assert.equal(detailStoreOf(ids[0]).hasPayload, false, 'the oldest visit was demoted')
    await visitStore(ids[11])
    assert.equal(calls.get(ids[11]), 1, 'a cached re-open reads nothing')
    await visitStore(ids[0])
    assert.equal(calls.get(ids[0]), 2, 'a demoted re-open reads once more')
  })

  test('a mounted store is never demoted', async () => {
    countingFetch()
    const ids = Array.from({ length: 12 }, (_, i) => 'live-' + i)
    const held = detailStoreOf(ids[0])
    const off = held.subscribe(() => {})
    held.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(held.hasPayload, true, 'the mounted store never landed')
    for (const id of ids.slice(1)) await visitStore(id)
    assert.equal(held.active, true)
    assert.equal(held.hasPayload, true, 'a mounted store keeps its payload')
    off()
  })

  test('a burst of opens is trimmed back to the bound on the next open', async () => {
    countingFetch()
    const ids = Array.from({ length: 12 }, (_, i) => 'burst-' + i)
    const offs: (() => void)[] = []
    const created = ids.map((id) => {
      const store = detailStoreOf(id)
      offs.push(store.subscribe(() => {}))
      store.request(1)
      return store
    })
    await vi.advanceTimersByTimeAsync(1000)
    for (const [i, store] of created.entries()) {
      assert.equal(store.hasPayload, true, 'burst store ' + String(i) + ' never landed')
    }
    for (const off of offs) off()
    await visitStore('burst-extra')
    assert.equal(created[0].hasPayload, false, 'the oldest burst payload is released')
    assert.equal(created[11].hasPayload, true, 'the newest burst payload survives')
    await visitStore('burst-extra-2')
    assert.equal(created[5].hasPayload, false)
    assert.equal(created[11].hasPayload, true)
  })
})

function SourceProbe(props: { sessionId: string; value?: unknown; useProjection?: (key: string) => unknown }): ReactElement {
  const useProjection = props.useProjection ?? ((key: string) => (key === 'contextTimeline' ? props.value : undefined))
  const source = useTimelineSource({
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
    let resolveSecond!: (value: ReturnType<typeof response>) => void
    let calls = 0
    const first = new Promise<ReturnType<typeof response>>(res => { resolve = res })
    const second = new Promise<ReturnType<typeof response>>(res => { resolveSecond = res })
    vi.stubGlobal('fetch', () => {
      calls++
      return calls === 1 ? first : second
    })
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: slimHead(5) }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(300) })
      await m.update(h(SourceProbe, { sessionId: 's1', value: slimHead(2) }))
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
      assert.equal(probeRead(m.container, 'state'), 'loading')
      await act(async () => {
        resolveSecond(response(detail(2)))
        await vi.advanceTimersByTimeAsync(0)
      })
      assert.equal(probeRead(m.container, 'state'), 'ready')
      assert.equal(detailStoreOf('s1').getSnapshot().detail?.rev, 2)
    } finally {
      await m.unmount()
    }
  })

  test('the inline generation passes through untouched and never fetches', async () => {
    let calls = 0
    stubDetailFetch(() => {
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
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: inline }))
    await new Promise(resolve => setTimeout(resolve, 350))
    assert.equal(probeRead(m.container, 'state'), 'legacy')
    assert.equal(probeRead(m.container, 'steps'), '1')
    assert.equal(probeRead(m.container, 'model'), 'inline-m')
    assert.equal(calls, 0, 'the inline generation never opens the detail channel')
    await act(async () => {
      ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
    })
    await m.unmount()
  })

  test('the cold start: no pushed value opens the channel itself and renders from the read', async () => {
    let resolveRead!: () => void
    vi.stubGlobal('fetch', () => new Promise(res => {
      resolveRead = () => { res({ ok: true, status: 200, json: async () => ({ ok: true, value: detail(2, { head: slimHead(2) }) }) }) }
    }))
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: undefined }))
    assert.equal(probeRead(m.container, 'state'), 'loading')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { resolveRead() })
    await until(() => probeRead(m.container, 'state') === 'ready', 'the cold read never landed')
    assert.equal(probeRead(m.container, 'model'), 'm', 'the read head renders')
    assert.equal(probeRead(m.container, 'rev'), '2')
    assert.equal(probeRead(m.container, 'steps'), '1', 'the read collections merge')
    await m.unmount()
  })

  test('a pushed head arriving after the cold read takes the channel back', async () => {
    let servedRev = 1
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ ok: true, value: detail(servedRev, { head: slimHead(servedRev, { model: servedRev === 1 ? 'cold-m' : 'pushed-m' }) }) }) }))
    let pushed: unknown = undefined
    function PushProbe(): ReactElement {
      return h(SourceProbe, {
        sessionId: 's1',
        useProjection: (key: string) => (key === 'contextTimeline' ? pushed : undefined),
      })
    }
    const m = await mount(h(PushProbe, null))
    await until(() => probeRead(m.container, 'state') === 'ready', 'the cold read never landed')
    assert.equal(probeRead(m.container, 'model'), 'cold-m')
    servedRev = 2
    pushed = slimHead(2, { model: 'pushed-m' })
    await m.update(h(PushProbe, null))
    assert.equal(probeRead(m.container, 'model'), 'pushed-m', 'the pushed head wins at once')
    assert.equal(probeRead(m.container, 'rev'), '2', 'the pushed revision renders')
    await until(() => detailStoreOf('s1').getSnapshot().detail?.rev === 2, 'the pushed head never trailed the channel')
    await m.unmount()
  })

  test('the cold read failing arms the retry affordance instead of stalling', async () => {
    let online = false
    stubDetailFetch(() => {
      if (!online) throw new Error('offline')
      return { body: { ok: true, value: detail(1, { head: slimHead(1) }) } }
    })
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: undefined }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'the cold failure never surfaced')
    assert.equal(probeRead(m.container, 'steps'), 'null')
    online = true
    await act(async () => {
      ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
    })
    await until(() => probeRead(m.container, 'state') === 'ready', 'the retry never recovered')
    await m.unmount()
  })

  test('an unrenderable cold start — headless payload, absent answer, or no session id — types the failure', async () => {
    for (const [label, body] of [
      ['headless', { ok: true, value: detail(1) }],
      ['absent', { ok: true, value: null }],
    ] as const) {
      stubDetailFetch(() => ({ body }))
      const m = await mount(h(SourceProbe, { sessionId: 's1', value: undefined }))
      await until(() => probeRead(m.container, 'state') === 'failed', `the ${label} cold start never surfaced its failure`)
      await m.unmount()
    }
    let emptyCalls = 0
    stubDetailFetch(() => {
      emptyCalls++
      return { body: { ok: true, value: detail(1, { head: slimHead(1) }) } }
    })
    const m = await mount(h(SourceProbe, { sessionId: '', value: undefined }))
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(probeRead(m.container, 'state'), 'loading', 'no session address keeps the waiting screen')
    assert.equal(emptyCalls, 0, 'no session address opens no channel')
    await m.unmount()
  })

  test('the split generation: counters render off the head immediately, the detail lands through the channel', async () => {
    let resolveRead!: () => void
    vi.stubGlobal('fetch', () => new Promise(res => {
      resolveRead = () => { res({
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          value: detail(3, {
            surfaceFloor: 2,
            archiveFloor: 5,
            fileOps: [{ seq: 2, path: 'a.ts', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }],
            fileOpsFloor: 4,
            spans: [{ kind: 'ttft', start: 0, end: 100 }, { kind: 'other', start: 100, end: 1_400 }],
          }),
        }),
      }) }
    }))
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: slimHead(3) }))
    assert.equal(probeRead(m.container, 'state'), 'loading')
    assert.equal(probeRead(m.container, 'turns'), '1', 'the head counters render before the detail lands')
    assert.equal(probeRead(m.container, 'steps'), '0', 'the collections wait for the channel')
    assert.equal(probeRead(m.container, 'floors'), 'x/x', 'no floors before the detail')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { resolveRead() })
    await until(() => probeRead(m.container, 'state') === 'ready', 'the detail never landed')
    assert.equal(probeRead(m.container, 'steps'), '1', 'the merged requests serve')
    assert.equal(probeRead(m.container, 'rev'), '3')
    assert.equal(probeRead(m.container, 'floors'), '2/5', 'the detail floors merge')
    assert.equal(probeRead(m.container, 'ops'), '1', 'the op log merges')
    assert.equal(probeRead(m.container, 'spans'), '2', 'the strip spans merge')
    await m.unmount()
  })

  test('a rev bump on the pushed head refetches the detail', async () => {
    let served = 3
    stubDetailFetch(() => ({ body: { ok: true, value: detail(served) } }))
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: slimHead(3) }))
    await until(() => probeRead(m.container, 'state') === 'ready', 'the first read never landed')
    assert.equal(detailStoreOf('s1').getSnapshot().detail?.rev, 3)
    served = 4
    await m.update(h(SourceProbe, { sessionId: 's1', value: slimHead(4) }))
    assert.equal(probeRead(m.container, 'rev'), '4')
    await until(() => detailStoreOf('s1').getSnapshot().detail?.rev === 4, 'the refetch never landed')
    await m.unmount()
  })

  test('the failed read arms the retry affordance, which refires the read', async () => {
    let online = false
    let calls = 0
    stubDetailFetch(() => {
      calls++
      if (!online) throw new Error('offline')
      return { body: { ok: true, value: detail(1) } }
    })
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: slimHead(1) }))
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
    stubDetailFetch(() => ({ body: { ok: true, value: null } }))
    const m = await mount(h(SourceProbe, { sessionId: 's1', value: slimHead(1) }))
    await until(() => probeRead(m.container, 'state') === 'failed', 'absence never surfaced')
    await m.unmount()
  })
})

describe('DetailStore — eager first read, warm-up, and the byte budget', () => {
  test('the first read starts a frame after request; later revisions keep the trailing window', async () => {
    vi.useFakeTimers()
    const { fetcher, calls } = {
      calls: [] as number[],
      fetcher: async () => { calls.push(Date.now()); return detail(calls.length) },
    }
    const store = new DetailStore(fetcher, 300, true)
    store.subscribe(() => {})
    store.request(1)
    assert.equal(store.getSnapshot().pending, true)
    await vi.advanceTimersByTimeAsync(15)
    assert.equal(calls.length, 0, 'the head frame paints before the read')
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(calls.length, 1)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    store.request(2)
    await vi.advanceTimersByTimeAsync(20)
    assert.equal(calls.length, 1, 'a landed store debounces later revisions')
    await vi.advanceTimersByTimeAsync(300)
    assert.equal(calls.length, 2)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 2)
    vi.useRealTimers()
  })

  test('warm without subscribers reads at once, refreshes a newer revision, and reports its live weight', async () => {
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(calls, { nodes: Array.from({ length: 100 }, (_, i) => ({ seq: i, cat: 'user', tokens: 1 })) }) }, 300, true)
    store.warm(1)
    await until(() => store.getSnapshot().detail?.rev === 1, 'the warm read never landed')
    assert.equal(calls, 1)
    assert.ok(store.byteSize >= detailBytesOf(detail(1)))
    assert.equal(store.active, false, 'a warm-up arms no subscriber')
    store.warm(1)
    await new Promise(resolve => setTimeout(resolve, 5))
    assert.equal(calls, 1, 'a covered revision does not reread')
    store.warm(3)
    await until(() => store.getSnapshot().detail?.rev === 2, 'the newer warm read never landed')
    assert.equal(calls, 2)
  })

  test('a monster detail is demoted against the page byte budget before the smallest cached detail', async () => {
    vi.useFakeTimers()
    const huge = detail(1, { nodes: Array.from({ length: 3_000 }, (_, i) => ({ seq: i, cat: 'user', tokens: 1 })) })
    vi.stubGlobal('fetch', async (_url: unknown, init?: { body?: string }) => {
      const id = JSON.parse(init?.body ?? '{}').sessionId as string
      return { ok: true, status: 200, json: async () => ({ ok: true, value: id.startsWith('huge') ? huge : detail(1, { nodes: [{ seq: 1, cat: 'user', tokens: 1 }] }) }) }
    })
    const small = detailStoreOf('small')
    const offSmall = small.subscribe(() => {})
    small.request(1)
    await vi.advanceTimersByTimeAsync(20)
    assert.equal(small.hasPayload, true)
    const hugeStores: DetailStore[] = []
    for (let i = 0; i < 10; i++) {
      const store = detailStoreOf('huge-' + i)
      const off = store.subscribe(() => {})
      store.request(1)
      await vi.advanceTimersByTimeAsync(20)
      off()
      hugeStores.push(store)
    }
    assert.equal(small.hasPayload, true, 'the small payload survives the budget')
    assert.ok(hugeStores.filter(store => store.hasPayload).length < hugeStores.length, 'the burst is trimmed')
    offSmall()
    vi.useRealTimers()
  })

  test('detailBytesOf weighs every served collection', () => {
    const base = detailBytesOf(detail(1))
    assert.ok(detailBytesOf(detail(1, { requests: [1, 2, 3] })) > base)
    assert.ok(detailBytesOf(detail(1, { fileOps: [{ seq: 1, path: 'a', kind: 'read', tool: 'read', err: false, added: 0, removed: 0 }] })) > base)
    assert.ok(detailBytesOf(detail(1, { commands: [{ seq: 1, time: 1, tool: 'bash', cmd: 'ls', start: 1, status: 'completed', err: false }] })) > base)
    assert.ok(detailBytesOf(detail(1, { spans: [{ kind: 'ttft', start: 0, end: 1 }] })) > base)
  })
})

describe('DetailStore — warm over an armed window', () => {
  test('warm cancels a pending trailing window and reads at once', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(1) }, 300, false)
    store.subscribe(() => {})
    store.request(1)
    assert.equal(store.getSnapshot().pending, true)
    store.warm(1)
    assert.equal(store.getSnapshot().pending, true)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 1, 'warm started the read without waiting for the 300ms window')
    await vi.advanceTimersByTimeAsync(300)
    assert.equal(calls, 1, 'the cancelled window never fires a second read')
    vi.useRealTimers()
  })
})

describe('DetailStore — warm while a read is in flight', () => {
  test('an in-flight warm does not stack a second read', async () => {
    let calls = 0
    let release!: (d: ContextTimelineDetail | null) => void
    const store = new DetailStore(() => {
      calls++
      return new Promise<ContextTimelineDetail | null>((resolve) => { release = resolve })
    }, 300, true)
    store.warm(1)
    await until(() => calls === 1, 'the first warm read never started')
    store.warm(2)
    assert.equal(calls, 1)
    release(detail(1))
    await until(() => store.getSnapshot().detail?.rev === 1, 'the first read never landed')
    assert.equal(calls, 1, 'warm during the flight stacked nothing')
  })
})

describe('DetailStore — a served revision behind the head', () => {
  test('a current lower revision lands once and waits for the next head push instead of polling', async () => {
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(1) }, 0, false)
    store.subscribe(() => {})
    store.request(2)
    await until(() => store.getSnapshot().detail?.rev === 1, 'the lower revision never landed')
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.equal(calls, 1, 'no trailing poll chases the same head revision')
    store.request(2)
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(calls, 2, 'a later request for the same head retries once')
  })

  test('a failed warm-up with no reader never retries in the background', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = new DetailStore(async () => { calls++; throw new Error('offline') }, 10, true)
    store.warm(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls, 1)
    vi.useRealTimers()
  })
})

describe('DetailStore — a failed warm-up leaves the view a clean retry', () => {
  test('a background failure resets the target so the mounted view reads again', async () => {
    let calls = 0
    const store = new DetailStore(async () => { calls++; return calls === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(detail(1)) }, 0, true)
    store.warm(1)
    await until(() => store.getSnapshot().failed, 'the warm failure never surfaced')
    const off = store.subscribe(() => {})
    store.request(1)
    await until(() => store.getSnapshot().detail?.rev === 1, 'the view never refetched after the warm failure')
    assert.equal(calls, 2)
    off()
  })
})

describe('DetailStore — one bounded catch-up', () => {
  test('a current revision behind the head gets exactly one delayed re-read', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(1) }, 0, false)
    store.subscribe(() => {})
    store.request(2)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    assert.equal(calls, 1)
    await vi.advanceTimersByTimeAsync(999)
    assert.equal(calls, 1)
    await vi.advanceTimersByTimeAsync(1)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 2, 'the catch-up read ran once')
    await vi.advanceTimersByTimeAsync(5_000)
    assert.equal(calls, 2, 'a second short answer is not polled')
    vi.useRealTimers()
  })

  test('a newer head resets the one-shot and a catch-up that reaches the target stops', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(calls === 1 ? 1 : 3) }, 0, false)
    store.subscribe(() => {})
    store.request(2)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    store.request(3)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 3, 'the new head target is served')
    await vi.advanceTimersByTimeAsync(2_000)
    assert.equal(calls, 2)
    vi.useRealTimers()
  })
})

describe('DetailStore — catch-up and store-map edges', () => {
  test('a catch-up timer that finds the target already served does not read again', async () => {
    vi.useFakeTimers()
    let calls = 0
    const store = new DetailStore(async () => { calls++; return detail(calls === 1 ? 1 : 2) }, 0, false)
    store.subscribe(() => {})
    store.request(2)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    store.warm(2)
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 2)
    await vi.advanceTimersByTimeAsync(2_000)
    assert.equal(calls, 2, 'the armed catch-up found the target already served')
    vi.useRealTimers()
  })

  test('the store-map trim never drops the store it is returning', () => {
    resetTimelineDetailStores()
    const offs: Array<() => void> = []
    for (let i = 0; i < 64; i++) {
      const store = detailStoreOf('active-' + i)
      offs.push(store.subscribe(() => {}))
    }
    const current = detailStoreOf('returned')
    assert.equal(detailStoreOf('returned'), current)
    for (const off of offs) off()
    resetTimelineDetailStores()
  })
})
