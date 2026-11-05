import { createElement as h } from 'react'
import assert from 'node:assert/strict'
import { describe, test, vi } from 'vitest'
import { CommsEvent, CommsEventDetail, DelegationEvent } from '../../../src/client/components/commsEvent'
import { makeRichText } from '../../../src/client/components/richText'
import type { CommsAgent } from '../../../src/client/commsModel'
import type { CommsRow } from '../../../src/client/fleetDetail'
import type { FleetMessage } from '../../../src/shared/types'
import { click, makeKit, mount, query, queryAll, text } from '../helpers/kit'

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
