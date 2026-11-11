import { act, createElement as h, type ReactElement } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { useHoverTip } from '../../../src/client/components/hoverTip'
import { flush, mount, query, type Mounted, until, click, makeKit, queryAll, text } from '../helpers/kit'
import { fetchMissNote, useFetchOnMiss, type FetchOnMiss } from '../../../src/client/components/fetchOnMiss'
import { CommsEvent, CommsEventDetail, DelegationEvent } from '../../../src/client/components/commsEvent'
import { makeRichText } from '../../../src/client/components/richText'
import { type CommsAgent } from '../../../src/client/commsModel'
import { type CommsRow } from '../../../src/client/fleetDetail'
import { type FleetMessage } from '../../../src/shared/types'
import { makeBalanceCapsule } from '../../../src/client/components/balanceCapsule'
import { PLATFORM_BALANCE_STORAGE_KEY, resetPlatformBalance } from '../../../src/client/balance'
import { asClientCtx, TestClientCtx } from '../helpers/harness'

describe('hoverTip', () => {

function Zone(): ReactElement {
  const { zoneProps, bubble } = useHoverTip()
  return h(
    'div',
    zoneProps,
    h('button', { id: 'a', 'data-lc-tip': 'tip A' }, h('span', { id: 'a-child' }, 'A')),
    h('button', { id: 'b', 'data-lc-tip': 'tip B', 'data-lc-tip-side': 'bottom' }, 'B'),
    h('span', { id: 'plain' }, 'plain'),
    h('span', { id: 'empty', 'data-lc-tip': '' }, 'empty'),
    bubble,
  )
}

const bubble = (): HTMLElement | null => document.body.querySelector('#lc-hovertip-bubble')

async function mouseover(target: Element): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
}

async function mouseout(target: Element, relatedTarget: EventTarget | null): Promise<void> {
  await act(async () => { target.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget })) })
}

async function focusIn(target: Element): Promise<void> {
  await act(async () => { target.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
}

async function blurOut(target: Element, relatedTarget: EventTarget | null): Promise<void> {
  await act(async () => { target.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget })) })
}

function pinRect(anchor: Element, rect: { left: number; top: number; width: number; height: number }): void {
  const { left, top, width, height } = rect
  Object.defineProperty(anchor, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ left, top, width, height, bottom: top + height, right: left + width }),
  })
}

function CountingZone(props: { onRender: () => void }): ReactElement {
  props.onRender()
  const { zoneProps, bubble } = useHoverTip()
  return h('div', zoneProps, h('button', { id: 'a', 'data-lc-tip': 'tip A' }, 'A'), bubble)
}

afterEach(() => {
  bubble()?.remove()
})

