import type { AgentForest, AgentNode } from './agentTree'
import { modelLabelOf } from './agentTree'
import { fromPartyOf, type CommsAgent } from './commsModel'
import type { CommsRow, FleetDelegationRow } from './fleetDetail'
import { familyOthersOf, taskOwnerIdOf, type FleetTeam, type FleetTeamTask } from './fleetTeam'

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

export const PULSE_LANE_HEIGHT = 68
export const PULSE_TASK_LANE_HEIGHT = 40
export const PULSE_POINT_PITCH = 32
export const PULSE_TRACK_PADDING = 8

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

export interface PulseLaneStats {
  model?: string
  effort?: string
  tokens: number
  cost: number | null
}

export interface PulseLaneInput {
  agent: CommsAgent
  active: boolean
  stats?: PulseLaneStats
}

export interface PulseLaneLink {
  from: string
  to: string
}

export interface PulseLaneView {
  visible: string[]
  matched: ReadonlySet<string>
}

function relatedLanesOf(seed: string, links: readonly PulseLaneLink[]): Set<string> {
  const related = new Set<string>([seed])
  for (const link of links) {
    if (link.from === seed) related.add(link.to)
    else if (link.to === seed) related.add(link.from)
  }
  return related
}

export function pulseLaneVisibility(
  lanes: readonly PulseLaneInput[],
  rows: readonly CommsRow[],
  links: readonly PulseLaneLink[],
  selectedAgent: string | null,
  query: string,
  showQuiet: boolean,
): PulseLaneView {
  const needle = query.trim().toLowerCase()
  const related = selectedAgent === null ? null : relatedLanesOf(selectedAgent, links)
  if (needle !== '') {
    const matched = new Set(
      lanes
        .filter(lane => (related === null || related.has(lane.agent.id))
          && (lane.agent.name.toLowerCase().includes(needle)
            || (lane.agent.description ?? '').toLowerCase().includes(needle)))
        .map(lane => lane.agent.id),
    )
    const linked = new Set<string>()
    for (const link of links) {
      if (matched.has(link.from) && (related === null || related.has(link.to))) linked.add(link.to)
      else if (matched.has(link.to) && (related === null || related.has(link.from))) linked.add(link.from)
    }
    return {
      visible: lanes
        .filter(lane => matched.has(lane.agent.id) || linked.has(lane.agent.id))
        .map(lane => lane.agent.id),
      matched,
    }
  }
  if (related !== null) {
    return {
      visible: lanes.filter(lane => related.has(lane.agent.id)).map(lane => lane.agent.id),
      matched: new Set(),
    }
  }
  if (showQuiet || lanes.length <= 8) return { visible: lanes.map(lane => lane.agent.id), matched: new Set() }
  const communicating = new Set<string>()
  for (const row of rows) {
    communicating.add(fromPartyOf(row))
    communicating.add(row.to)
  }
  return {
    visible: lanes
      .filter(lane => lane.active || communicating.has(lane.agent.id))
      .map(lane => lane.agent.id),
    matched: new Set(),
  }
}

export function pulseTaskBadgeOf(id: string): string {
  return /^task-\d+$/.test(id) ? id.slice(5) : id
}

