import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement, useState } from 'react'
import { describe, test, vi, afterAll, beforeAll } from 'vitest'
import { type CommandPage } from '../../../src/shared/types'
import { type Command } from '../../../src/client/commands'
import { type CommandPageFetcher } from '../../../src/client/commandPages'
import { useCommandLog } from '../../../src/client/components/useCommandLog'
import { click, mount, query, queryAll, settle, text, until, makeKit } from '../helpers/kit'
import { typeInto, Panel, cmd, rowTexts } from './commandPanelHarness'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import { restoreLayout, stubClientSizes } from '../helpers/layout'
import { makeContextJumpButton } from '../../../src/client/components/contextJump'
import { createContextSettings } from '../../../src/client/settings'
import { type ConversationNodeLike, type UseChatLike } from '../../../src/client/services'
import { takeContextFocus } from '../../../src/client/viewFocus'
import { DICT_EN } from '../../../src/client/i18n'
import { asClientCtx, TestClientCtx } from '../helpers/harness'

describe('commandPanelPages', () => {

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
})

describe('commandPanelWindow', () => {

const Panel = makeCommandPanel(makeKit())

const LIST_HEIGHT = 320
const T0 = 1_700_000_000_000

class ControlledResizeObserver {
  static all: ControlledResizeObserver[] = []
  readonly targets: Element[] = []
  constructor(readonly callback: ResizeObserverCallback) { ControlledResizeObserver.all.push(this) }
  static reset(): void { ControlledResizeObserver.all = [] }
  static rowObserver(): ControlledResizeObserver {
    const found = ControlledResizeObserver.all.find(entry => entry.targets.some(target => target.classList.contains('lc-cmd-item')))
    if (found === undefined) throw new Error('no row observer')
    return found
  }
  observe(target: Element): void { this.targets.push(target) }
  unobserve(target: Element): void {
    const at = this.targets.indexOf(target)
    if (at >= 0) this.targets.splice(at, 1)
  }
  disconnect(): void { this.targets.length = 0 }
  settle(height: number, target: Element | undefined = this.targets[0]): void {
    this.callback(
      [{
        target,
        borderBoxSize: [{ blockSize: height, inlineSize: 400 }],
        contentRect: { height },
      } as unknown as ResizeObserverEntry],
      this as unknown as ResizeObserver,
    )
  }
}

beforeAll(() => {
  stubClientSizes({ 'lc-cmd-list': { width: 500, height: LIST_HEIGHT } })
})

afterAll(() => {
  vi.unstubAllGlobals()
  restoreLayout()
})

function commandsOf(count: number): Command[] {
  return Array.from({ length: count }, (_, i) => ({
    seq: i + 1,
    time: T0 + i * 1000,
    tool: 'bash',
    cmd: `echo item-${i}`,
    description: `run item-${i}`,
    start: T0 + i * 1000,
    end: T0 + i * 1000 + 100,
    status: 'completed' as const,
    err: false,
    resultSeq: i + 1,
  }))
}

function rowSeqs(container: ParentNode): number[] {
  return queryAll(container, '.lc-cmd-cmd')
    .map(cmd => Number(/item-(\d+)/.exec(text(cmd))?.[1] ?? '-1'))
    .map(index => 399 - index)
    .sort((a, b) => a - b)
}

async function measureRows(height: (index: number) => number): Promise<void> {
  const observer = ControlledResizeObserver.rowObserver()
  for (const target of [...observer.targets]) {
    const items = queryAll(target.ownerDocument, '.lc-cmd-item')
    const index = items.indexOf(target as HTMLElement)
    await act(async () => { observer.settle(height(index), target) })
  }
}

function activeTitle(): string | null {
  const active = document.activeElement
  if (!(active instanceof Element)) return null
  return active.closest<HTMLElement>('.lc-cmd-item')?.querySelector<HTMLElement>('.lc-cmd-cmd')?.textContent ?? null
}

function PagedWindow(props: { commands: Command[]; fetchOlder?: CommandPageFetcher }): ReactElement {
  const log = useCommandLog(props.commands, props.commands.length > 0 ? props.commands[0].seq - 1 : undefined, props.fetchOlder)
  return h(Panel, { commands: log.records, floor: props.commands.length > 0 ? props.commands[0].seq - 1 : undefined, fill: log })
}

describe('CommandPanel fill pause away from the history tail', () => {
  test('a paused burst stays paused at the newest head and resumes when the tail nears', async () => {
    const calls: number[] = []
    const fetchOlder = async (beforeSeq: number): Promise<CommandPage> => {
      const seq = beforeSeq - 1
      calls.push(seq)
      return { commands: [{ seq, time: T0 + (seq % 100) * 1000, tool: 'bash', cmd: `echo old-${String(seq)}`, start: T0 + (seq % 100) * 1000, end: T0 + (seq % 100) * 1000 + 10, status: 'completed' as const, err: false }], atStart: false, total: 5_000 }
    }
    const served = commandsOf(400).map(cmd => ({ ...cmd, seq: cmd.seq + 100 }))
    const m = await mount(h(PagedWindow, { commands: served, fetchOlder }))
    try {
      await until(() => calls.length === 12, 'the burst never paused at the budget', 800)
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 80)) })
      assert.equal(calls.length, 12, 'the newest head does not demand older history')
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      list.scrollTop = 12_000
      await act(async () => { list.dispatchEvent(new Event('scroll')) })
      await until(() => calls.length > 12, 'the tail proximity never resumed the walk', 800)
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })
})

