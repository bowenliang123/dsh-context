import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { makeBalanceCapsule } from '../../../src/client/components/balanceCapsule'
import { PLATFORM_BALANCES_STORAGE_KEY, resetPlatformBalances } from '../../../src/client/balance'
import { createContextSettings, type ContextSettings } from '../../../src/client/settings'
import type { BalanceSource } from '../../../src/shared/types'
import { asClientCtx, TestClientCtx } from '../helpers/harness'
import { click, flush, keydown, makeKit, mount, query, queryAll, text, type Mounted } from '../helpers/kit'

const ACCOUNT = {
  isAvailable: true,
  balances: [
    { currency: 'CNY', total: 110, granted: 10, toppedUp: 100 },
    { currency: 'USD', total: 12.5, granted: 2.5, toppedUp: 10 },
  ],
}

const API = {
  isAvailable: true,
  balances: [
    { currency: 'CNY', total: 90, granted: 20, toppedUp: 70 },
    { currency: 'USD', total: 20, granted: 5, toppedUp: 15 },
  ],
}

const REPORT = { account: ACCOUNT, api: API }

function stubRoute(value: unknown, ok = true): void {
  vi.stubGlobal('fetch', async () => ({ ok, json: async () => ({ ok: true, value }) }))
}

function settingsWith(
  source: BalanceSource = 'account',
  over: { writable?: boolean; status?: string } = {},
): { settings: ContextSettings; sets: { field: string; value: unknown }[] } {
  const settings = createContextSettings()
  const sets: { field: string; value: unknown }[] = []
  settings.attach({
    getSnapshot: () => ({ status: over.status ?? 'ready', value: { balanceSource: source }, writable: over.writable ?? true }),
    subscribe: () => () => {},
    set: (field, value) => {
      sets.push({ field, value })
      return Promise.resolve()
    },
  })
  return { settings, sets }
}

interface OpenOptions {
  source?: BalanceSource
  locale?: string
  value?: unknown
  ok?: boolean
  writable?: boolean
  status?: string
}

async function open(options: OpenOptions = {}): Promise<{ m: Mounted; sets: { field: string; value: unknown }[] }> {
  stubRoute('value' in options ? options.value : REPORT, options.ok ?? true)
  const { settings, sets } = settingsWith(options.source ?? 'account', options)
  const locale = options.locale ?? 'en'
  const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale })), makeKit(locale), settings)
  const m = await mount(h(Capsule, {}))
  await flush()
  return { m, sets }
}

function pill(m: Mounted): HTMLElement {
  return query(m.container, '.lc-ov-balance')
}

function panel(): HTMLElement | null {
  return document.body.querySelector<HTMLElement>('.lc-bal-panel')
}

function options(): HTMLElement[] {
  return queryAll(panel()!, '.lc-bal-option')
}

function rowValues(option: Element): (string | null)[] {
  return queryAll(option, '.lc-bal-row-value').map(el => el.textContent)
}

async function openPanel(m: Mounted): Promise<HTMLElement> {
  await click(pill(m))
  const shown = panel()
  assert.ok(shown !== null, 'the panel is portaled to the body')
  return shown
}

