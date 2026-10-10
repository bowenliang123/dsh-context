/** Agent-graph derivation — the pure model behind the Agent network card. The
 * session-list snapshot carries everything the card needs, and this folds it
 * into the current session's family: the topmost known ancestor's whole subtree, per-node stats, and a depth/DFS layout. */

import type { PartsPart } from './categories'
import type { ContextBreakdown, ContextPressure, ContextTimeline, SessionCostUsage, TokenUsage } from '../shared/types'
import { mergeCostUsage } from './cost'
import { headlineOf, occupancyPercent, type Headline } from './headline'
import { asRecord, contextBreakdownOf, contextPressureOf, numOf, timelineOf, tokenUsageOf } from './services'

/** The outward `ctx.sessions` client face. Session navigation is NOT here: the
 * view owner's `openSession` is (services.ts `openSessionVia`). */
export interface SessionsFaceLike {
  list?: {
    getSnapshot(): unknown
    subscribe(fn: () => void): () => void
  }
  refreshSubagents?(parentSessionId: string): Promise<unknown>
}

export interface AgentRow {
  displayTitle?: string
  title?: string
  parentId?: string
  origin?: string
  running: boolean
  blank: boolean
  updatedAt: number
  projections?: Record<string, unknown>
}

/** The subagent domain's `subagent` identity projection (descriptor mode + durable label). */
export interface AgentIdentity {
  mode: 'one-shot' | 'continuable'
  label?: string
}

export interface AgentStats {
  head: Headline | null
  requests: number
  billed: number | null
  /** Cumulative session-cost ledger off the timeline — the card's price estimate rides it. */
  costUsage: SessionCostUsage | null
  durationMs: number | null
  identity: AgentIdentity | null
}

/** Live stats of the CURRENT session, fresher than any list row. */
export interface AgentSelfStats {
  head: Headline | null
  billed: number | null
  requests: number
  /** The tab's own cost ledger (the stats board's `data.cost`). */
  costUsage?: SessionCostUsage | null
  /** The current session's whole-step time (`data.timing.wallMs`, host-folded over the
   * complete log). Not the harness's subagent measure — that folds turn windows, and a parent
   * session never carries a `subagentTiming` projection at all — but the only duration it has. */
  durationMs?: number | null
}

export interface AgentNode extends AgentStats {
  id: string
  label: string
  parentId?: string
  depth: number
  /** Which level-1 subtree this node belongs to (root = -1) — drives the family link hue. */
  family: number
  isCurrent: boolean
  running: boolean
  completed: boolean
  subagent: boolean
}

export interface AgentForest {
  /** DFS pre-order (parents ahead of their children). */
  nodes: AgentNode[]
  edges: { from: string; to: string }[]
  overflow: number
  solo: boolean
}

/** The card stays readable up to this many nodes; the rest folds into an overflow note. */
export const AGENT_TREE_LIMIT = 25

/** Fixed card height — mirrored by `.lc-agent-card`'s `height` in agentGraph.css, so a link's
 * exit point (card bottom) and entry point (card top) always land on the card's edge. */
export const AGENT_CARD_H = 104
/** Horizontal cell pitch adapts to the stage width between these bounds; each node owns one
 * cell and the card fills it minus a 12px gutter, so a card never clips a neighbor or the stage edge.
 * Every card shares one pitch — the graph reads as a grid, and a card never claims extra room. */
const SLOT_MAX = 276
const SLOT_MIN = 150
const CARD_GUTTER = 12
/** Vertical pitch between depth levels: card height + a dedicated 40px link channel below it. */
const LEVEL_H = AGENT_CARD_H + 40
const PAD_Y = 48

export function agentRowOf(value: unknown): AgentRow | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const projections = asRecord(rec.projectionValues)
  return {
    ...(typeof rec.displayTitle === 'string' ? { displayTitle: rec.displayTitle } : {}),
    ...(typeof rec.title === 'string' ? { title: rec.title } : {}),
    ...(typeof rec.parentId === 'string' ? { parentId: rec.parentId } : {}),
    ...(typeof rec.origin === 'string' ? { origin: rec.origin } : {}),
    running: rec.running === true,
    blank: rec.blank === true,
    updatedAt: numOf(rec.updatedAt),
    ...(projections !== null ? { projections } : {}),
  }
}

