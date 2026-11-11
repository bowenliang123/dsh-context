import type { Category, CommandRecord, CommandStats, ContextEventRecord, FileOpRecord, SessionCostUsage, SurfaceNode, SurfaceNodeWindow, SystemPromptNode, TimingSpan, TimingTotals } from '../shared/types'
import type { SlimRequestRecord } from '../shared/types'
import type { FoldBounds } from './config'

const SURFACE_CATS: readonly Category[] = ['user', 'inject', 'skill', 'assistant', 'tool']

function finiteOf(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function slimSurfaceNode(node: SurfaceNode): SurfaceNode {
  const slim: SurfaceNode = { seq: node.seq, cat: node.cat, tokens: node.tokens }
  if (node.reasoning !== undefined) slim.reasoning = node.reasoning
  if (node.answerTokens !== undefined) slim.answerTokens = node.answerTokens
  if (node.callTokens !== undefined) slim.callTokens = node.callTokens
  if (node.imgs !== undefined) slim.imgs = node.imgs
  if (node.tool !== undefined) slim.tool = node.tool
  return slim
}

function slimSurfaceVal(node: unknown): SurfaceNode | undefined {
  if (node === null || typeof node !== 'object') return undefined
  const n = node as Record<string, unknown>
  if (!finiteOf(n.seq) || !finiteOf(n.tokens)) return undefined
  if (typeof n.cat !== 'string' || !(SURFACE_CATS as readonly string[]).includes(n.cat)) return undefined
  return slimSurfaceNode({
    seq: n.seq,
    cat: n.cat as Category,
    tokens: n.tokens,
    ...(finiteOf(n.reasoning) ? { reasoning: n.reasoning } : {}),
    ...(finiteOf(n.answerTokens) ? { answerTokens: n.answerTokens } : {}),
    ...(finiteOf(n.callTokens) ? { callTokens: n.callTokens } : {}),
    ...(finiteOf(n.imgs) ? { imgs: n.imgs } : {}),
    ...(typeof n.tool === 'string' ? { tool: n.tool } : {}),
  })
}

function slimRequestVal(rec: unknown): SlimRequestRecord | undefined {
  if (rec === null || typeof rec !== 'object') return undefined
  const r = rec as Record<string, unknown>
  if (!finiteOf(r.time) || !finiteOf(r.seq) || !finiteOf(r.total)) return undefined
  const slim: SlimRequestRecord = { time: r.time, seq: r.seq, total: r.total }
  if (finiteOf(r.turn)) slim.turn = r.turn
  if (finiteOf(r.step)) slim.step = r.step
  if (finiteOf(r.prompt)) slim.prompt = r.prompt
  if (finiteOf(r.activeMs)) slim.activeMs = r.activeMs
  return slim
}

function sumsOf(value: unknown): TimelineState['sums'] | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const sums: Record<Category, number> = { user: 0, inject: 0, skill: 0, assistant: 0, tool: 0 }
  for (const cat of SURFACE_CATS) {
    const n = (value as Record<string, unknown>)[cat]
    if (!finiteOf(n)) return undefined
    sums[cat] = n
  }
  return sums
}

export function deriveHeadState(val: unknown): TimelineState | undefined {
  if (val === null || typeof val !== 'object') return undefined
  const prev = val as Record<string, unknown>
  if (!Array.isArray(prev.surface) || !Array.isArray(prev.requests) || !Array.isArray(prev.commands)
    || !Array.isArray(prev.events)) return undefined
  const sums = sumsOf(prev.sums)
  if (sums === undefined) return undefined
  const surface: SurfaceNode[] = []
  for (const node of prev.surface) {
    const slim = slimSurfaceVal(node)
    if (slim === undefined) return undefined
    surface.push(slim)
  }
  const requests: SlimRequestRecord[] = []
  for (const rec of prev.requests) {
    const slim = slimRequestVal(rec)
    if (slim === undefined) return undefined
    requests.push(slim)
  }
  const commands = slimCommands(prev.commands)
  const pendingCodeCmds = slimPendingCommands(prev.pendingCodeCmds)
  const { pendingCodeCmds: _prevPending, ...rest } = prev
  const state = {
    ...rest,
    sums,
    surface,
    requests,
    commands,
    ...(pendingCodeCmds === undefined ? {} : { pendingCodeCmds }),
    spans: [],
    fileOps: [],
    archived: [],
  } as unknown as TimelineState
  for (const rec of commands) {
    if (typeof rec.call === 'string') noteCommandCall(state, rec.call)
  }
  if (pendingCodeCmds !== undefined) {
    for (const records of Object.values(pendingCodeCmds)) {
      for (const rec of records) {
        if (typeof rec.call === 'string') noteCommandCall(state, rec.call)
      }
    }
  }
  trimHeadState(state)
  return state
}