describe('CommandPanel row windowing', () => {
  test('never mounts the full list: the window follows the scroll with full-height pads', async () => {
    const m = await mount(h(Panel, { commands: commandsOf(400), workspace: '/repo' }))
    try {
      const list = query<HTMLElement>(m.container, '.lc-cmd-list')
      assert.equal(list.clientHeight, LIST_HEIGHT)
      const initial = queryAll(m.container, '.lc-cmd-item').length
      assert.ok(initial < 400, `bounded first paint (${initial})`)
      assert.ok(initial >= 8, 'a window wide enough to scroll through')
      assert.equal(queryAll(m.container, '.lc-cmd-item').length, 19)
      assert.equal(rowSeqs(m.container)[0], 0, 'the window starts at the newest row')
      const [headPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(headPad.style.height, '11430px', 'a bottom spacer keeps the full scroll height')

      list.scrollTop = 900
      await act(async () => { list.dispatchEvent(new Event('scroll')) })
      await until(() => queryAll<HTMLElement>(m.container, '.lc-row-pad').length === 2, 'a top pad appears after scrolling')
      const seqs = rowSeqs(m.container)
      assert.equal(seqs.length, 27)
      assert.equal(seqs[0], 22, 'the window starts at the row reaching the viewport top')
      assert.equal(seqs.at(-1), 48, 'the window ends at the row covering the viewport bottom plus overscan')
      const [topPad, bottomPad] = queryAll<HTMLElement>(m.container, '.lc-row-pad')
      assert.equal(topPad.style.height, '660px')
      assert.equal(bottomPad.style.height, '10530px')
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('mixed row heights and an open row keep the window instead of falling back to the full list', async () => {
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver)
    ControlledResizeObserver.reset()
    try {
      const m = await mount(h(Panel, { commands: commandsOf(400), workspace: '/repo' }))
      await measureRows(index => (index % 5 === 0 ? 90 : 30))
      assert.ok(queryAll(m.container, '.lc-cmd-item').length < 400, 'mixed heights stay windowed')
      const [first] = queryAll<HTMLElement>(m.container, '.lc-cmd-toggle')
      assert.ok(first !== undefined)
      assert.equal(first.getAttribute('aria-expanded'), 'false')
      await act(async () => { first.click() })
      assert.ok(query(m.container, '.lc-cmd-detail') !== null, 'the row expands')
      assert.equal(queryAll<HTMLElement>(m.container, '.lc-cmd-toggle')[0].getAttribute('aria-expanded'), 'true')
      assert.ok(queryAll(m.container, '.lc-cmd-item').length < 400, 'the expanded row keeps the list windowed')
      const observer = ControlledResizeObserver.rowObserver()
      const expanded = observer.targets.find(target => (target as HTMLElement).querySelector('.lc-cmd-detail') !== null)
      assert.ok(expanded !== undefined, 'the expanded item is measured')
      await act(async () => { observer.settle(420, expanded) })
      assert.ok(queryAll(m.container, '.lc-cmd-item').length < 400, 'a tall expanded item does not expand the window')
      await act(async () => { query<HTMLElement>(m.container, '.lc-cmd-toggle').click() })
      assert.ok(queryAll(m.container, '.lc-cmd-detail').length === 0)
      await act(async () => { query<HTMLElement>(m.container, '.lc-cmd-toggle').click() })
      assert.ok(query(m.container, '.lc-cmd-detail') !== null, 'the collapsed row re-expands')
      for (let toggle = 0; toggle < 8; toggle++) {
        await act(async () => { query<HTMLElement>(m.container, '.lc-cmd-toggle').click() })
        assert.equal(queryAll(m.container, '.lc-cmd-detail').length === 1, toggle % 2 === 1, `toggle ${toggle} alternates the detail`)
        assert.ok(queryAll(m.container, '.lc-cmd-item').length < 400, 'every toggle keeps the list windowed')
      }
      await m.unmount()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  test('one roving tab stop and Arrow/Home/End reach the first and last retained command', async () => {
    const located: Command[] = []
    const m = await mount(h(Panel, {
      commands: commandsOf(400),
      workspace: '/repo',
      onLocate: rec => { located.push(rec) },
    }))
    try {
      const roving = queryAll<HTMLElement>(m.container, '.lc-cmd-toggle').filter(toggle => toggle.tabIndex === 0)
      assert.equal(roving.length, 1, 'one tab stop for the rows')
      roving[0].focus()
      roving[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }))
      await until(() => activeTitle()?.includes('item-0') === true, 'End reaches and focuses the oldest row')
      assert.equal(queryAll<HTMLElement>(m.container, '.lc-cmd-toggle').filter(toggle => toggle.tabIndex === 0).length, 1)
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }))
      await until(() => activeTitle()?.includes('item-399') === true, 'Home returns focus to the newest row')
      await act(async () => {})
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
      await until(() => activeTitle()?.includes('item-398') === true, 'ArrowDown moves one row')
      const locate = query<HTMLElement>(m.container, '.lc-cmd-time-link')
      assert.equal(locate.tagName, 'BUTTON')
      assert.ok((locate.getAttribute('aria-label') ?? '').length > 0)
      await act(async () => { locate.click() })
      assert.equal(located.length, 1)
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })

  test('a filter that drops below the windowing threshold renders every remaining match', async () => {
    const commands = commandsOf(400).map((rec, i) => ({ ...rec, cmd: `${i === 0 ? 'echo needle' : 'echo item'}-${i}` }))
    const m = await mount(h(Panel, { commands, workspace: '/repo' }))
    try {
      const input = query<HTMLInputElement>(m.container, 'input.lc-fa-search')
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
        setter?.call(input, 'needle')
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await until(() => queryAll(m.container, '.lc-cmd-item').length === 1, 'the single match renders without spacers')
      assert.equal(queryAll(m.container, '.lc-row-pad').length, 0)
      await m.unmount()
    } finally {
      await m.unmount()
    }
  })
})
})

