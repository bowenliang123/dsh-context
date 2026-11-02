import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { MissionPulse } from '../../../src/client/components/missionPulse'
import { makeRichText } from '../../../src/client/components/richText'
import type { CommsRow } from '../../../src/client/fleetDetail'
import { click, makeKit, mount, query, queryAll, text, typeText } from '../helpers/kit'

const kit = makeKit()

function makeDetails(fullLanded = new Map()) {
  return {
    landed: new Map(),
    historyLanded: new Map(),
    fullLanded,
    pending: new Set<string>(),
    historyPending: new Set<string>(),
    fullPending: new Set<string>(),
    request: vi.fn(),
    requestHistory: vi.fn(),
    requestFull: vi.fn(),
  }
}

describe('MissionPulse boundary parties', () => {
  test('renders unknown parties and keeps the excerpt when the full log no longer contains the event', async () => {
    const row: CommsRow = {
      key: 'unknown-target:1:1000:relay',
      to: 'unknown-target',
      seq: 1,
      time: 1000,
      kind: 'relay',
      from: 'unknown-sender',
      text: 'outside excerpt…',
      clipped: true,
    }
    const selfRow: CommsRow = {
      key: 'self:2:500:relay',
      to: 'self',
      seq: 2,
      time: 500,
      kind: 'relay',
      from: 'self',
      text: 'note to self',
    }
    const details = makeDetails(new Map([['unknown-target', { messages: [{ seq: 99, time: 2000, kind: 'relay' as const, text: 'unrelated' }], truncated: false }]]))
    const mounted = await mount(h(MissionPulse, {
      forest: null,
      team: null,
      details,
      landedDetails: new Map(),
      comms: [row, selfRow],
      delegations: [],
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-label').length, 3)
    assert.equal(query(mounted.container, '[data-pulse-stat="agents"]').textContent, '3')
    await click(query(mounted.container, '.lc-pulse-event'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('outside excerpt…'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.comms.detail.excerptOnly')))
    await mounted.unmount()
  })

  test('renders durable delegations in natural order with colored solid links and useful inspection', async () => {
    const rows: CommsRow[] = [
      { key: 'child:2:2000:relay', to: 'child', seq: 2, time: 2000, kind: 'relay', from: 'root', text: 'second' },
      { key: 'child:1:1000:relay', to: 'child', seq: 1, time: 1000, kind: 'relay', from: 'root', text: 'first' },
    ]
    const delegation = {
      key: 'root:4:child',
      time: 500,
      seq: 4,
      from: 'root',
      to: 'child',
      mode: 'continuable' as const,
      label: 'Map host boundaries',
    }
    const agents = new Map([
      ['root', { id: 'root', name: 'Lead', role: 'lead' as const, self: true, hue: 'red' }],
      ['child', { id: 'child', name: 'Child', role: 'subagent' as const, self: false, hue: 'blue' }],
    ])
    const mounted = await mount(h(MissionPulse, {
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: rows,
      delegations: [delegation],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.deepEqual(events.map(event => event.dataset.eventKey), ['root:4:child', 'child:1:1000:relay', 'child:2:2000:relay'])
    assert.equal(events[0].dataset.record, 'delegation')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-a'), 'red')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-b'), 'blue')
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-baseline').length, 2)
    for (const line of queryAll(mounted.container, '.lc-pulse-edge-line')) {
      assert.equal(line.getAttribute('stroke'), 'red')
      assert.equal(line.getAttribute('stroke-dasharray'), null)
    }
    const edge = query(mounted.container, '[data-edge-key="child:1:1000:relay"]')
    await act(async () => { edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(events[1].className.includes('lc-pulse-event-hover'))
    assert.ok(edge.getAttribute('class')!.includes('lc-pulse-arrow-hover'))
    await act(async () => { edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    assert.ok(!edge.getAttribute('class')!.includes('lc-pulse-arrow-hover'))
    const otherEdge = query(mounted.container, '[data-edge-key="child:2:2000:relay"]')
    await act(async () => {
      edge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      otherEdge.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
      edge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }))
    })
    assert.ok(events[2].className.includes('lc-pulse-event-hover'))
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    await act(async () => { otherEdge.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    await act(async () => {
      edge.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      otherEdge.dispatchEvent(new FocusEvent('focusin', { bubbles: true }))
      edge.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    assert.ok(events[2].className.includes('lc-pulse-event-hover'))
    assert.ok(!events[1].className.includes('lc-pulse-event-hover'))
    await act(async () => { otherEdge.dispatchEvent(new FocusEvent('focusout', { bubbles: true })) })
    assert.ok(!events[2].className.includes('lc-pulse-event-hover'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.pulse.selectEvent')))
    await act(async () => { query(edge, '.lc-pulse-edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.pulse.selectEvent')))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    const scroller = query<HTMLElement>(mounted.container, '[data-sequence-scroller]')
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 1000 },
    })
    await click(queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-sequence-actions button')[0])
    assert.equal(scroller.scrollLeft, 0)
    await click(queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-sequence-actions button')[1])
    assert.equal(scroller.scrollLeft, 1000)
    await click(events[0])
    const inspector = query(mounted.container, '.lc-pulse-delegation-detail')
    assert.ok(text(inspector).includes('Map host boundaries'))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.delegationNote')))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.mode.continuable')))
    await click(query(inspector, '.lc-comms-detail-close'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.pulse.selectEvent')))
    await mounted.unmount()
  })

  test('filters, searches, and opens durable delegations without a roster', async () => {
    const open = vi.fn()
    const enter = vi.fn()
    const delegations = [
      { key: 'parent:1:child', time: 500, seq: 1, from: 'parent', to: 'child', mode: 'one-shot' as const },
      { key: 'other:2:peer', time: 600, seq: 2, from: 'other', to: 'peer', mode: 'external' as const, label: 'Peer duty' },
    ]
    const mounted = await mount(h(MissionPulse, {
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: [],
      delegations,
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      onOpen: open,
      onEnter: enter,
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.equal(events.length, 2)
    await click(events[0])
    const actions = queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-delegation-actions button')
    await click(actions[0])
    assert.equal(query(mounted.container, '[data-agent="child"]').getAttribute('aria-pressed'), 'true')
    assert.ok(text(actions[0]).includes(kit.t('fleet.comms.detail.unfilter')))
    await click(actions[0])
    assert.equal(query(mounted.container, '[data-agent="child"]').getAttribute('aria-pressed'), 'false')
    await click(actions[1])
    await click(actions[2])
    assert.deepEqual(open.mock.calls, [['child']])
    assert.deepEqual(enter.mock.calls, [['child']])
    await click(events[0])
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.pulse.selectEvent')))
    const search = query<HTMLInputElement>(mounted.container, '.lc-pulse-search')
    await typeText(search, 'peer duty')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 1)
    assert.equal(query(mounted.container, '.lc-pulse-event').dataset.eventKey, 'other:2:peer')
    await click(query(mounted.container, '.lc-pulse-event'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-delegation-actions button').length, 1)
    assert.deepEqual(open.mock.calls, [['child']])
    assert.deepEqual(enter.mock.calls, [['child']])
    await typeText(search, 'parent')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 1)
    assert.equal(query(mounted.container, '.lc-pulse-event').dataset.eventKey, 'parent:1:child')
    await typeText(search, 'no matching record')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-timeline')).includes(kit.t('fleet.pulse.emptyTimeline')))
    await mounted.unmount()
  })
})