export function agentIdentityOf(value: unknown): AgentIdentity | null {
  const rec = asRecord(value)
  if (rec === null) return null
  if (rec.mode !== 'one-shot' && rec.mode !== 'continuable') return null
  return {
    mode: rec.mode,
    ...(typeof rec.label === 'string' && rec.label !== '' ? { label: rec.label } : {}),
  }
}

export function agentDurationOf(value: unknown): number | null {
  const rec = asRecord(value)
  if (rec === null) return null
  const settled = numOf(rec.settledMs)
  const active = asRecord(rec.active)
  const openMs = active !== null ? Math.max(0, numOf(active.through) - numOf(active.since)) : 0
  const total = settled + openMs
  return total > 0 ? total : null
}

/** The harness's own done signal (its subagent header popup's green dot): the last closed turn
 * after the child's descriptor finished normally. A running session is never done, whatever it
 * last turned in. */
export function agentTurnCompletedOf(value: unknown): boolean {
  return asRecord(value)?.lastTurnCompleted === true
}

/** Fold one row's projection values into render-ready stats. The composition
 * prefers the plugin's own `contextTimeline`; a pressure-only row still yields an occupancy ring without slices. */
export function agentStatsOf(values: Record<string, unknown> | undefined): AgentStats {
  const timeline = timelineOf(values?.contextTimeline)
  const pressure = contextPressureOf(values?.contextPressure)
  const breakdown = contextBreakdownOf(values?.contextBreakdown)
  const usage = tokenUsageOf(values?.tokenUsage)
  let head: Headline | null = null
  if (timeline !== null) {
    head = headlineOf(timeline, pressure, breakdown)
  } else if (pressure !== null) {
    const tokens = typeof pressure.projectedTokens === 'number' ? pressure.projectedTokens
      : typeof pressure.pressureTokens === 'number' ? pressure.pressureTokens
        : null
    if (tokens !== null) {
      const window = typeof pressure.contextWindow === 'number' && pressure.contextWindow > 0
        ? pressure.contextWindow
        : undefined
      head = {
        tokens,
        window,
        pct: window !== undefined ? occupancyPercent(tokens, window) : null,
        parts: [],
      }
    }
  }
  return {
    head,
    // The split-generation wire head carries the tally precomputed; the inline generation's rows count their served records.
    requests: timeline !== null ? (timeline.counts?.steps ?? timeline.requests.length) : 0,
    billed: billedOf(usage),
    costUsage: timeline?.cost ?? null,
    durationMs: agentDurationOf(values?.subagentTiming),
    identity: agentIdentityOf(values?.subagent),
  }
}

/** Billed tokens off a `tokenUsage` tally; null when no tally is served. */
function billedOf(usage: TokenUsage | null): number | null {
  return usage !== null
    ? numOf(usage.uncachedInputTokens) + numOf(usage.outputTokens) + numOf(usage.cacheReadTokens) + numOf(usage.cacheWriteTokens)
    : null
}

/** The current session's own live stats off the VIEW's projections — the Context tab and the Fleet tab both
 * render the network card from this one derivation, so the two mounts can never disagree. Unlike a listed row
 * ({@link agentStatsOf}), a top-level session carries no `subagentTiming` projection: its own whole-step time
 * is the duration it has. */
export function agentSelfOf(
  timeline: ContextTimeline,
  pressure: ContextPressure | null,
  breakdown: ContextBreakdown | null,
  usage: TokenUsage | null,
): AgentSelfStats {
  return {
    head: headlineOf(timeline, pressure, breakdown),
    billed: billedOf(usage),
    // The split generation's slim head counts the retained steps itself; the inline generation's value serves them.
    requests: timeline.counts?.steps ?? timeline.requests.length,
    costUsage: timeline.cost ?? null,
    durationMs: timeline.timing != null && timeline.timing.wallMs > 0 ? timeline.timing.wallMs : null,
  }
}

/**
 * Spawn-order ranks from a parent row's `subagentCatalog` projection — the harness
 * header popup's own sibling order (parent catalog event order). Absent, empty, or
 * hostile values yield null and the caller keeps its activity heuristic; malformed
 * entries drop alone.
 */
