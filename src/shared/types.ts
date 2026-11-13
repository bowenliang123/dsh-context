import type { ActivityState } from '../host/activity'
import type { HeadersState } from '../host/headers'
import type { TimelineState } from '../host/foldState'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    contextTimeline: ContextTimeline
    contextHeaders: ContextHeaders
    contextActivity: ContextActivity
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState
    contextHeaders: HeadersState
    contextActivity: ActivityState
  }
}

export type Category = 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

export interface SystemPromptNode {
  seq: number
  time: number
  tokens: number
}

export interface TimelineCounts {
  turns: number
  steps: number
  injects: number
  compactions: number
  prunes: number
  skills?: number
}

export interface TimelineLast {
  seq: number
  total: number
  prompt?: number
}

export interface ActivityTally {
  n: number
  last: number
}

export interface ActivityDay {
  tokens: number
  requests: number
  cost?: SessionCostUsage
  turns?: number
  toolCalls?: number
  toolsMs?: number
  wallMs?: number
  skills?: Record<string, ActivityTally>
  tools?: Record<string, ActivityTally>
  cmds?: Record<string, ActivityTally>
}

export interface ContextActivity {
  days: Record<string, ActivityDay>
}

export interface SkillInfo {
  name: string
  description: string
  path?: string
  source?: string
}

export interface FleetDescriptor {
  mode: 'one-shot' | 'continuable'
  label?: string
  provider?: string
  agentProvider?: string
  agentModel?: string
  agentReasoningEffort?: string
  persona?: string
}

export interface FleetMessage {
  seq: number
  time: number
  kind: 'relay' | 'mailbox' | 'settled'
  from?: string
  fromName?: string
  text: string
  clipped?: boolean
  summary?: string
  report?: string
  structured?: string
  diagnostic?: string
}

export interface FleetMemberInfo {
  name: string
  description: string
  provider?: string
  context?: 'fresh' | 'fork'
}

export interface FleetDelegation {
  seq: number
  time: number
  to: string
  mode: 'one-shot' | 'continuable' | 'external' | 'unknown'
  label?: string
}

export interface FleetDetail {
  descriptor?: FleetDescriptor
  initialPrompt?: string
  lastReply?: { time: number; text: string }
  roster?: FleetMemberInfo[]
  delegations?: FleetDelegation[]
  messages: FleetMessage[]
  messagesTotal?: number
  truncated: boolean
}

export interface FleetSummaryMember {
  id: string
  createdAt?: number
  mode?: 'one-shot' | 'continuable' | 'external' | 'unknown'
  label?: string
  name?: string
  description?: string
  phase?: string
}

export interface FleetDetailCounts {
  readAt: number
  messagesTotal: number
  delegationsCount: number
}

export interface FleetSummary {
  rootId: string
  rootCreatedAt?: number
  detail: FleetDetail
  members: FleetSummaryMember[]
  familySize: number
  counts: Record<string, FleetDetailCounts>
}

export interface FleetBatchRequest {
  ids: string[]
  mode: 'preview' | 'history'
  rootId?: string
}

export interface FleetBatchValue {
  rows: Record<string, FleetDetail>
  missing: string[]
  total: number
}

export type DefaultGranularity = 'step' | 'turn'

export type DefaultTrendMode = 'total' | 'delta'

export type DefaultDeltaBase = 'step' | 'turn'

export type DefaultFileSort = 'count' | 'lines' | 'latest' | 'path' | 'name'

export type DefaultToolSort = 'size' | 'count' | 'name'

export type DefaultPlacement = 'all' | 'tab' | 'sidebar' | 'hide'

export type InsightsEntry = 'show' | 'hide'

export type DefaultDurationCurve = 'show' | 'hide'

export type OverviewAutoSteps = 'off' | '100' | '200' | '300'

export type DefaultOverviewRange = 'today' | '7d' | '30d'

export type FleetTab = 'show' | 'hide'

export interface PluginSettings {
  defaultPlacement: DefaultPlacement
  defaultGranularity: DefaultGranularity
  defaultTrendMode: DefaultTrendMode
  defaultDeltaBase: DefaultDeltaBase
  defaultToolSort: DefaultToolSort
  defaultFileSort: DefaultFileSort
  insightsEntry: InsightsEntry
  defaultDurationCurve: DefaultDurationCurve
  overviewAutoSteps: OverviewAutoSteps
  defaultOverviewRange: DefaultOverviewRange
  fleetTab: FleetTab
  promptPrefix: string
  promptSuffix: string
}

export type SettingsField = keyof PluginSettings

export interface SurfaceNodeWindow {
  nodes: SurfaceNode[]
  droppedNodes: number
  archive: SurfaceNode[]
  surfaceFloor?: number
  archiveFloor?: number
}

