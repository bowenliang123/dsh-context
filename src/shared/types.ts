/**
 * Shared wire contract — the snapshot model exchanged between the Host and
 * Client halves.
 *
 * The Host half no longer serves this over a custom RPC channel: it is the
 * `view()` payload of the `contextTimeline` session projection, registered on
 * the harness's `ctx.sessionProjections` registry. The registry drives
 * `apply(state, event)` over every committed session event, persists the state
 * through `ctx.sessionProjectionCache`, and pushes the finished value to the
 * browser as a `session/projection` frame (with a tail-page baseline), where
 * the Client reads it through the framework-standard `useProjection` seat.
 *
 * TYPE-ONLY host-side module: both halves import these as `import type`, so
 * nothing from here ever reaches the runtime bundles.
 */

import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The plugin's whole-value context timeline: current composition,
     * per-request history, context events, and the model-visible surface.
     * The Host folds it from the session log; clients receive the finished
     * value (key absence = the plugin's host half is not composed).
     */
    contextTimeline: ContextTimeline
    /**
     * The request-header CONTENT epochs (full system prompt + tool schemas)
     * behind the timeline's envelope figures. A separate unit so the hot
     * `contextTimeline` value stays lean: headers change rarely, so this
     * value (and its pushes) change only when a `request/header` lands.
     * The Context browser card reads it to show the actual prompt/schema
     * content of a picked step (key absence = older host: tokens only).
     */
    contextHeaders: ContextHeaders
  }
}

/** The five priced context categories (plus system/tools handled separately). */
export type Category = 'user' | 'inject' | 'assistant' | 'tool'

export interface Snapshot {
  ok: boolean
  model?: string
  provider?: string
  contextWindow?: number
  current: {
    system: number
    tools: number
    user: number
    inject: number
    assistant: number
    tool: number
    total: number
  }
  /**
   * Provider-anchored occupancy of the NEXT request. LEGACY since 0.11: the
   * Host no longer folds this — the Client reads the official token-meter
   * `contextPressure` projection key (`useProjection('contextPressure')`)
   * instead. Kept optional for wire compatibility with older clients.
   */
  occupancy?: {
    /** Provider-reported prompt size of the most recent request (input + cache). */
    pressureTokens?: number
    /** Heuristic total over the current model-visible surface. */
    surfaceTokens: number
    /** `surfaceTokens` at the newest usage sample. */
    sampledSurfaceTokens?: number
    /** pressureTokens + surface movement since the sample (clamped ≥ 0). */
    projectedTokens?: number
    /** Newest recorded route capacity (last-wins). */
    contextWindow?: number
  }
  toolList: { name: string; tokens: number }[]
  /**
   * Cumulative image-block count over the COMPLETE session log (user uploads
   * plus tool-result images) — never trimmed, like `cost`. Absent from older
   * hosts; clients treat absence as zero.
   */
  images?: number
  requests: RequestRecord[]
  events: ContextEventRecord[]
  /**
   * Cumulative session-cost raw material (per-family, per-period billed
   * token totals — see SessionCostUsage). Absent until a DeepSeek V4
   * request reports usage.
   */
  cost?: SessionCostUsage
  /**
   * The served live surface: the newest `maxNodes` tail PLUS every live
   * inject node older than the tail (injections land first and are few, so
   * they are pinned — otherwise a long session would price them while the
   * browser could list none). Seq-ordered, oldest first.
   */
  nodes: SurfaceNode[]
  /** Live nodes not served (the overflow beyond `maxNodes`, minus pinned injects — see `nodes`). */
  droppedNodes: number
  /**
   * Recently REMOVED surface nodes (compaction/prune shadows), each stamped
   * with `gone` (the replacing event's seq). Together with `nodes` this lets
   * the Context browser reconstruct the assembled surface of any retained
   * step: alive at request R = seq < R.seq && (gone undefined || gone > R.seq).
   */
  archive: SurfaceNode[]
  /**
   * Coverage floor of the served live `nodes`: the newest seq among the
   * `droppedNodes` live nodes not served. Present only when droppedNodes > 0.
   */
  surfaceFloor?: number
  /**
   * Coverage floor of `archive`: the newest `gone` among archive entries the
   * retention bounds dropped. Steps with seq < archiveFloor may miss removed
   * nodes (the browser shows the reconstruction as approximate).
   */
  archiveFloor?: number
}

/**
 * The `contextTimeline` projection's whole value — the same snapshot the
 * Client has always rendered, now delivered through the session-projection
 * pipeline. `ok` is always `true` here (a delivered projection is by
 * definition available); it is kept for wire compatibility with the
 * snapshot shape.
 */
export type ContextTimeline = Snapshot

/**
 * The official token-meter `contextPressure` projection (registered by
 * `@deepseek-ai/dsh-token-meter` on the same `SessionProjectionMap`): the
 * provider-anchored occupancy of the NEXT request. The Client reads this key
 * directly instead of the Host mirroring it inside `contextTimeline`
 * (token-meter owns estimation and replay — the docs' stated division of
 * labor). Fields are independent last-wins records; absent until a provider
 * reports usage. Absent key/value = the registry (or the meter) is not
 * composed — the Client falls back to its derived anchor.
 */