afterEach(() => {
  resetPlatformBalances()
  globalThis.localStorage.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('availability and labels', () => {
  test('nothing renders while the first read is pending', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: REPORT }) }
    })
    const pending = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), makeKit(), settingsWith().settings)
    const m = await mount(h(pending, {}))
    assert.equal(text(m.container), '', 'nothing while the first read is pending')
    release()
    await flush()
    assert.ok(query(m.container, '.lc-ov-balance'), 'the landing paints the pill')
    await m.unmount()
  })

  test('a failed route, a null report, and two absent arms render nothing', async () => {
    for (const [label, value, ok] of [
      ['route absent', undefined, false],
      ['no report', null, true],
      ['no arms', { account: null, api: null }, true],
    ] as [string, unknown, boolean][]) {
      resetPlatformBalances()
      const { m: mounted } = await open({ value, ok })
      assert.equal(text(mounted.container), '', label)
      await mounted.unmount()
    }
  })

  test('the account arm labels the pill by default; the api setting labels the other arm', async () => {
    const { m } = await open()
    const button = pill(m)
    assert.equal(button.tagName, 'BUTTON')
    assert.equal(button.getAttribute('type'), 'button')
    assert.equal(button.getAttribute('aria-haspopup'), 'dialog')
    assert.equal(button.getAttribute('aria-expanded'), 'false')
    assert.equal(query(m.container, '.lc-ov-balance-label').textContent, 'DeepSeek account balance')
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '$12.50')
    assert.ok(query(m.container, '.lc-ov-balance-caret'), 'a two-source pill carries the dropdown caret')
    assert.ok(!(query(m.container, '.lc-ov-balance-caret').getAttribute('class') ?? '').includes('lc-ov-balance-caret-open'))
    await m.unmount()

    const api = await open({ source: 'api' })
    assert.equal(query(api.m.container, '.lc-ov-balance-label').textContent, 'DeepSeek API balance')
    assert.equal(query(api.m.container, '.lc-ov-balance-value').textContent, '$20.00')
    await api.m.unmount()
  })

  test('an unavailable configured arm falls back to the available one', async () => {
    const accountOff = await open({ value: { account: null, api: API } })
    assert.equal(query(accountOff.m.container, '.lc-ov-balance-label').textContent, 'DeepSeek API balance')
    await accountOff.m.unmount()

    resetPlatformBalances()
    const apiOff = await open({ source: 'api', value: { account: ACCOUNT, api: null } })
    assert.equal(query(apiOff.m.container, '.lc-ov-balance-label').textContent, 'DeepSeek account balance')
    await apiOff.m.unmount()
  })

  test('the zh locale shows CNY with localized arm labels and figures', async () => {
    const { m } = await open({ locale: 'zh' })
    assert.equal(query(m.container, '.lc-ov-balance-label').textContent, 'DeepSeek账号余额')
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '¥110.00')
    const shown = await openPanel(m)
    assert.deepEqual(queryAll(options()[0], '.lc-bal-row-label').map(el => el.textContent), ['总额', '充值金额', '赠金'])
    assert.deepEqual(rowValues(options()[0]), ['¥110.00', '¥100.00', '¥10.00'])
    assert.equal(shown.getAttribute('aria-label'), 'DeepSeek 余额')
    await m.unmount()
  })

  test('an arm without the display currency falls back to its first entry, code-prefixed', async () => {
    const { m } = await open({
      value: { account: { isAvailable: true, balances: [{ currency: 'EUR', total: 5, granted: 0, toppedUp: 5 }] }, api: null },
    })
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, 'EUR 5.00')
    await m.unmount()
  })
})

