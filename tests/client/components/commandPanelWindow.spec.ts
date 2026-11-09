import assert from 'node:assert/strict'
import { act, createElement as h, type ReactElement } from 'react'
import { afterAll, beforeAll, describe, test, vi } from 'vitest'
import { makeCommandPanel } from '../../../src/client/components/commandPanel'
import { useCommandLog } from '../../../src/client/components/useCommandLog'
import type { CommandPageFetcher } from '../../../src/client/commandPages'
import type { CommandPage } from '../../../src/shared/types'
import type { Command } from '../../../src/client/commands'
import { makeKit, mount, query, queryAll, text, until } from '../helpers/kit'
import { restoreLayout, stubClientSizes } from '../helpers/layout'

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
