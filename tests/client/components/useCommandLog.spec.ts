import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement, useState } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import { type Command } from '../../../src/client/commands'
import { type CommandPageFetcher } from '../../../src/client/commandPages'
import { useCommandLog, FILL_MAX_KNOWN, type CommandLog } from '../../../src/client/components/useCommandLog'
import { type CommandPage } from '../../../src/shared/types'
import { mount, until, click, makeKit, query, queryAll, text, typeText } from '../helpers/kit'
import { MissionPulse } from '../../../src/client/components/missionPulse'
import { makeRichText } from '../../../src/client/components/richText'
import { type CommsRow, type FleetDelegationRow } from '../../../src/client/fleetDetail'
import { makeFleetView } from '../../../src/client/components/fleetView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { DICT_EN } from '../../../src/client/i18n'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { requestFleetMemberFocus, currentFleetMemberFocus } from '../../../src/client/viewFocus'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { makeScroller, mountInScroller, projectionsFor, richTimeline } from './contextViewHarness'
import { PulseEvents } from '../../../src/client/components/pulseEvents'
import { type CommsAgent } from '../../../src/client/commsModel'
import { pulseEventItemsOf, type PulseTimelineItem } from '../../../src/client/pulseModel'
import { restoreLayout, stubRowRects } from '../helpers/layout'