export function catalogOrderOf(values: Record<string, unknown> | undefined): Map<string, number> | null {
  const cat = values?.subagentCatalog
  if (!Array.isArray(cat)) return null
  const order = new Map<string, number>()
  for (const entry of cat) {
    const rec = asRecord(entry)
    if (rec === null || typeof rec.id !== 'string' || rec.id === '') continue
    if (!order.has(rec.id)) order.set(rec.id, order.size)
  }
  return order.size > 0 ? order : null
}

interface AgentChild {
  id: string
  row: AgentRow
}

/**
 * Build the current session's agent family: walk up `parentId` to the topmost
 * known ancestor, then DFS its whole subtree (blank rows excluded). Null when
 * there is no anchor; the current session synthesizes a row when the list has
 * not delivered it yet.
 * @param fetched - detail-channel heads for COLD rows, keyed by session id.
 *   The list block serves projection values only from the projection cache, so
 *   these fill in relatives that would otherwise list pressure-only; a row's
 *   own value always wins.
 */
export function agentForestOf(
  snapshot: unknown,
  currentId: string | undefined,
  self?: AgentSelfStats,
  fetched?: ReadonlyMap<string, unknown>,
): AgentForest | null {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return null

  const rows = new Map<string, AgentRow>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    // Blank placeholder sessions (never engaged) are not agents; the current session always stays.
    if (row !== null && (!row.blank || key === currentId)) rows.set(key, row)
  }
  if (!rows.has(currentId)) {
    rows.set(currentId, { running: false, blank: false, updatedAt: 0 })
  }

  // Topmost known ancestor; a lineage cycle anchors at the first repeated id.
  let root = currentId
  const chain = new Set<string>([currentId])
  for (;;) {
    const parent = rows.get(root)?.parentId
    if (parent === undefined || !rows.has(parent) || chain.has(parent)) break
    chain.add(parent)
    root = parent
  }
  const rootRow = rows.get(root)
  /** v8 ignore next 2 -- root is currentId (inserted above) or a parent verified with rows.has, so its row always exists. */
  if (rootRow === undefined) return null

  const childrenOf = new Map<string, AgentChild[]>()
  for (const [id, row] of rows) {
    if (row.parentId === undefined || !rows.has(row.parentId)) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push({ id, row })
    childrenOf.set(row.parentId, list)
  }
  for (const [pid, kids] of childrenOf) {
    // Sibling order follows the parent's subagent catalog (the harness header popup's
    // own spawn order) when cached; uncataloged children fall after cataloged ones,
    // and catalog-less parents keep the activity heuristic untouched.
    const order = catalogOrderOf(rows.get(pid)?.projections)
    kids.sort((a, b) => {
      const ra = order?.get(a.id)
      const rb = order?.get(b.id)
      if (ra !== undefined || rb !== undefined) {
        // Catalog ranks are unique per parent, so two ranked ids never tie here.
        if (ra === undefined) return 1
        if (rb === undefined) return -1
        return ra - rb
      }
      const runDelta = Number(b.row.running) - Number(a.row.running)
      if (runDelta !== 0) return runDelta
      const timeDelta = b.row.updatedAt - a.row.updatedAt
      return timeDelta !== 0 ? timeDelta : (a.id < b.id ? -1 : 1)
    })
  }

  // Measured before the DFS so the overflow note is exact even when the cap cuts the walk short.
  const measure = (id: string, seen: Set<string>): number => {
    if (seen.has(id)) return 0
    seen.add(id)
    let total = 1
    for (const kid of childrenOf.get(id) ?? []) total += measure(kid.id, seen)
    return total
  }
  const total = measure(root, new Set())

  const nodes: AgentNode[] = []
  const edges: { from: string; to: string }[] = []
  const visit = (id: string, row: AgentRow, parentId: string | undefined, depth: number, seen: Set<string>, family: number): void => {
    if (seen.has(id) || nodes.length >= AGENT_TREE_LIMIT) return
    seen.add(id)
    const values = row.projections
    const fetchedHead = fetched !== undefined ? fetched.get(id) : undefined
    const stats = agentStatsOf(fetchedHead !== undefined && values?.contextTimeline === undefined
      ? { ...values, contextTimeline: fetchedHead }
      : values)
    const identity = stats.identity
    if (id === currentId && self !== undefined) {
      stats.head = self.head ?? stats.head
      stats.billed = self.billed ?? stats.billed
      stats.requests = self.requests > 0 ? self.requests : stats.requests
      stats.costUsage = self.costUsage ?? stats.costUsage
      stats.durationMs = self.durationMs ?? stats.durationMs
    }
    const subagent = row.origin === 'subagent' || identity !== null
    const node: AgentNode = {
      ...stats,
      id,
      label: identity?.label ?? row.title ?? row.displayTitle ?? id,
      ...(parentId !== undefined ? { parentId } : {}),
      depth,
      family,
      isCurrent: id === currentId,
      running: row.running,
      // Done, by the harness popup's own rule: a stopped agent only, and the signal is the
      // last closed subagent turn finishing normally. A session that is not a subagent never
      // carries that projection, so its own folded steps stand in for it.
      completed: !row.running
        && (agentTurnCompletedOf(values?.subagentTiming) || (!subagent && stats.requests > 0)),
      subagent,
    }
    nodes.push(node)
    if (parentId !== undefined) edges.push({ from: parentId, to: id })
    const kids = childrenOf.get(id) ?? []
    kids.forEach((kid, ki) => {
      visit(kid.id, kid.row, id, depth + 1, seen, depth === 0 ? ki : family)
    })
  }
  visit(root, rootRow, undefined, 0, new Set(), -1)

  return { nodes, edges, overflow: Math.max(0, total - nodes.length), solo: nodes.length === 1 }
}

