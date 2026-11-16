import { and, eq, getTableColumns } from 'drizzle-orm'
import type { SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { ContextEventRecord, FileOpRecord, SurfaceNode, TimingSpan } from '../../shared/types'
import { dayKeyOf } from '../../shared/days'
import { commandProgramsOf } from '../../shared/commands'
import type { CommandStateRecord } from '../foldState'
import type { Db } from './db'
import type { FoldSink, SinkHeader, SinkRequest, SinkSkillLoad, SinkStepEnd, SinkStepStart, SinkToolCall, SinkToolPatch } from './foldSink'
import {
  events,
  fileOps,
  headerEpochs,
  headerTools,
  requests,
  skillLoads,
  steps,
  surfaceNodes,
  systemPrompts,
  timingSpans,
  toolCalls,
} from './schema'

const PREVIEW_MAX = 2_000

const PARAMETER_BUDGET = 900

export interface RowBatch {
  headerEpochs: (typeof headerEpochs.$inferInsert)[]
  headerTools: (typeof headerTools.$inferInsert)[]
  requests: (typeof requests.$inferInsert)[]
  steps: (typeof steps.$inferInsert)[]
  toolCalls: (typeof toolCalls.$inferInsert)[]
  surfaces: (typeof surfaceNodes.$inferInsert)[]
  systems: (typeof systemPrompts.$inferInsert)[]
  events: (typeof events.$inferInsert)[]
  fileOps: (typeof fileOps.$inferInsert)[]
  skillLoads: (typeof skillLoads.$inferInsert)[]
  spans: (typeof timingSpans.$inferInsert)[]
  stepPatches: { seq: number; values: Partial<typeof steps.$inferInsert> }[]
  requestPatches: { seq: number; values: Partial<typeof requests.$inferInsert> }[]
  toolPatches: { callId: string; values: Partial<typeof toolCalls.$inferInsert> }[]
  eventPatches: { seq: number; values: Partial<typeof events.$inferInsert> }[]
  surfacePatches: { seq: number; values: Partial<typeof surfaceNodes.$inferInsert> }[]
  systemPatches: { seq: number; values: Partial<typeof systemPrompts.$inferInsert> }[]
}

export function emptyBatch(): RowBatch {
  return {
    headerEpochs: [],
    headerTools: [],
    requests: [],
    steps: [],
    toolCalls: [],
    surfaces: [],
    systems: [],
    events: [],
    fileOps: [],
    skillLoads: [],
    spans: [],
    stepPatches: [],
    requestPatches: [],
    toolPatches: [],
    eventPatches: [],
    surfacePatches: [],
    systemPatches: [],
  }
}

export function batchSize(batch: RowBatch): number {
  return batch.headerEpochs.length + batch.headerTools.length + batch.requests.length + batch.steps.length
    + batch.toolCalls.length + batch.surfaces.length + batch.systems.length + batch.events.length
    + batch.fileOps.length + batch.skillLoads.length + batch.spans.length
    + batch.stepPatches.length + batch.requestPatches.length + batch.toolPatches.length
    + batch.eventPatches.length + batch.surfacePatches.length + batch.systemPatches.length
}

function previewOf(text: string | undefined): { preview?: string; truncated: number } {
  if (text === undefined || text === '') return { truncated: 0 }
  return text.length > PREVIEW_MAX
    ? { preview: text.slice(0, PREVIEW_MAX), truncated: 1 }
    : { preview: text, truncated: 0 }
}

function lowerText(...parts: (string | null | undefined)[]): string {
  return parts.filter((part): part is string => typeof part === 'string' && part !== '').join('\n').toLowerCase()
}

export function searchTextOf(title: string, cwd: string | null | undefined, lastUser: string | null | undefined): string {
  return lowerText(title, cwd, lastUser)
}

function toolPatchValues(patch: SinkToolPatch): Partial<typeof toolCalls.$inferInsert> {
  const values: Partial<typeof toolCalls.$inferInsert> = {}
  if (patch.resultSeq !== undefined) values.resultSeq = patch.resultSeq
  if (patch.endTime !== undefined) values.endTime = patch.endTime
  if (patch.durationMs !== undefined) values.durationMs = patch.durationMs
  if (patch.isError !== undefined) values.isError = patch.isError ? 1 : 0
  if (patch.status !== undefined) values.status = patch.status
  if (patch.exitCode !== undefined) values.exitCode = patch.exitCode
  if (patch.exitInferred !== undefined) values.exitInferred = patch.exitInferred ? 1 : 0
  if (patch.signal !== undefined) values.signal = patch.signal
  if (patch.timedOut !== undefined) values.timedOut = patch.timedOut ? 1 : 0
  if (patch.stopped !== undefined) values.stopped = patch.stopped ? 1 : 0
  if (patch.denied !== undefined) values.denied = patch.denied ? 1 : 0
  if (patch.derived !== undefined) values.derived = patch.derived ? 1 : 0
  if (patch.background !== undefined) values.background = patch.background ? 1 : 0
  if (patch.outChars !== undefined) values.outChars = patch.outChars
  if (patch.outTruncated !== undefined) values.outTruncated = patch.outTruncated ? 1 : 0
  if (patch.stderr !== undefined) values.stderr = patch.stderr ? 1 : 0
  if (patch.startTime !== undefined) values.startTime = patch.startTime
  if (patch.transport !== undefined) values.transport = patch.transport ? 1 : 0
  return values
}

export class RowsSink implements FoldSink {
  private batch = emptyBatch()
  private fileSeq = -1
  private fileOrdinal = 0
  private nextSpanSeq: number

  constructor(
    private readonly sessionId: string,
    private readonly pluginOf: (name: string) => string | undefined = () => undefined,
    nextSpanSeq = 0,
    private readonly day: (time: number) => string = time => dayKeyOf(time) ?? '',
  ) {
    this.nextSpanSeq = nextSpanSeq
  }

  take(): RowBatch {
    const batch = this.batch
    this.batch = emptyBatch()
    return batch
  }

  drainSize(): number {
    return batchSize(this.batch)
  }

  spanSeq(): number {
    return this.nextSpanSeq
  }

  header(row: SinkHeader): void {
    this.batch.headerEpochs.push({
      sessionId: this.sessionId,
      seq: row.seq,
      time: row.time,
      reason: row.reason ?? null,
    })
    row.tools.forEach((tool, ordinal) => {
      this.batch.headerTools.push({
        sessionId: this.sessionId,
        epochSeq: row.seq,
        ordinal,
        name: tool.name,
        tokens: tool.tokens,
        plugin: tool.plugin ?? this.pluginOf(tool.name) ?? null,
      })
    })
  }

  system(row: { seq: number; time: number; tokens: number }): void {
    this.batch.systems.push({ sessionId: this.sessionId, seq: row.seq, time: row.time, tokens: row.tokens })
  }

  systemGone(seq: number, goneSeq: number): void {
    this.batch.systemPatches.push({ seq, values: { goneSeq } })
  }

  surface(node: SurfaceNode): void {
    const preview = previewOf(node.text)
    this.batch.surfaces.push({
      sessionId: this.sessionId,
      seq: node.seq,
      time: node.time ?? null,
      cat: node.cat,
      tokens: node.tokens,
      reasoningTokens: node.reasoning ?? null,
      answerTokens: node.answerTokens ?? null,
      callTokens: node.callTokens ?? null,
      imgs: node.imgs ?? null,
      form: node.form ?? null,
      name: node.name ?? null,
      agent: node.agent ?? null,
      tool: node.tool ?? null,
      skill: node.skill ?? null,
      isError: node.err === true ? 1 : 0,
      calls: node.calls === undefined ? null : JSON.stringify(node.calls),
      preview: preview.preview ?? null,
      previewTruncated: preview.truncated,
      goneSeq: node.gone ?? null,
    })
  }

  surfaceGone(seq: number, goneSeq: number): void {
    this.batch.surfacePatches.push({ seq, values: { goneSeq } })
  }

  request(row: SinkRequest): void {
    this.batch.requests.push({
      sessionId: this.sessionId,
      seq: row.seq,
      time: row.time,
      day: row.day,
      turn: row.turn ?? null,
      step: row.step ?? null,
      startsTurn: row.startsTurn ? 1 : 0,
      isInherited: row.inherited ? 1 : 0,
      systemTokens: row.system,
      toolsTokens: row.tools,
      userTokens: row.user,
      injectTokens: row.inject,
      skillTokens: row.skill,
      assistantTokens: row.assistant,
      toolTokens: row.tool,
      totalTokens: row.total,
      model: row.model ?? null,
      provider: row.provider ?? null,
      period: row.period ?? null,
      promptTokens: row.prompt ?? null,
      inputTokens: row.input ?? null,
      cacheReadTokens: row.cacheRead ?? null,
      cacheWriteTokens: row.cacheWrite ?? null,
      outputTokens: row.output ?? null,
      reasoningTokens: row.reasoning ?? null,
      genMs: row.genMs ?? null,
    })
  }

  requestActive(seq: number, activeMs: number): void {
    this.batch.requestPatches.push({ seq, values: { activeMs } })
  }

  stepStart(row: SinkStepStart): void {
    this.batch.steps.push({
      sessionId: this.sessionId,
      seq: row.seq,
      turn: row.turn ?? null,
      step: row.step ?? null,
      startTime: row.time,
      endTime: null,
      day: row.day,
      requestSeq: null,
      wallMs: 0,
      activeMs: 0,
      waitMs: 0,
      idleMs: 0,
      toolBusyMs: 0,
      ttftMs: null,
      beatsFull: row.beatsFull ? 1 : 0,
    })
  }

  stepRequest(seq: number, requestSeq: number): void {
    this.batch.stepPatches.push({ seq, values: { requestSeq } })
  }

  stepEnd(row: SinkStepEnd): void {
    this.batch.stepPatches.push({
      seq: row.seq,
      values: {
        endTime: row.endTime,
        wallMs: row.wallMs,
        activeMs: row.activeMs,
        waitMs: row.waitMs,
        idleMs: row.idleMs,
        toolBusyMs: row.toolBusyMs,
        ttftMs: row.ttftMs ?? null,
        beatsFull: row.beatsFull ? 1 : 0,
      },
    })
  }

  toolCall(row: SinkToolCall): void {
    this.batch.toolCalls.push({
      sessionId: this.sessionId,
      seq: row.seq,
      callId: row.callId,
      resultSeq: null,
      name: row.name,
      plugin: this.pluginOf(row.name) ?? null,
      transport: row.transport ? 1 : 0,
      codeMode: row.codeMode ? 1 : 0,
      parentSeq: row.parentSeq ?? null,
      turn: row.turn ?? null,
      step: row.step ?? null,
      day: row.day || this.day(row.time),
      startTime: row.time,
      endTime: null,
      durationMs: null,
      isError: 0,
      status: null,
      exitCode: null,
      exitInferred: 0,
      signal: null,
      timedOut: 0,
      stopped: 0,
      denied: 0,
      derived: 0,
      background: 0,
      timeoutMs: null,
      sandbox: null,
      cmd: null,
      cmdTruncated: 0,
      cmdDescription: null,
      cmdCwd: null,
      program: null,
      outChars: null,
      outTruncated: 0,
      stderr: 0,
    })
  }

  toolCallUpdate(callId: string, patch: SinkToolPatch): void {
    const values = toolPatchValues(patch)
    if (Object.keys(values).length === 0) return
    this.batch.toolPatches.push({ callId, values })
  }

  command(rec: CommandStateRecord): void {
    this.batch.toolCalls.push({
      sessionId: this.sessionId,
      seq: rec.seq,
      callId: rec.call ?? '',
      resultSeq: rec.resultSeq ?? null,
      name: rec.tool,
      plugin: this.pluginOf(rec.tool) ?? null,
      transport: 0,
      codeMode: rec.codeMode === true ? 1 : 0,
      parentSeq: rec.parent ?? null,
      turn: rec.turn ?? null,
      step: rec.step ?? null,
      day: this.day(rec.start),
      startTime: rec.start,
      endTime: rec.end ?? null,
      durationMs: rec.end === undefined ? null : Math.max(0, rec.end - rec.start),
      isError: rec.err ? 1 : 0,
      status: rec.status,
      exitCode: rec.exit ?? null,
      exitInferred: rec.exitInferred === true ? 1 : 0,
      signal: rec.signal ?? null,
      timedOut: rec.timedOut === true ? 1 : 0,
      stopped: rec.stopped === true ? 1 : 0,
      denied: rec.denied === true ? 1 : 0,
      derived: rec.derived === true ? 1 : 0,
      background: rec.background === true ? 1 : 0,
      timeoutMs: rec.timeoutMs ?? null,
      sandbox: rec.sandbox ?? null,
      cmd: rec.cmd ?? null,
      cmdTruncated: rec.cmdTruncated === true ? 1 : 0,
      cmdDescription: rec.description ?? null,
      cmdCwd: rec.cwd ?? null,
      program: rec.cmd === undefined ? null : (commandProgramsOf(rec.tool, rec.cmd)[0] ?? null),
      outChars: rec.outChars ?? null,
      outTruncated: rec.outTruncated === true ? 1 : 0,
      stderr: rec.stderr === true ? 1 : 0,
    })
  }

  commandUpdate(rec: CommandStateRecord): void {
    this.batch.toolPatches.push({
      callId: rec.call ?? '',
      values: {
        resultSeq: rec.resultSeq ?? null,
        endTime: rec.end ?? null,
        durationMs: rec.end === undefined ? null : Math.max(0, rec.end - rec.start),
        isError: rec.err ? 1 : 0,
        status: rec.status,
        exitCode: rec.exit ?? null,
        exitInferred: rec.exitInferred === true ? 1 : 0,
        signal: rec.signal ?? null,
        timedOut: rec.timedOut === true ? 1 : 0,
        stopped: rec.stopped === true ? 1 : 0,
        denied: rec.denied === true ? 1 : 0,
        derived: rec.derived === true ? 1 : 0,
        background: rec.background === true ? 1 : 0,
        cmd: rec.cmd ?? null,
        cmdTruncated: rec.cmdTruncated === true ? 1 : 0,
        cmdDescription: rec.description ?? null,
        cmdCwd: rec.cwd ?? null,
        outChars: rec.outChars ?? null,
        outTruncated: rec.outTruncated === true ? 1 : 0,
        stderr: rec.stderr === true ? 1 : 0,
      },
    })
  }

  event(row: ContextEventRecord): void {
    this.batch.events.push({
      sessionId: this.sessionId,
      seq: row.seq,
      time: row.time,
      kind: row.kind,
      sub: row.sub ?? null,
      form: row.form ?? null,
      name: row.name ?? null,
      agent: row.agent ?? null,
      detail: row.detail ?? null,
      tokens: row.tokens ?? null,
      grossTokens: row.grossTokens ?? null,
      nodeCount: row.count ?? null,
      modelFrom: row.from ?? null,
      modelTo: row.to ?? null,
    })
  }

  eventUpdate(seq: number, patch: { tokens?: number; grossTokens?: number }): void {
    const values: Partial<typeof events.$inferInsert> = {}
    if (patch.tokens !== undefined) values.tokens = patch.tokens
    if (patch.grossTokens !== undefined) values.grossTokens = patch.grossTokens
    if (Object.keys(values).length > 0) this.batch.eventPatches.push({ seq, values })
  }

  fileOps(seq: number, ops: readonly FileOpRecord[]): void {
    if (ops.length === 0) return
    if (seq !== this.fileSeq) {
      this.fileSeq = seq
      this.fileOrdinal = 0
    }
    for (const op of ops) {
      const read = op.read
      const start = read !== undefined && 'start' in read ? read.start : null
      const count = read?.count ?? null
      const est = read !== undefined && 'est' in read ? 1 : 0
      this.batch.fileOps.push({
        sessionId: this.sessionId,
        seq: op.seq,
        ordinal: this.fileOrdinal++,
        time: op.time ?? null,
        kind: op.kind,
        tool: op.tool,
        path: op.path,
        isError: op.err ? 1 : 0,
        linesAdded: op.added,
        linesRemoved: op.removed,
        detail: op.detail ?? null,
        hits: op.hits ?? null,
        readStart: start,
        readCount: count,
        readEst: est,
        parentSeq: op.parent ?? null,
        program: op.program ?? null,
        isPattern: op.pattern === true ? 1 : 0,
      })
    }
  }

  skillLoad(row: SinkSkillLoad): void {
    this.batch.skillLoads.push({
      sessionId: this.sessionId,
      seq: row.seq,
      time: row.time,
      day: this.day(row.time),
      name: row.name,
      source: row.source,
    })
  }

  span(seq: number, spans: readonly TimingSpan[], nextSpanSeq: number): number {
    this.nextSpanSeq = Math.max(this.nextSpanSeq, nextSpanSeq)
    for (const span of spans) {
      this.batch.spans.push({
        sessionId: this.sessionId,
        spanSeq: this.nextSpanSeq++,
        seq,
        startTime: span.start,
        endTime: span.end,
        kind: span.kind,
      })
    }
    return this.nextSpanSeq
  }
}

function chunkRows<T extends Record<string, unknown>>(table: SQLiteTable, rows: readonly T[]): T[][] {
  const columns = Object.keys(getTableColumns(table)).length
  const size = Math.max(1, Math.floor(PARAMETER_BUDGET / Math.max(1, columns)))
  const chunks: T[][] = []
  for (let index = 0; index < rows.length; index += size) chunks.push(rows.slice(index, index + size))
  return chunks
}

function insertAll(db: Db, table: SQLiteTable, rows: readonly Record<string, unknown>[]): void {
  for (const chunk of chunkRows(table, rows)) {
    db.insert(table).values(chunk).onConflictDoNothing().run()
  }
}

export function writeBatch(db: Db, batch: RowBatch, sessionId: string): void {
  db.transaction(() => {
    insertAll(db, headerEpochs, batch.headerEpochs)
    insertAll(db, headerTools, batch.headerTools)
    insertAll(db, requests, batch.requests)
    insertAll(db, steps, batch.steps)
    insertAll(db, toolCalls, batch.toolCalls)
    insertAll(db, surfaceNodes, batch.surfaces)
    insertAll(db, systemPrompts, batch.systems)
    insertAll(db, events, batch.events)
    insertAll(db, fileOps, batch.fileOps)
    insertAll(db, skillLoads, batch.skillLoads)
    insertAll(db, timingSpans, batch.spans)
    for (const patch of batch.stepPatches) {
      db.update(steps).set(patch.values).where(and(eq(steps.sessionId, sessionId), eq(steps.seq, patch.seq))).run()
    }
    for (const patch of batch.requestPatches) {
      db.update(requests).set(patch.values).where(and(eq(requests.sessionId, sessionId), eq(requests.seq, patch.seq))).run()
    }
    for (const patch of batch.toolPatches) {
      db.update(toolCalls).set(patch.values).where(and(eq(toolCalls.sessionId, sessionId), eq(toolCalls.callId, patch.callId))).run()
    }
    for (const patch of batch.eventPatches) {
      db.update(events).set(patch.values).where(and(eq(events.sessionId, sessionId), eq(events.seq, patch.seq))).run()
    }
    for (const patch of batch.surfacePatches) {
      db.update(surfaceNodes).set(patch.values).where(and(eq(surfaceNodes.sessionId, sessionId), eq(surfaceNodes.seq, patch.seq))).run()
    }
    for (const patch of batch.systemPatches) {
      db.update(systemPrompts).set(patch.values).where(and(eq(systemPrompts.sessionId, sessionId), eq(systemPrompts.seq, patch.seq))).run()
    }
  }, { behavior: 'immediate' })
}
