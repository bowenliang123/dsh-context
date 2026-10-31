import type { Category, ContextEventRecord, FileOpRecord, RequestRecord, SurfaceNode, SystemPromptNode, TimingSpan } from '../shared/types'
import { estimateSystemContent } from '../shared/estimate'
import type { FoldBounds } from './config'
import {
  estimateAnswerTokens,
  estimateCallTokens,
  estimateMessage,
  estimateReasoningTokens,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from './pricing'
import type { ContentBlock, MessageSource } from './pricing'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { firstTokenTimeOfStream, replaceRangeOf, streamTimingOf } from './logShapes'
import { opBearingTool, opsOfCall, parseCallArgs, rawArgsNeeded } from '../shared/fileOps'
import { commandArgsOf, commandTool, markersOfText, outcomeOfMarkers } from '../shared/commands'
import {
  bumpBg,
  commandRecordOf,
  findCommandIndex,
  jobCallIdOf,
  jobOutcomePatch,
  patchBufferedCommand,
  resultPatchOf,
  resultTextsOf,
  setCommand,
  tallyRun,
} from './foldCommands'
import { cloneHead, compactSurfaceNodeInPlace, countTurnRuns, HEAD_KIND_COMPACTION, HEAD_KIND_INJECT, HEAD_KIND_NONE, HEAD_KIND_PRUNE, noteEvent, noteRequest, noteSurface, trimState } from './foldState'
import type { CommandStateRecord, TimelineEvent, TimelineState } from './foldState'
import { accumulateCost, addDecode, bumpToolTotals, carveWindows, DECODE_KINDS, durOf, ensureTiming, idleGapWindows, mergeWindows, tokenCountOf } from './foldMetering'
import type { UsageLike } from './foldMetering'

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

const SYSTEM_NODES_MAX = 8

function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    if (systems[i].tokens > 0) return systems[i].tokens
  }
  return 0
}

function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

const PENDING_CODE_OPS_MAX = 200

const PENDING_CODE_CMDS_MAX = 200

function argsRawOf(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === undefined || value === null) return undefined
  try {
    return JSON.stringify(value)
  } catch {
    return undefined
  }
}

function pushFileOps(st: TimelineState, ops: FileOpRecord[]): void {
  for (const op of ops) st.fileOps.push(op)
}

function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  if (st.compact === true) return
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

function applyLiveSubsets(st: TimelineState, node: SurfaceNode, sign: 1 | -1): void {
  if (node.reasoning !== undefined) st.assistantReasoning += sign * node.reasoning
  if (node.answerTokens !== undefined) st.assistantAnswerTokens += sign * node.answerTokens
  if (node.callTokens !== undefined) st.assistantCallTokens += sign * node.callTokens
}

function removeSurfaceSeqs(st: TimelineState, claimed: ReadonlySet<number>, goneSeq: number): SurfaceNode[] {
  if (claimed.size === 0) return []
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      st.sums[n.cat] -= n.tokens
      applyLiveSubsets(st, n, -1)
      noteSurface(st.head, n, -1)
      removed.push(n)
    } else {
      kept.push(n)
    }
  }
  archiveRemoved(st, removed, goneSeq)
  st.surface = kept
  return removed
}

type SurfaceEventLike = Pick<TimelineEvent, 'seq' | 'time' | 'surfaceOp'>

interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  isError?: unknown
}

function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

function firstFullText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

export function skillNameOf(msg: unknown): string {
  const content = msg !== null && typeof msg === 'object' ? (msg as MessageLike).content : undefined
  const text = firstFullText(content)
  const match = text.match(/<skill_content\s+name="([^"]+)"/)
  return match === null ? '' : match[1]
}