export interface SubagentCostFold {
  usage: SessionCostUsage | null
  /** Descendants with no timeline row and no landed head — the slim-head fetch targets. */
  cold: string[]
  count: number
}

/** Merge the current session's SUBAGENT subtree cost: warm rows'
 * `contextTimeline` cost first, fetched slim heads (`landed`) standing in for
 * rows with no timeline value. Blank rows are not agents; the current session
 * itself is never counted — the caller already holds its own usage. */
export function subagentCostFoldOf(
  snapshot: unknown,
  currentId: string | undefined,
  landed?: ReadonlyMap<string, ContextTimeline>,
): SubagentCostFold {
  const byId = asRecord(asRecord(snapshot)?.byId)
  if (byId === null || currentId === undefined || currentId === '') return { usage: null, cold: [], count: 0 }
  const childrenOf = new Map<string, string[]>()
  for (const key of Object.keys(byId)) {
    const row = agentRowOf(byId[key])
    if (row === null || row.blank || row.parentId === undefined) continue
    const list = childrenOf.get(row.parentId) ?? []
    list.push(key)
    childrenOf.set(row.parentId, list)
  }
  const parts: SessionCostUsage[] = []
  const cold: string[] = []
  const seen = new Set<string>([currentId])
  const queue = [currentId]
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i]
    for (const kid of childrenOf.get(id) ?? []) {
      if (seen.has(kid)) continue
      seen.add(kid)
      const head = landed?.get(kid)
      const values = agentRowOf(byId[kid])?.projections
      if (values?.contextTimeline === undefined) {
        // A cold relative's usage rides its fetched slim head; until one lands
        // the id stays a fetch target, and a landed head is final either way.
        if (head === undefined) cold.push(kid)
        else if (head.cost !== undefined) parts.push(head.cost)
      } else {
        const cost = timelineOf(values.contextTimeline)?.cost
        if (cost !== undefined) parts.push(cost)
      }
      queue.push(kid)
    }
  }
  return { usage: parts.length > 0 ? mergeCostUsage(...parts) : null, cold, count: seen.size - 1 }
}

export interface AgentPoint {
  id: string
  x: number
  y: number
  depth: number
}