describe('useHoverTip', () => {
  test('hovering an anchor shows its portaled tip and described-by; leaving hides both', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    await mouseover(a)
    const el = bubble()
    assert.ok(el !== null, 'the bubble portaled to <body>')
    assert.equal(el.getAttribute('role'), 'tooltip')
    assert.equal(el.textContent, 'tip A')
    assert.ok(el.className.includes('lc-tip') && el.className.includes('lc-hovertip'))
    assert.equal(el.style.opacity, '1', 'the measured pass revealed the bubble')
    assert.equal(el.style.left, '8px')
    assert.equal(el.style.top, '8px')
    assert.equal(a.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await mouseout(a, m.container)
    assert.equal(bubble(), null, 'leaving to a non-anchor hides the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null, 'the described-by goes with it')
    await m.unmount()
  })

  test('moving across the anchor subtree keeps the tip, switching anchors re-anchors, and focus/blur mirror hover', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    const b = query(m.container, '#b')
    await mouseover(a)
    const shown = bubble()?.style.cssText

    await mouseover(query(m.container, '#a-child'))
    assert.equal(bubble()?.style.cssText, shown, 'same anchor keeps the measured spot')
    assert.equal(a.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await mouseout(a, b)
    assert.ok(bubble() !== null, 'anchor-to-anchor movement never hides')
    await mouseover(b)
    assert.equal(bubble()?.textContent, 'tip B')
    assert.equal(a.getAttribute('aria-describedby'), null, 'the old anchor released')
    assert.equal(b.getAttribute('aria-describedby'), 'lc-hovertip-bubble')

    await focusIn(a)
    assert.equal(bubble()?.textContent, 'tip A')
    await blurOut(a, b)
    assert.ok(bubble() !== null, 'focus moving anchor-to-anchor never hides')
    await focusIn(b)
    assert.equal(bubble()?.textContent, 'tip B')
    await blurOut(b, null)
    assert.equal(bubble(), null, 'focus leaving the zone hides')
    await m.unmount()
  })

  test('a zone scroll or a viewport resize retracts the tip; non-anchors and empty labels never show one', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    await mouseover(query(m.container, '#plain'))
    assert.equal(bubble(), null, 'a non-anchor target shows nothing')
    await mouseover(query(m.container, '#empty'))
    assert.equal(bubble(), null, 'an empty data-lc-tip shows nothing')

    await mouseover(a)
    assert.ok(bubble() !== null)
    await act(async () => {
      query(m.container, '#plain').dispatchEvent(new Event('scroll', { bubbles: false }))
    })
    assert.equal(bubble(), null, 'any zone scroll retracts the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null)

    await mouseover(a)
    assert.ok(bubble() !== null)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(bubble(), null, 'the resize retracted the bubble')
    assert.equal(a.getAttribute('aria-describedby'), null)
    await act(async () => {
      window.dispatchEvent(new Event('resize'))
    })
    assert.equal(bubble(), null)
    await m.unmount()
  })

  test('the measure pass centers on the anchor, clamps horizontally, and flips a bottom tip that overflows', async () => {
    const m = await mount(h(Zone))
    const b = query(m.container, '#b')
    pinRect(b, { left: 100, top: 100, width: 20, height: 20 })
    await mouseover(b)
    assert.equal(bubble()?.style.left, '110px')
    assert.equal(bubble()?.style.top, '126px', 'anchor bottom + gap')

    pinRect(b, { left: 2000, top: 740, width: 20, height: 20 })
    await mouseout(b, m.container)
    await mouseover(b)
    assert.equal(bubble()?.style.left, '1016px', 'clamped to innerWidth - margin (width 0)')
    assert.equal(bubble()?.style.top, '734px', 'flipped above the anchor')
    await m.unmount()
  })

  test('hovering repaints only the bubble, and a re-shown tip reuses its measurement', async () => {
    let renders = 0
    const m = await mount(h(CountingZone, { onRender: () => { renders += 1 } }))
    const a = query(m.container, '#a')
    pinRect(a, { left: 100, top: 100, width: 40, height: 20 })

    renders = 0
    await mouseover(a)
    assert.equal(bubble()?.style.left, '120px')
    assert.equal(renders, 0, 'the zone never repaints for a hover')

    renders = 0
    await mouseout(a, m.container)
    assert.equal(bubble(), null)
    assert.equal(renders, 0, 'hiding the bubble leaves the zone untouched')

    await mouseover(a)
    assert.equal(bubble()?.textContent, 'tip A')
    assert.equal(bubble()?.style.left, '120px', 'the measured spot is reused')

    pinRect(a, { left: 300, top: 100, width: 40, height: 20 })
    await mouseout(a, m.container)
    await mouseover(a)
    assert.equal(bubble()?.style.left, '320px')

    a.setAttribute('data-lc-tip', 'tip A, longer')
    await mouseout(a, m.container)
    await mouseover(a)
    assert.equal(bubble()?.textContent, 'tip A, longer')
    assert.equal(bubble()?.style.left, '320px')

    await m.unmount()
  })

  test('a relabelled tip and a changed viewport both re-measure the bubble', async () => {
    const m = await mount(h(Zone))
    const a = query(m.container, '#a')
    pinRect(a, { left: 600, top: 100, width: 40, height: 20 })
    let widths = 0
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth')
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get: () => { widths += 1; return 10 },
    })
    try {
      await mouseover(a)
      assert.equal(bubble()?.style.left, '615px')
      widths = 0
      await mouseout(a, m.container)
      await mouseover(a)
      assert.equal(widths, 0, 'an unchanged tip reuses its measurement')
      a.setAttribute('data-lc-tip', 'tip A, longer')
      await mouseout(a, m.container)
      await mouseover(a)
      assert.equal(widths, 1, 'a relabelled tip re-measures')
      const width = window.innerWidth
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width - 400 })
      try {
        await mouseout(a, m.container)
        await mouseover(a)
        assert.equal(widths, 2, 'a changed viewport re-measures')
        assert.equal(bubble()?.style.left, '606px', 'the narrowed viewport re-clamps')
      } finally {
        Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
      }
    } finally {
      if (descriptor !== undefined) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', descriptor)
    }
    await m.unmount()
  })

  test('unmounting the zone removes the portaled bubble', async () => {
    const m: Mounted = await mount(h(Zone))
    await mouseover(query(m.container, '#a'))
    assert.ok(bubble() !== null)
    await m.unmount()
    await flush()
    assert.equal(bubble(), null, 'the portal goes down with the zone')
  })
})
})

