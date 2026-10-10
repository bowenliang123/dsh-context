/** Shared wire contract — the snapshot model exchanged between the Host and Client halves: the
 * `view()` payloads of the `contextTimeline` / `contextHeaders` / `contextActivity` session projections. */

import type { ActivityState } from '../host/activity'
import type { HeadersState } from '../host/headers'
import type { TimelineState } from '../host/foldState'
// The registry package ROOT carries the `@deepseek-ai/cordis` Context augmentation
// (`sessionProjections` service); the `/types` subpath only declares the merge-extensible maps.
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** The plugin's timeline: slim head on the split generation, inline value on channel-less
     * hosts; key absence = the host half is not composed. */
    contextTimeline: ContextTimeline
    /** Request-header content epochs — a separate unit so the hot timeline value stays lean;
     * key absence = an older host (tokens only). */
    contextHeaders: ContextHeaders
    /** The per-day activity ledger behind the Context Insights heatmap; key absence = an older host (empty heatmap). */
    contextActivity: ContextActivity
  }
  interface SessionProjectionStateMap {
    contextTimeline: TimelineState
    contextHeaders: HeadersState
    contextActivity: ActivityState
  }
}

/** The priced surface buckets. `skill` carries the skill-machinery content the harness injects:
 * the `<available_skills>` digest, a `/name` invocation's instructions, and a `skill`-tool load. */
export type Category = 'user' | 'inject' | 'skill' | 'assistant' | 'tool'

/** One live system-prompt node; the harness models the prompt as a surface node, so its TEXT is
 * fetched from the `system/message` event at `seq`. The effective figure is the LAST node with `tokens > 0`. */
export interface SystemPromptNode {
  seq: number
  time: number
  tokens: number
}

/** Counts precomputed over the RETAINED request/event records; `steps` is the retained request-record count. */
export interface TimelineCounts {
  turns: number
  steps: number
  injects: number
  compactions: number
  prunes: number
  /** Distinct names among the retained events tagged `sub: 'skill'`; the `<available_skills>`
   * digest has no name and never counts. Absent = 0. */
  skills?: number
}

/** The newest retained request record's billing summary. */
export interface TimelineLast {
  seq: number
  total: number
  prompt?: number
}

export interface ActivityDay {
  /** Billed tokens from provider-reported usage that day (input + cache read/write + output); a
   * settlement-less request counts only toward `requests`. */
  tokens: number
  /** Completed model calls (assistant settlements) that day. */
  requests: number
  /** The day's billed buckets keyed provider → model → pricing period, scoped to the day the
   * requests INITIATED in. Absent = tokens-only bars. */
  cost?: SessionCostUsage
  /** Skill name → `{ n: loads, last: last-load instant in epoch ms }`; absent = an empty day. */
  skills?: Record<string, { n: number; last: number }>
}

/** The per-session daily ledger: host-local day key (`YYYY-MM-DD`, shared/days.ts) → that day's
 * billed volume; the Context Insights page merges every listed session's ledger. */
export interface ContextActivity {
  days: Record<string, ActivityDay>
}

/** One available skill's catalog metadata, served by `/api/dsh-context/skills` (host/skills.ts); every field but `name` is best-effort. */
export interface SkillInfo {
  /** Kebab-case identifier — the join key onto `ActivityDay.skills`. */
  name: string
  description: string
  /** Absolute instruction file path, when the provider is filesystem-backed. */
  path?: string
  /** Discovery source bucket (e.g. 'project-agents', 'user-dsh', 'bundled'). */
  source?: string
}

/** The display-preference vocabulary of the `dsh-context` entry — the ONE declaration shared by
 * the Host Config schema (host/config.ts) and the Client's settings form (client/settings.ts). */
export type DefaultGranularity = 'step' | 'turn'

export type DefaultTrendMode = 'total' | 'delta'

/** The browser delta baseline: against the immediately preceding record, or the previous turn's last step. */
export type DefaultDeltaBase = 'step' | 'turn'

export type DefaultFileSort = 'count' | 'latest' | 'path'

export type DefaultToolSort = 'size' | 'count' | 'name'

export type DefaultPlacement = 'all' | 'tab' | 'sidebar'

export type InsightsEntry = 'show' | 'hide'

export type DefaultDurationCurve = 'show' | 'hide'

/** Whether the Fleet conversation tab is served. */
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
  fleetTab: FleetTab
}

export type SettingsField = keyof PluginSettings

