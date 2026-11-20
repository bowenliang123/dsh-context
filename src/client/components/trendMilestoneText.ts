import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import type { ViewKit } from '../viewkit'
import { isMetricEntry, type MilestoneEntry, type MilestoneGroup, type MilestoneKind } from './trendMilestones'

export interface MilestoneTextOptions {
  granularity: 'step' | 'turn'
  stepsOf: (turn: number | undefined) => number
}

type TextKit = Pick<ViewKit, 't' | 'fmt' | 'fmtDuration'>

const NAMES_MAX = 24

function nameList(names: string[], missingBase = 0): string {
  const listed = names.slice(0, NAMES_MAX)
  const missing = Math.max(0, missingBase + names.length - listed.length)
  return listed.join(', ') + (missing > 0 ? (listed.length > 0 ? ' ' : '') + '+' + String(missing) : '')
}

export function milestoneKindLabel(t: ViewKit['t'], granularity: 'step' | 'turn', kind: MilestoneKind): string {
  if (kind === 'longest') return t(granularity === 'turn' ? 'trend.ms.longestTurn' : 'trend.ms.longest')
  if (kind === 'growth') return t(granularity === 'turn' ? 'trend.ms.growthTurn' : 'trend.ms.growth')
  return t('trend.ms.' + kind)
}

function agentEventLabel(t: ViewKit['t'], ev: ContextEventRecord): string {
  if (ev.name === 'subagent-settled') return t('trend.ms.agentDone')
  if (ev.name === 'agent-message') return t('trend.ms.agentMessage')
  if (ev.name === 'team-message') return t('trend.ms.agentTeam')
  if (ev.name === 'session-reference') return t('trend.ms.agentRef')
  return t('trend.ms.agent')
}

function agentEntryLabel(t: ViewKit['t'], events: ContextEventRecord[]): string {
  const first = agentEventLabel(t, events[0])
  for (let i = 1; i < events.length; i++) {
    if (agentEventLabel(t, events[i]) !== first) return t('trend.ms.agent')
  }
  return first
}

export function milestoneEntryRows(kit: TextKit, granularity: 'step' | 'turn', entry: MilestoneEntry): string[] {
  const label = !isMetricEntry(entry) && entry.kind === 'agent'
    ? agentEntryLabel(kit.t, entry.events)
    : milestoneKindLabel(kit.t, granularity, entry.kind)
  if (isMetricEntry(entry)) {
    return [label + ' · ' + (entry.kind === 'longest' ? kit.fmtDuration(entry.value) : '+' + kit.fmt(entry.value))]
  }
  const first = entry.events[0]
  const more = entry.events.length > 1 ? ' ×' + String(entry.events.length) : ''
  if (entry.kind === 'goal-create' || entry.kind === 'goal-complete'
    || entry.kind === 'team-task-complete') {
    const names = entry.events
      .map(ev => ev.name)
      .filter((name): name is string => name !== undefined && name !== '')
    if (entry.events.length > 1) {
      const head = label + ' · ×' + String(entry.events.length)
      return names.length > 0 ? [head, nameList(names)] : [head]
    }
    return [label + (names.length > 0 ? ' · ' + names[0] : '')]
  }
  if (entry.kind === 'todo-add' || entry.kind === 'team-task-create') {
    let count = 0
    for (const ev of entry.events) count += ev.count ?? 1
    return [label + (count > 1 ? ' · ×' + String(count) : '')]
  }
  if (entry.kind === 'todo-done' || entry.kind === 'ask') {
    const items: string[] = []
    let count = 0
    for (const ev of entry.events) {
      count += ev.count ?? ev.items?.length ?? 1
      for (const item of ev.items ?? []) {
        if (!items.includes(item)) items.push(item)
      }
    }
    if (count > 1) {
      const head = label + ' · ×' + String(count)
      return [head, nameList(items, Math.max(0, count - items.length))]
    }
    const name = items.length > 0 ? items[0] : first.name ?? ''
    return [label + (name !== '' ? ' · ' + name : '')]
  }
  if (entry.kind === 'compaction' || entry.kind === 'prune') {
    let tokens = 0
    for (const ev of entry.events) tokens += ev.tokens ?? 0
    return [label + more + (tokens > 0 ? ' · −' + kit.fmt(tokens) : '')]
  }
  if (entry.kind === 'model') {
    const route = first.from !== undefined || first.to !== undefined
      ? ' · ' + (first.from ?? '?') + ' → ' + (first.to ?? '?')
      : ''
    return [label + route + more]
  }
  const names = entry.events
    .map(ev => entry.kind === 'agent' ? ev.agent : ev.name)
    .filter((name): name is string => name !== undefined && name !== '')
  if (entry.events.length > 1) {
    const head = label + ' · ×' + String(entry.events.length)
    return names.length > 0 ? [head, nameList(names)] : [head]
  }
  return [label + (names.length > 0 ? ' · ' + names[0] : '')]
}

export function milestoneTipRows(
  kit: TextKit,
  opts: MilestoneTextOptions,
  group: MilestoneGroup,
  req: RequestRecord,
): string[] {
  const n = req.stepCount ?? 1
  const head = opts.granularity === 'turn'
    ? (n > 1 ? kit.t('tip.turn', { t: req.turn ?? 0, n }) : kit.t('tip.turn1', { t: req.turn ?? 0 }))
    : kit.t('tip.step', { t: req.turn ?? 0, s: req.step ?? 0, n: opts.stepsOf(req.turn) })
  const cluster = group.members !== undefined && group.members.some(member => member.targetIdx !== group.targetIdx)
  return [
    head,
    ...(cluster ? [kit.t('trend.ms.cluster')] : []),
    ...group.entries.flatMap(entry => milestoneEntryRows(kit, opts.granularity, entry)),
    kit.t('trend.ms.open'),
  ]
}

export function milestoneLabel(
  kit: TextKit,
  opts: MilestoneTextOptions,
  group: MilestoneGroup,
  req: RequestRecord,
): string {
  return milestoneTipRows(kit, opts, group, req).join('. ')
}
