import type { Category, CommandRecord, CommandStats, ContextEventRecord, FileOpRecord, RequestRecord, SessionCostUsage, SurfaceNode, SystemPromptNode, TimingSpan, TimingTotals } from '../shared/types'
import type { FoldBounds } from './config'

export interface CommandStateRecord extends CommandRecord {
  call?: string
}

export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
}

export interface TimelineHeadEvent {
  kind: number
  name: string
}

export interface TimelineHead {
  turns: number
  steps: number
  turnSteps: number[]
  turnKeys: (number | null)[]
  events: TimelineHeadEvent[]
  skills: Record<string, number>
  injects: number
  compactions: number
  prunes: number
  images: number
  toolCalls: number
}

export interface TimelineState {
  surface: SurfaceNode[]
  sums: Record<Category, number>
  assistantReasoning: number
  assistantAnswerTokens: number
  assistantCallTokens: number
  systemTokens: number
  systems?: SystemPromptNode[]
  toolsTokens: number
  model?: string
  provider?: string
  reasoningEffort?: string
  lastModel?: string
  contextWindow?: number
  maxOutputTokens?: number
  requests: RequestRecord[]
  turnRuns?: number
  events: ContextEventRecord[]
  archived: SurfaceNode[]
  cost?: SessionCostUsage
  generatedReasoning?: number
  generatedAnswerTokens?: number
  generatedCallTokens?: number
  humanInputs?: number
  answers?: number
  lastUser?: string
  archiveFloor?: number
  detailRev?: number
  timing?: TimingTotals
  stepStart?: {
    time: number
    firstToken?: number
  }
  stepWaits?: { start: number; end: number }[]
  stepApprovals?: Record<string, number>
  stepRequestSeq?: number
  stepBeats?: number[]
  stepBeatsFull?: boolean
  spans: TimingSpan[]
  stepSpans?: TimingSpan[]
  callNames: Record<string, { name: string; start: number; argsRaw?: string }>
  pendingShadowedSeqs?: number[]
  pendingShadowEventSeq?: number
  fileOps: FileOpRecord[]
  fileOpsFloor?: number
  commands: CommandStateRecord[]
  commandsFloor?: number
  commandStats?: CommandStats
  pendingCodeCmds?: Record<string, CommandStateRecord[]>
  pendingCodeOps?: Record<string, FileOpRecord[]>
  compact?: true
  head: TimelineHead
}

export const HEAD_KIND_NONE = 0
export const HEAD_KIND_INJECT = 1
export const HEAD_KIND_COMPACTION = 2
export const HEAD_KIND_PRUNE = 3

export function emptyHead(): TimelineHead {
  return {
    turns: 0,
    steps: 0,
    turnSteps: [],
    turnKeys: [],
    events: [],
    skills: {},
    injects: 0,
    compactions: 0,
    prunes: 0,
    images: 0,
    toolCalls: 0,
  }
}

export function cloneHead(head: TimelineHead): TimelineHead {
  return {
    ...head,
    turnSteps: [...head.turnSteps],
    turnKeys: [...head.turnKeys],
    events: [...head.events],
    skills: { ...head.skills },
  }
}

export function trimToLastTurns(requests: RequestRecord[], maxTurns: number): RequestRecord[] {
  let runs = 0
  let start = requests.length
  let prevTurn: number | undefined
  for (let i = requests.length - 1; i >= 0; i--) {
    const turn = requests[i].turn
    if (turn !== prevTurn) {
      if (runs >= maxTurns) break
      runs++
      prevTurn = turn
    }
    start = i
  }
  return requests.slice(start)
}

export function countTurnRuns(requests: RequestRecord[]): number {
  let runs = 0
  let prevTurn: number | undefined
  for (const r of requests) {
    if (r.turn !== prevTurn) {
      runs++
      prevTurn = r.turn
    }
  }
  return runs
}

function stepsOf(head: TimelineHead): number {
  let steps = 0
  for (const n of head.turnSteps) steps += n
  return steps
}

