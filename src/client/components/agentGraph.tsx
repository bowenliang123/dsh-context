/**
 * The Agent network card — the foot of the Context tab: the current agent's
 * whole family (ancestors, siblings, subagents) as a node graph, where every
 * node is a live donut of that session's own context composition ringed by
 * its occupancy, and a click jumps to that agent's session.
 *
 * Data rides the harness's existing planes end to end — the session-list
 * snapshot (`ctx.sessions.list`: lineage rows + per-session projection
 * values) and the tab's own projections for the current node — so the card
 * adds no RPC of its own beyond one direct-child catalog refresh per
 * session. A harness without the outward sessions service hides the card.
 */

import type * as ReactNS from 'react'
import { CATS } from '../categories'
import type { ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import type { AgentNode, AgentSelfStats } from '../agentTree'
import {
  AGENT_NODE_R,
  AGENT_RING_R,
  agentForestOf,
  fmtDurationCompact,
  layoutForest,
  openAgentSession,
  ringSegments,
  sessionsFaceOf,
} from '../agentTree'

import { React } from '../react'

export interface AgentGraphProps {
  sessionId?: string
  /** Live stats of the current session from the tab's own projections. */
  self?: AgentSelfStats
}

/** Caption box height under a node (3 wrapped label lines + the tokens line). */
const CAPTION_H = 60

/** Fallback arc color for pressure-only nodes (no composition data), by fill ratio. */
export function ringColorOf(pct: number | null): string {
  if (pct === null) return 'var(--dsw-alias-border-l1)'
  if (pct >= 90) return '#ef4444'
  if (pct >= 70) return '#f59e0b'
  return '#22c55e'
}

export function makeAgentGraph(
  ctx: ClientCtx,
  kit: ViewKit,
): (props: AgentGraphProps) => ReactNS.ReactElement | null {
  const { t, fmt, catLabel } = kit

  function AgentGraph(props: AgentGraphProps): ReactNS.ReactElement | null {
    // Resolved lazily at mount (not at apply): the outward sessions service
    // belongs to the client runtime's composition, and a deployment without
    // it simply keeps the card hidden.
    const face = React.useMemo(() => sessionsFaceOf(ctx), [])
    const subscribe = React.useCallback((fn: () => void) => {
      if (face === null) return () => {}
      /* v8 ignore next 2 -- sessionsFaceOf returns a face only after proving list.subscribe. */
      if (face.list === undefined) return () => {}
      return face.list.subscribe(fn)
    }, [face])
    const getSnapshot = React.useCallback(() => {
      if (face === null) return null
      /* v8 ignore next 2 -- sessionsFaceOf proves list before returning the face. */
      if (face.list === undefined) return null
      return face.list.getSnapshot()
    }, [face])
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot)
    const sessionId = props.sessionId
    const [hoverId, setHoverId] = React.useState<string | null>(null)

    // The layout is fully responsive: re-run it whenever the stage's visible
    // width changes (sidebar toggles, window resizes, split views).
    const stageRef = React.useRef<HTMLDivElement | null>(null)
    const [stageWidth, setStageWidth] = React.useState(0)
    React.useEffect(() => {
      /* v8 ignore start -- jsdom has neither ResizeObserver nor layout; tests exercise the natural-pitch fallback (stageWidth 0). */
      const el = stageRef.current
      if (el === null || typeof ResizeObserver !== 'function') return
      setStageWidth(el.clientWidth)
      const observer = new ResizeObserver(() => { setStageWidth(el.clientWidth) })
      observer.observe(el)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [])

    // Discover the current session's direct-child catalog once per session:
    // catalog-derived children join the list rows (and gain navigation
    // addresses). Fire-and-forget — the card renders from list rows alone.
    React.useEffect(() => {
      if (face === null || typeof sessionId !== 'string' || sessionId === '') return
      if (typeof face.refreshSubagents !== 'function') return
      face.refreshSubagents(sessionId).catch(() => {})
    }, [face, sessionId])

    const built = React.useMemo(() => {
      const forest = agentForestOf(snapshot, sessionId, props.self)
      return forest !== null ? { forest, layout: layoutForest(forest, stageWidth) } : null
    }, [snapshot, sessionId, props.self, stageWidth])

    if (built === null) return null
    const { forest, layout } = built
    const byId = new Map(forest.nodes.map(n => [n.id, n]))
    /* v8 ignore next 1 -- agentForestOf anchors the forest at the current
       session, so a current node always exists. */
    const current = forest.nodes.find(n => n.isCurrent) ?? forest.nodes[0]
    const inspected = (hoverId !== null ? byId.get(hoverId) : undefined) ?? current
    const runningCount = forest.nodes.filter(n => n.running).length
    let totalTokens = 0
    for (const n of forest.nodes) totalTokens += n.head !== null ? n.head.tokens : 0

    const open = (id: string): void => {
      if (id === current.id) return
      openAgentSession(face, id)
    }
    const keyOpen = (id: string) => (ev: ReactNS.KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      open(id)
    }

    return (
      <div className="lc-card lc-agents">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('agents.title')}</span>
          <span className="lc-card-sub">{t('agents.sub')}</span>
        </div>

        <div className="lc-agents-chips">
          <span className="lc-agents-chip">{t('agents.chip.count', { n: forest.nodes.length + forest.overflow })}</span>
          <span className={'lc-agents-chip' + (runningCount > 0 ? ' lc-agents-chip-on' : '')}>
            {t('agents.chip.running', { n: runningCount })}
          </span>
          {totalTokens > 0
            ? <span className="lc-agents-chip">{t('agents.chip.tokens', { n: fmt(totalTokens) })}</span>
            : null}
          {forest.overflow > 0
            ? <span className="lc-agents-chip">{t('agents.more', { n: forest.overflow })}</span>
            : null}
        </div>

        <div className="lc-agents-stage" ref={stageRef}>
          <svg
            className="lc-agents-svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {layout.links.map((link) => {
              // Direct segment per link, colored by the child's family; a
              // running child layers a flowing pulse of the same hue on top.
              const d = `M ${link.x1} ${link.y1} L ${link.x2} ${link.y2}`
              return (
                <g key={link.to}>
                  <path
                    className={'lc-agents-link' + (link.running ? ' lc-agents-link-live' : '')}
                    d={d}
                    stroke={link.color}
                    fill="none"
                  />
                  {link.running ? <path className="lc-agents-flow" d={d} stroke={link.color} fill="none" /> : null}
                </g>
              )
            })}
            {forest.nodes.map((node) => {
              const point = layout.points.find(p => p.id === node.id)
              /* v8 ignore next 2 -- layoutForest positions every forest node,
                 so the lookup never misses. */
              if (point === undefined) return null
              return (
                <AgentNodeView
                  key={node.id}
                  node={node}
                  x={point.x}
                  y={point.y}
                  captionW={layout.captionW}
                  hovered={hoverId === node.id}
                  onHover={setHoverId}
                  onOpen={open}
                  onKeyOpen={keyOpen(node.id)}
                  t={t}
                  fmt={fmt}
                />
              )
            })}
          </svg>
        </div>

        {forest.solo ? <div className="lc-empty lc-agents-solo">{t('agents.solo')}</div> : null}

        <Inspector node={inspected} t={t} fmt={fmt} />
        <div className="lc-agents-legend">
          {CATS.map(c => (
            <span key={c.key} className="lc-agents-legend-item">
              <i style={{ background: c.color }} />
              {catLabel(c.key)}
            </span>
          ))}
          <span className="lc-agents-legend-item">
            <i className="lc-agents-legend-free" />
            {t('agents.legend.free')}
          </span>
          <span className="lc-agents-legend-item">
            <i className="lc-agents-legend-edge" />
            {t('agents.running')}
          </span>
        </div>
      </div>
    )
  }

  return AgentGraph
}