describe('the dropdown', () => {
  test('lists each available arm with its total, topped-up, and granted figures; only the shown arm is pressed', async () => {
    const { m } = await open()
    const shown = await openPanel(m)
    assert.equal(pill(m).getAttribute('aria-expanded'), 'true')
    assert.equal(pill(m).getAttribute('aria-controls'), 'lc-bal-panel')
    assert.match(query(pill(m), '.lc-ov-balance-caret').getAttribute('class') ?? '', /lc-ov-balance-caret-open/)
    assert.equal(document.activeElement, shown, 'focus moves into the dialog')
    assert.equal(shown.getAttribute('role'), 'dialog')
    assert.equal(shown.getAttribute('aria-label'), 'DeepSeek balance')
    const cards = options()
    assert.equal(cards.length, 2)
    assert.deepEqual(cards.map(card => query(card, '.lc-bal-option-name').textContent), [
      'DeepSeek account balance',
      'DeepSeek API balance',
    ])
    assert.deepEqual(cards.map(card => card.getAttribute('aria-pressed')), ['true', 'false'])
    assert.deepEqual(rowValues(cards[0]), ['$12.50', '$10.00', '$2.50'])
    assert.deepEqual(rowValues(cards[1]), ['$20.00', '$15.00', '$5.00'])
    assert.equal(queryAll(cards[0], '.lc-bal-option-check').length, 1, 'the shown arm carries the check')
    assert.equal(queryAll(cards[1], '.lc-bal-option-check').length, 0)
    const usage = query<HTMLAnchorElement>(shown, '.lc-bal-usage')
    assert.equal(usage.getAttribute('href'), 'https://platform.deepseek.com/usage')
    assert.equal(usage.getAttribute('target'), '_blank')
    assert.equal(usage.getAttribute('rel'), 'noreferrer')
    assert.equal(usage.textContent, 'View on DeepSeek Platform')
    await m.unmount()
  })

  test('selecting the other arm switches the pill, persists the setting, closes the panel, and returns focus', async () => {
    const { m, sets } = await open()
    await openPanel(m)
    await click(options()[1])
    assert.deepEqual(sets, [{ field: 'balanceSource', value: 'api' }])
    assert.equal(query(m.container, '.lc-ov-balance-label').textContent, 'DeepSeek API balance')
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '$20.00')
    assert.equal(panel(), null, 'the pick closes the panel')
    assert.equal(pill(m).getAttribute('aria-expanded'), 'false')
    assert.equal(document.activeElement, pill(m), 'focus returns to the trigger')
    await m.unmount()
  })

  test('a read-only or still-loading settings face switches the pill for the session without writing', async () => {
    for (const [label, over] of [
      ['read-only', { writable: false }],
      ['loading', { status: 'pending' }],
    ] as [string, { writable?: boolean; status?: string }][]) {
      resetPlatformBalances()
      const { m, sets } = await open(over)
      await openPanel(m)
      await click(options()[1])
      assert.equal(query(m.container, '.lc-ov-balance-label').textContent, 'DeepSeek API balance', label)
      assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '$20.00', label)
      assert.deepEqual(sets, [], label + ': no settings write is attempted')
      await m.unmount()
    }
  })

  test('a single available arm still opens its own breakdown', async () => {
    const { m } = await open({ source: 'account', value: { account: null, api: API } })
    assert.equal(m.container.querySelector('.lc-ov-balance-caret'), null, 'one source needs no switching caret')
    const shown = await openPanel(m)
    const cards = options()
    assert.equal(cards.length, 1)
    assert.equal(query(cards[0], '.lc-bal-option-name').textContent, 'DeepSeek API balance')
    assert.equal(cards[0].getAttribute('aria-pressed'), 'true')
    assert.deepEqual(queryAll(shown, '.lc-bal-row-label').map(el => el.textContent), ['Total', 'Topped up', 'Granted'])
    await m.unmount()
  })

  test('a second press on the trigger closes the panel', async () => {
    const { m } = await open()
    await openPanel(m)
    await click(pill(m))
    assert.equal(panel(), null)
    assert.equal(pill(m).getAttribute('aria-expanded'), 'false')
    await m.unmount()
  })

  test('Escape, an outside press, a scroll, and a resize close it; a press inside the panel or a targetless event does not', async () => {
    const { m } = await open()
    await openPanel(m)
    await keydown('Escape', document.body)
    assert.equal(panel(), null, 'Escape closes the panel')

    await openPanel(m)
    await act(async () => { panel()!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.ok(panel() !== null, 'a press inside the portaled panel keeps it open')

    await act(async () => { window.dispatchEvent(new MouseEvent('mousedown')) })
    assert.ok(panel() !== null, 'an event with no node target is ignored')

    await act(async () => { document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true })) })
    assert.equal(panel(), null, 'a press outside closes it')

    await openPanel(m)
    await act(async () => { window.dispatchEvent(new Event('scroll')) })
    assert.equal(panel(), null, 'a scroll retracts the panel')

    await openPanel(m)
    await act(async () => { window.dispatchEvent(new Event('resize')) })
    assert.equal(panel(), null, 'a resize retracts the panel')
    await m.unmount()
  })

  test('sits under its trigger, inside the viewport, and flips and clamps', async () => {
    const own = (name: string): PropertyDescriptor | undefined => Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
    const width = own('offsetWidth')
    const height = own('offsetHeight')
    const restore = (name: string, was: PropertyDescriptor | undefined): void => {
      if (was === undefined) Reflect.deleteProperty(HTMLElement.prototype, name)
      else Object.defineProperty(HTMLElement.prototype, name, was)
    }
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 240 })
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, get: () => 160 })
    try {
      const { m } = await open()
      const rect = { left: 800, right: 900, top: 680, bottom: 700 }
      pill(m).getBoundingClientRect = () =>
        ({ ...rect, x: rect.left, y: rect.top, width: 100, height: 20, toJSON: () => '' }) as DOMRect

      const shown = await openPanel(m)
      assert.notEqual(shown.style.visibility, 'hidden', 'measured before paint, so no hidden stage is left')
      assert.equal(shown.style.left, '660px', 'right-aligned to the trigger inside the viewport')
      assert.equal(shown.style.top, '514px', 'flipped above: below the trigger there is no room for 160px')

      await click(pill(m))
      rect.left = 10
      rect.right = 110
      await openPanel(m)
      const clamped = panel()!
      assert.equal(clamped.style.left, '8px', 'clamped inside the viewport')
      assert.equal(clamped.style.top, '514px')
      await m.unmount()
    } finally {
      restore('offsetWidth', width)
      restore('offsetHeight', height)
    }
  })
})

