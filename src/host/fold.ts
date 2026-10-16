/**
 * The context-timeline fold: replays a session's durable event log into the per-request composition timeline.
 *
 * A session projection unit on `ctx.sessionProjections` (timeline.ts registers it): the framework calls
 * `applyTimeline` once per committed `session/event` and persists the returned state through the projection cache.
 * `applyTimeline` MUST return the same reference when the event does not change state — `Object.is` gates the
 * change feed — and any change returns a new reference built from a lazy shallow clone. The state must stay
 * plain JSON (cached-checkpoint precondition) and bounded.
 */

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
import { countTurnRuns, trimState } from './foldState'
import type { TimelineEvent, TimelineState } from './foldState'
import { accumulateCost, addDecode, bumpToolTotals, DECODE_KINDS, durOf, ensureTiming, tokenCountOf } from './foldMetering'
import type { UsageLike } from './foldMetering'

function categoryOf(type: string, message: { source?: MessageSource } | undefined): Category {
  if (type === 'assistant/message') return 'assistant'
  if (type === 'tool/result') return 'tool'
  if (type === 'developer/message') return 'inject'
  // Skill machinery is its own bucket: both source kinds are durable user/message injections that the plain
  // injected-context check would absorb.
  const kind = message?.source?.kind
  if (kind === 'skill-invocation' || kind === 'skill-catalog') return 'skill'
  if (isInjection(message?.source)) return 'inject'
  return 'user'
}

/** Mark the detail collections dirty. Fold branches that touch only the working slots (stepStart, callNames, the
 * shadow claim) or the envelope scalars must NOT bump — the served detail is unchanged and an open tab has nothing to refetch.
 */
function bumpDetailRev(st: TimelineState): void {
  st.detailRev = (st.detailRev ?? 0) + 1
}

/** The effective price is the LAST nonempty node, so dropping the oldest can only under-report a log whose newest nodes are all empty. */
const SYSTEM_NODES_MAX = 8

/** The effective system-prompt price: the last nonempty node, else 0 (the harness's own rule). */
function systemTokensOf(systems: readonly SystemPromptNode[]): number {
  for (let i = systems.length - 1; i >= 0; i--) {
    if (systems[i].tokens > 0) return systems[i].tokens
  }
  return 0
}

/** Append one system-prompt node, bounding the list (see SYSTEM_NODES_MAX). */
function pushSystem(st: TimelineState, node: SystemPromptNode): void {
  const systems = [...(st.systems ?? []), node]
  st.systems = systems.length > SYSTEM_NODES_MAX ? systems.slice(-SYSTEM_NODES_MAX) : systems
  st.systemTokens = systemTokensOf(st.systems)
}

/** A hostile log that dispatches without settling the parent run_code cannot grow the persisted state past this. */
const PENDING_CODE_OPS_MAX = 200

/** JSON-stringify an unknown argument payload; a hostile (cyclic) value yields no args. */
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

/** Stamped COPIES: the source objects are shared with the persisted previous state, so `gone` must never be written onto them. */
function archiveRemoved(st: TimelineState, removed: SurfaceNode[], goneSeq: number): void {
  for (const n of removed) st.archived.push({ ...n, gone: goneSeq })
}

/** Removal follows the SEQ list, not the declared range: pruned replacement nodes keep their own seqs beyond the
 * range end, so a range-based removal would leave them behind and overcount. */
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

/** The fields the surface projection reads off a durable event. */
type SurfaceEventLike = Pick<TimelineEvent, 'seq' | 'time' | 'surfaceOp'>

interface MessageLike {
  content?: ContentBlock[]
  source?: MessageSource
  /** The V4 generation's one error spelling: an event-level `error` mark is admitted only alongside it. */
  isError?: unknown
}

/** A structural read keeps malformed payloads total and, unlike `deriveEventMessage`, keeps an empty developer
 * message's surface position at zero tokens (the harness's message-projection rule the fold's surface mirrors). */
function messageOf(data: Record<string, unknown> | undefined): MessageLike | null {
  const message = data?.message
  return message !== null && typeof message === 'object' ? message : null
}

