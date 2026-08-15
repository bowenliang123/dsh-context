/**
 * Shared wire contract — the snapshot model exchanged between the Host and
 * Client halves over the `/dsh-context` Connection RPC channel.
 *
 * TYPE-ONLY module: both halves import these as `import type`, so nothing
 * from here ever reaches the runtime bundles. The Host produces these
 * records while folding the session log; the Client renders them.
 */

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
   * Provider-anchored occupancy, mirroring dsh token-meter's contextPressure
   * projection (the official chat context ring). `projectedTokens` answers for
   * the NEXT request: the newest usage sample's prompt pressure carried
   * forward by the heuristic surface movement since the sample. Fields are
   * independent last-wins records; absent until a provider reports usage.
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
  requests: RequestRecord[]
  events: ContextEventRecord[]
  nodes: SurfaceNode[]
  droppedNodes: number
}

/** One model-visible message on the surface, with its heuristic token price. */
export interface SurfaceNode {
  seq: number
  /** Event timestamp (ms epoch); the Client shows it when present. */
  time?: number
  cat: Category
  tokens: number
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