export interface CommandStateRecord extends CommandRecord {
  call?: string
}

function slimCommandRecord(rec: CommandStateRecord): CommandStateRecord {
  const { cmd: _cmd, cmdTruncated: _cmdTruncated, description: _description, cwd: _cwd, ...rest } = rec
  return rest
}

function slimCommands(records: unknown): CommandStateRecord[] {
  const commands: CommandStateRecord[] = []
  if (!Array.isArray(records)) return commands
  for (const rec of records) {
    if (rec === null || typeof rec !== 'object') continue
    commands.push(slimCommandRecord(rec as CommandStateRecord))
  }
  return commands
}

function slimPendingCommands(pending: unknown): TimelineState['pendingCodeCmds'] {
  if (pending === null || typeof pending !== 'object') return undefined
  const slimmed: Record<string, CommandStateRecord[]> = {}
  let count = 0
  for (const [root, records] of Object.entries(pending as Record<string, unknown>)) {
    const slim = slimCommands(records)
    if (slim.length > 0) {
      slimmed[root] = slim
      count += slim.length
    }
  }
  return count > 0 ? slimmed : undefined
}

export interface TimelineEvent {
  type: string
  seq: number
  time: number
  data?: Record<string, unknown>
  surfaceOp?: unknown
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
  requests: SlimRequestRecord[]
  turnRuns?: number
  totals?: CumulativeTotals
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
  callNames: Record<string, { name: string; start: number; argsRaw?: string; transport?: true }>
  pendingShadowedSeqs?: number[]
  pendingShadowEventSeq?: number
  fileOps: FileOpRecord[]
  fileOpsFloor?: number
  commands: CommandStateRecord[]
  commandsFloor?: number
  commandStats?: CommandStats
  toolTally?: Record<string, number>
  programTally?: Record<string, number>
  commandCalls?: string[]
  commandCallsOverflow?: boolean
  pendingCodeCmds?: Record<string, CommandStateRecord[]>
  pendingCodeOps?: Record<string, FileOpRecord[]>
  pendingCodeStarts?: Record<string, number>
}

export function archiveWindowOf(
  state: TimelineState,
  tail: number,
): { archive: SurfaceNode[]; archiveFloor?: number } {
  let drop = 0
  const oldestReq = state.requests.length > 0 ? state.requests[0].seq : undefined
  if (oldestReq !== undefined) {
    while (drop < state.archived.length
      && (state.archived[drop].gone ?? Infinity) <= oldestReq) drop++
  }
  if (state.archived.length - drop > tail) drop = state.archived.length - tail
  if (drop === 0) {
    return {
      archive: state.archived,
      ...(state.archiveFloor !== undefined ? { archiveFloor: state.archiveFloor } : {}),
    }
  }
  const stateFloor = state.archiveFloor
  const dropFloor = state.archived[drop - 1].gone
  if (stateFloor === undefined && dropFloor === undefined) {
    return { archive: state.archived.slice(drop) }
  }
  return {
    archive: state.archived.slice(drop),
    archiveFloor: Math.max(stateFloor ?? 0, dropFloor ?? 0),
  }
}

export function surfaceWindowOf(state: TimelineState, tail: number, archiveTail: number): SurfaceNodeWindow {
  const overflowCount = Math.max(0, state.surface.length - tail)
  const overflow = state.surface.slice(0, overflowCount)
  const kept = state.surface.slice(overflowCount)
  const pinned = overflow.filter(node => node.cat === 'inject' || node.cat === 'skill')
  const nodes = pinned.length > 0 ? [...pinned, ...kept] : kept
  const droppedNodes = overflowCount - pinned.length
  const archive = archiveWindowOf(state, archiveTail)
  const window: SurfaceNodeWindow = {
    nodes,
    droppedNodes,
    archive: archive.archive,
  }
  if (droppedNodes > 0) {
    let floor = 0
    for (const node of overflow) {
      if (node.cat !== 'inject' && node.cat !== 'skill') floor = Math.max(floor, node.seq)
    }
    window.surfaceFloor = floor
  }
  if (archive.archiveFloor !== undefined) window.archiveFloor = archive.archiveFloor
  return window
}

