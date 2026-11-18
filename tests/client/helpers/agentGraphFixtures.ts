import { makeAgentGraph } from '../../../src/client/components/agentGraph'
import type { AgentSelfStats } from '../../../src/client/agentTree'
import { TestClientCtx, asClientCtx } from './harness'
import { makeKit } from './kit'

export function timeline(total: number, requests = 0): unknown {
  return {
    ok: true,
    contextWindow: 1000,
    current: { system: 10, tools: 20, user: total, inject: 0, assistant: 0, tool: 0, total: total + 30 },
    requests: Array.from({ length: requests }, (_, i) => ({
      seq: i + 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1,
    })),
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
}

export class FakeSessions {
  opened: string[] = []
  private listeners = new Set<() => void>()
  state: unknown

  constructor(byId: Record<string, unknown>) {
    this.state = { byId }
  }

  readonly list = {
    getSnapshot: (): unknown => this.state,
    subscribe: (fn: () => void): () => void => {
      this.listeners.add(fn)
      return () => this.listeners.delete(fn)
    },
  }

  openSession(id: string): void {
    this.opened.push(id)
  }

  setState(byId: Record<string, unknown>): void {
    this.state = { byId }
    for (const fn of this.listeners) fn()
  }
}

export function makeView(sessions: unknown, options: { locale?: 'en' | 'zh' } = {}) {
  const nav = { openSession: (id: string) => (sessions as { openSession?: (id: string) => void }).openSession?.(id) }
  const ctx = new TestClientCtx({ locale: options.locale, services: { sessions, uiWorkspace: nav } })
  return makeAgentGraph(asClientCtx(ctx), options.locale === 'zh' ? makeKit('zh') : makeKit())
}

export function selfStats(over: Partial<AgentSelfStats> = {}): AgentSelfStats {
  return {
    head: { tokens: 500, window: 1000, pct: 50, parts: [{ key: 'user', color: '#22c55e', value: 500 }] },
    billed: 1200,
    requests: 3,
    durationMs: 387_000,
    ...over,
  }
}

export function family(): Record<string, unknown> {
  return {
    root: {
      displayTitle: 'Main Agent', running: true, updatedAt: 10,
      projectionValues: { contextTimeline: timeline(200, 2) },
    },
    worker: {
      parentId: 'root', origin: 'subagent', running: true, updatedAt: 8,
      projectionValues: {
        contextTimeline: timeline(800, 5),
        subagent: { mode: 'continuable', label: 'worker-bee' },
        subagentTiming: { settledMs: 42000 },
        tokenUsage: { uncachedInputTokens: 100, outputTokens: 40, cacheReadTokens: 10, cacheWriteTokens: 0 },
      },
    },
    done: {
      parentId: 'root', origin: 'subagent', running: false, updatedAt: 6,
      projectionValues: {
        contextPressure: { projectedTokens: 950, contextWindow: 1000 },
        subagent: { mode: 'one-shot' },
        subagentTiming: { settledMs: 9000, lastTurnCompleted: true },
      },
    },
  }
}

export function filterFamily(): Record<string, unknown> {
  return {
    root: { displayTitle: 'Main Agent', running: true, updatedAt: 10, projectionValues: { contextTimeline: timeline(200, 2) } },
    mate: {
      parentId: 'root', origin: 'subagent', running: false, updatedAt: 8,
      projectionValues: { contextTimeline: timeline(300, 1), subagent: { mode: 'continuable', label: 'mate-idle' } },
    },
    mateSub: {
      parentId: 'mate', origin: 'subagent', running: true, updatedAt: 9,
      projectionValues: { contextTimeline: timeline(100, 1), subagent: { mode: 'one-shot', label: 'busy-bee' } },
    },
    dead: {
      parentId: 'root', origin: 'subagent', running: false, updatedAt: 6,
      projectionValues: { contextTimeline: timeline(50, 1), subagent: { mode: 'one-shot' }, subagentTiming: { settledMs: 5000, lastTurnCompleted: true } },
    },
  }
}
