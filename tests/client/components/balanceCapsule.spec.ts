import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeBalanceCapsule } from '../../../src/client/components/balanceCapsule'
import { PLATFORM_BALANCE_STORAGE_KEY, resetPlatformBalance } from '../../../src/client/balance'
import { resetDisplayCurrencyPreference, setDisplayCurrencyPreference } from '../../../src/client/currency'
import { asClientCtx, TestClientCtx } from '../helpers/harness'
import { flush, makeKit, mount, query, text } from '../helpers/kit'

const kit = makeKit()

const WIRE_BALANCE = {
  isAvailable: true,
  balances: [
    { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
    { currency: 'USD', total: 12.5, granted: 2.5, toppedUp: 10 },
  ],
}

function stubRoute(body: unknown): void {
  vi.stubGlobal('fetch', async () => ({ ok: true, json: async () => body }))
}

/** Seed the figure a previous open would have left in storage. */
function remember(balance: unknown): void {
  globalThis.localStorage.setItem(PLATFORM_BALANCE_STORAGE_KEY, JSON.stringify(balance))
}

afterEach(() => {
  resetPlatformBalance()
  resetDisplayCurrencyPreference()
  globalThis.localStorage.clear()
  vi.unstubAllGlobals()
})

describe('BalanceCapsule', () => {
  test('absent, failed, and still-pending reads render nothing', async () => {
    stubRoute({ ok: true, value: null })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    assert.equal(text(m.container), '')
    await m.unmount()

    stubRoute({ ok: false })
    const failed = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m2 = await mount(h(failed, {}))
    await flush()
    assert.equal(text(m2.container), '')
    await m2.unmount()

    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: WIRE_BALANCE }) }
    })
    const pending = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m3 = await mount(h(pending, {}))
    assert.equal(text(m3.container), '', 'nothing while the first read is pending')
    await m3.unmount()
    release()
    await flush()
  })

  test('the en locale shows USD with the total and the breakdown tooltip', async () => {
    stubRoute({ ok: true, value: WIRE_BALANCE })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    const pill = query(m.container, '.lc-ov-balance')
    assert.equal(pill?.tagName, 'A')
    assert.equal(pill?.getAttribute('href'), 'https://platform.deepseek.com/usage')
    assert.equal(pill?.getAttribute('target'), '_blank')
    assert.equal(pill?.getAttribute('rel'), 'noreferrer')
    assert.equal(query(m.container, '.lc-ov-balance-label')?.textContent, 'DeepSeek balance')
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '$12.50')
    // The breakdown rides data-* attributes for the page's hover tip (no native `title`): only the
    // non-zero parts bubble, topped-up before granted, and the tip drops below the pill.
    assert.equal(pill?.getAttribute('title'), null)
    assert.equal(pill?.getAttribute('data-lc-tip'), 'Topped-up balance: $10.00\nGranted balance: $2.50')
    assert.equal(pill?.getAttribute('data-lc-tip-side'), 'bottom')
    await m.unmount()
  })

  test('an en page shows the funded CNY entry when the USD entry is zero', async () => {
    stubRoute({
      ok: true,
      value: {
        isAvailable: true,
        balances: [
          { currency: 'CNY', total: 58.97, granted: 0, toppedUp: 58.97 },
          { currency: 'USD', total: 0, granted: 0, toppedUp: 0 },
        ],
      },
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '¥58.97', 'the funded currency beats the display currency')
    await m.unmount()
  })

  test('the currency preference overrides the language rule', async () => {
    stubRoute({ ok: true, value: WIRE_BALANCE })
    setDisplayCurrencyPreference('cny')
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '¥110.00')
    await m.unmount()
  })

  test('zero sub-items drop from the tooltip; an all-zero account rides bare', async () => {
    stubRoute({
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'USD', total: 9, granted: 0, toppedUp: 9 }] },
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    const pill = query(m.container, '.lc-ov-balance')
    assert.equal(pill.getAttribute('data-lc-tip'), 'Topped-up balance: $9.00', 'the zero granted line is gone')
    await m.unmount()

    stubRoute({
      ok: true,
      value: { isAvailable: false, balances: [{ currency: 'USD', total: 0, granted: 0, toppedUp: 0 }] },
    })
    const bare = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m2 = await mount(h(bare, {}))
    await flush()
    assert.equal(query(m2.container, '.lc-ov-balance-value')?.textContent, '$0.00', 'the pill still shows the figure')
    assert.equal(query(m2.container, '.lc-ov-balance').getAttribute('data-lc-tip'), null, 'nothing to break down — no tip')
    await m2.unmount()
  })

  test('the zh locale shows CNY with localized breakdown labels', async () => {
    stubRoute({ ok: true, value: WIRE_BALANCE })
    // The kit's `t` is the harness's locale-bound translate (zh), while the ctx's locale service drives the currency pick.
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'zh' })), makeKit('zh'))
    const m = await mount(h(Capsule, {}))
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-label')?.textContent, 'DeepSeek 余额')
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '¥110.00')
    assert.equal(query(m.container, '.lc-ov-balance').getAttribute('data-lc-tip'), '充值余额: ¥100.00\n赠送余额: ¥10.00')
    await m.unmount()
  })

  test('the remembered figure paints first, then the revalidated one replaces it', async () => {
    remember(WIRE_BALANCE)
    const fresh = { isAvailable: true, balances: [{ currency: 'USD', total: 9.99, granted: 0.99, toppedUp: 9 }] }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: fresh }) }
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '$12.50', 'the remembered total shows at once')
    release()
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '$9.99', 'the live figure takes over')
    await m.unmount()
  })

  test('a failed revalidation keeps the remembered figure instead of blanking the pill', async () => {
    remember(WIRE_BALANCE)
    stubRoute({ ok: false })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '$12.50')
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, '$12.50', 'the miss changes nothing')
    await m.unmount()
  })

  test('an account without the display currency falls back to its first entry, code-prefixed', async () => {
    stubRoute({
      ok: true,
      value: { isAvailable: true, balances: [{ currency: 'EUR', total: 5, granted: 0, toppedUp: 5 }] },
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const m = await mount(h(Capsule, {}))
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value')?.textContent, 'EUR 5.00')
    await m.unmount()
  })
})

describe('BalanceCapsule — the fast close-reopen window (issue #82)', () => {
  test('a reopen inside the read window joins it and settles on the landing figure', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: WIRE_BALANCE }) }
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const first = await mount(h(Capsule, {}))
    assert.equal(text(first.container), '', 'nothing remembered yet')
    await first.unmount()
    const Reopened = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const second = await mount(h(Reopened, {}))
    assert.equal(text(second.container), '', 'the joined read has not landed yet')
    release()
    await flush()
    assert.equal(query(second.container, '.lc-ov-balance-value')?.textContent, '$12.50', 'the landing reaches the reopen')
    await second.unmount()
  })
})