export interface Snapshot extends SurfaceNodeWindow {
  ok: boolean
  unsupported?: {
    current: string
    minimum: string
  }
  model?: string
  provider?: string
  reasoningEffort?: string
  contextWindow?: number
  maxOutputTokens?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    skill: number
    assistant: number
    assistantReasoning?: number
    assistantAnswerTokens?: number
    assistantCallTokens?: number
    tool: number
    total: number
  }
  images?: number
  generatedReasoning?: number
  generatedAnswerTokens?: number
  generatedCallTokens?: number
  toolCalls?: number
  toolTally?: Record<string, number>
  programTally?: Record<string, number>
  humanInputs?: number
  answers?: number
  lastUser?: string
  counts?: TimelineCounts
  last?: TimelineLast
  detailRev?: number
  requests: RequestRecord[]
  events: ContextEventRecord[]
  cost?: SessionCostUsage
  timing?: TimingTotals
  systems?: SystemPromptNode[]
  fileOps?: FileOpRecord[]
  fileOpsFloor?: number
  commands?: CommandRecord[]
  commandsFloor?: number
  commandStats?: CommandStats
  spans?: TimingSpan[]
  costRead?: SessionCostRead
}

export interface CostPriceRate {
  hit: number
  miss: number
  write: number
  out: number
}

export type CostConfidence = 'high' | 'medium' | 'low'

export interface CostPriceFace {
  provider: string
  model: string
  rate: CostPriceRate
  via: string
  confidence: CostConfidence
  canonical?: string
}

export interface CostPriceMiss {
  provider: string
  model: string
  reason: string
  candidates?: number
}

export interface SessionCostRead {
  usd: number | null
  ready: boolean
  faces?: CostPriceFace[]
  misses?: CostPriceMiss[]
}

export interface ContextTimelineDetail extends SurfaceNodeWindow {
  rev: number
  head?: ContextTimeline
  requests: RequestRecord[]
  events: ContextEventRecord[]
  fileOps?: FileOpRecord[]
  fileOpsFloor?: number
  commands?: CommandRecord[]
  commandsFloor?: number
  commandStats?: CommandStats
  spans?: TimingSpan[]
}

export type CommandStatus = 'running' | 'completed' | 'failed' | 'killed'

export interface CommandPage {
  commands: CommandRecord[]
  atStart: boolean
  total: number
}

export interface CommandRecord {
  seq: number
  resultSeq?: number
  time: number
  tool: string
  cmd?: string
  cmdTruncated?: true
  description?: string
  cwd?: string
  timeoutMs?: number
  background?: true
  sandbox?: string
  codeMode?: true
  parent?: number
  turn?: number
  step?: number
  start: number
  end?: number
  status: CommandStatus
  exit?: number
  exitInferred?: true
  signal?: string
  timedOut?: true
  stopped?: true
  denied?: true
  err: boolean
  outChars?: number
  outTruncated?: true
  stderr?: true
  derived?: true
  gone?: number
}

export interface CommandStats {
  runs: number
  failed: number
  ms: number
  bg: number
}

export interface FileOpRecord {
  seq: number
  path: string
  kind: 'read' | 'write' | 'search'
  tool: string
  time?: number
  err: boolean
  added: number
  removed: number
  detail?: string
  hits?: number
  read?: { start: number; count: number } | { count: number; est: true }
  parent?: number
  program?: string
  pattern?: true
  gone?: number
}

export type ContextTimeline = Snapshot