export function pulseTasksByAgent(team: FleetTeam | null): Map<string, readonly FleetTeamTask[]> {
  const map = new Map<string, FleetTeamTask[]>()
  if (team === null) return map
  for (const task of team.tasks) {
    const ownerId = taskOwnerIdOf(team, task)
    if (ownerId === undefined) continue
    const tasks = map.get(ownerId) ?? []
    tasks.push(task)
    map.set(ownerId, tasks)
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

export type PulseWorkAgentState = 'running' | 'latest_complete' | 'idle'

export interface PulseWorkItem {
  key: string
  id: string
  kind: 'team' | 'agent'
  subject: string
  status: 'pending' | 'in_progress' | 'completed' | 'idle' | 'latest_complete'
  ownerId?: string
  ownerName?: string
  ownerState?: PulseWorkAgentState
  ownerModel?: string
  description?: string
  blockedBy: string[]
  writeScopes: string[]
  warnings: string[]
  ready: boolean
}

function agentStateOf(node: AgentNode): PulseWorkAgentState
function agentStateOf(node: AgentNode | undefined): PulseWorkAgentState | undefined
function agentStateOf(node: AgentNode | undefined): PulseWorkAgentState | undefined {
  if (node === undefined) return undefined
  if (node.running) return 'running'
  if (node.subagent && node.completed) return 'latest_complete'
  return 'idle'
}

export function pulseWorkItemsOf(forest: AgentForest | null, team: FleetTeam | null): PulseWorkItem[] {
  const nodeOf = new Map((forest?.nodes ?? []).map(node => [node.id, node]))
  const teamRows: PulseWorkItem[] = (team?.tasks ?? []).map((task) => {
    const ownerId = taskOwnerIdOf(team, task)
    const ownerNode = ownerId !== undefined ? nodeOf.get(ownerId) : undefined
    const ownerState = agentStateOf(ownerNode)
    const ownerModel = ownerNode !== undefined ? modelLabelOf(ownerNode.model, ownerNode.reasoningEffort) : undefined
    const ownerName = task.ownerName ?? ownerNode?.label
    return {
      key: `team:${task.id}`,
      id: task.id,
      kind: 'team',
      subject: task.subject,
      status: task.status,
      ...(ownerId !== undefined ? { ownerId } : {}),
      ...(ownerName !== undefined ? { ownerName } : {}),
      ...(ownerState !== undefined ? { ownerState } : {}),
      ...(ownerModel !== undefined ? { ownerModel } : {}),
      ...(task.description !== '' ? { description: task.description } : {}),
      blockedBy: task.blockedBy,
      writeScopes: task.writeScopes,
      warnings: task.warnings,
      ready: task.ready,
    }
  })
  const agentRows: PulseWorkItem[] = familyOthersOf(forest, team).map((node) => {
    const ownerState = agentStateOf(node)
    const ownerModel = modelLabelOf(node.model, node.reasoningEffort)
    return {
      key: `agent:${node.id}`,
      id: node.id,
      kind: 'agent',
      subject: node.label,
      status: ownerState === 'running' ? 'in_progress' : ownerState,
      ownerId: node.id,
      ownerName: node.label,
      ownerState,
      ...(ownerModel !== undefined ? { ownerModel } : {}),
      blockedBy: [],
      writeScopes: [],
      warnings: [],
      ready: false,
    }
  })
  const order: Record<PulseWorkItem['status'], number> = { in_progress: 0, pending: 1, idle: 2, latest_complete: 3, completed: 4 }
  return [...teamRows, ...agentRows].sort((a, b) => order[a.status] - order[b.status])
}

export interface PulseWorkGroup {
  key: string
  ownerId?: string
  ownerName?: string
  items: PulseWorkItem[]
}

export function pulseWorkGroupsOf(items: readonly PulseWorkItem[]): PulseWorkGroup[] {
  const groups = new Map<string, PulseWorkGroup>()
  for (const item of items) {
    const key = item.ownerId !== undefined ? `id:${item.ownerId}`
      : item.ownerName !== undefined ? `name:${item.ownerName}` : 'unowned'
    const group = groups.get(key) ?? {
      key,
      ...(item.ownerId !== undefined ? { ownerId: item.ownerId } : {}),
      ...(item.ownerName !== undefined ? { ownerName: item.ownerName } : {}),
      items: [],
    }
    group.items.push(item)
    groups.set(key, group)
  }
  const unowned = groups.get('unowned')
  groups.delete('unowned')
  if (unowned !== undefined) groups.set('unowned', unowned)
  return [...groups.values()]
}

export type PulseWorkPhase = 'pending' | 'in_progress' | 'completed'

export function pulseWorkPhaseOf(item: PulseWorkItem): PulseWorkPhase {
  if (item.kind === 'team') return item.status as PulseWorkPhase
  if (item.status === 'in_progress') return 'in_progress'
  if (item.status === 'latest_complete') return 'completed'
  return 'pending'
}

export function pulseDependencyChainOf(items: readonly PulseWorkItem[], taskId: string): Set<string> {
  const blockers = new Map(items.filter(item => item.kind === 'team').map(item => [item.id, item.blockedBy]))
  const chain = new Set<string>()
  const queue = [...(blockers.get(taskId) ?? [])]
  for (let index = 0; index < queue.length; index++) {
    const id = queue[index]
    if (chain.has(id)) continue
    chain.add(id)
    queue.push(...(blockers.get(id) ?? []))
  }
  return chain
}
