import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, test, vi } from 'vitest'
import { invalidate } from '../../src/client/invalidation'
import { type ContextTimelineDetail } from '../../src/shared/types'
import { DetailStore, detailStoreOf, resetTimelineDetailStores, useTimelineSource } from '../../src/client/timelineSource'
import { mount, text, until, makeKit, query } from './helpers/kit'
import { revealInScrollParent, revealRowInCard, scrollIntoViewIfPossible, scrollToPos, settleReveal } from '../../src/client/revealScroll'
import { DICT_EN, DICT_ZH } from '../../src/client/i18n'
import { makeAgentHeads } from '../../src/client/agentHeads'
import { makeContextView } from '../../src/client/components/contextView'
import { createContextSettings } from '../../src/client/settings'
import { SIDEBAR_CONTEXT_ID, SIDEBAR_CONTEXT_KIND, watchSidebarContextTab } from '../../src/client/sidebar'
import { type ContextViewProps, type SidebarTabDefinitionLike } from '../../src/client/services'
import { TestClientCtx, asClientCtx } from './helpers/harness'

describe('timelineRetention', () => {

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
})

describe('revealScroll', () => {

const top = (t: number): DOMRect => ({ top: t }) as DOMRect

afterEach(() => {
  vi.unstubAllGlobals()
})

function queueFrames(): { flush: () => void } {
  const frames: FrameRequestCallback[] = []
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  })
  return {
    flush: (): void => {
      while (frames.length > 0) frames.shift()?.(0)
    },
  }
}

function spyScrollTo(el: HTMLElement): ScrollToOptions[] {
  const calls: ScrollToOptions[] = []
  Object.defineProperty(el, 'scrollTo', {
    value: (options?: ScrollToOptions): void => {
      if (options !== undefined) calls.push(options)
    },
  })
  return calls
}

function stubReducedMotion(reduced: boolean | 'throw'): void {
  vi.stubGlobal('matchMedia', (query: string) => {
    if (query !== '(prefers-reduced-motion: reduce)') throw new Error('unexpected query')
    if (reduced === 'throw') throw new Error('boom')
    return { matches: reduced }
  })
}

function mounted(oy: 'auto' | 'scroll', scrollerTop: number, anchorTop: number): { scroller: HTMLDivElement; anchor: HTMLDivElement } {
  const scroller = document.createElement('div')
  scroller.style.overflowY = oy
  Object.defineProperty(scroller, 'scrollHeight', { value: 500 })
  Object.defineProperty(scroller, 'clientHeight', { value: 200 })
  scroller.getBoundingClientRect = () => top(scrollerTop)
  const anchor = document.createElement('div')
  anchor.getBoundingClientRect = () => top(anchorTop)
  scroller.appendChild(anchor)
  document.body.appendChild(scroller)
  return { scroller, anchor }
}

