import type { ContextEventRecord } from './types'

export type MilestoneKind = 'compaction' | 'prune' | 'skill' | 'agent' | 'spawn' | 'model' | 'longest' | 'growth'
  | 'goal-create' | 'goal-complete' | 'todo-add' | 'todo-done' | 'ask' | 'team-task-create' | 'team-task-complete'

const AGENT_INJECT_NAMES = new Set(['agent-message', 'team-message', 'subagent-settled', 'session-reference'])

export function milestoneKindOf(ev: ContextEventRecord): MilestoneKind | null {
  if (ev.kind === 'compaction' || ev.kind === 'prune' || ev.kind === 'model') return ev.kind
  if (ev.kind === 'goal-create' || ev.kind === 'goal-complete') return ev.kind
  if (ev.kind === 'todo-add' || ev.kind === 'todo-done') return ev.kind
  if (ev.kind === 'ask') return ev.kind
  if (ev.kind === 'team-task-create' || ev.kind === 'team-task-complete') return ev.kind
  if (ev.kind === 'agent') return 'spawn'
  if (ev.kind !== 'inject') return null
  if (ev.sub === 'skill') return 'skill'
  if (typeof ev.agent === 'string' && ev.agent !== '') return 'agent'
  return typeof ev.name === 'string' && AGENT_INJECT_NAMES.has(ev.name) ? 'agent' : null
}
