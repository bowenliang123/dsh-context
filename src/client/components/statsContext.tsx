/** The Context card: counts only — proportions live on the composition card, the event rows on the events
 * card, and the token figures on the Token card. The counts arrive precomputed (the split-generation wire
 * head, or `countsOfRecords` on the inline generation); the card never touches the collections. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode, TimelineCounts } from '../../shared/types'
import { estimateSessionCost, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, priceFaceOf, toCurrency } from '../cost'
import type { CostCurrency, ModelBook, PriceFace } from '../cost'
import { sessionsFaceOf, subagentCostFoldOf } from '../agentTree'
import type { AgentHeads } from '../agentHeads'
import { useSessionsSnapshot } from '../agentHeads'
import type { Translate } from '../i18n'
import { useModelPrices } from '../modelPrices'
import { revealInScrollParent } from '../revealScroll'
import { asRecord, type ClientCtx } from '../services'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'

interface PriceRow { key: string; face: PriceFace }

const BANDS: readonly (readonly [keyof PriceFace['rate'], string])[] = [
  ['hit', 'stats.costHit'],
  ['miss', 'stats.costMiss'],
  ['write', 'stats.costWrite'],
  ['out', 'stats.costOut'],
]

function priceRowsOf(usage: SessionCostUsage | undefined, book: ModelBook | null): PriceRow[] {
  if (usage === undefined || book === null) return []
  const rows: PriceRow[] = []
  for (const provider of Object.keys(usage)) {
    const models = asRecord(usage[provider])
    /* v8 ignore next 1 -- the fold's inputs are mergeCostUsage's own output
       (hostile branches dropped at the merge), so a non-record branch never
       reaches here; the guard stays for the helper's own contract. */
    if (models === null) continue
    for (const model of Object.keys(models)) {
      const face = priceFaceOf(book, provider, model)
      if (face === null) continue
      rows.push({ key: provider + '/' + model, face })
    }
  }
  return rows
}

/** The inline generation's counter derivation; the host's split-generation counts
 * match it by construction (fold.ts buildTimelineHead). */
export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  // Loaded skills: the distinct names among the skill-tagged inject events — the host fold's exact tag set
  // (`sub: 'skill'` on `/name` invocations and `skill`-tool loads; the catalog digest rides an untagged event).
  const skills = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
    if (ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '') skills.add(ev.name)
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes, skills: skills.size }
}

/** null usage = nothing reported (no subagents, no usage, or no sessions face on this harness). */
export interface SubagentStats {
  usage: SessionCostUsage | null
  count: number
}