export function noteRequest(head: TimelineHead, record: RequestRecord, prev: RequestRecord | undefined, bounds: FoldBounds): void {
  const key = record.turn ?? null
  const prevKey = prev?.turn ?? null
  if (prev === undefined || key !== prevKey) {
    head.turnSteps.push(1)
    head.turnKeys.push(key)
  } else {
    head.turnSteps[head.turnSteps.length - 1] += 1
  }
  while (head.turnSteps.length > bounds.maxKeptTurns) {
    head.turnSteps.shift()
    head.turnKeys.shift()
  }
  const turnValues = new Set<number>()
  let retained = bounds.maxRequestSteps
  for (let index = head.turnSteps.length - 1; index >= 0 && retained > 0; index--) {
    turnValues.add(head.turnKeys[index] ?? 0)
    retained -= head.turnSteps[index]
  }
  head.turns = turnValues.size
  head.steps = Math.min(stepsOf(head), bounds.maxRequestSteps)
}

export function noteEvent(head: TimelineHead, kind: number, name: string, maxEvents: number): void {
  head.events.push({ kind, name })
  if (kind === HEAD_KIND_INJECT) head.injects += 1
  else if (kind === HEAD_KIND_COMPACTION) head.compactions += 1
  else if (kind === HEAD_KIND_PRUNE) head.prunes += 1
  if (name !== '' && name !== '__proto__') {
    head.skills[name] = (Object.hasOwn(head.skills, name) ? head.skills[name] : 0) + 1
  }
  while (head.events.length > maxEvents) {
    const old = head.events[0]
    head.events.shift()
    if (old.kind === HEAD_KIND_INJECT) head.injects -= 1
    else if (old.kind === HEAD_KIND_COMPACTION) head.compactions -= 1
    else if (old.kind === HEAD_KIND_PRUNE) head.prunes -= 1
    if (old.name !== '' && old.name !== '__proto__' && Object.hasOwn(head.skills, old.name)) {
      const count = head.skills[old.name] - 1
      if (count > 0) head.skills[old.name] = count
      else Reflect.deleteProperty(head.skills, old.name)
    }
  }
}

export function noteSurface(head: TimelineHead, node: SurfaceNode, sign: 1 | -1): void {
  if (node.imgs !== undefined) head.images += sign * node.imgs
  if (node.cat === 'tool' || (node.cat === 'skill' && node.tool !== undefined)) head.toolCalls += sign
}

const HEAD_SURFACE_KEYS = new Set(['seq', 'cat', 'tokens', 'reasoning', 'answerTokens', 'callTokens', 'imgs', 'tool'])

export function compactSurfaceNode(node: SurfaceNode): SurfaceNode {
  const next: SurfaceNode = { seq: node.seq, cat: node.cat, tokens: node.tokens }
  if (node.reasoning !== undefined) next.reasoning = node.reasoning
  if (node.answerTokens !== undefined) next.answerTokens = node.answerTokens
  if (node.callTokens !== undefined) next.callTokens = node.callTokens
  if (node.imgs !== undefined) next.imgs = node.imgs
  if (node.tool !== undefined) next.tool = node.tool
  return next
}

export function compactSurfaceNodeInPlace(node: SurfaceNode): void {
  for (const key of Object.keys(node)) {
    if (!HEAD_SURFACE_KEYS.has(key)) Reflect.deleteProperty(node, key)
  }
}

function deriveHead(state: TimelineState, bounds: FoldBounds): TimelineHead {
  const input = state as Partial<TimelineState>
  const head = emptyHead()
  let prev: RequestRecord | undefined
  for (const record of input.requests ?? []) {
    noteRequest(head, record, prev, bounds)
    prev = record
  }
  for (const ev of input.events ?? []) {
    let kind = HEAD_KIND_NONE
    if (ev.kind === 'inject') kind = HEAD_KIND_INJECT
    else if (ev.kind === 'compaction') kind = HEAD_KIND_COMPACTION
    else if (ev.kind === 'prune') kind = HEAD_KIND_PRUNE
    const name = ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '' ? ev.name : ''
    noteEvent(head, kind, name, bounds.maxEvents)
  }
  for (const node of state.surface) noteSurface(head, node, 1)
  return head
}

