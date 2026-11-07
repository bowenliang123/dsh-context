import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactElement, type ReactNode } from 'react'
import type { ContextEventRecord, ContextTimeline, RequestRecord, SessionCostUsage, SurfaceNode, TimelineCounts } from '../../shared/types'
import { estimateSessionCost, billedTokensOf, formatCost, formatPriceRate, mergeCostUsage, priceLookupsOf, toCurrency } from '../cost'
import type { CostCurrency, ModelBook, PriceFace, PriceMiss } from '../cost'
import { sessionsFaceOf, subagentCostFoldOf } from '../agentTree'
import { useSessionsSnapshot } from '../agentHeads'
import type { AgentHeads } from '../agentHeads'
import type { Translate } from '../i18n'
import { useModelPrices } from '../modelPrices'
import { nameColorOf } from '../nameColor'
import { type ClientCtx } from '../services'
import { isDeepSeekProvider } from '../../shared/providers'
import type { ViewKit } from '../viewkit'
import { IconData } from '../primitives'
import { useElementSize } from './useElementMetrics'

interface PriceRow { key: string; face: PriceFace }
interface PriceMissRow { key: string; provider: string; model: string; miss: PriceMiss }

const BANDS: readonly (readonly [keyof PriceFace['rate'], string])[] = [
  ['hit', 'stats.costHit'],
  ['miss', 'stats.costMiss'],
  ['write', 'stats.costWrite'],
  ['out', 'stats.costOut'],
]

function pricesOf(usage: SessionCostUsage | undefined, book: ModelBook | null): { rows: PriceRow[]; misses: PriceMissRow[] } {
  if (usage === undefined || book === null) return { rows: [], misses: [] }
  const rows: PriceRow[] = []
  const misses: PriceMissRow[] = []
  for (const lookup of priceLookupsOf(usage, book)) {
    const key = lookup.provider + '/' + lookup.model
    if (lookup.face !== null) rows.push({ key, face: lookup.face })
    else misses.push({ key, provider: lookup.provider, model: lookup.model, miss: lookup.miss })
  }
  return { rows, misses }
}

export function countsOfRecords(requests: readonly RequestRecord[], events: readonly ContextEventRecord[]): TimelineCounts {
  const turns = new Set<number>()
  for (const req of requests) turns.add(req.turn ?? 0)
  let injects = 0
  let compactions = 0
  let prunes = 0
  const skills = new Set<string>()
  for (const ev of events) {
    if (ev.kind === 'inject') injects++
    else if (ev.kind === 'compaction') compactions++
    else if (ev.kind === 'prune') prunes++
    if (ev.sub === 'skill' && typeof ev.name === 'string' && ev.name !== '') skills.add(ev.name)
  }
  return { turns: turns.size, steps: requests.length, injects, compactions, prunes, skills: skills.size }
}

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
    const snapshot = useSessionsSnapshot(face, 250)
    const [landed, setLanded] = useState<ReadonlyMap<string, ContextTimeline>>(new Map())
    const fold = useMemo(
      () => subagentCostFoldOf(snapshot, sessionId, landed),
      [snapshot, sessionId, landed],
    )
    useEffect(() => {
      for (const id of fold.cold) {
        void heads.headOf(id).then((head) => {
          /* v8 ignore next 1 */
          if (head !== null) setLanded(prev => prev.get(id) === head ? prev : new Map(prev).set(id, head))
        }).catch(() => {})
      }
    }, [fold, heads])
    return { usage: fold.usage, count: fold.count }
  }
}

export type StatsEventKind = 'inject' | 'compaction' | 'prune'

const EVENT_PILLS: readonly { kind: StatsEventKind; tally: 'injects' | 'compactions' | 'prunes'; cls: string }[] = [
  { kind: 'inject', tally: 'injects', cls: 'lc-kind-inject' },
  { kind: 'compaction', tally: 'compactions', cls: 'lc-kind-compaction' },
  { kind: 'prune', tally: 'prunes', cls: 'lc-kind-prune' },
]

