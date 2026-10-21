/** Shared wire contract: the `view()` payloads of the `contextTimeline` / `contextHeaders` /
 * `contextActivity` session projections. */

import type { ActivityState } from '../host/activity'
import type { HeadersState } from '../host/headers'
import type { TimelineState } from '../host/foldState'
// The registry package ROOT carries the Context augmentation; the `/types` subpath only declares the merge-extensible maps.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Slim head on the split generation, inline value on channel-less hosts; key absence = no host half. */
    contextTimeline: ContextTimeline
    /** Epoch metadata in its own unit so the hot timeline stays lean; key absence = an older host (tokens only). */
    contextHeaders: ContextHeaders
    /** The per-day activity ledger; key absence = an older host (empty heatmap). */
    contextActivity: ContextActivity
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState
    contextHeaders: HeadersState
    contextActivity: ActivityState
  }
}

/** `skill` is the harness-injected skill machinery: the `<available_skills>` digest, a `/name` invocation's instructions, and a
 * `skill`-tool load. */
export type Category = 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

/** Its TEXT comes from the `system/message` event at `seq`; the effective figure is the LAST node with `tokens > 0`. */
export interface SystemPromptNode {
  seq: number
  time: number
  tokens: number
}

/** Counts over the RETAINED records; `steps` is the retained request-record count. */
export interface TimelineCounts {
  turns: number
  steps: number
  injects: number
  compactions: number
  prunes: number
  /** Distinct names among the retained events tagged `sub: 'skill'`; the digest has none and never counts. Absent = 0. */
  skills?: number
}

/** The newest retained request record's billing summary. */
export interface TimelineLast {
  seq: number
  total: number
  prompt?: number
}

export interface ActivityDay {
  /** Billed tokens that day (input + cache read/write + output); a settlement-less request counts only toward `requests`. */
  tokens: number
  /** Completed model calls (assistant settlements) that day. */
  requests: number
  /** Keyed provider → model → pricing period, scoped to the day the requests INITIATED. Absent = tokens-only bars. */
  cost?: SessionCostUsage
  /** Turns whose FIRST settlement landed on this (step-initiation) day. */
  turns?: number
  /** Completed tool runs whose step STARTED that day. */
  toolCalls?: number
  /** Summed tool-run durations for those runs, in ms. */
  toolsMs?: number
  /** Summed wall time of steps that ENDED, charged to the day their step STARTED, in ms. */
  wallMs?: number
  /** Skill name → `{ n: loads, last: last-load instant in epoch ms }`; absent = an empty day. */
  skills?: Record<string, { n: number; last: number }>
}

/** Host-local day key (`YYYY-MM-DD`, shared/days.ts) → that day's billed volume; the Insights page merges every listed ledger. */
export interface ContextActivity {
  days: Record<string, ActivityDay>
}

/** Served by `/api/dsh-context/skills` (host/skills.ts); every field but `name` is best-effort. */
export interface SkillInfo {
  /** Kebab-case identifier — the join key onto `ActivityDay.skills`. */
  name: string
  description: string
  /** Absolute instruction file path, when the provider is filesystem-backed. */
  path?: string
  /** Discovery source bucket ('project-agents', 'user-dsh', 'bundled', …). */
  source?: string
}

export interface FleetDescriptor {
  mode: 'one-shot' | 'continuable'
  label?: string
  /** The `ctx.subagents` provider name that established the child ('spawn' / 'fork' / …). */
  provider?: string
  agentProvider?: string
  agentModel?: string
  agentReasoningEffort?: string
  persona?: string
}

/** One inter-agent message lifted from a session log (team relay, historical mailbox delivery, or runtime settle record). */
export interface FleetMessage {
  seq: number
  /** Event instant (epoch ms). */
  time: number
  kind: 'relay' | 'mailbox' | 'settled'
  /** Sender session id, when the source attests one. */
  from?: string
  /** The sender NAME (historical mailbox attestation, or the Team relay's framing line). */
  fromName?: string
  /** Text excerpt, already capped by the route. */
  text: string
  /** True when a cap cut this message: a `full: true` read lifts it. */
  clipped?: boolean
  /** `settled` only: the runtime's one-line settlement summary. */
  summary?: string
  /** `settled` only: the child's closing report, split out of the notice. */
  report?: string
  /** `settled` only: the structured result the notice printed, when it carried one. */
  structured?: string
  /** `settled` only: the provider diagnostic that followed the notice. */
  diagnostic?: string
}