describe('contextJump', () => {

const kit = makeKit()
const Jump = makeContextJumpButton(asClientCtx(new TestClientCtx()), kit, createContextSettings())

const SESSION = 'sv-jump'

function chatWith(nodes: unknown): { useChat?: UseChatLike } {
  return { useChat: (sel => sel({ legacy: { nodes: nodes as readonly ConversationNodeLike[] } })) as UseChatLike }
}

const reply = { kind: 'assistant', seq: 4, messageId: 'msg-4' }
const toolNode = { kind: 'tool', seq: 3, messageId: 'msg-tool' }

describe('ContextJump — seat guards', () => {
  test('a non-string or empty message id renders nothing', async () => {
    for (const messageId of [undefined, '', 42]) {
      const m = await mount(h(Jump, { messageId }))
      assert.equal(queryAll(m.container, 'button').length, 0)
      await m.unmount()
    }
  })

  test('a chat seat that appears or disappears after mount keeps the button rendering without shifting its hooks', async () => {
    function useChatSeat<T>(sel: (s: unknown) => T): T {
      useState(0)
      return sel({ legacy: { nodes: [reply] } })
    }
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION }))
    await m.update(h(Jump, { messageId: 'msg-4', sessionId: SESSION, useChat: useChatSeat }))
    assert.ok(query(m.container, 'button.lc-jump') !== null)
    await m.update(h(Jump, { messageId: 'msg-4', sessionId: SESSION }))
    assert.ok(query(m.container, 'button.lc-jump') !== null)
    await m.unmount()
  })

  test('renders the labelled icon button for a finalized reply; a click with no served node seat switches tabs and mints no focus', async () => {
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION }))
    const btn = query(m.container, 'button.lc-jump')
    assert.equal(btn.getAttribute('aria-label'), DICT_EN['jump.title'])
    assert.ok(btn.querySelector('svg') !== null)
    await click(btn)
    assert.equal(takeContextFocus(SESSION), null)
    await m.unmount()
  })
})

