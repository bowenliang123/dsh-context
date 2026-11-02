import type { AgentForest } from './agentTree'
import { fromPartyOf, type CommsAgent } from './commsModel'
import type { CommsRow } from './fleetDetail'
import { familyOthersOf, memberIdByName, type FleetTeam } from './fleetTeam'

export interface PulseDomain {
  start: number
  end: number
}

export function pulseDomainOf(rows: readonly CommsRow[]): PulseDomain | null {
  if (rows.length === 0) return null
  let start = rows[0].time
  let end = rows[0].time
  for (const row of rows) {
    start = Math.min(start, row.time)
    end = Math.max(end, row.time)
  }
  return { start, end }
}

export function pulsePositionOf(time: number, domain: PulseDomain | null): number {
  if (domain === null || domain.end === domain.start) return 50
  return ((time - domain.start) / (domain.end - domain.start)) * 100
}

export interface PulseBin extends PulseDomain {
  index: number
  count: number
}

export function pulseBinsOf(rows: readonly CommsRow[], domain: PulseDomain | null, count = 24): PulseBin[] {
  if (domain === null) return []
  if (domain.start === domain.end) {
    return [{ index: 0, start: domain.start, end: domain.end, count: rows.length }]
  }
  const size = Math.max(1, Math.floor(count))
  const bins: PulseBin[] = Array.from({ length: size }, (_, index) => ({
    index,
    start: domain.start + ((domain.end - domain.start) * index) / size,
    end: domain.start + ((domain.end - domain.start) * (index + 1)) / size,
    count: 0,
  }))
  for (const row of rows) {
    const position = pulsePositionOf(row.time, domain)
    const index = Math.min(size - 1, Math.floor((position / 100) * size))
    bins[Math.max(0, index)].count += 1
  }
  return bins
}

export function pulseTimelineRowsOf(
  rows: readonly CommsRow[],
  bins: readonly PulseBin[],
  selectedStart: number | 'all' | null,
  selectedKey: string | null,
  limit = 400,
): CommsRow[] {
  const active = typeof selectedStart === 'number'
    ? bins.find(bin => bin.start === selectedStart)
    : selectedStart === null && rows.length > 200 ? [...bins].reverse().find(bin => bin.count > 0) : undefined
  const filtered = active === undefined
    ? [...rows]
    : rows.filter(row => row.time >= active.start && (active.index === bins.length - 1 ? row.time <= active.end : row.time < active.end))
  const bounded = filtered.length > limit ? filtered.slice(0, limit) : filtered
  const selected = selectedKey !== null ? rows.find(row => row.key === selectedKey) : undefined
  if (selected !== undefined && !bounded.some(row => row.key === selected.key)) bounded.push(selected)
  return bounded
}

export interface PulseLaneLayout {
  id: string
  top: number
  height: number
  center: number
}

export interface PulsePointLayout {
  key: string
  row: CommsRow
  x: number
  y: number
  level: number
}

export interface PulseLayout {
  domain: PulseDomain | null
  lanes: PulseLaneLayout[]
  points: PulsePointLayout[]
  bins: PulseBin[]
  height: number
}

export function layoutPulse(
  rows: readonly CommsRow[],
  laneIds: readonly string[],
  binCount = 24,
  domainOverride?: PulseDomain | null,
): PulseLayout {
  const domain = domainOverride === undefined ? pulseDomainOf(rows) : domainOverride
  const lanes: PulseLaneLayout[] = []
  const points: PulsePointLayout[] = []
  const rowsAt = new Map<string, CommsRow[]>()
  for (const row of rows) {
    const laneRows = rowsAt.get(row.to)
    if (laneRows === undefined) rowsAt.set(row.to, [row])
    else laneRows.push(row)
  }
  let top = 0
  for (const id of laneIds) {
    const laneRows = (rowsAt.get(id) ?? [])
      .sort((a, b) => (a.time - b.time) || a.key.localeCompare(b.key))
    const placed: Array<{ row: CommsRow; x: number; level: number }> = []
    let previousX = Number.NEGATIVE_INFINITY
    let level = 0
    let maxLevel = 0
    for (const row of laneRows) {
      const x = pulsePositionOf(row.time, domain)
      level = x - previousX < 2 ? level + 1 : 0
      previousX = x
      maxLevel = Math.max(maxLevel, level)
      placed.push({ row, x, level })
    }
    const height = 40 + maxLevel * 14
    const lane = { id, top, height, center: top + height / 2 }
    lanes.push(lane)
    for (const entry of placed) {
      points.push({
        key: entry.row.key,
        row: entry.row,
        x: entry.x,
        y: top + 20 + entry.level * 14,
        level: entry.level,
      })
    }
    top += height
  }
  return { domain, lanes, points, bins: pulseBinsOf(rows, domain, binCount), height: top }
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
