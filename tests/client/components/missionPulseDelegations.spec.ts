import { act, createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { MissionPulse } from '../../../src/client/components/missionPulse'
import { makeRichText } from '../../../src/client/components/richText'
import type { CommsRow } from '../../../src/client/fleetDetail'
import { click, makeKit, mount, query, queryAll, text, typeText } from '../helpers/kit'

const kit = makeKit()
const graph = () => null

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

describe('MissionPulse delegation records', () => {
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
    const pulse = (comms: CommsRow[]) => h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms,
      delegations: [delegation],
      agents,
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    })
    const mounted = await mount(pulse(rows))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    assert.ok(query(mounted.container, '[data-comms-key="child:2:2000:relay"]').className.includes('lc-comms-event-open'))
    const scroller = query<HTMLElement>(mounted.container, '[data-sequence-scroller]')
    Object.defineProperties(scroller, {
      clientWidth: { configurable: true, value: 200 },
      scrollWidth: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 120, writable: true },
    })
    assert.equal(scroller.scrollLeft, 0)
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.equal(query<HTMLElement>(mounted.container, '.lc-pulse-lane-labels-rows').style.transform, 'translateY(-120px)')
    const laneButton = query<HTMLButtonElement>(mounted.container, '[data-agent="child"]')
    scroller.scrollTop = 0
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 136)
    Object.defineProperty(scroller, 'clientHeight', { configurable: true, value: 1000 })
    scroller.scrollTop = 120
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 68)
    scroller.scrollTop = 0
    await act(async () => { laneButton.dispatchEvent(new FocusEvent('focusin', { bubbles: true })) })
    assert.equal(scroller.scrollTop, 0)
    scroller.scrollLeft = 300
    await mounted.update(pulse([...rows]))
    assert.equal(scroller.scrollLeft, 300)
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.deepEqual(events.map(event => event.dataset.eventKey), ['root:4:child', 'child:1:1000:relay', 'child:2:2000:relay'])
    assert.equal(events[0].dataset.record, 'delegation')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-a'), 'red')
    assert.equal(events[0].style.getPropertyValue('--lc-ch-b'), 'blue')
    assert.equal(queryAll(mounted.container, '.lc-pulse-lane-baseline').length, 2)
    const laneLabel = query<HTMLElement>(mounted.container, '[data-lane-label="root"]')
    const laneTrack = query<HTMLElement>(mounted.container, '[data-lane="root"]')
    assert.equal(laneLabel.style.getPropertyValue('--lc-lane-hue'), 'red')
    assert.equal(laneTrack.style.getPropertyValue('--lc-lane-hue'), 'red')
    await act(async () => { laneLabel.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(laneLabel.className.includes('lc-pulse-lane-hover'))
    assert.ok(laneTrack.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneLabel.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!laneLabel.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneTrack.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })) })
    assert.ok(laneTrack.className.includes('lc-pulse-lane-hover'))
    await act(async () => { laneTrack.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })) })
    assert.ok(!laneTrack.className.includes('lc-pulse-lane-hover'))
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
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await act(async () => { query(edge, '.lc-pulse-edge-hit').dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await act(async () => { edge.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })) })
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('first'))
    const [firstButton, latestButton] = queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-sequence-actions button')
    assert.ok(firstButton.className.includes('lc-gran-on'))
    assert.ok(!latestButton.className.includes('lc-gran-on'))
    scroller.scrollLeft = 800
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(!firstButton.className.includes('lc-gran-on'))
    assert.ok(latestButton.className.includes('lc-gran-on'))
    scroller.scrollLeft = 400
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(latestButton.className.includes('lc-gran-on'))
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 1000 })
    await act(async () => { scroller.dispatchEvent(new Event('scroll')) })
    assert.ok(latestButton.className.includes('lc-gran-on'))
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 200 })
    await click(firstButton)
    assert.equal(scroller.scrollLeft, 0)
    assert.ok(firstButton.className.includes('lc-gran-on'))
    await click(latestButton)
    assert.equal(scroller.scrollLeft, 1000)
    assert.ok(latestButton.className.includes('lc-gran-on'))
    await click(events[0])
    const inspector = query(mounted.container, '.lc-pulse-delegation-detail')
    assert.ok(text(inspector).includes('Map host boundaries'))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.delegationNote')))
    assert.ok(text(inspector).includes(kit.t('fleet.pulse.mode.continuable')))
    await click(query(inspector, '.lc-comms-detail-close'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('second'))
    await mounted.unmount()
  })

  test('filters, searches, and opens durable delegations without a roster', async () => {
    const open = vi.fn()
    const enter = vi.fn()
    const details = makeDetails()
    details.fullPending.add('peer')
    details.landed.set('child', {
      updatedAt: 1,
      detail: { messages: [], truncated: false, initialPrompt: 'Child deep research prompt' },
    })
    const delegations = [
      { key: 'parent:1:child', time: 500, seq: 1, from: 'parent', to: 'child', mode: 'one-shot' as const },
      { key: 'bare:3:barechild', time: 550, seq: 3, from: 'bare', to: 'barechild', mode: 'one-shot' as const },
      { key: 'other:2:peer', time: 600, seq: 2, from: 'other', to: 'peer', mode: 'external' as const, label: 'Peer duty' },
    ]
    const mounted = await mount(h(MissionPulse, {
      graph,
      forest: null,
      team: null,
      details,
      landedDetails: new Map(),
      comms: [],
      delegations,
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      currency: 'usd',
      onOpen: open,
      onEnter: enter,
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const events = queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')
    assert.equal(events.length, 3)
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '.lc-pulse-event-list .lc-comms-event').map(el => el.dataset.commsKey),
      ['other:2:peer', 'bare:3:barechild', 'parent:1:child'],
    )
    assert.equal(queryAll(mounted.container, '[data-comms-key="bare:3:barechild"] .lc-comms-preview-text').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('Peer duty'))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.comms.detail.loading')))
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes(kit.t('fleet.tasks.brief')))
    const chips = queryAll<HTMLButtonElement>(mounted.container, '.lc-pulse-event-tools .lc-fleet-filters button')
    assert.ok(text(chips[3]).includes(kit.t('fleet.comms.kind.delegation') + '3'))
    await click(chips[1])
    assert.equal(queryAll(mounted.container, '.lc-pulse-event-list .lc-comms-event').length, 0)
    await click(chips[3])
    await click(chips[0])
    await click(queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')[0])
    assert.deepEqual(details.requestFull.mock.calls, [['child']])
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
    await click(queryAll<HTMLElement>(mounted.container, '.lc-pulse-event')[0])
    assert.ok(text(query(mounted.container, '.lc-pulse-inspector')).includes('Peer duty'))
    const laneSearch = query<HTMLInputElement>(mounted.container, '.lc-pulse-timeline .lc-pulse-search')
    await typeText(laneSearch, 'peer')
    assert.deepEqual(
      queryAll<HTMLElement>(mounted.container, '[data-lane-label]').map(el => el.dataset.laneLabel),
      ['other', 'peer'],
    )
    assert.ok(query(mounted.container, '[data-lane-label="peer"]').className.includes('lc-pulse-lane-match'))
    assert.ok(text(query(mounted.container, '[data-lane-label="other"]')).includes(kit.t('fleet.pulse.linked')))
    await typeText(laneSearch, '')
    const search = query<HTMLInputElement>(mounted.container, '.lc-pulse-event-tools .lc-pulse-search')
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
    await typeText(search, 'deep research')
    assert.equal(query(mounted.container, '.lc-pulse-event').dataset.eventKey, 'parent:1:child')
    await typeText(search, 'no matching record')
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 0)
    assert.ok(text(query(mounted.container, '.lc-pulse-timeline')).includes(kit.t('fleet.pulse.emptyTimeline')))
    await mounted.unmount()
  })
})