export interface ContextPressure {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface TimingSpan {
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other'
  start: number
  end: number
}

export interface CostBucketTotals {
  uncached: number
  cacheRead: number
  cacheWrite: number
  output: number
}

export interface ToolTimingTotals {
  calls: number
  ms: number
}

export interface TimingTotals {
  wallMs: number
  ttftMs: number
  genMs: number
  reasoningMs?: number
  reasoningBlocks?: number
  textMs?: number
  textBlocks?: number
  toolArgMs?: number
  toolArgBlocks?: number
  speedTokens?: number
  speedMs?: number
  calls: number
  toolsMs: number
  toolBusyMs?: number
  idleMs?: number
  toolCalls: number
  tools: Record<string, ToolTimingTotals>
}

export interface CostModelUsage {
  peak?: CostBucketTotals
  off?: CostBucketTotals
}

export interface SessionCostUsage {
  [provider: string]: { [model: string]: CostModelUsage }
}

export interface SurfaceNode {
  seq: number
  time?: number
  cat: Category
  tokens: number
  reasoning?: number
  answerTokens?: number
  callTokens?: number
  imgs?: number
  gone?: number
  form?: string
  name?: string
  text?: string
  tool?: string
  err?: boolean
  skill?: string
  calls?: string[]
  agent?: string
}

export interface SlimRequestRecord {
  turn?: number
  step?: number
  time: number
  seq: number
  total: number
  prompt?: number
  activeMs?: number
}

export interface RequestRecord extends SlimRequestRecord {
  system: number
  tools: number
  user: number
  inject: number
  assistant: number
  tool: number
  skill?: number
  cacheRead?: number
  output?: number
  stepCount?: number
  net?: number
}

export interface ContextEventRecord {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode'
  form?: string
  tokens?: number
  grossTokens?: number
  count?: number
  sub?: string
  name?: string
  agent?: string
  detail?: string
  from?: string
  to?: string
  fromTurn?: number
  fromStep?: number
  turn?: number
  step?: number
}

export const UNKNOWN_TOOL_SOURCE = '<unknown-plugin>'

export interface HeaderTool {
  name: string
  tokens: number
  plugin?: string
}

export interface HeaderRecord {
  seq: number
  time: number
  systemTokens?: number
  tools: HeaderTool[]
}

export interface ContextHeaders {
  headers: HeaderRecord[]
}

export interface HeaderEpochContent {
  system?: string
  tools: Array<{
    name: string
    description?: string
    schema?: unknown
  }>
}

export interface PlatformBalanceEntry {
  currency: string
  total: number
  granted: number
  toppedUp: number
}

export interface PlatformBalance {
  isAvailable: boolean
  balances: PlatformBalanceEntry[]
}

export interface BackfillCoverage {
  complete: boolean
  remaining: number
  failed: number
  running: boolean
  total: number
  covered: number
  unsupported: number
}

export type OverviewPart = 'summary' | 'days' | 'page' | 'tally'

export type OverviewCoverage = 'all' | 'active' | 'archived'

export type OverviewSort = 'recent' | 'tokens' | 'context'

export type OverviewTallyField = 'skills' | 'tools' | 'cmds'

export type OverviewRange = 'today' | '7d' | '30d' | { start: number; end: number }

export interface OverviewScope {
  range?: OverviewRange
  day?: string | null
  coverage?: OverviewCoverage
  group?: string | null
  query?: string
}

export interface OverviewPick {
  field: OverviewTallyField
  name: string
}

export interface OverviewRequest {
  part: OverviewPart
  revision?: string | null
  scope?: OverviewScope
  sort?: OverviewSort
  page?: number
  tally?: OverviewTallyField
  pick?: OverviewPick | null
}

export interface OverviewPartTotal {
  key: string
  value: number
}

export interface OverviewTimingWindow {
  calls: number
  toolCalls: number
  toolsMs: number
  wallMs: number
}

export interface OverviewSummary {
  sessions: number
  sessionsTotal: number
  sessionsArchived: number
  archivedScoped: number
  tokens: number
  turns: number
  costUsd: number | null
  costSessions: number
  usageSessions: number
  cacheHit: string | null
  tokenParts: OverviewPartTotal[] | null
  timing: TimingTotals | null
  windowTiming: OverviewTimingWindow
  coverage: BackfillCoverage
}

export interface OverviewDay {
  key: string
  tokens: number
  sessions: number
  costUsd: number | null
}

export interface OverviewPageRow {
  id: string
  title: string
  cwd?: string
  updatedAt: number
  running: boolean
  archived: boolean
  group?: string
  tokens: number
  turns: number
  steps?: number
  parts: OverviewPartTotal[]
  total: number
  contextWindow?: number
  maxOutputTokens?: number
  model?: string
  lastUser?: string
  costUsd: number | null
  createdDay?: string
}

export interface OverviewGroupCount {
  key: string
  count: number
}

export interface OverviewPage {
  items: OverviewPageRow[]
  index: number
  count: number
  total: number
  scopeTotal: number
  groups: OverviewGroupCount[]
}

export interface OverviewTallyStat {
  name: string
  n: number
  sessions: number
  last: number
}

export interface OverviewTally {
  field: OverviewTallyField
  stats: OverviewTallyStat[]
}

export interface OverviewUnchanged {
  revision: string
  unchanged: true
}

export interface OverviewSummaryValue {
  revision: string
  pricingReady: boolean
  summary: OverviewSummary
}

export interface OverviewDaysValue {
  revision: string
  pricingReady: boolean
  days: OverviewDay[]
}

export interface OverviewPageValue {
  revision: string
  pricingReady: boolean
  page: OverviewPage
}

export interface OverviewTallyValue {
  revision: string
  pricingReady: boolean
  tally: OverviewTally
}

export type OverviewValue = OverviewUnchanged | OverviewSummaryValue | OverviewDaysValue | OverviewPageValue | OverviewTallyValue