describe('revealInScrollParent', () => {
  test("scrolls the nearest 'auto' or 'scroll' ancestor so the anchor tops its scrollport; a grow-with-content box is skipped", () => {
    const auto = mounted('auto', 100, 450)
    auto.scroller.scrollTop = 42
    assert.equal(revealInScrollParent(auto.anchor), true)
    assert.equal(auto.scroller.scrollTop, 392, 'the rect delta lands the anchor flush: 42 + (450 − 100)')
    auto.scroller.remove()

    const scroll = mounted('scroll', 0, 200)
    assert.equal(revealInScrollParent(scroll.anchor), true)
    assert.equal(scroll.scroller.scrollTop, 200)
    scroll.scroller.remove()

    const grown = mounted('auto', 0, 300)
    const inner = document.createElement('div')
    inner.style.overflowY = 'auto'
    Object.defineProperty(inner, 'scrollHeight', { value: 300 })
    Object.defineProperty(inner, 'clientHeight', { value: 300 })
    inner.appendChild(grown.anchor)
    grown.scroller.appendChild(inner)
    assert.equal(revealInScrollParent(grown.anchor), true)
    assert.equal(grown.scroller.scrollTop, 300, 'the real scroller above takes the delta')
    grown.scroller.remove()
  })

  test('with a live scrollTo the delta is applied through it as a smooth scroll, leaving scrollTop untouched', () => {
    const auto = mounted('auto', 100, 450)
    auto.scroller.scrollTop = 42
    const calls = spyScrollTo(auto.scroller)
    assert.equal(revealInScrollParent(auto.anchor), true)
    assert.deepEqual(calls, [{ top: 392, left: undefined, behavior: 'smooth' }])
    assert.equal(auto.scroller.scrollTop, 42)
    auto.scroller.remove()
  })

  test('reduced motion downgrades the smooth scroll to an instant one, and a throwing matchMedia keeps it smooth', () => {
    stubReducedMotion(true)
    const reduced = mounted('auto', 0, 260)
    const reducedCalls = spyScrollTo(reduced.scroller)
    assert.equal(revealInScrollParent(reduced.anchor), true)
    assert.deepEqual(reducedCalls, [{ top: 260, left: undefined, behavior: 'instant' }])
    reduced.scroller.remove()

    stubReducedMotion('throw')
    const noisy = mounted('auto', 0, 260)
    const noisyCalls = spyScrollTo(noisy.scroller)
    assert.equal(revealInScrollParent(noisy.anchor), true)
    assert.deepEqual(noisyCalls, [{ top: 260, left: undefined, behavior: 'smooth' }])
    noisy.scroller.remove()
  })

  test('a plain ancestor chain to body, a detached anchor, and a hostile chain all report false without throwing', () => {
    const plain = document.createElement('div')
    document.body.appendChild(plain)
    assert.equal(revealInScrollParent(plain), false)
    plain.remove()
    assert.equal(revealInScrollParent(document.createElement('div')), false)
    const hostile = {
      get parentElement(): never { throw new Error('boom') },
    } as unknown as Element
    assert.equal(revealInScrollParent(hostile), false)
  })
})

describe('revealRowInCard', () => {
  const rect = (t: number, b: number): DOMRect => ({ top: t, bottom: b }) as DOMRect

  function mounted(rowTop: number, rowBottom: number, regionOverflow = true): {
    page: HTMLDivElement; card: HTMLDivElement; region: HTMLDivElement; row: HTMLDivElement
  } {
    const page = document.createElement('div')
    const card = document.createElement('div')
    const region = document.createElement('div')
    const row = document.createElement('div')
    region.appendChild(row)
    card.appendChild(region)
    page.appendChild(card)
    document.body.appendChild(page)
    Object.defineProperty(region, 'scrollHeight', { value: regionOverflow ? 600 : 300 })
    Object.defineProperty(region, 'clientHeight', { value: regionOverflow ? 200 : 300 })
    region.getBoundingClientRect = () => rect(0, 200)
    row.getBoundingClientRect = () => rect(rowTop, rowBottom)
    region.scrollTop = 30
    page.scrollTop = 55
    return { page, card, region, row }
  }

  test('a row above or below the visible slice scrolls the rows region to it; a fully visible row scrolls nothing', () => {
    const above = mounted(-10, 20)
    revealRowInCard(above.region.parentElement, above.row)
    assert.equal(above.region.scrollTop, 20, 'the row reaches the slice top: 30 − (0 − (−10))')
    assert.equal(above.page.scrollTop, 55, 'nothing above the card moves')
    const below = mounted(250, 280)
    revealRowInCard(below.region.parentElement, below.row)
    assert.equal(below.region.scrollTop, 110, 'the row reaches the slice bottom: 30 + (280 − 200)')

    const visible = mounted(10, 60)
    revealRowInCard(visible.region.parentElement, visible.row)
    assert.equal(visible.region.scrollTop, 30)
    assert.equal(visible.page.scrollTop, 55)
  })

  test('with a live scrollTo the adjustment rides through it as a smooth scroll', () => {
    const above = mounted(-10, 20)
    const calls = spyScrollTo(above.region)
    revealRowInCard(above.region.parentElement, above.row)
    assert.deepEqual(calls, [{ top: 20, left: undefined, behavior: 'smooth' }])
    assert.equal(above.region.scrollTop, 30)
    assert.equal(above.page.scrollTop, 55)
  })

  test('a region that does not overflow ends the walk at the card; a null card, null row, or outside row does nothing', () => {
    const still = mounted(250, 280, false)
    revealRowInCard(still.card, still.row)
    assert.equal(still.region.scrollTop, 30)
    assert.equal(still.card.scrollTop, 0)
    assert.equal(still.page.scrollTop, 55)

    const { card, row } = mounted(0, 10)
    const stranger = document.createElement('div')
    document.body.appendChild(stranger)
    assert.doesNotThrow(() => {
      revealRowInCard(null, row)
      revealRowInCard(card, null)
      revealRowInCard(card, stranger)
    })
    stranger.remove()
  })

})

