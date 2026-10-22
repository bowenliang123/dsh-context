// Fixture data and stand-ins for the dsh-TUI host faces: the kit components render inert DOM that records their props, so
// component specs assert what the plugin asked the host to draw, never a host implementation detail.

import { act, createElement, type ReactElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import type { ContextHeaders, ContextTimeline, RequestRecord } from '../../src/shared/types'
import type {
  ChartKit, ColumnChartProps, LegendProps, ProjectionWatch, SceneKey, SceneUi, StackedBarProps, SurfaceHost, SurfaceUi, TableProps,
} from '../../src/tui/hostTypes'
import type { ContextData, ContextSource } from '../../src/tui/source'

export const NOW = 1_700_000_100_000
export const T0 = NOW - 100_000

function request(over: Partial<RequestRecord> & { seq: number; turn: number; step: number }): RequestRecord {
  return { time: T0 + over.seq * 1000, system: 1000, tools: 2000, user: 100, inject: 50, assistant: 0, tool: 0, total: 3150, ...over }
}

export function timelineFixture(over: Partial<ContextTimeline> = {}): ContextTimeline {
  return {
    ok: true,
    model: 'deepseek-v4',
    contextWindow: 200_000,
    maxOutputTokens: 8192,
    current: { system: 1000, tools: 2000, user: 300, inject: 50, skill: 20, assistant: 90, tool: 700, total: 4160 },
    requests: [
      request({ seq: 3, turn: 1, step: 1, prompt: 3150, cacheRead: 0, output: 40 }),
      request({ seq: 6, turn: 1, step: 2, assistant: 40, tool: 500, total: 3690, prompt: 3700, skill: 20 }),
      request({ seq: 10, turn: 2, step: 1, user: 300, assistant: 90, tool: 700, total: 4140, prompt: 4100 }),
    ],
    events: [
      { seq: 2, time: T0 + 2000, kind: 'inject', form: 'instructions', name: 'AGENTS.md', tokens: 50, turn: 1, step: 1 },
      { seq: 8, time: T0 + 8000, kind: 'compaction', count: 3, tokens: 400, fromTurn: 1, fromStep: 2, turn: 2, step: 1 },
      { seq: 9, time: T0 + 9000, kind: 'model', from: 'a', to: 'b' },
    ],
    nodes: [
      { seq: 1, time: T0 + 1000, cat: 'user', tokens: 100, text: 'fix the bug' },
      { seq: 2, time: T0 + 2000, cat: 'inject', tokens: 50, name: 'AGENTS.md', text: 'rules' },
      { seq: 4, time: T0 + 4000, cat: 'assistant', tokens: 40, calls: ['read'] },
      { seq: 5, time: T0 + 5000, cat: 'tool', tokens: 500, tool: 'read', text: 'export const a = 1' },
      { seq: 7, time: T0 + 7000, cat: 'skill', tokens: 20, skill: 'tdd' },
      { seq: 9, time: T0 + 9000, cat: 'user', tokens: 200, text: 'and the tests' },
      { seq: 11, time: T0 + 11000, cat: 'tool', tokens: 200, tool: 'bash', err: true },
    ],
    droppedNodes: 0,
    archive: [],
    fileOps: [
      { seq: 5, path: '/w/src/a.ts', kind: 'read', tool: 'read', time: T0 + 5000, err: false, added: 0, removed: 0, read: { start: 10, count: 20 } },
      { seq: 7, path: 'src/b.ts', kind: 'write', tool: 'edit', time: T0 + 7000, err: false, added: 5, removed: 2 },
      { seq: 8, path: 'src/b.ts', kind: 'read', tool: 'read', time: T0 + 8000, err: false, added: 0, removed: 0, read: { count: 50, est: true } },
      { seq: 9, path: 'TODO', kind: 'search', tool: 'grep', time: T0 + 9000, err: false, added: 0, removed: 0, pattern: true },
    ],
    cost: { deepseek: { 'deepseek-v4': { peak: { uncached: 1000, cacheRead: 3000, cacheWrite: 0, output: 200 } } } },
    timing: { wallMs: 9000, ttftMs: 1200, genMs: 3000, calls: 3, toolsMs: 2500, toolCalls: 2, tools: {} },
    answers: 1,
    humanInputs: 2,
    toolCalls: 2,
    ...over,
  }
}

export function headersFixture(): ContextHeaders {
  return {
    headers: [{ seq: 0, time: T0, tools: [{ name: 'read', tokens: 800, plugin: '@deepseek-ai/dsh-tool-fs' }, { name: 'bash', tokens: 1200 }] }],
  }
}

/** Lets cordis run the deferred injects a plugin set up. */
export async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise(resolve => setTimeout(resolve, 1))
}

