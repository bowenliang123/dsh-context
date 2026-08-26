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
  AGENT_INNER_R,
  AGENT_NODE_R,
  agentForestOf,
  donutSegments,
  fmtDuration,
  layoutForest,
  openAgentSession,
  sessionsFaceOf,
} from '../agentTree'

import { React } from '../react'

export interface AgentGraphProps {
  sessionId?: string
  /** Live stats of the current session from the tab's own projections. */
  self?: AgentSelfStats
}

/** Caption box under a node: wraps freely so full agent names always show. */
const CAPTION_W = 136
const CAPTION_H = 60

/** Occupancy-ring color by fill ratio (no window → the neutral track color). */
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

    // Discover the current session's direct-child catalog once per session:
    // catalog-derived children join the list rows (and gain navigation
    // addresses). Fire-and-forget — the card renders from list rows alone.
    React.useEffect(() => {
      if (face === null || typeof sessionId !== 'string' || sessionId === '') return
      if (typeof face.refreshSubagents !== 'function') return
      face.refreshSubagents(sessionId).catch(() => {})
    }, [face, sessionId])

    const forest = React.useMemo(
      () => agentForestOf(snapshot, sessionId, props.self),
      [snapshot, sessionId, props.self],
    )
    if (forest === null) return null

    const layout = layoutForest(forest)
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

        <div className="lc-agents-stage">
          <svg
            className="lc-agents-svg"
            width={layout.width}
            height={layout.height}
            viewBox={`0 0 ${layout.width} ${layout.height}`}
          >
            {layout.links.map(link => (
              <path
                key={link.to}
                className={'lc-agents-link' + (link.running ? ' lc-agents-link-on' : '')}
                d={`M ${link.x1} ${link.y1} C ${link.x1} ${link.y1 + 18}, ${link.x2} ${link.y2 - 18}, ${link.x2} ${link.y2}`}
                fill="none"
              />
            ))}
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
  hovered: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  onKeyOpen: (ev: ReactNS.KeyboardEvent) => void
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

function AgentNodeView(props: NodeViewProps): ReactNS.ReactElement {
  const { node, x, y } = props
  const pct = node.head !== null ? node.head.pct : null
  const segs = node.head !== null ? donutSegments(node.head.parts, AGENT_INNER_R) : []
  const ring = 2 * Math.PI * AGENT_NODE_R
  const fill = pct !== null ? ring * Math.min(100, pct) / 100 : 0
  const cls = 'lc-agent-node'
    + (node.isCurrent ? ' lc-agent-self' : '')
    + (node.running ? ' lc-agent-running' : '')
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
      <circle className="lc-agent-halo" r={AGENT_NODE_R + 9} />
      <circle className="lc-agent-track" r={AGENT_NODE_R} />
      {pct !== null && pct > 0
        ? (
          <circle
            className="lc-agent-ring"
            r={AGENT_NODE_R}
            stroke={ringColorOf(pct)}
            strokeDasharray={`${fill} ${ring - fill}`}
            transform="rotate(-90)"
          />
        )
        : null}
      {segs.map(seg => (
        <circle
          key={seg.key}
          className="lc-agent-seg"
          r={AGENT_INNER_R}
          stroke={seg.color}
          strokeDasharray={`${seg.len} ${2 * Math.PI * AGENT_INNER_R - seg.len}`}
          strokeDashoffset={-seg.offset}
          transform="rotate(-90)"
        />
      ))}
      <text className="lc-agent-pct" textAnchor="middle" dy="0.32em">
        {pct !== null ? `${pct}%` : (node.head !== null ? props.fmt(node.head.tokens) : '—')}
      </text>
      <circle
        className={'lc-agent-dot' + (node.running ? ' lc-agent-dot-on' : node.completed ? ' lc-agent-dot-done' : '')}
        cx={AGENT_NODE_R * 0.72}
        cy={AGENT_NODE_R * 0.72}
        r={4}
      />
      {/* HTML caption (foreignObject): the full label wraps instead of truncating. */}
      <foreignObject x={-CAPTION_W / 2} y={AGENT_NODE_R + 8} width={CAPTION_W} height={CAPTION_H}>
        <div className="lc-agent-caption">
          <div className="lc-agent-label">{node.label}</div>
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
  if (node.durationMs !== null) bits.push(fmtDuration(node.durationMs))
  return (
    <div className="lc-agents-inspector">
      <span className={'lc-agent-dot' + (node.running ? ' lc-agent-dot-on' : node.completed ? ' lc-agent-dot-done' : '')} />
      <b className="lc-agents-inspector-name">{node.label}</b>
      {node.isCurrent ? <span className="lc-agents-badge">{t('agents.self')}</span> : null}
      {node.identity !== null
        ? <span className="lc-agents-badge">{t(node.identity.mode === 'one-shot' ? 'agents.oneshot' : 'agents.continuable')}</span>
        : null}
      <span className="lc-agents-inspector-stats">{bits.join(' · ')}</span>
      {!node.isCurrent ? <span className="lc-agents-inspector-open">{t('agents.open')}</span> : null}
    </div>
  )
}