function applySurface(
  st: TimelineState,
  ev: SurfaceEventLike,
  type: string,
  message: MessageLike | null | undefined,
): SurfaceNode {
  st.head = cloneHead(st.head)
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    tokens: estimateMessage(message, type === 'assistant/message' || type === 'developer/message'),
  }
  if (cat === 'assistant') {
    const reasoning = estimateReasoningTokens(message?.content)
    if (reasoning > 0) node.reasoning = reasoning
    const answers = estimateAnswerTokens(message?.content)
    if (answers > 0) node.answerTokens = answers
    const calls = estimateCallTokens(message?.content)
    if (calls > 0) node.callTokens = calls
  }
  const imgs = imageCountOf(message?.content)
  if (imgs > 0) node.imgs = imgs
  const source = message?.source
  const form = source?.form
  if (typeof form === 'string') node.form = form
  if (type === 'assistant/message') {
    const text = firstText(message?.content)
    if (text !== '') node.text = text
    else {
      const names = toolCallNames(message?.content)
      if (names.length > 0) node.calls = names.slice(0, 3)
    }
  } else if (type === 'tool/result') {
    const srcId = (source as { callId?: unknown } | undefined)?.callId
    const toolEntry = typeof srcId === 'string' && Object.hasOwn(st.callNames, srcId) ? st.callNames[srcId] : undefined
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      const timing = ensureTiming(st)
      const dur = durOf(toolEntry.start, ev.time)
      timing.toolsMs += dur
      timing.toolCalls += 1
      bumpToolTotals(timing, toolEntry.name, dur)
      if (st.stepStart !== undefined) {
        st.stepSpans = [...(st.stepSpans ?? []), { kind: 'tools', start: toolEntry.start, end: ev.time }]
      }
    }
    if (typeof srcId === 'string') {
      const kept: Record<string, { name: string; start: number }> = {}
      for (const k in st.callNames) {
        if (k !== srcId) kept[k] = st.callNames[k]
      }
      st.callNames = kept
    }
    if (message?.isError === true) node.err = true
  } else if (source?.kind === 'skill-invocation') {
    node.skill = typeof source.name === 'string' ? source.name : '?'
  } else if (source?.kind === 'plugin') {
    if (source.form === 'notice' && typeof source.summary === 'string') node.text = source.summary
    else if (source.form === 'snapshot' && Array.isArray(source.sections)) {
      node.text = source.sections.map(s => s?.name).filter(Boolean).join(', ').slice(0, 80)
    } else {
      const ptext = firstText(message?.content)
      if (ptext !== '') node.text = ptext
    }
  } else {
    const utext = firstText(message?.content)
    if (utext !== '') node.text = utext
  }

  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq)
      st.sums[cat] += node.tokens
      applyLiveSubsets(st, node, 1)
      noteSurface(st.head, node, 1)
      st.surface.push(node)
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) st.events[i] = { ...st.events[i], tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      archiveRemoved(st, removed, ev.seq)
      for (const r of removed) {
        st.sums[r.cat] -= r.tokens
        applyLiveSubsets(st, r, -1)
        noteSurface(st.head, r, -1)
      }
      st.sums[cat] += node.tokens
      applyLiveSubsets(st, node, 1)
      noteSurface(st.head, node, 1)
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  applyLiveSubsets(st, node, 1)
  noteSurface(st.head, node, 1)
  return node
}

const ASK_USER_TOOL = 'ask_user_question'

type CloneKey = 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing' | 'commands'

const CLONE_ALL: readonly CloneKey[] = ['surface', 'sums', 'requests', 'events', 'archived', 'callNames', 'fileOps', 'timing', 'commands']

const STEP_BEATS_MAX = 1024

export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  if (state.stepStart === undefined || state.stepBeatsFull === true
    || !Number.isFinite(event.time) || event.time < 0) {
    return applyTimelineEvent(state, event, bounds)
  }
  const beats = state.stepBeats
  const next = beats !== undefined && beats.length >= STEP_BEATS_MAX
    ? { ...state, stepBeats: [], stepBeatsFull: true }
    : { ...state, stepBeats: [...(beats ?? []), event.time] }
  const applied = applyTimelineEvent(next, event, bounds)
  return applied === next ? state : applied
}