export interface AgentLink {
  to: string
  running: boolean
  color: string
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface AgentLayout {
  width: number
  height: number
  /** Card width from the responsive layout (narrows as slots compress). */
  cardW: number
  points: AgentPoint[]
  links: AgentLink[]
}

/** Tidy top-down tree layout: siblings claim leaf slots and parents center over
 * their children. The slot pitch adapts to the stage width between SLOT_MAX and
 * SLOT_MIN; a level that still overflows wraps into bands, since vertical room is cheaper than horizontal scrolling. */
export function layoutForest(forest: AgentForest, stageWidth = 0): AgentLayout {
  // Nodes are DFS pre-order, so plain iteration appends children in visit order.
  const childrenOf = new Map<string, AgentNode[]>()
  for (const n of forest.nodes) {
    if (n.parentId === undefined) continue
    const kids = childrenOf.get(n.parentId) ?? []
    kids.push(n)
    childrenOf.set(n.parentId, kids)
  }

  const slotOf = new Map<string, number>()
  let leafSlots = 0
  const place = (node: AgentNode): number => {
    const kids = childrenOf.get(node.id) ?? []
    if (kids.length === 0) {
      const slot = leafSlots
      leafSlots++
      slotOf.set(node.id, slot)
      return slot
    }
    let first = 0
    let last = 0
    kids.forEach((kid, index) => {
      const slot = place(kid)
      if (index === 0) first = slot
      last = slot
    })
    const slot = (first + last) / 2
    slotOf.set(node.id, slot)
    return slot
  }
  /** v8 ignore next 1 -- a forest always holds at least the (possibly synthesized) current node. */
  if (forest.nodes.length > 0) place(forest.nodes[0])

  const perLevel = stageWidth > 0 ? Math.max(1, Math.floor(stageWidth / SLOT_MIN)) : 0

  if (perLevel > 0 && leafSlots > perLevel) {
    // Wrapped layout: bands interleaved by kinship, so after each parent band
    // come the bands of exactly those parents' children and sibling groups never split unless one group alone exceeds the band.
    const bandSlot = Math.min(SLOT_MAX, stageWidth / perLevel)
    const width = perLevel * bandSlot
    const points: AgentPoint[] = []
    let row = 0
    const emitBand = (nodes: AgentNode[], depth: number): void => {
      const inset = (width - nodes.length * bandSlot) / 2
      nodes.forEach((node, i) => {
        points.push({ id: node.id, x: inset + (i + 0.5) * bandSlot, y: PAD_Y + row * LEVEL_H, depth })
      })
      row++
      let band: AgentNode[] = []
      const flush = (): void => {
        if (band.length === 0) return
        const packed = band
        band = []
        emitBand(packed, depth + 1)
      }
      for (const node of nodes) {
        const kids = childrenOf.get(node.id) ?? []
        for (let start = 0; start < kids.length; start += perLevel) {
          const group = kids.slice(start, start + perLevel)
          if (band.length + group.length > perLevel) flush()
          band.push(...group)
          if (band.length === perLevel) flush()
        }
      }
      flush()
    }
    /* v8 ignore next 1 -- a forest always holds at least the current node. */
    if (forest.nodes.length > 0) emitBand([forest.nodes[0]], 0)
    return {
      width,
      height: PAD_Y + (row - 1) * LEVEL_H + AGENT_CARD_H + 24,
      cardW: bandSlot - CARD_GUTTER,
      points,
      links: linksOf(forest, points),
    }
  }

  // Adaptive pitch; 0 = unmeasured stage (the natural maximum).
  const slot = stageWidth > 0 && leafSlots > 1 ? Math.min(SLOT_MAX, stageWidth / leafSlots) : SLOT_MAX
  const points: AgentPoint[] = forest.nodes.map(node => ({
    id: node.id,
    /** v8 ignore next 1 -- place() visits every node: the forest is exactly the root's subtree by construction. */
    x: (slotOf.get(node.id) ?? 0) * slot + slot / 2,
    y: PAD_Y + node.depth * LEVEL_H,
    depth: node.depth,
  }))
  const maxDepth = points.reduce((max, p) => Math.max(max, p.depth), 0)
  return {
    width: leafSlots * slot,
    height: PAD_Y + maxDepth * LEVEL_H + AGENT_CARD_H + 24,
    cardW: slot - CARD_GUTTER,
    points,
    links: linksOf(forest, points),
  }
}

/** Family hue by level-1 subtree index: the golden angle keeps consecutive
 * families separated on the color wheel without a hand-tuned palette. */
export function familyHue(index: number): string {
  return `hsl(${Math.round(index * 137.508) % 360} 58% 52%)`
}

function linksOf(forest: AgentForest, points: AgentPoint[]): AgentLink[] {
  const pointOf = new Map(points.map(p => [p.id, p]))
  const nodeOf = new Map(forest.nodes.map(n => [n.id, n]))
  const runningIds = new Set(forest.nodes.filter(n => n.running).map(n => n.id))
  const links: AgentLink[] = []
  for (const edge of forest.edges) {
    const from = pointOf.get(edge.from)
    const to = pointOf.get(edge.to)
    /** v8 ignore next 2 -- edges are emitted only for visited parent/child pairs, so both points always exist. */
    if (from === undefined || to === undefined) continue
    links.push({
      to: edge.to,
      running: runningIds.has(edge.to),
      /* v8 ignore next 1 -- edges only connect visited nodes. */
      color: familyHue(nodeOf.get(edge.to)?.family ?? 0),
      // Out of the parent card's bottom edge, into the child card's top edge. A wrapped
      // band can drop a child several rows down, where the curve passes BEHIND the rows
      // between (the link layer paints under the cards) — it reads as depth, not a crossing.
      x1: from.x,
      y1: from.y + AGENT_CARD_H,
      x2: to.x,
      y2: to.y,
    })
  }
  return links
}

/** The hovered node's lineage: its ancestor chain plus its whole subtree — the set of
 * node ids whose links light up under lineage focus. Null for no id or an unknown one. */
export function lineageOf(forest: AgentForest, id: string | null): Set<string> | null {
  if (id === null) return null
  const byId = new Map(forest.nodes.map(n => [n.id, n]))
  const start = byId.get(id)
  if (start === undefined) return null
  const lit = new Set<string>()
  let cur: AgentNode | undefined = start
  while (cur !== undefined) {
    lit.add(cur.id)
    cur = cur.parentId !== undefined ? byId.get(cur.parentId) : undefined
  }
  const queue = [id]
  for (let i = 0; i < queue.length; i++) {
    for (const n of forest.nodes) {
      if (n.parentId === queue[i] && !lit.has(n.id)) {
        lit.add(n.id)
        queue.push(n.id)
      }
    }
  }
  return lit
}

export interface BarSeg {
  key: string
  /** Segment color; the free remainder is styled by the bar's track instead. */
  color: string
  /** Share of the whole bar (0..1) — occupancy scales the composition, the free share closes it. */
  share: number
  free: boolean
}

/** Threshold color for pressure-only fills (no composition data) and the card's pct figure. */
export function pressureColorOf(pct: number | null): string {
  if (pct === null) return 'var(--dsw-alias-border-l1)'
  if (pct >= 90) return 'var(--color-red-500)'
  if (pct >= 70) return 'var(--color-amber-500)'
  return 'var(--color-green-500)'
}

/** One composition bar per agent — the chat composer ring's own semantics, flattened: the
 * composition parts, scaled to the occupancy share, fill the bar and a neutral remainder marks
 * the free window. No known window fills the whole bar; no composition falls back to a single
 * threshold-colored occupancy fill. */
export function barSegments(parts: PartsPart[], pct: number | null, fallbackColor: string): BarSeg[] {
  const occ = pct === null ? 1 : Math.min(100, Math.max(0, pct)) / 100
  let total = 0
  for (const p of parts) total += p.value > 0 ? p.value : 0
  const segs: BarSeg[] = []
  let acc = 0
  if (total > 0) {
    for (const p of parts) {
      if (p.value <= 0) continue
      const share = (p.value / total) * occ
      if (share <= 0) continue
      segs.push({ key: p.key, color: p.color, share, free: false })
      acc += share
    }
  } else if (pct !== null && occ > 0) {
    segs.push({ key: 'fill', color: fallbackColor, share: occ, free: false })
    acc = occ
  }
  if (pct !== null && acc < 1) {
    segs.push({ key: 'free', color: '', share: 1 - acc, free: true })
  }
  return segs
}

export function sessionsFaceOf(ctx: { get(name: string): unknown }): SessionsFaceLike | null {
  const rec = asRecord(ctx.get('sessions'))
  if (rec === null) return null
  const list = asRecord(rec.list)
  if (list === null || typeof list.getSnapshot !== 'function' || typeof list.subscribe !== 'function') return null
  return rec
}

/** Compact duration: `42s`, `3m05s`, `1h07m`. Distinct from format.ts's
 * `fmtDuration`, whose decimal seconds the inspector's fixed-width caption column cannot use. */
export function fmtDurationCompact(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}