describe('fetchOnMiss', () => {

let current: FetchOnMiss<string> | null = null

function Probe(props: {
  missKey: number | null
  fetcher?: (key: number) => Promise<string | null>
  scope?: string
}): ReactElement {
  const miss = useFetchOnMiss<string>(props.missKey, props.fetcher, 'test warn', props.scope)
  current = miss
  return h('div', null, h('span', { 'data-k': 'values' }, JSON.stringify([...miss.values])))
}

const values = (): [number, string][] => current === null ? [] : [...current.values]

const t = (key: string): string => key

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  current = null
})

describe('useFetchOnMiss scope isolation', () => {
  test('a same-seq value from another session never leaks into the new session', async () => {
    const a = vi.fn(async () => 'A body')
    const b = vi.fn(async () => 'B body')
    const m = await mount(h(Probe, { missKey: 7, fetcher: a, scope: 'A' }))
    try {
      await until(() => current?.state !== 'loading' && current?.values.has(7) === true, 'A never loaded')
      assert.deepEqual(values(), [[7, 'A body']])
      await m.update(h(Probe, { missKey: 7, fetcher: b, scope: 'B' }))
      await until(() => current?.values.get(7) === 'B body', 'B never re-read the seq')
      assert.equal(b.mock.calls.length, 1, 'the new session fetched instead of replaying A')
      assert.deepEqual(values(), [[7, 'B body']], 'no stale A entry survives')
    } finally {
      await m.unmount()
    }
  })

  test('a scope change with the same fetcher resets the values and re-reads', async () => {
    const fetcher = vi.fn(async () => 'shared body')
    const m = await mount(h(Probe, { missKey: 3, fetcher, scope: 'A' }))
    try {
      await until(() => current?.values.has(3) === true, 'the first read never landed')
      await m.update(h(Probe, { missKey: 3, fetcher, scope: 'B' }))
      await until(() => fetcher.mock.calls.length === 2, 'the scope change never re-read')
      assert.deepEqual(values(), [[3, 'shared body']])
    } finally {
      await m.unmount()
    }
  })

  test('a response from the previous session never lands after the switch', async () => {
    let resolveOld!: (value: string | null) => void
    const oldFetcher = (): Promise<string | null> => new Promise((resolve) => { resolveOld = resolve })
    const newFetcher = vi.fn(async () => 'B body')
    const m = await mount(h(Probe, { missKey: 9, fetcher: oldFetcher, scope: 'A' }))
    try {
      await m.update(h(Probe, { missKey: 9, fetcher: newFetcher, scope: 'B' }))
      await until(() => current?.values.get(9) === 'B body', 'B never landed')
      await act(async () => { resolveOld('A body') })
      assert.deepEqual(values(), [[9, 'B body']], 'the stale A response was dropped')
    } finally {
      await m.unmount()
    }
  })
})

