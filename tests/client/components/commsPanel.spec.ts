// CommsPanel — the on-demand cross-session message scan: the trigger, progress, staleness,
// per-agent filtering, and the merged timeline.

import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi, expect } from 'vitest'
import { CommsPanel, type CommsPanelProps } from '../../../src/client/components/commsPanel'
import type { FleetDetailState } from '../../../src/client/fleetModel'
import type { AgentNode } from '../../../src/client/agentTree'
import type { CommsRow } from '../../../src/client/fleetDetail'
import type { FleetDetail } from '../../../src/shared/types'
import { DICT_EN } from '../../../src/client/i18n'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'
import { act } from 'react'

const kit = makeKit()

function nodeOf(id: string, over: Partial<AgentNode> = {}): AgentNode {
  return {
    id, label: id, depth: 0, family: 0, isCurrent: false, running: false, completed: false,
    subagent: false, updatedAt: 0, head: null, requests: 0, billed: null, costUsage: null,
    durationMs: null, identity: null, ...over,
  }
}

const NODES = [nodeOf('root', { updatedAt: 5 }), nodeOf('w1', { updatedAt: 3 })]

const COMMS: CommsRow[] = [
  { key: 'w1:9', to: 'w1', time: 1_700_000_000_000, kind: 'relay', from: 'root', text: 'how far along?' },
  { key: 'root:4', to: 'root', time: 0, kind: 'settled', from: 'w1', text: 'Background subagent w1 finished and will do no further work unless you send it more.' },
  { key: 'w1:3', to: 'w1', time: 90, kind: 'mailbox', fromName: 'lead', text: 'old school' },
  // A relay carrying the mailbox-era sender name.
  { key: 'w1:2', to: 'w1', time: 80, kind: 'relay', from: 'root', fromName: 'lead', text: 'named relay' },
  // Neither an id nor a name: the bare arrow introduces the recipient.
  { key: 'w1:1', to: 'w1', time: 60, kind: 'relay', text: 'anonymous' },
]

function detailsOf(over: Partial<FleetDetailState> = {}): FleetDetailState {
  return {
    landed: new Map(),
    pending: new Set(),
    scanned: new Set(),
    request: vi.fn(),
    scan: vi.fn(),
    refresh: vi.fn(),
    ...over,
  }
}

function propsOf(over: Partial<CommsPanelProps> = {}): CommsPanelProps {
  return {
    nodes: NODES,
    details: detailsOf(),
    comms: COMMS,
    labelOf: id => ({ root: 'Main Agent', w1: 'worker-bee' })[id] ?? id,
    onPin: () => {},
    t: kit.t,
    fmt: kit.fmt,
    ...over,
  }
}

