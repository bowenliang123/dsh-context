import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactElement } from 'react'
import { IconWorkspaceTreeOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { CATS } from '../categories'
import type { AgentHeads } from '../agentHeads'
import { makeAgentHeads } from '../agentHeads'
import { billedTokensOf, displayCurrencyOf, estimateSessionCost, formatCost, type CostCurrency, type ModelBook } from '../cost'
import { avatarLabelsOf, avatarNameOf, type CommsAgent, type CommsRole } from '../commsModel'
import { useModelPrices } from '../modelPrices'
import { containHorizontalOverscroll } from '../overscroll'
import { scrollIntoViewIfPossible, scrollToPos } from '../revealScroll'
import { openSessionVia, type ClientCtx } from '../services'
import type { ViewKit } from '../viewkit'
import type { FleetDetail } from '../../shared/types'
import { useFleetModel } from '../fleetModel'
import { teammateNameOf, teamMemberOf, type FleetTeam, type FleetTeamMember } from '../fleetTeam'
import type { AgentForest, AgentNode, AgentSelfStats } from '../agentTree'
import {
  AGENT_CARD_COMPACT_H,
  AGENT_CARD_H,
  LEAD_HUE,
  barSegments,
  familyHue,
  fmtDurationCompact,
  layoutForest,
  neighborhoodOf,
  pressureColorOf,
} from '../agentTree'
import { AgentInspector } from './agentInspector'
import { AgentAvatar } from './commsAgent'
function memberStyle(hue: string): CSSProperties {
  return { '--lc-member-hue': hue } as CSSProperties
}

export interface AgentGraphProps {
  sessionId?: string
  compact?: boolean
  self?: AgentSelfStats
  forest?: AgentForest | null
  team?: FleetTeam | null
  pinnedId?: string | null
  hoverId?: string | null
  focusId?: string | null
  onHover?: (id: string | null) => void
  onSelect?: (id: string) => void
  inspector?: boolean
}

const STAGGER_CAP = 8
const STAGE_H = 560
const GRAPH_OVERSCAN = 320
const GRAPH_WINDOW_SEED = 60

function hueOf(node: AgentNode, team: FleetTeam | null, members: readonly FleetTeamMember[]): string {
  const member = teamMemberOf(team, node.id)
  return member?.role === 'lead' ? LEAD_HUE
    : member !== null ? familyHue(members.indexOf(member))
      : node.isCurrent ? LEAD_HUE : familyHue(node.family)
}

function linkPath(x1: number, y1: number, x2: number, y2: number): string {
  const k = Math.min(96, Math.max(24, (y2 - y1) * 0.5))
  return `M ${x1} ${y1} C ${x1} ${y1 + k}, ${x2} ${y2 - k}, ${x2} ${y2}`
}

function avatarIdentityOf(team: FleetTeam | null, node: AgentNode, t: ViewKit['t']): { name: string; role: CommsRole } {
  const member = teamMemberOf(team, node.id)
  const role: CommsRole = member === null ? (node.isCurrent ? 'agent' : 'subagent') : member.role
  return { name: avatarNameOf(member === null ? node.label : member.name, role, t), role }
}

export function makeAgentGraph(
  ctx: ClientCtx,
  kit: ViewKit,
  heads: AgentHeads = makeAgentHeads(),
): (props: AgentGraphProps) => ReactElement | null {
  const { t, fmt, catLabel } = kit

  function AgentGraph(props: AgentGraphProps): ReactElement | null {
    const sessionId = props.sessionId
    const internal = useFleetModel(ctx, heads, sessionId, props.self, props.forest === undefined)
    const forest = props.forest !== undefined ? props.forest : internal.forest
    const team = props.team !== undefined ? props.team : internal.team
    const members = team?.members ?? []

    const [internalHover, setInternalHover] = useState<string | null>(null)
    const [showAll, setShowAll] = useState(false)
    useEffect(() => { setShowAll(false) }, [sessionId])
    const hoverId = props.hoverId !== undefined ? props.hoverId : internalHover
    const focusId = hoverId ?? (props.focusId ?? null)
    const pinnedId = props.pinnedId ?? null
    const litId = hoverId ?? pinnedId ?? props.focusId ?? null
    const onHover = props.onHover ?? setInternalHover
    const { book } = useModelPrices()
    const currency = displayCurrencyOf(ctx.locale)

    const stageRef = useRef<HTMLDivElement | null>(null)
    const heardFocus = props.focusId ?? null
    const [stageWidth, setStageWidth] = useState(0)
    const [stageHeight, setStageHeight] = useState(0)
    useEffect(() => {
      const el = stageRef.current
      /* v8 ignore next 1 */
      if (el === null) return
      return containHorizontalOverscroll(el)
    }, [])

    const layout = useMemo(
      () => (forest !== null ? layoutForest(forest, stageWidth, props.compact === true) : null),
      [forest, props.compact, stageWidth],
    )
    const stageMounted = forest !== null
    useLayoutEffect(() => {
      /* v8 ignore start */
      const el = stageRef.current
      if (el === null) return
      const style = getComputedStyle(el)
      const padX = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
      const padY = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
      const measure = (width: number, height: number): void => {
        setStageWidth(width)
        if (!showAll) setStageHeight(height)
      }
      const rect = el.getBoundingClientRect()
      measure(rect.width - padX, rect.height - padY)
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(([entry]) => {
        measure(entry.contentRect.width, entry.contentRect.height)
      })
      observer.observe(el)
      return () => { observer.disconnect() }
      /* v8 ignore stop */
    }, [showAll, stageMounted])
    const avatarLabels = useMemo(
      () => forest === null
        ? null
        : avatarLabelsOf(forest.nodes.map(node => ({ id: node.id, name: avatarIdentityOf(team, node, t).name }))),
      [forest, team, t],
    )
    const [stageView, setStageView] = useState<{ top: number; height: number; measured: boolean }>({ top: 0, height: 0, measured: false })
    useLayoutEffect(() => {
      /* v8 ignore start */
      const el = stageRef.current
      if (el === null) return undefined
      let frame = 0
      const update = (): void => {
        frame = 0
        setStageView(current => (current.top === el.scrollTop && current.height === el.clientHeight && current.measured
          ? current
          : { top: el.scrollTop, height: el.clientHeight, measured: true }))
      }
      const schedule = (): void => { if (frame === 0) frame = requestAnimationFrame(update) }
      update()
      el.addEventListener('scroll', schedule, { passive: true })
      const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(schedule) : null
      observer?.observe(el)
      return () => {
        el.removeEventListener('scroll', schedule)
        if (frame !== 0) cancelAnimationFrame(frame)
        observer?.disconnect()
      }
      /* v8 ignore stop */
    }, [layout?.height, showAll])
    const cardHeight = props.compact === true ? AGENT_CARD_COMPACT_H : AGENT_CARD_H
    const seededHeight = !stageView.measured && forest !== null && forest.nodes.length > GRAPH_WINDOW_SEED ? STAGE_H : 0
    const viewportHeight = stageView.height > 0 ? stageView.height : seededHeight
    const band = viewportHeight > 0
      ? { from: stageView.top - GRAPH_OVERSCAN, to: stageView.top + viewportHeight + GRAPH_OVERSCAN }
      : null
    const graph = useMemo(() => {
      if (forest === null || layout === null) return null
      const points = new Map(layout.points.map(point => [point.id, point]))
      const nodes = new Map(forest.nodes.map(node => [node.id, node]))
      const entries = forest.nodes.map(node => ({ node, hue: hueOf(node, team, members) }))
      const hues = new Map(entries.map(entry => [entry.node.id, entry.hue]))
      const visible = band === null ? entries : entries.filter(({ node }) => {
        const point = points.get(node.id)
        return point !== undefined && point.y <= band.to && point.y + cardHeight >= band.from
      })
      return {
        points,
        nodes,
        hues,
        visible,
        lit: neighborhoodOf(forest, litId),
        links: band === null
          ? layout.links
          : layout.links.filter(link => Math.min(link.y1, link.y2) - cardHeight <= band.to && Math.max(link.y1, link.y2) >= band.from),
      }
    }, [band?.from, band?.to, cardHeight, forest, layout, litId, members, team])
    useEffect(() => {
      if (heardFocus === null || graph === null) return
      const point = graph.points.get(heardFocus)
      const el = stageRef.current
      /* v8 ignore next 1 */
      if (point !== undefined && el !== null && (point.y < el.scrollTop || point.y + cardHeight > el.scrollTop + el.clientHeight)) {
        scrollToPos(el, { top: Math.max(0, point.y - 24) })
      }
      /* v8 ignore next 1 */
      const card = stageRef.current?.querySelector<HTMLElement>(`[data-agent="${CSS.escape(heardFocus)}"]`) ?? null
      scrollIntoViewIfPossible(card, { block: 'center', behavior: 'smooth' })
    }, [cardHeight, graph, heardFocus])

    if (forest === null || layout === null || graph === null) return null
    const tallFamily = layout.height > STAGE_H
    const overflowsStage = showAll || (tallFamily && layout.height > stageHeight)
    const byId = graph.nodes
    /* v8 ignore next 1 */
    const current = forest.nodes.find(n => n.isCurrent) ?? forest.nodes[0]
    const pinnedNode = pinnedId !== null ? byId.get(pinnedId) : undefined
    const hoverNode = focusId !== null ? byId.get(focusId) : undefined
    const inspected = pinnedNode ?? hoverNode ?? current
    const runningCount = forest.nodes.filter(n => n.running).length
    let totalTokens = 0
    for (const n of forest.nodes) totalTokens += n.head !== null ? n.head.tokens : 0

    const lit = graph.lit

    const open = (id: string): void => {
      if (id === current.id) return
      openSessionVia(ctx, id)
    }
    const select = props.onSelect
    const keyOpen = (id: string) => (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      if (select !== undefined) select(id)
      else open(id)
    }

    const inspector = (
      <AgentInspector
        node={inspected}
        pinned={pinnedNode !== undefined}
        team={team ?? null}
        detail={nullDetail}
        roster={[]}
        comms={[]}
        labelOf={fallbackLabel(byId)}
        onOpen={open}
        onPin={noopPin}
        onFocusTask={noopPin}
        t={t}
        fmt={fmt}
        catLabel={catLabel}
      />
    )

    return (
      <div className={'lc-card lc-agents' + (props.compact === true ? ' lc-agents-compact' : '')}>
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconWorkspaceTreeOutlineRegular size={14} />
            {t('agents.title')}
          </span>
          <span className="lc-card-sub">{t(select !== undefined ? 'agents.subSelect' : 'agents.sub')}</span>
        </div>

        <div className="lc-agents-chips">
          <span className="lc-agents-chip">{t('agents.chip.count', { n: forest.nodes.length })}</span>
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
          {overflowsStage
            ? (
              <button
                type="button"
                className="lc-agents-chip lc-agents-toggle"
                aria-expanded={showAll}
                onClick={() => { setShowAll(v => !v) }}
              >
                {t(showAll ? 'agents.showLess' : 'agents.showAll')}
              </button>
            )
            : null}
        </div>

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

        <div className="lc-agents-split">
          <div className="lc-agents-main">
            <div className={'lc-agents-stage' + (tallFamily ? ' lc-agents-stage-tall' : '') + (showAll ? ' lc-agents-stage-all' : '')} ref={stageRef}>
              <div
                className={'lc-agents-canvas' + (lit !== null ? ' lc-agents-focus' : '')}
                style={{ width: layout.width, height: layout.height }}
              >
                <svg
                  className="lc-agents-links"
                  width={layout.width}
                  height={layout.height}
                  viewBox={`0 0 ${layout.width} ${layout.height}`}
                >
                  {graph.links.map((link) => {
                    const d = linkPath(link.x1, link.y1, link.x2, link.y2)
                    const parentId = graph.nodes.get(link.to)?.parentId
                    const on = lit !== null && parentId !== undefined && lit.has(link.to) && lit.has(parentId)
                    const color = graph.hues.get(link.to)
                    return (
                      <g key={link.to} className={on ? 'lc-agents-on' : undefined}>
                        <path
                          className={'lc-agents-link stroke-[1.5px]' + (link.running ? ' lc-agents-link-live' : '')}
                          d={d}
                          stroke={color}
                          fill="none"
                        />
                        {link.running
                          ? <path className="lc-agents-flow animate-lc-agent-flow fill-none stroke-2" d={d} stroke={color} />
                          : null}
                        <circle className="lc-agents-joint" cx={link.x1} cy={link.y1} r={2} fill={color} />
                        <circle className="lc-agents-joint" cx={link.x2} cy={link.y2} r={3} fill={color} />
                      </g>
                    )
                  })}
                </svg>
                {graph.visible.map(({ node, hue }, index) => {
                  const point = graph.points.get(node.id)
                  /* v8 ignore next 2 */
                  if (point === undefined) return null
                  return (
                    <AgentCard
                      key={node.id}
                      node={node}
                      x={point.x}
                      y={point.y}
                      width={layout.cardW}
                      hue={hue}
                      index={index}
                      hovered={focusId === node.id}
                      on={lit !== null && lit.has(node.id)}
                      pinned={pinnedId === node.id}
                      onHover={onHover}
                      onOpen={open}
                      onSelect={select}
                      onKeyOpen={keyOpen(node.id)}
                      book={book}
                      currency={currency}
                      memberName={teammateNameOf(team, node)}
                      avatar={{
                        id: node.id,
                        ...avatarIdentityOf(team, node, t),
                        self: node.isCurrent,
                        hue,
                        initials: avatarLabels?.get(node.id),
                      }}
                      t={t}
                      fmt={fmt}
                    />
                  )
                })}
              </div>
            </div>

            {forest.solo ? <div className="lc-empty lc-agents-solo">{t('agents.solo')}</div> : null}
          </div>

          {props.inspector === false ? null : inspector}
        </div>
      </div>
    )
  }

  return AgentGraph
}

const nullDetail: { detail: FleetDetail | null } = { detail: null }
/* v8 ignore next */
const noopPin = (): void => {}

/* v8 ignore next 2 */
function fallbackLabel(byId: ReadonlyMap<string, AgentNode>): (id: string) => string {
  return id => byId.get(id)?.label ?? id
}

interface CardProps {
  node: AgentNode
  x: number
  y: number
  width: number
  hue: string
  index: number
  hovered: boolean
  on: boolean
  pinned: boolean
  onHover: (id: string | null) => void
  onOpen: (id: string) => void
  onSelect?: (id: string) => void
  onKeyOpen: (ev: KeyboardEvent) => void
  book: ModelBook | null
  currency: CostCurrency
  memberName?: string
  avatar: CommsAgent
  t: ViewKit['t']
  fmt: ViewKit['fmt']
}

function AgentCard(props: CardProps): ReactElement {
  const { node, x, y, width } = props
  const pct = node.head !== null ? node.head.pct : null
  const segs = node.head !== null ? barSegments(node.head.parts, pct, pressureColorOf(pct)) : []
  const consumed = node.billed !== null && node.billed > 0 ? node.billed
    : node.costUsage !== null ? billedTokensOf(node.costUsage) : null
  const cost = estimateSessionCost(node.costUsage, props.book, props.currency)
  const metricBits: string[] = []
  if (consumed !== null && consumed > 0) metricBits.push(props.fmt(consumed))
  if (cost !== null) metricBits.push(formatCost(cost, props.currency))
  const meta: string[] = []
  if (node.durationMs !== null) meta.push(fmtDurationCompact(node.durationMs))
  if (node.requests > 0) meta.push(props.t('agents.steps', { n: node.requests }))
  const selectable = props.onSelect !== undefined
  const cls = 'lc-agent-card animate-lc-agent-in motion-reduce:animate-none'
    + (node.isCurrent ? ' lc-agent-self' : '')
    + (props.hovered ? ' lc-agent-hover' : '')
    + (props.on ? ' lc-agent-on' : '')
    + (props.pinned ? ' lc-agent-pinned' : '')
    + (selectable || !node.isCurrent ? ' lc-agent-clickable' : '')
  return (
    <div
      className={cls}
      style={{ left: x - width / 2, top: y, width, ...memberStyle(props.hue), '--lc-i': Math.min(props.index, STAGGER_CAP) } as CSSProperties}
      data-agent={node.id}
      role={selectable || !node.isCurrent ? 'button' : undefined}
      tabIndex={selectable || !node.isCurrent ? 0 : undefined}
      aria-pressed={selectable ? props.pinned : undefined}
      onClick={() => {
        if (props.onSelect !== undefined) props.onSelect(node.id)
        else props.onOpen(node.id)
      }}
      onKeyDown={props.onKeyOpen}
      onMouseEnter={() => { props.onHover(node.id) }}
      onMouseLeave={() => { props.onHover(null) }}
      onFocus={() => { props.onHover(node.id) }}
      onBlur={() => { props.onHover(null) }}
    >
      <div className="lc-agent-card-head">
        <AgentAvatar agent={props.avatar} size="sm" t={props.t} />
        {node.running || node.completed
          ? <StateDot state={node.running ? 'ongoing' : 'done'} size={11} className="lc-agent-state" />
          : null}
        <div className="lc-agent-label" title={props.memberName ?? node.label}>{props.memberName ?? node.label}</div>
        {node.isCurrent ? <span className="lc-agents-badge lc-agent-self-badge">{props.t('agents.self')}</span> : null}
      </div>
      {props.memberName !== undefined ? <div className="lc-agent-duty" title={node.label}>{node.label}</div> : null}
      <div className="lc-agent-metric">
        <span className="lc-agent-tokens">{metricBits.length > 0 ? metricBits.join(' · ') : '—'}</span>
      </div>
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
