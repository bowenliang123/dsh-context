import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { afterEach, describe, test, vi } from 'vitest'
import { PulseEvents } from '../../../src/client/components/pulseEvents'
import { makeRichText } from '../../../src/client/components/richText'
import type { CommsAgent } from '../../../src/client/commsModel'
import type { CommsRow, FleetDelegationRow } from '../../../src/client/fleetDetail'
import { pulseEventItemsOf, type PulseTimelineItem } from '../../../src/client/pulseModel'
import { makeKit, mount, query, queryAll, until } from '../helpers/kit'
import { restoreLayout, stubRowRects } from '../helpers/layout'

const kit = makeKit()
const rich = makeRichText(kit)

const AGENTS = new Map<string, CommsAgent>([
  ['root', { id: 'root', name: 'Lead', role: 'lead', self: true, hue: 'red' }],
  ['child', { id: 'child', name: 'Worker', role: 'subagent', self: false, hue: 'blue' }],
])

function agentOf(id: string): CommsAgent {
  return AGENTS.get(id) ?? { id, name: id, role: 'other', self: false, hue: 'gray' }
}

function detailsOf(): Parameters<typeof PulseEvents>[0]['details'] {
  return {
    summary: null,
    landed: new Map(),
    historyLanded: new Map(),
    fullLanded: new Map(),
    pending: new Set(),
    historyPending: new Set(),
    fullPending: new Set(),
    facts: new Map(),
    family: { total: 0, loaded: 0, pending: 0, failed: 0, messages: null, delegations: null },
    requestFamily: vi.fn(),
    requestFull: vi.fn(),
    prioritize: vi.fn(),
    retryFamily: vi.fn(),
  }
}

function rowsOf(count: number): CommsRow[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `child:${index + 1}:${(index + 1) * 1000}:relay`,
    to: 'child',
    seq: index + 1,
    time: (index + 1) * 1000,
    kind: 'relay' as const,
    from: 'root',
    text: `event ${index}`,
  }))
}

function propsOf(events: PulseTimelineItem[], over: Partial<Parameters<typeof PulseEvents>[0]> = {}): Parameters<typeof PulseEvents>[0] {
  return {
    events,
    scopedEvents: events,
    details: detailsOf(),
    kind: 'all',
    query: '',
    selectedAgent: null,
    selectedItem: undefined,
    agentOf,
    onKind: () => {},
    onQuery: () => {},
    onSelectEvent: () => {},
    onSelectDelegation: () => {},
    onClose: () => {},
    onSelectAgent: () => {},
    onClearSelection: () => {},
    onOpen: () => {},
    onEnter: () => {},
    rich,
    t: kit.t,
    ...over,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  restoreLayout()
})

describe('PulseEvents — stream interactions', () => {
  test('the kind filters and both row kinds forward their picks', async () => {
    const delegations: FleetDelegationRow[] = [{ key: 'root:1:child', from: 'root', to: 'child', seq: 1, time: 500, mode: 'continuable', label: 'own task' }]
    const rows = rowsOf(2)
    const events = pulseEventItemsOf(rows, delegations)
    const kinds: string[] = []
    const messages: string[] = []
    const picked: string[] = []
    const m = await mount(h(PulseEvents, propsOf(events, {
      onKind: kind => { kinds.push(kind) },
      onSelectEvent: row => { messages.push(row.key) },
      onSelectDelegation: delegation => { picked.push(delegation.key) },
    })))
    const filter = queryAll(m.container, '.lc-pulse-event-tools .lc-gran-btn')
    await act(async () => { filter[1].click() })
    assert.deepEqual(kinds, ['message'])
    await act(async () => { query(m.container, '[data-comms-key="child:1:1000:relay"] .lc-comms-hit').click() })
    assert.deepEqual(messages, ['child:1:1000:relay'])
    await act(async () => { query(m.container, '[data-comms-key="root:1:child"] .lc-comms-hit').click() })
    assert.deepEqual(picked, ['root:1:child'])
    await m.unmount()
  })

  test('an off-window selection estimates its target once from the measured pitch and pads the window after scrolling', async () => {
    stubRowRects('lc-comms-event', () => 60, 4)
    const rows = rowsOf(70)
    const events = pulseEventItemsOf(rows, [])
    const m = await mount(h(PulseEvents, propsOf(events)))
    const list = query<HTMLElement>(m.container, '.lc-pulse-event-list')
    Object.defineProperties(list, {
      clientHeight: { configurable: true, value: 640 },
      scrollTop: { configurable: true, value: 0, writable: true },
    })
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll(m.container, '[data-comms-key]').length < 70, 'the stream never windowed')
    list.scrollTop = 1000
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll<HTMLElement>(m.container, '.lc-pulse-event-list > li[aria-hidden]').length === 2, 'both window pads never rendered')
    const [topPad] = queryAll<HTMLElement>(m.container, '.lc-pulse-event-list > li[aria-hidden]')
    assert.ok(Number.parseFloat(topPad.style.height) > 0)
    list.scrollTop = 0
    await act(async () => { list.dispatchEvent(new Event('scroll')) })
    await until(() => queryAll<HTMLElement>(m.container, '.lc-pulse-event-list > li[aria-hidden]').length === 1, 'the window never returned to the top')
    const frames: FrameRequestCallback[] = []
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      frames.push(callback)
      return frames.length
    })
    await m.update(h(PulseEvents, propsOf(events, { selectedItem: events[50] })))
    assert.equal(list.scrollTop, 50 * 64, 'the off-window row is estimated from the measured pitch')
    assert.ok(frames.length > 0, 'the reveal scheduled a frame')
    await act(async () => { while (frames.length > 0) frames.shift()?.(0) })
    list.scrollTop = 51 * 64
    await m.update(h(PulseEvents, propsOf(events, { selectedItem: events[51] })))
    assert.equal(list.scrollTop, 51 * 64, 'an estimate already at its target does not scroll again')
    await m.unmount()
  })
})
