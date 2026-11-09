import { createElement as h, startTransition, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import type { Category, ContextEventRecord, RequestRecord, SurfaceNode } from '../../shared/types'
import { TrendReserved } from './trendReserved'
import { briefNodes, briefOf } from '../brief'
import { headlineOf } from '../headline'
import type { ContextViewProps } from '../services'
import { conversationNodesOf, headersOf, imageLoaderOf, projectionOf, seatKeyOf, seatOf, sessionAddressOf, unsupportedOf } from '../services'
import type { ClientCtx, ConversationNodeLike } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useContextSession } from '../sessionData'
import { makeDetailNote } from './detailNote'
import { canOpenPathsOf, openPathVia, openResourceVia, workspaceOf } from '../services'
import { makeAttachmentOpener } from '../attachmentSource'
import { activityOf, activityOfOps, locateStepOf, previewAddressOf, surfaceSeqOf } from '../fileActivity'
import type { FileEntry, FileOp } from '../fileActivity'
import { commandsOf, programsOf, tallyOfCommands, viewsOf, surfaceSeqOf as commandSurfaceSeqOf } from '../commands'
import type { Command } from '../commands'
import type { ContextSettings } from '../settings'
import { overviewThresholdOf } from '../settings'
import type { ViewKit } from '../viewkit'
import { IconCompareSplit, IconContextInjection } from '../primitives'
import type { AgentHeads } from '../agentHeads'
import { agentSelfOf, providerModelLabelOf } from '../agentTree'
import { makeContextBrowser } from './browser'
import type { CatFocus } from './browser'
import { makeAgentGraph } from './agentGraph'
import { Donut } from './donut'
import { makeCurrentComposition } from './currentComposition'
import { makeEventList } from './events'
import { makeFileCard } from './fileCard'
import type { FileFilter } from './fileCard'
import { makeCommandPanel } from './commandPanel'
import { makeCommandPager } from '../commandPages'
import { useCommandLog } from './useCommandLog'
import { tallyEntriesOf } from '../tallySort'
import { makePluginInfo } from './pluginInfo'
import { makeRecomCard } from './recomCard'
import { makeUpgradeGate } from './upgradeGate'
import { makeRequestDetail } from './requestDetail'
import { countsOfRecords, makeStatsContext, makeSubagentCost, toolTallyOf } from './statsContext'
import type { StatsEventKind, StatsJump } from './statsContext'
import { makeStatsTiming } from './statsTiming'
import { makeStatsTokens } from './statsTokens'
import { makeLegend, makeStackedBar } from './stackedBar'
import { makeTrendChart } from './trendChart'
import { aggregateByTurn, attachMarkers, boundaryIndex, jumpTargetOf, turnStepsOf } from './trendModel'
import { makeTrendOverview } from './trendOverview'
import { stepStampOf } from './browserHelpers'
import { assembleCached, cachedByData } from './derivedCache'
import { useLazyMount } from './useLazyMount'
import { useConversationSurface } from './useConversationSurface'
import { dnaDeltaMaximaOf, trendBandsOf } from '../dna'
import type { TrendBand } from '../dna'

import { activateViewTab, openContextSidebar, subscribeContextFocus, takeContextFocus, useFleetMemberFocus } from '../viewFocus'
import { revealInScrollParent } from '../revealScroll'
import { makeErrorBoundary } from './errorBoundary'
import { trimRetentionMap } from '../retention'
import { remoteStateOf } from './useRemoteState'

const viewScroll = new Map<string, number>()

const EVENT_KINDS = ['inject', 'compaction', 'prune', 'model', 'mode'] as const
const HOVER_DELAY_MS = 140
const HOVER_LOCK_MS = 320
const DNA_HOVER_DELAY = 220
const DNA_LAZY_MIN = 512
function revealCard(root: HTMLElement | null, selector: string): void {
  /* v8 ignore start */
  const card = root?.querySelector(selector) ?? null
  if (card !== null) revealInScrollParent(card)
  /* v8 ignore stop */
}