describe('useCommandLog', () => {

let log: CommandLog | null = null

function cmd(seq: number, body: string): Command {
  return {
    seq,
    time: 1_700_000_000_000 + seq,
    tool: 'bash',
    cmd: body,
    start: 1_700_000_000_000 + seq,
    end: 1_700_000_000_000 + seq + 10,
    status: 'completed',
    err: false,
  }
}

function Probe(props: {
  commands: Command[]
  floor?: number
  fetchOlder?: CommandPageFetcher
  scope?: string
}): ReactElement {
  log = useCommandLog(props.commands, props.floor, props.fetchOlder, props.scope)
  return h('div', null, h('span', { 'data-k': 'records' }, JSON.stringify(log.records.map(rec => [rec.seq, rec.cmd]))))
}

function bodies(): string[] {
  return log === null ? [] : log.records.map(rec => rec.cmd ?? '')
}

function page(commands: Command[], atStart: boolean, total: number): CommandPage {
  return { commands, atStart, total }
}

afterEach(() => {
  vi.restoreAllMocks()
  log = null
})

describe('useCommandLog scope isolation', () => {
  test('switching session resets the known ledger and refills from the new floor', async () => {
    const fetchPage = async (beforeSeq: number): Promise<CommandPage | null> => page([cmd(beforeSeq - 1, 'old ' + String(beforeSeq))], true, 1)
    const m = await mount(h(Probe, {
      commands: [cmd(10, 'A10'), cmd(12, 'A12')],
      floor: 9,
      fetchOlder: fetchPage,
      scope: 'A',
    }))
    try {
      await until(() => log?.status === 'done', 'session A never filled')
      assert.ok(bodies().includes('old 10'), 'A read below its floor')
      assert.ok(bodies().includes('A10'))
      const bCalls: number[] = []
      const fetchB = async (beforeSeq: number): Promise<CommandPage | null> => {
        bCalls.push(beforeSeq)
        return page([cmd(beforeSeq - 1, 'new ' + String(beforeSeq))], true, 1)
      }
      await m.update(h(Probe, {
        commands: [cmd(10, 'B10'), cmd(12, 'B12')],
        floor: 9,
        fetchOlder: fetchB,
        scope: 'B',
      }))
      await until(() => log?.status === 'done', 'session B never filled')
      assert.deepEqual(bodies().sort(), ['B10', 'B12', 'new 10'], 'only session B records remain')
      assert.deepEqual(bCalls, [10], 'the fill restarted from B’s floor')
      assert.equal(bodies().includes('old 10'), false, 'the old page content never merged into B')
      assert.equal(bodies().includes('A10'), false, 'the old served content never merged into B')
    } finally {
      await m.unmount()
    }
  })

  test('an in-flight page from the previous session never lands', async () => {
    let resolveOld: ((value: CommandPage | null) => void) | undefined
    const oldPage = (): Promise<CommandPage | null> => new Promise((resolve) => { resolveOld = resolve })
    const fetchB = async (): Promise<CommandPage | null> => page([cmd(8, 'B8')], true, 1)
    const m = await mount(h(Probe, {
      commands: [cmd(10, 'A10')],
      floor: 9,
      fetchOlder: oldPage,
      scope: 'A',
    }))
    try {
      await until(() => resolveOld !== undefined, 'the old fill never started')
      await m.update(h(Probe, {
        commands: [cmd(10, 'B10')],
        floor: 9,
        fetchOlder: fetchB,
        scope: 'B',
      }))
      await until(() => log?.status === 'done', 'session B never filled')
      await act(async () => { resolveOld?.(page([cmd(8, 'A8')], true, 1)) })
      assert.equal(bodies().includes('A8'), false, 'the stale page was dropped')
      assert.deepEqual(bodies().sort(), ['B10', 'B8'])
    } finally {
      await m.unmount()
    }
  })

  test('a fetcher identity change resets the ledger; losing and regaining the pager does not', async () => {
    const fetchA = async (): Promise<CommandPage | null> => page([cmd(8, 'A8')], true, 1)
    const fetchB = async (): Promise<CommandPage | null> => page([cmd(8, 'B8')], true, 1)
    const m = await mount(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: fetchA }))
    try {
      await until(() => log?.status === 'done', 'A never filled')
      await m.update(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: undefined }))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      await m.update(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: fetchB }))
      assert.equal(log?.status, 'done', 'the regained pager keeps the completed fill')
      assert.deepEqual(bodies().sort(), ['A10', 'A8'])
    } finally {
      await m.unmount()
    }
  })

  test('a fetcher identity change with no explicit scope resets the ledger', async () => {
    const fetchA = async (): Promise<CommandPage | null> => page([cmd(8, 'A8')], true, 1)
    const fetchB = async (): Promise<CommandPage | null> => page([cmd(8, 'B8')], true, 1)
    const m = await mount(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: fetchA }))
    try {
      await until(() => log?.status === 'done', 'A never filled')
      await m.update(h(Probe, { commands: [cmd(10, 'B10')], floor: 9, fetchOlder: fetchB }))
      await until(() => log?.status === 'done', 'B never filled')
      assert.deepEqual(bodies().sort(), ['B10', 'B8'], 'the new fetcher never replayed A content')
    } finally {
      await m.unmount()
    }
  })

  test('a rejection from the previous session never lands', async () => {
    let rejectOld: ((reason: unknown) => void) | undefined
    const oldPage = (): Promise<CommandPage | null> => new Promise((_resolve, reject) => { rejectOld = reject })
    const fetchB = async (): Promise<CommandPage | null> => page([cmd(8, 'B8')], true, 1)
    const m = await mount(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: oldPage, scope: 'A' }))
    try {
      await until(() => rejectOld !== undefined, 'the old fill never started')
      await m.update(h(Probe, { commands: [cmd(10, 'B10')], floor: 9, fetchOlder: fetchB, scope: 'B' }))
      await until(() => log?.status === 'done', 'B never filled')
      await act(async () => { rejectOld?.(new Error('late')) })
      assert.equal(log?.status, 'done', 'the stale rejection changed nothing')
      assert.deepEqual(bodies().sort(), ['B10', 'B8'])
    } finally {
      await m.unmount()
    }
  })

  test('a same-seq record from another session never shows the wrong command', async () => {
    const fetchPage = async (): Promise<CommandPage | null> => null
    const m = await mount(h(Probe, {
      commands: [cmd(8, 'A8')],
      floor: 7,
      fetchOlder: fetchPage,
      scope: 'A',
    }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
      assert.deepEqual(bodies(), ['A8'])
      await m.update(h(Probe, {
        commands: [cmd(8, 'B8')],
        floor: 7,
        fetchOlder: fetchPage,
        scope: 'B',
      }))
      await until(() => bodies()[0] === 'B8', 'the same seq kept A’s command')
      assert.equal(bodies().length, 1)
    } finally {
      await m.unmount()
    }
  })

  test('the fill status returns to idle-waiting on a new scope and refetches', async () => {
    const fetchA = async (): Promise<CommandPage | null> => page([cmd(8, 'A8')], true, 1)
    const fetchB = async (): Promise<CommandPage | null> => page([cmd(8, 'B8')], true, 1)
    const m = await mount(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: fetchA, scope: 'A' }))
    try {
      await until(() => log?.status === 'done', 'A never filled')
      await m.update(h(Probe, { commands: [cmd(10, 'B10')], floor: 9, fetchOlder: fetchB, scope: 'B' }))
      await until(() => log?.status === 'loading' || log?.status === 'done', 'B never restarted the fill')
      await until(() => log?.status === 'done', 'B never completed')
      assert.deepEqual(bodies().sort(), ['B10', 'B8'])
    } finally {
      await m.unmount()
    }
  })
})