export interface Snapshot {
  ok: boolean
  /** Present ONLY when the running harness is below the supported baseline: the host folds
   * nothing (all figures zero) and the client shows the upgrade gate. */
  unsupported?: {
    current: string
    minimum: string
  }
  model?: string
  provider?: string
  contextWindow?: number
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
  /** Image blocks in the CURRENT context (uploads plus nested tool-result images), summed over live surface nodes. Absent = 0. */
  images?: number
  /** Tool calls whose result is live (a `skill`-tool node keeps counting); in-flight and
   * compacted/pruned-out calls are excluded. Absent = 0. */
  toolCalls?: number
  /** Whole-session tally of non-injection `user/message` plus answered `ask_user_question` — a
   * running total over the COMPLETE log. Absent = 0. */
  humanInputs?: number
  /** Whole-session replies: one per assistant message carrying non-blank text (tool-only steps are not replies). Absent = 0. */
  answers?: number
  /** The newest own message as a one-line preview (first text block, whitespace collapsed, 80 chars max). Absent = hidden. */
  lastUser?: string
  /** Split-generation head fields — present exactly when the host serves the slim head;
   * `detailRev` bumps whenever the detail collections change. */
  counts?: TimelineCounts
  last?: TimelineLast
  detailRev?: number
  /** The slim head serves these EMPTY (the collections ride the detail channel); the client swaps in the detail payload's collections. */
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /** Cumulative session-cost raw material (SessionCostUsage); absent until a request with a known model reports usage. */
  cost?: SessionCostUsage
  /** Whole-session timing totals (TimingTotals). Absent until the first step lifecycle completes. */
  timing?: TimingTotals
  /** The live system-prompt nodes, oldest first. Absent on rows folded before the field existed
   * — the client then reads the header epoch's `systemTokens`. */
  systems?: SystemPromptNode[]
  /** The served live surface: the newest `maxNodes` tail PLUS every live inject/skill node older
   * than the tail (they land first and are pinned). Seq-ordered, oldest first. */
  nodes: SurfaceNode[]
  /** Live nodes not served: the overflow beyond `maxNodes` minus the pinned inject/skill nodes. */
  droppedNodes: number
  /** Recently REMOVED surface nodes (compaction/prune shadows) stamped with `gone` (the replacing
   * event's seq); a node belongs to request R when `seq < R.seq && (gone undefined || gone > R.seq)`. */
  archive: SurfaceNode[]
  /** Newest seq among the `droppedNodes` nodes not served; present only when droppedNodes > 0. */
  surfaceFloor?: number
  /** Newest `gone` among retention-dropped archive entries; steps below it may miss removed nodes. */
  archiveFloor?: number
  /** The fold-derived file-op log and trim floor: the INLINE value and detail payload, never the slim head. */
  fileOps?: FileOpRecord[]
  fileOpsFloor?: number
  /** The timing strip's painted spans: INLINE value and detail payload only; absent on rows folded before the collection existed. */
  spans?: TimingSpan[]
}

/** The on-demand DETAIL payload of the split generation: the heavy collections the slim head no
 * longer carries (host/detail.ts). `rev` mirrors the head's `detailRev` and is the client's latest-wins cursor. */
export interface ContextTimelineDetail {
  rev: number
  /** The slim head at the SAME fold cut as the collections — a session listed cold has no
   * `contextTimeline` row, so the Agent network ring reads this. Optional. */
  head?: ContextTimeline
  requests: RequestRecord[]
  events: ContextEventRecord[]
  nodes: SurfaceNode[]
  droppedNodes: number
  archive: SurfaceNode[]
  surfaceFloor?: number
  archiveFloor?: number
  /** The file-op log (shared/fileOps.ts) over the FULL log; Code-Mode nested dispatches book on their parent run_code result (`parent`). */
  fileOps?: FileOpRecord[]
  /** The newest dropped op's seq when the op log trimmed (coverage honesty, same family as archiveFloor). */
  fileOpsFloor?: number
  /** The completed steps' time slices in log order, positioned by their real instants. Absent = no strip. */
  spans?: TimingSpan[]
}

/** One executed file operation, folded host-side from the durable tool lifecycle (`tool/call` +
 * `tool/result`, or a nested `tool/ptc-dispatch`); line deltas are estimates read off the call
 * ARGUMENTS. `gone` is client-joined, not host-stamped. */
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

/** The official token-meter `contextPressure` projection: the provider-anchored occupancy of the
 * NEXT request; fields are independent last-wins records. Absent = the meter is not composed (the
 * client then falls back to its derived anchor). */
export interface ContextPressure {
  /** Provider-reported prompt size of the most recent request (input + cache). */
  pressureTokens?: number
  /** pressureTokens + heuristic surface movement since the sample (clamped ≥ 0). */
  projectedTokens?: number
  contextWindow?: number
}