interface NodeViewProps {
  node: AgentNode
  x: number
  y: number
  /** Label box width from the responsive layout (narrows as slots compress). */
  captionW: number
  hovered: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  onKeyOpen: (ev: ReactNS.KeyboardEvent) => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

function AgentNodeView(props: NodeViewProps): ReactNS.ReactElement {
  const { node, x, y, captionW } = props
  const pct = node.head !== null ? node.head.pct : null
  const ring = 2 * Math.PI * AGENT_RING_R
  const segs = node.head !== null ? ringSegments(node.head.parts, pct, AGENT_RING_R, ringColorOf(pct)) : []
  const cls = 'lc-agent-node'
    + (node.isCurrent ? ' lc-agent-self' : '')
    + (node.running ? ' lc-agent-running' : '')
    + (node.completed && !node.running ? ' lc-agent-done' : '')
    + (props.hovered ? ' lc-agent-hover' : '')
    + (node.isCurrent ? '' : ' lc-agent-clickable')
  return (
    <g
      className={cls}
      transform={`translate(${x}, ${y})`}
      data-agent={node.id}
      role={node.isCurrent ? 'img' : 'button'}
      tabIndex={node.isCurrent ? undefined : 0}
      onClick={() => { props.onOpen(node.id) }}
      onKeyDown={props.onKeyOpen}
      onMouseEnter={() => { props.onHover(node.id) }}
      onMouseLeave={() => { props.onHover(null) }}
    >
      {/* Halo carries the state: wash for self, breathing green while running, faint green for done. */}
      <circle className="lc-agent-halo" r={AGENT_NODE_R + 9} />
      <circle className="lc-agent-track" r={AGENT_NODE_R} />
      {segs.map(seg => (
        <circle
          key={seg.key}
          className={'lc-agent-seg' + (seg.free ? ' lc-agent-free' : '')}
          r={AGENT_RING_R}
          stroke={seg.free ? undefined : seg.color}
          strokeDasharray={`${seg.len} ${ring - seg.len}`}
          strokeDashoffset={-seg.offset}
          transform="rotate(-90)"
        />
      ))}
      <text className="lc-agent-pct" textAnchor="middle" dy="0.32em">
        {pct !== null ? `${pct}%` : (node.head !== null ? props.fmt(node.head.tokens) : '—')}
      </text>
      {/* HTML caption (foreignObject): the full label wraps instead of truncating;
          the current agent is marked in text, keeping every node's ring semantics identical. */}
      <foreignObject x={-captionW / 2} y={AGENT_NODE_R + 8} width={captionW} height={CAPTION_H}>
        <div className="lc-agent-caption">
          <div className="lc-agent-label">
            {node.label}
            {node.isCurrent ? <span className="lc-agents-badge lc-agent-self-badge">{props.t('agents.self')}</span> : null}
          </div>
          <div className="lc-agent-tokens">{node.head !== null ? props.fmt(node.head.tokens) : '—'}</div>
        </div>
      </foreignObject>
    </g>
  )
}

/** The detail strip mirroring the hovered (or current) node: identity, occupancy, activity, and the open hint. */
function Inspector(props: { node: AgentNode; t: ViewKit['t']; fmt: ViewKit['fmt'] }): ReactNS.ReactElement {
  const { node, t, fmt } = props
  const bits: string[] = []
  if (node.head !== null) {
    const head = node.head
    const window = head.window !== undefined ? ` / ${fmt(head.window)}` : ''
    const pct = head.pct !== null ? ` · ${head.pct}%` : ''
    bits.push(`${fmt(head.tokens)}${window}${pct}`)
  }
  if (node.requests > 0) bits.push(t('agents.requests', { n: node.requests }))
  if (node.billed !== null && node.billed > 0) bits.push(t('agents.billed', { n: fmt(node.billed) }))
  if (node.durationMs !== null) bits.push(fmtDurationCompact(node.durationMs))
  return (
    <div className="lc-agents-inspector">
      <b className="lc-agents-inspector-name">{node.label}</b>
      {node.isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
      {node.running ? <span className="lc-agents-badge lc-agents-badge-on">{t('agents.running')}</span> : null}
      {node.identity !== null
        ? <span className="lc-agents-badge">{t(node.identity.mode === 'one-shot' ? 'agents.oneshot' : 'agents.continuable')}</span>
        : null}
      <span className="lc-agents-inspector-stats">{bits.join(' · ')}</span>
      {!node.isCurrent ? <span className="lc-agents-inspector-open">{t('agents.open')}</span> : null}
    </div>
  )
}
