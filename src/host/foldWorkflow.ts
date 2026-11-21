import type { ContextEventRecord } from '../shared/types'
import { commandArgsRecordOf } from '../shared/commands'
import { asPlainObject } from '../shared/decode'
import {
  pushEvent,
  TALLY_NAME_CHARS_MAX,
  TEAM_TASKS_MAX,
  TODO_ITEMS_MAX,
  type TimelineEvent,
  type TimelineState,
  type WorkflowTeamTaskStatus,
  type WorkflowTodoStatus,
} from './foldState'

const ITEMS_MAX = 8

function sameStatuses<T extends string>(a: Record<string, T>, b: Record<string, T>): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  for (const key of keys) {
    if (a[key] !== b[key]) return false
  }
  return true
}

function clip(value: string): string {
  return value.length > TALLY_NAME_CHARS_MAX ? value.slice(0, TALLY_NAME_CHARS_MAX - 1) + '…' : value
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : clip(text)
}

function withEvents(
  state: TimelineState,
  records: ContextEventRecord[],
  next: Partial<TimelineState> = {},
): TimelineState {
  if (records.length === 0) return { ...state, ...next }
  const st: TimelineState = { ...state, ...next, events: [...state.events] }
  for (const record of records) pushEvent(st, record)
  st.detailRev = (st.detailRev ?? 0) + 1
  return st
}

function todoStatusOf(value: unknown): WorkflowTodoStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : undefined
}

function teamStatusOf(value: unknown): WorkflowTeamTaskStatus | undefined {
  return value === 'pending' || value === 'in_progress' || value === 'completed' || value === 'deleted'
    ? value
    : undefined
}

export function applyGoalChange(
  state: TimelineState,
  seq: number,
  time: number,
  data: Record<string, unknown> | undefined,
): TimelineState | undefined {
  const operation = data?.operation
  if (operation !== 'create' && operation !== 'complete') return undefined
  const goal = asPlainObject(data?.goal)
  const objective = textOf(goal?.objective)
  if (objective === undefined) return undefined
  const record: ContextEventRecord = {
    seq,
    time,
    kind: operation === 'create' ? 'goal-create' : 'goal-complete',
    name: objective,
    count: 1,
  }
  return withEvents(state, [record])
}

export function applyTodoWrite(
  state: TimelineState,
  seq: number,
  time: number,
  data: Record<string, unknown> | undefined,
): TimelineState | undefined {
  const raw = data?.todos
  if (!Array.isArray(raw)) return undefined
  const entries: [string, WorkflowTodoStatus][] = []
  for (const item of raw) {
    if (entries.length >= TODO_ITEMS_MAX) break
    const record = asPlainObject(item)
    const content = textOf(record?.content)
    const status = todoStatusOf(record?.status)
    if (content === undefined || status === undefined) continue
    entries.push([content, status])
  }
  const current: Record<string, WorkflowTodoStatus> = Object.fromEntries(entries)
  const previous = state.todoItems ?? {}
  const added: string[] = []
  const done: string[] = []
  for (const content of Object.keys(current)) {
    const status = current[content]
    if (!Object.hasOwn(previous, content)) {
      added.push(content)
      continue
    }
    if (previous[content] !== 'completed' && status === 'completed') done.push(content)
  }
  const changed = entries.length > 0 || Object.keys(previous).length > 0
  if (!changed) return undefined
  const records: ContextEventRecord[] = []
  if (added.length > 0) records.push({ seq, time, kind: 'todo-add', count: added.length })
  if (done.length > 0) {
    const items = done.slice(0, ITEMS_MAX)
    records.push({ seq, time, kind: 'todo-done', count: done.length, items, name: items[0] })
  }
  if (records.length === 0 && sameStatuses(previous, current)) return undefined
  return withEvents(state, records, { todoItems: current })
}

export function applyTeamTask(
  state: TimelineState,
  seq: number,
  time: number,
  data: Record<string, unknown> | undefined,
): TimelineState | undefined {
  const task = asPlainObject(data?.task)
  const id = textOf(task?.id)
  const subject = textOf(task?.subject)
  const status = teamStatusOf(task?.status)
  if (id === undefined || id === '__proto__' || subject === undefined || status === undefined) return undefined
  const previous = state.teamTasks ?? {}
  const prev = Object.hasOwn(previous, id) ? previous[id] : undefined
  const records: ContextEventRecord[] = []
  if (prev === undefined && status !== 'deleted') {
    records.push({ seq, time, kind: 'team-task-create', count: 1 })
  }
  if (prev !== undefined && prev !== 'completed' && status === 'completed') {
    records.push({ seq, time, kind: 'team-task-complete', name: subject, count: 1 })
  }
  let current: Record<string, WorkflowTeamTaskStatus> = {}
  for (const [key, value] of Object.entries(previous)) {
    if (key !== id) current[key] = value
  }
  if (status !== 'deleted') current[id] = status
  const keys = Object.keys(current)
  if (keys.length > TEAM_TASKS_MAX) {
    current = Object.fromEntries(keys.slice(keys.length - TEAM_TASKS_MAX).map(key => [key, current[key]]))
  }
  const nextStatus = status === 'deleted' ? undefined : status
  if (records.length === 0 && nextStatus === prev) return undefined
  return withEvents(state, records, { teamTasks: current })
}

export function applyWorkflowEvent(state: TimelineState, event: TimelineEvent): TimelineState | undefined {
  if (event.type === 'goal/change') return applyGoalChange(state, event.seq, event.time, event.data)
  if (event.type === 'todo/write') return applyTodoWrite(state, event.seq, event.time, event.data)
  if (event.type === 'team/task') return applyTeamTask(state, event.seq, event.time, event.data)
  return undefined
}

export function askRecordOf(
  seq: number,
  time: number,
  data: Record<string, unknown> | undefined,
): ContextEventRecord | undefined {
  const args = commandArgsRecordOf(data?.arguments)
  if (args === null || !Array.isArray(args.questions)) return undefined
  const items: string[] = []
  let count = 0
  for (const question of args.questions) {
    const record = asPlainObject(question)
    const text = textOf(record?.question)
    if (text === undefined) continue
    count += 1
    if (items.length < ITEMS_MAX) items.push(text)
  }
  if (count === 0) return undefined
  return { seq, time, kind: 'ask', count, items, name: items[0] }
}