export interface ContextPressure {
  /** Provider-reported prompt size of the most recent request (input + cache). */
  pressureTokens?: number
  /** pressureTokens + heuristic surface movement since the sample (clamped ≥ 0). */
  projectedTokens?: number
  /** Newest recorded route capacity (last-wins). */
  contextWindow?: number
}

/**
 * The official token-meter `contextBreakdown` projection: the heuristic
 * composition rows the chat ring's click-open panel shows (system prompt,
 * tool schemas, conversation). The Client reads this key directly so the
 * composition card's proportions AND counts stay identical to the panel's
 * by construction; the message bucket is subdivided into the plugin's four
 * surface categories by the fold's per-category ratios. Absent key/value =
 * an older harness without the meter's projection units — callers fall back
 * to the fold's own sums (identical estimator, minus the image correction).
 */
export interface ContextBreakdown {
  systemTokens: number
  toolsTokens: number
  messageTokens: number
}

/**
 * The official token-meter `tokenUsage` projection (registered by
 * `@deepseek-ai/dsh-token-meter` on the same `SessionProjectionMap`): durable
 * cumulative provider-reported usage across the COMPLETE session log. The four
 * buckets are disjoint (reasoning tokens are already inside `outputTokens`).
 * The Client reads this key directly to compute the cache-hit share — the
 * exact same data the chat stats line below the input box shows, same formula
 * — instead of the Host mirroring it inside `contextTimeline`. Absent until a
 * provider reports usage.
 */
export interface TokenUsage {
  /** Billed prompt tokens that missed the provider cache. */
  uncachedInputTokens: number
  /** Billed output tokens (reasoning included). */
  outputTokens: number
  /** Billed prompt tokens served from the provider cache. */
  cacheReadTokens: number
  /** Billed prompt tokens written into the provider cache. */
  cacheWriteTokens: number
}

/**
 * Cumulative billed-token totals for one pricing bucket of the session-cost
 * estimate (host-folded, never trimmed — running totals over the COMPLETE
 * session log, immune to the request/event retention bounds).
 */
export interface CostBucketTotals {
  /** Billed prompt tokens that missed the provider cache. */
  uncached: number
  /** Billed prompt tokens served from the provider cache. */
  cacheRead: number
  /** Billed prompt tokens written into the provider cache. */
  cacheWrite: number
  /** Billed output tokens (reasoning included). */
  output: number
}

/** One model family's totals split by DeepSeek's pricing period (Beijing Time). */
export interface CostFamilyUsage {
  /** Peak windows: 09:00-12:00 and 14:00-18:00 Beijing Time, weekdays only. */
  peak?: CostBucketTotals
  /** All other hours plus all of Saturday/Sunday (half the peak rate). */
  off?: CostBucketTotals
}

/**
 * The session-cost estimate's raw material: cumulative provider-reported
 * token totals per DeepSeek V4 model family (matched on the model NAME,
 * provider-agnostic) and pricing period. The Client prices these with its
 * hardcoded list-price table in the locale's currency. Absent until a
 * deepseek-v4-flash / deepseek-v4-pro request reports usage.
 */
export interface SessionCostUsage {
  flash?: CostFamilyUsage
  pro?: CostFamilyUsage
}

/** One model-visible message on the surface, with its heuristic token price. */
export interface SurfaceNode {
  seq: number
  /** Event timestamp (ms epoch); the Client shows it when present. */
  time?: number
  cat: Category
  tokens: number
  /**
   * Removal marker, present only on `archive` entries: the seq of the
   * replacement surface event that shadowed this node (compaction/prune).
   * The node is part of the assembled context of every request with
   * seq > this node.seq and seq < gone.
   */
  gone?: number
  form?: string
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
  output?: number
  /**
   * Turn-mode aggregate marker, set by the Client's aggregateByTurn (one bar
   * per turn shows its LAST step's record). The Host never sets it.
   */
  stepCount?: number
}

/** A notable context event (compaction, prune, injection, model switch). */
export interface ContextEventRecord {
  seq: number
  time: number
  kind: 'compaction' | 'prune' | 'inject' | 'model'
  form?: string
  tokens?: number
  count?: number
  sub?: string
  name?: string
  from?: string
  to?: string
  /** Turn/step of the request logged right BEFORE the event (host-stamped). */
  fromTurn?: number
  fromStep?: number
  /** Turn/step of the request this event contributed to (host-stamped). */
  turn?: number
  step?: number
}

// ---- contextHeaders projection (request-header content epochs) -------------

/** One tool schema as assembled into a request header, with its display price. */
export interface HeaderTool {
  name: string
  tokens: number
  /** Producer-declared description (may be long; the browser truncates). */
  description?: string
  /** The raw JSON schema object the model received (plain JSON). */
  schema?: unknown
}

/**
 * One request-header epoch: the full system prompt and tool schemas in force
 * from this event's seq until the next epoch. Headers change rarely (the loop
 * only logs `request/header` on change), so this unit's pushes are rare and
 * carrying full content is cheap.
 */
export interface HeaderRecord {
  seq: number
  time: number
  system?: string
  tools: HeaderTool[]
}

/** The `contextHeaders` projection value: the bounded epoch list (newest last). */
export interface ContextHeaders {
  headers: HeaderRecord[]
}