export function toolTallyOf(nodes: readonly SurfaceNode[]): [string, number][] {
  const tally = new Map<string, number>()
  for (const n of nodes) {
    if (n.cat !== 'tool' && !(n.cat === 'skill' && n.tool !== undefined)) continue
    if (typeof n.tool !== 'string' || n.tool === '') continue
    tally.set(n.tool, (tally.get(n.tool) ?? 0) + 1)
  }
  return [...tally].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
}

export type StatsJump = 'turns' | 'steps' | 'skills' | 'answers' | 'inputs' | 'read' | 'write' | 'search' | 'image'

type FigureJump = Extract<StatsJump, 'turns' | 'steps' | 'skills' | 'answers'>

const JUMP_TIPS: Record<StatsJump, string> = {
  turns: 'stats.sessionJump',
  steps: 'stats.sessionJump',
  skills: 'stats.skillsJump',
  answers: 'stats.answersJump',
  inputs: 'stats.userJump',
  read: 'stats.filesJump',
  write: 'stats.filesJump',
  search: 'stats.filesJump',
  image: 'stats.filesJump',
}

interface JumpWire {
  role: 'button'
  tabIndex: number
  title?: string
  onClick: () => void
  onKeyDown: (ev: KeyboardEvent) => void
}

function pickWire(title: string | undefined, fire: () => void): JumpWire {
  return {
    role: 'button',
    tabIndex: 0,
    title,
    onClick: fire,
    onKeyDown: (ev: KeyboardEvent) => {
      if (ev.key !== 'Enter' && ev.key !== ' ') return
      ev.preventDefault()
      fire()
    },
  }
}

function rowJump(fire: () => void): (ev: MouseEvent) => void {
  return (ev) => {
    if ((ev.target as HTMLElement).closest('a, button, [role="button"]') !== null) return
    fire()
  }
}

interface StatsContextProps {
  counts: TimelineCounts
  humanInputs?: number
  answers?: number
  onJump?: (jump: StatsJump) => void
  onTeamClick?: () => void
  onToolPick?: (tool: string) => void
  onToolMore?: () => void
  onCommandPick?: (program: string) => void
  onCommandMore?: () => void
  onEventsClick?: (kind: StatsEventKind | null) => void
  toolCalls?: number
  files: { reads: number; writes: number; searches: number; images: number }
  tools: readonly (readonly [string, number])[]
  commands?: { runs: number; top: readonly (readonly [string, number])[] }
  cost?: SessionCostUsage
  locale: string
  sessionId?: string
}

const IO_COLOR: Record<'inputs' | 'read' | 'write' | 'search' | 'image', string> = {
  inputs: 'var(--color-green-500)',
  read: 'var(--dsw-alias-brand-primary)',
  write: 'var(--dsw-alias-state-success-primary)',
  search: 'var(--dsw-alias-state-warn-primary)',
  image: 'var(--color-pink-500)',
}

const TOOL_SHADE = (rank: number): string =>
  `color-mix(in srgb, var(--color-teal-500) ${Math.max(38, 100 - rank * 21)}%, transparent)`
const TOOL_REST = 'color-mix(in srgb, var(--color-neutral-500) 40%, transparent)'

const CHIP_GAP = 3

function useFittedChips(tally: readonly unknown[]) {
  const count = tally.length
  const rowRef = useRef<HTMLDivElement | null>(null)
  const gaugeRef = useRef<HTMLDivElement | null>(null)
  const chipGaugeRef = useRef<HTMLDivElement | null>(null)
  const [shown, setShown] = useState(count)

  const fit = useCallback(() => {
    const count = tally.length
    const row = rowRef.current
    const gauge = gaugeRef.current
    const chipGauge = chipGaugeRef.current
    /* v8 ignore next 3 */
    if (row === null || gauge === null || chipGauge === null) return
    const width = row.getBoundingClientRect().width
    if (!(width > 0)) {
      setShown(count)
      return
    }
    const widths = Array.from(gauge.children, el => el.getBoundingClientRect().width)
    let whole = 0
    for (let i = 0; i < count; i++) whole += widths[i] + (i === 0 ? 0 : CHIP_GAP)
    if (whole <= width) {
      setShown(count)
      return
    }
    const moreWidths = Array.from(chipGauge.children, el => el.getBoundingClientRect().width)
    let pills = 0
    for (let n = count - 1; n >= 0; n--) {
      let used = moreWidths[count - n - 1] + n * CHIP_GAP
      for (let i = 0; i < n; i++) used += widths[i]
      if (used <= width) {
        pills = n
        break
      }
    }
    setShown(prev => (prev === pills ? prev : pills))
  }, [tally])

  const rowSize = useElementSize(rowRef)
  useLayoutEffect(fit, [fit, rowSize.width])
  return { shown, rowRef, gaugeRef, chipGaugeRef }
}

