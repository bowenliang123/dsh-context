import type { ContextTimeline } from '../../../src/shared/types'

export function timeline(total: number, requests = 0): ContextTimeline {
  return {
    ok: true,
    contextWindow: 1000,
    current: {
      system: 0, tools: 0, user: total, inject: 0, skill: 0, assistant: 0, tool: 0, total,
    },
    requests: Array.from({ length: requests }, (_, i) => ({
      seq: i + 1, time: 0, system: 0, tools: 0, user: 0, inject: 0, assistant: 0, tool: 0, total: 1,
    })),
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
}

export function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { running: false, updatedAt: 1, ...over }
}

export function snap(byId: Record<string, unknown>): unknown {
  return { byId }
}
