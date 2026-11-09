import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { describe, test, vi } from 'vitest'
import type { CommandPage } from '../../../src/shared/types'
import type { Command } from '../../../src/client/commands'
import type { CommandPageFetcher } from '../../../src/client/commandPages'
import { useCommandLog } from '../../../src/client/components/useCommandLog'
import { click, mount, query, queryAll, settle, text, until } from '../helpers/kit'
import { typeInto } from './commandPanelHarness'
import { Panel, cmd, rowTexts } from './commandPanelHarness'

function page(commands: CommandPage['commands'], atStart: boolean, total: number): CommandPage {
  return { commands, atStart, total }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function PagedPanel(props: { commands: Command[]; floor?: number; fetchOlder?: CommandPageFetcher }): ReactElement {
  const log = useCommandLog(props.commands, props.floor, props.fetchOlder)
  return h(Panel, { commands: log.records, floor: props.floor, fill: log })
}

const RETRY = 'Retry'

describe('CommandPanel — incremental history fill', () => {
  test('walks the served floor back to the log head and drops the coverage note', async () => {
    const calls: number[] = []
    const pages = [
      page([cmd(6, { cmd: 'echo 6' }), cmd(8, { cmd: 'echo 8' })], false, 7),
      page([cmd(2, { cmd: 'echo 2' }), cmd(4, { cmd: 'echo 4' })], false, 7),
      page([cmd(0, { cmd: 'echo 0' })], true, 7),
    ]
    const fetchOlder = async (beforeSeq: number): Promise<CommandPage | null> => {
      calls.push(beforeSeq)
      return pages.shift() ?? null
    }
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder,
    }))
    try {
      await until(() => rowTexts(m.container).length === 7, 'the history never filled')
      assert.deepEqual(calls, [10, 6, 2], 'each page starts below the previous page’s oldest record')
      assert.ok(text(m.container).includes('echo 0'), 'the log’s first record is reachable')
      assert.equal(queryAll(m.container, '.lc-cmd-chips .lc-gran-btn b')[0]?.textContent, '7', 'the All chip counts the whole log')
      assert.ok(!text(m.container).includes('Covering'), 'a complete fill drops the coverage note')
      assert.equal(queryAll(m.container, '.lc-cmd-floor-btn').length, 0)
    } finally {
      await m.unmount()
    }
  })

  test('the note reports the fill’s progress and disappears when the head is reached', async () => {
    const first = deferred<CommandPage | null>()
    const second = deferred<CommandPage | null>()
    const queue = [first, second]
    const fetchOlder = (): Promise<CommandPage | null> => {
      const next = queue.shift()
      assert.ok(next !== undefined)
      return next.promise
    }
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder,
    }))
    try {
      await until(() => text(m.container).includes('Loading earlier runs…'), 'the fill never started')
      assert.ok(!text(m.container).includes('/ 600'), 'the total is unknown before the first page')
      await act(async () => { first.resolve(page([cmd(8, { cmd: 'echo 8' })], false, 600)) })
      await until(() => text(m.container).includes('3 / 600'), 'the progress never counted the first page')
      await act(async () => { second.resolve(page([cmd(6, { cmd: 'echo 6' })], true, 600)) })
      await until(() => !text(m.container).includes('Loading earlier runs…'), 'the note never cleared')
      assert.ok(!text(m.container).includes('Covering'))
    } finally {
      await m.unmount()
    }
  })

  test('a failed or empty page keeps the list and offers a retry that resumes the fill', async () => {
    const fetchOlder = vi.fn<() => Promise<CommandPage | null>>()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(page([cmd(8, { cmd: 'echo 8' })], true, 3))
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder,
    }))
    try {
      await until(() => text(m.container).includes('older ones could not be loaded'), 'the failure note never landed')
      assert.ok(text(m.container).includes('Loaded 2 runs'))
      assert.equal(rowTexts(m.container).length, 2, 'the served records stay')
      assert.equal(text(query(m.container, '.lc-cmd-floor-btn')), RETRY)
      await click(query(m.container, '.lc-cmd-floor-btn'))
      await until(() => rowTexts(m.container).length === 3, 'the retry never resumed')
      assert.ok(!text(m.container).includes('could not be loaded'))
      assert.equal(fetchOlder.mock.calls.length, 2)
    } finally {
      await m.unmount()
    }
  })

  test('a page that makes no backward progress fails the fill instead of looping', async () => {
    const fetchOlder = async (): Promise<CommandPage | null> => page([cmd(10, { cmd: 'echo 10' })], false, 99)
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder,
    }))
    try {
      await until(() => text(m.container).includes('older ones could not be loaded'), 'the no-progress guard never fired')
      assert.equal(rowTexts(m.container).length, 2)
    } finally {
      await m.unmount()
    }
  })

  test('records the projection later trims away stay listed, and served updates win over their paged copies', async () => {
    const ten = cmd(10, { cmd: 'echo 10' })
    const twelve = cmd(12, { cmd: 'echo 12' })
    const fourteen = cmd(14, { cmd: 'echo 14' })
    const fetchOlder = async (): Promise<CommandPage | null> => page([cmd(8, { cmd: 'echo 8' })], true, 3)
    const m = await mount(h(PagedPanel, { commands: [ten, twelve], floor: 9, fetchOlder }))
    try {
      await until(() => rowTexts(m.container).length === 3, 'the fill never landed')
      await m.update(h(PagedPanel, { commands: [twelve, fourteen], floor: 11, fetchOlder }))
      await settle(0)
      assert.equal(rowTexts(m.container).length, 4, 'the trimmed record stayed and the new one arrived')
      assert.ok(text(m.container).includes('echo 10'))

      const failedTwelve = cmd(12, { cmd: 'echo 12', status: 'failed', end: undefined })
      await m.update(h(PagedPanel, { commands: [failedTwelve, fourteen], floor: 11, fetchOlder }))
      await settle(0)
      const row = queryAll<HTMLElement>(m.container, '.lc-cmd-row').find(r => text(r).includes('echo 12'))
      assert.ok(row !== undefined && queryAll(row, '.lc-cmd-st-fail').length === 1, 'the served update replaced the copy')

      await m.update(h(PagedPanel, { commands: [failedTwelve, fourteen], floor: 11, fetchOlder }))
      await settle(0)
      assert.equal(rowTexts(m.container).length, 4, 'an unchanged served list leaves the map alone')
    } finally {
      await m.unmount()
    }
  })

  test('an empty served slice arms no pager, and an unmounted panel ignores a late answer', async () => {
    const fetchOlder = vi.fn(async (): Promise<CommandPage | null> => null)
    const empty = await mount(h(PagedPanel, { commands: [], floor: 9, fetchOlder }))
    try {
      await settle(40)
      assert.equal(fetchOlder.mock.calls.length, 0, 'nothing to page without a served record')
      assert.ok(!text(empty.container).includes('Covering'))
    } finally {
      await empty.unmount()
    }

    const pending = deferred<CommandPage | null>()
    const late = vi.fn(() => pending.promise)
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder: late,
    }))
    await until(() => late.mock.calls.length === 1, 'the read never started')
    await m.unmount()
    await act(async () => { pending.resolve(page([cmd(8, { cmd: 'echo 8' })], true, 3)) })
    assert.equal(late.mock.calls.length, 1)
  })

  test('an untrimmed log never arms the pager and serves the list as-is', async () => {
    const fetchOlder = vi.fn(async (): Promise<CommandPage | null> => page([], true, 0))
    const m = await mount(h(PagedPanel, { commands: [cmd(10), cmd(12)], fetchOlder }))
    try {
      await settle(40)
      assert.equal(rowTexts(m.container).length, 2)
      assert.equal(fetchOlder.mock.calls.length, 0)
      assert.equal(queryAll(m.container, '.lc-cmd-floor').length, 0)
    } finally {
      await m.unmount()
    }
  })

  test('an idle panel without a pager keeps the coverage note', async () => {
    const m = await mount(h(PagedPanel, { commands: [cmd(10), cmd(12)], floor: 9 }))
    try {
      assert.ok(text(m.container).includes('Covering the latest 2 runs'))
    } finally {
      await m.unmount()
    }
  })

  test('a rejected read fails the fill; losing the pager mid-fill does too; a late rejection is ignored', async () => {
    const failing = async (): Promise<CommandPage | null> => { throw new Error('route down') }
    const m = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder: failing,
    }))
    try {
      await until(() => text(m.container).includes('older ones could not be loaded'), 'the rejection never failed the fill')
    } finally {
      await m.unmount()
    }

    const pending = deferred<CommandPage | null>()
    const pager = vi.fn(() => pending.promise)
    const lost = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })],
      floor: 9,
      fetchOlder: pager,
    }))
    try {
      await until(() => pager.mock.calls.length === 1, 'the read never started')
      await lost.update(h(PagedPanel, { commands: [cmd(10, { cmd: 'echo 10' }), cmd(12, { cmd: 'echo 12' })], floor: 9 }))
      await settle(40)
      assert.ok(text(lost.container).includes('older ones could not be loaded'), 'the lost pager fails instead of hanging')
      await act(async () => { pending.resolve(page([cmd(8, { cmd: 'echo 8' })], true, 3)) })
      assert.equal(rowTexts(lost.container).length, 2, 'the stale answer is ignored')
    } finally {
      await lost.unmount()
    }

    const late = deferred<CommandPage | null>()
    const latePager = vi.fn(() => late.promise)
    const lateMount = await mount(h(PagedPanel, {
      commands: [cmd(10, { cmd: 'echo 10' })],
      floor: 9,
      fetchOlder: latePager,
    }))
    await until(() => latePager.mock.calls.length === 1, 'the late read never started')
    await lateMount.unmount()
    await act(async () => { late.reject(new Error('unmounted')) })
  })
})