export function trimToLastTurns(requests: SlimRequestRecord[], maxTurns: number): SlimRequestRecord[] {
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

export function countTurnRuns(requests: readonly SlimRequestRecord[]): number {
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

export function trimState(st: TimelineState, bounds: FoldBounds): void {
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
  if (bounds.headOnly === true) {
    trimHeadState(st)
    return
  }
  if (st.archived.length > 0) {
    let drop = 0
    const oldestReq = st.requests.length > 0 ? st.requests[0].seq : undefined
    if (oldestReq !== undefined) {
      while (drop < st.archived.length
        && (st.archived[drop].gone ?? Infinity) <= oldestReq) drop++
    }
    if (drop > 0) {
      const floor = st.archived[drop - 1].gone
      /* v8 ignore next 1 */
      if (floor !== undefined) st.archiveFloor = Math.max(st.archiveFloor ?? 0, floor)
      st.archived = st.archived.slice(drop)
    }
  }
}

const COMMAND_CALLS_MAX = 1024

export function noteCommandCall(st: TimelineState, callId: string): void {
  if (callId === '') return
  const calls = st.commandCalls
  if (calls === undefined) {
    st.commandCalls = [callId]
    return
  }
  if (calls.includes(callId)) return
  calls.push(callId)
  if (calls.length > COMMAND_CALLS_MAX) {
    calls.splice(0, calls.length - COMMAND_CALLS_MAX)
    st.commandCallsOverflow = true
  }
}

export function trimHeadState(st: TimelineState): void {
  if (st.requests.length > 2) st.requests = st.requests.slice(-2)
  if (st.events.length > 0) st.events = []
  if (st.commands.length > 0) st.commands = st.commands.filter(rec => rec.status === 'running').slice(-16)
  if (st.fileOps.length > 0) st.fileOps = []
  if (st.spans.length > 0) st.spans = []
  if (st.archived.length > 0) st.archived = []
}

export const TIMING_SPANS_MAX = 2_000

export const SKILL_NAMES_MAX = 500

export const TALLY_NAMES_MAX = 128

export const TALLY_NAME_CHARS_MAX = 120

export interface CumulativeTotals {
  turns: number
  steps: number
  injects: number
  compactions: number
  prunes: number
  skills: Record<string, true>
  lastTurn?: number
}

function emptyTotals(): CumulativeTotals {
  return { turns: 0, steps: 0, injects: 0, compactions: 0, prunes: 0, skills: {} }
}

function ownedTotals(st: TimelineState): CumulativeTotals {
  return st.totals === undefined ? emptyTotals() : { ...st.totals }
}

export function countStep(st: TimelineState): void {
  const totals = ownedTotals(st)
  totals.steps += 1
  st.totals = totals
}

export function countInject(st: TimelineState): void {
  const totals = ownedTotals(st)
  totals.injects += 1
  st.totals = totals
}

export function countCompaction(st: TimelineState, kind: 'compaction' | 'prune'): void {
  const totals = ownedTotals(st)
  if (kind === 'compaction') totals.compactions += 1
  else totals.prunes += 1
  st.totals = totals
}

export function noteTurn(st: TimelineState, turn: number | undefined): void {
  const label = turn !== undefined && Number.isFinite(turn) ? turn : 0
  if (st.totals?.lastTurn === label) return
  const totals = ownedTotals(st)
  totals.turns += 1
  totals.lastTurn = label
  st.totals = totals
}

export function noteSkillName(st: TimelineState, name: string): void {
  if (name === '' || name === '__proto__') return
  const current = st.totals
  if (current !== undefined && Object.hasOwn(current.skills, name)) return
  if (current !== undefined && Object.keys(current.skills).length >= SKILL_NAMES_MAX) return
  const totals = ownedTotals(st)
  totals.skills = { ...totals.skills, [name]: true }
  st.totals = totals
}

export function createTimelineState(): TimelineState {
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
    totals: emptyTotals(),
    events: [],
    archived: [],
    callNames: {},
    fileOps: [],
    commands: [],
    spans: [],
  }
}
