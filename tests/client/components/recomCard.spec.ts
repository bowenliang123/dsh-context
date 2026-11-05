import assert from 'node:assert/strict'
import { act, createElement as h } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import { makeRecomCard, resetRecomCache } from '../../../src/client/components/recomCard'
import { DEFAULT_RECOM, type Recom } from '../../../src/shared/recoms'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, query, text } from '../helpers/kit'

function remoteRecom(): Recom {
  return {
    ...DEFAULT_RECOM,
    id: 'remote',
    name: 'Remote Model',
    slogan: { en: 'Remote slogan', zh: '远端标语' },
    promotion: { en: 'Remote promotion', zh: '远端推广' },
    tooltip: { en: 'Remote tooltip', zh: '远端说明' },
  }
}

function secondRecom(): Recom {
  return { ...remoteRecom(), id: 'second', name: 'Second Model' }
}

function reply(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function pendingRequest(): { calls: number; release(value: Response): void } {
  let release!: (value: Response) => void
  const request = { calls: 0, release: (value: Response) => { release(value) } }
  vi.stubGlobal('fetch', () => {
    request.calls++
    return new Promise<Response>((resolve) => { release = resolve })
  })
  return request
}

function card(locale: 'en' | 'zh'): () => ReturnType<ReturnType<typeof makeRecomCard>> {
  const ctx = new TestClientCtx({ locale })
  return makeRecomCard(makeKit(locale), asClientCtx(ctx))
}

afterEach(() => {
  resetRecomCache()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('RecomCard', () => {
  test('the default paints immediately, then the validated remote pool replaces it', async () => {
    let release!: (value: Response) => void
    const pending = new Promise<Response>((resolve) => { release = resolve })
    const calls: { url: string; init?: RequestInit }[] = []
    vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
      calls.push({ url, init })
      return pending
    })
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    assert.ok(m.container.querySelector('.lc-card-title') === null)
    assert.ok(m.container.querySelector('.lc-recom-link > .lc-recom-arrow') !== null)
    assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.en))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    release(reply({ ok: true, value: [remoteRecom()], degraded: false }))
    await flush()
    assert.ok(text(m.container).includes('Remote Model'))
    assert.ok(text(m.container).includes('Remote slogan'))
    assert.ok(text(m.container).includes('Remote promotion'))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    const tooltip = query(m.container, '[role="tooltip"]')
    assert.equal(tooltip.textContent, 'Remote tooltip')
    const link = query<HTMLAnchorElement>(m.container, 'a')
    assert.equal(link.href, DEFAULT_RECOM.url)
    assert.equal(link.target, '_blank')
    assert.equal(link.rel, 'noreferrer')
    assert.equal(link.getAttribute('aria-describedby'), query(m.container, '[role="tooltip"]').id)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.url, 'api/dsh-context/recom')
    assert.equal(calls[0]?.init?.method, 'POST')
    assert.equal(calls[0]?.init?.body, '{}')
    assert.equal(query<HTMLImageElement>(m.container, 'img').src, DEFAULT_RECOM.icon)
    await m.unmount()
  })

  test('Chinese content renders locally and HTTP or payload failures preserve the default', async () => {
    const responses = [
      reply({}, false),
      reply({ ok: true, value: { bad: true } }),
      { ok: true, json: () => Promise.reject(new Error('bad json')) } as unknown as Response,
    ]
    for (const response of responses) {
      vi.stubGlobal('fetch', async () => response)
      const RecomCard = card('zh')
      const m = await mount(h(RecomCard))
      await flush()
      assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.zh))
      assert.equal(query(m.container, '[role="tooltip"]').textContent, DEFAULT_RECOM.tooltip.zh)
      assert.ok(m.container.querySelector('.lc-recom-degraded') !== null)
      await m.unmount()
    }
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const RecomCard = card('zh')
    const m = await mount(h(RecomCard))
    await flush()
    assert.ok(text(m.container).includes(DEFAULT_RECOM.promotion.zh))
    await m.unmount()
  })

  test('the brand initial covers icon states and a settled pool survives unmount', async () => {
    const request = pendingRequest()
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    const mark = query(m.container, '.lc-recom-mark')
    assert.equal(mark.querySelector('.lc-recom-fallback')?.textContent, 'D')
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('load'))
    })
    assert.ok(mark.classList.contains('lc-recom-mark-loaded'))
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('error'))
    })
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    assert.ok(mark.querySelector('img') === null)
    await m.unmount()
    request.release(reply({ ok: true, value: [remoteRecom()] }))
    await flush()
    assert.equal(m.container.isConnected, false)
    const second = await mount(h(RecomCard))
    assert.ok(text(second.container).includes('Remote Model'))
    assert.equal(request.calls, 1)
    await second.unmount()
  })

  test('the first pool picks randomly and later mounts rotate immediately with one fetch', async () => {
    const request = pendingRequest()
    vi.spyOn(Math, 'random').mockReturnValue(0.99)
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    assert.ok(text(first.container).includes(DEFAULT_RECOM.name))
    request.release(reply({ ok: true, value: [remoteRecom(), secondRecom()], degraded: false }))
    await flush()
    assert.ok(text(first.container).includes('Second Model'))
    await first.unmount()
    const second = await mount(h(RecomCard))
    assert.ok(text(second.container).includes('Remote Model'), 'the next entry paints synchronously')
    await second.unmount()
    const third = await mount(h(RecomCard))
    assert.ok(text(third.container).includes('Second Model'), 'rotation wraps within the cached pool')
    await third.unmount()
    assert.equal(request.calls, 1)
  })

  test('concurrent first mounts share the same pool request', async () => {
    const request = pendingRequest()
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    const second = await mount(h(RecomCard))
    request.release(reply({ ok: true, value: [remoteRecom()] }))
    await flush()
    assert.ok(text(first.container).includes('Remote Model'))
    assert.ok(text(second.container).includes('Remote Model'))
    assert.equal(request.calls, 1)
    await first.unmount()
    await second.unmount()
  })

  test('reset during a pending read keeps a later request shared and independent', async () => {
    const releases: ((value: Response) => void)[] = []
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { releases.push(resolve) }))
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    resetRecomCache()
    const second = await mount(h(RecomCard))
    assert.equal(releases.length, 2)
    releases[0](reply({}, false))
    await flush()
    const third = await mount(h(RecomCard))
    assert.equal(releases.length, 2, 'the stale cleanup leaves the newer request in flight')
    releases[1](reply({ ok: true, value: [secondRecom()] }))
    await flush()
    assert.ok(text(second.container).includes('Second Model'))
    assert.ok(text(third.container).includes('Second Model'))
    await first.unmount()
    await second.unmount()
    await third.unmount()
  })

  test('an identical initial selection leaves the painted card untouched', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: [DEFAULT_RECOM] }))
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    await flush()
    assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.en))
    assert.ok(text(m.container).includes(DEFAULT_RECOM.promotion.en))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    await m.unmount()
  })

  test('a degraded pool paints its mark at once and a later mount retries', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: [DEFAULT_RECOM], degraded: true }))
    const RecomCard = card('zh')
    const first = await mount(h(RecomCard))
    await flush()
    assert.equal(query(first.container, '.lc-recom-brand').textContent, 'DeepSeek')
    assert.ok(first.container.querySelector('.lc-recom-degraded') !== null)
    await first.unmount()
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { release = resolve }))
    const second = await mount(h(RecomCard))
    assert.ok(second.container.querySelector('.lc-recom-degraded') !== null, 'the cached degrade paints at once')
    release(reply({ ok: true, value: [remoteRecom()], degraded: false }))
    await flush()
    assert.ok(text(second.container).includes('Remote Model'))
    assert.ok(second.container.querySelector('.lc-recom-degraded') === null)
    await second.unmount()
  })
})
