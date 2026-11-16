import { eq, sql } from 'drizzle-orm'
import type { FoldBounds } from '../config'
import { applyTimeline } from '../fold'
import { createTimelineState } from '../foldState'
import type { TimelineEvent, TimelineState } from '../foldState'
import type { Db } from './db'
import { bumpGeneration } from './db'
import { RowsSink, searchTextOf, writeBatch } from './rows'
import { foldState, sessions } from './schema'

export const ROW_CHUNK = 2_000


export interface FoldSessionOptions {
  sessionId: string
  title: string
  cwd?: string | null
  isSeeded?: boolean
  pluginOf?: (name: string) => string | undefined
  now?: () => number
  onBatch?: () => void
}

export interface FoldResult {
  state: TimelineState
  lastSeq: number
  rows: number
}

const STATE_KEYS = [
  'surface', 'sums', 'assistantReasoning', 'assistantAnswerTokens', 'assistantCallTokens',
  'systemTokens', 'systems', 'toolsTokens', 'model', 'provider', 'reasoningEffort', 'lastModel',
  'contextWindow', 'maxOutputTokens', 'requests', 'turnRuns', 'events', 'callNames', 'stepStart',
  'stepWaits', 'stepApprovals', 'stepRequestSeq', 'stepBeats', 'stepBeatsFull', 'stepSeq',
  'pendingShadowedSeqs', 'pendingShadowEventSeq', 'fileOpsFloor', 'commands', 'commandsFloor',
  'commandStats', 'commandCalls', 'commandCallsOverflow', 'agents', 'pendingCodeCmds',
  'pendingCodeOps', 'pendingCodeStarts', 'stepSpans', 'detailRev', 'isSeeded', 'seedCutSeq',
  'createdDay', 'billedTokens', 'nextSpanSeq',
] as const

export function stateToJson(state: TimelineState): string {
  const picked: Record<string, unknown> = {}
  for (const key of STATE_KEYS) {
    const value = state[key]
    if (value !== undefined) picked[key] = value
  }
  return JSON.stringify(picked)
}

export function decodeStateJson(json: string | null | undefined): TimelineState | null {
  if (json === null || json === undefined || json === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const raw = parsed as Record<string, unknown>
  if (!Array.isArray(raw.surface) || typeof raw.sums !== 'object' || raw.sums === null) return null
  if (!Array.isArray(raw.requests) || !Array.isArray(raw.events) || !Array.isArray(raw.commands)) return null
  if (typeof raw.callNames !== 'object' || raw.callNames === null) return null
  const value = raw as Partial<TimelineState>
  const fallback = createTimelineState()
  return {
    ...fallback,
    ...value,
    surface: value.surface as TimelineState['surface'],
    sums: { ...fallback.sums, ...value.sums },
    requests: value.requests as TimelineState['requests'],
    events: value.events as TimelineState['events'],
    commands: value.commands as TimelineState['commands'],
    callNames: value.callNames as TimelineState['callNames'],
    billedTokens: value.billedTokens ?? 0,
    nextSpanSeq: value.nextSpanSeq ?? 0,
  }
}

export function applyFoldEvents(
  db: Db,
  sessionId: string,
  state: TimelineState,
  events: readonly TimelineEvent[],
  bounds: FoldBounds,
  sink: RowsSink,
  onBatch?: () => void,
): { state: TimelineState; lastSeq: number; rows: number } {
  let next = state
  let lastSeq = -1
  let rows = 0
  for (const event of events) {
    next = applyTimeline(next, event, bounds, sink)
    if (typeof event.seq === 'number') lastSeq = Math.max(lastSeq, event.seq)
    if (sink.drainSize() > ROW_CHUNK) {
      rows += sink.drainSize()
      writeBatch(db, sink.take(), sessionId)
      onBatch?.()
    }
  }
  return { state: next, lastSeq, rows }
}

export function prepareFoldState(base: TimelineState | undefined, isSeeded: boolean | undefined): TimelineState {
  const state = base ?? createTimelineState()
  if (isSeeded !== undefined) state.isSeeded = isSeeded
  return state
}

export function writeSessionFold(
  db: Db,
  options: FoldSessionOptions,
  state: TimelineState,
  lastSeq: number,
  status: 'ok',
): void {
  const at = (options.now ?? Date.now)()
  const current = db.select({ detailRev: sessions.detailRev, title: sessions.title })
    .from(sessions).where(eq(sessions.id, options.sessionId)).get()
  const rev = Math.max((current?.detailRev ?? 0) + 1, 1)
  const lastUser = state.lastUser ?? null
  const curTotal = state.systemTokens + state.toolsTokens
    + state.sums.user + state.sums.inject + state.sums.skill + state.sums.assistant + state.sums.tool
  const stateJson = stateToJson(state)
  db.transaction(() => {
    db.update(sessions).set({
      model: state.model ?? null,
      provider: state.provider ?? null,
      reasoningEffort: state.reasoningEffort ?? null,
      contextWindow: state.contextWindow ?? null,
      maxOutputTokens: state.maxOutputTokens ?? null,
      curTotal,
      lastUser,
      billedTokens: state.billedTokens ?? 0,
      seedCutSeq: state.seedCutSeq ?? null,
      createdDay: state.createdDay ?? null,
      lastSeq,
      foldStatus: status,
      foldError: null,
      detailRev: rev,
      foldedAt: at,
      searchText: searchTextOf(current?.title ?? options.title, options.cwd, lastUser),
    }).where(eq(sessions.id, options.sessionId)).run()
    db.insert(foldState).values({
      sessionId: options.sessionId,
      lastSeq,
      stateJson,
      updatedAt: at,
    }).onConflictDoUpdate({
      target: foldState.sessionId,
      set: { lastSeq, stateJson, updatedAt: at },
    }).run()
  }, { behavior: 'immediate' })
}

export function markFoldStatus(db: Db, sessionId: string, status: 'pending' | 'folding' | 'failed' | 'unsupported', error?: string): void {
  const nextError = error === undefined ? null : error.slice(0, 200)
  const current = db.select({ status: sessions.foldStatus, error: sessions.foldError })
    .from(sessions).where(eq(sessions.id, sessionId)).get()
  if (current?.status === status && current.error === nextError) return
  db.update(sessions).set({
    foldStatus: status,
    foldError: nextError,
    detailRev: sql`${sessions.detailRev} + 1`,
  }).where(eq(sessions.id, sessionId)).run()
  bumpGeneration(db)
}

export function deleteSessionChildRows(db: Db, sessionId: string): void {
  const tables = [
    'header_tools', 'header_epochs', 'timing_spans', 'skill_loads', 'file_ops', 'events',
    'system_prompts', 'surface_nodes', 'tool_calls', 'steps', 'requests',
  ]
  db.transaction(() => {
    for (const table of tables) db.run(sql`delete from ${sql.identifier(table)} where ${sql.identifier('session_id')} = ${sessionId}`)
    db.delete(foldState).where(eq(foldState.sessionId, sessionId)).run()
    db.update(sessions).set({
      lastSeq: -1,
      foldStatus: 'pending',
      foldError: null,
      detailRev: sql`${sessions.detailRev} + 1`,
    }).where(eq(sessions.id, sessionId)).run()
  }, { behavior: 'immediate' })
  bumpGeneration(db)
}
