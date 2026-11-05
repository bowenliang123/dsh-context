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

function reply(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function card(locale: 'en' | 'zh'): () => ReturnType<ReturnType<typeof makeRecomCard>> {
  const ctx = new TestClientCtx({ locale })
  return makeRecomCard(makeKit(locale), asClientCtx(ctx))
}

afterEach(() => {
  resetRecomCache()
  vi.unstubAllGlobals()
})

describe('RecomCard', () => {
  test('the default paints immediately, then the validated remote selection replaces it', async () => {
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
    release(reply({ ok: true, value: remoteRecom(), degraded: false }))
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

  test('the brand initial covers icon loading and failure, and a late response is ignored after unmount', async () => {
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { release = resolve }))
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    const mark = query(m.container, '.lc-recom-mark')
    assert.ok(mark.querySelector('.lc-recom-fallback') !== null)
    assert.equal(mark.querySelector('.lc-recom-fallback')?.textContent, 'D')
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('load'))
    })
    assert.ok(mark.classList.contains('lc-recom-mark-loaded'))
    assert.ok(mark.querySelector('.lc-recom-fallback') !== null)
    await act(async () => {
      query(m.container, 'img').dispatchEvent(new Event('error'))
    })
    assert.ok(!mark.classList.contains('lc-recom-mark-loaded'))
    assert.ok(mark.querySelector('.lc-recom-fallback') !== null)
    assert.ok(mark.querySelector('img') === null)
    await m.unmount()
    release(reply({ ok: true, value: remoteRecom() }))
    await flush()
    assert.equal(m.container.isConnected, false)
  })

  test('every mount re-requests and rotates, painting the cached entry at once', async () => {
    const calls: string[] = []
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', async () => {
      calls.push('fetch')
      return new Promise<Response>((resolve) => { release = resolve })
    })
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    assert.ok(!text(first.container).includes('Remote Model'))
    release(reply({ ok: true, value: { ...remoteRecom(), icon: 'https://simpleicons.org/icons/deepseek.svg' } }))
    await flush()
    assert.ok(text(first.container).includes('Remote Model'))
    await first.unmount()
    const second = await mount(h(RecomCard))
    assert.ok(text(second.container).includes('Remote Model'), 'the cached entry paints before the fresh read settles')
    await second.unmount()
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: { ...remoteRecom(), icon: 'https://simpleicons.org/icons/deepseek.svg' } }))
    const third = await mount(h(RecomCard))
    await flush()
    assert.ok(text(third.container).includes('Remote Model'))
    assert.ok(!text(third.container).includes(DEFAULT_RECOM.slogan.en))
    await third.unmount()
    assert.equal(calls.length, 2)
  })

  test('an identical response leaves the painted card untouched', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: DEFAULT_RECOM }))
    const RecomCard = card('en')
    const m = await mount(h(RecomCard))
    await flush()
    assert.ok(text(m.container).includes(DEFAULT_RECOM.slogan.en))
    assert.ok(text(m.container).includes(DEFAULT_RECOM.promotion.en))
    assert.ok(!text(m.container).includes('Remote Model'))
    assert.ok(m.container.querySelector('.lc-recom-degraded') === null)
    await m.unmount()
  })

  test('a host-degraded selection marks the brand until live data settles', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: DEFAULT_RECOM, degraded: true }))
    const RecomCard = card('zh')
    const m = await mount(h(RecomCard))
    await flush()
    assert.equal(query(m.container, '.lc-recom-brand').textContent, 'DeepSeek')
    assert.ok(m.container.querySelector('.lc-recom-degraded') !== null)
    await m.unmount()
    let release!: (value: Response) => void
    vi.stubGlobal('fetch', () => new Promise<Response>((resolve) => { release = resolve }))
    const second = await mount(h(RecomCard))
    assert.ok(second.container.querySelector('.lc-recom-degraded') !== null, 'the cached degrade paints at once')
    release(reply({ ok: true, value: DEFAULT_RECOM }))
    await flush()
    assert.ok(second.container.querySelector('.lc-recom-degraded') === null)
    await second.unmount()
  })

  test('a failed refresh keeps the cached live card unmarked', async () => {
    vi.stubGlobal('fetch', async () => reply({ ok: true, value: remoteRecom(), degraded: false }))
    const RecomCard = card('en')
    const first = await mount(h(RecomCard))
    await flush()
    assert.ok(text(first.container).includes('Remote Model'))
    await first.unmount()
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')))
    const second = await mount(h(RecomCard))
    await flush()
    assert.ok(text(second.container).includes('Remote Model'))
    assert.ok(second.container.querySelector('.lc-recom-degraded') === null)
    await second.unmount()
  })
})