describe('useCommandLog fill edges', () => {
  test('a rejected page fails the fill and the retry resumes it', async () => {
    const fetchPage = vi.fn<() => Promise<CommandPage | null>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(page([cmd(8, 'recovered')], true, 1))
    const m = await mount(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: fetchPage, scope: 's' }))
    try {
      await until(() => log?.status === 'failed', 'the rejected page never failed the fill')
      await act(async () => { log?.retry() })
      await until(() => log?.status === 'done', 'the retry never resumed the fill')
      assert.deepEqual(bodies().sort(), ['recovered', 'served'])
      assert.equal(fetchPage.mock.calls.length, 2)
    } finally {
      await m.unmount()
    }
  })

  test('losing the pager mid-fill fails instead of hanging', async () => {
    const pending = vi.fn(() => new Promise<CommandPage | null>(() => {}))
    const m = await mount(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: pending, scope: 's' }))
    try {
      await until(() => pending.mock.calls.length === 1, 'the fill never started')
      await m.update(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: undefined, scope: 's' }))
      await until(() => log?.status === 'failed', 'the lost pager never failed the fill')
      assert.deepEqual(bodies(), ['served'], 'the served records stay visible')
    } finally {
      await m.unmount()
    }
  })

  test('empty served or an unknown floor starts nothing and retry is inert outside failed', async () => {
    const fetchPage = vi.fn(async (): Promise<CommandPage | null> => page([], true, 0))
    const idle = await mount(h(Probe, { commands: [], floor: 9, fetchOlder: fetchPage }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      assert.equal(log?.status, 'idle')
      assert.equal(fetchPage.mock.calls.length, 0)
      await act(async () => { log?.retry() })
      assert.equal(log?.status, 'idle', 'the retry guard leaves a non-failed fill alone')
    } finally {
      await idle.unmount()
    }
    const openFloor = await mount(h(Probe, { commands: [cmd(3, 'no floor')], fetchOlder: fetchPage }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      assert.equal(log?.status, 'idle')
      assert.deepEqual(bodies(), ['no floor'])
      assert.equal(fetchPage.mock.calls.length, 0)
    } finally {
      await openFloor.unmount()
    }
  })

  test('merging replays unchanged records and updates a changed same-seq record', async () => {
    const fetchPage = async (): Promise<CommandPage | null> => page([], true, 0)
    const kept = cmd(3, 'stable')
    const m = await mount(h(Probe, { commands: [kept], floor: 4, fetchOlder: fetchPage, scope: 's' }))
    try {
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      await m.update(h(Probe, { commands: [kept], floor: 4, fetchOlder: fetchPage, scope: 's' }))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      assert.deepEqual(bodies(), ['stable'])
      await m.update(h(Probe, { commands: [cmd(3, 'updated')], floor: 4, fetchOlder: fetchPage, scope: 's' }))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
      assert.deepEqual(bodies(), ['updated'])
    } finally {
      await m.unmount()
    }
  })

  test('a repeated page seq keeps the first record and a page without progress fails', async () => {
    const pages = [
      page([cmd(8, 'dup'), cmd(9, 'nine')], false, 4),
      page([cmd(8, 'dup again'), cmd(6, 'six')], true, 4),
    ]
    const calls: number[] = []
    const fetchPage = async (beforeSeq: number): Promise<CommandPage | null> => {
      calls.push(beforeSeq)
      return pages.shift() ?? null
    }
    const m = await mount(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: fetchPage, scope: 's' }))
    try {
      await until(() => log?.status === 'done', 'the fill never completed')
      assert.deepEqual(calls, [10, 8])
      assert.deepEqual(bodies().sort(), ['dup', 'nine', 'served', 'six'], 'the repeated seq never overwrote the known record')
    } finally {
      await m.unmount()
    }

    const stuck = vi.fn(async (): Promise<CommandPage | null> => page([cmd(10, 'same cursor')], false, 4))
    const stuckMount = await mount(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: stuck, scope: 's' }))
    try {
      await until(() => log?.status === 'failed', 'the no-progress page never failed the fill')
      assert.equal(stuck.mock.calls.length, 1, 'no-progress stops after one read')
    } finally {
      await stuckMount.unmount()
    }
  })

  test('pages continue walking down until atStart and count the total', async () => {
    const pages = [
      page([cmd(8, 'eight')], false, 3),
      page([cmd(6, 'six')], true, 3),
    ]
    const fetchPage = async (): Promise<CommandPage | null> => pages.shift() ?? null
    const m = await mount(h(Probe, { commands: [cmd(10, 'ten')], floor: 9, fetchOlder: fetchPage, scope: 's' }))
    try {
      await until(() => log?.status === 'done', 'the fill never reached the log head')
      assert.deepEqual(bodies().sort(), ['eight', 'six', 'ten'])
    } finally {
      await m.unmount()
    }
  })
})