interface ChipLaneProps {
  items: readonly (readonly [string, number])[]
  rowClass: string
  color: (name: string, rank: number) => string
  jumpTip: string
  onPick?: (name: string) => void
  onMore?: () => void
  moreTip?: string
  zeroWhenEmpty?: boolean
  t: Translate
  fmt: (n: number) => string
}

function ChipLane(props: ChipLaneProps): ReactElement {
  const { items, rowClass, color, jumpTip, onPick, onMore, moreTip, zeroWhenEmpty, t, fmt } = props
  const { shown, rowRef, gaugeRef, chipGaugeRef } = useFittedChips(items)

  const chip = (name: string, n: number, rank: number, hint = false): ReactElement => {
    const wire = hint && onPick !== undefined ? pickWire(t(jumpTip), () => { onPick(name) }) : undefined
    return (
      <span
        key={name}
        className={'lc-ledger-chip' + (wire !== undefined ? ' lc-ledger-chip-btn' : '')}
        {...(wire ?? { title: name })}
      >
        <i style={{ background: color(name, rank) }} />
        <span className="lc-ledger-chip-label">{name}</span>
        <b>{fmt(n)}</b>
      </span>
    )
  }
  const more = (hidden: number, key?: string, live = false): ReactElement => {
    const wire = live && hidden > 0 && onMore !== undefined ? pickWire(moreTip, onMore) : undefined
    return (
      <span
        key={key}
        className={'lc-ledger-chip lc-ledger-chip-more' + (wire !== undefined ? ' lc-ledger-chip-btn' : '')}
        {...(wire ?? {})}
      >
        <i style={{ background: TOOL_REST }} />
        <span className="lc-ledger-chip-label">{t('stats.toolsMore', { n: hidden })}</span>
      </span>
    )
  }
  const none = (): ReactElement => (
    <span className="lc-ledger-chip lc-ledger-chip-dim">
      <span className="lc-ledger-chip-label">{t('stats.laneEmpty')}</span>
    </span>
  )
  const empty = items.length === 0
  const folds = items.length - shown
  return (
    <div className={'lc-ledger-chips ' + rowClass} ref={rowRef}>
      {items.slice(0, shown).map(([name, n], i) => chip(name, n, i, onPick !== undefined))}
      {empty && zeroWhenEmpty !== true ? none() : null}
      {folds > 0 || (empty && zeroWhenEmpty === true) ? more(folds, undefined, true) : null}
      <span className="lc-ledger-gauge" aria-hidden="true">
        <div className="lc-ledger-chips" ref={gaugeRef}>{items.map(([name, n], i) => chip(name, n, i))}</div>
        <div className="lc-ledger-chips" ref={chipGaugeRef}>
          {Array.from({ length: items.length }, (_, k) => more(k + 1, String(k + 1)))}
        </div>
      </span>
    </div>
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
    const priceState = pricesOf(usage, book)
    const subPriceState = pricesOf(subUsage ?? undefined, book)
    const rows = priceState.rows
    const deepseek = usage !== undefined && Object.keys(usage).some(p => isDeepSeekProvider(p))
    const subDeepseek = subUsage !== null && Object.keys(subUsage).some(p => isDeepSeekProvider(p))
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
    const missesBlock = (misses: PriceMissRow[]): ReactNode =>
      misses.length > 0 ? (
        <span key="misses" className="lc-stat-tip-prices">
          {misses.map(m => (
            <span key={m.key} className="lc-stat-tip-row">
              {m.miss.reason === 'ambiguous'
                ? t('stats.costAmbiguous', { p: m.provider, m: m.model, n: String(m.miss.candidates) })
                : t('stats.costNotListed', { p: m.provider, m: m.model })}
            </span>
          ))}
        </span>
      ) : null
    const inferredNote = (blocks: PriceRow[]): ReactNode =>
      blocks.some(r => r.face.via === 'canonical-maker' || r.face.via === 'family' || r.face.via === 'index')
        ? <span key="inferred">{t('stats.costInferredNote')}</span>
        : null
    const notes = (deep: boolean): ReactElement[] =>
      [
        currency === 'cny' ? <span key="cny">{t('stats.costTipCny')}</span> : null,
        deep ? <span key="peak">{t('stats.costTipDeepseek')}</span> : null,
      ].filter((el): el is ReactElement => el !== null)
    const tipFor = (state: { rows: PriceRow[]; misses: PriceMissRow[] }, scope: string, deep: boolean): ReactNode => [
      scope,
      <span key="billed" className="lc-stat-tip-row">{t('stats.billedTip')}</span>,
      pricesBlock(state.rows),
      missesBlock(state.misses),
      inferredNote(state.rows),
      ...notes(deep),
      failed ? <span key="unavailable">{t('stats.costUnavailable')}</span> : null,
    ]
    const costTip: ReactNode = tipFor(priceState, t('stats.costTip'), deepseek)
    const subTip: ReactNode = tipFor(subPriceState, t('stats.subCostTip'), subDeepseek)
    const ownPriceState = pricesOf(props.cost, book)
    const ownDeepseek = props.cost !== undefined && Object.keys(props.cost).some(p => isDeepSeekProvider(p))
    const ownTip: ReactNode = tipFor(ownPriceState, t('stats.ownCostTip'), ownDeepseek)
    const onJump = props.onJump
    const jumpWire = (key: StatsJump, hint = true): JumpWire | undefined => {
      const relay = onJump
      if (relay === undefined) return undefined
      return pickWire(hint ? t(JUMP_TIPS[key]) : undefined, () => { relay(key) })
    }
    const ioTotal = (props.humanInputs ?? 0) + props.files.reads + props.files.writes + props.files.searches + props.files.images
    const toolTotal = props.toolCalls ?? props.tools.reduce((sum, [, n]) => sum + n, 0)
    const commandTop = props.commands?.top ?? []
    const chip = (
      key: string,
      label: string,
      value: number,
      color: string,
      opts: { title?: string; tip?: ReactNode; jump: StatsJump },
    ): ReactElement => {
      const wire = jumpWire(opts.jump, opts.tip === undefined)
      return (
        <span
          key={key}
          className={'lc-ledger-chip'
            + (wire !== undefined ? ' lc-ledger-chip-btn' : '')
            + (value === 0 ? ' lc-ledger-chip-dim' : '')
            + (opts.tip !== undefined ? ' lc-stat-tipped group/tip' : '')}
          {...(wire ?? {})}
          title={opts.title}
        >
          <i style={{ background: color }} />
          <span className="lc-ledger-chip-label">
            {label}
            {opts.tip !== undefined && <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>}
          </span>
          <b>{fmt(value)}</b>
          {opts.tip !== undefined && <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip">{opts.tip}</span>}
        </span>
      )
    }
    const figure = (key: FigureJump, value: number, label: string): ReactElement => {
      const wire = jumpWire(key)
      return (
        <span key={key} className={'lc-core-kv lc-core-kv-' + key + (wire === undefined ? '' : ' lc-core-kv-btn')} {...(wire ?? {})}>
          <b>{fmt(value)}</b>
          <i>{label}</i>
        </span>
      )
    }
    const costPids = new Set(rows.map(r => r.face.pid).filter(p => p !== ''))
    const costHref = costPids.size === 1 ? 'https://models.dev/providers/' + [...costPids][0] + '/' : undefined
    const ownCost = estimateSessionCost(props.cost, book, currency)
    const familyTokens = billedTokensOf(usage)
    const ownTokens = billedTokensOf(props.cost)
    const subTokens = billedTokensOf(subUsage)
    const pair = (tokens: number | null, costText: string): ReactElement => (
      tokens === null
        ? <span className="lc-strip-pair">{fmt(tokens)}<i>/</i>{costText}</span>
        : <span className="lc-strip-pair"><b>{fmt(tokens)}</b><i>/</i><b>{costText}</b></span>
    )
    const costText = cost === null ? '—' : formatCost(cost, currency)
    const ownText = ownCost === null ? '—' : formatCost(ownCost, currency)
    const subText = subCost === null ? '—' : formatCost(subCost, currency)
    const teamPair = pair(familyTokens, costText)
    const openTeam = props.onTeamClick
    const onTeamClick = openTeam === undefined ? undefined : rowJump(openTeam)
    const costRow = (key: string, content: ReactNode): ReactElement => (
      openTeam === undefined
        ? <span key={key} className="lc-strip-cell lc-ledger-cost-row lc-stat-tipped group/tip">{content}</span>
        : <button key={key} type="button" className="lc-strip-cell lc-ledger-cost-row lc-ledger-cost-row-btn lc-stat-tipped group/tip" onClick={openTeam}>{content}</button>
    )
    const openEvents = props.onEventsClick
    const eventsJump = openEvents === undefined ? undefined : (): void => { openEvents(null) }
    const onEventsTile = eventsJump === undefined ? undefined : rowJump(eventsJump)
    return (
      <div className="lc-card flex-[3] min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconData size={14} />
            {t('stats.title')}
          </span>
        </div>
        <div className="lc-stats">
          <div className="lc-ledger">
            <div className="lc-ledger-head lc-ledger-in-head">
              <span className="lc-ledger-label">{t('stats.io')}</span>
              <b className="lc-ledger-total">{fmt(ioTotal)}</b>
            </div>
            <div className="lc-core">
              <span className="lc-core-kvs lc-core-kvs-main">
                {figure('turns', props.counts.turns, t('stats.turns'))}
                {figure('steps', props.counts.steps, t('stats.steps'))}
              </span>
              <span className="lc-core-kvs">
                {figure('skills', props.counts.skills ?? 0, t('stats.skills'))}
                {figure('answers', props.answers ?? 0, t('stats.answers'))}
              </span>
              <span
                className={'lc-core-kv lc-core-kv-events' + (eventsJump === undefined ? '' : ' lc-core-kv-events-btn')}
                onClick={onEventsTile}
              >
                {eventsJump === undefined
                  ? <i>{t('stats.events')}</i>
                  : <i className="lc-core-kv-events-open" {...pickWire(t('stats.eventsJump'), eventsJump)}>{t('stats.events')}</i>}
                <span className="lc-core-kv-events-list">
                  {EVENT_PILLS.map((p, index) => {
                    const n = props.counts[p.tally]
                    const wire = props.onEventsClick === undefined
                      ? undefined
                      : pickWire(t('stats.eventsKindJump', { kind: t('kind.' + p.kind) }), () => { props.onEventsClick?.(p.kind) })
                    return (
                      <Fragment key={p.kind}>
                        {index > 0 ? <span className="lc-core-kv-sep" aria-hidden="true">/</span> : null}
                        <span
                          className={'lc-kind ' + p.cls + ' lc-core-kv-event'
                            + (wire === undefined ? '' : ' lc-core-kv-event-btn')
                            + (n === 0 ? ' lc-ledger-chip-dim' : '')}
                          data-kind={p.kind}
                          {...(wire ?? {})}
                        >
                          {t('kind.' + p.kind)}
                          <b>{fmt(n)}</b>
                        </span>
                      </Fragment>
                    )
                  })}
                </span>
              </span>
            </div>
            <div className="lc-ledger-head lc-ledger-out-head">
              <span className="lc-ledger-label">{t('stats.toolCalls')}</span>
              <b className="lc-ledger-total">{fmt(toolTotal)}</b>
            </div>
            <ChipLane
              items={props.tools}
              rowClass="lc-ledger-out-chips"
              color={(_, rank) => TOOL_SHADE(rank)}
              jumpTip="stats.toolJump"
              onPick={props.onToolPick}
              onMore={props.onToolMore}
              moreTip={t('stats.toolsMoreTip')}
              zeroWhenEmpty
              t={t}
              fmt={fmt}
            />
            <div className="lc-ledger-head lc-ledger-in-head2">
              <span className="lc-ledger-label">{t('stats.commands')}</span>
              <b className="lc-ledger-total">{fmt(props.commands?.runs ?? 0)}</b>
            </div>
            <div className="lc-ledger-team">
              <div
                className={'lc-ledger-head lc-ledger-out-head2 lc-ledger-team-head lc-ledger-cost-row' + (onTeamClick === undefined ? '' : ' lc-ledger-cost-row-btn')}
                onClick={onTeamClick}
              >
                <span className="lc-strip-cell lc-ledger-team-pair lc-stat-tipped group/tip">
                  <i>
                    {openTeam === undefined
                      ? <span className="lc-ledger-label">{t('stats.fleet')}</span>
                      : <button type="button" className="lc-ledger-label lc-ledger-team-open" onClick={openTeam}>{t('stats.fleet')}</button>}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </i>
                  <span className="lc-ledger-total">
                    {costHref === undefined ? teamPair : <a className="lc-strip-link" href={costHref} target="_blank" rel="noreferrer noopener">{teamPair}</a>}
                  </span>
                </span>
                <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip" aria-hidden="true">{costTip}</span>
              </div>
              <div className="lc-ledger-out-body2">
                {costRow('own', <>
                  <i>
                    {t('stats.currentAgent')}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </i>
                  {pair(ownTokens, ownText)}
                  <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip" aria-hidden="true">{ownTip}</span>
                </>)}
                {costRow('subs', <>
                  <i>
                    {t('stats.teamSubs')}
                    {' '}
                    {sub.count > 0
                      ? <b className="lc-ledger-team-count">{t('stats.teamSubsCount', { n: sub.count })}</b>
                      : t('stats.teamSubsCount', { n: sub.count })}
                    <i className="lc-stat-q group-hover/tip:text-(--dsw-alias-label-primary) group-hover/tip:border-(--dsw-alias-label-primary)" aria-hidden="true">?</i>
                  </i>
                  {pair(sub.count === 0 ? null : subTokens, subText)}
                  <span className="lc-tip lc-stat-tip group-hover/tip:opacity-100" role="tooltip" aria-hidden="true">{subTip}</span>
                </>)}
              </div>
            </div>
            <ChipLane
              items={commandTop}
              rowClass="lc-ledger-in-body2"
              color={nameColorOf}
              jumpTip="stats.commandJump"
              onPick={props.onCommandPick}
              onMore={props.onCommandMore}
              moreTip={t('stats.commandsMoreTip')}
              t={t}
              fmt={fmt}
            />
            <div className="lc-ledger-chips lc-ledger-in-chips">
              {chip('inputs', t('stats.user'), props.humanInputs ?? 0, IO_COLOR.inputs, { jump: 'inputs', tip: t('stats.userTip') })}
              {chip('read', t('stats.fileRead'), props.files.reads, IO_COLOR.read, { jump: 'read', title: t('stats.filesJump') })}
              {chip('write', t('stats.fileWrite'), props.files.writes, IO_COLOR.write, { jump: 'write', title: t('stats.filesJump') })}
              {props.files.searches > 0 ? chip('search', t('stats.fileSearch'), props.files.searches, IO_COLOR.search, { jump: 'search', title: t('stats.filesJump') }) : null}
              {props.files.images > 0 ? chip('image', t('stats.fileImage'), props.files.images, IO_COLOR.image, { jump: 'image', title: t('stats.filesJump') }) : null}
            </div>
          </div>
        </div>
      </div>
    )
  }
}