/** One roster fact lifted from a lead session's durable `team/member` records; the projection strips
 * these fields, so the Fleet detail route serves them for the member cards. */
export interface FleetMemberInfo {
  name: string
  description: string
  provider?: string
  context?: 'fresh' | 'fork'
}

/** The Fleet detail route's per-session payload (`/api/dsh-context/fleet`); a LEAD session additionally serves its roster facts. */
export interface FleetDetail {
  descriptor?: FleetDescriptor
  /** The first non-injection user message — a child's delegation briefing, a root's first human prompt. */
  initialPrompt?: string
  /** The newest assistant text — the agent's latest report-back. */
  lastReply?: { time: number; text: string }
  /** Roster facts off `team/member` records (lead logs only), keyed by member name. */
  roster?: FleetMemberInfo[]
  /** Newest-first inter-agent messages found in this session's log. */
  messages: FleetMessage[]
  /** Every inter-agent message found before the excerpt cap; absent when nothing was hidden. */
  messagesTotal?: number
  /** True when the route's caps cut the message list or a text. */
  truncated: boolean
}

/** The ONE declaration shared by the Host Config schema (host/config.ts) and the Client's settings form. */
export type DefaultGranularity = 'step' | 'turn'

export type DefaultTrendMode = 'total' | 'delta'

/** The browser delta baseline: the immediately preceding record, or the previous turn's last step. */
export type DefaultDeltaBase = 'step' | 'turn'

export type DefaultFileSort = 'count' | 'lines' | 'latest' | 'path' | 'name'

export type DefaultToolSort = 'size' | 'count' | 'name'

/** Where the Context panel mounts; 'hide' registers no surface. */
export type DefaultPlacement = 'all' | 'tab' | 'sidebar' | 'hide'

export type InsightsEntry = 'show' | 'hide'

export type DefaultDurationCurve = 'show' | 'hide'

/** Retained-step count at which the trend turns its Overview ribbon on; 'off' never auto-switches. */
export type OverviewAutoSteps = 'off' | '100' | '200' | '300'

/** The Insights page's rolling preset; a calendar-picked range replaces it for that visit only. */
export type DefaultOverviewRange = 'today' | '7d' | '30d' | 'all'

export type FleetTab = 'show' | 'hide'

/** The display currency of every money figure; `auto` follows the UI language (zh → CNY, else USD). */
export type DisplayCurrency = 'auto' | 'cny' | 'usd'

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
  displayCurrency: DisplayCurrency
  /** Free text joined ahead of the harness's assembled system prompt; empty disables. */
  promptPrefix: string
  /** Free text joined behind the harness's assembled system prompt; empty disables. */
  promptSuffix: string
}

export type SettingsField = keyof PluginSettings

export interface Snapshot {
  ok: boolean
  /** Present ONLY below the supported baseline: the host folds nothing (all figures zero) and the client shows the upgrade gate. */
  unsupported?: {
    current: string
    minimum: string
  }
  model?: string
  provider?: string
  /** The newest request envelope's materialized reasoning effort. Absent = no effort in force, or a row folded before the field
   * existed. */
  reasoningEffort?: string
  contextWindow?: number
  /** The newest request envelope's routed output cap (auto-compaction reserves it). Absent = no cap in the log, or a row folded before
   * the field existed. */
  maxOutputTokens?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    skill: number
    assistant: number
    tool: number
    total: number
  }
  /** Image blocks in the CURRENT context (uploads plus nested tool-result images). Absent = 0. */
  images?: number
  /** Tool calls whose result is live (a `skill`-tool node keeps counting). Absent = 0. */
  toolCalls?: number
  /** Whole-session tally of non-injection `user/message` plus answered `ask_user_question` over the COMPLETE log. Absent = 0. */
  humanInputs?: number
  /** Whole-session replies: one per assistant message carrying non-blank text (tool-only steps are not replies). Absent = 0. */
  answers?: number
  /** The newest own message as a one-line preview (first text block, whitespace collapsed, 80 chars max). Absent = hidden. */
  lastUser?: string
  /** Split-generation head fields: present exactly when the host serves the slim head; `detailRev` bumps whenever the detail collections
   * change. */
  counts?: TimelineCounts
  last?: TimelineLast
  detailRev?: number
  /** The slim head serves these EMPTY (collections ride the detail channel): the client swaps in the detail payload's. */
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /** Cumulative session-cost raw material; absent until a request with a known model reports usage. */
  cost?: SessionCostUsage
  /** Whole-session timing totals; absent until the first step lifecycle completes. */
  timing?: TimingTotals
  /** The live system-prompt nodes, oldest first. Absent on rows folded before the field existed: the client then reads the header epoch's
   * `systemTokens`. */
  systems?: SystemPromptNode[]
  /** The served live surface: the newest `maxNodes` tail PLUS every older live inject/skill node (they land first and are pinned).
   * Seq-ordered, oldest first. */
  nodes: SurfaceNode[]
  /** Live nodes not served: the overflow beyond `maxNodes` minus the pinned inject/skill nodes. */
  droppedNodes: number
  /** Recently REMOVED surface nodes stamped with `gone` (the replacing event's seq); a node belongs to request R when `seq < R.seq &&
   * (gone undefined || gone > R.seq)`. */
  archive: SurfaceNode[]
  /** Newest seq among the `droppedNodes` nodes not served; present only when droppedNodes > 0. */
  surfaceFloor?: number
  /** Newest `gone` among retention-dropped archive entries; steps below it may miss removed nodes. */
  archiveFloor?: number
  /** The fold-derived file-op log and trim floor: INLINE value and detail payload only, never the slim head. */
  fileOps?: FileOpRecord[]
  fileOpsFloor?: number
  /** The fold-derived command log and its trim floor/coverage honesty, same channel as `fileOps`. */
  commands?: CommandRecord[]
  commandsFloor?: number
  /** Whole-log execution tallies behind the command panel's title; survives list trimming. */
  commandStats?: CommandStats
  /** INLINE value and detail payload only; absent on rows folded before the collection existed. */
  spans?: TimingSpan[]
}

