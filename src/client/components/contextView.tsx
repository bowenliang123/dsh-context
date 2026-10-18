import { createElement as h, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import type { Category, ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { CATS } from '../categories'
import { briefNodes, briefOf } from '../brief'
import { headlineOf } from '../headline'
import type { ContextViewProps } from '../services'
import { conversationNodesOf, headersOf, imageLoaderOf, projectionOf, unsupportedOf } from '../services'
import type { ClientCtx, ConversationNodeLike } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useContextSession } from '../sessionData'
import { makeDetailNote } from './detailNote'
import { canOpenPathsOf, openPathVia, openResourceVia, workspaceOf } from '../services'
import { makeAttachmentOpener } from '../attachmentSource'
import { activityOf, activityOfOps, locateStepOf, previewAddressOf } from '../fileActivity'
import type { FileEntry, FileOp } from '../fileActivity'
import type { ContextSettings } from '../settings'
import type { ViewKit } from '../viewkit'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf } from '../agentTree'
import { makeContextBrowser } from './browser'
import type { CatFocus } from './browser'
import { makeAgentGraph } from './agentGraph'
import { Donut } from './donut'
import { makeCurrentComposition } from './currentComposition'
import { makeEventList } from './events'
import { makeFileCard } from './fileCard'
import type { FileFilter } from './fileCard'
import { makePluginInfo } from './pluginInfo'
import { makeUpgradeGate } from './upgradeGate'
import { makeRequestDetail } from './requestDetail'
import { countsOfRecords, makeStatsContext, makeSubagentCost, toolTallyOf } from './statsContext'
import type { StatsJump } from './statsContext'
import { makeStatsTiming } from './statsTiming'
import { makeStatsTokens } from './statsTokens'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, jumpTargetOf, makeTrendChart, turnStepsOf } from './trendChart'
import { makeTrendOverview } from './trendOverview'
import { cachedByData, assembleCached } from './derivedCache'
import { useLazyMount } from './useLazyMount'
import { trendBandsOf } from '../dna'
import type { TrendBand } from '../dna'

import { activateViewTab, openContextSidebar, subscribeContextFocus, takeContextFocus } from '../viewFocus'
import { revealInScrollParent } from '../revealScroll'
import { makeErrorBoundary } from './errorBoundary'

// The page scrolls inside the conversation's shared `[data-conversation-scroll]` container, which the chat bottom-anchors;
// a module-level per-session ledger survives tab remounts and restores once content renders.
const viewScroll = new Map<string, number>()

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const
/** Ordinary sweeps coalesce on this trailing delay; DNA bars are heavier and wait longer for the pointer to rest. */
const HOVER_DELAY_MS = 140
const DNA_HOVER_DELAY = 220
/** Above this many retained steps the DNA bands are built lazily per rendered window. */
const DNA_LAZY_MIN = 512

/** Scroll a landed-on card to the top of the page's scrollport: the stats jumps and the events card's injection
 *  rows land on the browser, the stats file pills on the File Activity card, and no landing may stay below the fold. */
function revealCard(root: HTMLElement | null, selector: string): void {
  /* v8 ignore start -- every render path attaches the root and draws the landed-on card, so the target always resolves. */
  const card = root?.querySelector(selector) ?? null
  if (card !== null) revealInScrollParent(card)
  /* v8 ignore stop */
}

/** Reveal the browser card only when NO part of it is in the window's visible slice (stacked narrow
 * layouts where the card sits below the fold): the in-card row reveal cannot be seen from there. An
 * unconditional top-alignment would yank the page on wide layouts, where the card sits beside the reader. */
function revealBrowserIfOffscreen(root: HTMLElement | null): void {
  /* v8 ignore start -- every render path attaches the root and draws the browser card, so the target always resolves. */
  if (root === null) return
  const browser = root.querySelector('.lc-col-browser')
  if (browser === null) return
  const br = browser.getBoundingClientRect()
  if (br.bottom <= 0 || br.top >= window.innerHeight) revealInScrollParent(browser)
  /* v8 ignore stop */
}

/** The Context browser's height ceiling: the span from the first left card's top to the last card's bottom
 * (the current-composition card plus the trend card, inter-card gap included), rounded up so the card is
 * never shorter than the cards beside it and the cards below never move. The cards' own boxes — not the
 * column's — keep the cap independent of the browser card stretching the row. Null — uncapped — while no
 * usable card measurement exists (the loading frame, or a layout-less rect). */
export function browserCapOf(cards: readonly { top: number; bottom: number }[]): number | null {
  const first = cards.at(0)
  const last = cards.at(-1)
  if (first === undefined || last === undefined) return null
  const span = last.bottom - first.top
  return Number.isFinite(span) && span > 0 ? Math.ceil(span) : null
}

/** The trend card's reserved body: the plot lane plus an empty detail panel wearing the panel's OWN classes, so the
 * pending and loaded states are measured by the same CSS and cannot drift. Without it the first step's arrival grew
 * the card by its whole height and shoved every card below it down the page. */