function box(): HTMLDivElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'scrollTop', { value: 10, writable: true })
  Object.defineProperty(el, 'scrollLeft', { value: 20, writable: true })
  return el
}

describe('scrollToPos', () => {
  test('without scrollTo the top and left land as direct assignments, each axis only when present', () => {
    const both = box()
    scrollToPos(both, { top: 300, left: 90 })
    assert.equal(both.scrollTop, 300)
    assert.equal(both.scrollLeft, 90)

    const topOnly = box()
    scrollToPos(topOnly, { top: 44 })
    assert.equal(topOnly.scrollTop, 44)
    assert.equal(topOnly.scrollLeft, 20)

    const leftOnly = box()
    scrollToPos(leftOnly, { left: 44 })
    assert.equal(leftOnly.scrollTop, 10)
    assert.equal(leftOnly.scrollLeft, 44)
  })

  test('with a live scrollTo one call carries both axes and the default smooth behavior', () => {
    const el = box()
    const calls = spyScrollTo(el)
    scrollToPos(el, { top: 300, left: 90 })
    assert.deepEqual(calls, [{ top: 300, left: 90, behavior: 'smooth' }])
    assert.equal(el.scrollTop, 10)
    assert.equal(el.scrollLeft, 20)
  })

  test('an explicit behavior passes through; reduced motion downgrades smooth, and a throwing matchMedia does not', () => {
    const el = box()
    const calls = spyScrollTo(el)
    scrollToPos(el, { top: 1 }, 'instant')
    assert.deepEqual(calls, [{ top: 1, left: undefined, behavior: 'instant' }])

    stubReducedMotion(true)
    scrollToPos(el, { top: 2 })
    assert.deepEqual(calls[1], { top: 2, left: undefined, behavior: 'instant' })

    stubReducedMotion('throw')
    scrollToPos(el, { top: 3 })
    assert.deepEqual(calls[2], { top: 3, left: undefined, behavior: 'smooth' })
  })
})

describe('scrollIntoViewIfPossible', () => {
  test('a null element or one without the verb is a no-op; the live verb receives the options', () => {
    const bare = document.createElement('div')
    Object.defineProperty(bare, 'scrollIntoView', { value: undefined })
    assert.doesNotThrow(() => {
      scrollIntoViewIfPossible(null)
      scrollIntoViewIfPossible(bare)
    })
    const calls: (ScrollIntoViewOptions | undefined)[] = []
    const el = document.createElement('div')
    el.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { calls.push(options as ScrollIntoViewOptions | undefined) }
    scrollIntoViewIfPossible(el, { block: 'nearest', behavior: 'smooth' })
    assert.deepEqual(calls, [{ block: 'nearest', behavior: 'smooth' }])
  })

  test('reduced motion rewrites a requested smooth scroll into an instant one, keeping the rest of the options', () => {
    stubReducedMotion(true)
    const calls: (ScrollIntoViewOptions | undefined)[] = []
    const el = document.createElement('div')
    el.scrollIntoView = (options?: boolean | ScrollIntoViewOptions) => { calls.push(options as ScrollIntoViewOptions | undefined) }
    scrollIntoViewIfPossible(el, { block: 'center', inline: 'center', behavior: 'smooth' })
    assert.deepEqual(calls, [{ block: 'center', inline: 'center', behavior: 'instant' }])
  })
})