describe('useCommandLog fill budget and cap', () => {
  test('a burst stops at the page budget, reports paused, and resume() walks the rest', async () => {
    const calls: number[] = []
    let seq = 10_000
    const fetchPage = async (beforeSeq: number): Promise<CommandPage | null> => {
      calls.push(beforeSeq)
      seq -= 1
      return page([cmd(seq, 'row ' + String(seq))], false, 5_000)
    }
    const m = await mount(h(Probe, { commands: [cmd(10_001, 'served')], floor: 10_000, fetchOlder: fetchPage, scope: 's' }))
    try {
      await until(() => log?.status === 'paused', 'the burst never paused at the budget')
      assert.equal(calls.length, 12, 'the burst consumed exactly the page budget')
      const pausedRecords = bodies().length
      await act(async () => { log?.resume() })
      await until(() => calls.length > 12, 'resume never fetched again')
      await act(async () => { log?.resume() })
      await until(() => bodies().length > pausedRecords + 1, 'the resumed burst never landed more rows')
      assert.equal(log?.status === 'paused' || log?.status === 'loading' || log?.status === 'done', true)
    } finally {
      await m.unmount()
    }
  })

  test('the known ledger stops at the cap and keeps every listed row', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => cmd(i + 1, 'row ' + String(i + 1)))
    let cursor = 100
    let served = 0
    const fetchPage = async (): Promise<CommandPage | null> => {
      const out: Command[] = []
      for (let i = 0; i < 50; i++) {
        cursor -= 1
        out.push(cmd(cursor, 'old ' + String(cursor)))
      }
      served += out.length
      return { commands: out, atStart: false, total: 10_000 }
    }
    const m = await mount(h(Probe, { commands: rows, floor: 100, fetchOlder: fetchPage, scope: 's' }))
    try {
      await until(() => log?.status === 'paused', 'the burst never paused at the budget')
      for (let round = 0; round < 200 && (log?.records.length ?? 0) < FILL_MAX_KNOWN; round++) {
        await act(async () => { log?.resume() })
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)) })
      }
      const atCap = log?.records.length ?? 0
      assert.ok(atCap >= FILL_MAX_KNOWN, 'the ledger never reached the cap')
      const callsAtCap = served
      await act(async () => { log?.resume() })
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 45)) })
      assert.equal(served, callsAtCap, 'a capped ledger refuses to erase what the list shows')
      assert.equal(log?.records.length, atCap, 'the capped set stays whole')
      assert.equal(log?.status, 'paused', 'the cap parks the walk instead of trimming the listed rows')
    } finally {
      await m.unmount()
    }
  })
})