describe('CommandPanel — bounded bursts and auto-resume', () => {
  test('a budget-paused fill resumes automatically when the search needs the full history', async () => {
    const calls: number[] = []
    let seq = 4_000
    const fetchOlder = async (beforeSeq: number): Promise<CommandPage | null> => {
      calls.push(beforeSeq)
      seq -= 1
      return page([cmd(seq, { cmd: `deep-${String(seq)}` })], false, 5_000)
    }
    const m = await mount(h(PagedPanel, {
      commands: [cmd(4_001, { cmd: 'echo recent' })],
      floor: 4_000,
      fetchOlder,
    }))
    try {
      await until(() => calls.length === 12, 'the burst never paused at the budget')
      const rowsBefore = rowTexts(m.container).length
      await typeInto(m.container, 'input.lc-fa-search', 'deep-')
      await until(() => calls.length > 12, 'the search never resumed the paused fill')
      await until(() => rowTexts(m.container).length > rowsBefore + 2, 'the resumed fill never landed more rows')
      assert.ok(rowTexts(m.container).some(row => row.includes('deep-')), 'history rows joined the filtered list')
    } finally {
      await m.unmount()
    }
  })

  test('a resumed burst stays bounded and the coverage note clears only at the head', async () => {
    let seq = 4_000
    const calls: number[] = []
    const fetchOlder = async (beforeSeq: number): Promise<CommandPage | null> => {
      calls.push(beforeSeq)
      seq -= 1
      return page([cmd(seq, { cmd: `old-${String(seq)}` })], false, 5_000)
    }
    const m = await mount(h(PagedPanel, {
      commands: [cmd(4_001, { cmd: 'echo recent' })],
      floor: 4_000,
      fetchOlder,
    }))
    try {
      await until(() => calls.length === 12, 'the burst never paused at the budget')
      await until(() => calls.length > 12, 'the visible oldest row never auto-resumed the walk')
      const note = text(m.container)
      assert.ok(note.includes('Covering') || note.includes('Loading earlier runs'), 'the ongoing fill keeps a coverage note')
      const atMid = calls.length
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 60)) })
      assert.ok(calls.length >= atMid, 'the walk keeps advancing without user action')
    } finally {
      await m.unmount()
    }
  })
})
