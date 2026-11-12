import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode } from 'react'
import { assembleCached } from './derivedCache'
import { UNKNOWN_TOOL_SOURCE, type Category, type HeaderRecord, type HeaderTool, type RequestRecord, type SurfaceNode, type SystemPromptNode } from '../../shared/types'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
import type { DnaItem } from '../dna'
import type { ConversationNodeLike } from '../services'
import type { ContextSettings, DefaultDeltaBase, DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import { IconBrowse } from '../primitives'
import { makeDetailNote } from './detailNote'
import { makeNodeText } from './nodes'
import { turnStepsOf } from './trendModel'
import { useSurfaceWindow } from './useRowWindow'
import type { SurfaceWindow } from './useRowWindow'
import { fetchMissNote, useFetchOnMiss } from './fetchOnMiss'
import { catNodesModelOf, catToolsModelOf, flatNodesModelOf, makeNodeRowOf } from './browserRows'
import type { NodeRow } from './browserRows'
import { makeAttachmentSection } from './attachments'
import { makeRichText } from './richText'
import type { StackedBarProps } from './stackedBar'
import { TextSection, schemaTextOf, RowToolbar, ToolSchema } from './browserToolCard'
import { revealRowInCard } from '../revealScroll'
import { NodeContent, byCatOf, msgKindsOf } from './browserNodes'
import type { RowKind } from './browserNodes'
import { DNA_MIN_BAND, baseRequestOf, countOf, findRowByKey, nodeEstimateSize, safeIdPart, stepPickMatchesOf, stepPickOptionsOf, stepStampOf } from './browserHelpers'
export type { CatFocus } from './browserHelpers'
export { stepStampOf } from './browserHelpers'
import { useLinkedToggle } from './useLinkedToggle'
import { incrementHas, incrementOf } from '../../shared/increment'
import type { IncrementCat } from '../../shared/increment'
import { MapIcon, makeBrowserTreemap } from './browserTreemap'
import { StepPick } from './browserPick'
import type { StepPickOption } from './browserHelpers'
import type { MapBlock } from '../treemap'
import type { ContextBrowserProps } from './browserProps'
import { useBrowserDelta } from './useBrowserDelta'
export type { ContextBrowserProps } from './browserProps'

export function makeContextBrowser(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  settings: ContextSettings,
): (props: ContextBrowserProps) => ReactElement {
  const { t, fmt, fmtTime, catLabel } = kit
  const DetailNote = makeDetailNote(kit)
  const BrowserTreemap = makeBrowserTreemap(kit)
  const nodeText = makeNodeText(kit)
  const rich = makeRichText(kit)
  const AttachmentSection = makeAttachmentSection(kit)
  const lineLabel = (n: number): string => t(n === 1 ? 'block.line' : 'block.lines', { n })

  return function ContextBrowser(props: ContextBrowserProps): ReactElement {
    const { data, headers } = props
    const [sel, setSel] = useState<'live' | number>('live')
    const [openCat, setOpenCat] = useState<string | null>(null)
    const [openElem, setOpenElem] = useState<string | null>(null)
    const [rowQuery, setRowQuery] = useState('')
    const [rowKind, setRowKind] = useState<RowKind | null>(null)
    const [toolSort, setToolSort] = useState<DefaultToolSort>(() => settings.defaultToolSort())
    const [dna, setDna] = useLinkedToggle(props.dna, props.onDnaChange)
    const [delta, setDelta] = useLinkedToggle(props.delta, props.onDeltaChange)
    const [deltaBase, setDeltaBase] = useState<DefaultDeltaBase>(() => settings.defaultDeltaBase())
    const [dnaKey, setDnaKey] = useState<string | null>(null)
    const [rowDnaKey, setRowDnaKey] = useState<string | null>(null)
    const [mapOn, setMapOn] = useState(false)
    const onOpenCat = props.onOpenCat
    const setCat = (c: string | null): void => {
      setOpenCat(c)
      if (onOpenCat !== undefined) onOpenCat(c)
    }

    const convNodes = props.convNodes
    const convBySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    const openSeq = openElem !== null && openElem.startsWith('n')
      ? Number(openElem.slice(1))
      : null
    const fetchContent = props.fetchContent
    const sessionScope = props.session
    const miss = useFetchOnMiss(
      openSeq !== null && !convBySeq.has(openSeq) ? openSeq : null,
      fetchContent,
      'dsh-context: targeted history read failed',
      sessionScope,
    )
    const bySeq = useMemo(() => {
      if (miss.values.size === 0) return convBySeq
      const m = new Map(convBySeq)
      for (const [seq, n] of miss.values) if (!m.has(seq)) m.set(seq, n)
      return m
    }, [convBySeq, miss.values])
    const pinSeq = props.pinSeq
    useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setCat(null)
      setOpenElem(null)
    }, [pinSeq, onOpenCat])
    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const idBase = useId()
    const [focusRowKey, setFocusRowKey] = useState<string | null>(null)
    const [catRowsEl, setCatRowsEl] = useState<HTMLDivElement | null>(null)
    const nodeFocus = props.nodeFocus
    useEffect(() => {
      if (nodeFocus === null || nodeFocus === undefined) return
      if (delta) {
        const step = nodeFocus.step === 'live' ? null : nodeFocus.step
        const target = step === null ? null : data.requests.find(r => r.seq === step) ?? null
        const targetSeq = target !== null ? target.seq : null
        const base = baseRequestOf(data.requests, target, deltaBase)
        const baseView = base === null ? null : assembleCached(data, headers, base.seq)
        if (!incrementHas(incrementOf(assembleCached(data, headers, targetSeq), baseView), nodeFocus.key)) setDelta(false)
      }
      setSel(nodeFocus.step)
      setCat(nodeFocus.cat)
      setOpenElem(nodeFocus.key)
      setRowQuery('')
      setRowKind(null)
      setFocusRowKey(nodeFocus.key)
      if (props.onNodeFocusHandled !== undefined) props.onNodeFocusHandled()
    }, [nodeFocus, props.onNodeFocusHandled, onOpenCat, delta, data, headers, deltaBase])
    const catFocus = props.catFocus
    useEffect(() => {
      if (catFocus === null || catFocus === undefined) return
      if (dna) setDna(false)
      if (delta) setDelta(false)
      setSel(catFocus.step ?? 'live')
      setCat(catFocus.cat)
      setOpenElem(null)
      setRowQuery(catFocus.query ?? '')
      setRowKind(catFocus.kind ?? null)
      setFocusRowKey(null)
      if (props.onCatFocusHandled !== undefined) props.onCatFocusHandled()
    }, [catFocus, props.onCatFocusHandled, onOpenCat, dna, delta])
    useEffect(() => {
      if (focusRowKey === null) return undefined
      let frame = 0
      let attempts = 8
      const tick = (): void => {
        /* v8 ignore next 1 */
        if (rootRef.current === null) return
        const row = findRowByKey(rootRef.current, focusRowKey)
        if (row !== null) {
          revealRowInCard(rootRef.current, row)
          return
        }
        attempts -= 1
        /* v8 ignore next 1 */
        if (attempts <= 0) return
        frame = requestAnimationFrame(tick)
      }
      frame = requestAnimationFrame(tick)
      return () => { cancelAnimationFrame(frame) }
    }, [focusRowKey])
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const stampOf = useMemo(() => stepStampOf(requests), [requests])
    const pendingStamp = useMemo(() => {
      let hasReq = false
      let lastSeq = -1
      let lastTurn = 0
      let lastStep = 0
      for (const r of requests) {
        if (hasReq && r.seq <= lastSeq) continue
        hasReq = true
        lastSeq = r.seq
        lastTurn = typeof r.turn === 'number' ? r.turn : -1
        lastStep = typeof r.step === 'number' ? r.step : -1
      }
      if (hasReq && (lastTurn < 0 || lastStep < 0)) return null
      let newestSeq = -1
      let newest: SurfaceNode | null = null
      for (const n of data.nodes) if (newest === null || n.seq > newestSeq) { newest = n; newestSeq = n.seq }
      if (newest === null) return null
      const nextTurn = { turn: lastTurn + 1, step: 1 }
      if (newest.cat === 'user') return nextTurn
      if (!hasReq) return null
      if (newest.cat === 'assistant' && !msgKindsOf(newest, bySeq.get(newest.seq)).tool) return nextTurn
      return { turn: lastTurn, step: lastStep + 1 }
    }, [requests, data.nodes, bySeq])
    const hoverReq = props.previewSeq !== null && props.previewSeq !== undefined
      ? requests.find(r => r.seq === props.previewSeq) ?? null
      : null
    const req = hoverReq ?? (sel === 'live' ? null : requests.find(r => r.seq === sel) ?? null)
    const actual = req ?? requests.reduce<RequestRecord | null>((a, r) => (a === null || r.seq > a.seq ? r : a), null)
    const seq = req !== null ? req.seq : null
    const pickOption = useMemo(() => {
      const live: StepPickOption = { value: 'live', label: t('browser.live') }
      const optionOf = (r: RequestRecord): StepPickOption => ({
        value: String(r.seq),
        label: t('browser.pickStep', { t: r.turn ?? 0, s: r.step ?? 0 }),
      })
      return { live, optionOf }
    }, [t, props.locale])
    const pickOptions = useMemo(
      () => stepPickOptionsOf(requests, sel, seq, pickOption.live, pickOption.optionOf),
      [requests, pickOption, sel, seq],
    )
    const pickSearch = useMemo(
      () => (query: string) => stepPickMatchesOf(requests, query, pickOption.live, pickOption.optionOf),
      [requests, pickOption],
    )
    const linked = req === null && props.onHoverKey !== undefined
    const linkKey = linked && props.hoverKey !== null && props.hoverKey !== 'free'
      ? props.hoverKey
      : null
    const refReq = baseRequestOf(requests, req, deltaBase)
    const hasBase = requests.length > 0
    const fetchDelta = props.fetchDelta
    const baseSeq = refReq === null ? null : refReq.seq
    const localView = useMemo(() => assembleCached(data, headers, seq), [data, headers, seq])
    const prevView = useMemo(() => (refReq !== null ? assembleCached(data, headers, refReq.seq) : null), [data, headers, refReq])
    const localDiff = useMemo(() => incrementOf(localView, prevView), [localView, prevView])
    const deltaRead = useBrowserDelta({
      fetchDelta,
      seq,
      baseSeq,
      session: props.session,
      revision: data.detailRev ?? 0,
      localView,
      prevView,
      localDiff,
    })
    const view = deltaRead.view ?? localView
    const byCat = useMemo(() => byCatOf(view), [view])
    const diff = deltaRead.diff
    const inc = delta ? diff : null
    const badges = hasBase ? diff : null
    const approximate = deltaRead.approximate
    const deltaPending = deltaRead.pending
    const shownView = inc !== null ? { ...view, system: inc.system, header: inc.header, nodes: inc.nodes } : view
    const shownByCat = inc !== null ? inc.byCat : byCat

    const toolsElemOpen = (): boolean => openElem === 'tools' || (openElem !== null && openElem.startsWith('tool:'))
    const fetchHeader = props.fetchHeader
    const headerSeq = shownView.header !== null ? shownView.header.seq : null
    const systemSeq = shownView.system !== null ? shownView.system.seq : null
    const sysOpen = shownView.system !== null && (openCat === 'system' || openElem === 'sys')
    const toolsOpen = shownView.header !== null && (openCat === 'tools' || toolsElemOpen())
    const contentSeq = sysOpen ? systemSeq : toolsOpen ? headerSeq : null
    const epoch = useFetchOnMiss(
      contentSeq,
      fetchHeader,
      'dsh-context: header content fetch failed',
      sessionScope,
    )
    const headerContent = epoch.values
    const headerNote = fetchMissNote(t, fetchHeader, epoch.state, epoch.retry, 'browser.headerMetaOnly')

    const breakdown = req !== null ? req : data.current
    const parts = partsOf(breakdown)
    const total = breakdown.total
    const catTokensOf = (c: IncrementCat): number => inc !== null ? inc.tokens[c] : breakdown[c] || 0
    const pinKey = openCat !== null && catTokensOf(openCat as IncrementCat) > 0 ? openCat : null
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setCat(null)
      setOpenElem(null)
    }

    const toolHits = new Map<string, number>()
    for (const n of view.nodes) {
      if ((n.cat === 'tool' || n.cat === 'skill') && n.tool !== undefined) toolHits.set(n.tool, (toolHits.get(n.tool) ?? 0) + 1)
    }
    const toolHitsOf = (tool: HeaderTool): number => toolHits.get(tool.name) ?? 0

    const nodeRowOf = useMemo(
      () => makeNodeRowOf(kit, nodeText, bySeq, openElem),
      [kit, nodeText, bySeq, openElem],
    )
    const flatModel = useMemo(
      () => (dna ? flatNodesModelOf(view.nodes, rowQuery, inc !== null ? inc.seqs : null, nodeRowOf) : { entries: [], tokens: 0 }),
      [dna, inc, nodeRowOf, rowQuery, view],
    )
    const flatKeyOf = useCallback((index: number): string => 'n' + String(flatModel.entries[index].r.n.seq), [flatModel])
    const flatScope = useSurfaceWindow(scrollRef, {
      count: flatModel.entries.length,
      getKey: flatKeyOf,
      estimateSize: nodeEstimateSize,
      minCount: 30,
      overscan: 240,
      seed: 10,
      enabled: dna,
      focusKey: focusRowKey,
    })
    const flatScopeRef = useRef<SurfaceWindow | null>(null)
    flatScopeRef.current = flatScope
    const revealFlatKey = useCallback((key: string): boolean => {
      /* v8 ignore next 1 */
      const scope = flatScopeRef.current
      const el = scrollRef.current
      /* v8 ignore next 1 */
      if (!dna || scope === null || el === null) return false
      scope.scrollToKey(key)
      requestAnimationFrame(() => {
        const row = findRowByKey(el, key)
        /* v8 ignore next 1 */
        if (row !== null) revealRowInCard(rootRef.current, row)
      })
      return true
    }, [dna])
    const catModel = useMemo(() => {
      if (openCat === null || openCat === 'system') return null
      if (openCat === 'tools') {
        const header = shownView.header
        const content = header === null ? undefined : headerContent.get(header.seq)
        const tokens = inc !== null ? inc.tokens.tools : breakdown.tools
        return {
          kind: 'tools' as const,
          tools: catToolsModelOf(header?.tools ?? [], content, rowQuery, toolSort, toolHitsOf, tokens, schemaTextOf),
        }
      }
      if (dna) return null
      const c = openCat as Category
      const nodes = shownByCat[c] ?? []
      const tokens = inc !== null ? inc.tokens[c] : breakdown[c] || 0
      return {
        kind: 'nodes' as const,
        nodes: catNodesModelOf(nodes, c, rowQuery, rowKind, nodeRowOf, tokens),
      }
    }, [breakdown, byCat, dna, headerContent, inc, nodeRowOf, openCat, rowKind, rowQuery, toolSort, view])
    const catKeyOf = useCallback((index: number): string => {
      /* v8 ignore next 1 */
      if (catModel === null) return ''
      if (catModel.kind === 'tools') return 'tool:' + catModel.tools.shown[index].name
      return 'n' + String(catModel.nodes.shown[index].n.seq)
    }, [catModel])
    const catCount = catModel === null
      ? 0
      : catModel.kind === 'tools' ? catModel.tools.shown.length : catModel.nodes.shown.length
    const catScope = useSurfaceWindow(scrollRef, {
      count: catCount,
      getKey: catKeyOf,
      estimateSize: nodeEstimateSize,
      minCount: 30,
      overscan: 240,
      seed: 10,
      initial: 'start',
      enabled: catModel !== null,
      leadingEl: catRowsEl,
      focusKey: focusRowKey,
    })
    const catBodyIdOf = (key: string): string => `${idBase}-cat-${safeIdPart(key)}`
    const rowBodyIdOf = (key: string): string => `${idBase}-row-${safeIdPart(key)}`

    const dnaLabel = (it: DnaItem): string => {
      const base = dnaBaseLabel(it, t, catLabel)
      return it.time !== undefined ? base + ' · ' + fmtTime(it.time) : base
    }
    const dnaItems = dna ? dnaOf(view).filter(it => inc === null || incrementHas(inc, it.key)) : null
    const dnaByKey = new Map(dnaItems?.map(it => [it.key, it] as const) ?? [])
    const dnaParts = dnaItems?.map(it => ({
      key: it.key,
      color: CAT_COLOR[it.cat],
      value: it.tokens,
      label: dnaLabel(it),
      group: it.cat,
    })) ?? null
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    const rowDnaLive = dna && rowDnaKey !== null
      && (rowDnaKey === 'tools' ? shownView.header !== null
        : rowDnaKey === 'system' ? shownView.system !== null
          : dnaByKey.has(rowDnaKey)) ? rowDnaKey : null
    useLayoutEffect(() => {
      if (liveDnaKey === null) return
      /* v8 ignore next 1 */
      const row = rootRef.current?.querySelector('.lc-br-elem-echo') ?? null
      if (row !== null) revealRowInCard(rootRef.current, row)
      else revealFlatKey(liveDnaKey)
    }, [liveDnaKey, revealFlatKey])
    const pickDna = (key: string): void => {
      const it = dnaByKey.get(key)
      /* v8 ignore next 1 */
      if (it === undefined) return
      openRow(it.cat, key)
    }

    const openRow = (c: string, key: string): void => {
      setCat(c)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(key)
    }

    const toolCount = (c: string): number => inc !== null
      ? inc.counts[c as IncrementCat]
      : countOf(view, byCat, c)

    const headerlessOpenable = (c: string): boolean => inc === null && (c === 'system' || c === 'tools') && view.header === null

    const singleKeyOf = (c: string): string | null => {
      if (c === 'system') return shownView.system !== null ? 'sys' : null
      if (c === 'tools') {
        const tools = shownView.header?.tools
        return tools !== undefined && tools.length === 1 ? 'tool:' + tools[0].name : null
      }
      /* v8 ignore next 1 */
      const nodes = shownByCat[c as Category] ?? []
      return nodes.length === 1 ? 'n' + String(nodes[0].seq) : null
    }

    const toggleCat = (c: string) => {
      if (dna) {
        if (c === 'system' && shownView.system !== null) { setOpenCat(c); setRowQuery(''); setOpenElem('sys') }
        else if (c === 'tools') { setOpenCat(c); setRowQuery(''); setOpenElem('tools') }
        return
      }
      const openable = toolCount(c) > 0 || headerlessOpenable(c)
      if (!openable) return
      if (openCat === c) {
        setCat(null)
        setOpenElem(null)
        return
      }
      setCat(c)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(singleKeyOf(c))
    }
    const toggleElem = (key: string) => {
      if (dna && (key === 'tools' || key === 'sys')) {
        const open = key === 'tools' ? toolsElemOpen() : openElem === key
        setOpenElem(open ? null : key)
        setCat(open ? null : key === 'tools' ? 'tools' : 'system')
        if (!open) setRowQuery('')
        return
      }
      setOpenElem(openElem === key ? null : key)
    }

    const pickMapBlock = (c: string, b: MapBlock): void => {
      if (b.elem !== undefined) {
        openRow(c, b.elem)
      } else {
        setCat(c)
        setRowKind(null)
        setOpenElem(null)
        setRowQuery(b.query ?? '')
      }
    }

    const elemRow = (
      key: string, tag: ReactNode | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNode,
      err = false, trailing: ReactNode = null,
      stamp: { turn: number; step: number; pending: boolean } | null = null,
      opts?: { open?: boolean; onHover?: (over: boolean) => void; tabIndex?: number; rowRef?: (el: HTMLElement | null) => void },
    ) => {
      const open = opts?.open ?? openElem === key
      const hover = opts?.onHover
      const bodyId = rowBodyIdOf(key)
      const echo = dna && liveDnaKey !== null
        && (liveDnaKey === key || (key === 'tools' && liveDnaKey.startsWith('tool:')))
      return (
        <div key={key} data-lc-key={key} ref={opts?.rowRef} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '') + (echo ? ' lc-br-elem-echo' : '')}>
          <button
            type="button"
            className="lc-br-elem-row hover:bg-(--dsw-alias-interactive-bg-hover)"
            tabIndex={opts?.tabIndex}
            aria-expanded={open}
            {...(open ? { 'aria-controls': bodyId } : {})}
            onMouseEnter={hover !== undefined ? () => { hover(true) } : undefined}
            onMouseLeave={hover !== undefined ? () => { hover(false) } : undefined}
            onClick={() => { toggleElem(key) }}
          >
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
            {err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
            {tag !== null ? <span className="lc-br-tags">{tag}</span> : null}
            <span className="lc-br-preview">{preview}</span>
            {trailing !== null ? trailing : null}
            {stamp !== null || time !== undefined
              ? <span
                className={'lc-br-time' + (stamp !== null && stamp.pending ? ' lc-br-time-pending' : '')}
                title={stamp !== null
                  ? t(stamp.pending ? 'browser.stepPendingTip' : 'browser.stepAtTip', { t: stamp.turn, s: stamp.step })
                  : undefined}
              >
                {stamp !== null ? t('browser.stepAt', { t: stamp.turn, s: stamp.step }) : ''}
                {stamp !== null && time !== undefined ? ' · ' : ''}
                {time !== undefined ? fmtTime(time) : ''}
              </span>
              : null}
            <span className="lc-br-tokens">{'≈' + fmt(tokens)}</span>
          </button>
          {open ? <div className="lc-br-content" id={bodyId}>{body}</div> : null}
        </div>
      )
    }

    const stampFor = (itemSeq: number): { turn: number; step: number; pending: boolean } | null => {
      const confirmed = stampOf(itemSeq)
      if (confirmed !== null) return { ...confirmed, pending: false }
      if (!view.live || pendingStamp === null) return null
      return { ...pendingStamp, pending: true }
    }

    const rowTagNode = (tag: string | null, names: readonly string[] | null): ReactNode => {
      if (tag === null) return null
      if (names === null) return <span className="lc-br-tag">{tag}</span>
      const counts = new Map<string, number>()
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
      return [...counts.entries()].map(([name, count]) => (
        <span key={name} className="lc-br-tag">{count > 1 ? name + ' ×' + String(count) : name}</span>
      ))
    }

    const messageRow = (
      r: NodeRow,
      tag: ReactNode,
      onHover?: (over: boolean) => void,
      opts?: { tabIndex?: number; rowRef?: (el: HTMLElement | null) => void },
    ): ReactElement =>
      elemRow(`n${r.n.seq}`, tag, r.preview, r.n.tokens, r.n.time,
        <NodeContent
          node={r.n}
          conv={r.conv}
          rich={rich}
          att={{ Section: AttachmentSection, load: props.loadImage, open: props.openAttachment }}
          labels={{
            thinking: t('block.thinking'),
            answer: t('block.answer'),
            content: t('block.content'),
            result: t('block.result'),
            summary: t('block.summary'),
            other: t('attach.other'),
            lines: lineLabel,
            callState: (err: boolean, exit: number | null) => (
              <span className={'lc-ts-call-state ' + (err ? 'lc-ts-call-err' : 'lc-ts-call-ok')}>
                <i />
                {err
                  ? t('call.fail') + (exit !== null ? ' · ' + t('call.exit', { n: exit }) : '')
                  : t('call.ok')}
              </span>
            ),
          }}
          hint={r.conv === undefined ? missNote : t('browser.noContent')}
        />,
        r.rowErr, null, stampFor(r.n.seq),
        { onHover, tabIndex: opts?.tabIndex, rowRef: opts?.rowRef })

    const systemPreviewOf = (sys: SystemPromptNode): string =>
      headerContent.get(sys.seq)?.system?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''
    const systemBodyOf = (sys: SystemPromptNode): ReactNode => {
      const content = headerContent.get(sys.seq)
      if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
      if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
      return <TextSection label={catLabel('system')} text={content.system} rich={rich} lines={lineLabel} />
    }

    const rowsBlock = (
      keys: readonly string[],
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void,
      rowsEl: (el: HTMLDivElement | null) => void,
      scope: SurfaceWindow,
      renderRow: (key: string, index: number) => ReactElement,
    ): ReactElement => (
      <div className="lc-br-rows" ref={rowsEl} onKeyDown={onKeyDown}>
        {scope.topPad > 0 ? <div className="lc-row-pad" style={{ height: scope.topPad }} aria-hidden="true" /> : null}
        {keys.slice(scope.from, scope.to + 1).map((key, offset) => renderRow(key, scope.from + offset))}
        {scope.bottomPad > 0 ? <div className="lc-row-pad" style={{ height: scope.bottomPad }} aria-hidden="true" /> : null}
      </div>
    )

    const catBody = (c: string): ReactNode => {
      if (c === 'system') {
        const sys = shownView.system
        if (sys === null) {
          return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        }
        const content = headerContent.get(sys.seq)
        if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
        if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
        return elemRow('sys', null, systemPreviewOf(sys), catTokensOf('system'), undefined,
          systemBodyOf(sys), false, null, stampFor(sys.seq))
      }
      if (c === 'tools') {
        const header = shownView.header
        if (header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        const labels = {
          desc: t('tool.desc'),
          title: t('tool.params'),
          empty: t('tool.paramsEmpty'),
          show: t('tool.jsonToggle'),
          hide: t('tool.jsonHide'),
        }
        const content = headerContent.get(header.seq)
        const epochStamp = stampFor(header.seq)
        const model = catModel !== null && catModel.kind === 'tools' ? catModel.tools : null
        const toolctl = (
          <RowToolbar
            value={rowQuery}
            placeholder={t('tool.search')}
            clearLabel={t('field.clear')}
            count={model?.shown.length ?? 0}
            tokens={model?.shownTokens ?? 0}
            tip={t('tool.sortTip')}
            onChange={setRowQuery}
          >
            {(['size', 'count', 'name'] as const).map(k => (
              <button
                key={k}
                type="button"
                className={'lc-gran-btn' + (toolSort === k ? ' lc-gran-on' : '')}
                onClick={() => { setToolSort(k) }}
              >
                {t('tool.sort.' + k)}
              </button>
            ))}
          </RowToolbar>
        )
        if (model === null || model.shown.length === 0) {
          return (
            <div>
              {toolctl}
              <div className="lc-br-note">{t('tool.noMatch')}</div>
            </div>
          )
        }
        const contentByName = model.contentByName
        const toolBody = (tool: HeaderTool): ReactNode => {
          if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
          const row = contentByName.get(tool.name)
          return row === undefined
            ? <div className="lc-br-note">{t('browser.notInLog')}</div>
            : <ToolSchema description={row.description} schema={row.schema} rich={rich} lines={lineLabel} labels={labels} />
        }
        const keys = model.shown.map(tool => 'tool:' + tool.name)
        return (
          <div>
            {toolctl}
            {rowsBlock(keys, catScope.onKeyDown, setCatRowsEl, catScope, (key, index) => {
              const tool = model.shown[index]
              const trailing = (
                <>
                  {tool.plugin !== undefined
                    ? <span className="lc-br-tag lc-br-tool-plugin" title={tool.plugin === UNKNOWN_TOOL_SOURCE ? t('tool.unknownTitle') : t('tool.plugin')}>
                      {tool.plugin === UNKNOWN_TOOL_SOURCE ? t('tool.unknown') : tool.plugin}
                    </span>
                    : null}
                  <span className="lc-br-hits" title={t('tool.hitsTip')}>{'×' + fmt(toolHitsOf(tool))}</span>
                </>
              )
              return elemRow(key, null, tool.name, tool.tokens, undefined,
                toolBody(tool),
                false, trailing, epochStamp, { tabIndex: catScope.tabIndexFor(key), rowRef: catScope.measure(key) })
            })}
          </div>
        )
      }
      /* v8 ignore next 1 */
      if (catModel === null || catModel.kind !== 'nodes') return <div className="lc-br-note">{t('browser.rowNoMatch')}</div>
      const model = catModel.nodes
      const shown = model.shown
      const rowctl = model.kindCounts === null
        ? (
          <RowToolbar
            value={rowQuery}
            placeholder={t('browser.search.' + c)}
            clearLabel={t('field.clear')}
            count={shown.length}
            tokens={model.shownTokens}
            onChange={setRowQuery}
          />
        )
        : (
          <RowToolbar
            value={rowQuery}
            placeholder={t('browser.search.' + c)}
            clearLabel={t('field.clear')}
            count={shown.length}
            tokens={model.shownTokens}
            tip={t('browser.kindTip')}
            onChange={setRowQuery}
          >
            {model.kindCounts.map(({ k, n }) => (
              <button
                key={k}
                type="button"
                className={'lc-gran-btn' + (rowKind === k ? ' lc-gran-on' : '')}
                onClick={() => { setRowKind(rowKind === k ? null : k) }}
              >
                {t('browser.kind.' + k)}
                <span className="lc-kind-n">{fmt(n)}</span>
              </button>
            ))}
          </RowToolbar>
        )
      if (shown.length === 0) {
        return <div>{rowctl}<div className="lc-br-note">{t('browser.rowNoMatch')}</div></div>
      }
      const keys = shown.map(row => 'n' + String(row.n.seq))
      return (
        <div>
          {rowctl}
          {rowsBlock(keys, catScope.onKeyDown, setCatRowsEl, catScope, (key, index) => {
            const row = shown[index]
            return messageRow(row, rowTagNode(row.tag, row.tagNames), undefined, {
              tabIndex: catScope.tabIndexFor(key),
              rowRef: catScope.measure(key),
            })
          })}
        </div>
      )
    }

    const catChip = (cat: Category | 'system' | 'tools'): ReactElement => (
      <span
        className="lc-br-tag"
        style={{
          background: `color-mix(in srgb, ${CAT_COLOR[cat]} 14%, transparent)`,
          borderColor: `color-mix(in srgb, ${CAT_COLOR[cat]} 45%, transparent)`,
        }}
      >{catLabel(cat)}</span>
    )

    const toolsGroupRow = (header: HeaderRecord): ReactElement => {
      const open = toolsElemOpen()
      return elemRow(
        'tools',
        catChip('tools'),
        t('browser.items', { n: header.tools.length }),
        catTokensOf('tools'),
        undefined,
        catBody('tools'),
        false, null,
        stampFor(header.seq),
        { open, onHover: (over) => { setRowDnaKey(over ? 'tools' : null) } },
      )
    }

    const systemRow = (sys: SystemPromptNode): ReactElement =>
      elemRow('sys', catChip('system'), systemPreviewOf(sys),
        catTokensOf('system'), undefined, systemBodyOf(sys), false, null, stampFor(sys.seq),
        { onHover: (over) => { setRowDnaKey(over ? 'system' : null) } })

    const flatQ = rowQuery.trim().toLowerCase()
    const flatHeader = shownView.header
    const flatSys = shownView.system
    const flatSysText = flatSys !== null ? headerContent.get(flatSys.seq)?.system ?? '' : ''
    const flatTail: ReactElement[] = []
    let flatTailTokens = 0
    if (dna && flatHeader !== null && flatHeader.tools.some(tool =>
      tool.name.toLowerCase().includes(flatQ) || (tool.plugin ?? '').toLowerCase().includes(flatQ))) {
      flatTail.push(toolsGroupRow(flatHeader))
      flatTailTokens += catTokensOf('tools')
    }
    if (dna && flatSys !== null
      && (systemPreviewOf(flatSys).toLowerCase().includes(flatQ) || flatSysText.toLowerCase().includes(flatQ))) {
      flatTail.push(systemRow(flatSys))
      flatTailTokens += catTokensOf('system')
    }
    const flatCount = flatModel.entries.length + flatTail.length
    const flatTokens = flatModel.tokens + flatTailTokens
    const flatToolbar = (): ReactElement => (
      <RowToolbar
        value={rowQuery}
        placeholder={t('browser.search.flat')}
        clearLabel={t('field.clear')}
        count={flatCount}
        tokens={flatTokens}
        onChange={setRowQuery}
      />
    )
    const pctBase = inc !== null ? inc.total : total

    return (
      <div className="lc-card lc-br" ref={rootRef}>
        <div className="lc-br-head">
          <div className="lc-card-title">
            <span className="lc-card-title-text">
              <IconBrowse size={14} />
              {t('browser.title')}
            </span>
            <span className="lc-gran lc-br-dna-ctl" role="group" title={t('browser.dnaTip')}>
              <button
                type="button"
                className={'lc-gran-btn' + (dna ? ' lc-gran-on' : '')}
                onClick={() => { setDna(!dna) }}
              >
                {t('browser.dna')}
              </button>
            </span>
            <span className="lc-br-ctl">
              <StepPick
                value={seq === null ? 'live' : String(seq)}
                options={pickOptions}
                search={pickSearch}
                searchPlaceholder={t('browser.pick.search')}
                emptyLabel={t('browser.pick.empty')}
                clearLabel={t('field.clear')}
                ariaLabel={t('browser.pick.aria')}
                onChange={pick}
              />
              <span className="lc-gran lc-br-base-ctl" role="group" title={t('browser.base.tip')}>
                <button
                  type="button"
                  className={'lc-gran-btn' + (deltaBase === 'step' ? ' lc-gran-on' : '')}
                  onClick={() => { setDeltaBase('step') }}
                >
                  {t('browser.base.step')}
                </button>
                <button
                  type="button"
                  className={'lc-gran-btn' + (deltaBase === 'turn' ? ' lc-gran-on' : '')}
                  onClick={() => { setDeltaBase('turn') }}
                >
                  {t('browser.base.turn')}
                </button>
              </span>
              <span className="lc-gran lc-br-mode-ctl" role="group" title={t('browser.deltaTip')}>
                <button
                  type="button"
                  className={'lc-gran-btn' + (delta ? '' : ' lc-gran-on')}
                  onClick={() => { if (delta) setDelta(false) }}
                >
                  {t('gran.total')}
                </button>
                <button
                  type="button"
                  className={'lc-gran-btn' + (delta ? ' lc-gran-on' : '')}
                  onClick={() => { if (!delta) setDelta(true) }}
                >
                  {t('gran.delta')}
                </button>
              </span>
            </span>
          </div>

          <div className={'lc-br-bar' + (dna ? ' lc-br-bar-dna' : '')}>
            <div className="lc-br-bar-main">
              <div className="lc-br-meta">
                <b>{req !== null
                  ? t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0, n: stepsOf(req.turn) })
                  : t('browser.liveNow')}</b>
                {req !== null ? <span>{fmtTime(req.time)}</span> : null}
                <span className="lc-est">{inc !== null
                  ? t('browser.addedOfTotal', { a: fmt(inc.total), n: fmt(total) })
                  : t('detail.estTotal', { n: fmt(total) })}</span>
                {actual !== null && actual.prompt !== undefined
                  ? <span>{t('detail.actual', { n: fmt(actual.prompt) })}</span>
                  : null}
              </div>
              <StackedBar
                parts={dnaParts ?? (inc !== null ? inc.parts : parts)}
                height={10}
                hoverKey={dna ? liveDnaKey ?? rowDnaLive ?? linkKey ?? pinKey : linkKey ?? pinKey}
                onHoverKey={dna ? setDnaKey : linked ? props.onHoverKey : undefined}
                tip={dna}
                shareLabel={inc !== null ? t('browser.ofAdded') : undefined}
                onPickKey={dna ? pickDna : undefined}
                minBand={dna ? DNA_MIN_BAND : undefined}
              />
            </div>
            <button
              type="button"
              className={'lc-br-map-btn' + (mapOn ? ' lc-br-map-btn-on' : '')}
              title={t('browser.mapTip')}
              aria-label={t('browser.mapAria')}
              aria-pressed={mapOn}
              onClick={() => { setMapOn(!mapOn) }}
            >
              <MapIcon />
            </button>
          </div>

          {view.missingLive > 0
            ? <div className="lc-br-note">{t('browser.missingLive', { n: view.missingLive })}</div>
            : null}
          {deltaPending
            ? <div className="lc-br-note">{t('browser.deltaPending')}</div>
            : null}
          {approximate
            ? <div className="lc-br-note">{t('browser.approx')}</div>
            : null}
          {props.detailState === 'loading'
            ? <DetailNote state="loading" className="lc-br-note" />
            : null}
          {props.detailState === 'failed' && props.onDetailRetry !== undefined
            ? <DetailNote state="failed" onRetry={props.onDetailRetry} className="lc-br-note" />
            : null}

          {dna ? flatToolbar() : null}
        </div>

        {mapOn
          ? (
            <BrowserTreemap
              view={shownView}
              emptyLabel={inc !== null ? t('browser.noAdded') : undefined}
              shareLabel={inc !== null ? t('browser.ofAdded') : undefined}
              openCat={openCat}
              hoverKey={linkKey}
              onHoverKey={dna ? undefined : linked ? props.onHoverKey : undefined}
              onPickCat={toggleCat}
              onPickBlock={pickMapBlock}
            />
          )
          : null}

        <div className="lc-br-scroll" ref={scrollRef}>
          {dna
            ? (
              <div className="lc-br-flat" onKeyDown={flatScope.onKeyDown}>
                {flatScope.topPad > 0 ? <div className="lc-row-pad" style={{ height: flatScope.topPad }} aria-hidden="true" /> : null}
                {flatModel.entries.slice(flatScope.from, flatScope.to + 1).map(({ r, pos }) => {
                  const key = 'n' + String(r.n.seq)
                  return messageRow(r, (
                    <>
                      {catChip(r.n.cat)}
                      <span className="lc-br-pos">#{fmt(pos)}</span>
                      {rowTagNode(r.tag, r.tagNames)}
                    </>
                  ), (over) => { setRowDnaKey(over ? 'n' + String(r.n.seq) : null) }, {
                    tabIndex: flatScope.tabIndexFor(key),
                    rowRef: flatScope.measure(key),
                  })
                })}
                {flatScope.bottomPad > 0
                  ? <div className="lc-row-pad" style={{ height: flatScope.bottomPad }} aria-hidden="true" />
                  : null}
                {flatTail}
                {flatCount === 0
                  ? <div className="lc-br-note">{inc !== null && flatQ === '' && inc.items === 0 ? t('browser.noAdded') : t('browser.rowNoMatch')}</div>
                  : null}
              </div>
            )
            : (
              <div className="lc-br-cats">
                {CATS.map((c) => {
                  const count = toolCount(c.key)
                  const v = catTokensOf(c.key)
                  const countUp = badges !== null ? badges.counts[c.key] : 0
                  const countDown = badges !== null ? badges.removed[c.key] : 0
                  const tokenUp = badges !== null ? badges.tokenUp[c.key] : 0
                  const tokenDown = badges !== null ? badges.tokenDown[c.key] : 0
                  const openable = count > 0 || headerlessOpenable(c.key)
                  const open = openCat === c.key && openable
                  return (
                    <div key={c.key} className={'lc-br-cat' + (openable ? '' : ' lc-br-cat-empty')} style={{ '--lc-cat-hue': c.color } as CSSProperties}>
                      <button
                        type="button"
                        className={'lc-br-cat-row hover:bg-(--dsw-alias-interactive-bg-hover)'
                          + (open ? ' lc-br-cat-open' : '')
                          + (countUp + countDown + tokenUp + tokenDown > 0 ? ' lc-br-cat-diff' : '')
                          + (linked && props.hoverKey === c.key ? ' lc-br-cat-on' : '')}
                        /* v8 ignore start */
                        onMouseEnter={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(c.key) } : undefined}
                        onMouseLeave={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) } : undefined}
                        /* v8 ignore stop */
                        aria-expanded={open}
                        {...(open ? { 'aria-controls': catBodyIdOf(c.key) } : {})}
                        onClick={() => { toggleCat(c.key) }}
                      >
                        <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                        <i style={{ background: c.color }} />
                        <span className="lc-br-cat-label">{catLabel(c.key)}</span>
                        <span className="lc-br-count-grp">
                          <span className="lc-br-cat-count">{t('browser.items', { n: count })}</span>
                          {countUp > 0 ? (
                            <span className="lc-br-delta lc-br-delta-up">{`+${countUp}`}</span>
                          ) : null}
                          {countDown > 0 ? (
                            <span className="lc-br-delta lc-br-delta-down">{`-${countDown}`}</span>
                          ) : null}
                        </span>
                        <span className="lc-br-tokens-grp">
                          {tokenUp > 0 ? (
                            <span className="lc-br-tdelta lc-br-tdelta-up">{'+' + fmt(tokenUp)}</span>
                          ) : null}
                          {tokenDown > 0 ? (
                            <span className="lc-br-tdelta lc-br-tdelta-down">{'-' + fmt(tokenDown)}</span>
                          ) : null}
                          <span className="lc-br-tokens">{'≈' + fmt(v)}</span>
                        </span>
                        <span className="lc-br-pct">{pctBase > 0 ? `${Math.round(v / pctBase * 100)}%` : ''}</span>
                      </button>
                      {open ? <div className="lc-br-body" id={catBodyIdOf(c.key)}>{catBody(c.key)}</div> : null}
                    </div>
                  )
                })}
              </div>
            )}
        </div>
      </div>
    )
  }
}