describe('useCommandLog stale results after a lost pager', () => {
  test('a page landing after the pager was lost changes nothing and a rejection does neither', async () => {
    let resolvePage: ((value: CommandPage | null) => void) | undefined
    let rejectPage: ((reason: unknown) => void) | undefined
    const pending = (): Promise<CommandPage | null> => new Promise((resolve, reject) => { resolvePage = resolve; rejectPage = reject })
    const m = await mount(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: pending, scope: 's' }))
    try {
      await until(() => resolvePage !== undefined, 'the fill never started')
      await m.update(h(Probe, { commands: [cmd(10, 'served')], floor: 9, fetchOlder: undefined, scope: 's' }))
      await until(() => log?.status === 'failed', 'losing the pager never failed the fill')
      await act(async () => { resolvePage?.(page([cmd(8, 'late')], true, 2)) })
      assert.deepEqual(bodies(), ['served'], 'the late page never landed')
      await act(async () => { rejectPage?.(new Error('late rejection')) })
      assert.equal(log?.status, 'failed', 'the late rejection changed nothing')
      assert.deepEqual(bodies(), ['served'])
    } finally {
      await m.unmount()
    }
  })

  test('losing the pager together with the scope keeps the reset ledger idle instead of failed', async () => {
    let resolvePage: ((value: CommandPage | null) => void) | undefined
    const pending = (): Promise<CommandPage | null> => new Promise((resolve) => { resolvePage = resolve })
    const m = await mount(h(Probe, { commands: [cmd(10, 'A10')], floor: 9, fetchOlder: pending, scope: 'A' }))
    try {
      await until(() => resolvePage !== undefined, 'the fill never started')
      await m.update(h(Probe, { commands: [cmd(10, 'B10')], floor: 9, fetchOlder: undefined, scope: 'B' }))
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)) })
      assert.equal(log?.status, 'idle', 'the scope switch reset the ledger and no pager means no new fill')
      await act(async () => { resolvePage?.(page([cmd(8, 'late A')], true, 2)) })
      assert.deepEqual(bodies(), ['B10'], 'the stale page never joined the new scope')
    } finally {
      await m.unmount()
    }
  })
})
})