describe('settleReveal', () => {
  test('issues the alignment once, waits out the glide, then re-checks once from the settled position', () => {
    const { flush } = queueFrames()
    const el = box()
    const issues: number[] = []
    const align = vi.fn((): boolean => {
      issues.push(el.scrollTop)
      if (issues.length === 1) {
        el.scrollTop = 300
        return true
      }
      return false
    })
    settleReveal(el, align)
    flush()
    assert.equal(align.mock.calls.length, 2, 'one issue and one settled re-check')
    assert.equal(el.scrollTop, 300)
  })

  test('an alignment already in place gets one settled re-check and stops without issuing', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => false)
    settleReveal(el, align)
    flush()
    assert.equal(align.mock.calls.length, 2)
    assert.equal(el.scrollTop, 10)
  })

  test('a stubborn alignment keeps re-issuing only up to the budget', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => true)
    settleReveal(el, align, 5)
    flush()
    assert.equal(align.mock.calls.length, 5)
  })

  test('a newer run on the same element supersedes the older loop', () => {
    const { flush } = queueFrames()
    const el = box()
    const first = vi.fn((): boolean => true)
    const second = vi.fn((): boolean => false)
    settleReveal(el, first)
    settleReveal(el, second)
    flush()
    assert.equal(first.mock.calls.length, 1, 'the superseded loop never frames again')
    assert.equal(second.mock.calls.length, 2)
  })

  test('user input on the scroller cancels the settle loop', () => {
    const { flush } = queueFrames()
    const el = box()
    const align = vi.fn((): boolean => true)
    settleReveal(el, align)
    el.dispatchEvent(new Event('wheel'))
    flush()
    assert.equal(align.mock.calls.length, 1)
  })
})
})

