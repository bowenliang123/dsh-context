import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { milestoneKindOf, type MilestoneKind } from '../../shared/milestones'
import { boundaryIndex } from './trendModel'
import { BAR_GAP, BAR_W } from './trendWindow'

export { milestoneKindOf, type MilestoneKind } from '../../shared/milestones'

export const MILESTONE_PRIORITY: Record<MilestoneKind, number> = {
  compaction: 0,
  prune: 1,
  'goal-complete': 2,
  'team-task-complete': 3,
  'todo-done': 4,
  'goal-create': 5,
  'team-task-create': 6,
  'todo-add': 7,
  ask: 8,
  longest: 9,
  growth: 10,
  spawn: 11,
  agent: 12,
  skill: 13,
  model: 14,
}

export interface MilestoneEventEntry {
  kind: MilestoneKind
  events: ContextEventRecord[]
}

export interface MilestoneMetricEntry {
  kind: 'longest' | 'growth'
  value: number
}

export type MilestoneEntry = MilestoneEventEntry | MilestoneMetricEntry

export interface MilestoneGroup {
  key: string
  targetIdx: number
  targetSeq: number
  targetTurn: number | null
  anchor: 'boundary' | 'bar'
  leadKind: MilestoneKind
  entries: MilestoneEntry[]
  count: number
  members?: MilestoneGroup[]
}

export interface MilestoneGeometry {
  shownFrom: number
  shownTo: number
  leftPad: number
}

export interface MilestoneBandItem {
  key: string
  x: number
  maxIcons: number
  group: MilestoneGroup
  align?: 'start' | 'end'
}

interface Peak {
  idx: number
  value: number
}

export function isMetricEntry(entry: MilestoneEntry): entry is MilestoneMetricEntry {
  return entry.kind === 'longest' || entry.kind === 'growth'
}

export function eventTargetIndex(
  requests: RequestRecord[],
  ev: ContextEventRecord,
  granularity: 'step' | 'turn',
): number {
  if (granularity === 'turn' && typeof ev.turn === 'number') {
    const at = requests.findIndex(r => (r.turn ?? 0) === ev.turn)
    if (at >= 0) return at
  }
  return boundaryIndex(requests, ev.seq)
}

export function metricPeaksOf(requests: RequestRecord[]): { longest: Peak | null; growth: Peak | null } {
  let longest: Peak | null = null
  let growth: Peak | null = null
  let prev: number | null = null
  for (let i = 0; i < requests.length; i++) {
    const req = requests[i]
    const activeMs = req.activeMs ?? 0
    if (activeMs > 0 && (longest === null || activeMs > longest.value)) longest = { idx: i, value: activeMs }
    if (prev !== null) {
      const delta = req.total - prev
      if (delta > 0 && (growth === null || delta > growth.value)) growth = { idx: i, value: delta }
    }
    prev = req.total
  }
  return { longest, growth }
}

export function milestonesOf(
  requests: RequestRecord[],
  events: ContextEventRecord[],
  granularity: 'step' | 'turn',
): MilestoneGroup[] {
  const groups = new Map<string, MilestoneGroup>()
  const groupAt = (idx: number, anchor: 'boundary' | 'bar', kind: MilestoneKind): MilestoneGroup => {
    const target = requests[idx]
    const key = (anchor === 'bar' ? 'm:' : 'b:') + String(idx)
    const hit = groups.get(key)
    if (hit !== undefined) return hit
    const group: MilestoneGroup = {
      key,
      targetIdx: idx,
      targetSeq: target.seq,
      targetTurn: typeof target.turn === 'number' ? target.turn : null,
      anchor,
      leadKind: kind,
      entries: [],
      count: 0,
    }
    groups.set(key, group)
    return group
  }
  for (const ev of events) {
    const kind = milestoneKindOf(ev)
    if (kind === null) continue
    const idx = eventTargetIndex(requests, ev, granularity)
    if (idx < 0) continue
    const group = groupAt(idx, 'boundary', kind)
    let entry = group.entries.find((item): item is MilestoneEventEntry =>
      !isMetricEntry(item) && item.kind === kind)
    if (entry === undefined) {
      entry = { kind, events: [] }
      group.entries.push(entry)
    }
    entry.events.push(ev)
    group.count += 1
  }
  const peaks = metricPeaksOf(requests)
  const addMetric = (peak: Peak | null, kind: 'longest' | 'growth'): void => {
    if (peak === null) return
    const group = groupAt(peak.idx, 'bar', kind)
    group.entries.push({ kind, value: peak.value })
    group.count += 1
  }
  addMetric(peaks.longest, 'longest')
  addMetric(peaks.growth, 'growth')
  const rank = (group: MilestoneGroup): number => group.anchor === 'boundary' ? 0 : 1
  for (const group of groups.values()) {
    group.entries.sort((a, b) => MILESTONE_PRIORITY[a.kind] - MILESTONE_PRIORITY[b.kind])
    group.leadKind = group.entries[0].kind
  }
  return [...groups.values()].sort((a, b) => a.targetIdx - b.targetIdx || rank(a) - rank(b))
}

export function milestoneJumpSeq(group: MilestoneGroup): number {
  for (const entry of group.entries) {
    if (!isMetricEntry(entry) && entry.events.length > 0) return entry.events[0].seq
  }
  return group.targetSeq
}

const MS_HEAD_PAD = 8

const MS_HEAD_GAP = 12

