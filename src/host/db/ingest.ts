import type { FoldBounds } from '../config'
import type { TimelineState } from '../foldState'
import { createTimelineState } from '../foldState'
import type { Db } from './db'
import {
  applyFoldEvents,
  deleteSessionChildRows,
  prepareFoldState,
  writeSessionFold,
} from './foldSession'
import type { FoldResult } from './foldSession'
import { RowsSink, writeBatch } from './rows'

export interface FoldRequest {
  db: Db
  sessionId: string
  title: string
  cwd?: string | null
  isSeeded?: boolean
  events: readonly { type: string; seq: number; time: number; data?: Record<string, unknown>; surfaceOp?: unknown }[]
  bounds: FoldBounds
  baseState?: TimelineState
  incremental: boolean
  pluginOf?: (name: string) => string | undefined
  now?: () => number
  onBatch?: () => void
}

export function foldSession(request: FoldRequest): FoldResult {
  const { db, sessionId, bounds } = request
  if (!request.incremental) deleteSessionChildRows(db, sessionId)
  const base = prepareFoldState(request.baseState ?? createTimelineState(), request.isSeeded)
  const sink = new RowsSink(sessionId, request.pluginOf, base.nextSpanSeq)
  const folded = applyFoldEvents(db, sessionId, base, request.events, bounds, sink, request.onBatch)
  const pending = sink.take()
  if (pending.headerEpochs.length + pending.requests.length + pending.steps.length
    + pending.toolCalls.length + pending.surfaces.length + pending.systems.length
    + pending.events.length + pending.fileOps.length + pending.skillLoads.length
    + pending.spans.length + pending.stepPatches.length + pending.requestPatches.length
    + pending.toolPatches.length + pending.eventPatches.length + pending.surfacePatches.length
    + pending.systemPatches.length > 0) {
    writeBatch(db, pending, sessionId)
  }
  writeSessionFold(db, {
    sessionId,
    title: request.title,
    cwd: request.cwd,
    isSeeded: request.isSeeded,
    pluginOf: request.pluginOf,
    now: request.now,
  }, folded.state, folded.lastSeq, 'ok')
  return { state: folded.state, lastSeq: folded.lastSeq, rows: folded.rows }
}