function revealBrowserIfOffscreen(root: HTMLElement | null): void {
  /* v8 ignore start */
  if (root === null) return
  const browser = root.querySelector('.lc-col-browser')
  if (browser === null) return
  const br = browser.getBoundingClientRect()
  if (br.bottom <= 0 || br.top >= window.innerHeight) revealInScrollParent(browser)
  /* v8 ignore stop */
}

export function browserCapOf(cards: readonly { top: number; bottom: number }[]): number | null {
  const first = cards.at(0)
  const last = cards.at(-1)
  if (first === undefined || last === undefined) return null
  const span = last.bottom - first.top
  return Number.isFinite(span) && span > 0 ? Math.ceil(span) : null
}

type TabInfoSeat = () => { tab?: { visible?: boolean }; sidebar?: { expanded?: boolean } }

const NO_TAB_INFO: TabInfoSeat = () => ({ tab: { visible: true } })

export function makeContextView(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
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
  const CommandPanel = makeCommandPanel(kit)
  const StatsContext = makeStatsContext(kit, makeSubagentCost(ctx, heads))
  const StatsTiming = makeStatsTiming(kit, Donut)
  const StatsTokens = makeStatsTokens(kit, Donut)
  const PluginInfo = makePluginInfo(kit, ctx)
  const RecomCard = makeRecomCard(kit, ctx)
  const UpgradeGate = makeUpgradeGate(kit)
  const DetailNote = makeDetailNote(kit)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const AgentGraph = makeAgentGraph(ctx, kit, heads)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextViewBody(props: ContextViewProps): ReactElement {
    const sessionId = props.sessionId
    const inSidebar = props.host === 'sidebar'
    const { source, data, pressure, breakdown, usage } = useContextSession(props)
    const ensurePart = source.ensurePart
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    const [selectedSeq, setSelectedSeq] = useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = useState<number | null>(null)
    const [hoverTurn, setHoverTurn] = useState<number | null>(null)
    const [granularity, setGranularity] = useState<'step' | 'turn'>(() => settings.defaultGranularity())
    const [trendMode, setTrendMode] = useState<'total' | 'delta'>(() => settings.defaultTrendMode())
    const [dna, setDna] = useState(false)
    const [adaptive, setAdaptive] = useState(false)
    const [overview, setOverview] = useState(false)
    const overviewAutoAt = overviewThresholdOf(settings.overviewAutoSteps())
    const overviewAutoFired = useRef(new Set<string | undefined>())
    useLayoutEffect(() => {
      if (data === null || overviewAutoAt === null || overviewAutoFired.current.has(sessionId)) return
      if (data.requests.length < overviewAutoAt) return
      overviewAutoFired.current.add(sessionId)
      setOverview(true)
      setDna(false)
      setAdaptive(false)
    }, [data, sessionId, overviewAutoAt])
    const [durationCurve, setDurationCurve] = useState(() => settings.defaultDurationCurve() === 'show')
    const [focusTurn, setFocusTurn] = useState<number | null>(null)
    const [focusSeq, setFocusSeq] = useState<number | null>(null)
    const [jumpSeq, setJumpSeq] = useState<number | null>(null)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [focusCat, setFocusCat] = useState<string | null>(null)
    const [sidebarVisible, setSidebarVisible] = useState(true)
    const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
    const hoverPending = useRef<number | null>(null)
    const hoverAt = useRef(0)
    const hoverLock = useRef(0)
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
          /* v8 ignore next 2 */
          if (hoverPending.current === trailing) setHoveredSeq(trailing)
        })
      }, dna ? DNA_HOVER_DELAY : HOVER_DELAY_MS)
    }, [clearHoverTimer, dna])
    const handleHoverTurn = useCallback((turn: number | null): void => {
      if (turn !== null && performance.now() < hoverLock.current) return
      startTransition(() => { setHoverTurn(turn) })
    }, [])
    const handleHoverKey = useCallback((key: string | null): void => {
      startTransition(() => { setHoverCat(key) })
    }, [])
    /* v8 ignore start */
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
    const [nodeFocus, setNodeFocus] = useState<{ step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null>(null)
    const clearNodeFocus = useCallback(() => { setNodeFocus(null) }, [])

    const loadImage = useMemo(
      () => imageLoaderOf(ctx, typeof sessionId === 'string' ? sessionId : undefined),
      [ctx, sessionId],
    )

    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )
    const fetchOlderCommands = useMemo(
      () => (typeof sessionId === 'string' && sessionId !== '' ? makeCommandPager(sessionId) : undefined),
      [sessionId],
    )

    const rootRef = useRef<HTMLDivElement | null>(null)
    useConversationSurface(rootRef)
    const scrollerRef = useRef<HTMLElement | null>(null)
    const restoredRef = useRef<string | null>(null)
    const [catFocus, setCatFocus] = useState<CatFocus | null>(null)
    const clearCatFocus = useCallback(() => { setCatFocus(null) }, [])
    const [filterFocus, setFilterFocus] = useState<FileFilter | null>(null)
    const clearFilterFocus = useCallback(() => { setFilterFocus(null) }, [])
    const [eventsFocus, setEventsFocus] = useState(0)
    const onEventsClick = useCallback((kind: StatsEventKind | null): void => {
      if (kind !== null) setPickedKinds([kind])
      setEventsFocus(n => n + 1)
    }, [])
    const [commandFocus, setCommandFocus] = useState<string | null>(null)
    const clearCommandFocus = useCallback(() => { setCommandFocus(null) }, [])
    const [commandReveal, setCommandReveal] = useState(0)

    const [belowFoldRef, belowFoldMounted] = useLazyMount(filterFocus !== null || eventsFocus > 0)
    const [cmdsRef, cmdsMounted] = useLazyMount(commandFocus !== null || commandReveal > 0)
    const [browserRef, browserMounted] = useLazyMount()

    useEffect(() => {
      if (source.detailState !== 'ready') return
      ensurePart('files')
      const timer = setTimeout(() => { ensurePart('spans') }, 0)
      return () => { clearTimeout(timer) }
    }, [source.detailState, ensurePart])
    useEffect(() => {
      if (browserMounted) ensurePart('nodes')
    }, [browserMounted, ensurePart])
    useEffect(() => {
      if (belowFoldMounted) ensurePart('events')
    }, [belowFoldMounted, ensurePart])
    useEffect(() => {
      if (cmdsMounted) ensurePart('commands')
    }, [cmdsMounted, ensurePart])
    useEffect(() => {
      if (dna || trendMode === 'delta') ensurePart('requests')
    }, [dna, trendMode, ensurePart])

    const leftColRef = useRef<HTMLDivElement | null>(null)
    const [browserCap, setBrowserCap] = useState<number | null>(null)
    const [capTick, setCapTick] = useState(0)
    useEffect(() => {
      const col = leftColRef.current
      /* v8 ignore next 1 */
      if (col === null) return
      const next = browserCapOf([...col.children].map(el => el.getBoundingClientRect()))
      setBrowserCap(prev => (prev === next ? prev : next))
    }, [capTick, data, sidebarVisible])
    /* v8 ignore start */
    useEffect(() => {
      const col = leftColRef.current
      if (col === null || typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(() => { setCapTick(tick => tick + 1) })
      observer.observe(col)
      for (const el of col.querySelectorAll(':scope > .lc-card')) observer.observe(el)
      return () => { observer.disconnect() }
    }, [sidebarVisible])
    /* v8 ignore stop */
    const onJump = useCallback((jump: StatsJump): void => {
      if (jump === 'turns' || jump === 'steps') {
        hoverLock.current = performance.now() + HOVER_LOCK_MS
        handleHover(null)
        handleHoverTurn(null)
        revealCard(rootRef.current, '[data-lc-trend]')
        return
      }
      if (jump === 'read' || jump === 'write' || jump === 'search' || jump === 'image') {
        setFilterFocus(jump)
        return
      }
      setCatFocus(jump === 'skills'
        ? { cat: 'skill' }
        : jump === 'answers' ? { cat: 'assistant', kind: 'answer' } : { cat: 'user' })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [handleHover, handleHoverTurn])
    const revealCat = useCallback((cat: Category | 'system' | 'tools', seq: number): void => {
      setCatFocus({ cat, step: seq })
      revealBrowserIfOffscreen(rootRef.current)
    }, [])
    const hasFamilyView = settings.fleetTab() === 'show' || settings.defaultPlacement() !== 'tab'
    const onTeamClick = useCallback((): void => {
      if (!activateViewTab(t('tab.fleet'))) openContextSidebar(ctx)
    }, [t])
    const onToolPick = useCallback((tool: string): void => {
      const inSkill = data?.nodes.some(n => n.tool === tool && n.cat === 'skill') === true
      setCatFocus(inSkill ? { cat: 'skill' } : { cat: 'tool', query: tool })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [data])
    const onToolMore = useCallback((): void => {
      setCatFocus({ cat: 'tool' })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [])
    const onCommandMore = useCallback((): void => {
      setCommandReveal(n => n + 1)
    }, [])
    const focusMember = useFleetMemberFocus(typeof sessionId === 'string' ? sessionId : undefined)

    useLayoutEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '' || data === null) return
      if (restoredRef.current === sessionId) return
      restoredRef.current = sessionId
      /* v8 ignore next 3 */
      const scroller = rootRef.current !== null
        ? rootRef.current.closest('[data-conversation-scroll]')
        : null
      if (scroller === null) return
      scrollerRef.current = scroller as HTMLElement
      scroller.scrollTop = viewScroll.get(sessionId) ?? 0
    }, [sessionId, data])

    useLayoutEffect(() => {
      return () => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        const scroller = scrollerRef.current
        if (scroller === null) return
        viewScroll.set(sessionId, scroller.scrollTop)
        trimRetentionMap(viewScroll, 'viewScroll')
      }
    }, [sessionId])

    const requests = data ? data.requests : []
    const events = data ? data.events : []
    const counts = data?.counts ?? countsOfRecords(requests, events)
    const kindCounts: Record<string, number | undefined> = { inject: counts.injects, compaction: counts.compactions, prune: counts.prunes }
    const shownEvents = pickedKinds.length === EVENT_KINDS.length ? events : events.filter(e => pickedKinds.includes(e.kind))
    const displayRequests = useMemo(
      () => (granularity === 'turn' ? aggregateByTurn(requests) : requests),
      [requests, granularity],
    )
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const remote = remoteStateOf(displayRequests.length, source.detailState, source.retryDetail)
    const opStampOf = useMemo(() => stepStampOf(requests), [requests])
    const markers = useMemo(() => attachMarkers(displayRequests, events), [displayRequests, events])
    /* v8 ignore next 1 */
    const dnaAllowed = dna && data !== null && (!inSidebar || sidebarVisible)
    const dnaEager = dnaAllowed && displayRequests.length <= DNA_LAZY_MIN
    const dnaCacheOwner = useMemo(() => ({ data, headers }), [data, headers])
    const dnaBands = useMemo(
      () => (dnaEager
        ? cachedByData(dnaCacheOwner, `dna:${granularity}`, () => displayRequests.map(req => trendBandsOf(assembleCached(data, headers, req.seq))))
        : null),
      [dnaEager, dnaCacheOwner, data, headers, displayRequests, granularity],
    )
    const dnaAt = useMemo(() => {
      if (!dnaAllowed || displayRequests.length <= DNA_LAZY_MIN) return null
      return (seq: number): TrendBand[] => trendBandsOf(assembleCached(data, headers, seq))
    }, [dnaAllowed, data, headers, displayRequests.length])
    const deltaMaxima = useMemo(() => {
      if (!dnaAllowed || trendMode !== 'delta') return null
      return cachedByData(dnaCacheOwner, `dnaDeltaMax:${granularity}`, () => dnaDeltaMaximaOf(data, headers, displayRequests))
    }, [dnaAllowed, trendMode, dnaCacheOwner, data, headers, displayRequests, granularity])
    const revealBand = useCallback((seq: number, band: { key: string; cat: Category | 'system' | 'tools' }): void => {
      setNodeFocus({ step: seq, key: band.key, cat: band.cat })
    }, [])

    useEffect(() => {
      if (filterFocus === null || !belowFoldMounted) return
      revealCard(rootRef.current, '.lc-fa-card')
    }, [filterFocus, belowFoldMounted])

    useEffect(() => {
      if (eventsFocus === 0 || !belowFoldMounted) return
      revealCard(rootRef.current, '.lc-events-card')
    }, [eventsFocus, belowFoldMounted])

    useEffect(() => {
      if (commandFocus === null || !cmdsMounted) return
      revealCard(rootRef.current, '.lc-cmd-card')
    }, [commandFocus, cmdsMounted])

    useEffect(() => {
      if (commandReveal === 0 || !cmdsMounted) return
      revealCard(rootRef.current, '.lc-cmd-card')
    }, [commandReveal, cmdsMounted])

    useEffect(() => {
      if (typeof sessionId !== 'string' || sessionId === '') return
      const take = (): void => {
        const seq = takeContextFocus(sessionId)
        if (seq !== null) setJumpSeq(seq)
      }
      take()
      return subscribeContextFocus(take)
    }, [sessionId])

    const detailReady = source.detailState === 'ready' || source.detailState === 'legacy'
    useEffect(() => {
      if (jumpSeq === null || data === null || !detailReady) return
      setJumpSeq(null)
      const target = jumpTargetOf(aggregateByTurn(requests), jumpSeq)
      if (target === null) return
      setGranularity('turn')
      setSelectedSeq(target.seq)
      setFocusTurn(target.turn ?? 0)
      /* v8 ignore next 2 */
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
    const ioTotals = useMemo(
      () => {
        const totals = (data !== null && data.fileOps !== undefined
          ? activityOfOps(data.fileOps, data.archive, null)
          : activityOf(briefList, convOf, null)).totals
        return { reads: totals.read.ops, writes: totals.write.ops, searches: totals.search.ops, images: totals.image.ops }
      },
      [data, briefList, convOf],
    )
    const toolTally = useMemo(() => {
      if (data?.toolTally !== undefined) return tallyEntriesOf(data.toolTally)
      return data ? cachedByData(data, 'toolTally', () => toolTallyOf(data.nodes)) : []
    }, [data])
    const commandList = useMemo(() => {
      if (data === null || data.commands === undefined) return []
      const records = data.commands
      return cachedByData(data, 'commands', () => commandsOf(records, data.archive))
    }, [data])
    const sessionKey = typeof sessionId === 'string' && sessionId !== '' ? sessionId : undefined
    const commandLog = useCommandLog(
      commandList,
      data?.commandsFloor,
      source.detailState === 'legacy' ? undefined : fetchOlderCommands,
      sessionKey,
    )
    const fullCommandList = commandLog.records
    const workspace = typeof ctx.get === 'function' ? workspaceOf(ctx, typeof sessionId === 'string' ? sessionId : undefined) : undefined
    const commandBoard = useMemo(() => {
      const stats = data?.commandStats ?? (fullCommandList.length > 0 ? tallyOfCommands(fullCommandList) : null)
      const top = data?.programTally !== undefined
        ? tallyEntriesOf(data.programTally)
        : programsOf(viewsOf(fullCommandList, workspace)).map(p => [p.name, p.n] as [string, number])
      if (stats === null && top.length === 0) return { runs: 0, top: [] as [string, number][] }
      return { runs: stats?.runs ?? 0, top }
    }, [fullCommandList, data, workspace])
    const hasCommands = fullCommandList.length > 0 || (data?.commandStats?.runs ?? 0) > 0
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
    const previewOpener = useMemo(() => openResourceVia(ctx), [ctx])
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
      const seq = surfaceSeqOf(op)
      const step = locateStepOf(requests, seq, op.gone)
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(seq), cat: 'tool' })
    }, [requests])
    const locateCommand = useCallback((rec: Command): void => {
      const seq = commandSurfaceSeqOf(rec)
      /* v8 ignore next 1 */
      if (seq === undefined) return
      const step = locateStepOf(requests, seq, rec.gone)
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(seq), cat: 'tool' })
      revealBrowserIfOffscreen(rootRef.current)
    }, [requests])
    const locateNode = useCallback((node: SurfaceNode, isResponse: boolean): void => {
      /* v8 ignore next 1 */
      if (activeReq === null) return
      const next = isResponse && activeIdx + 1 < displayRequests.length ? displayRequests[activeIdx + 1] : null
      const step: number | 'live' = isResponse ? (next !== null ? next.seq : 'live') : activeReq.seq
      setNodeFocus({ step, key: 'n' + String(node.seq), cat: node.cat })
      revealBrowserIfOffscreen(rootRef.current)
    }, [activeReq, activeIdx, displayRequests])

    const nodeOfSeq = useMemo(() => {
      if (data === null) return new Map<number, SurfaceNode>()
      return cachedByData(data, 'nodeOfSeq', () => {
        const m = new Map<number, SurfaceNode>()
        for (const n of data.nodes) m.set(n.seq, n)
        for (const n of data.archive) m.set(n.seq, n)
        return m
      })
    }, [data])
    const canEventFocus = useCallback((ev: ContextEventRecord): boolean => (
      ev.kind !== 'compaction' && ev.kind !== 'prune' ? true : boundaryIndex(requests, ev.seq) >= 0
    ), [requests])
    const focusEvent = useCallback((ev: ContextEventRecord): void => {
      if (ev.kind === 'compaction' || ev.kind === 'prune') {
        const idx = boundaryIndex(requests, ev.seq)
        /* v8 ignore next 1 */
        if (idx < 0) return
        const seq = requests[idx].seq
        setOverview(false)
        setGranularity('step')
        setSelectedSeq(seq)
        setFocusSeq(seq)
        revealCard(rootRef.current, '[data-lc-trend]')
        return
      }
      const node = nodeOfSeq.get(ev.seq)
      const step = locateStepOf(requests, ev.seq, node?.gone)
      if (step === null) return
      setNodeFocus({ step, key: 'n' + String(ev.seq), cat: node?.cat ?? 'inject' })
      revealCard(rootRef.current, '.lc-col-browser')
    }, [requests, nodeOfSeq])

    if (!data) {
      return (
        <div className="lc-root" ref={rootRef}>
          {inSidebar ? null : (
            <div className="lc-cols lc-head">
              <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 190 }} aria-hidden="true" />
              <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 190 }} aria-hidden="true" />
            </div>
          )}
          <div className="lc-cols lc-head">
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 150 }} aria-hidden="true" />
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 150 }} aria-hidden="true" />
          </div>
          <div className="lc-cols lc-cols-main">
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 360 }} aria-hidden="true" />
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 360 }} aria-hidden="true" />
          </div>
          <div className="lc-cols">
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
          </div>
          <div className="lc-cols">
            <div className="lc-card lc-deferred-skeleton" style={{ minHeight: 320 }} aria-hidden="true" />
          </div>
          {source.detailState === 'failed'
            ? <DetailNote state="failed" onRetry={source.retryDetail} />
            : <div className="lc-empty">{t('loading')}</div>}
        </div>
      )
    }

    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = displayRequests.indexOf(req)
      /* v8 ignore next 1 */
      return i >= 0 ? markers[i] : undefined
    }

    const head = headlineOf(data, pressure, breakdown)

    let activeTurn: number | null = hoverTurn
    if (activeTurn === null && hoveredSeq !== null) {
      for (const req of displayRequests) if (req.seq === hoveredSeq) { activeTurn = req.turn ?? null; break }
    }

    const trendHoverCat = hoverCat !== null && hoverCat !== 'free' ? hoverCat : null

    const localeSvc = ctx.get('locale')
    const activeLocale = localeSvc !== undefined && typeof localeSvc.getLocale === 'function'
      ? localeSvc.getLocale().active
      : 'en'
    const subtitle = providerModelLabelOf(data.provider, data.model, data.reasoningEffort)
    const gate = unsupportedOf(data.unsupported)

    /* v8 ignore next 2 */
    if (inSidebar && !sidebarVisible) return <div className="lc-root" ref={rootRef} />

    const compositionCard = (
      <CurrentComposition
        head={head}
        subtitle={subtitle}
        hoverKey={hoverCat}
        onHoverKey={handleHoverKey}
      />
    )
    const trendBase = {
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
      hoverLock,
      onSelect: setSelectedSeq,
      onHover: handleHover,
      onHoverTurn: handleHoverTurn,
    }
    const trendCard = (
      <div className="lc-card" data-lc-trend>
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconCompareSplit size={14} />
            {t('trend.title')}
          </span>
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
          ? (detailReady
            ? <TrendReserved catLabel={catLabel}><div className="lc-empty">{t('trend.empty')}</div></TrendReserved>
            : <TrendReserved catLabel={catLabel}>
              {remote.kind === 'failed'
                ? <DetailNote state="failed" onRetry={remote.retry} />
                : <DetailNote state="loading" />}
            </TrendReserved>)
          : (
            <div>
              {overview
                ? (
                  <TrendOverview
                    key={sessionId}
                    {...trendBase}
                    onPickCat={revealCat}
                    onPickTurn={(turn) => {
                      setGranularity('turn')
                      let seq: number | null = null
                      for (const req of displayRequests) if ((req.turn ?? 0) === turn) seq = req.seq
                      /* v8 ignore next 1 */
                      if (seq !== null) setSelectedSeq(seq)
                    }}
                  />
                )
                : (
                  <TrendChart
                    key={sessionId}
                    {...trendBase}
                    focusTurn={focusTurn}
                    focusSeq={focusSeq}
                    adaptive={adaptive}
                    dna={dnaBands}
                    dnaAt={dnaAt}
                    deltaMaxima={deltaMaxima}
                    onPickBand={revealBand}
                    onPickTurn={(turn) => { setGranularity('turn'); setFocusTurn(turn) }}
                    onFocusTurnHandled={() => { setFocusTurn(null) }}
                    onFocusSeqHandled={() => { setFocusSeq(null) }}
                  />
                )}
              <RequestDetail
                request={activeReq}
                prev={trendMode === 'delta' && activeIdx >= 0 ? (activeIdx > 0 ? displayRequests[activeIdx - 1] : null) : undefined}
                /* v8 ignore next 1 */
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
        dna={dna}
        onDnaChange={setDna}
        locale={activeLocale}
        session={sessionKey}
      />
    )

    return (
      <div className="lc-root" ref={rootRef}>

        {inSidebar ? null : (
          <div className="lc-cols lc-head">
            <StatsContext counts={counts} humanInputs={data.humanInputs} answers={data.answers} toolCalls={data.toolCalls}
              files={ioTotals} tools={toolTally} commands={commandBoard}
              cost={data.cost} costRead={data.costRead} locale={activeLocale} sessionId={typeof sessionId === 'string' ? sessionId : undefined}
              onJump={onJump} onTeamClick={hasFamilyView ? onTeamClick : undefined}
              onToolPick={onToolPick}
              onToolMore={onToolMore}
              onCommandPick={hasCommands ? setCommandFocus : undefined}
              onCommandMore={hasCommands ? onCommandMore : undefined}
              onEventsClick={onEventsClick} />
            <div className="lc-col">
              <PluginInfo />
              <RecomCard key={typeof sessionId === 'string' ? sessionId : undefined} />
            </div>
          </div>
        )}
        <div className="lc-cols lc-head">
          <StatsTokens usage={usage} current={data.current} breakdown={breakdown}
            generatedReasoning={data.generatedReasoning} generatedAnswerTokens={data.generatedAnswerTokens}
            generatedCallTokens={data.generatedCallTokens} />
          <StatsTiming timing={data.timing ?? null} spans={data.spans} locale={activeLocale} />
        </div>

        <div className="lc-cols lc-cols-main">
          <div className="lc-col flex-1 min-w-[min(360px,100%)]" ref={leftColRef}>{compositionCard}{trendCard}</div>
          <div
            ref={browserRef}
            className="lc-col lc-col-browser flex-1 min-w-[min(360px,100%)]"
            style={browserCap !== null ? { maxHeight: browserCap } : undefined}
          >{browserMounted ? browserCard : <div className="lc-card lc-deferred-skeleton" style={{ height: '100%', minHeight: 320 }} aria-hidden="true" />}</div>
        </div>

        <div className="lc-cols" ref={belowFoldRef}>
          {belowFoldMounted ? (<>
            <div className="lc-card lc-events-card lc-col flex-1 min-w-[min(360px,100%)]">
              <div className="lc-card-title">
                <span className="lc-card-title-text">
                  <IconContextInjection size={14} />
                  {t('events.title')}
                </span>
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
              <EventList
                events={shownEvents}
                state={source.detailState}
                onRetry={source.retryDetail}
                onEventFocus={focusEvent}
                canEventFocus={canEventFocus}
              />
            </div>
            <FileCard activity={fileActivity} workspace={workspace} stampOf={opStampOf}
              onPreview={previewFile} onOpen={fileOpener} onLocate={locateFileOp}
              filterFocus={filterFocus} onFilterFocusHandled={clearFilterFocus}
              state={source.detailState} onRetry={source.retryDetail} />
          </>) : (<>
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)] lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)] lc-deferred-skeleton" style={{ minHeight: 450 }} aria-hidden="true" />
          </>)}
        </div>

        <div className="lc-cols" ref={cmdsRef}>
          {cmdsMounted ? (
            <CommandPanel key={sessionId} commands={fullCommandList} stats={data.commandStats} floor={data.commandsFloor}
              fill={commandLog}
              workspace={workspace} stampOf={opStampOf} onLocate={locateCommand} fetchContent={fetchContent}
              focusProgram={commandFocus} onFocusProgramHandled={clearCommandFocus}
              state={source.detailState} onRetry={source.retryDetail} />
          ) : (
            <div className="lc-card lc-col flex-1 min-w-[min(360px,100%)] lc-deferred-skeleton" style={{ minHeight: 320 }} aria-hidden="true" />
          )}
        </div>

        {inSidebar ? (
          <AgentGraph
            sessionId={typeof sessionId === 'string' ? sessionId : undefined}
            self={agentSelfOf(data, pressure, breakdown, usage)}
            focusId={focusMember}
          />
        ) : null}

        <div className="lc-foot">{t('footer')}</div>

        {gate !== null && (
          <UpgradeGate sessionId={sessionId} current={gate.current} minimum={gate.minimum} />
        )}
      </div>
    )
  }

  function ContextViewGate(props: ContextViewProps): ReactElement {
    const useTabInfo = (props as ContextViewProps & { useTabInfo?: TabInfoSeat }).useTabInfo
    const info = seatOf(useTabInfo, NO_TAB_INFO)()
    if (props.host === 'sidebar' && info.tab?.visible !== true) return h('div', { className: 'lc-root' })
    return h(ContextViewBody, props)
  }

  return function ContextView(props: ContextViewProps): ReactElement {
    return h(ErrorBoundary, null, h(ContextViewGate, { ...props, key: seatKeyOf(props) }))
  }
}
