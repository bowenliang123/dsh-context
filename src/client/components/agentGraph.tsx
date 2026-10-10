/**
 * The Agent network card — the head of the Fleet tab, and (compact) the right Sidebar's Context
 * panel. The current agent's whole family (ancestors, siblings, subagents) as a node graph, where
 * every node is a live card of that session's own context — title, occupancy, and a composition
 * bar — and a click jumps to that agent's session. Links are bezier curves fanned out from the
 * parent's foot, hued per level-1 family; hovering a card lights its whole lineage (ancestors and
 * subtree).
 *
 * The card splits in two on wide-enough panes (the `lc-card` container query folds it to stacked
 * on the narrow Sidebar): the graph on the left, the inspector (agentInspector.tsx) on the right,
 * following the hovered card, the pinned pick, or the current session.
 *
 * The forest derivation lives in fleetModel.ts (`useFleetModel`): the Fleet tab derives it once
 * and passes it in (`forest`/`team`), so every panel reads the same family; the sidebar mount
 * leaves both undefined and the card derives its own. Fleet-only extras (pinning, team membership,
 * fleet-detail prompts and comms) arrive through `extras`; the sidebar mount passes none and the
 * inspector renders its stats-and-composition core alone.
 */

import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { IconWorkspaceTreeOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { CATS } from '../categories'
import type { AgentHeads } from '../agentHeads'
import { makeAgentHeads } from '../agentHeads'
import { billedTokensOf, estimateSessionCost, formatCost, type CostCurrency, type ModelBook } from '../cost'
import { useModelPrices } from '../modelPrices'
import { containHorizontalOverscroll } from '../overscroll'
import { openSessionVia, type ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import type { FleetDetail, FleetMemberInfo } from '../../shared/types'
import type { CommsRow } from '../fleetDetail'
import { useFleetModel } from '../fleetModel'
import type { FleetTeam } from '../fleetTeam'
import type { AgentForest, AgentNode, AgentSelfStats } from '../agentTree'
import {
  barSegments,
  fmtDurationCompact,
  layoutForest,
  lineageOf,
  pressureColorOf,
} from '../agentTree'
import { AgentInspector } from './agentInspector'

/** The Fleet tab's enrichment of the inspector: pin state, team roster, and the fleet-detail reads. */
export interface AgentGraphExtras {
  team: FleetTeam | null
  pinnedId: string | null
  onPin: (id: string | null) => void
  /** The landed fleet-detail read of one session; undefined while in flight. */
  detailOf: (id: string) => { detail: FleetDetail | null } | undefined
  /** Merged comms rows involving one session. */
  commsOf: (id: string) => CommsRow[]
  labelOf: (id: string) => string
  /** The lead's roster facts (duty descriptions) off its landed fleet detail. */
  roster: readonly FleetMemberInfo[]
  /** An inspector task chip flashes the task on the task board. */
  onFocusTask: (id: string | null) => void
}

export interface AgentGraphProps {
  sessionId?: string
  /** Live stats of the current session from the tab's own projections (internal derivation only). */
  self?: AgentSelfStats
  /** The Fleet tab's shared derivation; undefined = the card derives its own (the sidebar mount). */
  forest?: AgentForest | null
  /** Controlled hover (the Fleet tab lifts it so the list rows light graph nodes too). */
  hoverId?: string | null
  onHover?: (id: string | null) => void
  /** The Fleet tab's enrichment; its `team` (possibly null) is the family's team projection then. */
  extras?: AgentGraphExtras
}

/** Entrance stagger cap for the cards and their bar segments (the stackedBar idiom). */
const STAGGER_CAP = 8

/** The link's S-curve: vertical tangents at both card edges, curvature proportional to the drop, clamped to [24, 96]. */
function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  const k = Math.min(96, Math.max(24, (y2 - y1) * 0.5))
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
}

export function makeAgentGraph(
  ctx: ClientCtx,
  kit: ViewKit,
  /** The shared page-scope cold-head cache — the stats board's subagent-cost cell reads the same fetches. */
  heads: AgentHeads = makeAgentHeads(),
): (props: AgentGraphProps) => ReactElement | null {
  const { t, fmt, catLabel } = kit

  /** The display currency follows the active locale — read per render: the slot outlet re-renders on a locale switch. */
  function activeCurrency(): CostCurrency {
    const locale = ctx.locale
    return typeof locale.getLocale === 'function' && locale.getLocale().active === 'zh' ? 'cny' : 'usd'
  }

  function AgentGraph(props: AgentGraphProps): ReactElement | null {
    const sessionId = props.sessionId
    // The internal derivation runs only when the caller passes no forest in; the flag is a
    // mount-stable prop split (the Fleet tab always passes one, the sidebar never does).
    const internal = useFleetModel(ctx, heads, sessionId, props.self, props.forest === undefined)
    const forest = props.forest !== undefined ? props.forest : internal.forest
    const team = props.extras !== undefined ? props.extras.team : internal.team

    const [internalHover, setInternalHover] = useState<string | null>(null)
    const hoverId = props.hoverId !== undefined ? props.hoverId : internalHover
    const onHover = props.onHover ?? setInternalHover
    // The shared price book (the stats board's own store): a card's cost estimate
    // appears once the book lands, and never blocks the rest of the card.
    const { book } = useModelPrices()
    const currency = activeCurrency()

    // The layout is fully responsive: re-run it whenever the stage's visible
    // width changes (sidebar toggles, window resizes, split views).
    const stageRef = useRef<HTMLDivElement | null>(null)
    const [stageWidth, setStageWidth] = useState(0)
    useEffect(() => {
      /* v8 ignore start -- jsdom has neither ResizeObserver nor layout; tests exercise the natural-pitch fallback (stageWidth 0). */
      const el = stageRef.current
      if (el === null || typeof ResizeObserver !== 'function') return
      // contentRect, not clientWidth: the stage's 4px side padding is breathing room for
      // hover shadows, and sizing to clientWidth would overshoot the content box by exactly
      // that padding, arming a phantom horizontal scrollbar whenever the layout fits exactly.
      const observer = new ResizeObserver(([entry]) => { setStageWidth(entry.contentRect.width) })
      observer.observe(el)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [])
    // A horizontal swipe running off the stage's edge must not chain into the browser's history navigation
    // (overscroll.ts): the sheet's overscroll-behavior-x covers Chromium/Firefox, this covers WebKit.
    useEffect(() => {
      const el = stageRef.current
      /* v8 ignore next 1 -- the stage renders whenever the card does, and React
         attaches refs before effects run; el is never null here. */
      if (el === null) return
      return containHorizontalOverscroll(el)
    }, [])

    const layout = useMemo(() => (forest !== null ? layoutForest(forest, stageWidth) : null), [forest, stageWidth])

    if (forest === null || layout === null) return null
    const byId = new Map(forest.nodes.map(n => [n.id, n]))
    /** v8 ignore next 1 -- agentForestOf anchors the forest at the current session, so a current node always exists. */
    const current = forest.nodes.find(n => n.isCurrent) ?? forest.nodes[0]
    const pinnedId = props.extras?.pinnedId ?? null
    const pinnedNode = pinnedId !== null ? byId.get(pinnedId) : undefined
    const hoverNode = hoverId !== null ? byId.get(hoverId) : undefined
    const inspected = pinnedNode ?? hoverNode ?? current
    const runningCount = forest.nodes.filter(n => n.running).length
    let totalTokens = 0
    for (const n of forest.nodes) totalTokens += n.head !== null ? n.head.tokens : 0

    // The hovered card's lineage (ancestor chain + own subtree) lights its links; the rest dim.
    const lit = lineageOf(forest, hoverId)

    const open = (id: string): void => {
      if (id === current.id) return
      openSessionVia(ctx, id)
    }
    const keyOpen = (id: string) => (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      open(id)
    }

    const extras = props.extras
    const inspector = (
      <AgentInspector
        node={inspected}
        pinned={pinnedNode !== undefined}
        team={team ?? null}
        detail={extras !== undefined ? extras.detailOf(inspected.id) : nullDetail}
        roster={extras?.roster ?? []}
        comms={extras !== undefined ? extras.commsOf(inspected.id) : []}
        labelOf={extras?.labelOf ?? fallbackLabel(byId)}
        onOpen={open}
        onPin={extras?.onPin ?? noopPin}
        onFocusTask={extras?.onFocusTask ?? noopPin}
        t={t}
        fmt={fmt}
        catLabel={catLabel}
      />
    )

    return (
      <div className="lc-card lc-agents">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconWorkspaceTreeOutlineRegular size={14} />
            {t('agents.title')}
          </span>
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
          {team !== null
            ? (
              <span className="lc-agents-chip lc-agents-chip-team">
                {t('fleet.teamChip', { m: team.members.length, n: team.tasks.length })}
              </span>
            )
            : null}
          {forest.overflow > 0
            ? <span className="lc-agents-chip">{t('agents.more', { n: forest.overflow })}</span>
            : null}
        </div>

        <div className="lc-agents-split">
          <div className="lc-agents-main">
            <div className="lc-agents-stage" ref={stageRef}>
              <div className="lc-agents-canvas" style={{ width: layout.width, height: layout.height }}>
                <svg
                  className={'lc-agents-links' + (lit !== null ? ' lc-agents-focus' : '')}
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                >
                  {layout.links.map((link) => {
                    const d = linkPath(link.x1, link.y1, link.x2, link.y2)
                    const on = lit !== null && lit.has(link.to)
                    return (
                      <g key={link.to} className={on ? 'lc-agents-on' : undefined}>
                        <path
                          className={'lc-agents-link stroke-[1.5px]' + (link.running ? ' lc-agents-link-live' : '')}
                          d={d}
                          stroke={link.color}
                          fill="none"
                        />
                        {link.running
                          ? <path className="lc-agents-flow animate-lc-agent-flow fill-none stroke-2" d={d} stroke={link.color} />
                          : null}
                        <circle className="lc-agents-joint" cx={link.x1} cy={link.y1} r={2} fill={link.color} />
                        <circle className="lc-agents-joint" cx={link.x2} cy={link.y2} r={3} fill={link.color} />
                      </g>
                    )
                  })}
                </svg>
                {forest.nodes.map((node, index) => {
                  const point = layout.points.find(p => p.id === node.id)
                  /** v8 ignore next 2 -- layoutForest positions every forest node, so the lookup never misses. */
                  if (point === undefined) return null
                  return (
                    <AgentCard
                      key={node.id}
                      node={node}
                      x={point.x}
                      y={point.y}
                      width={layout.cardW}
                      index={index}
                      hovered={hoverId === node.id}
                      pinned={pinnedId === node.id}
                      onHover={onHover}
                      onOpen={open}
                      onKeyOpen={keyOpen(node.id)}
                      book={book}
                      currency={currency}
                      t={t}
                      fmt={fmt}
                    />
                  )
                })}
              </div>
            </div>

            {forest.solo ? <div className="lc-empty lc-agents-solo">{t('agents.solo')}</div> : null}

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

          {inspector}
        </div>
      </div>
    )
  }

  return AgentGraph
}

/** The sidebar mount's inspector carries no fleet-detail read: a settled-empty detail hides those sections. */
const nullDetail: { detail: FleetDetail | null } = { detail: null }
/* v8 ignore next -- the unpin/focus callbacks exist only with the Fleet tab's extras. */
const noopPin = (): void => {}

/** Without the Fleet tab's label resolver, sender labels fall back to the forest's own rows. */
/* v8 ignore next 2 -- without extras the inspector's comms list is always empty, so this never fires. */
function fallbackLabel(byId: ReadonlyMap<string, AgentNode>): (id: string) => string {
  return id => byId.get(id)?.label ?? id
}

interface CardProps {
  node: AgentNode
  /** Card center x and top y in canvas coordinates; the card box derives from them. */
  x: number
  y: number
  width: number
  /** DFS order — the entrance stagger slot. */
  index: number
  hovered: boolean
  /** The list/team/comms pick this card echoes with a ring. */
  pinned: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  onKeyOpen: (ev: KeyboardEvent) => void
  /** The price book and display currency for the cost estimate (null book → no estimate shown). */
  book: ModelBook | null
  currency: CostCurrency
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

function AgentCard(props: CardProps): ReactElement {
  const { node, x, y, width } = props
  const pct = node.head !== null ? node.head.pct : null
  const segs = node.head !== null ? barSegments(node.head.parts, pct, pressureColorOf(pct)) : []
  // The headline figure is the agent's CONSUMPTION: the tokenUsage tally, with the
  // fold's own cost ledger standing in when the tally is absent (cold relatives).
  const consumed = node.billed !== null && node.billed > 0 ? node.billed
    : node.costUsage !== null ? billedTokensOf(node.costUsage) : null
  const cost = estimateSessionCost(node.costUsage, props.book, props.currency)
  const metricBits: string[] = []
  if (consumed !== null && consumed > 0) metricBits.push(props.fmt(consumed))
  if (cost !== null) metricBits.push(formatCost(cost, props.currency))
  // Activity footer: the run's duration, then its step count. Either bit may be missing —
  // a node that never ran has no steps, a cold one no timing yet.
  const meta: string[] = []
  if (node.durationMs !== null) meta.push(fmtDurationCompact(node.durationMs))
  if (node.requests > 0) meta.push(props.t('agents.steps', { n: node.requests }))
  const cls = 'lc-agent-card animate-lc-agent-in motion-reduce:animate-none'
    + (node.isCurrent ? ' lc-agent-self' : '')
    // lc-agent-hover carries no rule of its own — the hover/focus wash rides
    // :hover/:focus-visible; the class stays as the specs' state anchor.
    + (props.hovered ? ' lc-agent-hover' : '')
    + (props.pinned ? ' lc-agent-pinned' : '')
    + (node.isCurrent ? '' : ' lc-agent-clickable')
  return (
    <div
      className={cls}
      style={{ left: x - width / 2, top: y, width, '--lc-i': Math.min(props.index, STAGGER_CAP) } as CSSProperties}
      data-agent={node.id}
      role={node.isCurrent ? undefined : 'button'}
      tabIndex={node.isCurrent ? undefined : 0}
      onClick={() => { props.onOpen(node.id) }}
      onKeyDown={props.onKeyOpen}
      onMouseEnter={() => { props.onHover(node.id) }}
      onMouseLeave={() => { props.onHover(null) }}
      onFocus={() => { props.onHover(node.id) }}
      onBlur={() => { props.onHover(null) }}
    >
      <div className="lc-agent-card-head">
        {node.running || node.completed
          ? <StateDot state={node.running ? 'ongoing' : 'done'} size={11} className="lc-agent-state" />
          : null}
        <div className="lc-agent-label">{node.label}</div>
        {/* The badge sits OUTSIDE the clamped label: an inline badge would be clipped away
            whenever a long title claims both lines. The lc-agent-self-badge class carries no
            rule of its own — it stays as the specs' anchor for the self marker. */}
        {node.isCurrent ? <span className="lc-agents-badge lc-agent-self-badge">{props.t('agents.self')}</span> : null}
      </div>
      <div className="lc-agent-metric">
        <b className="lc-agent-tokens">{metricBits.length > 0 ? metricBits.join(' · ') : '—'}</b>
      </div>
      {/* The free remainder is the bar's own track, so only occupied segments render. */}
      <div className="lc-agent-bar">
        {segs.filter(seg => !seg.free).map((seg, i) => (
          <i
            key={seg.key}
            className="lc-agent-bar-seg animate-lc-stacked-in motion-reduce:animate-none"
            style={{ width: `${seg.share * 100}%`, background: seg.color, '--lc-i': Math.min(i, STAGGER_CAP) } as CSSProperties}
          />
        ))}
      </div>
      {meta.length > 0 || pct !== null ? (
        <div className="lc-agent-meta">
          <span className="lc-agent-meta-text">{meta.join(' · ')}</span>
          {pct !== null ? <span className="lc-agent-pct" style={{ color: pressureColorOf(pct) }}>{pct}%</span> : null}
        </div>
      ) : null}
    </div>
  )
}