describe('missionPulseDelegations', () => {

const kit = makeKit()
const graph = () => null

function makeDetails(fullLanded = new Map()) {
  return {
    summary: null,
    landed: new Map(),
    historyLanded: new Map(),
    fullLanded,
    pending: new Set<string>(),
    historyPending: new Set<string>(),
    fullPending: new Set<string>(),
    facts: new Map(),
    family: { total: 0, loaded: 0, pending: 0, failed: 0, messages: null, delegations: null },
    requestFamily: vi.fn(),
    requestFull: vi.fn(),
    prioritize: vi.fn(),
    retryFamily: vi.fn(),
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
})

describe('fleetView', () => {

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetTimelineDetailStores()
})

function selfOnly(id: string) {
  const snapshot = { byId: { [id]: { displayTitle: 'Main Agent', running: false, blank: false, updatedAt: 1 } } }
  return { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } }
}

function emptyFleetRoute(): void {
  vi.stubGlobal('fetch', () => Promise.resolve({
    ok: true,
    json: () => Promise.resolve({ ok: true, value: { messages: [], truncated: false } }),
  } as Response))
}

function makeView(ctx: TestClientCtx) {
  return makeFleetView(asClientCtx(ctx), kit, makeAgentHeads())
}

describe('FleetView Mission Pulse states', () => {
  test('a projection seat that appears or disappears after mount keeps the view rendering without shifting its hooks', async () => {
    emptyFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-flip') } })
    const View = makeView(ctx)
    function useProjectionSeat(key: string): unknown {
      useState(0)
      return key === 'contextTimeline' ? richTimeline() : undefined
    }
    const m = await mount(h(View, { sessionId: 'sv-flip' }))
    await m.update(h(View, { sessionId: 'sv-flip', useProjection: useProjectionSeat }))
    assert.ok(m.container.childElementCount > 0)
    await m.update(h(View, { sessionId: 'sv-flip' }))
    assert.ok(m.container.childElementCount > 0)
    await m.unmount()
  })

  test('a solo session keeps its tree, an empty timeline, and an empty work queue without the retired boards', async () => {
    emptyFleetRoute()
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline()) }))

    assert.ok(text(query(m.container, '.lc-pulse-header')).includes(DICT_EN['fleet.pulse.title']))
    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '1')
    assert.equal(query(m.container, '[data-pulse-stat="tasks"]').textContent, '0')
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label').length, 1)
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    await until(() => text(query(m.container, '.lc-pulse-events')).includes(DICT_EN['fleet.comms.empty']), 'the empty stream never settled')
    assert.ok(query(m.container, '.lc-pulse-main-graph .lc-agents.lc-agents-compact') !== null)
    assert.equal(queryAll(m.container, '.lc-col-graph .lc-agent-card').length, 1)
    assert.equal(queryAll(m.container, '.lc-members, .lc-summary, .lc-comms-channels').length, 0)
    assert.equal(queryAll(m.container, '.lc-foot').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a cold session names its retryable read instead of spinning', async () => {
    let reads = 0
    let release!: () => void
    vi.stubGlobal('fetch', () => {
      reads += 1
      if (reads === 1) return new Promise(res => { release = () => { res({ ok: false, status: 503 } as Response) } })
      return Promise.resolve({ ok: false, status: 503 } as Response)
    })
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-cold') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-cold', useProjection: () => undefined }))

    assert.equal(query(m.container, '.lc-empty').textContent, DICT_EN['loading'])
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)) })
    await act(async () => { release() })
    await until(() => text(m.container).includes(DICT_EN['detail.loadFailed']), 'the failure never surfaced')
    const before = reads
    await click(query(m.container, '.lc-br-retry'))
    await until(() => reads > before, 'the retry never refired the read')
    assert.ok(text(m.container).includes(DICT_EN['detail.loadFailed']))
    await m.unmount()
    ctx.dispose()
  })

  test('the baseline gate rides the Fleet tab too', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-gate') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: 'sv-gate', useProjection: projectionsFor(richTimeline({ unsupported: { current: '0.1.0', minimum: '0.2.0-rc.2' } })) }))

    assert.ok(query(m.container, '.lc-gate-card') !== null)
    await m.unmount()
    ctx.dispose()
  })

  test('without a session id the empty mission still paints', async () => {
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-none') } })
    const View = makeView(ctx)
    const m = await mount(h(View, { useProjection: projectionsFor(richTimeline()) }))

    assert.equal(query(m.container, '[data-pulse-stat="agents"]').textContent, '0')
    assert.equal(queryAll(m.container, '.lc-pulse-lane-label').length, 0)
    assert.ok(text(query(m.container, '.lc-pulse-tasks')).includes(DICT_EN['fleet.tasks.noTeam']))
    assert.equal(queryAll(m.container, '.lc-agents, .lc-foot').length, 0)
    await m.unmount()
    ctx.dispose()
  })

  test('a relayed member pick selects the same lane used by tasks and events', async () => {
    emptyFleetRoute()
    const id = 'sv-fleet-pick'
    const snapshot = {
      byId: {
        [id]: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { contextTimeline: richTimeline() } },
        worker: { parentId: id, origin: 'subagent', running: true, updatedAt: 8, projectionValues: { contextTimeline: richTimeline(), subagent: { mode: 'continuable', label: 'worker-bee' } } },
      },
    }
    const ctx = new TestClientCtx({ services: { sessions: { list: { getSnapshot: (): unknown => snapshot, subscribe: (): (() => void) => () => {} } } } })
    const View = makeView(ctx)
    const m = await mount(h(View, { sessionId: id, useProjection: projectionsFor(richTimeline()) }))
    await act(async () => { requestFleetMemberFocus(id, 'worker') })
    await until(() => query(m.container, '.lc-pulse-lane-agent[data-agent="worker"]').getAttribute('aria-pressed') === 'true', 'the relay never selected the lane')
    assert.equal(query(m.container, '.lc-agent-card[data-agent="worker"]').getAttribute('aria-pressed'), 'true')
    assert.ok(query(m.container, '[data-task="worker"]').className.includes('lc-pulse-work-related'))
    assert.equal(currentFleetMemberFocus(id), 'worker')
    await m.unmount()
    ctx.dispose()
  })
})

describe('FleetView shared scrollport', () => {
  test('mount and session switches claim the top of the scrollport', async () => {
    const props = { sessionId: 'sv-fleet', useProjection: projectionsFor(richTimeline()) }
    const ctx = new TestClientCtx({ services: { sessions: selfOnly('sv-fleet') } })
    const View = makeView(ctx)
    const scroller = makeScroller()
    scroller.scrollTop = 3491
    const m = await mountInScroller(h(View, props), scroller)
    assert.equal(scroller.scrollTop, 0)
    scroller.scrollTop = 120
    await m.unmount()

    const next = makeScroller()
    next.scrollTop = 55
    const remounted = await mountInScroller(h(View, props), next)
    assert.equal(next.scrollTop, 0)
    await remounted.unmount()

    const switched = makeScroller()
    const switchView = await mountInScroller(h(View, props), switched)
    switched.scrollTop = 300
    await switchView.update(h(View, { sessionId: 'sv-other', useProjection: projectionsFor(richTimeline()) }))
    assert.equal(switched.scrollTop, 0)
    await switchView.unmount()
    ctx.dispose()
  })
})
})

describe('pulseEventsWindow', () => {

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
})
