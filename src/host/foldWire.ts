import type { CommandRecord, ContextTimelineDetail, RequestRecord, Snapshot, ToolTimingTotals } from '../shared/types'
import { attachTurnSpans } from '../shared/turnSpans'
import { copyCostUsage } from './foldMetering'
import type { FoldBounds } from './config'
import type { CommandStateRecord, TimelineState } from './foldState'
import { surfaceWindowOf } from './foldState'

export function serveCommand(rec: CommandStateRecord): CommandRecord {
  const copy: CommandStateRecord = { ...rec }
  delete copy.call
  return copy
}

function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  let images = 0
  let toolCalls = 0
  for (const node of state.surface) {
    if (node.imgs !== undefined) images += node.imgs
    if (node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined)) toolCalls++
  }
  const result: Snapshot = {
    ok: true,
    ...(state.model !== undefined ? { model: state.model } : {}),
    ...(state.provider !== undefined ? { provider: state.provider } : {}),
    ...(state.reasoningEffort !== undefined ? { reasoningEffort: state.reasoningEffort } : {}),
    ...(state.contextWindow !== undefined ? { contextWindow: state.contextWindow } : {}),
    ...(state.maxOutputTokens !== undefined ? { maxOutputTokens: state.maxOutputTokens } : {}),
    current: {
      system: state.systemTokens,
      tools: state.toolsTokens,
      user: state.sums.user,
      inject: state.sums.inject,
      skill: state.sums.skill,
      assistant: state.sums.assistant,
      assistantReasoning: state.assistantReasoning,
      assistantAnswerTokens: state.assistantAnswerTokens,
      assistantCallTokens: state.assistantCallTokens,
      tool: state.sums.tool,
      total: surfaceTotal + state.systemTokens + state.toolsTokens,
    },
    images,
    toolCalls,
    ...(state.toolTally === undefined ? {} : { toolTally: { ...state.toolTally } }),
    ...(state.programTally === undefined ? {} : { programTally: { ...state.programTally } }),
    ...(state.commandStats === undefined ? {} : { commandStats: { ...state.commandStats } }),
    humanInputs: state.humanInputs ?? 0,
    answers: state.answers ?? 0,
    ...(state.lastUser !== undefined ? { lastUser: state.lastUser } : {}),
    ...(state.generatedReasoning !== undefined ? { generatedReasoning: state.generatedReasoning } : {}),
    ...(state.generatedAnswerTokens !== undefined ? { generatedAnswerTokens: state.generatedAnswerTokens } : {}),
    ...(state.generatedCallTokens !== undefined ? { generatedCallTokens: state.generatedCallTokens } : {}),
    requests: [],
    events: [],
    nodes: [],
    droppedNodes: 0,
    archive: [],
  }
  if (state.cost !== undefined) {
    result.cost = copyCostUsage(state.cost)
  }
  if (state.timing !== undefined) {
    const tools: Record<string, ToolTimingTotals> = {}
    for (const k in state.timing.tools) tools[k] = { ...state.timing.tools[k] }
    result.timing = { ...state.timing, tools }
  }
  if (state.systems !== undefined && state.systems.length > 0) {
    result.systems = state.systems.map(n => ({ ...n }))
  }
  return result
}

export function requestRowsOf(state: TimelineState): RequestRecord[] {
  return state.requests
    .filter((r): r is RequestRecord => typeof (r as { system?: unknown }).system === 'number')
    .map(r => ({ ...r }))
}

export function eventsOf(state: TimelineState, requests: readonly RequestRecord[] = requestRowsOf(state)): ContextTimelineDetail['events'] {
  return attachTurnSpans(state.events, requests)
}

function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const requests = requestRowsOf(state)
  const window = surfaceWindowOf(state, bounds.maxNodes, bounds.maxArchiveNodes)
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests,
    events: eventsOf(state, requests),
    nodes: window.nodes,
    droppedNodes: window.droppedNodes,
    archive: window.archive.map(node => ({ ...node })),
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
    commands: state.commands.map(serveCommand),
    ...(state.commandsFloor !== undefined ? { commandsFloor: state.commandsFloor } : {}),
    ...(state.commandStats !== undefined ? { commandStats: { ...state.commandStats } } : {}),
    spans: state.spans.map(s => ({ ...s })),
  }
  if (window.surfaceFloor !== undefined) result.surfaceFloor = window.surfaceFloor
  if (window.archiveFloor !== undefined) result.archiveFloor = window.archiveFloor
  return result
}

function skillNamesCountOf(state: TimelineState): number {
  const names = state.totals?.skills
  if (names !== undefined) return Object.keys(names).length
  const skills = new Set<string>()
  for (const e of state.events) {
    if (e.sub === 'skill' && typeof e.name === 'string' && e.name !== '') skills.add(e.name)
  }
  return skills.size
}

function retainedCountsOf(state: TimelineState): NonNullable<Snapshot['counts']> {
  const turns = new Set<number>()
  for (const r of state.requests) turns.add(r.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  for (const e of state.events) {
    if (e.kind === 'inject') injects++
    else if (e.kind === 'compaction') compactions++
    else if (e.kind === 'prune') prunes++
  }
  return {
    turns: turns.size,
    steps: state.requests.length,
    injects,
    compactions,
    prunes,
    skills: skillNamesCountOf(state),
  }
}

function countsOf(state: TimelineState): NonNullable<Snapshot['counts']> {
  const totals = state.totals
  return totals !== undefined
    ? {
      turns: totals.turns,
      steps: totals.steps,
      injects: totals.injects,
      compactions: totals.compactions,
      prunes: totals.prunes,
      skills: skillNamesCountOf(state),
    }
    : retainedCountsOf(state)
}

export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  result.counts = countsOf(state)
  const last = state.requests.at(-1)
  if (last !== undefined) {
    result.last = { seq: last.seq, total: last.total, ...(typeof last.prompt === 'number' ? { prompt: last.prompt } : {}) }
  }
  result.detailRev = state.detailRev ?? 0
  return result
}

export function buildTimelineDetail(state: TimelineState, bounds: FoldBounds): ContextTimelineDetail {
  return { rev: state.detailRev ?? 0, head: buildTimelineHead(state), ...detailCollectionsOf(state, bounds) }
}

export function buildTimelineView(state: TimelineState, bounds: FoldBounds): Snapshot {
  const result: Snapshot = { ...headFieldsOf(state), ...detailCollectionsOf(state, bounds) }
  result.counts = countsOf(state)
  return result
}