export function makeSubagentCost(
  ctx: ClientCtx,
  heads: AgentHeads,
): (sessionId: string | undefined) => SubagentStats {
  return function useSubagentCost(sessionId: string | undefined): SubagentStats {
    const face = useMemo(() => sessionsFaceOf(ctx), [])
    const snapshot = useSessionsSnapshot(face)
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())
    const fold = useMemo(
      () => subagentCostFoldOf(snapshot, sessionId, landed),
      [snapshot, sessionId, landed],
    )
    // Same value → same state: the identity bail-out keeps a settled replay on every snapshot tick from looping.
    useEffect(() => {
      for (const id of fold.cold) {
        void heads.headOf(id).then((head) => {
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
    }, [fold, heads])
    return { usage: fold.usage, count: fold.count }
  }
}

type FlowNodeKey = 'inputs' | 'events' | 'session' | 'tools' | 'cost'

const FLOW_NODES: readonly FlowNodeKey[] = ['inputs', 'events', 'session', 'tools', 'cost']

interface FlowBox { x: number; y: number; w: number; h: number }

interface FlowLink { d: string; color: string }

/** A box-edge anchor: the point plus the outward normal (the curve's tangent direction). */
interface Anchor { x: number; y: number; dx: number; dy: number }

/** Must match the `@container lc-card (max-width: …)` rule in stats.css: the flow root fills the card's
 * content box, so the `clientWidth` read and the CSS query can never disagree about the fold mode. */
const FLOW_FOLD_PX = 559

/** The flow topology; non-conservative by design — every ribbon is the same width whatever the tally behind it. */
const FLOW_LINKS: readonly { from: FlowNodeKey; to: FlowNodeKey; fromAt: number; toAt: number; color: string }[] = [
  { from: 'inputs', to: 'session', fromAt: 0.5, toAt: 1 / 3, color: 'var(--color-green-500)' },
  { from: 'events', to: 'session', fromAt: 0.5, toAt: 2 / 3, color: 'var(--color-purple-500)' },
  { from: 'session', to: 'tools', fromAt: 1 / 3, toAt: 0.5, color: 'var(--color-teal-500)' },
  { from: 'session', to: 'cost', fromAt: 2 / 3, toAt: 0.5, color: 'var(--color-pink-500)' },
]

const EVENT_PILLS: readonly { kind: 'inject' | 'compaction' | 'prune'; tally: 'injects' | 'compactions' | 'prunes'; cls: string }[] = [
  { kind: 'inject', tally: 'injects', cls: 'lc-kind-inject' },
  { kind: 'compaction', tally: 'compactions', cls: 'lc-kind-compaction' },
  { kind: 'prune', tally: 'prunes', cls: 'lc-kind-prune' },
]

/** Folded over the LIVE surface with the host's own predicate (fold.ts `toolCalls`), so the pills sum to
 * the head's `toolCalls` figure by construction, minus any result the fold stamped no name on. */
export function toolTallyOf(nodes: readonly SurfaceNode[]): [string, number][] {
  const tally = new Map<string, number>()
  for (const n of nodes) {
    if (n.cat !== 'tool' && !(n.cat === 'skill' && n.tool !== undefined)) continue
    if (typeof n.tool !== 'string' || n.tool === '') continue
    tally.set(n.tool, (tally.get(n.tool) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

interface StatsContextProps {
  counts: TimelineCounts
  humanInputs?: number
  answers?: number
  onFigureClick?: (figure: 'skills' | 'answers') => void
  toolCalls?: number
  files: { reads: number; writes: number; searches: number; images: number }
  tools: readonly (readonly [string, number])[]
  cost?: SessionCostUsage
  locale: string
  sessionId?: string
}

function flowAnchor(box: FlowBox, side: 'left' | 'right' | 'top' | 'bottom', at: number): Anchor {
  switch (side) {
    case 'left': return { x: box.x, y: box.y + box.h * at, dx: -1, dy: 0 }
    case 'right': return { x: box.x + box.w, y: box.y + box.h * at, dx: 1, dy: 0 }
    case 'top': return { x: box.x + box.w * at, y: box.y, dx: 0, dy: -1 }
    case 'bottom': return { x: box.x + box.w * at, y: box.y + box.h, dx: 0, dy: 1 }
  }
}

/** Cubic whose end control point sits at `b + normal·k`, so the path arrives moving INTO the node. */
export function flowCurve(a: Anchor, b: Anchor): string {
  const k = Math.max(18, (a.dx !== 0 ? Math.abs(b.x - a.x) : Math.abs(b.y - a.y)) / 2)
  return `M ${a.x} ${a.y} C ${a.x + a.dx * k} ${a.y + a.dy * k} ${b.x + b.dx * k} ${b.y + b.dy * k} ${b.x} ${b.y}`
}

/** Sources attach on their trailing edge and targets on their leading one: the session node is a target of
 * the left/top pair and the source of the right/bottom pair, so one orientation pair serves both modes. */
export function measureFlow(boxes: Record<FlowNodeKey, FlowBox>, horizontal: boolean): FlowLink[] {
  const fromSide = horizontal ? 'right' as const : 'bottom' as const
  const toSide = horizontal ? 'left' as const : 'top' as const
  return FLOW_LINKS.map(link => ({
    d: flowCurve(flowAnchor(boxes[link.from], fromSide, link.fromAt), flowAnchor(boxes[link.to], toSide, link.toAt)),
    color: link.color,
  }))
}

/** The row's own gap, mirrored from `.lc-flow-pills` in stats.css so the fit arithmetic matches the rendered box. */
const PILL_GAP = 4

/** The tool tally on ONE line, exactly like the Input/Output row above it: every tool the card has room for, spelled
 *  out in full, and the rest folded into a trailing "其他 +N" — so a session that used five tools shows five rather than
 *  an arbitrary top three.
 *
 *  The visible row renders ONLY what fits, so nothing is ever clipped or overlapped. The fit is measured off a hidden
 *  gauge that carries every pill at its natural width — a pill's width does not depend on whether its neighbours are on
 *  screen, so the gauge answers for the tail the row is not showing. Because the row never wraps, the node's height is
 *  a property of the card's width alone: it stops resizing as a session's tool mix changes. With no tally (the split
 *  generation's head carries none) the row holds a lone "其他 +0". */
function ToolPills(props: {
  tools: readonly (readonly [string, number])[]
  t: Translate
  fmt: (n: number) => string
}): ReactElement {
  const { tools, t, fmt } = props
  const rowRef = useRef<HTMLDivElement | null>(null)
  const gaugeRef = useRef<HTMLDivElement | null>(null)
  const chipGaugeRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(tools.length)

  const pill = (name: string, n: number, title?: string): ReactElement => (
    <span key={name} className="lc-flow-pill" title={title}>
      <span className="lc-flow-pill-label">{name}</span>
      <b>{fmt(n)}</b>
    </span>
  )

  const fit = useCallback(() => {
    const row = rowRef.current
    const gauge = gaugeRef.current
    const chipGauge = chipGaugeRef.current
    /* v8 ignore next 3 -- the gauges always render, so their refs are set whenever the row is. */
    if (row === null || gauge === null || chipGauge === null) return
    const width = row.getBoundingClientRect().width
    // Nothing measurable (a hidden pane, jsdom): show the whole tally rather than guessing a subset.
    if (width <= 0) {
      setShown(tools.length)
      return
    }
    const widths = Array.from(gauge.children, el => el.getBoundingClientRect().width)
    const chips = Array.from(chipGauge.children, el => el.getBoundingClientRect().width)
    // The widest set that fits WITH the chip it would actually carry, found in one pass from the top down. Measuring
    // the live chip instead would feed this pass's own output back into its input; measuring only the widest chip
    // would cost a pill to digits the chip never shows.
    let pills = 0
    for (let n = Math.min(widths.length, chips.length - 1); n >= 0; n--) {
      let total = chips[tools.length - n] + n * PILL_GAP
      for (let i = 0; i < n; i++) total += widths[i]
      if (total <= width) {
        pills = n
        break
      }
    }
    setShown(prev => (prev === pills ? prev : pills))
  }, [tools])

  // Re-weigh on a new tally; the ResizeObserver covers a pane drag, which changes no prop.
  useLayoutEffect(fit, [fit])
  /* v8 ignore start -- jsdom exposes no ResizeObserver. */
  useEffect(() => {
    const row = rowRef.current
    if (row === null || typeof ResizeObserver !== 'function') return
    const observer = new ResizeObserver(fit)
    observer.observe(row)
    return () => { observer.disconnect() }
  }, [fit])
  /* v8 ignore stop */

  return (
    <>
      <div className="lc-flow-pills lc-flow-pills-tools" ref={rowRef}>
        {tools.slice(0, shown).map(([name, n]) => pill(name, n, name))}
        <span className="lc-flow-pill lc-flow-pill-dim">
          <span className="lc-flow-pill-label">{t('stats.toolsMore', { n: tools.length - shown })}</span>
        </span>
      </div>
      {/* Off-flow gauges: every pill and every chip width the fit may weigh, so the row can measure the tail it is
          not showing without rendering it. */}
      <span className="lc-flow-pill-gauge" aria-hidden="true">
        <div className="lc-flow-pills" ref={gaugeRef}>{tools.map(([name, n]) => pill(name, n))}</div>
        <div className="lc-flow-pills" ref={chipGaugeRef}>
          {Array.from({ length: tools.length + 1 }, (_, k) => (
            <span key={k} className="lc-flow-pill lc-flow-pill-dim">
              <span className="lc-flow-pill-label">{t('stats.toolsMore', { n: k })}</span>
            </span>
          ))}
        </div>
      </span>
    </>
  )
}

export function makeStatsContext(
  kit: ViewKit,
  useSubagentCost: (sessionId: string | undefined) => SubagentStats,
): (props: StatsContextProps) => ReactElement {
  const { t, fmt } = kit
  return function StatsContext(props: StatsContextProps): ReactElement {
    const currency: CostCurrency = props.locale === 'zh' ? 'cny' : 'usd'
    const { book, failed } = useModelPrices()
    const sub = useSubagentCost(props.sessionId)
    const subUsage = sub.usage
    const usage = mergeCostUsage(props.cost, subUsage) ?? undefined
    const cost = estimateSessionCost(usage, book, currency)
    const subCost = estimateSessionCost(subUsage, book, currency)
    const fmtRate = (usd: number): string => formatPriceRate(toCurrency(usd, currency), currency)
    const rows = priceRowsOf(usage, book)
    const subRows = priceRowsOf(subUsage ?? undefined, book)
    const deepseek = usage !== undefined && Object.keys(usage).some(p => isDeepSeekProvider(p))
    const subDeepseek = subUsage !== null && Object.keys(subUsage).some(p => isDeepSeekProvider(p))
    // Folded usage with no priced row (book not loaded, or it carries none of this scope's models): say so instead of a bare dash.
    const unpriced = rows.length === 0 && usage !== undefined && Object.keys(usage).length > 0
      && (failed || book !== null)
    const subUnpriced = subRows.length === 0 && subUsage !== null && (failed || book !== null)
    const pricesBlock = (blocks: PriceRow[]): ReactNode =>
      blocks.length > 0 ? (
        <span key="prices" className="lc-stat-tip-prices">
          <span className="lc-stat-tip-head">{t('stats.costPriceHead')}</span>
          {blocks.map(r => (
            <span key={r.key} className="lc-stat-tip-row">
              {BANDS.filter(([bucket]) => r.face.rate[bucket] > 0).map(([bucket, label]) => (
                <span key={bucket} className="lc-stat-tip-band">
                  <i>{t(label)}</i>
                  {' '}
                  <b>{fmtRate(r.face.rate[bucket])}</b>
                </span>
              ))}
              <span className="lc-stat-tip-by">{t('stats.costPriceBy', { p: r.face.pid, m: r.face.mid })}</span>
            </span>
          ))}
        </span>
      ) : null
    const notes = (deep: boolean): ReactElement[] =>
      [
        currency === 'cny' ? <span key="cny">{t('stats.costTipCny')}</span> : null,
        deep ? <span key="peak">{t('stats.costTipDeepseek')}</span> : null,
      ].filter((el): el is ReactElement => el !== null)
    const costTip: ReactNode = [
      t('stats.costTip'),
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(rows),
      ...notes(deepseek),
      unpriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    const subTip: ReactNode = [
      t('stats.subCostTip'),
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(subRows),
      ...notes(subDeepseek),
      subUnpriced ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    // A no-deps layout effect re-measures after every render (a same-string bail-out keeps it loopless); the
    // ResizeObserver tick covers pane drags, which change no prop.
    const flowRef = useRef<HTMLDivElement | null>(null)
    const nodeEls = useRef(new Map<FlowNodeKey, HTMLDivElement>())
    const [links, setLinks] = useState<FlowLink[]>([])
    const [, setResizeTick] = useState(0)
    const nodeRef = (key: FlowNodeKey) => (el: HTMLDivElement | null): void => {
      if (el === null) nodeEls.current.delete(key)
      else nodeEls.current.set(key, el)
    }
    useLayoutEffect(() => {
      const root = flowRef.current
      /* v8 ignore next 1 -- the effect only runs while mounted, and the card always renders the flow root. */
      if (root === null) return
      const rootBox = root.getBoundingClientRect()
      const boxes = {} as Record<FlowNodeKey, FlowBox>
      for (const key of FLOW_NODES) {
        /* v8 ignore start -- the five nodes render before this layout effect, so every key resolves. */
        const el = nodeEls.current.get(key)
        if (el === undefined) return
        /* v8 ignore stop */
        const r = el.getBoundingClientRect()
        boxes[key] = { x: r.left - rootBox.left, y: r.top - rootBox.top, w: r.width, h: r.height }
      }
      const next = measureFlow(boxes, root.clientWidth > FLOW_FOLD_PX)
      setLinks(prev => (prev.length === next.length && prev.every((l, i) => l.d === next[i].d && l.color === next[i].color) ? prev : next))
    })
    /* v8 ignore start -- jsdom has neither ResizeObserver nor layout: tests pin the geometry through measureFlow's unit tests. */
    useEffect(() => {
      const root = flowRef.current
      if (root === null || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { setResizeTick(tick => tick + 1) })
      observer.observe(root)
      return () => { observer.disconnect() }
    }, [])
    /* v8 ignore stop */
    const head = (label: string, total: ReactNode, tip?: ReactNode, href?: string): ReactElement => {
      const body = (
        <>
          <span className="lc-flow-label">
            {label}
            {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
          </span>
          <b className="lc-flow-total">{total}</b>
          {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
        </>
      )
      const className = 'lc-flow-head' + (tip === undefined ? '' : ' lc-stat-tipped group/tip')
      return href === undefined
        ? <div className={className}>{body}</div>
        : <a className={className} href={href} target="_blank" rel="noreferrer noopener">{body}</a>
    }
    const pill = (label: string, value: number, cls = '', tip?: ReactNode): ReactElement => (
      <span key={label} className={'lc-flow-pill' + cls + (value === 0 ? ' lc-flow-pill-dim' : '') + (tip === undefined ? '' : ' lc-stat-tipped group/tip')}>
        <span className="lc-flow-pill-label">
          {label}
          {tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
        </span>
        <b>{fmt(value)}</b>
        {tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{tip}</span>}
      </span>
    )
    const onFigureClick = props.onFigureClick
    const figure = (key: 'skills' | 'answers', value: number, label: string, tip: string): ReactElement => (
      <span
        key={key}
        role={onFigureClick === undefined ? undefined : 'button'}
        tabIndex={onFigureClick === undefined ? undefined : 0}
        className={'lc-flow-kv' + (onFigureClick === undefined ? '' : ' lc-flow-kv-btn')}
        title={onFigureClick === undefined ? undefined : tip}
        onClick={onFigureClick === undefined ? undefined : () => { onFigureClick(key) }}
        onKeyDown={onFigureClick === undefined ? undefined : (ev: KeyboardEvent) => {
          if (ev.key !== 'Enter' && ev.key !== ' ') return
          ev.preventDefault()
          onFigureClick(key)
        }}
      >
        <b>{fmt(value)}</b>
        <i>{label}</i>
      </span>
    )
    const costPids = new Set(rows.map(r => r.face.pid).filter(p => p !== ''))
    const costHref = costPids.size === 1 ? 'https://models.dev/providers/' + [...costPids][0] + '/' : undefined
    const ownCost = estimateSessionCost(props.cost, book, currency)
    const familyTokens = billedTokensOf(usage)
    const ownTokens = billedTokensOf(props.cost)
    const subTokens = billedTokensOf(subUsage)
    const pair = (tokens: number, costText: string): ReactElement => (
      <span className="lc-flow-pair"><b>{fmt(tokens)}</b><i>/</i><b>{costText}</b></span>
    )
    const costText = cost === null ? '—' : formatCost(cost, currency)
    const ownText = ownCost === null ? '—' : formatCost(ownCost, currency)
    const subText = subCost === null ? '—' : formatCost(subCost, currency)
    const revealAgents = (): void => {
      const agents = flowRef.current?.closest('.lc-root')?.querySelector('.lc-agents') ?? null
      if (agents !== null) revealInScrollParent(agents)
    }
    const onTeamClick = (ev: MouseEvent): void => {
      if ((ev.target as HTMLElement).closest('a') !== null) return
      revealAgents()
    }
    const onTeamKeyDown = (ev: KeyboardEvent): void => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      revealAgents()
    }
    const ioTotal = (props.humanInputs ?? 0) + props.files.reads + props.files.writes + props.files.searches + props.files.images
    // The head's live tally; the pills' own sum is the fallback on hosts too old to carry it.
    const toolTotal = props.toolCalls ?? props.tools.reduce((sum, [, n]) => sum + n, 0)
    return (
      <div className="lc-card flex-[3] min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('stats.title')}</span>
        </div>
        <div className="lc-stats lc-flow" ref={flowRef}>
          {/* Under the nodes; ordered left→right / top→bottom so the traveling dashes read in flow order. */}
          <svg className="lc-flow-svg" aria-hidden="true">
            {links.map((l, i) => (
              // Fixed four-link set in fixed order: the index IS the identity (zero-measured boxes produce identical d strings).
              <g key={i}>
                <path className="lc-flow-ribbon" d={l.d} stroke={l.color} />
                <path className="lc-flow-dash animate-lc-agent-flow motion-reduce:animate-none" d={l.d} stroke={l.color} />
              </g>
            ))}
          </svg>
          <div className="lc-flow-col">
            <div className="lc-flow-node" ref={nodeRef('inputs')}>
              {head(t('stats.io'), fmt(ioTotal))}
              {/* Searches and image reads pill only when they happened; the three zero counts stay visible. */}
              <div className="lc-flow-pills">
                {pill(t('stats.humanInputs'), props.humanInputs ?? 0, '', t('stats.humanInputsTip'))}
                {pill(t('files.kind.read'), props.files.reads)}
                {pill(t('files.kind.write'), props.files.writes)}
                {props.files.searches > 0 ? pill(t('files.kind.search'), props.files.searches) : null}
                {props.files.images > 0 ? pill(t('files.kind.image'), props.files.images) : null}
              </div>
            </div>
            <div className="lc-flow-node" ref={nodeRef('events')}>
              {head(t('stats.events'), fmt(props.counts.injects + props.counts.compactions + props.counts.prunes))}
              <div className="lc-flow-pills">
                {EVENT_PILLS.map(p => pill(t('kind.' + p.kind), props.counts[p.tally], ' lc-flow-pill-tint ' + p.cls))}
              </div>
            </div>
          </div>
          <div className="lc-flow-mid">
            <div className="lc-flow-node lc-flow-self" ref={nodeRef('session')}>
              <span className="lc-flow-label">{t('stats.session')}</span>
              <span className="lc-flow-self-stats">
                <span className="lc-flow-kv"><b>{fmt(props.counts.turns)}</b><i>{t('stats.turns')}</i></span>
                <span className="lc-flow-kv"><b>{fmt(props.counts.steps)}</b><i>{t('stats.steps')}</i></span>
              </span>
              <span className="lc-flow-self-stats">
                {figure('skills', props.counts.skills ?? 0, t('stats.skills'), t('stats.skillsJump'))}
                {figure('answers', props.answers ?? 0, t('stats.answers'), t('stats.answersJump'))}
              </span>
            </div>
          </div>
          <div className="lc-flow-col lc-flow-col-r">
            <div className="lc-flow-node" ref={nodeRef('tools')}>
              {head(t('stats.toolCalls'), fmt(toolTotal))}
              <ToolPills tools={props.tools} t={t} fmt={fmt} />
            </div>
            <div
              className="lc-flow-node lc-flow-team"
              ref={nodeRef('cost')}
              role="button"
              tabIndex={0}
              onClick={onTeamClick}
              onKeyDown={onTeamKeyDown}
            >
              {head(t('agents.title'), pair(familyTokens, costText), costTip, costHref)}
              <div className="lc-flow-rows">
                <div className="lc-flow-row">
                  <span className="lc-flow-row-label">{t('stats.currentAgent')}</span>
                  {pair(ownTokens, ownText)}
                </div>
                <div className="lc-flow-row lc-stat-tipped group/tip">
                  <span className="lc-flow-row-label">
                    {t('stats.teamSubs', { n: sub.count })}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </span>
                  {pair(subTokens, subText)}
                  <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{subTip}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    )
  }
}
