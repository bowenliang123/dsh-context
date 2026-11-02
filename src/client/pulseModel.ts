import type { AgentForest } from './agentTree'
import { fromPartyOf, type CommsAgent } from './commsModel'
import type { CommsRow, FleetDelegationRow } from './fleetDetail'
import { familyOthersOf, memberIdByName, tasksOfOwner, type FleetTeam, type FleetTeamTask } from './fleetTeam'

interface PulseTimelineBase {
  key: string
  time: number
  from: string
  to: string
}

export interface PulseMessageItem extends PulseTimelineBase {
  kind: 'message'
  row: CommsRow
}

export interface PulseDelegationItem extends PulseTimelineBase {
  kind: 'delegation'
  delegation: FleetDelegationRow
}

export type PulseTimelineItem = PulseMessageItem | PulseDelegationItem

export function pulseTimelineItemsOf(
  rows: readonly CommsRow[],
  delegations: readonly FleetDelegationRow[],
): PulseTimelineItem[] {
  const items: PulseTimelineItem[] = [
    ...rows.map(row => ({
      kind: 'message' as const,
      key: row.key,
      time: row.time,
      from: fromPartyOf(row),
      to: row.to,
      row,
    })),
    ...delegations.map(delegation => ({
      kind: 'delegation' as const,
      key: delegation.key,
      time: delegation.time,
      from: delegation.from,
      to: delegation.to,
      delegation,
    })),
  ]
  return items.sort((a, b) => (a.time - b.time)
    || ((a.kind === 'delegation' ? 0 : 1) - (b.kind === 'delegation' ? 0 : 1))
    || a.key.localeCompare(b.key))
}

export const PULSE_LANE_HEIGHT = 56
export const PULSE_TASK_LANE_HEIGHT = 40
export const PULSE_POINT_PITCH = 32
export const PULSE_TRACK_PADDING = 20

export interface PulseLaneLayout {
  id: string
  top: number
  height: number
  center: number
}

export interface PulsePointLayout {
  key: string
  item: PulseTimelineItem
  x: number
  y: number
}

export interface PulseLayout {
  width: number
  lanes: PulseLaneLayout[]
  points: PulsePointLayout[]
  height: number
}

export function layoutPulse(
  items: readonly PulseTimelineItem[],
  laneIds: readonly string[],
  totalCount = items.length,
  offset = 0,
): PulseLayout {
  const lanes = laneIds.map((id, index) => ({
    id,
    top: index * PULSE_LANE_HEIGHT,
    height: PULSE_LANE_HEIGHT,
    center: index * PULSE_LANE_HEIGHT + PULSE_LANE_HEIGHT / 2,
  }))
  const laneAt = new Map(lanes.map(lane => [lane.id, lane]))
  const points: PulsePointLayout[] = []
  items.forEach((item, index) => {
    const lane = laneAt.get(item.to)
    if (lane === undefined) return
    points.push({
      key: item.key,
      item,
      x: PULSE_TRACK_PADDING + (offset + index) * PULSE_POINT_PITCH + PULSE_POINT_PITCH / 2,
      y: lane.center,
    })
  })
  return {
    width: PULSE_TRACK_PADDING * 2 + totalCount * PULSE_POINT_PITCH,
    lanes,
    points,
    height: lanes.length * PULSE_LANE_HEIGHT,
  }
}

export interface PulseLaneInput {
  agent: CommsAgent
  active: boolean
}

export function pulseVisibleLaneIds(
  lanes: readonly PulseLaneInput[],
  rows: readonly CommsRow[],
  selectedAgent: string | null,
  query: string,
  showQuiet: boolean,
): string[] {
  if (showQuiet || lanes.length <= 8) return lanes.map(lane => lane.agent.id)
  const needle = query.trim().toLowerCase()
  const communicating = new Set<string>()
  for (const row of rows) {
    communicating.add(fromPartyOf(row))
    communicating.add(row.to)
  }
  return lanes
    .filter((lane) => {
      if (lane.active || lane.agent.id === selectedAgent || communicating.has(lane.agent.id)) return true
      if (needle === '') return false
      return lane.agent.name.toLowerCase().includes(needle)
        || (lane.agent.description ?? '').toLowerCase().includes(needle)
    })
    .map(lane => lane.agent.id)
}

export function pulseTaskBadgeOf(id: string): string {
  return id.startsWith('task-') ? `#${id.slice(5)}` : id
}

export function pulseTasksByAgent(team: FleetTeam | null): Map<string, readonly FleetTeamTask[]> {
  const map = new Map<string, readonly FleetTeamTask[]>()
  if (team === null) return map
  for (const member of team.members) {
    const tasks = tasksOfOwner(team, member.name)
    if (tasks.length > 0) map.set(member.id, tasks)
  }
  return map
}

export function pulseTaskOf(
  item: PulseTimelineItem,
  tasksByAgent: ReadonlyMap<string, readonly FleetTeamTask[]>,
): FleetTeamTask | null {
  const tasks = tasksByAgent.get(item.to) ?? tasksByAgent.get(item.from) ?? []
  return tasks.length === 0 ? null : tasks[0]
}

export interface PulseWorkItem {
  key: string
  id: string
  kind: 'team' | 'agent'
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'idle' | 'latest_complete'
  ownerId?: string
  ownerName?: string
  description?: string
  blockedBy: string[]
  writeScopes: string[]
  warnings: string[]
  ready: boolean
}

export function pulseWorkItemsOf(forest: AgentForest | null, team: FleetTeam | null): PulseWorkItem[] {
  const teamRows: PulseWorkItem[] = (team?.tasks ?? []).map((task) => {
    const ownerId = memberIdByName(team, task.ownerName)
    return {
      key: `team:${task.id}`,
      id: task.id,
      kind: 'team',
      subject: task.subject,
      status: task.status,
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(task.ownerName !== undefined ? { ownerName: task.ownerName } : {}),
      ...(task.description !== '' ? { description: task.description } : {}),
      blockedBy: task.blockedBy,
      writeScopes: task.writeScopes,
      warnings: task.warnings,
      ready: task.ready,
    }
  })
  const agentRows: PulseWorkItem[] = familyOthersOf(forest, team).map(node => ({
    key: `agent:${node.id}`,
    id: node.id,
    kind: 'agent',
    subject: node.label,
    status: node.running ? 'in_progress' : node.completed ? 'latest_complete' : 'idle',
    ownerId: node.id,
    ownerName: node.label,
    blockedBy: [],
    writeScopes: [],
    warnings: [],
    ready: false,
  }))
  const order: Record<PulseWorkItem['status'], number> = { in_progress: 0, pending: 1, idle: 2, latest_complete: 3, completed: 4 }
  return [...teamRows, ...agentRows].sort((a, b) => order[a.status] - order[b.status])
}