function TrendReserved(props: { children: ReactNode; catLabel: (cat: Category | 'system' | 'tools') => string }): ReactElement {
  return (
    <div className="lc-trend-lane">
      <div className="lc-trend-plot">{props.children}</div>
      <div className="lc-detail">
        <div className="lc-detail-head" />
        <div className="lc-brief" />
        <div className="lc-stacked-wrap"><div className="lc-stacked" /></div>
        <div className="lc-legend">
          {CATS.map(c => (
            <span key={c.key} className="lc-chip">
              <i style={{ background: c.color }} />
              <span className="lc-chip-label">{props.catLabel(c.key)}</span>
              <span className="lc-chip-nums" />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}

export function makeContextView(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
  /** The page-scope cold-head cache the caller shares across every agent-data reader. */
  heads: AgentHeads,
): (props: ContextViewProps) => ReactElement {
  const { t, catLabel } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const TrendChart = makeTrendChart(kit)
  const TrendOverview = makeTrendOverview(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar, Legend)
  const EventList = makeEventList(kit)
  const FileCard = makeFileCard(kit, settings)
  // The stats board's subagent-cost cell reads the shared page-scope cold-head cache.
  const StatsContext = makeStatsContext(kit, makeSubagentCost(ctx, heads))
  const StatsTiming = makeStatsTiming(kit, Donut)
  const StatsTokens = makeStatsTokens(kit, Donut)
  const PluginInfo = makePluginInfo(kit)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextViewBody(props: ContextViewProps): ReactElement {
    const sessionId = props.sessionId
    const inSidebar = props.host === 'sidebar'
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    // `contextHeaders` (full system prompt + tool schemas) for the Context browser; absent on older Host halves →
    // tokens-only sections with a note.
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = useState<number | null>(null)
    // Mount-time defaults from the plugin settings card; in-chart toggling stays mount-local and never writes back.
    const [granularity, setGranularity] = useState<'step' | 'turn'>(() => settings.defaultGranularity())
    const [trendMode, setTrendMode] = useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    // DNA mode: per-item fingerprints of each request's context (dna.ts).
    const [dna, setDna] = useState(false)
    const [adaptive, setAdaptive] = useState(false)
    // The overview face: the whole retained log as one continuous ribbon (trendOverview.tsx). Exclusive with DNA
    // mode (per-bar fingerprints are illegible at ribbon scale) and Adaptive (the whole log IS the visible
    // window): activating one clears the others.
    const [overview, setOverview] = useState(false)
    const [durationCurve, setDurationCurve] = useState(() => settings.defaultDurationCurve() === 'show')
    const [focusTurn, setFocusTurn] = useState<number | null>(null)
    const [jumpSeq, setJumpSeq] = useState<number | null>(null)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [focusCat, setFocusCat] = useState<string | null>(null)
    // Sidebar-hosted copies stay mounted while the sidebar is collapsed (the dock only hides them): track real
    // visibility so a hidden copy stops rendering its cards and the page never pays for two full context views.
    const [sidebarVisible, setSidebarVisible] = useState(true)
    // Pointer-driven hovers are transient: they must never block the pointer. The chart keeps its own immediate
    // hover state, while the rest of the view (browser preview, file activity) follows in a transition so a
    // pointer sweep cannot stack synchronous full-view renders.
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hoverPending = useRef<number | null>(null)
    const hoverAt = useRef(0)
    const clearHoverTimer = useCallback((): void => {
      if (hoverTimer.current !== null) {
        clearTimeout(hoverTimer.current)
        hoverTimer.current = null
      }
    }, [])
    useEffect(() => clearHoverTimer, [clearHoverTimer])
    const handleHover = useCallback((seq: number | null): void => {
      hoverPending.current = seq
      if (seq === null) {
        clearHoverTimer()
        hoverAt.current = 0
        setHoveredSeq(null)
        return
      }
      const now = performance.now()
      // First entry (or a deliberate slow move) previews immediately; a pointer sweep keeps only the trailing
      // value, so the browser preview cannot force a layout per pointer event while the chart stays instant.
      // DNA bars carry thousands of bands: previewing every bar enter made each sweep cost a full view render,
      // so DNA mode only follows once the pointer rests (the chart's own hover stays instant).
      if (!dna && now - hoverAt.current > HOVER_DELAY_MS) {
        clearHoverTimer()
        hoverAt.current = now
        setHoveredSeq(seq)
        return
      }
      hoverAt.current = now
      clearHoverTimer()
      hoverTimer.current = setTimeout(() => {
        hoverTimer.current = null
        const trailing = seq
        startTransition(() => {
          /* v8 ignore next 2 -- the timer is cleared by a reset; the guard only covers a transition already
             queued behind that reset, which jsdom's synchronous act cannot interleave. */
          if (hoverPending.current === trailing) setHoveredSeq(trailing)
        })
      }, dna ? DNA_HOVER_DELAY : HOVER_DELAY_MS)
    }, [clearHoverTimer, dna])
    const handleHoverTurn = useCallback((turn: number | null): void => {
      startTransition(() => { setHoverTurn(turn) })
    }, [])
    const handleHoverKey = useCallback((key: string | null): void => {
      startTransition(() => { setHoverCat(key) })
    }, [])
    /* v8 ignore start -- jsdom has neither IntersectionObserver nor layout: the gate is verified in the live page. */
    useEffect(() => {
      if (!inSidebar || typeof IntersectionObserver !== 'function') return
      const el = rootRef.current
      if (el === null) return
      const observer = new IntersectionObserver(([entry]) => {
        setSidebarVisible(entry.isIntersecting)
      }, { threshold: 0 })
      observer.observe(el)
      return () => { observer.disconnect() }
    }, [inSidebar, data])
    /* v8 ignore stop */
    const [pickedKinds, setPickedKinds] = useState<string[]>([...EVENT_KINDS])
    const toggleKind = (k: string) => {
      setPickedKinds((p) => {
        if (p.length === EVENT_KINDS.length) return [k]
        if (!p.includes(k)) return [...p, k]
        return p.length === 1 ? [...EVENT_KINDS] : p.filter(x => x !== k)
      })
    }
    // One-shot reveal bridge; `key` is the band key both DNA surfaces share ('sys' / 'tool:<name>' / 'n<seq>').
    const [nodeFocus, setNodeFocus] = useState<{ step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null>(null)
    const clearNodeFocus = useCallback(() => { setNodeFocus(null) }, [])

    const loadImage = useMemo(
      () => imageLoaderOf(ctx, typeof sessionId === 'string' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // The gateway page face can land after the first render (a watch rebuild remounts this view before the fiber
    // re-fires): the fetchers below must rebuild when it lands or is revoked.
    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(sessionId)
        : undefined),
      [sessionId, historyFace],
    )

    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollerRef = useRef<HTMLElement | null>(null)
    // The session whose position was already applied this mount — re-applying on re-renders would yank the reader's scroll.
    const restoredRef = useRef<string | null>(null)
    const [catFocus, setCatFocus] = useState<CatFocus | null>(null)
    const clearCatFocus = useCallback(() => { setCatFocus(null) }, [])
    // One-shot File Activity kind request from the stats board's file pills (the card owns the chips otherwise).
    const [filterFocus, setFilterFocus] = useState<FileFilter | null>(null)
    const clearFilterFocus = useCallback(() => { setFilterFocus(null) }, [])

    // Below-the-fold cards: keep the first commit to the cards the reader actually sees, then mount the event/file
    // row in an idle slice once it nears the conversation viewport. The two skeleton cards reserve the row height.
    const [belowFoldRef, belowFoldMounted] = useLazyMount(filterFocus !== null)
    // The browser card is visible but heavy (assembled rows for the current step): paint its card-shaped skeleton
    // in the first commit, then fill it in the next idle slice so the open's commit stays small.
    const [browserRef, browserMounted] = useLazyMount()

    // The browser column's height cap (browserCapOf), re-measured for new data and ResizeObserver ticks:
    // pane drags and card reflows change no prop.
    const leftColRef = useRef<HTMLDivElement | null>(null)
    const [browserCap, setBrowserCap] = useState<number | null>(null)
    const [capTick, setCapTick] = useState(0)
    useLayoutEffect(() => {
      const col = leftColRef.current
      /* v8 ignore next 1 -- the loading frame renders no left column; every carded render attaches it. */
      if (col === null) return
      // The column renders exactly the composition + trend cards.
      const next = browserCapOf([...col.children].map(el => el.getBoundingClientRect()))
      setBrowserCap(prev => (prev === next ? prev : next))
      // Hover/selection commits change no card geometry: only a new projection or a ResizeObserver tick
      // needs a fresh measurement, so a pointer sweep never flushes layout here.
    }, [data, capTick])
    /* v8 ignore start -- jsdom has neither ResizeObserver nor layout: the cap's math is pinned by browserCapOf's unit tests. */
    useEffect(() => {
      const col = leftColRef.current
      if (col === null || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { setCapTick(tick => tick + 1) })
      observer.observe(col)
      for (const el of col.querySelectorAll(':scope > .lc-card')) observer.observe(el)
      return () => { observer.disconnect() }
    }, [data])
    /* v8 ignore stop */
    // The stats board's jumps: a browser key lands on its own category row (skills inject, answers, user messages),
    // a file kind on the File Activity card's matching chip.
    const onJump = useCallback((jump: StatsJump): void => {
      if (jump === 'read' || jump === 'write' || jump === 'search' || jump === 'image') {
        // The below-fold row may still be lazy: setting the focus forces its mount, and the effect below
        // reveals the card once it exists.
        setFilterFocus(jump)
        return
      }
      setCatFocus(jump === 'skills'
        ? { cat: 'skill' }
        : jump === 'answers' ? { cat: 'assistant', kind: 'answer' } : { cat: 'user' })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [])
    // The stats board's family cell names the Agent Network card: its own tab when the preferences serve one,
    // else the right Sidebar panel that keeps the card inline. A deployment serving neither — a stripped
    // harness, or the tab hidden with no Sidebar — leaves the cell a plain figure instead of a dead button.
    const hasFamilyView = settings.fleetTab() === 'show' || settings.defaultPlacement() !== 'tab'
    const onTeamClick = useCallback((): void => {
      if (!activateViewTab(t('tab.fleet'))) openContextSidebar(ctx)
    }, [t])

    // Restore the saved position in a layout effect, so the chat's bottom-anchored position never flashes in first.
    useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '' || data === null) return
      if (restoredRef.current === sessionId) return
      restoredRef.current = sessionId
      /* v8 ignore next 3 -- a layout effect body only runs while mounted and
         both render paths attach rootRef, so the null arm cannot fire. */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller === null) return
      scrollerRef.current = scroller as HTMLElement
      scroller.scrollTop = viewScroll.get(sessionId) ?? 0
    }, [sessionId, data])

    // Save the position in a layout-effect cleanup, so it fires before the incoming view's layout effects re-scroll the shared container.
    useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
      }
    }, [sessionId])

    // No locale subscription here: the harness slot outlet re-renders every entry on a locale switch, and the kit's
    // bound `t` reads the active locale at call time.

    const requests = data ? data.requests : []
    const events = data ? data.events : []
    const counts = data?.counts ?? countsOfRecords(requests, events)
    // Only the three kinds the host tallies; model/mode switches carry no count.
    const kindCounts: Record<string, number | undefined> = { inject: counts.injects, compaction: counts.compactions, prune: counts.prunes }
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    // Per-step bars, or one per turn (each turn's LAST step's record); memoized so hover-driven re-renders keep bar props identity-stable.
    const displayRequests = useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    // Tallied over the RAW step records — turn-mode aggregates read their own stepCount instead.
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const markers = useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])
    // One assemble() per displayed record — the same pure reconstruction the browser uses — memoized so hover-driven
    // re-renders never reassemble.
    /* v8 ignore next 1 -- a missing projection returns the loading screen before the trend card
       (and its DNA toggle) renders, so `dna && data === null` cannot occur. */
    // A long log carries thousands of requests: assembling every step's context up front blocked the DNA toggle.
    // Small logs and delta mode keep the eager array; large total-mode logs hand the chart a per-seq accessor so only
    // the rendered window assembles. Delta needs every bar's per-key change: net totals cannot bound key churn.
    /* v8 ignore next 1 -- the sidebar-visible operand is only reachable in a live dock (jsdom has no IO);
       the hidden-copy path is verified on the live page and every main-host test covers the short-circuit. */
    const dnaAllowed = dna && data !== null && (!inSidebar || sidebarVisible)
    const dnaEager = dnaAllowed && (displayRequests.length <= DNA_LAZY_MIN || trendMode === 'delta')
    // Bands depend on the header epoch as well as the timeline; the composite owner keeps a late epoch from
    // reusing bands assembled without its system prompt/tool schemas.
    const dnaCacheOwner = useMemo(() => ({ data, headers }), [data, headers])
    const dnaBands = useMemo(
      () => (dnaEager
        ? cachedByData(dnaCacheOwner, `dna:${granularity}`, () => displayRequests.map(req => trendBandsOf(assembleCached(data, headers, req.seq))))
        : null),
      [dnaEager, dnaCacheOwner, data, headers, displayRequests, granularity],
    )
    const dnaAt = useMemo(() => {
      if (!dnaAllowed || displayRequests.length <= DNA_LAZY_MIN || trendMode === 'delta') return null
      const bandsBySeq = new Map<number, TrendBand[]>()
      return (seq: number): TrendBand[] => {
        let bands = bandsBySeq.get(seq)
        /* v8 ignore next 1 -- the chart's own per-seq cache makes a repeated lookup here defensive only. */
        if (bands === undefined) {
          bands = trendBandsOf(assembleCached(data, headers, seq))
          bandsBySeq.set(seq, bands)
        }
        return bands
      }
    }, [dnaAllowed, data, headers, displayRequests.length, trendMode])
    const revealBand = useCallback((seq: number, band: { key: string; cat: Category | 'system' | 'tools' }): void => {
      setNodeFocus({ step: seq, key: band.key, cat: band.cat })
    }, [])

    // A stats file-pill jump can target the lazy below-fold row: reveal it once the forced mount lands.
    useEffect(() => {
      if (filterFocus === null || !belowFoldMounted) return
      revealCard(rootRef.current, '.lc-fa-card')
    }, [filterFocus, belowFoldMounted])

    // Chat → Context jump, leg 1: pick up the relay's request once per mount and on every later record (the sidebar
    // landing keeps this view mounted).
    useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const take = (): void => {
        const seq = takeContextFocus(sessionId)
        if (seq !== null) setJumpSeq(seq)
      }
      take()
      return subscribeContextFocus(take)
    }, [sessionId])

    // Leg 2: the relayed seq is the turn's LAST request — exactly the aggregate's record — so the jump pins that turn bar; the one-shot
    // request must not be consumed while the split generation's collections are still pending (it re-fires when they land).
    const detailReady = source.detailState === 'ready' || source.detailState === 'legacy'
    useEffect(() => {
      if (jumpSeq === null || data === null || !detailReady) return
      setJumpSeq(null)
      const target = jumpTargetOf(aggregateByTurn(requests), jumpSeq)
      if (target === null) return
      setGranularity('turn')
      setSelectedSeq(target.seq)
      setFocusTurn(target.turn ?? 0)
      /* v8 ignore next 2 -- the effect only fires while mounted, and both render paths attach
         rootRef and render the composition card. */
      const anchor = rootRef.current?.querySelector('[data-lc-current]') ?? null
      if (anchor !== null) revealInScrollParent(anchor)
    }, [jumpSeq, data, requests, detailReady])

    const briefList = useMemo(() => (data ? cachedByData(data, 'briefList', () => briefNodes(data)) : []), [data])
    const convNodes = conversationNodesOf(props)
    const bySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    let pinnedIdx = -1
    for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === selectedSeq) pinnedIdx = i
    const pinnedReq = pinnedIdx >= 0 ? displayRequests[pinnedIdx] : null
    let activeIdx = -1
    if (hoveredSeq !== null) {
      for (let i = 0; i < displayRequests.length; i++) if (displayRequests[i].seq === hoveredSeq) { activeIdx = i; break }
    }
    if (activeIdx < 0) activeIdx = pinnedIdx
    if (activeIdx < 0 && displayRequests.length > 0) activeIdx = displayRequests.length - 1
    const activeReq = activeIdx >= 0 ? displayRequests[activeIdx] : null
    // File activity follows the same active bar: the EXCLUSIVE upper bound is the next RAW request's seq (the picked step's own
    // tool calls count too); the latest bar's null bound serves everything.
    let filesBefore: number | null = null
    if (activeReq !== null) {
      const ri = requests.findIndex(r => r.seq === activeReq.seq)
      filesBefore = ri + 1 < requests.length ? requests[ri + 1].seq : null
    }
    const brief = useMemo(
      () => (activeReq !== null ? briefOf(briefList, displayRequests, activeIdx) : null),
      [activeReq, briefList, displayRequests, activeIdx],
    )
    const convOf = useCallback((seq: number): ConversationNodeLike | undefined => bySeq.get(seq), [bySeq])

    // Memoized on the walk's inputs only: hover/select renders elsewhere leave every input reference untouched, so the walk is skipped.
    // The live chat-node map moves independently of the projection, so it joins the cache owner.
    const fileCacheOwner = useMemo(() => ({ data, bySeq }), [data, bySeq])
    const fileActivity = useMemo(
      () => {
        if (data === null) return activityOf(briefList, convOf, filesBefore)
        return cachedByData(fileCacheOwner, `files:${String(filesBefore)}`, () => (
          data.fileOps !== undefined
            ? activityOfOps(data.fileOps, data.archive, filesBefore)
            : activityOf(briefList, convOf, filesBefore)
        ))
      },
      [fileCacheOwner, data, briefList, convOf, filesBefore],
    )
    // The stats card's pill tallies; the null bound means the WHOLE session.
    const ioTotals = useMemo(
      () => {
        const totals = (data !== null && data.fileOps !== undefined
          ? activityOfOps(data.fileOps, data.archive, null)
          : activityOf(briefList, convOf, null)).totals
        return { reads: totals.read.ops, writes: totals.write.ops, searches: totals.search.ops, images: totals.image.ops }
      },
      [data, briefList, convOf],
    )
    const toolTally = useMemo(() => (data ? cachedByData(data, 'toolTally', () => toolTallyOf(data.nodes)) : []), [data])
    // Read per render off the observable snapshot, so the next projection push re-renders with the current workspace root.
    const workspace = typeof ctx.get === 'function' ? workspaceOf(ctx, typeof sessionId === 'string' ? sessionId : undefined) : undefined
    // The capability is an async RPC answer, so file names stay inert until the probe settles.
    const [canOpenPaths, setCanOpenPaths] = useState(false)
    useEffect(() => {
      let live = true
      void canOpenPathsOf(ctx).then((can) => { if (live) setCanOpenPaths(can) })
      return () => { live = false }
    }, [ctx])
    const fileOpener = useMemo(
      () => (canOpenPaths ? openPathVia(ctx) : undefined),
      [canOpenPaths, ctx],
    )
    // The preview column this tab registers into; the face is re-proved per call, so an HMR revocation leaves no stale opener.
    const previewOpener = useMemo(() => openResourceVia(ctx), [ctx])
    const sessionKey = typeof sessionId === 'string' ? sessionId : undefined
    const previewFile = useMemo(
      () => previewOpener === undefined
        ? undefined
        : (entry: FileEntry): boolean => {
          const address = previewAddressOf(entry.path, entry.form, entry.pattern, sessionKey, workspace)
          return address !== undefined && previewOpener(address)
        },
      [previewOpener, sessionKey, workspace],
    )
    const openAttachment = useMemo(
      () => makeAttachmentOpener(ctx, typeof sessionId === 'string' ? sessionId : undefined, workspace),
      [ctx, sessionId, workspace],
    )
    const locateFileOp = useCallback((op: FileOp): void => {
      // A nested Code-Mode op has no surface row of its own — it reveals on its parent run_code result.
      const seq = op.parent ?? op.seq
      const step = locateStepOf(requests, seq, op.gone)
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(seq), cat: 'tool' })
    }, [requests])
    // A response node (seq === the request's) first appears in the NEXT step's surface, or the live surface on the last bar.
    const locateNode = useCallback((node: SurfaceNode, isResponse: boolean): void => {
      /* v8 ignore next 1 -- locateNode is only wired to brief rows, and
         brief !== null guarantees activeReq !== null in the same closure. */
      if (activeReq === null) return
      const next = isResponse && activeIdx + 1 < displayRequests.length ? displayRequests[activeIdx + 1] : null
      const step: number | 'live' = isResponse ? (next !== null ? next.seq : 'live') : activeReq.seq
      setNodeFocus({ step, key: 'n' + String(node.seq), cat: node.cat })
      revealBrowserIfOffscreen(rootRef.current)
    }, [activeReq, activeIdx, displayRequests])

    // An injection event carries the seq of the very surface node it added (fold.ts), so its row can reveal that node
    // at the step that first carried it. Resolution comes from the served node: its `gone` stamp bounds the reveal
    // (a removed item shows only on the steps before its removal), and its category is the fold's own verdict — skill
    // machinery lands in `skill`, which the event's `sub` does not cover (the catalog digest rides an untagged event).
    const nodeOfSeq = useMemo(() => {
      if (data === null) return new Map<number, SurfaceNode>()
      return cachedByData(data, 'nodeOfSeq', () => {
        const m = new Map<number, SurfaceNode>()
        for (const n of data.nodes) m.set(n.seq, n)
        for (const n of data.archive) m.set(n.seq, n)
        return m
      })
    }, [data])
    const focusInject = useCallback((ev: ContextEventRecord): void => {
      const node = nodeOfSeq.get(ev.seq)
      const step = locateStepOf(requests, ev.seq, node?.gone)
      // Removed before any step dispatched it: there is nothing left to show.
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(ev.seq), cat: node?.cat ?? 'inject' })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [requests, nodeOfSeq])

    if (!data) {
      return (
        <div className="lc-root" ref={rootRef}>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      /** v8 ignore next 1 -- the only caller passes displayRequests[activeIdx], an element of the very array indexOf scans. */
      return i >= 0 ? markers[i] : undefined
    }

    // Provider-anchored occupancy: the 4-chars/token heuristic undercounts CJK by ~10–15%, so the headline anchors to the billed total.
    const head = headlineOf(data, pressure, breakdown)
    let fileScope = t('files.scopeLatest')
    if (activeReq !== null && filesBefore !== null) {
      fileScope = activeReq.stepCount !== undefined && activeReq.stepCount > 1
        ? t('detail.turn', { t: activeReq.turn ?? 0, n: activeReq.stepCount })
        : t('detail.step', { t: activeReq.turn ?? 0, s: activeReq.step ?? 0, n: stepsOf(activeReq.turn) })
    }

    // Turn highlight is hover-only (strip hover wins, then the hovered bar's turn): no fallback, so a pinned or
    // default selection never glows.
    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    // Mirrors the browser's shared category hover; the overview's 'free' key drops — it has no segment in the chart or the detail bar.
    const trendHoverCat = hoverCat !== null && hoverCat !== 'free' ? hoverCat : null

    const localeSvc = ctx.get('locale')
    const activeLocale = localeSvc !== undefined && typeof localeSvc.getLocale === 'function'
      ? localeSvc.getLocale().active
      : 'en'
    const subtitle = (data.model ?? '') + (data.provider ? ' · ' + data.provider : '')
    const gate = unsupportedOf(data.unsupported)

    /* v8 ignore next 2 -- only a real dock collapse hides a sidebar copy; jsdom has no IntersectionObserver. */
    if (inSidebar && !sidebarVisible) return <div className="lc-root" ref={rootRef} />

    const compositionCard = (
      <CurrentComposition
        head={head}
        subtitle={subtitle}
        hoverKey={hoverCat}
        onHoverKey={handleHoverKey}
      />
    )
    // Both trend faces share the records + hover/select flow; only the overview's turn click pins instead of
    // scroll-centering (there is no scroll), and the bar chart carries DNA/adaptive extras. The `key` stays out —
    // a spread carrying it trips React's spread-key warning — and rides the faces explicitly for the per-session
    // remount that re-anchors at the newest bars instead of inheriting stale scroll state.
    const trendBase = {
      // ALL retained requests (bounded by the host's maxKeptTurns/maxRequestSteps config): earlier
      // turns/steps stay reachable via scroll or the fit width.
      requests: displayRequests,
      markers,
      selectedSeq: pinnedReq ? pinnedReq.seq : null,
      hoveredSeq,
      activeTurn,
      granularity,
      mode: trendMode,
      hoverCat: trendHoverCat,
      focusCat,
      durationCurve,
      onSelect: setSelectedSeq,
      onHover: handleHover,
      onHoverTurn: handleHoverTurn,
    }
    const trendCard = (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('trend.title')}</span>
          <span className="lc-gran lc-trend-mods" role="group">
            <button
              type="button"
              className={'lc-gran-btn' + (dna ? ' lc-gran-on' : '')}
              title={t('trend.dnaTip')}
              onClick={() => {
                const on = !dna
                setDna(on)
                if (on) setOverview(false)
              }}
            >{t('trend.dna')}</button>
            <button
              type="button"
              className={'lc-gran-btn' + (adaptive ? ' lc-gran-on' : '')}
              title={t('trend.adaptiveHint')}
              onClick={() => {
                const on = !adaptive
                setAdaptive(on)
                if (on) setOverview(false)
              }}
            >{t('trend.adaptive')}</button>
            <button
              type="button"
              className={'lc-gran-btn' + (durationCurve ? ' lc-gran-on' : '')}
              title={t('trend.durationTip')}
              onClick={() => { setDurationCurve(on => !on) }}
            >{t('trend.duration')}</button>
            <button
              type="button"
              className={'lc-gran-btn' + (overview ? ' lc-gran-on' : '')}
              title={t('trend.overviewTip')}
              onClick={() => {
                const on = !overview
                setOverview(on)
                if (on) { setDna(false); setAdaptive(false) }
              }}
            >{t('trend.overview')}</button>
          </span>
          <div className="lc-trend-ctl">
            <div className="lc-gran">
              <button
                className={'lc-gran-btn' + (granularity === 'step' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('step') }}
              >{t('gran.step')}</button>
              <button
                className={'lc-gran-btn' + (granularity === 'turn' ? ' lc-gran-on' : '')}
                onClick={() => { setGranularity('turn') }}
              >{t('gran.turn')}</button>
            </div>
            <div className="lc-gran" title={t('gran.modeHint')}>
              <button
                className={'lc-gran-btn' + (trendMode === 'total' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('total') }}
              >{t('gran.total')}</button>
              <button
                className={'lc-gran-btn' + (trendMode === 'delta' ? ' lc-gran-on' : '')}
                onClick={() => { setTrendMode('delta') }}
              >{t('gran.delta')}</button>
            </div>
          </div>
        </div>
        {displayRequests.length === 0
          // Split generation, first detail read pending or failed: say so instead of claiming no history.
          ? (detailReady
            ? <TrendReserved catLabel={catLabel}><div className="lc-empty">{t('trend.empty')}</div></TrendReserved>
            : <TrendReserved catLabel={catLabel}>
              <DetailNote state={source.detailState === 'failed' ? 'failed' : 'loading'} onRetry={source.retryDetail} />
            </TrendReserved>)
          : (
            <div>
              {overview
                ? (
                  <TrendOverview
                    key={sessionId}
                    {...trendBase}
                    onPickTurn={(turn) => {
                      setGranularity('turn')
                      // No scroll to center: pin the turn's closing record — the same seq its aggregate keeps.
                      let seq: number | null = null
                      for (const req of displayRequests) if ((req.turn ?? 0) === turn) seq = req.seq
                      /* v8 ignore next 1 -- the clicked block always has records (blocks walk the same list),
                         so the pinned seq is never null. */
                      if (seq !== null) setSelectedSeq(seq)
                    }}
                  />
                )
                : (
                  <TrendChart
                    key={sessionId}
                    {...trendBase}
                    focusTurn={focusTurn}
                    adaptive={adaptive}
                    dna={dnaBands}
                    dnaAt={dnaAt}
                    onPickBand={revealBand}
                    onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                    onFocusTurnHandled={() => { setFocusTurn(null) }}
                  />
                )}
              <RequestDetail
                request={activeReq}
                // Delta mode pairs the detail with the SAME previous record the chart diffs against (first bar: null).
                prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1] : null) : undefined}
                /** v8 ignore next 1 -- RequestDetail renders only when displayRequests.length > 0, which forces activeReq
                 * non-null via the activeIdx fallback above. */
                marker={activeReq !== null ? markerOf(activeReq) : undefined}
                brief={brief}
                convOf={convOf}
                stepsOf={stepsOf}
                onLocate={locateNode}
                hoverKey={trendHoverCat}
                onHoverKey={handleHoverKey}
              />
            </div>
          )}
      </div>
    )
    const browserCard = (
      <ContextBrowser
        data={data}
        headers={headers}
        convNodes={convNodes}
        fetchContent={fetchContent}
        fetchHeader={fetchHeader}
        previewSeq={hoveredSeq}
        pinSeq={pinnedReq !== null ? pinnedReq.seq : null}
        hoverKey={hoverCat}
        onHoverKey={handleHoverKey}
        onOpenCat={setFocusCat}
        nodeFocus={nodeFocus}
        onNodeFocusHandled={clearNodeFocus}
        loadImage={loadImage}
        openAttachment={openAttachment}
        detailState={source.detailState}
        onDetailRetry={source.retryDetail}
        catFocus={catFocus}
        onCatFocusHandled={clearCatFocus}
        // The DNA switch is shared with the trend card: both toggles move as one.
        dna={dna}
        onDnaChange={setDna}
        locale={activeLocale}
      />
    )

    return (
      <div className="lc-root" ref={rootRef}>

        {inSidebar ? null : (
          <div className="lc-cols lc-head">
            <StatsContext counts={counts} humanInputs={data.humanInputs} answers={data.answers} toolCalls={data.toolCalls}
              files={ioTotals} tools={toolTally}
              cost={data.cost} locale={activeLocale} sessionId={typeof sessionId === 'string' ? sessionId : undefined}
              onJump={onJump} onTeamClick={hasFamilyView ? onTeamClick : undefined} />
            <PluginInfo />
          </div>
        )}
        <div className="lc-cols lc-head">
          <StatsTokens usage={usage} current={data.current} breakdown={breakdown} />
          <StatsTiming timing={data.timing ?? null} spans={data.spans} locale={activeLocale} />
        </div>

        <div className="lc-cols lc-cols-main">
          <div className="lc-col flex-1 min-w-[min(360px,100%)]" ref={leftColRef}>{compositionCard}{trendCard}</div>
          {/* The row's stretch makes the cap the card's height, ending it flush with the left cards; the
              /context modal draws its own stack and fills its own card. The DNA feed lays out every
              message, so the card's rows region scrolls inside the capped card. */}
          <div
            ref={browserRef}
            className="lc-col lc-col-browser flex-1 min-w-[min(360px,100%)]"
            style={browserCap !== null ? { maxHeight: browserCap } : undefined}
          >{browserMounted ? browserCard : <div className="lc-card lc-deferred-skeleton" style={{ height: '100%', minHeight: 320 }} aria-hidden="true" />}</div>
        </div>

        <div className="lc-cols" ref={belowFoldRef}>
          {belowFoldMounted ? (<>
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)]">
              <div className="lc-card-title">
                <span className="lc-card-title-text">{t('events.title')}</span>
                <div className="lc-kinds @max-[380px]/lc-card:flex-wrap">
                  {EVENT_KINDS.map((k) => {
                    const n = kindCounts[k]
                    return (
                      <button
                        key={k}
                        data-kind={k}
                        className={'lc-gran-btn' + (pickedKinds.includes(k) ? ' lc-gran-on lc-kind-' + k : '')}
                        onClick={() => { toggleKind(k) }}
                      >
                        {t('kind.' + k)}
                        {n !== undefined ? <span className="lc-kind-n">{kit.fmt(n)}</span> : null}
                      </button>
                    )
                  })}
                </div>
              </div>
              <EventList events={shownEvents} state={source.detailState} onRetry={source.retryDetail} onInjectFocus={focusInject} />
            </div>
            <FileCard activity={fileActivity} scope={fileScope} workspace={workspace}
              onPreview={previewFile} onOpen={fileOpener} onLocate={locateFileOp}
              filterFocus={filterFocus} onFilterFocusHandled={clearFilterFocus}
              state={source.detailState} onRetry={source.retryDetail} />
          </>) : (<>
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)] lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)] lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
          </>)}
        </div>

        {/* The card's standalone home is the Fleet tab; the right Sidebar's panel is too narrow to split, so it keeps the card inline. */}
        {inSidebar ? (
          <AgentGraph
            sessionId={typeof sessionId === 'string' ? sessionId : undefined}
            self={agentSelfOf(data, pressure, breakdown, usage)}
          />
        ) : null}

        <div className="lc-foot">{t('footer')}</div>

        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  return function ContextView(props: ContextViewProps): ReactElement {
    return h(ErrorBoundary, null, h(ContextViewBody, props))
  }
}