describe('sidebar', () => {

const NS = 'dsh-context'

function registry(): { definitions: SidebarTabDefinitionLike[]; disposed: number; register: (d: SidebarTabDefinitionLike) => () => void } {
  const rec = {
    definitions: [] as SidebarTabDefinitionLike[],
    disposed: 0,
    register: (definition: SidebarTabDefinitionLike): (() => void) => {
      rec.definitions.push(definition)
      return () => { rec.disposed += 1 }
    },
  }
  return rec
}

function wire(ctx: TestClientCtx, view: (props: ContextViewProps) => unknown = props => props): void {
  const t = ctx.locale.bind(NS)
  watchSidebarContextTab(asClientCtx(ctx), view, t, NS)
}

describe('watchSidebarContextTab — the optional registration', () => {
  test('a harness without the sidebar registry registers nothing until the registry arms (deferred inject)', () => {
    const ctx = new TestClientCtx()
    wire(ctx)
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    assert.equal(tabs.definitions.length, 1)
    assert.equal(ctx.slots.of('sidebar.right.pane.tab').length, 1)
    ctx.dispose()
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
  })

  test('registers the type, the body and chip-title seats, and the guide fields it supplies; unload unwinds them', async () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)

    const def = tabs.definitions[0]
    assert.equal(def.id, SIDEBAR_CONTEXT_ID)
    assert.equal(def.kind, SIDEBAR_CONTEXT_KIND, 'the kind is namespaced so a foreign `context` cannot collide')
    assert.equal(def.title(), 'Context')
    assert.equal(def.guide?.length, 1)
    assert.equal(def.guide?.[0].id, SIDEBAR_CONTEXT_ID, 'the guide entry carries the stable entry identity')
    assert.equal(def.guide?.[0].order, 20, 'after the shipped Files entry (order 10)')
    assert.equal(def.guide?.[0].title(), 'Context')
    assert.equal(def.guide?.[0].description?.(), DICT_EN['sidebar.guideDescription'])
    assert.equal(typeof def.guide?.[0].icon, 'function', 'the guide capsule carries the bundled emblem')

    const body = ctx.slots.of('sidebar.right.pane.tab')
    assert.equal(body.length, 1)
    assert.equal(body[0].registration.key, SIDEBAR_CONTEXT_ID, 'the keyed seat dispatches on the type id')
    assert.equal(body[0].registration.locale, NS, 'the framework synthesizes the t seat for the panel')

    const title = ctx.slots.of('sidebar.right.pane.tab.title')
    assert.equal(title.length, 1, 'the chip-title seat is registered for the type')
    assert.equal(title[0].registration.key, SIDEBAR_CONTEXT_ID)

    const m = await mount(h(title[0].component as () => ReactElement))
    assert.equal(query<SVGSVGElement>(m.container, 'svg').getAttribute('width'), '16')
    assert.equal(text(m.container), 'Context')
    await m.unmount()

    ctx.dispose()
    assert.equal(tabs.disposed, 1, 'the type registration was disposed')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'the body seat was disposed')
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab.title'), [], 'the chip-title seat was disposed')
  })

  test('the labels follow the active locale at call time', () => {
    const ctx = new TestClientCtx({ locale: 'zh' })
    ctx.locale.register(NS, { zh: DICT_ZH, en: DICT_EN })
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    wire(ctx)
    assert.equal(tabs.definitions[0].title(), '上下文')
    assert.equal(tabs.definitions[0].guide?.[0].title(), '上下文')
    assert.equal(tabs.definitions[0].guide?.[0].description?.(), DICT_ZH['sidebar.guideDescription'])
    ctx.dispose()
  })

  test('the body renders the injected view with the seat props and the sidebar host marker', () => {
    const ctx = new TestClientCtx()
    const seen: ContextViewProps[] = []
    const view = (props: ContextViewProps): string => {
      seen.push(props)
      return 'context-view'
    }
    ctx.setService('sidebarRightTabs', registry())
    wire(ctx, view)
    const component = ctx.slots.of('sidebar.right.pane.tab')[0].component
    const props = { sessionId: 's-1', useProjection: () => undefined }
    assert.equal(component(props), 'context-view')
    assert.equal(seen.length, 1)
    assert.notEqual(seen[0], props, 'the marker rides a copy, never the seat object')
    assert.equal(seen[0].sessionId, 's-1')
    assert.equal(seen[0].useProjection, props.useProjection, 'the standard kit survives the spread')
    assert.equal(seen[0].host, 'sidebar', 'the panel host marker')
    ctx.dispose()
  })

  test('the real Context view through this seat keeps the Agent Network card inline', async () => {
    const snapshot = { byId: { 's-1': { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
    const ctx = new TestClientCtx({
      services: {
        sessions: {
          list: {
            getSnapshot: (): unknown => snapshot,
            subscribe: (): (() => void) => () => {},
          },
        },
      },
    })
    ctx.setService('sidebarRightTabs', registry())
    const view = makeContextView(asClientCtx(ctx), makeKit(), createContextSettings(), makeAgentHeads())
    wire(ctx, view)
    const component = ctx.slots.of('sidebar.right.pane.tab')[0].component
    const m = await mount(component({
      sessionId: 's-1',
      useProjection: (key: string) => (key === 'contextTimeline'
        ? { ok: true, current: { system: 10, tools: 20, user: 30, inject: 0, skill: 0, assistant: 0, tool: 0, total: 60 }, requests: [], events: [], nodes: [], droppedNodes: 0, archive: [] }
        : undefined),
    }) as ReactElement)
    assert.ok(query(m.container, '.lc-agents') !== null, 'the panel keeps the family card')
    assert.ok(text(m.container).includes(DICT_EN['agents.solo']), 'and renders it with real data')
    await m.unmount()
    ctx.dispose()
  })

  test('a throwing registry is swallowed: the plugin keeps its other seats', () => {
    const ctx = new TestClientCtx()
    ctx.setService('sidebarRightTabs', {
      register: () => { throw new Error('id already registered') },
    })
    assert.doesNotThrow(() => { wire(ctx) })
    assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [], 'no body seat without a type')
    ctx.dispose()
  })

  test('a failure mid-registration unwinds the seats that already landed', () => {
    const ctx = new TestClientCtx()
    const tabs = registry()
    ctx.setService('sidebarRightTabs', tabs)
    let calls = 0
    ;(ctx as unknown as { slots: unknown }).slots = {
      inject: (_name: string, callback: () => unknown) => {
        calls += 1
        if (calls === 2) throw new Error('title seat unavailable')
        return callback()
      },
      register: () => () => {},
    }
    assert.doesNotThrow(() => { wire(ctx) })
    assert.equal(tabs.disposed, 1, 'the type registration was rolled back')
    ctx.dispose()
  })

  test('a shapeless service (no register, a primitive) registers nothing', () => {
    for (const service of [{}, 'registry', 7, null]) {
      const ctx = new TestClientCtx()
      ctx.setService('sidebarRightTabs', service)
      assert.doesNotThrow(() => { wire(ctx) })
      assert.deepEqual(ctx.slots.of('sidebar.right.pane.tab'), [])
      ctx.dispose()
    }
  })

  test('a foreign slots face returning no disposer is tolerated on unload', () => {
    const ctx = new TestClientCtx()
    ctx.setService('sidebarRightTabs', registry())
    ;(ctx as unknown as { slots: unknown }).slots = {
      inject: () => undefined,
      register: () => () => {},
    }
    wire(ctx)
    assert.doesNotThrow(() => { ctx.dispose() })
  })
})
})
