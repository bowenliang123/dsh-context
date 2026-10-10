// ContextView — the Context tab root, driven by real projection values and real plugin settings.

import { act, createElement as h, type ReactElement } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, vi } from 'vitest'
import { makeContextView } from '../../../src/client/components/contextView'
import { makeAgentHeads } from '../../../src/client/agentHeads'
import { resetTimelineDetailStores } from '../../../src/client/timelineSource'
import { createContextSettings } from '../../../src/client/settings'
import type { UseChatLike } from '../../../src/client/services'
import type { ContextTimeline } from '../../../src/shared/types'
import { TestClientCtx, asClientCtx } from '../helpers/harness'
import { makeKit, mount, queryAll, text } from '../helpers/kit'

// pluginInfo's npm-registry probe stays inert (and '0.0.0-dev' short-circuits it anyway).
vi.stubGlobal('fetch', () => Promise.resolve({ ok: false } as Response))

const kit = makeKit()

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  // The cold-start share (timelineSource.ts) is page-lifetime per session:
  // drop it so one test's cold read never leaks its failed/ready state into a later test that reuses the same session id.
  resetTimelineDetailStores()
})

export function timeline(over: Record<string, unknown> = {}): ContextTimeline {
  return {
    ok: true,
    current: { system: 100, tools: 200, user: 300, inject: 50, skill: 0, assistant: 400, tool: 150, total: 1200 },
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
    ...over,
  } as ContextTimeline
}

export const T0 = 1700000000000

/** Two steps of one turn plus a turn-less trailing step, with their nodes. */
export function richTimeline(over: Record<string, unknown> = {}): ContextTimeline {
  return timeline({
    model: 'deepseek-v4-flash',
    provider: 'deepseek',
    contextWindow: 128000,
    toolCalls: 3,
    images: 1,
    requests: [
      { seq: 2, turn: 1, step: 1, time: T0 + 1000, system: 100, tools: 200, user: 10, inject: 0, assistant: 20, tool: 0, total: 330, prompt: 350, output: 20, cacheRead: 100 },
      { seq: 4, turn: 1, step: 2, time: T0 + 3000, system: 100, tools: 200, user: 10, inject: 0, assistant: 60, tool: 30, total: 400 },
      { seq: 6, time: T0 + 5000, system: 100, tools: 200, user: 10, inject: 0, assistant: 80, tool: 30, total: 420 },
    ],
    events: [
      { seq: 3, time: T0 + 2000, kind: 'compaction', count: 2, turn: 1, step: 2, fromTurn: 1, fromStep: 1, tokens: 500 },
      { seq: 5, time: T0 + 4000, kind: 'inject', form: 'notice', name: 'heads-up', tokens: 12, turn: 1, step: 3 },
    ],
    nodes: [
      { seq: 1, cat: 'user', tokens: 10, text: 'hello there', time: T0 + 500 },
      { seq: 2, cat: 'assistant', tokens: 20, text: 'reply one', time: T0 + 1000 },
      { seq: 3, cat: 'tool', tokens: 30, tool: 'bash', text: 'file output', time: T0 + 2000 },
      { seq: 4, cat: 'assistant', tokens: 60, text: 'reply two', time: T0 + 3000 },
      { seq: 6, cat: 'assistant', tokens: 80, text: 'reply three', time: T0 + 5000 },
    ],
    droppedNodes: 2,
    ...over,
  })
}

export function projectionsFor(data: ContextTimeline, extra: Record<string, unknown> = {}) {
  const projections: Record<string, unknown> = { contextTimeline: data, ...extra }
  return (key: string) => projections[key]
}

export function makeView(ctx: TestClientCtx, settings = createContextSettings()) {
  return makeContextView(asClientCtx(ctx), kit, settings, makeAgentHeads())
}

export function buttonByText(container: ParentNode, label: string): HTMLElement {
  const hit = queryAll(container, 'button').find(b => text(b) === label)
  if (hit === undefined) throw new Error(`button not found: ${label}`)
  return hit
}

/** Mount inside a `[data-conversation-scroll]` scroller so the view's shared-scrollport probes find it. */
export async function mountInScroller(el: ReactElement, scroller: HTMLElement) {
  const inner = document.createElement('div')
  scroller.appendChild(inner)
  document.body.appendChild(scroller)
  const root = createRoot(inner)
  await act(async () => {
    root.render(el)
  })
  return {
    container: inner,
    async update(next: ReactElement) {
      await act(async () => {
        root.render(next)
      })
    },
    async unmount() {
      await act(async () => {
        root.unmount()
      })
      scroller.remove()
    },
  }
}

/** Full projection over two steps of one turn plus a turn-less step. */
export async function mountRich(sessionId: string) {
  const View = makeView(new TestClientCtx())
  const m = await mount(h(View, {
    sessionId,
    useProjection: projectionsFor(richTimeline(), {
      contextHeaders: { headers: [{ seq: 1, time: T0, system: 'SYS', tools: [{ name: 'bash', tokens: 12, description: 'run' }] }] },
    }),
    useChat: (sel =>
        sel({
          legacy: { nodes: [] } })) as UseChatLike,
  }))
  return m
}