/** Unlike `firstText`, this must NOT truncate or normalize: the skill name is matched off the raw
 * `<skill_content name="…">` wrapper. */
function firstFullText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  for (const item of blocks) {
    if (item === null || typeof item !== 'object') continue
    const block = item as ContentBlock
    if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') return block.text
  }
  return ''
}

/** Loaded skills are rendered as `<skill_content name="…">…</skill_content>` in the result's text, so the name is
 * recovered from the content rather than trusted from the call envelope. Exported for the activity fold's
 * skill-load tally, which reads the raw `data.message` off the same durable event. */
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
    // Empty assistant/developer messages project to no model message, so skip content and role framing together.
    tokens: estimateMessage(message, type === 'assistant/message' || type === 'developer/message'),
  }
  // Image blocks ride the NODE (absent when zero): the stats board sums the live surface, so a compacted message's images stop counting.
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
    const toolEntry = typeof srcId === 'string' ? st.callNames[srcId] : undefined
    if (toolEntry !== undefined) {
      node.tool = toolEntry.name
      const timing = ensureTiming(st)
      const dur = durOf(toolEntry.start, ev.time)
      timing.toolsMs += dur
      timing.toolCalls += 1
      bumpToolTotals(timing, toolEntry.name, dur)
      // Painted only while a step is open to own the window (a cross-step or foreign result still prices the totals above).
      if (st.stepStart !== undefined) {
        st.stepSpans = [...(st.stepSpans ?? []), { kind: 'tools', start: toolEntry.start, end: ev.time }]
      }
    }
    // Rebuild without the used id (no dynamic delete, per repo lint); the map holds at pending-call size, so the copy is trivial.
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
      // This path removes by seq and appends, while the harness splices the replacement at the declared range
      // start's index — so the node takes that start's seat, or its own newer seq parks it after every message.
      const head = removed.find(n => n.seq === op.start)
      if (head !== undefined) node.seat = head.seat ?? head.seq
      st.surface.push(node)
      // Rewrite the metering row from its gross shadow price to the NET freed amount, so it matches the drop the
      // trend chart shows. Cloned: the events array's elements are shared with the persisted state.
      if (shadowEventSeq !== undefined) {
        const removedSum = removed.reduce((sum, n) => sum + n.tokens, 0)
        const i = st.events.findIndex(e => e.seq === shadowEventSeq)
        if (i >= 0) st.events[i] = { ...st.events[i], tokens: Math.max(0, removedSum - node.tokens) }
      }
      return node
    }
    // Spliced IN PLACE: the harness gives the replacing node the span's position, and BOTH endpoints must name live
    // nodes as its registry validates. A malformed span degrades to an append, keeping the nodes.
    let si = -1
    let ei = -1
    for (let i = 0; i < st.surface.length; i++) {
      if (si < 0 && st.surface[i].seq === op.start) si = i
      if (st.surface[i].seq === op.end) { ei = i; break }
    }
    if (si >= 0 && ei >= si) {
      const removed = st.surface.splice(si, ei - si + 1, node)
      node.seat = removed[0].seat ?? removed[0].seq
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

/** Its settled result IS the user's answer, so it folds into the human-input tally; one result = one submission. */
const ASK_USER_TOOL = 'ask_user_question'

/** The collections a fold branch may mutate IN PLACE. A branch names exactly its own mutations in `ensure`; the
 * unlisted containers are never written in place — every touch REPLACES the property with a fresh array/record — so
 * they stay shared with the persisted previous state without a clone. */
type CloneKey = 'surface' | 'sums' | 'requests' | 'events' | 'archived' | 'callNames' | 'fileOps' | 'timing'

const CLONE_ALL: readonly CloneKey[] = ['surface', 'sums', 'requests', 'events', 'archived', 'callNames', 'fileOps', 'timing']

export function applyTimeline(state: TimelineState, event: TimelineEvent, bounds: FoldBounds): TimelineState {
  let st: TimelineState | undefined
  /** The event's private working state. Called EXACTLY ONCE per event (each case names the collections its own path
   * may write into; helpers never call it), so building afresh per call is safe. The default is the full clone, so a
   * future branch that omits its list degrades to the old behavior instead of sharing a collection it mutates. */
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
      // Absent `timing` stays absent: an own `undefined`-valued property fails every cache write.
      else if (state.timing !== undefined) st.timing = { ...state.timing, tools: { ...state.timing.tools } }
    }
    return st
  }

  const data = event.data
  // The registry drives `apply` straight off the session/event bus with no error boundary: one throwing fold stops
  // this unit's cells and its push feed from advancing, leaving the browser on "loading" forever. The durable log is
  // untrusted input, so a malformed event is DROPPED, never thrown.
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
        // The routed output cap auto-compaction reserves out of the window (the envelope's effective
        // maxTokens, adapter default materialized). Last-wins, so a cap-less header clears it.
        const maxOutputTokens = header.config?.maxTokens
        if (typeof maxOutputTokens === 'number' && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0) {
          s.maxOutputTokens = maxOutputTokens
        } else {
          delete s.maxOutputTokens
        }
        // A model switch has no dedicated event: it is a request header differing from the previous one, logged with
        // reason 'change' ('initial' opens a session, 'resume' reopens it).
        if ((data?.reason === 'change' || data?.reason === 'resume') && s.model && s.lastModel && s.model !== s.lastModel) {
          s.events.push({ seq: event.seq, time: event.time, kind: 'model', from: s.lastModel, to: s.model })
          bumpDetailRev(s)
        }
        if (s.model) s.lastModel = s.model
        break
      }
      case 'system/message': {
        // The system prompt is position 0 of the harness's ordered surface but stays outside the plugin's message
        // categories: it is the envelope figure's source, so it must not enter `surface`/`sums` (that would
        // double-count it against `systemTokens`).
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
        // Logged only when the route or capacity changes, so it updates the current route display but never fires a model-switch event.
        if (data && typeof data.contextWindow === 'number') s.contextWindow = data.contextWindow
        if (data && typeof data.model === 'string') s.model = data.model
        if (data && typeof data.provider === 'string') s.provider = data.provider
        break
      }
      case 'tool/call': {
        if (data && typeof data.callId === 'string' && typeof data.name === 'string') {
          const s = ensure(['callNames'])
          // Arguments are kept ONLY where they can be read (an op-bearing tool, or the run_code root the flush reads),
          // keeping a large bash/pwsh call out of the persisted state.
          const argsRaw = rawArgsNeeded(data.name) ? argsRawOf(data.arguments) : undefined
          s.callNames[data.callId] = {
            name: data.name,
            start: event.time,
            ...(argsRaw !== undefined ? { argsRaw } : {}),
          }
        }
        break
      }
      case 'tool/ptc-dispatch': {
        // A nested PTC (Code Mode) call settling inside a run_code program: its dispatch event carries no meta, so
        // read windows and per-file search attribution degrade to the argument-only forms. The ops buffer under the
        // top run_code call id and flush when its result folds (their locate target is that result's row).
        const rootCallId = data?.rootCallId
        const name = data?.name
        if (typeof rootCallId === 'string' && typeof name === 'string') {
          // Same gating as tool/call, minus the run_code arm.
          const argsRaw = opBearingTool(name) ? argsRawOf(data?.arguments) : undefined
          const ops = opsOfCall({
            seq: event.seq,
            time: event.time,
            tool: name,
            argsRaw,
            err: data?.isError === true,
          })
          if (ops.length > 0) {
            const s = ensure([])
            bufferCodeOps(s, rootCallId, ops)
          }
        }
        break
      }
      case 'assistant/attempt': {
      // One model attempt that committed no surface message, but whose embedded stream still carries the attempt's
      // first token — the harness's own sessionStats fold stamps it on the open step the same way, so an in-step
      // retry keeps its real TTFT instead of falling into the card's residue.
        const start = state.stepStart
        if (start === undefined || start.firstToken !== undefined) return state
        const first = firstTokenTimeOfStream(data?.stream)
        if (first === undefined) return state
        const s = ensure([])
        s.stepStart = { time: start.time, firstToken: first }
        break
      }
      case 'step/start': {
        // A superseded step's leftover span accumulator and wait/approval/back-pointer slots die here (their instants
        // predate the new window).
        const s = ensure([])
        s.stepStart = { time: event.time }
        delete s.stepSpans
        delete s.stepWaits
        delete s.stepApprovals
        delete s.stepRequestSeq
        break
      }
      case 'step/end': {
        // No open slot (an unpaired step/end, or one the step aged past a refold): the state must stay reference-equal.
        const start = state.stepStart
        if (start === undefined) return state
        const s = ensure(state.stepRequestSeq !== undefined ? ['timing', 'requests'] : ['timing'])
        ensureTiming(s).wallMs += durOf(start.time, event.time)
        // ACTIVE time prices the trend chart's duration overlay: the step window minus the clamped union of the
        // step's user waits. The stamp lands on the step's committed request record, and a hostile refold that lost
        // the row just skips it.
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
        // their UNION, never double wall time) and every hole filled with the residue kind, so it always tiles
        // gapless. A zero-width step (hostile times) flushes nothing.
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
        // An out-of-step ask prices nothing and must leave the state reference-equal.
        const id = data?.id
        if (state.stepStart === undefined || typeof id !== 'string') return state
        const s = ensure([])
        s.stepApprovals = { ...state.stepApprovals, [id]: event.time }
        break
      }
      case 'approval/decided': {
        // A decided without its armed asked (an out-of-step pair, a refold window) prices nothing.
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
        // The dependency projects an empty developer message to null; the structural read keeps its surface position.
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
              // The same identity rides the surface node, so browser rows label the injection as this event row does.
              node.name = label
            }
            // A notice carries the producer's bounded one-line account; show it after the source name, as the dsh transcript row does.
            if (source?.form === 'notice' && typeof source.summary === 'string' && source.summary !== '') {
              rec.detail = source.summary
            }
          }
          s.events.push(rec)
        } else {
          s.humanInputs = (s.humanInputs ?? 0) + 1
          // Last-wins: a text-less message (images only) keeps the previous line.
          if (node.text !== undefined && node.text !== '') s.lastUser = node.text
        }
        break
      }
      case 'tool/result': {
        // Pricing the envelope instead of data.message would miss all content.
        const toolMsg = deriveEventMessage(event as never) as MessageLike | null
        // Read before applySurface consumes it: the armed call pairs this result into file ops, and the result's
        // callId is the flush key for buffered Code-Mode ops.
        const msgSource = toolMsg?.source as { callId?: unknown } | undefined
        const srcId = msgSource?.callId
        const pendingEntry = typeof srcId === 'string' ? state.callNames[srcId] : undefined
        const buffered = typeof srcId === 'string' ? state.pendingCodeOps?.[srcId] : undefined
        const s = ensure(['surface', 'sums', 'archived', 'events', 'fileOps', 'timing'])
        bumpDetailRev(s)
        const node = applySurface(s, event, event.type, toolMsg)
        // An answered question prompt is a human input too; an unpaired/foreign result carries no tool name and counts nothing.
        if (node.tool === ASK_USER_TOOL) s.humanInputs = (s.humanInputs ?? 0) + 1
        // The Q&A tool's whole window is the user's answer wait, so the open step books it for the `activeMs` subtraction at `step/end`.
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
        }
        if (buffered !== undefined && buffered.length > 0) {
          // The run_code root settles: its nested ops land with `parent` = this
          // result's row, plus the program description off its call arguments.
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
        // A skill load's tool result is harness-injected context with its own composition bucket: the price moves
        // from `tool` to `skill` at the surface-sum level so the charts show the skill's occupancy instead of
        // burying it among ordinary results. The name comes from the rendered `<skill_content name="…">` wrapper,
        // and when the tool/call event is gone (trimmed window, replay) the wrapper alone still identifies a
        // genuine skill result. The stamp keeps unpaired loads countable as tool calls.
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
        // Official TokenUsage semantics: the buckets are disjoint — inputTokens is uncached input only, cache
        // read/write are separate, billed prompt-side = input + cacheRead + cacheWrite — and outputTokens already
        // includes reasoningTokens. Every bucket passes `tokenCountOf` first, because the durable log is untrusted
        // and a raw nonconforming figure must never enter the state.
          const input = tokenCountOf(usage.inputTokens)
          const cacheRead = tokenCountOf(usage.cacheReadTokens)
          const cacheWrite = tokenCountOf(usage.cacheWriteTokens)
          output = tokenCountOf(usage.outputTokens)
          // Any readable bucket is a billing sample, and a fully unreadable object is absent, so a fabricated 0 never
          // reaches the client's derived-occupancy anchor.
          if (input !== null || cacheRead !== null || cacheWrite !== null || output !== null) {
            record.prompt = (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
            // Cache-hit share of the billed prompt (the step line's cache figure).
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
        // The wait/generation boundary sits at the first OBSERVABLE instant, reached back to an earlier block marker
        // when the stream's markers precede the token (a redacted reasoning block leaves no chunk behind): anchoring
        // at the token instead would charge the marker-tiled decode window to the wait and the legend's rows would
        // double-count past 100%. A stream with no token (an aborted step) stays unattributed and lands in the
        // card's residue. The pending slot stays armed — the step's tool calls and `step/end` still follow.
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
            // decodeStart boundary, so the rows, the ring and the strip read one window. A marker-less stream leaves
            // the window to the step/end residue fill.
            const modelSpans: TimingSpan[] = [{ kind: 'ttft', start: stepStart.time, end: decodeStart }]
            for (const block of decodeBlocks) {
              const to = Math.min(event.time, block.end)
              if (to <= block.start) continue
              modelSpans.push({ kind: block.kind, start: modelSpans.length === 1 ? decodeStart : block.start, end: to })
            }
            s.stepSpans = [...(s.stepSpans ?? []), ...modelSpans]
            // Paired exactly as the harness's session-stats fold pairs them: a call counts ONLY when both its decode
            // window and its provider-reported output tokens are known. TPS keeps the first-token anchor on purpose,
            // because it is the harness-parity figure.
            if (output !== null) {
              timing.speedMs = (timing.speedMs ?? 0) + durOf(firstToken, event.time)
              timing.speedTokens = (timing.speedTokens ?? 0) + output
            }
            // Generation split: the buckets tile the generation window, leaving only the settlement tail unattributed.
            // Priced ONLY when the window was, so an unstamped call's unattributed time cannot reappear here.
            const tally = decodeTallyOfStream(data?.stream, event.time)
            for (const kind of DECODE_KINDS) addDecode(timing, kind, tally.spans[kind], tally.blocks[kind])
          }
        }
        // null when the content array is empty (usage-only events project to no message, same rule as dsh's surface fold).
        const asstMsg = deriveEventMessage(event as never) as MessageLike | null
        const asstNode = applySurface(s, event, event.type, asstMsg)
        // The node carries `text` exactly when the message said something, so a text-less tool dispatch does not count.
        if (asstNode.text !== undefined) s.answers = (s.answers ?? 0) + 1
        break
      }
      case 'session/end-seed': {
        // The fork/seed boundary: events before a TAGGED marker (`inherited: true`) are the parent-log prefix a
        // seeded child replays verbatim, usage settlements included — spend the session it forked from already
        // priced. Zeroing the cost totals makes a seeded session's own cost count post-seed spend only. The
        // UNTAGGED marker is the ordinary resume/replay boundary and must leave the state reference untouched, or
        // every resume would wipe the session's history. `{}`, not `undefined`: an undefined-valued property fails
        // the plain-JSON cache precondition.
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
    // Unreachable over well-formed events; the guard exists so a fold can never take the projection down. A failed
    // event is dropped WHOLE — partial mutations lived on private lazy clones — keeping the transition all-or-nothing.
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
export { addBilledUsage, isPeakUtc, tokenCountOf } from './foldMetering'
export type { BilledUsage, UsageLike } from './foldMetering'
export { buildTimelineDetail, buildTimelineHead, buildTimelineView } from './foldWire'