/** The official token-meter `contextBreakdown` projection: the heuristic composition rows the chat
 * ring's panel shows. Read directly so the card's counts stay identical to the panel's; the message
 * bucket splits into the five message-bearing surface categories. Absent = an older harness. */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/** The official token-meter `tokenUsage` projection: durable cumulative provider-reported usage
 * across the COMPLETE log; the four buckets are disjoint (reasoning sits inside `outputTokens`). */
export interface TokenUsage {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** One painted span of the timing card's session-time strip (a step's TTFT wait, decode block,
 * tool-run window, or residue gap). `start`/`end` are the slice's REAL instants; the strip packs
 * them gapless in log order, and `end` > `start` always. */
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

/**
 * Whole-session timing totals, host-folded from the durable step/tool lifecycle plus the call's
 * first token (its embedded `assistant/message.data.stream`); running totals over the COMPLETE log.
 *
 * Milliseconds: `wallMs` sums whole steps; `ttftMs` the step-start → decode-start slice and `genMs`
 * the decode-start → assistant-message slice (only over calls whose stream carried a token delta);
 * `toolsMs` sums per-call tool durations (parallel calls each count). The decode window opens at the
 * first OBSERVABLE instant — the first token, or an earlier `block-start` marker (a redacted
 * reasoning block leaves no chunk): anchoring at the token would double-count the marker-tiled
 * window past 100%.
 *
 * The generation split comes off the stream's `block-start` framing (`blockType`): `reasoningMs` /
 * `textMs` / `toolArgMs` and their block counts, each marker owning the interval to the next.
 * `speedTokens`/`speedMs` are the harness-parity throughput seat (first-token → assistant-message,
 * calls carrying both); `speedMs` KEEPS the first-token anchor. `calls` counts folded assistant
 * messages, `toolCalls` folded call/result pairs.
 */
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

/** One billed model's totals split by pricing period: providers without period pricing book
 * everything under `peak`; DeepSeek bills `peak` at list price and `off` at half. */
export interface CostModelUsage {
  peak?: CostBucketTotals
  off?: CostBucketTotals
}

/** The session-cost raw material: cumulative provider-reported billed tokens keyed by the request
 * envelope's DSH provider id ('' when none) then model id — the faces the Client's models.dev price book resolves. */
export interface SessionCostUsage {
  [provider: string]: { [model: string]: CostModelUsage }
}

/** One model-visible message on the surface, with its heuristic token price. */
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
  /** The producer identity the matching inject event names (host pricing.ts
   * `injectionSourceName`); absent when unreadable or predating the stamp. */
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
  /** Skill-machinery tokens of this request (the `skill` composition category); absent on rows
   * folded before the category existed (read as 0). */
  skill?: number
  /** Billed cache-read (served) prompt tokens — the hit-rate numerator against `prompt`; absent
   * on older hosts, and zero is a real value. */
  cacheRead?: number
  output?: number
  /** The step's ACTIVE ms (`step/start` → `step/end` minus in-step user waits: approval decisions
   * and `ask_user_question`), stamped at `step/end`; absent while the step is open. */
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

/** Sentinel `HeaderTool.plugin` value marking a tool whose provider could not be attributed (it was
 * already registered when this plugin's attribution hook installed); no real plugin name collides. */
export const UNKNOWN_TOOL_SOURCE = '<unknown-plugin>'

/** One tool of a request-header epoch, with its display price. */
export interface HeaderTool {
  name: string
  tokens: number
  /** The registering plugin's label when known: `mcp:<server>` for MCP tools, or the pinned
   * first-party map; `UNKNOWN_TOOL_SOURCE` marks a boot-time tool, absent = no tag. */
  plugin?: string
}

/** One request-header epoch's METADATA (epoch boundaries and token prices, in force from this seq
 * until the next). The CONTENT is deliberately not projected — every list row and push frame would
 * carry it — and is fetched on demand as a {@link HeaderEpochContent}. */
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

/** The fetched CONTENT of one request-header epoch, mapped client-side off the raw durable event
 * (historyPage.ts); tool identity joins the metadata by `name`. */
export interface HeaderEpochContent {
  system?: string
  tools: Array<{
    name: string
    description?: string
    schema?: unknown
  }>
}

/** One currency's DeepSeek open-platform balance figures. */
export interface PlatformBalanceEntry {
  /** The ISO code the platform reported (`CNY` / `USD`). */
  currency: string
  /** `granted` + `toppedUp`, derived rather than read from the platform's `total_balance`, which rounds independently of its parts. */
  total: number
  /** The not-expired granted (gift) balance. */
  granted: number
  toppedUp: number
}

/** The DeepSeek open-platform balance, served by `/api/dsh-context/balance`; `null` on the wire
 * (nothing rendered) when unconfigured or the read fails. */
export interface PlatformBalance {
  isAvailable: boolean
  /** One entry per currency the account holds; at least one. */
  balances: PlatformBalanceEntry[]
}