export function compactTimelineState(state: TimelineState, bounds: FoldBounds): TimelineState {
  const input = state as Partial<TimelineState>
  if (input.compact === true && input.head !== undefined) return state
  const callNamesIn = state.callNames
  const callNames: Record<string, { name: string; start: number }> = {}
  for (const key in callNamesIn) {
    const entry = callNamesIn[key]
    callNames[key] = { name: entry.name, start: entry.start }
  }
  const requests = input.requests ?? []
  const next: TimelineState = {
    ...state,
    compact: true,
    head: input.head ?? deriveHead(state, bounds),
    surface: state.surface.map(compactSurfaceNode),
    requests: requests.length > 0 ? [requests[requests.length - 1]] : [],
    events: [],
    archived: [],
    fileOps: [],
    commands: [],
    spans: [],
    callNames,
  }
  delete next.turnRuns
  delete next.fileOpsFloor
  delete next.commandsFloor
  delete next.commandStats
  delete next.pendingCodeCmds
  delete next.pendingCodeOps
  delete next.archiveFloor
  return next
}

export function trimState(st: TimelineState, bounds: FoldBounds): void {
  if (st.compact === true) return
  st.turnRuns = st.turnRuns ?? countTurnRuns(st.requests)
  if (st.turnRuns > bounds.maxKeptTurns) {
    st.requests = trimToLastTurns(st.requests, bounds.maxKeptTurns)
    st.turnRuns = countTurnRuns(st.requests)
  }
  if (st.requests.length > bounds.maxRequestSteps) {
    st.requests = st.requests.slice(-bounds.maxRequestSteps)
    st.turnRuns = countTurnRuns(st.requests)
  }
  if (st.events.length > bounds.maxEvents) st.events = st.events.slice(-bounds.maxEvents)
  if (st.spans.length > TIMING_SPANS_MAX) st.spans = st.spans.slice(-TIMING_SPANS_MAX)
  if (st.fileOps.length > bounds.maxFileOps) {
    const drop = st.fileOps.length - bounds.maxFileOps
    st.fileOpsFloor = Math.max(st.fileOpsFloor ?? 0, st.fileOps[drop - 1].seq)
    st.fileOps = st.fileOps.slice(drop)
  }
  if (st.commands.length > bounds.maxCommands) {
    let excess = st.commands.length - bounds.maxCommands
    let floor = 0
    const kept: CommandStateRecord[] = []
    for (const rec of st.commands) {
      if (excess > 0 && rec.status !== 'running') {
        excess--
        floor = Math.max(floor, rec.seq)
        continue
      }
      kept.push(rec)
    }
    if (kept.length > bounds.maxCommands) {
      const extra = kept.length - bounds.maxCommands
      for (const rec of kept.slice(0, extra)) floor = Math.max(floor, rec.seq)
      kept.splice(0, extra)
    }
    st.commandsFloor = Math.max(st.commandsFloor ?? 0, floor)
    st.commands = kept
  }
  if (st.archived.length > 0) {
    let drop = 0
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (st.archived.length - drop > bounds.maxArchiveNodes) {
      drop = st.archived.length - bounds.maxArchiveNodes
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

const TIMING_SPANS_MAX = 2_000

export function createTimelineState(full = true): TimelineState {
  return {
    surface: [],
    sums: { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 },
    assistantReasoning: 0,
    assistantAnswerTokens: 0,
    assistantCallTokens: 0,
    systemTokens: 0,
    toolsTokens: 0,
    requests: [],
    turnRuns: 0,
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    commands: [],
    spans: [],
    ...(full ? {} : { compact: true }),
    head: emptyHead(),
  }
}
