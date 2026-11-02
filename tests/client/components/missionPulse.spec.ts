import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { MissionPulse } from '../../../src/client/components/missionPulse'
import { makeRichText } from '../../../src/client/components/richText'
import type { CommsRow } from '../../../src/client/fleetDetail'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

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

  test('lets all activity escape the default latest-burst focus', async () => {
    const rows = Array.from({ length: 201 }, (_, index): CommsRow => ({
      key: `w1:${index + 1}:${1000 + index}:relay`,
      to: 'w1',
      seq: index + 1,
      time: 1000 + index,
      kind: 'relay',
      from: 'root',
      text: `event ${index + 1}`,
    }))
    const mounted = await mount(h(MissionPulse, {
      forest: null,
      team: null,
      details: makeDetails(),
      landedDetails: new Map(),
      comms: rows,
      agents: new Map(),
      titles: new Map(),
      attested: new Map(),
      focusMember: null,
      onOpen: () => {},
      onEnter: () => {},
      rich: makeRichText(kit),
      t: kit.t,
    }))
    const pressed = queryAll<HTMLElement>(mounted.container, '.lc-pulse-histogram button[aria-pressed="true"]')
    assert.equal(pressed.length, 1)
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, Number(pressed[0].dataset.count))
    await click(pressed[0])
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 201)
    assert.equal(queryAll(mounted.container, '.lc-pulse-histogram button[aria-pressed="true"]').length, 0)
    await click(pressed[0])
    await click(query(mounted.container, '.lc-pulse-timeline .lc-pulse-quiet'))
    assert.equal(queryAll(mounted.container, '.lc-pulse-event').length, 201)
    assert.equal(queryAll(mounted.container, '.lc-pulse-histogram button[aria-pressed="true"]').length, 0)
    await mounted.unmount()
  })
})
