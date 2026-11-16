import type { ContextEventRecord, FileOpRecord, SurfaceNode, TimingSpan } from '../../shared/types'
import type { CommandStateRecord } from '../foldState'

export interface SinkHeaderTool {
  name: string
  tokens: number
  plugin?: string
}

export interface SinkHeader {
  seq: number
  time: number
  reason?: string
  tools: SinkHeaderTool[]
}

export interface SinkRequest {
  seq: number
  time: number
  day: string
  turn?: number
  step?: number
  startsTurn: boolean
  inherited: boolean
  system: number
  tools: number
  user: number
  inject: number
  skill: number
  assistant: number
  tool: number
  total: number
  model?: string
  provider?: string
  period?: 'peak' | 'off'
  prompt?: number
  input?: number
  cacheRead?: number
  cacheWrite?: number
  output?: number
  reasoning?: number
  genMs?: number
}

export interface SinkStepStart {
  seq: number
  time: number
  turn?: number
  step?: number
  day: string
  beatsFull: boolean
}

export interface SinkStepEnd {
  seq: number
  endTime: number
  wallMs: number
  activeMs: number
  waitMs: number
  idleMs: number
  toolBusyMs: number
  ttftMs?: number
  beatsFull: boolean
}

export interface SinkToolCall {
  seq: number
  time: number
  callId: string
  name: string
  turn?: number
  step?: number
  day: string
  codeMode: boolean
  parentSeq?: number
  transport: boolean
}

export interface SinkToolPatch {
  resultSeq?: number
  endTime?: number
  durationMs?: number
  isError?: boolean
  status?: string
  exitCode?: number
  exitInferred?: boolean
  signal?: string
  timedOut?: boolean
  stopped?: boolean
  denied?: boolean
  derived?: boolean
  background?: boolean
  outChars?: number
  outTruncated?: boolean
  stderr?: boolean
  startTime?: number
  transport?: boolean
}

export interface SinkSkillLoad {
  seq: number
  time: number
  name: string
  source: 'invocation' | 'result' | 'dispatch'
}

export interface FoldSink {
  header(row: SinkHeader): void
  system(row: { seq: number; time: number; tokens: number }): void
  systemGone(seq: number, goneSeq: number): void
  surface(node: SurfaceNode): void
  surfaceGone(seq: number, goneSeq: number): void
  request(row: SinkRequest): void
  requestActive(seq: number, activeMs: number): void
  stepStart(row: SinkStepStart): void
  stepRequest(seq: number, requestSeq: number): void
  stepEnd(row: SinkStepEnd): void
  toolCall(row: SinkToolCall): void
  toolCallUpdate(callId: string, patch: SinkToolPatch): void
  command(rec: CommandStateRecord): void
  commandUpdate(rec: CommandStateRecord): void
  event(row: ContextEventRecord): void
  eventUpdate(seq: number, patch: { tokens?: number; grossTokens?: number }): void
  fileOps(seq: number, ops: readonly FileOpRecord[]): void
  skillLoad(row: SinkSkillLoad): void
  span(seq: number, spans: readonly TimingSpan[], nextSpanSeq: number): number
}