describe('data freshness', () => {
  test('a stored report paints before the live read lands, and a live read replaces it', async () => {
    globalThis.localStorage.setItem(PLATFORM_BALANCES_STORAGE_KEY, JSON.stringify({ at: Date.now(), balances: REPORT }))
    const fresh = { account: null, api: { isAvailable: true, balances: [{ currency: 'USD', total: 9.99, granted: 0.99, toppedUp: 9 }] } }
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: fresh }) }
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), makeKit(), settingsWith().settings)
    const m = await mount(h(Capsule, {}))
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '$12.50', 'the remembered figure shows at once')
    release()
    await flush()
    assert.equal(query(m.container, '.lc-ov-balance-value').textContent, '$9.99', 'the live figure takes over')
    assert.equal(query(m.container, '.lc-ov-balance-label').textContent, 'DeepSeek API balance', 'the live report renames the shown arm')
    await m.unmount()
  })

  test('a reopen inside the read window joins it and settles on the landing figure (issue #82)', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: REPORT }) }
    })
    const first = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), makeKit(), settingsWith().settings)
    const m1 = await mount(h(first, {}))
    assert.equal(text(m1.container), '', 'nothing remembered yet')
    await m1.unmount()
    const second = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), makeKit(), settingsWith().settings)
    const m2 = await mount(h(second, {}))
    assert.equal(text(m2.container), '', 'the joined read has not landed yet')
    release()
    await flush()
    assert.equal(query(m2.container, '.lc-ov-balance-value').textContent, '$12.50', 'the landing reaches the reopen')
    await m2.unmount()
  })

  test('the report emptying while the panel is open hides the pill on the next landing', async () => {
    globalThis.localStorage.setItem(PLATFORM_BALANCES_STORAGE_KEY, JSON.stringify({ at: Date.now(), balances: REPORT }))
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.stubGlobal('fetch', async () => {
      await gate
      return { ok: true, json: async () => ({ ok: true, value: { account: null, api: null } }) }
    })
    const Capsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), makeKit(), settingsWith().settings)
    const m = await mount(h(Capsule, {}))
    await openPanel(m)
    release()
    await flush()
    assert.equal(panel(), null, 'the portal unmounts with the pill')
    assert.equal(text(m.container), '', 'nothing left to show')
    await m.unmount()
  })
})