describe('useFetchOnMiss retry and bounds', () => {
  test('a rejection from the previous session never lands after the switch', async () => {
    let rejectOld!: (reason: unknown) => void
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const oldFetcher = (): Promise<string | null> => new Promise((_resolve, reject) => { rejectOld = reject })
    const newFetcher = async (): Promise<string | null> => 'B body'
    const m = await mount(h(Probe, { missKey: 9, fetcher: oldFetcher, scope: 'A' }))
    try {
      await m.update(h(Probe, { missKey: 9, fetcher: newFetcher, scope: 'B' }))
      await until(() => current?.values.get(9) === 'B body', 'B never landed')
      await act(async () => { rejectOld(new Error('late')) })
      assert.equal(current?.state, 'idle', 'the stale rejection changed nothing')
      assert.equal(warn.mock.calls.length, 0, 'the stale rejection was not even reported')
    } finally {
      await m.unmount()
    }
  })

  test('a failed read retries with bounded backoff and lands without user action', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      if (calls <= 2) throw new Error('offline')
      return 'landed'
    }
    const m = await mount(h(Probe, { missKey: 1, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      assert.equal(calls, 1)
      assert.equal(current?.state, 'loading', 'an armed retry keeps the placeholder in place')
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      assert.equal(calls, 2)
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      assert.equal(calls, 3)
      await until(() => current?.values.get(1) === 'landed', 'the retried read never landed')
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })

  test('the retry budget ends in a failed state that a manual retry revives', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      if (calls <= 4) throw new Error('offline')
      return 'revived'
    }
    const m = await mount(h(Probe, { missKey: 2, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
      await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })
      assert.equal(calls, 4)
      assert.equal(current?.state, 'failed')
      await act(async () => { current?.retry() })
      await until(() => current?.values.get(2) === 'revived', 'the manual retry never landed')
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })

  test('a null answer is absent and is not retried', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => null)
    const m = await mount(h(Probe, { missKey: 4, fetcher, scope: 's' }))
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      assert.equal(current?.state, 'absent')
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
      assert.equal(fetcher.mock.calls.length, 1)
    } finally {
      await m.unmount()
    }
  })

  test('the value map stays bounded under heavy churn', async () => {
    const fetcher = async (key: number): Promise<string | null> => 'body ' + String(key)
    const m = await mount(h(Probe, { missKey: 0, fetcher, scope: 's' }))
    try {
      for (let key = 0; key < 40; key++) {
        await m.update(h(Probe, { missKey: key, fetcher, scope: 's' }))
        await until(() => current?.values.has(key) === true, 'key ' + String(key) + ' never landed')
      }
      assert.equal(current?.values.size, 32, 'the miss cache is bounded')
      assert.equal(current?.values.has(39), true)
      assert.equal(current?.values.has(0), false)
    } finally {
      await m.unmount()
    }
  })

  test('an unmount cancels an armed retry', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    let calls = 0
    const fetcher = async (): Promise<string | null> => {
      calls++
      throw new Error('offline')
    }
    const m = await mount(h(Probe, { missKey: 5, fetcher, scope: 's' }))
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    assert.equal(calls, 1)
    await m.unmount()
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    assert.equal(calls, 1, 'the detached hook retried nothing')
  })

  test('no fetcher and no key are inert', async () => {
    const m = await mount(h(Probe, { missKey: null }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 5)) })
      assert.deepEqual(values(), [])
      assert.equal(current?.state, 'idle')
    } finally {
      await m.unmount()
    }
  })
})