export interface FakeWatch extends ProjectionWatch {
  set: (value: unknown, sessionId?: string) => void
  listeners: Set<() => void>
}

export function fakeWatch(value: unknown, sessionId: string | undefined = 's1'): FakeWatch {
  let current = value
  let session = sessionId
  const listeners = new Set<() => void>()
  return {
    get sessionId() {
      return session
    },
    read: () => current,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next, nextSession) => {
      current = next
      if (nextSession !== undefined) session = nextSession
      for (const listener of listeners) listener()
    },
    listeners,
  }
}

export function staticSource(data: Partial<ContextData>): ContextSource & { set: (next: Partial<ContextData>) => void } {
  let snapshot: ContextData = { sessionId: 's1', timeline: null, headers: null, partial: false, ...data }
  const listeners = new Set<() => void>()
  return {
    read: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    set: (next) => {
      snapshot = { ...snapshot, ...next }
      for (const listener of listeners) listener()
    },
  }
}

function recorder<P extends object>(name: string) {
  return (props: P): ReactElement => createElement('div', { 'data-kit': name, 'data-props': JSON.stringify(props) })
}

export const fakeFormat: ChartKit['format'] = {
  relativeTime: at => `${Math.round((NOW - at) / 1000)}s`,
  cells: text => Array.from(text).reduce((n, c) => n + ((c.codePointAt(0) ?? 0) >= 0x2e80 ? 2 : 1), 0),
  truncate: (text, cells) => text.slice(0, cells),
}

export const fakeKit: ChartKit = {
  StackedBar: recorder<StackedBarProps>('StackedBar'),
  ColumnChart: recorder<ColumnChartProps>('ColumnChart'),
  Legend: recorder<LegendProps>('Legend'),
  Table: recorder<TableProps>('Table'),
  format: fakeFormat,
  seriesColor: index => `chart${(index % 8) + 1}`,
  hashSeries: key => key.length,
}

export const baseUi: SurfaceUi = {
  Box: (props: { children?: ReactNode }) => createElement('div', { 'data-box': '' }, props.children),
  Text: (props: { children?: ReactNode; color?: string; inverse?: boolean; bold?: boolean }) => createElement('span', {
    'data-color': props.color ?? '',
    'data-inverse': props.inverse === true ? '1' : '',
    'data-bold': props.bold === true ? '1' : '',
  }, props.children),
}

export const panelUi: SurfaceUi = {
  ...baseUi,
  ...fakeKit,
}

export interface InputHolder {
  handler?: (input: string, key: SceneKey) => void
}

export function sceneUi(input: InputHolder, size: { columns: number; rows: number }, ui: SurfaceUi = panelUi): SceneUi {
  return {
    ...ui,
    useInput: (handler) => {
      input.handler = handler
    },
    useTerminalSize: () => size,
  }
}

export interface FakeHost extends SurfaceHost {
  keys: Set<(event: { input: string; key: Record<string, boolean>; preventDefault: () => void }) => void>
  opened: { path: string; options?: { line?: number } }[]
  toasts: string[]
}

export function fakeHost(snapshot: unknown, openResult = true): FakeHost {
  const host: FakeHost = {
    keys: new Set(),
    opened: [],
    toasts: [],
    snapshot: () => snapshot,
    onKey: (listener) => {
      host.keys.add(listener)
      return () => {
        host.keys.delete(listener)
      }
    },
    openFile: (path, options) => {
      host.opened.push({ path, ...(options !== undefined ? { options } : {}) })
      return openResult
    },
    toast: (text) => {
      host.toasts.push(text)
      return true
    },
  }
  return host
}

export async function pressPanel(host: FakeHost, input: string, key: Record<string, boolean> = {}): Promise<boolean> {
  let prevented = false
  await act(async () => {
    for (const listener of host.keys) listener({ input, key, preventDefault: () => { prevented = true } })
  })
  return prevented
}

export async function pressScene(input: InputHolder, text: string, key: SceneKey = {}): Promise<void> {
  await act(async () => {
    input.handler?.(text, key)
  })
}

export interface Rendered {
  container: HTMLElement
  render: (el: ReactElement) => Promise<void>
  unmount: () => Promise<void>
}

export async function render(el: ReactElement): Promise<Rendered> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(el)
  })
  return {
    container,
    render: async (next) => {
      await act(async () => {
        root.render(next)
      })
    },
    unmount: async () => {
      await act(async () => {
        root.unmount()
      })
      container.remove()
    },
  }
}

export function kitProps<T = Record<string, unknown>>(container: HTMLElement, name: string): T[] {
  return [...container.querySelectorAll(`[data-kit="${name}"]`)].map(el => JSON.parse(el.getAttribute('data-props') ?? '{}') as T)
}

export function textOf(container: HTMLElement): string {
  return container.textContent ?? ''
}