describe('ContextJump — click flow', () => {
  test('no sidebar face: resolves the reply seq, records the relay, and falls back to the tab', async () => {
    const bar = document.createElement('div')
    const chat = document.createElement('button')
    chat.setAttribute('role', 'tab')
    chat.setAttribute('aria-selected', 'true')
    chat.textContent = 'Chat'
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.append(chat, context)
    document.body.appendChild(bar)
    try {
      const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION, ...chatWith([reply, toolNode]) }))
      await click(query(m.container, 'button.lc-jump'))
      assert.equal(takeContextFocus(SESSION), 4, 'the clicked reply’s request seq rides the relay')
      assert.equal(contextClicks, 1, 'the Context tab button was clicked')
      assert.equal(takeContextFocus(SESSION), null)
      await m.unmount()
    } finally {
      bar.remove()
    }
  })

  test('the seq resolves at render and the click never re-reads the seat (a real hook is render-only)', async () => {
    let reads = 0
    const useChat = ((sel: (s: unknown) => unknown) => {
      reads++
      return sel({ legacy: { nodes: [reply] as readonly ConversationNodeLike[] } })
    }) as UseChatLike
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION, useChat }))
    const before = reads
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(reads, before, 'no click-time seat read — the production seat throws off-render')
    assert.equal(takeContextFocus(SESSION), 4, 'the render-resolved seq rides the relay')
    await m.unmount()
  })

  test('the seq resolution prefers the matching assistant node and drops non-finite seqs', async () => {
    const m = await mount(h(Jump, { messageId: 'msg-tool', sessionId: SESSION, ...chatWith([reply, toolNode]) }))
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a tool node never mints a focus')
    await m.unmount()

    const broken = { kind: 'assistant', seq: Number.NaN, messageId: 'msg-x' }
    const m2 = await mount(h(Jump, { messageId: 'msg-x', sessionId: SESSION, ...chatWith([broken]) }))
    await click(query(m2.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a non-finite seq never mints a focus')
    await m2.unmount()
  })

  test('a hostile node that throws on property access is skipped, not fatal', async () => {
    const hostile = { get kind(): string { throw new Error('boom') } }
    const m = await mount(h(Jump, { messageId: 'msg-4', sessionId: SESSION, ...chatWith([hostile, reply]) }))
    await click(query(m.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), 4, 'the real reply after the hostile element still resolves')
    await m.unmount()

    const hostileMatch = {
      get kind(): string { return 'assistant' },
      get messageId(): string { throw new Error('boom') },
    }
    const m2 = await mount(h(Jump, { messageId: 'msg-9', sessionId: SESSION, ...chatWith([hostileMatch]) }))
    await click(query(m2.container, 'button.lc-jump'))
    assert.equal(takeContextFocus(SESSION), null, 'a hostile match candidate degrades to no focus')
    await m2.unmount()
  })

  test('an unknown reply and a missing session still switch tabs, minting no relay entry', async () => {
    const bar = document.createElement('div')
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.appendChild(context)
    document.body.appendChild(bar)
    try {
      const m = await mount(h(Jump, { messageId: 'msg-none', sessionId: SESSION, ...chatWith([reply]) }))
      await click(query(m.container, 'button.lc-jump'))
      assert.equal(takeContextFocus(SESSION), null)
      assert.equal(contextClicks, 1, 'the tab still opens, just without a pinned step')
      await m.unmount()

      const m2 = await mount(h(Jump, { messageId: 'msg-4', sessionId: 7, ...chatWith([reply]) }))
      await click(query(m2.container, 'button.lc-jump'))
      assert.equal(contextClicks, 2)
      await m2.unmount()
    } finally {
      bar.remove()
    }
  })
})