/** The split generation's DETAIL payload (host/detail.ts); `rev` mirrors the head's `detailRev` and is the client's latest-wins cursor. */
export interface ContextTimelineDetail {
  rev: number
  /** The slim head at the SAME fold cut; a cold-listed session has no `contextTimeline` row, so the Agent network ring reads this. */
  head?: ContextTimeline
  requests: RequestRecord[]
  events: ContextEventRecord[]
  nodes: SurfaceNode[]
  droppedNodes: number
  archive: SurfaceNode[]
  surfaceFloor?: number
  archiveFloor?: number
  /** The file-op log (shared/fileOps.ts) over the FULL log; Code-Mode nested dispatches book on their parent `run_code` result. */
  fileOps?: FileOpRecord[]
  /** The newest dropped op's seq when the op log trimmed (coverage honesty, same family as `archiveFloor`). */
  fileOpsFloor?: number
  /** The command log (shared/commands.ts); nested Code-Mode dispatches flush on their parent `run_code` result. */
  commands?: CommandRecord[]
  /** The newest dropped record's seq when the command log trimmed. */
  commandsFloor?: number
  commandStats?: CommandStats
  /** The completed steps' time slices in log order, positioned by their real instants. Absent = no strip. */
  spans?: TimingSpan[]
}

export type CommandStatus = 'running' | 'completed' | 'failed' | 'killed'

/** One shell/code execution, folded from `tool/call` (creation) paired with `tool/result` and — on hosts that log them —
 * `job/registered` / `job/settled` (precise timing and outcome). Without job events the timing/exit are envelope-derived
 * (`derived: true`). Nested Code-Mode dispatches carry `parent` (their run_code result's seq, the locate target).
 * `gone` is client-joined, not host-stamped. */
export interface CommandRecord {
  /** The call event's seq — the record's stable identity. */
  seq: number
  /** The result event's seq — the surface node a reveal targets. Absent while running and on nested Code-Mode records
   * (those reveal on `parent`). */
  resultSeq?: number
  /** The call event's instant — the list's chronological anchor. */
  time: number
  tool: string
  /** The command text (a run_code record carries the program's source), capped at the fold's maxCommandChars. */
  cmd: string
  cmdTruncated?: true
  /** The model-authored intent (bash/pwsh require it; persistent shells and run_code may omit it). */
  description?: string
  /** The result meta's cwd when logged, else the workdir argument; absent = the session's cwd. */
  cwd?: string
  timeoutMs?: number
  /** Dispatched to the background (an acked result with no outcome yet shows running until a `job/settled` lands). */
  background?: true
  /** The requested sandbox escalation, when the call carried one. */
  sandbox?: string
  /** A nested Code-Mode dispatch record. */
  codeMode?: true
  parent?: number
  turn?: number
  step?: number
  /** job.startedAt when registered, else the call instant. */
  start: number
  /** job.finishedAt when settled, else the result instant; absent while running. */
  end?: number
  status: CommandStatus
  /** Explicit exit code from a marker or job detail; absent = unknown (never fabricate a 0). */
  exit?: number
  /** The exit 0 was inferred from the ABSENCE of any marker (the shell tools omit the marker on a clean exit). */
  exitInferred?: true
  signal?: string
  timedOut?: true
  stopped?: true
  denied?: true
  /** The result message's isError (an infrastructure failure, not a command failure). */
  err: boolean
  outChars?: number
  outTruncated?: true
  stderr?: true
  /** Timing/exit derive from event envelopes — no job events on this log (parallel calls can overstate durations). */
  derived?: true
  gone?: number
}

