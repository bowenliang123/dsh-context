import type { CommandRecord, ContextTimelineDetail, Snapshot, ToolTimingTotals } from '../shared/types'
import { copyCostUsage } from './foldMetering'
import type { FoldBounds } from './config'
import type { CommandStateRecord, TimelineState } from './foldState'

export function serveCommand(rec: CommandStateRecord): CommandRecord {
  const copy: CommandStateRecord = { ...rec }
  delete copy.call
  return copy
}

function headFieldsOf(state: TimelineState): Snapshot {
  const surfaceTotal = state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  const images = state.head.images
  const toolCalls = state.head.toolCalls
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

function detailCollectionsOf(state: TimelineState, bounds: FoldBounds): Omit<ContextTimelineDetail, 'rev'> {
  const result: Omit<ContextTimelineDetail, 'rev'> = {
    requests: state.requests.map(r => ({ ...r })),
    events: state.events.map(e => ({ ...e })),
    nodes: [],
    droppedNodes: 0,
    archive: state.archived.map(n => ({ ...n })),
    fileOps: state.fileOps.map(o => ({ ...o })),
    ...(state.fileOpsFloor !== undefined ? { fileOpsFloor: state.fileOpsFloor } : {}),
    commands: state.commands.map(serveCommand),
    ...(state.commandsFloor !== undefined ? { commandsFloor: state.commandsFloor } : {}),
    ...(state.commandStats !== undefined ? { commandStats: { ...state.commandStats } } : {}),
    spans: state.spans.map(s => ({ ...s })),
  }
  const overflowCount = Math.max(0, state.surface.length - bounds.maxNodes)
  const overflow = state.surface.slice(0, overflowCount)
  const tail = state.surface.slice(overflowCount)
  const pinned = overflow.filter(n => n.cat === 'inject' || n.cat === 'skill')
  result.nodes = pinned.length > 0 ? [...pinned, ...tail] : tail
  result.droppedNodes = overflowCount - pinned.length
  if (result.droppedNodes > 0) {
    let floor = 0
    for (const n of overflow) if (n.cat !== 'inject' && n.cat !== 'skill') floor = Math.max(floor, n.seq)
    result.surfaceFloor = floor
  }
  if (state.archiveFloor !== undefined) result.archiveFloor = state.archiveFloor

  const requests = result.requests
  const events = result.events
  let ri = 0
  for (const ev of events) {
    while (ri < requests.length && requests[ri].seq <= ev.seq) ri++
    const next = requests.at(ri)
    const prev = ri > 0 ? requests.at(ri - 1) : undefined
    if (next !== undefined && typeof next.turn === 'number' && typeof next.step === 'number') {
      ev.turn = next.turn
      ev.step = next.step
    }
    if (prev !== undefined && typeof prev.turn === 'number' && typeof prev.step === 'number') {
      ev.fromTurn = prev.turn
      ev.fromStep = prev.step
    }
  }
  return result
}

export function buildTimelineHead(state: TimelineState): Snapshot {
  const result = headFieldsOf(state)
  result.counts = {
    turns: state.head.turns,
    steps: state.head.steps,
    injects: state.head.injects,
    compactions: state.head.compactions,
    prunes: state.head.prunes,
    skills: Object.keys(state.head.skills).length,
  }
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