function applyTimelineEvent(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  const detail = state.compact !== true
  const headOf = (next: TimelineState): TimelineState['head'] => {
    if (next.head === state.head) next.head = cloneHead(state.head)
    return next.head
  }
  const ensure = (keys: readonly CloneKey[] = CLONE_ALL): TimelineState => {
    st = { ...state }
    for (const key of keys) {
      if (!detail && (key === 'events' || key === 'archived' || key === 'fileOps' || key === 'commands')) continue
      if (key === 'surface') st.surface = [...state.surface]
      else if (key === 'sums') st.sums = { ...state.sums }
      else if (key === 'requests') st.requests = [...state.requests]
      else if (key === 'events') st.events = [...state.events]
      else if (key === 'archived') st.archived = [...state.archived]
      else if (key === 'callNames') st.callNames = { ...state.callNames }
      else if (key === 'fileOps') st.fileOps = [...state.fileOps]
      else if (key === 'commands') st.commands = [...state.commands]
      else if (state.timing !== undefined) st.timing = { ...state.timing, tools: { ...state.timing.tools } }
    }
    return st
  }

  const data = event.data
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown; reasoningEffort?: unknown; maxTokens?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure(['events'])
        s.toolsTokens = estimateToolsTotal(tools)
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        if (header.config && typeof header.config.reasoningEffort === 'string' && header.config.reasoningEffort !== '') {
          s.reasoningEffort = header.config.reasoningEffort
        } else {
          delete s.reasoningEffort
        }
        const maxOutputTokens = header.config?.maxTokens
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
          s.maxOutputTokens = maxOutputTokens
        } else {
          delete s.maxOutputTokens
        }
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          if (detail) s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          const head = headOf(s)
          noteEvent(head, HEAD_KIND_NONE, '', bounds.maxEvents)
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        const s = ensure(['surface', 'sums', 'archived'])
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (claimed.size > 0) s.head = cloneHead(s.head)
          if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s)
        }
        pushSystem(s, { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) })
        break
      }
      case 'request/context': {
        const s = ensure([])
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const cmdTool = commandTool(data.name)
          const parsed = cmdTool === null ? null : commandArgsOf(cmdTool, data.arguments, bounds.maxCommandChars)
          const s = ensure(cmdTool === null ? ['callNames'] : ['callNames', 'commands'])
          const argsRaw = detail && rawArgsNeeded(data.name) ? argsRawOf(data.arguments) : undefined
          if (data.callId !== '__proto__') {
            s.callNames[data.callId] = {
              name: data.name,
              start: event.time,
              ...(argsRaw !== undefined ? { argsRaw } : {}),
            }
          }
          if (cmdTool !== null && parsed !== null) {
            if (detail) {
              s.commands.push(commandRecordOf({
                seq: event.seq,
                time: event.time,
                tool: cmdTool,
                parsed,
                turn: data.turn,
                step: data.step,
                call: data.callId,
              }))
              if (parsed.background === true) bumpBg(s)
            }
            bumpDetailRev(s)
          }
        }
        break
      }
      case 'job/registered': {
        if (!detail) {
          const callId = jobCallIdOf(data)
          const startedAt = data?.startedAt
          if (callId === undefined || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return state
          const s = ensure([])
          bumpDetailRev(s)
          break
        }
        const callId = jobCallIdOf(data)
        const startedAt = data?.startedAt
        if (callId === undefined || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return state
        const index = findCommandIndex(state.commands, callId)
        const s = ensure(index >= 0 ? ['commands'] : [])
        bumpDetailRev(s)
        if (index >= 0) {
          s.commands[index] = { ...s.commands[index], start: startedAt }
          break
        }
        if (state.pendingCodeCmds === undefined) break
        patchBufferedCommand(s, state.pendingCodeCmds, callId, rec => ({ ...rec, start: startedAt }))
        break
      }
      case 'job/settled': {
        if (!detail) {
          const callId = jobCallIdOf(data)
          const finishedAt = data?.finishedAt
          const status = data?.status
          if (callId === undefined || typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return state
          if (status !== 'completed' && status !== 'killed' && status !== 'failed') return state
          const s = ensure([])
          bumpDetailRev(s)
          break
        }
        const callId = jobCallIdOf(data)
        const finishedAt = data?.finishedAt
        const status = data?.status
        if (callId === undefined || typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return state
        if (status !== 'completed' && status !== 'killed' && status !== 'failed') return state
        const index = findCommandIndex(state.commands, callId)
        const s = ensure(index >= 0 ? ['commands'] : [])
        bumpDetailRev(s)
        if (index >= 0) {
          setCommand(s, index, jobOutcomePatch(s.commands[index], status, finishedAt, data?.detail))
          break
        }
        const pendingCmds = state.pendingCodeCmds
        if (pendingCmds === undefined) break
        patchBufferedCommand(s, pendingCmds, callId, rec => jobOutcomePatch(rec, status, finishedAt, data?.detail))
        break
      }
      case 'tool/ptc-dispatch-start': {
        if (!detail) return state
        const rootCallId = data?.rootCallId
        const subCallId = data?.subCallId
        const cmdTool = commandTool(typeof data?.name === 'string' ? data.name : undefined)
        if (typeof rootCallId !== 'string' || typeof subCallId !== 'string' || cmdTool === null) return state
        const parsed = commandArgsOf(cmdTool, data?.arguments, bounds.maxCommandChars)
        if (parsed === null) return state
        const pending = state.pendingCodeCmds ?? {}
        let total = 0
        for (const k in pending) total += pending[k].length
        if (total + 1 > PENDING_CODE_CMDS_MAX) return state
        const rec: CommandStateRecord = commandRecordOf({
          seq: event.seq,
          time: event.time,
          tool: cmdTool,
          parsed,
          codeMode: true,
          call: subCallId,
        })
        const s = ensure([])
        if (parsed.background === true) bumpBg(s)
        s.pendingCodeCmds = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), rec] }
        break
      }
      case 'tool/ptc-dispatch': {
        if (!detail) return state
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId === 'string' && typeof name === 'string') {
          const subCallId = data?.subCallId
          const bufferedCmds = typeof subCallId === 'string' ? state.pendingCodeCmds?.[rootCallId] : undefined
          const cmdIndex = bufferedCmds?.findIndex(r => r.call === subCallId) ?? -1
          const argsRaw = opBearingTool(name) ? argsRawOf(data?.arguments) : undefined
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: name,
            argsRaw,
            err: data?.isError === true,
          })
          if (ops.length > 0 || (bufferedCmds !== undefined && cmdIndex >= 0)) {
            const s = ensure([])
            if (ops.length > 0) bufferCodeOps(s, rootCallId, ops)
            if (bufferedCmds !== undefined && cmdIndex >= 0) {
              const prev = bufferedCmds[cmdIndex]
              const texts = resultTextsOf(data?.content)
              const markers = markersOfText(texts.at(-1) ?? '')
              const isError = data?.isError === true
              const next: CommandStateRecord = {
                ...prev,
                ...resultPatchOf(texts, markers),
                err: isError,
              }
              if (markers.backgroundAck === true) {
                next.background = true
                if (prev.background !== true) bumpBg(s)
              } else {
                const outcome = outcomeOfMarkers(markers, isError)
                next.status = outcome.status
                if (outcome.exit !== undefined) next.exit = outcome.exit
                if (outcome.exitInferred === true) next.exitInferred = true
                next.end = event.time
                next.derived = true
              }
              const list = [...bufferedCmds]
              list[cmdIndex] = next
              s.pendingCodeCmds = { ...state.pendingCodeCmds, [rootCallId]: list }
            }
          }
        }
        break
      }
      case 'assistant/attempt': {
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure([])
        s.stepStart = { time: start.time, firstToken: first }
        break
      }
      case 'step/start': {
        const s = ensure([])
        s.stepStart = { time: event.time }
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        delete s.stepBeats
        delete s.stepBeatsFull
        break
      }
      case 'step/end': {
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure(state.stepRequestSeq !== undefined ? ['timing', 'requests'] : ['timing'])
        const timing = ensureTiming(s)
        timing.wallMs += durOf(start.time, event.time)
        const waits: { start: number; end: number }[] = [...(state.stepWaits ?? [])]
        for (const id in state.stepApprovals) waits.push({ start: state.stepApprovals[id], end: event.time })
        waits.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        let waitMs = 0
        let waitCursor = start.time
        for (const wait of waits) {
          const from = Math.max(waitCursor, wait.start)
          const to = Math.min(wait.end, event.time)
          if (to > from) { waitMs += to - from; waitCursor = to }
        }
        const activeMs = durOf(start.time, event.time) - waitMs
        const last = state.requests.at(-1)
        const responseTime = last !== undefined && last.seq === state.stepRequestSeq ? last.time : undefined
        if (responseTime !== undefined && last !== undefined) {
          s.requests[s.requests.length - 1] = { ...last, activeMs }
        }
        const painted: TimingSpan[] = []
        for (const span of state.stepSpans ?? []) {
          const from = Math.max(start.time, span.start)
          const to = Math.min(event.time, span.end)
          if (to > from) painted.push({ kind: span.kind, start: from, end: to })
        }
        painted.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const zoneStart = responseTime ?? start.time
        const gapIdle = state.stepBeatsFull === true ? [] : idleGapWindows(state.stepBeats ?? [], start.time, event.time, zoneStart)
        const waitIdle = mergeWindows(waits.map(w => ({ start: Math.max(w.start, zoneStart), end: Math.min(w.end, event.time) })))
        const residueIdle = mergeWindows([...gapIdle, ...waitIdle])
        const flushed: TimingSpan[] = []
        let cursor = start.time
        let idleMs = 0
        for (const span of painted) {
          const from = Math.max(cursor, span.start)
          if (span.end <= from) continue
          idleMs += carveWindows(flushed, 'other', cursor, from, residueIdle)
          idleMs += carveWindows(flushed, span.kind, from, span.end, waitIdle)
          cursor = span.end
        }
        idleMs += carveWindows(flushed, 'other', cursor, event.time, residueIdle)
        if (detail) s.spans = [...state.spans, ...flushed]
        let toolBusyMs = 0
        for (const span of flushed) {
          if (span.kind === 'tools') toolBusyMs += span.end - span.start
        }
        if (timing.toolBusyMs !== undefined) timing.toolBusyMs += toolBusyMs
        if (idleMs > 0) timing.idleMs = (timing.idleMs ?? 0) + idleMs
        delete s.stepStart
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        delete s.stepBeats
        delete s.stepBeatsFull
        bumpDetailRev(s)
        break
      }
      case 'approval/asked': {
        const id = data?.id
        if (state.stepStart === undefined || typeof id !== 'string') return state
        const s = ensure([])
        s.stepApprovals = { ...state.stepApprovals, [id]: event.time }
        break
      }
      case 'approval/decided': {
        const id = data?.id
        const open = state.stepApprovals
        const askedAt = typeof id === 'string' ? open?.[id] : undefined
        if (open === undefined || askedAt === undefined) return state
        const s = ensure([])
        s.stepWaits = [...(state.stepWaits ?? []), { start: askedAt, end: event.time }]
        const kept: Record<string, number> = {}
        for (const k in open) if (k !== id) kept[k] = open[k]
        if (Object.keys(kept).length > 0) s.stepApprovals = kept
        else delete s.stepApprovals
        break
      }
      case 'user/message':
      case 'developer/message': {
        const developer = event.type === 'developer/message'
        const msg = developer ? messageOf(data) : deriveEventMessage(event as never) as MessageLike | null
        if (developer && (msg === null || !Array.isArray(msg.content))) return state
        const s = ensure(['surface', 'sums', 'archived', 'events'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, msg)
        const source = msg?.source
        if (developer || isInjection(source)) {
          const rec: ContextEventRecord = {
            seq: event.seq,
            time: event.time,
            kind: 'inject',
            form: typeof source?.form === 'string' && source.form !== '' ? source.form : 'context',
            tokens: node.tokens,
          }
          if (source?.kind === 'skill-invocation') {
            rec.sub = 'skill'
            rec.name = typeof source.name === 'string' ? source.name : '?'
          } else {
            const label = injectionSourceName(source)
            if (label !== '') {
              rec.name = label
              node.name = label
            }
            if (source?.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          if (detail) s.events.push(rec)
          const head = headOf(s)
          const skill = rec.sub === 'skill' && typeof rec.name === 'string' && rec.name !== '' ? rec.name : ''
          noteEvent(head, HEAD_KIND_INJECT, skill, bounds.maxEvents)
        } else {
          s.humanInputs = (s.humanInputs ?? 0) + 1
          if (node.text !== undefined && node.text !== '') s.lastUser = node.text
        }
        if (!detail) compactSurfaceNodeInPlace(node)
        break
      }
      case 'tool/result': {
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const pendingEntry = typeof srcId === 'string' && Object.hasOwn(state.callNames, srcId) ? state.callNames[srcId] : undefined
        const buffered = detail && typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined
        const bufferedCmds = detail && typeof srcId === 'string' ? state.pendingCodeCmds?.[srcId] : undefined
        const commandCall = detail && pendingEntry !== undefined && commandTool(pendingEntry.name) !== null
        const s = ensure(['surface', 'sums', 'archived', 'events', 'fileOps', 'timing',
          ...((bufferedCmds?.length ?? 0) > 0 || commandCall ? ['commands' as const] : [])])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, toolMsg)
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        if (pendingEntry !== undefined && pendingEntry.name === ASK_USER_TOOL && state.stepStart !== undefined) {
          s.stepWaits = [...(state.stepWaits ?? []), { start: pendingEntry.start, end: event.time }]
        }
        if (detail && pendingEntry !== undefined) {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: pendingEntry.name,
            argsRaw: pendingEntry.argsRaw,
            meta: data?.meta,
            err: toolMsg?.isError === true,
          })
          pushFileOps(s, ops)
          if (typeof srcId === 'string' && commandTool(pendingEntry.name) !== null) {
            const index = findCommandIndex(s.commands, srcId)
            if (index >= 0) {
              const prev = s.commands[index]
              const texts = resultTextsOf(toolMsg?.content)
              const markers = markersOfText(texts.at(-1) ?? '')
              const isError = toolMsg?.isError === true
              const next: CommandStateRecord = {
                ...prev,
                ...resultPatchOf(texts, markers),
                resultSeq: event.seq,
                err: isError,
              }
              if (markers.exit !== undefined) delete next.exitInferred
              const metaCwd = (data?.meta as { cwd?: unknown } | null | undefined)?.cwd
              if (typeof metaCwd === 'string' && metaCwd !== '') next.cwd = metaCwd
              if (markers.backgroundAck === true) {
                next.background = true
                if (prev.background !== true) bumpBg(s)
              } else if (prev.status === 'running') {
                const outcome = outcomeOfMarkers(markers, isError)
                next.status = outcome.status
                if (prev.tool !== 'run_code') {
                  if (outcome.exit !== undefined) next.exit = outcome.exit
                  if (outcome.exitInferred === true) next.exitInferred = true
                }
                next.end = event.time
                next.derived = true
              }
              setCommand(s, index, next)
            }
          }
        }
        if (detail && buffered !== undefined && buffered.length > 0) {
          const program = parseCallArgs(pendingEntry?.argsRaw)?.description
          pushFileOps(s, buffered.map(op => ({
            ...op,
            parent: event.seq,
            ...(typeof program === 'string' && program !== '' ? { program } : {}),
          })))
          const kept: Record<string, FileOpRecord[]> = {}
          for (const k in s.pendingCodeOps) {
            if (k !== srcId) kept[k] = s.pendingCodeOps[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeOps = kept
          else delete s.pendingCodeOps
        }
        if (detail && bufferedCmds !== undefined && bufferedCmds.length > 0) {
          for (const rec of bufferedCmds) {
            const next: CommandStateRecord = { ...rec, parent: event.seq }
            s.commands.push(next)
            if (next.status !== 'running') tallyRun(s, next)
          }
          const kept: Record<string, CommandStateRecord[]> = {}
          for (const k in s.pendingCodeCmds) {
            if (k !== srcId) kept[k] = s.pendingCodeCmds[k]
          }
          if (Object.keys(kept).length > 0) s.pendingCodeCmds = kept
          else delete s.pendingCodeCmds
        }
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            if (node.tool === undefined) node.tool = 'skill'
            s.sums.tool -= node.tokens
            node.cat = 'skill'
            s.sums.skill += node.tokens
            if (detail) s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
            const head = headOf(s)
            noteEvent(head, HEAD_KIND_INJECT, name, bounds.maxEvents)
          }
        }
        if (!detail) compactSurfaceNodeInPlace(node)
        break
      }
      case 'assistant/message': {
        const usage = data?.usage as UsageLike | null | undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'requests', 'timing'])
        bumpDetailRev(s)
        const total = s.systemTokens + s.toolsTokens + s.sums.user + s.sums.inject + s.sums.skill + s.sums.assistant + s.sums.tool
        const record: RequestRecord = {
          time: event.time,
          seq: event.seq,
          system: s.systemTokens,
          tools: s.toolsTokens,
          user: s.sums.user,
          inject: s.sums.inject,
          skill: s.sums.skill,
          assistant: s.sums.assistant,
          tool: s.sums.tool,
          total,
        }
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        if (state.stepStart !== undefined) s.stepRequestSeq = record.seq
        let output: number | null = null
        if (usage !== null && typeof usage === 'object') {
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          output = tokenCountOf(usage.outputTokens)
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            if (cacheRead !== null) record.cacheRead = cacheRead
            if (output !== null) record.output = output
            accumulateCost(s, event.time, {
              uncached: input ?? 0,
              cacheRead: cacheRead ?? 0,
              cacheWrite: cacheWrite ?? 0,
              output: output ?? 0,
            })
          }
        }
        const prevLast = state.requests.at(-1)
        if (detail) s.requests.push(record)
        else s.requests = [record]
        if (detail) {
          s.turnRuns = (state.turnRuns ?? countTurnRuns(state.requests))
            + (prevLast === undefined
              ? (record.turn !== undefined ? 1 : 0)
              : (record.turn === prevLast.turn ? 0 : 1))
        }
        const head = headOf(s)
        noteRequest(head, record, prevLast, bounds)
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const streamTiming = streamTimingOf(data?.stream, event.time)
          const firstToken = stepStart.firstToken ?? streamTiming.firstToken
          if (firstToken !== undefined) {
            const decodeBlocks = streamTiming.spans
            let decodeStart = firstToken
            for (const block of decodeBlocks) decodeStart = Math.min(decodeStart, block.start)
            timing.ttftMs += durOf(stepStart.time, decodeStart)
            timing.genMs += durOf(decodeStart, event.time)
            const modelSpans: TimingSpan[] = [{ kind: 'ttft', start: stepStart.time, end: decodeStart }]
            for (const block of decodeBlocks) {
              const to = Math.min(event.time, block.end)
              if (to <= block.start) continue
              modelSpans.push({ kind: block.kind, start: modelSpans.length === 1 ? decodeStart : block.start, end: to })
            }
            s.stepSpans = [...(s.stepSpans ?? []), ...modelSpans]
            if (output !== null) {
              timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time)
              timing.speedTokens = (timing.speedTokens ?? 0) + output
            }
            const tally = streamTiming.tally
            for (const kind of DECODE_KINDS) addDecode(timing, kind, tally.spans[kind], tally.blocks[kind])
          }
        }
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        const asstNode = applySurface(s, event, event.type, asstMsg)
        if (asstNode.text !== undefined) s.answers = (s.answers ?? 0) + 1
        const providerReasoning = usage !== null && typeof usage === 'object' ? tokenCountOf(usage.reasoningTokens) : null
        const generated = providerReasoning === null
          ? (asstNode.reasoning ?? 0)
          : output === null ? providerReasoning : Math.min(providerReasoning, output)
        if (generated > 0) s.generatedReasoning = (s.generatedReasoning ?? 0) + generated
        const generatedAnswers = asstNode.answerTokens ?? 0
        if (generatedAnswers > 0) s.generatedAnswerTokens = (s.generatedAnswerTokens ?? 0) + generatedAnswers
        const generatedCalls = asstNode.callTokens ?? 0
        if (generatedCalls > 0) s.generatedCallTokens = (s.generatedCallTokens ?? 0) + generatedCalls
        if (!detail) compactSurfaceNodeInPlace(asstNode)
        break
      }
      case 'session/end-seed': {
        if (data?.inherited !== true) break
        const s = ensure([])
        s.cost = {}
        delete s.generatedReasoning
        delete s.generatedAnswerTokens
        delete s.generatedCallTokens
        break
      }
      case 'plan/mode': {
        if (data && typeof data.active === 'boolean') {
          const s = ensure(['events'])
          if (detail) s.events.push({ seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' })
          const head = headOf(s)
          noteEvent(head, HEAD_KIND_NONE, '', bounds.maxEvents)
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure(['events'])
        bumpDetailRev(s)
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        if (detail) {
          s.events.push({
            seq: event.seq,
            time: event.time,
            kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
            tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
            ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
              ? { count: data.shadowedSeqs.length }
              : {}),
          })
        }
        const head = headOf(s)
        noteEvent(head, event.type === 'compaction/summary' ? HEAD_KIND_COMPACTION : HEAD_KIND_PRUNE, '', bounds.maxEvents)
        break
      }
      default:
        return state
    }
  } catch {
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

export { createTimelineState, trimToLastTurns } from './foldState'
export type { TimelineEvent, TimelineState } from './foldState'
export { addBilledUsage, isBeijingPeak, tokenCountOf } from './foldMetering'
export type { BilledUsage, UsageLike } from './foldMetering'
export { buildTimelineDetail, buildTimelineHead } from './foldWire'
