import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { afterEach, describe, test, vi } from 'vitest'
import type { Command } from '../../../src/client/commands'
import type { CommandPageFetcher } from '../../../src/client/commandPages'
import { useCommandLog } from '../../../src/client/components/useCommandLog'
import { FILL_MAX_KNOWN } from '../../../src/client/components/useCommandLog'
import type { CommandLog } from '../../../src/client/components/useCommandLog'
import type { CommandPage } from '../../../src/shared/types'
import { mount, until } from '../helpers/kit'

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