describe('CommsPanel — the scan lifecycle', () => {
  test('the collapsed state offers the scan; the button scans every node', async () => {
    const details = detailsOf()
    const m = await mount(h(CommsPanel, propsOf({ details })))
    const scanBtn = query(m.container, '.lc-comms-scan')
    assert.ok(text(scanBtn).includes('2'))
    await click(scanBtn)
    expect(details.scan).toHaveBeenCalledWith(NODES)
    await m.unmount()
  })

  test('progress shows while reads are in flight, then the row count', async () => {
    const details = detailsOf({
      landed: new Map([['root', { detail: null, updatedAt: 5 }]]),
      pending: new Set(['w1']),
      scanned: new Set(['root', 'w1']),
    })
    const m = await mount(h(CommsPanel, propsOf({ details, comms: [] })))
    assert.ok(text(m.container).includes('1/2'))
    await m.unmount()

    const done = detailsOf({
      landed: new Map([
        ['root', { detail: null, updatedAt: 5 }],
        ['w1', { detail: { messages: [], truncated: false }, updatedAt: 3 }],
      ]),
      scanned: new Set(['root', 'w1']),
    })
    const m2 = await mount(h(CommsPanel, propsOf({ details: done })))
    assert.ok(text(m2.container).includes(DICT_EN['fleet.comms.rows'].replace('{n}', '5')))
    await m2.unmount()
  })

  test('a scanned-then-moved session flags the panel stale; rescan refreshes', async () => {
    const details = detailsOf({
      landed: new Map([['root', { detail: null, updatedAt: 4 }]]),
      scanned: new Set(['root']),
    })
    const m = await mount(h(CommsPanel, propsOf({ details, nodes: [nodeOf('root', { updatedAt: 5 })] })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.comms.stale']))
    const buttons = queryAll(m.container, '.lc-inspector-btn')
    await click(buttons[0])
    expect(details.refresh).toHaveBeenCalled()
    await m.unmount()
  })

  test('a scanned family with no messages says so', async () => {
    const details = detailsOf({
      landed: new Map([['root', { detail: null, updatedAt: 5 }]]),
      scanned: new Set(['root']),
    })
    const m = await mount(h(CommsPanel, propsOf({ details, comms: [] })))
    assert.ok(text(m.container).includes(DICT_EN['fleet.comms.empty']))
    await m.unmount()
  })
})

describe('CommsPanel — the timeline', () => {
  const landedAll = new Map<string, { detail: FleetDetail | null; updatedAt: number }>([
    ['root', { detail: { messages: [], truncated: false }, updatedAt: 5 }],
    ['w1', { detail: { messages: [], truncated: true }, updatedAt: 3 }],
  ])
  const scannedAll = new Set(['root', 'w1'])

  test('rows render time, kind, parties, and text; parties pin', async () => {
    const pins: (string | null)[] = []
    const m = await mount(h(CommsPanel, propsOf({ details: detailsOf({ landed: landedAll, scanned: scannedAll }), onPin: id => { pins.push(id) } })))
    const rows = queryAll(m.container, '.lc-comms-row')
    assert.equal(rows.length, 5)
    assert.ok(text(rows[0]).includes('relay'))
    assert.ok(text(rows[0]).includes('Main Agent'))
    assert.ok(text(rows[0]).includes('worker-bee'))
    assert.ok(text(rows[0]).includes('how far along?'))
    // A zero instant reads as a dash; the settled boilerplate renders localized.
    assert.ok(text(rows[1]).includes('—'))
    assert.ok(text(rows[1]).includes('settled'))
    assert.ok(text(rows[1]).includes(DICT_EN['fleet.settled.finished']))
    assert.ok(!text(rows[1]).includes('Background subagent'))
    // An unrecognized settled phrasing falls back to the raw text.
    const odd = await mount(h(CommsPanel, propsOf({
      details: detailsOf({ landed: landedAll, scanned: scannedAll }),
      comms: [{ key: 'w1:1', to: 'w1', time: 1, kind: 'settled', from: 'root', text: 'a brand-new phrasing' }],
    })))
    assert.ok(text(odd.container).includes('a brand-new phrasing'))
    await odd.unmount()
    // The mailbox row names its sender.
    assert.ok(text(rows[2]).includes('lead'))
    // The truncation note rides any landed detail's flag.
    assert.ok(text(m.container).includes(DICT_EN['fleet.comms.truncated']))

    const peers = queryAll(rows[0], '.lc-comms-peer')
    await click(peers[0])
    await click(peers[1])
    assert.deepEqual(pins, ['root', 'w1'])
    await m.unmount()
  })

  test('the agent filter narrows the rows', async () => {
    const m = await mount(h(CommsPanel, propsOf({ details: detailsOf({ landed: landedAll, scanned: scannedAll }) })))
    const select = query(m.container, 'select') as HTMLSelectElement
    // The filter lists every involved agent plus the all entry.
    assert.ok(text(select).includes('Main Agent'))
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, 'root')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(queryAll(m.container, '.lc-comms-row').length, 3)
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set?.call(select, '')
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(queryAll(m.container, '.lc-comms-row').length, 5)
    await m.unmount()
  })

  test('no rows yet hides the filter and the truncation note', async () => {
    const details = detailsOf({
      landed: new Map([['root', { detail: { messages: [], truncated: false }, updatedAt: 5 }]]),
      scanned: new Set(['root']),
    })
    const m = await mount(h(CommsPanel, propsOf({ details, comms: [] })))
    assert.equal(queryAll(m.container, 'select').length, 0)
    assert.ok(!text(m.container).includes(DICT_EN['fleet.comms.truncated']))
    await m.unmount()
  })
})