/** Whole-log execution tallies, maintained incrementally: `runs`/`failed`/`ms` at each record's terminal transition,
 * `bg` when a background dispatch becomes known (the argument at creation, else the hand-off ack). */
export interface CommandStats {
  runs: number
  /** Failed OR killed terminal outcomes. */
  failed: number
  /** Summed execution ms over records with both endpoints known (concurrent runs double-count wall time). */
  ms: number
  /** Runs dispatched to the background, whether or not they ever settle. */
  bg: number
}

/** Folded from the durable tool lifecycle (`tool/call` + `tool/result`, or a nested `tool/ptc-dispatch`); line deltas are estimates off
 * the call ARGUMENTS. `gone` is client-joined, not host-stamped. */
export interface FileOpRecord {
  seq: number
  /** The op's file; for a pathless search the searched PATTERN (`pattern: true`). */
  path: string
  kind: 'read' | 'write' | 'search'
  tool: string
  time?: number
  err: boolean
  added: number
  removed: number
  /** The searched pattern, with the include filter when one narrowed the call. */
  detail?: string
  /** Meta-attributed search op only: matched lines the result reported for this file. */
  hits?: number
  /** Read ops only: the exact 1-based window the result meta reported, else the `limit`-argument estimate (`est: true`). */
  read?: { start: number; count: number } | { count: number; est: true }
  /** Nested Code-Mode op only: the run_code result node the op ran under (the locate target). */
  parent?: number
  /** Nested Code-Mode op only: the run_code program's model-authored description. */
  program?: string
  /** The searched-pattern marker: `path` is a pattern, not a file — display must not relativize it. */
  pattern?: true
  /** Client-joined archive stamp (see the type note); absent on the wire. */
  gone?: number
}

/** The `contextTimeline` projection's whole value; `ok` is always `true` here (kept for wire compatibility). */
export type ContextTimeline = Snapshot

/** The official token-meter `contextPressure` projection: provider-anchored occupancy of the NEXT request. Absent = not composed (the
 * client uses its derived anchor). */
export interface ContextPressure {
  /** Provider-reported prompt size of the most recent request (input + cache). */
  pressureTokens?: number
  /** `pressureTokens` + heuristic surface movement since the sample, clamped ≥ 0. */
  projectedTokens?: number
  contextWindow?: number
}

/** The official token-meter `contextBreakdown`: read directly so the card's counts stay identical to the panel's; `messageTokens` splits
 * into the five message-bearing categories. Absent = an older harness. */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** The official token-meter `tokenUsage`: durable cumulative usage across the COMPLETE log; the four buckets are disjoint (reasoning sits
 * inside `outputTokens`). */
export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One painted span of the timing strip (TTFT wait, decode block, tool-run window, or residue gap); `start`/`end` are REAL instants,
 * packed gapless in log order, and `end` > `start` always. */
export interface TimingSpan {
  /** The timing card's own slice vocabulary (same keys, same colors). */
  kind: 'ttft' | 'reasoning' | 'text' | 'toolarg' | 'tools' | 'other'
  start: number
  end: number
}

/** One pricing bucket's cumulative billed tokens: a running total over the COMPLETE session log, never trimmed. */
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

/** Whole-session totals over the COMPLETE log: `wallMs` whole steps, `ttftMs` step-start → decode-start, `genMs`
 * decode-start → assistant-message, `toolsMs` per-call. The decode window opens at the first OBSERVABLE instant, so
 * marker-tiled windows never double-count; speed* keep the first-token anchor; `calls`/`toolCalls` count messages/pairs. */
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
  toolCalls: number
  /** Per-tool-name tallies behind the timing card's ranking (bounded). */
  tools: Record<string, ToolTimingTotals>
}