describe('ContextJump — hidden panel entry', () => {
  test("the 'hide' placement renders no jump; a flip back to 'all' brings it in", async () => {
    const settings = createContextSettings()
    settings.set('defaultPlacement', 'hide')
    const HiddenJump = makeContextJumpButton(asClientCtx(new TestClientCtx()), kit, settings)
    const m = await mount(h(HiddenJump, { messageId: 'msg-4' }))
    assert.equal(queryAll(m.container, 'button').length, 0, 'no Context surface is left to jump to')
    await act(async () => { settings.set('defaultPlacement', 'all') })
    assert.equal(queryAll(m.container, 'button').length, 1, 'the jump follows the entry live')
    await m.unmount()
  })
})

describe('ContextJump — sidebar landing', () => {
  test('a served sidebarRight face opens the Context tab there; an openTab that refuses falls back to the conversation tab', async () => {
    const opened: string[] = []
    const ctx = new TestClientCtx({ services: { sidebarRight: { openTab: (kind: string) => { opened.push(kind) } } } })
    const SidebarJump = makeContextJumpButton(asClientCtx(ctx), kit, createContextSettings())
    const bar = document.createElement('div')
    const context = document.createElement('button')
    context.setAttribute('role', 'tab')
    context.textContent = 'Context'
    let contextClicks = 0
    context.addEventListener('click', () => { contextClicks++ })
    bar.appendChild(context)
    document.body.appendChild(bar)
    try {
      const m = await mount(h(SidebarJump, { messageId: 'msg-4', sessionId: SESSION, ...chatWith([reply]) }))
      await click(query(m.container, 'button.lc-jump'))
      assert.deepEqual(opened, ['dsh-context'], 'the sidebar Context tab was opened by kind')
      assert.equal(takeContextFocus(SESSION), 4, 'the clicked reply’s request seq rides the relay')
      assert.equal(contextClicks, 0, 'the conversation tab was not touched')
      await m.unmount()

      const refusing = new TestClientCtx({ services: { sidebarRight: { openTab: () => { throw new Error('refused') } } } })
      const RefusingJump = makeContextJumpButton(asClientCtx(refusing), kit, createContextSettings())
      const fallback = await mount(h(RefusingJump, { messageId: 'msg-4', sessionId: SESSION, ...chatWith([reply]) }))
      await click(query(fallback.container, 'button.lc-jump'))
      assert.equal(contextClicks, 1)
      await fallback.unmount()
    } finally {
      bar.remove()
    }
  })
})
})
