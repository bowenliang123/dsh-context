/** `applyTimeline` MUST return the same reference when the event does not change state — `Object.is` gates the change
 * feed. State must stay plain JSON (cached-checkpoint precondition) and bounded. */

import type { Category, ContextEventRecord, FileOpRecord, RequestRecord, SurfaceNode, SystemPromptNode, TimingSpan } from '../shared/types'
import { estimateSystemContent } from '../shared/estimate'
import type { FoldBounds } from './config'
import {
  estimateMessage,
  estimateToolsTotal,
  firstText,
  imageCountOf,
  injectionSourceName,
  isInjection,
  toolCallNames,
} from './pricing'
import type { ContentBlock, MessageSource } from './pricing'
import { deriveEventMessage } from '@deepseek-ai/dsh-session'
import { decodeSpansOfStream, decodeTallyOfStream, firstTokenTimeOfStream, replaceRangeOf } from './logShapes'
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
import { countTurnRuns, trimState } from './foldState'
import type { CommandStateRecord, TimelineEvent, TimelineState } from './foldState'
import { accumulateCost, addDecode, bumpToolTotals, DECODE_KINDS, durOf, ensureTiming, tokenCountOf } from './foldMetering'
import type { UsageLike } from './foldMetering'

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  // Skill machinery is its own bucket: both source kinds are durable user/message injections the plain check absorbs.
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/** Bump only when the SERVED detail changes; working-slot and envelope-scalar branches must NOT bump. */
function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

/** Cap: only the LAST nonempty node prices, so trimming the oldest can only under-report a log whose newest nodes are empty. */
const SYSTEM_NODES_MAX = 8

/** The effective figure is the LAST nonempty node (the harness's own rule); else 0. */
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

/** A hostile log that dispatches without settling the parent run_code cannot grow the persisted state past this. */
const PENDING_CODE_OPS_MAX = 200

/** The command-record sibling of PENDING_CODE_OPS_MAX (nested dispatches buffered per unsettled run_code root). */
const PENDING_CODE_CMDS_MAX = 200

/** JSON-stringify an unknown payload; a hostile (cyclic) value yields no args. */
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

/** A full buffer drops new arrivals wholesale (defensive logs only). */
function bufferCodeOps(st: TimelineState, rootCallId: string, ops: FileOpRecord[]): void {
  const pending = st.pendingCodeOps ?? {}
  let total = 0
  for (const k in pending) total += pending[k].length
  if (total + ops.length > PENDING_CODE_OPS_MAX) return
  st.pendingCodeOps = { ...pending, [rootCallId]: [...(pending[rootCallId] ?? []), ...ops] }
}

/** Stamped COPIES: the sources are shared with the persisted previous state, so `gone` must never be written onto them. */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