/** One billed model's totals split by pricing period: period-less providers book everything under `peak`; DeepSeek's `peak` prices at
 * twice the list (off-peak) rate, `off` at list. */
export interface CostModelUsage {
  peak?: CostBucketTotals
  off?: CostBucketTotals
}

/** Cumulative provider-reported billed tokens keyed by the request envelope's DSH provider id ('' when none) then model id — the faces
 * the Client's models.dev price book resolves. */
export interface SessionCostUsage {
  [provider: string]: { [model: string]: CostModelUsage }
}

export interface SurfaceNode {
  seq: number
  time?: number
  cat: Category
  tokens: number
  /** Image blocks inside this node's message (absent when zero). */
  imgs?: number
  /** Set only on `archive` entries: the seq of the replacement event that shadowed this node. */
  gone?: number
  form?: string
  /** The producer identity the matching inject event names (host pricing.ts `injectionSourceName`); absent when unreadable or predating
   * the stamp. */
  name?: string
  text?: string
  tool?: string
  err?: boolean
  skill?: string
  calls?: string[]
}

/** One answered model call (a step); consecutive records of one turn form it. */
export interface RequestRecord {
  turn?: number
  step?: number
  time: number
  seq: number
  system: number
  tools: number
  user: number
  inject: number
  assistant: number
  tool: number
  total: number
  prompt?: number
  /** Skill-machinery tokens of this request; absent on rows folded before the category existed (read as 0). */
  skill?: number
  /** Billed cache-read (served) prompt tokens — the hit-rate numerator against `prompt`; absent on older hosts, and zero is a real value.
   */
  cacheRead?: number
  output?: number
  /** The step's ACTIVE ms (`step/start` → `step/end` minus in-step user waits), stamped at `step/end`; absent while the step is open. */
  activeMs?: number
  /** Turn-mode aggregate marker, set by the Client's aggregateByTurn (the Host never sets it). */
  stepCount?: number
  /** Delta-mode signed net change, set by the Client's deltaOf (the Host never sets it). */
  net?: number
}

export interface ContextEventRecord {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model' | 'mode'
  form?: string
  tokens?: number
  count?: number
  sub?: string
  name?: string
  detail?: string
  from?: string
  to?: string
  /** Turn/step of the request logged right BEFORE the event (host-stamped). */
  fromTurn?: number
  fromStep?: number
  /** Turn/step of the request this event contributed to (host-stamped). */
  turn?: number
  step?: number
}

/** Sentinel `HeaderTool.plugin` value: the provider could not be attributed (already registered before the attribution hook installed);
 * no real plugin name collides. */
export const UNKNOWN_TOOL_SOURCE = '<unknown-plugin>'

export interface HeaderTool {
  name: string
  tokens: number
  /** The registering plugin's label: `mcp:<server>` for MCP tools, or the pinned first-party map; `UNKNOWN_TOOL_SOURCE` marks a boot-time
   * tool, absent = no tag. */
  plugin?: string
}

/** One request-header epoch's METADATA, in force from this seq until the next. CONTENT is deliberately not projected (every list row
 * would carry it) and is fetched as a {@link HeaderEpochContent}. */
export interface HeaderRecord {
  seq: number
  time: number
  /** The epoch's estimated system-prompt tokens; absent when it logged no system prompt. */
  systemTokens?: number
  tools: HeaderTool[]
}

/** The `contextHeaders` projection value: the bounded epoch list (newest last). */
export interface ContextHeaders {
  headers: HeaderRecord[]
}

/** The fetched CONTENT of one header epoch, mapped client-side off the raw durable event (historyPage.ts); tool identity joins the
 * metadata by `name`. */
export interface HeaderEpochContent {
  system?: string
  tools: Array<{
    name: string
    description?: string
    schema?: unknown
  }>
}

export interface PlatformBalanceEntry {
  /** The ISO code the platform reported (`CNY` / `USD`). */
  currency: string
  /** `granted` + `toppedUp`, derived rather than read from the platform's `total_balance`, which rounds independently of its parts. */
  total: number
  granted: number
  toppedUp: number
}

/** The DeepSeek open-platform balance, served by `/api/dsh-context/balance`; `null` on the wire (nothing rendered) when unconfigured or
 * the read fails. */
export interface PlatformBalance {
  isAvailable: boolean
  /** One entry per currency the account holds; at least one. */
  balances: PlatformBalanceEntry[]
}
