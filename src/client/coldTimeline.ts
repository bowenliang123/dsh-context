import type { ContextTimeline } from '../shared/types'

export const COLD_TIMELINE: ContextTimeline = {
  ok: true,
  current: { system: 0, tools: 0, user: 0, inject: 0, skill: 0, assistant: 0, tool: 0, total: 0 },
  requests: [],
  events: [],
  nodes: [],
  droppedNodes: 0,
  archive: [],
}