describe('fetchMissNote', () => {
  test('renders the empty, absent, failed, and loading notes', () => {
    assert.equal(fetchMissNote(t, undefined, 'idle', () => {}, 'browser.noContent'), 'browser.noContent')
    assert.equal(fetchMissNote(t, () => {}, 'absent', () => {}, 'browser.noContent'), 'browser.notInLog')
    assert.equal(fetchMissNote(t, () => {}, 'loading', () => {}, 'browser.noContent'), 'browser.loading')
    let retries = 0
    const node = fetchMissNote(t, () => {}, 'failed', () => { retries++ }, 'browser.noContent')
    assert.ok(node !== null && typeof node === 'object')
    const button = node as { props: { onClick: () => void; children: string } }
    assert.equal(button.props.children, 'browser.loadFailed')
    button.props.onClick()
    assert.equal(retries, 1)
  })
})
})

describe('commsEvent', () => {

const kit = makeKit()
const rich = makeRichText(kit)
const SUMMARY = 'Background subagent w1 finished and will do no further work unless you send it more.'
const AGENTS = new Map<string, CommsAgent>([
  ['root', { id: 'root', name: 'Lead', role: 'lead', self: true, hue: 'blue' }],
  ['w1', { id: 'w1', name: 'worker-bee', role: 'teammate', self: false, hue: 'green' }],
  ['w2', { id: 'w2', name: 'dsh-source-map child 45', role: 'subagent', self: false, hue: 'red', initials: 'DS45' }],
  ['w3', { id: 'w3', name: 'dsh-source-map child 1', role: 'subagent', self: false, hue: 'teal', initials: 'DS1' }],
])

function agentOf(id: string): CommsAgent {
  return AGENTS.get(id) ?? { id, name: id, role: 'other', self: false, hue: 'gray' }
}

function mountEvent(row: CommsRow, options: { full?: FleetMessage | null; fullPending?: boolean } = {}) {
  const full = options.full ?? null
  return mount(h(CommsEvent, {
    row,
    agentOf,
    open: true,
    onToggle: vi.fn(),
    full,
    t: kit.t,
  }, h(CommsEventDetail, {
    row,
    agentOf,
    full,
    fullPending: options.fullPending === true,
    pinnedId: null,
    onSelect: vi.fn(),
    onOpen: vi.fn(),
    onEnter: vi.fn(),
    onClose: vi.fn(),
    rich,
    t: kit.t,
  })))
}

describe('CommsEvent and detail', () => {
  test('a recognized settlement exposes its outcome, report, structured result and diagnostic', async () => {
    const row: CommsRow = {
      key: 'root:8:6000:settled', to: 'root', seq: 8, time: 6000, kind: 'settled', from: 'w1',
      text: `${SUMMARY}Its closing message:All gates green.`,
      summary: SUMMARY,
      report: 'All gates green.\n\n- check passed',
      structured: '{"ok":true}',
      diagnostic: 'provider warning',
    }
    const mounted = await mountEvent(row)
    assert.ok(text(query(mounted.container, '.lc-comms-preview')).includes(kit.t('fleet.settledShort.finished')))
    assert.ok(text(query(mounted.container, '.lc-comms-preview')).includes('All gates green.'))
    const detail = query(mounted.container, '.lc-comms-detail')
    assert.ok(text(detail).includes(kit.t('fleet.comms.detail.settledNote')))
    assert.ok(text(detail).includes(kit.t('fleet.settled.finished')))
    assert.ok(text(detail).includes('check passed'))
    assert.ok(text(detail).includes(kit.t('fleet.comms.detail.structured')))
    assert.ok(text(detail).includes('provider warning'))
    const participants = query(detail, '.lc-comms-participants')
    const body = query(detail, '.lc-comms-detail-body')
    assert.ok((participants.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    assert.ok(text(query(detail, '[data-party="from"]')).includes('worker-bee'))
    assert.ok(text(query(detail, '[data-party="from"]')).includes(kit.t('fleet.comms.detail.sender')))
    assert.ok(text(query(detail, '[data-party="to"]')).includes('Lead'))
    assert.ok(text(query(detail, '[data-party="to"]')).includes(kit.t('fleet.comms.detail.recipient')))
    assert.equal(queryAll(detail, '.lc-comms-person').length, 2)
    await mounted.unmount()
  })

  test('unknown settlements and empty bodies degrade without hiding the raw record', async () => {
    const future: CommsRow = {
      key: 'root:20:9000:settled', to: 'root', seq: 20, time: 9000, kind: 'settled', from: 'w1',
      text: 'a future summary', summary: 'a future summary', structured: 'not-json',
    }
    const mounted = await mountEvent(future)
    assert.ok(text(query(mounted.container, '.lc-comms-preview')).includes('a future summary'))
    const detail = query(mounted.container, '.lc-comms-detail')
    assert.ok(text(detail).includes('a future summary'))
    assert.ok(text(detail).includes('not-json'))
    assert.ok(text(detail).includes(kit.t('fleet.comms.detail.noReport')))
    assert.ok(!text(detail).includes(kit.t('fleet.settled.finished')))
    await mounted.unmount()

    const raw: CommsRow = { key: 'root:21:9100:settled', to: 'root', seq: 21, time: 9100, kind: 'settled', from: 'w1', text: 'a brand-new phrasing' }
    const rawMount = await mountEvent(raw)
    assert.equal(queryAll(rawMount.container, '.lc-comms-preview-text').length, 0)
    assert.ok(text(query(rawMount.container, '.lc-comms-detail-body')).includes('a brand-new phrasing'))
    assert.ok(!text(rawMount.container).includes(kit.t('fleet.comms.detail.noReport')))
    await rawMount.unmount()

    const empty: CommsRow = { key: 'root:22:9200:relay', to: 'root', seq: 22, time: 9200, kind: 'relay', from: 'w1', text: '' }
    const emptyMount = await mountEvent(empty)
    assert.ok(text(query(emptyMount.container, '.lc-comms-detail-body')).includes(kit.t('fleet.comms.detail.noBody')))
    await emptyMount.unmount()
  })

  test('a settlement without a report uses the summary for copying and explains the missing body', async () => {
    const row: CommsRow = {
      key: 'root:23:9300:settled', to: 'root', seq: 23, time: 9300, kind: 'settled', from: 'w1', text: SUMMARY, summary: SUMMARY,
    }
    const mounted = await mountEvent(row)
    assert.ok(text(query(mounted.container, '.lc-comms-detail-body')).includes(kit.t('fleet.comms.detail.noReport')))
    assert.ok(text(query(mounted.container, '.lc-comms-detail')).includes(kit.t('fleet.settled.finished')))
    await mounted.unmount()
  })

  test('self messages show one participant and clipped records disclose excerpt-only content', async () => {
    const row: CommsRow = {
      key: 'root:4:2000:relay', to: 'root', seq: 4, time: 2000, kind: 'relay', from: 'root', text: 'note to self', clipped: true,
    }
    const mounted = await mountEvent(row)
    assert.equal(queryAll(mounted.container, '.lc-comms-person').length, 1)
    assert.ok(query(mounted.container, '.lc-comms-people').className.includes('lc-comms-people-self'))
    assert.equal(queryAll(mounted.container, '.lc-comms-role').length, 0)
    assert.ok(text(query(mounted.container, '.lc-comms-detail')).includes(kit.t('fleet.comms.detail.excerptOnly')))
    await mounted.unmount()
  })

  test('long labels stack into stem and digits inside the badge', async () => {
    const row: CommsRow = {
      key: 'root:30:10000:relay', to: 'root', seq: 30, time: 10000, kind: 'relay', from: 'w2', text: 'note',
    }
    const mounted = await mountEvent(row)
    const avatar = query(mounted.container, '.lc-comms-avatar')
    assert.ok(avatar.className.includes('lc-comms-avatar-stack'))
    assert.deepEqual(queryAll(avatar, '.lc-comms-avatar-text').map(node => text(node)), ['DS', '45'])
    assert.equal(text(avatar), 'DS45')
    await mounted.unmount()

    const short = await mountEvent({ ...row, from: 'w3' })
    const three = query(short.container, '.lc-comms-avatar')
    assert.ok(three.className.includes('lc-comms-avatar-condensed'))
    assert.deepEqual(queryAll(three, '.lc-comms-avatar-text').map(node => text(node)), ['DS1'])
    await short.unmount()
  })

  test('full content replaces the excerpt and pending state names the read', async () => {
    const row: CommsRow = {
      key: 'root:5:2500:relay', to: 'root', seq: 5, time: 2500, kind: 'relay', from: 'w1', text: 'excerpt…', clipped: true,
    }
    const full: FleetMessage = { seq: 5, time: 2500, kind: 'relay', from: 'w1', text: 'complete body' }
    const mounted = await mountEvent(row, { full })
    assert.ok(text(query(mounted.container, '.lc-comms-detail-body')).includes('complete body'))
    assert.ok(!text(query(mounted.container, '.lc-comms-detail')).includes(kit.t('fleet.comms.detail.excerptOnly')))
    await mounted.unmount()
    const pending = await mountEvent(row, { fullPending: true })
    assert.ok(text(query(pending.container, '.lc-comms-detail')).includes(kit.t('fleet.comms.detail.loading')))
    await pending.unmount()
  })

  test('the body offers raw, markdown, copy and find controls', async () => {
    const row: CommsRow = {
      key: 'root:40:11000:relay', to: 'root', seq: 40, time: 11000, kind: 'relay', from: 'w1',
      text: '# Report\n\nsome **bold** body',
    }
    const mounted = await mountEvent(row)
    const detail = query(mounted.container, '.lc-comms-detail')
    const tools = query(detail, '.lc-comms-detail-tools')
    assert.deepEqual(
      queryAll<HTMLElement>(tools, '.lc-gran-btn').map(button => text(button)),
      [kit.t('rich.raw'), kit.t('rich.md')],
    )
    assert.ok(query(tools, '.lc-rich-copy'))
    assert.ok(query(detail, '.lc-comms-detail-body .lc-ts-desc-md'))
    await click(queryAll<HTMLElement>(tools, '.lc-gran-btn')[0])
    assert.deepEqual(
      queryAll(detail, '.lc-comms-detail-body .lc-ts-line').map(line => text(line)),
      ['# Report', '', 'some **bold** body'],
    )
    assert.equal(queryAll(detail, '.lc-comms-detail-body .lc-ts-desc-md').length, 0)
    await click(queryAll<HTMLElement>(tools, '.lc-gran-btn')[1])
    assert.ok(query(detail, '.lc-comms-detail-body .lc-ts-desc-md'))
    await click(query(tools, '.lc-find-btn'))
    assert.ok(query(detail, '.lc-comms-detail-body .lc-find'))
    await click(queryAll(query(detail, '.lc-find'), '.lc-find-btn')[2])
    assert.equal(queryAll(detail, '.lc-find').length, 0)
    await mounted.unmount()
  })

  test('json-shaped message text still opens as markdown', async () => {
    const row: CommsRow = {
      key: 'root:41:11100:relay', to: 'root', seq: 41, time: 11100, kind: 'relay', from: 'w1', text: '{"ok":true}',
    }
    const mounted = await mountEvent(row)
    const body = query(mounted.container, '.lc-comms-detail-body')
    assert.ok(query(body, '.lc-ts-desc-md'))
    assert.equal(queryAll(body, '.lc-ts-desc-json').length, 0)
    assert.deepEqual(
      queryAll<HTMLElement>(body, '.lc-gran-btn').map(button => text(button)),
      [kit.t('rich.raw'), kit.t('rich.md')],
    )
    await mounted.unmount()
  })

  test('a delegation row keeps the task preview and folds its route and duty into the head', async () => {
    const delegation = {
      key: 'root:9:w2', seq: 9, time: 9000, from: 'root', to: 'w2', mode: 'continuable' as const, label: 'Map host boundaries',
    }
    const mounted = await mount(h(DelegationEvent, {
      delegation,
      agentOf,
      preview: 'Scan the host package tree.',
      open: false,
      onToggle: vi.fn(),
      t: kit.t,
    }))
    assert.equal(query(mounted.container, '.lc-comms-event').dataset.commsKey, 'root:9:w2')
    assert.ok(query(mounted.container, '.lc-comms-kind-delegation'))
    assert.ok(text(query(mounted.container, '.lc-comms-kind')).includes(kit.t('fleet.pulse.delegation')))
    assert.ok(text(query(mounted.container, '.lc-comms-flow')).includes('Lead'))
    assert.ok(text(query(mounted.container, '.lc-comms-flow')).includes('dsh-source-map child 45'))
    assert.ok(text(query(mounted.container, '.lc-comms-preview')).includes('Scan the host package tree.'))
    assert.equal(query(mounted.container, '.lc-comms-event').children.length, 1)
    await mounted.unmount()
    const namedMounted = await mount(h(DelegationEvent, {
      delegation: { ...delegation, from: 'w1', to: 'root' },
      agentOf,
      preview: '',
      open: true,
      onToggle: vi.fn(),
      children: h('div', { className: 'lc-comms-detail' }, 'detail body'),
      t: kit.t,
    }))
    const roles = queryAll<HTMLElement>(namedMounted.container, '.lc-comms-role').map(role => text(role))
    assert.deepEqual(roles, [kit.t('fleet.role.teammate')])
    assert.ok(text(query(namedMounted.container, '.lc-comms-event')).includes('detail body'))
    assert.equal(text(query(namedMounted.container, '.lc-comms-preview')).trim(), '')
    await namedMounted.unmount()
  })
})
})

describe('balanceCapsule', () => {

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

function remember(balance: unknown): void {
  globalThis.localStorage.setItem(PLATFORM_BALANCE_STORAGE_KEY, JSON.stringify(balance))
}

afterEach(() => {
  resetPlatformBalance()
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

  test('the en locale shows USD with the total and breakdown; the zh locale shows CNY with localized labels', async () => {
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
    assert.equal(pill?.getAttribute('title'), null)
    assert.equal(pill?.getAttribute('data-lc-tip'), 'Topped-up balance: $10.00\nGranted balance: $2.50')
    assert.equal(pill?.getAttribute('data-lc-tip-side'), 'bottom')
    await m.unmount()

    const ZhCapsule = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'zh' })), makeKit('zh'))
    const zh = await mount(h(ZhCapsule, {}))
    await flush()
    assert.equal(query(zh.container, '.lc-ov-balance-label')?.textContent, 'DeepSeek 余额')
    assert.equal(query(zh.container, '.lc-ov-balance-value')?.textContent, '¥110.00')
    assert.equal(query(zh.container, '.lc-ov-balance').getAttribute('data-lc-tip'), '充值余额: ¥100.00\n赠送余额: ¥10.00')
    await zh.unmount()
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

  test('the remembered figure paints first, a live read replaces it, and a failed revalidation keeps it', async () => {
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

    resetPlatformBalance()
    globalThis.localStorage.clear()
    remember(WIRE_BALANCE)
    stubRoute({ ok: false })
    const Failed = makeBalanceCapsule(asClientCtx(new TestClientCtx({ locale: 'en' })), kit)
    const failed = await mount(h(Failed, {}))
    assert.equal(query(failed.container, '.lc-ov-balance-value')?.textContent, '$12.50')
    await flush()
    assert.equal(query(failed.container, '.lc-ov-balance-value')?.textContent, '$12.50', 'the miss changes nothing')
    await failed.unmount()
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
})
