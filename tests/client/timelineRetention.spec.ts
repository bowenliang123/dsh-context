import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { invalidate } from '../../src/client/invalidation'
import type { ContextTimelineDetail } from '../../src/shared/types'
import { DetailStore, detailStoreOf, resetTimelineDetailStores, useTimelineSource } from '../../src/client/timelineSource'
import { mount, text, until } from './helpers/kit'

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

function RetentionProbe(props: { sessionId?: string; value?: unknown; useProjection?: (key: string) => unknown }): ReactElement {
  const useProjection = props.useProjection ?? ((key: string) => (key === 'contextTimeline' ? props.value : undefined))
  const source = useTimelineSource({ sessionId: props.sessionId, useProjection })
  const data = source.data
  return h('div', null,
    h('span', { 'data-k': 'state' }, source.detailState),
    h('span', { 'data-k': 'cost' }, String(data?.costRead?.usd ?? 'x')),
    h('span', { 'data-k': 'cmds' }, String(data?.commands?.length ?? 'x')),
    h('button', { 'data-k': 'retry', onClick: source.retryDetail }, 'retry'),
    h('button', { 'data-k': 'part', onClick: () => source.ensurePart('nodes') }, 'part'))
}

function probeRead(container: HTMLElement, key: string): string {
  return text(container.querySelector(`[data-k="${key}"]`) as HTMLElement)
}

afterEach(() => {
  resetTimelineDetailStores()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
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

  test('payload growth is trimmed as it lands, without waiting for the next open', async () => {
    countingFetch()
    const ids = Array.from({ length: 12 }, (_, i) => 'burst-' + i)
    const created: DetailStore[] = []
    for (const id of ids) {
      const store = detailStoreOf(id)
      const off = store.subscribe(() => {})
      store.request(1)
      await vi.advanceTimersByTimeAsync(1000)
      off()
      created.push(store)
    }
    assert.equal(created.filter(store => store.hasPayload).length, 8, 'the payload slot bound holds right after the burst')
    assert.equal(created[0].hasPayload, false, 'the oldest payload was released as a newer one landed')
    assert.equal(created[11].hasPayload, true, 'the newest payload stays')
    await visitStore('burst-extra')
    assert.equal(created.filter(store => store.hasPayload).length, 7, 'the next open makes room for its own payload')
    assert.equal(created[11].hasPayload, true)
  })
})


describe('detailStoreOf — pricing invalidation', () => {
  beforeEach(() => { vi.useFakeTimers() })

  test('pricing readiness refetches an active store at the same revision and adopts costRead', async () => {
    let calls = 0
    stubDetailFetch(() => {
      calls++
      const head = calls === 1 ? slimHead(1) : { ...slimHead(1), costRead: { usd: 1.5, ready: true } }
      return { body: { ok: true, value: detail(1, { head }) } }
    })
    const store = detailStoreOf('priced')
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(store.getSnapshot().detail?.head?.costRead, undefined)
    invalidate('pricing')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 2, 'the active store refetched for the ready price catalog')
    assert.equal(store.getSnapshot().detail?.head?.costRead?.usd, 1.5)
    invalidate('fleet')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 2, 'another invalidation kind leaves the detail alone')
    off()
  })

  test('pricing readiness releases an inactive payload and its next open re-reads', async () => {
    let calls = 0
    stubDetailFetch(() => {
      calls++
      return { body: { ok: true, value: detail(1) } }
    })
    const store = detailStoreOf('cold-priced')
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(store.hasPayload, true)
    off()
    assert.equal(store.hasPayload, true, 'parking keeps the payload for a quick reopen')
    invalidate('pricing')
    assert.equal(store.hasPayload, false, 'the stale cost-less payload is dropped')
    const again = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(1000)
    assert.equal(calls, 2)
    assert.equal(store.hasPayload, true)
    again()
  })

  test('pricing readiness cancels an armed debounce and reads once', async () => {
    let calls = 0
    stubDetailFetch(() => {
      calls++
      return { body: { ok: true, value: detail(1) } }
    })
    const store = detailStoreOf('timer-priced')
    const off = store.subscribe(() => {})
    store.request(1)
    assert.equal(calls, 0, 'the debounce window is armed')
    invalidate('pricing')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 1)
    await vi.advanceTimersByTimeAsync(1_000)
    assert.equal(calls, 1, 'the cancelled window never fires a second read')
    off()
  })

  test('pricing readiness does not stack a read over an in-flight one', async () => {
    let calls = 0
    let release!: () => void
    vi.stubGlobal('fetch', () => {
      calls++
      return new Promise((resolve) => {
        release = () => resolve({ ok: true, status: 200, json: async () => ({ ok: true, value: detail(1) }) })
      })
    })
    const store = detailStoreOf('racing-priced')
    const off = store.subscribe(() => {})
    store.request(1)
    await vi.advanceTimersByTimeAsync(300)
    assert.equal(calls, 1)
    invalidate('pricing')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(calls, 1, 'the in-flight core read is not duplicated')
    release()
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().detail?.rev, 1)
    off()
  })

  test('pricing readiness settles a session with no fetcher as failed', async () => {
    const store = detailStoreOf('')
    const off = store.subscribe(() => {})
    invalidate('pricing')
    await vi.advanceTimersByTimeAsync(0)
    assert.equal(store.getSnapshot().failed, true)
    off()
  })
})

describe('useTimelineSource — retention wiring', () => {
  test('a session-less mount stays loading, opens no channel, and ships the noops', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls++
      return { ok: true, status: 200, json: async () => ({ ok: true, value: detail(1) }) }
    })
    const m = await mount(h(RetentionProbe, {}))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 350)) })
    try {
      assert.equal(probeRead(m.container, 'state'), 'loading')
      assert.equal(calls, 0)
      await act(async () => {
        ;(m.container.querySelector('[data-k="part"]') as HTMLElement).click()
        ;(m.container.querySelector('[data-k="retry"]') as HTMLElement).click()
      })
      assert.equal(calls, 0)
    } finally {
      await m.unmount()
    }
  })

  test('the detail head costRead fills a cost-less projection head; commands merge through', async () => {
    stubDetailFetch(() => ({
      body: {
        ok: true,
        value: detail(1, {
          head: { ...slimHead(1), costRead: { usd: 2.5, ready: true } },
          commands: [{ seq: 1, time: 0, tool: 'bash', cmd: 'ls', start: 0, status: 'completed', err: false }],
          commandsFloor: 1,
          commandStats: { runs: 1, failed: 0, ms: 1, bg: 0 },
        }),
      },
    }))
    const m = await mount(h(RetentionProbe, { sessionId: 's1', value: slimHead(1) }))
    try {
      await until(() => probeRead(m.container, 'state') === 'ready', 'the detail never landed')
      assert.equal(probeRead(m.container, 'cost'), '2.5')
      assert.equal(probeRead(m.container, 'cmds'), '1')
    } finally {
      await m.unmount()
    }
  })

  test('the fresher costRead carried by the served detail head wins over the projection copy', async () => {
    stubDetailFetch(() => ({
      body: {
        ok: true,
        value: detail(1, { head: { ...slimHead(1), costRead: { usd: 2.5, ready: true } } }),
      },
    }))
    const m = await mount(h(RetentionProbe, { sessionId: 's1', value: { ...slimHead(1), costRead: { usd: 9, ready: true } } }))
    try {
      await until(() => probeRead(m.container, 'state') === 'ready', 'the detail never landed')
      assert.equal(probeRead(m.container, 'cost'), '2.5')
    } finally {
      await m.unmount()
    }
  })
})