/** Removal follows the SEQ list, not the declared range: pruned replacement nodes keep seqs beyond the range end. */
function removeSurfaceSeqs(st: TimelineState, claimed: ReadonlySet<number>, goneSeq: number): SurfaceNode[] {
  if (claimed.size === 0) return []
  const kept: SurfaceNode[] = []
  const removed: SurfaceNode[] = []
  for (const n of st.surface) {
    if (claimed.has(n.seq)) {
      st.sums[n.cat] -= n.tokens
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

/** A structural read stays total; unlike `deriveEventMessage`, an empty message keeps its surface position. */
function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

/** Unlike `firstText`, this must NOT truncate or normalize: the skill name is matched off the raw wrapper. */
function firstFullText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

/** The name is recovered from the rendered `<skill_content name="…">` wrapper, never trusted from the call envelope. */
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
  const cat = categoryOf(type, message ?? undefined)
  const node: SurfaceNode = {
    seq: ev.seq,
    time: ev.time,
    cat,
    tokens: estimateMessage(message, type === 'assistant/message' || type === 'developer/message'),
  }
  // Image blocks ride the NODE (absent when zero): the stats board sums the live surface, not the archive.
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
      // Painted only while a step is open to own the window (a cross-step result still prices the totals above).
      if (st.stepStart !== undefined) {
        st.stepSpans = [...(st.stepSpans ?? []), { kind: 'tools', start: toolEntry.start, end: ev.time }]
      }
    }
    // Rebuild without the used id (no dynamic delete, per repo lint).
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

  // Consume the armed shadow claim here; a later surface event would expire it. DELETE the fields: assigning
  // `undefined` breaks the plain-JSON precondition.
  const shadowedSeqs = st.pendingShadowedSeqs
  const shadowEventSeq = st.pendingShadowEventSeq
  delete st.pendingShadowedSeqs
  delete st.pendingShadowEventSeq

  const op = replaceRangeOf(ev.surfaceOp)
  if (op !== null) {
    if (Array.isArray(shadowedSeqs) && shadowedSeqs.length > 0) {
      const removed = removeSurfaceSeqs(st, new Set(shadowedSeqs), ev.seq)
      st.sums[cat] += node.tokens
      st.surface.push(node)
      // Rewrite the metering row to the NET freed amount, matching the trend chart's drop. Cloned: elements are
      // shared with the persisted state.
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) st.events[i] = { ...st.events[i], tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    // Spliced IN PLACE: the harness gives the replacing node the span's position, and BOTH endpoints must name
    // live nodes as its registry validates. A malformed span degrades to an append, keeping the nodes.
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      archiveRemoved(st, removed, ev.seq)
      for (const r of removed) st.sums[r.cat] -= r.tokens
      st.sums[cat] += node.tokens
      return node
    }
  }
  st.surface.push(node)
  st.sums[cat] += node.tokens
  return node
}

/** Its settled result IS the user's answer, so it folds into the human-input tally. */
const ASK_USER_TOOL = 'ask_user_question'

/** The collections a fold branch may mutate IN PLACE. A branch names exactly its own mutations in `ensure`; unlisted
 * containers are never written in place — every touch REPLACES the property — so they stay shared with persisted state. */
type CloneKey = 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing' | 'commands'

const CLONE_ALL: readonly CloneKey[] = ['surface', 'sums', 'requests', 'events', 'archived', 'callNames', 'fileOps', 'timing', 'commands']

export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  /** The event's private working state. Called EXACTLY ONCE per event. The default is the full clone, so a future
   * branch that omits its list degrades to the old behavior instead of sharing a collection it mutates. */
  const ensure = (keys: readonly CloneKey[] = CLONE_ALL): TimelineState => {
    st = { ...state }
    for (const key of keys) {
      if (key === 'surface') st.surface = [...state.surface]
      else if (key === 'sums') st.sums = { ...state.sums }
      else if (key === 'requests') st.requests = [...state.requests]
      else if (key === 'events') st.events = [...state.events]
      else if (key === 'archived') st.archived = [...state.archived]
      else if (key === 'callNames') st.callNames = { ...state.callNames }
      else if (key === 'fileOps') st.fileOps = [...state.fileOps]
      else if (key === 'commands') st.commands = [...state.commands]
      // Absent `timing` stays absent: an own `undefined`-valued property fails every cache write.
      else if (state.timing !== undefined) st.timing = { ...state.timing, tools: { ...state.timing.tools } }
    }
    return st
  }

  const data = event.data
  // The registry has no error boundary, so a malformed event is DROPPED, never thrown.
  try {
    switch (event.type) {
      case 'request/header': {
        const header = (data?.header ?? {}) as {
          tools?: unknown[]
          config?: { model?: unknown; provider?: unknown; maxTokens?: unknown }
        }
        const tools = Array.isArray(header.tools) ? header.tools : []
        const s = ensure(['events'])
        // Tools TOTAL = dsh's whole-array price (one JSON string of every schema).
        s.toolsTokens = estimateToolsTotal(tools)
        // The durable request envelope, not request/context, is the route/model source of truth.
        if (header.config && typeof header.config.model === 'string') s.model = header.config.model
        if (header.config && typeof header.config.provider === 'string') s.provider = header.config.provider
        // The routed output cap auto-compaction reserves out of the window. Last-wins: a cap-less header clears it.
        const maxOutputTokens = header.config?.maxTokens
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
          s.maxOutputTokens = maxOutputTokens
        } else {
          delete s.maxOutputTokens
        }
        // No dedicated model-switch event: a `'change'`/`'resume'` header whose model differs from the previous one.
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        // The system prompt must stay outside `surface`/`sums`, or it double-counts against `systemTokens`.
        const s = ensure(['surface', 'sums', 'archived'])
        delete s.pendingShadowedSeqs
        delete s.pendingShadowEventSeq
        const op = replaceRangeOf(event.surfaceOp)
        if (op !== null) {
          const systems = s.systems ?? []
          s.systems = systems.filter(n => n.seq < op.start || n.seq > op.end)
          // Defensive: dsh never claims ordinary surface nodes here, but removal keeps surface and sums consistent.
          const claimed = new Set<number>()
          for (const n of s.surface) {
            if (n.seq >= op.start && n.seq <= op.end) claimed.add(n.seq)
          }
          if (removeSurfaceSeqs(s, claimed, event.seq).length > 0) bumpDetailRev(s)
        }
        pushSystem(s, { seq: event.seq, time: event.time, tokens: estimateSystemContent(messageOf(data)?.content) })
        break
      }
      case 'request/context': {
        const s = ensure([])
        // Logged only when the route or capacity changes, so it updates the current route display but fires no event.
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const cmdTool = commandTool(data.name)
          const s = ensure(cmdTool === null ? ['callNames'] : ['callNames', 'commands'])
          // Arguments are kept ONLY where read (an op-bearing tool, or the run_code root the flush reads), keeping a
          // large bash/pwsh call out of the persisted state — the command record below parses its own at the event.
          const argsRaw = rawArgsNeeded(data.name) ? argsRawOf(data.arguments) : undefined
          // `__proto__` assigns the prototype instead of a row: lookups and `for...in` rebuilds would read the entry
          // back as inherited members, breaking the persisted state's strict schema (bumpToolTotals' guarded hazard).
          if (data.callId !== '__proto__') {
            s.callNames[data.callId] = {
              name: data.name,
              start: event.time,
              ...(argsRaw !== undefined ? { argsRaw } : {}),
            }
          }
          if (cmdTool !== null) {
            const parsed = commandArgsOf(cmdTool, data.arguments, bounds.maxCommandChars)
            if (parsed !== null) {
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
              bumpDetailRev(s)
            }
          }
        }
        break
      }
      case 'job/registered': {
        // Precise spawn instant for a running command (job events exist only on the 0.2.1 line; absent elsewhere).
        const callId = jobCallIdOf(data)
        const startedAt = data?.startedAt
        if (callId === undefined || typeof startedAt !== 'number' || !Number.isFinite(startedAt)) return state
        const index = findCommandIndex(state.commands, callId)
        if (index >= 0) {
          const s = ensure(['commands'])
          s.commands[index] = { ...s.commands[index], start: startedAt }
          bumpDetailRev(s)
          break
        }
        // A nested record still buffered behind its run_code root takes the stamp too (unserved: no detail bump).
        if (state.pendingCodeCmds === undefined) return state
        const s = ensure([])
        if (!patchBufferedCommand(s, state.pendingCodeCmds, callId, rec => ({ ...rec, start: startedAt }))) return state
        break
      }
      case 'job/settled': {
        // The terminal job record: precise end + outcome. A nonzero command exit reports as `completed` with the code
        // in the detail (the shell tools never map it to `failed`); `failed` is reserved for infrastructure.
        const callId = jobCallIdOf(data)
        const finishedAt = data?.finishedAt
        const status = data?.status
        if (callId === undefined || typeof finishedAt !== 'number' || !Number.isFinite(finishedAt)) return state
        if (status !== 'completed' && status !== 'killed' && status !== 'failed') return state
        const index = findCommandIndex(state.commands, callId)
        if (index >= 0) {
          const s = ensure(['commands'])
          setCommand(s, index, jobOutcomePatch(s.commands[index], status, finishedAt, data?.detail))
          bumpDetailRev(s)
          break
        }
        // A buffered nested record settles here and tallies at its flush (terminal records tally on entering the log).
        const pendingCmds = state.pendingCodeCmds
        if (pendingCmds === undefined) return state
        const s = ensure([])
        if (!patchBufferedCommand(s, pendingCmds, callId, rec => jobOutcomePatch(rec, status, finishedAt, data?.detail))) return state
        break
      }
      case 'tool/ptc-dispatch-start': {
        // A nested command starts inside a run_code program: buffer it under the root until the root's result folds
        // (the parent seq — the record's locate target — is unknowable before then), same lifecycle as pendingCodeOps.
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
        // A nested PTC dispatch event carries no meta, so its read windows and per-file attribution degrade to the
        // argument-only forms; its ops buffer under the top run_code id and flush at its result.
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
              // The nested settle: outcome off the rendered content's markers, timing off the two dispatch events.
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
              // `bufferedCmds` non-empty implies the map exists; a spread of it needs no fallback branch.
              s.pendingCodeCmds = { ...state.pendingCodeCmds, [rootCallId]: list }
            }
          }
        }
        break
      }
      case 'assistant/attempt': {
      // One model attempt that committed no surface message, but whose embedded stream still carries the attempt's
      // first token — the harness's sessionStats stamps it on the open step the same way, keeping a retry's TTFT.
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
        break
      }
      case 'step/end': {
        // No open slot (unpaired, or the step aged past a refold): the state must stay reference-equal.
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure(state.stepRequestSeq !== undefined ? ['timing', 'requests'] : ['timing'])
        ensureTiming(s).wallMs += durOf(start.time, event.time)
        // ACTIVE time prices the trend chart's duration overlay: the step window minus the clamped union of the
        // step's user waits. The stamp lands on the step's committed request record; a refold that lost the row skips it.
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
        if (last !== undefined && last.seq === state.stepRequestSeq) {
          s.requests[s.requests.length - 1] = { ...last, activeMs }
        }
        // Tile the open step's spans across [step start, step end] — first-wins de-overlap (parallel tool runs paint
        // their UNION, never double wall time) and every hole filled with the residue kind, so it tiles gaplessly.
        const painted: TimingSpan[] = []
        for (const span of state.stepSpans ?? []) {
          const from = Math.max(start.time, span.start)
          const to = Math.min(event.time, span.end)
          if (to > from) painted.push({ kind: span.kind, start: from, end: to })
        }
        painted.sort((a, b) => (a.start - b.start) || (a.end - b.end))
        const flushed: TimingSpan[] = []
        let cursor = start.time
        for (const span of painted) {
          const from = Math.max(cursor, span.start)
          if (span.end <= from) continue
          if (from > cursor) flushed.push({ kind: 'other', start: cursor, end: from })
          flushed.push({ kind: span.kind, start: from, end: span.end })
          cursor = span.end
        }
        if (event.time > cursor) flushed.push({ kind: 'other', start: cursor, end: event.time })
        s.spans = [...state.spans, ...flushed]
        // DELETE the optional fields — assigning `undefined` would break the plain-JSON precondition.
        delete s.stepStart
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
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
            // Re-proved: the harness validates a source's `kind` but not its `form`, so a hostile form must degrade to
            // the default instead of failing the record's strict schemas on every delivery.
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
              // The same identity rides the surface node so browser rows label the injection identically.
              node.name = label
            }
            // A notice's bounded one-line account, shown after the source name as the dsh transcript row does.
            if (source?.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
        } else {
          s.humanInputs = (s.humanInputs ?? 0) + 1
          if (node.text !== undefined && node.text !== '') s.lastUser = node.text
        }
        break
      }
      case 'tool/result': {
        // Pricing the envelope instead of `data.message` would miss all content.
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        // Read before `applySurface` consumes it: pairing into file ops and the Code-Mode flush key both need it.
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const pendingEntry = typeof srcId === 'string' && Object.hasOwn(state.callNames, srcId) ? state.callNames[srcId] : undefined
        const buffered = typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined
        const bufferedCmds = typeof srcId === 'string' ? state.pendingCodeCmds?.[srcId] : undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'fileOps', 'timing', 'commands'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, toolMsg)
        // An answered question prompt is a human input too; an unpaired/foreign result carries no tool name.
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        // The Q&A tool's whole window is the user's answer wait, booked for the `activeMs` subtraction at `step/end`.
        if (pendingEntry !== undefined && pendingEntry.name === ASK_USER_TOOL && state.stepStart !== undefined) {
          s.stepWaits = [...(state.stepWaits ?? []), { start: pendingEntry.start, end: event.time }]
        }
        // Unpaired results book no file ops (parity with the surface node's missing tool label).
        if (pendingEntry !== undefined) {
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: pendingEntry.name,
            argsRaw: pendingEntry.argsRaw,
            meta: data?.meta,
            err: toolMsg?.isError === true,
          })
          pushFileOps(s, ops)
          // The command's own settle: the rendered text's markers give the outcome, the envelope the end instant. A
          // background hand-off ack is no outcome — the run stays open until a job/settled lands (or stays "dispatched"
          // on hosts without job events).
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
              // Only the hand-off ack keeps the run open: a background-flagged call whose result carries no ack (an
              // infrastructure error, a denial) settles through the normal outcome path.
              if (markers.backgroundAck === true) {
                next.background = true
                if (prev.background !== true) bumpBg(s)
              } else if (prev.status === 'running') {
                const outcome = outcomeOfMarkers(markers, isError)
                next.status = outcome.status
                // A code program has no shell exit code; the exit fields stay absent for it.
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
        if (buffered !== undefined && buffered.length > 0) {
          // The run_code root settles: nested ops land with `parent` = this result's row, plus the program description.
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
        if (bufferedCmds !== undefined && bufferedCmds.length > 0) {
          // Nested command records flush on the root's result with `parent` as their locate target; a dispatch that
          // settled inside the buffer tallies on entering the log, a still-running one tallies at its job/settled.
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
        // A skill load's tool result is harness-injected context with its own bucket: its price moves from `tool` to
        // `skill`. The rendered wrapper identifies it even when the tool/call event is trimmed.
        if (node.tool === 'skill' || node.tool === undefined) {
          const name = skillNameOf(toolMsg)
          if (name !== '') {
            node.skill = name
            if (node.tool === undefined) node.tool = 'skill'
            s.sums.tool -= node.tokens
            node.cat = 'skill'
            s.sums.skill += node.tokens
            s.events.push({ seq: event.seq, time: event.time, kind: 'inject', form: 'instructions', sub: 'skill', name, tokens: node.tokens })
          }
        }
        break
      }
      case 'assistant/message': {
      // The record is the request exactly as dispatched, so it is built before this response joins the surface.
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
        // Write only real numbers: an absent `turn`/`step` must not materialize an `undefined` property.
        if (data && typeof data.turn === 'number') record.turn = data.turn
        if (data && typeof data.step === 'number') record.step = data.step
        // `step/end` stamps the step's active time onto this record, the duration overlay's source.
        if (state.stepStart !== undefined) s.stepRequestSeq = record.seq
        // Hoisted for the throughput seat below: `null` means "no readable output bucket", not a fabricated 0.
        let output: number | null = null
        if (usage !== null && typeof usage === 'object') {
          // Official TokenUsage semantics: buckets are disjoint — `inputTokens` is uncached input only, cache read/write
          // separate (prompt-side = input + cacheRead + cacheWrite); `outputTokens` includes reasoning; every bucket passes `tokenCountOf`.
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          output = tokenCountOf(usage.outputTokens)
          // Any readable bucket is a billing sample; a fully unreadable object stays absent, never a fabricated 0.
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
        s.requests.push(record)
        // The `turnRuns` ledger: one turn run per change of the `turn` value, exactly `countTurnRuns`'s rule.
        const prevLast = state.requests.at(-1)
        s.turnRuns = (state.turnRuns ?? countTurnRuns(state.requests))
          + (prevLast === undefined
            ? (record.turn !== undefined ? 1 : 0)
            : (record.turn === prevLast.turn ? 0 : 1))
        // The wait/generation boundary opens at the first OBSERVABLE instant (an earlier block-start marker that
        // precedes the first token included); anchoring at the token would double-count the decode window.
        const timing = ensureTiming(s)
        timing.calls += 1
        const stepStart = state.stepStart
        if (stepStart !== undefined) {
          const firstToken = stepStart.firstToken ?? firstTokenTimeOfStream(data?.stream)
          if (firstToken !== undefined) {
            const decodeBlocks = decodeSpansOfStream(data?.stream, event.time)
            let decodeStart = firstToken
            for (const block of decodeBlocks) decodeStart = Math.min(decodeStart, block.start)
            timing.ttftMs += durOf(stepStart.time, decodeStart)
            timing.genMs += durOf(decodeStart, event.time)
            // The strip's model slices: the silent wait, then the decode blocks in STREAM order off the SAME
            // `decodeStart` boundary, so rows, ring and strip read one window. A marker-less stream stays on residue.
            const modelSpans: TimingSpan[] = [{ kind: 'ttft', start: stepStart.time, end: decodeStart }]
            for (const block of decodeBlocks) {
              const to = Math.min(event.time, block.end)
              if (to <= block.start) continue
              modelSpans.push({ kind: block.kind, start: modelSpans.length === 1 ? decodeStart : block.start, end: to })
            }
            s.stepSpans = [...(s.stepSpans ?? []), ...modelSpans]
            // A call counts ONLY when both its decode window and its provider-reported output tokens are known; TPS
            // keeps the first-token anchor on purpose.
            if (output !== null) {
              timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time)
              timing.speedTokens = (timing.speedTokens ?? 0) + output
            }
            // The buckets tile the generation window; priced ONLY when the window was, so unstamped calls stay
            // unattributed.
            const tally = decodeTallyOfStream(data?.stream, event.time)
            for (const kind of DECODE_KINDS) addDecode(timing, kind, tally.spans[kind], tally.blocks[kind])
          }
        }
        // null when the content array is empty (a usage-only event projects to no message, as in dsh's surface fold).
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        const asstNode = applySurface(s, event, event.type, asstMsg)
        // The node carries `text` exactly when the message said something, so a text-less tool dispatch does not count.
        if (asstNode.text !== undefined) s.answers = (s.answers ?? 0) + 1
        break
      }
      case 'session/end-seed': {
        // The fork/seed boundary: a TAGGED marker (`inherited: true`) zeroes the cost totals so a seeded session
        // counts post-seed spend only. The UNTAGGED resume marker must leave the state reference untouched, or every
        // resume wipes history. `{}`, not `undefined`: an undefined-valued property fails the plain-JSON precondition.
        if (data?.inherited !== true) break
        const s = ensure([])
        s.cost = {}
        break
      }
      case 'plan/mode': {
        // Plan mode adds a guidance section to every model request while active, so it earns an event.
        if (data && typeof data.active === 'boolean') {
          const s = ensure(['events'])
          s.events.push({ seq: event.seq, time: event.time, kind: 'mode', name: data.active ? 'plan.on' : 'plan.off' })
          bumpDetailRev(s)
        }
        break
      }
      case 'compaction/summary':
      case 'compaction/prune': {
        const s = ensure(['events'])
        bumpDetailRev(s)
        // The replacement that follows this event synchronously shadows exactly these node seqs.
        if (data && Array.isArray(data.shadowedSeqs)) {
          s.pendingShadowedSeqs = data.shadowedSeqs.filter((x): x is number => typeof x === 'number')
          s.pendingShadowEventSeq = event.seq
        }
        s.events.push({
          seq: event.seq,
          time: event.time,
          kind: event.type === 'compaction/summary' ? 'compaction' : 'prune',
          tokens: data && typeof data.shadowedTokenCount === 'number' ? data.shadowedTokenCount : 0,
          ...(event.type === 'compaction/summary' && data && Array.isArray(data.shadowedSeqs)
            ? { count: data.shadowedSeqs.length }
            : {}),
        })
        break
      }
      default:
        return state
    }
  } catch {
    // Unreachable over well-formed events; a failed event drops WHOLE (partial mutations lived on private clones).
    st = undefined
  }

  if (st !== undefined) {
    trimState(st, bounds)
    return st
  }
  return state
}

// The pre-split surface, kept for the specs; production callers import the owning sibling directly.
export { createTimelineState, trimToLastTurns } from './foldState'
export type { TimelineEvent, TimelineState } from './foldState'
export { addBilledUsage, isBeijingPeak, tokenCountOf } from './foldMetering'
export type { BilledUsage, UsageLike } from './foldMetering'
export { buildTimelineDetail, buildTimelineHead, buildTimelineView } from './foldWire'