function setIconCapacity(items: MilestoneBandItem[]): void {
  for (let i = 0; i < items.length; i++) {
    const left = i > 0 ? items[i].x - items[i - 1].x : Infinity
    const right = i + 1 < items.length ? items[i + 1].x - items[i].x : Infinity
    const spread = Math.min(left, right)
    items[i].maxIcons = spread >= 40 ? 3 : spread >= 26 ? 2 : 1
  }
}

export function bandItemsOf(groups: MilestoneGroup[], geometry: MilestoneGeometry): MilestoneBandItem[] {
  const pitch = BAR_W + BAR_GAP
  const items: MilestoneBandItem[] = []
  for (const group of mergeSameTarget(groups)) {
    if (group.targetIdx < geometry.shownFrom || group.targetIdx > geometry.shownTo) continue
    const local = group.targetIdx - geometry.shownFrom
    const base = geometry.leftPad + (geometry.leftPad > 0 ? BAR_GAP : 0)
    const x = base + local * pitch + (group.anchor === 'bar' ? BAR_W / 2 : -BAR_GAP / 2)
    items.push({ key: group.key, x, maxIcons: 3, group, ...(x < MS_HEAD_PAD ? { align: 'start' as const } : {}) })
  }
  items.sort((a, b) => a.x - b.x)
  const packed = packNearby(items)
  setIconCapacity(packed)
  return packed
}

const FIT_CLUSTER_PX = 14

function mergeCluster(members: MilestoneGroup[]): MilestoneGroup {
  const byKind = new Map<MilestoneKind, MilestoneEntry>()
  const owner = new Map<MilestoneKind, MilestoneGroup>()
  const entries: MilestoneEntry[] = []
  for (const group of members) {
    for (const entry of group.entries) {
      const hit = byKind.get(entry.kind)
      if (hit === undefined) {
        const copy: MilestoneEntry = isMetricEntry(entry)
          ? { kind: entry.kind, value: entry.value }
          : { kind: entry.kind, events: [...entry.events] }
        byKind.set(entry.kind, copy)
        owner.set(entry.kind, group)
        entries.push(copy)
        continue
      }
      if (!isMetricEntry(hit) && !isMetricEntry(entry)) hit.events.push(...entry.events)
    }
  }
  entries.sort((a, b) => MILESTONE_PRIORITY[a.kind] - MILESTONE_PRIORITY[b.kind])
  const lead = entries[0]
  const representative = owner.get(lead.kind) as MilestoneGroup
  return {
    key: 'c:' + members[0].key + ':' + members[members.length - 1].key,
    targetIdx: representative.targetIdx,
    targetSeq: representative.targetSeq,
    targetTurn: representative.targetTurn,
    anchor: entries.every(isMetricEntry) ? 'bar' : 'boundary',
    leadKind: lead.kind,
    entries,
    count: members.reduce((sum, group) => sum + group.count, 0),
    members,
  }
}

function mergeSameTarget(groups: MilestoneGroup[]): MilestoneGroup[] {
  const byTarget = new Map<number, MilestoneGroup[]>()
  for (const group of groups) {
    const list = byTarget.get(group.targetIdx)
    if (list === undefined) byTarget.set(group.targetIdx, [group])
    else list.push(group)
  }
  return [...byTarget.values()].map(list => list.length === 1 ? list[0] : mergeCluster(list))
}

function packNearby(items: MilestoneBandItem[]): MilestoneBandItem[] {
  const packed: MilestoneBandItem[] = []
  for (const item of items) {
    const prev = packed.length > 0 ? packed[packed.length - 1] : undefined
    if (prev === undefined || item.x - prev.x >= MS_HEAD_GAP) {
      packed.push(item)
      continue
    }
    const group = mergeCluster([prev.group, item.group])
    const owner = group.targetIdx === item.group.targetIdx ? item : prev
    packed[packed.length - 1] = {
      key: group.key,
      x: owner.x,
      maxIcons: 3,
      group,
      ...(owner.align !== undefined ? { align: owner.align } : {}),
    }
  }
  return packed
}

export function fitBandItemsOf(
  groups: MilestoneGroup[],
  width: number,
  denominator: number,
): MilestoneBandItem[] {
  if (width <= 0) return []
  const span = Math.max(1, denominator)
  const placed = mergeSameTarget(groups).map((group) => {
    const fraction = (group.targetIdx + (group.anchor === 'bar' ? 0 : -0.5)) / span
    return { group, x: Math.min(width, Math.max(0, fraction * width)) }
  }).sort((a, b) => a.x - b.x)
  const buckets: { members: MilestoneGroup[]; from: number; to: number }[] = []
  for (const item of placed) {
    const last = buckets.length > 0 ? buckets[buckets.length - 1] : null
    if (last !== null && item.x - last.to < FIT_CLUSTER_PX) {
      last.members.push(item.group)
      last.to = item.x
    } else {
      buckets.push({ members: [item.group], from: item.x, to: item.x })
    }
  }
  const items: MilestoneBandItem[] = buckets.map((bucket) => {
    const group = bucket.members.length === 1 ? bucket.members[0] : mergeCluster(bucket.members)
    const x = (bucket.from + bucket.to) / 2
    return {
      key: group.key,
      x,
      maxIcons: 3,
      group,
      ...(x < MS_HEAD_PAD ? { align: 'start' as const } : x > width - MS_HEAD_PAD ? { align: 'end' as const } : {}),
    }
  })
  setIconCapacity(items)
  return items
}
