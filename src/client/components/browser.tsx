import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { assembleCached } from './derivedCache'
import { UNKNOWN_TOOL_SOURCE, type Category, type ContextHeaders, type ContextTimeline, type HeaderRecord, type HeaderTool, type RequestRecord, type SurfaceNode, type SystemPromptNode } from '../../shared/types'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
import { useRowWindow } from './useRowWindow'
import type { DnaItem } from '../dna'
import type { ContentFetcher, ConversationNodeLike, HeaderFetcher } from '../services'
import type { ContextSettings, DefaultDeltaBase, DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import type { DetailState } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import { makeNodeText } from './nodes'
import { turnStepsOf } from './trendChart'
import { fetchMissNote, useFetchOnMiss } from './fetchOnMiss'
import { attachmentsIn } from '../../shared/attachment'
import { makeAttachmentSection } from './attachments'
import { makeRichText } from './richText'
import type { StackedBarProps } from './stackedBar'
import type { AttachmentOpener, ImageLoader } from '../services'
import { TextSection, schemaTextOf, RowToolbar, ToolSchema, toolErrOf } from './browserToolCard'
import { revealRowInCard } from '../revealScroll'
import { NodeContent, byCatOf, nodeNameOf, msgKindsOf, reasoningTextOf, ROW_KINDS } from './browserNodes'
import type { RowKind } from './browserNodes'
import { DNA_MIN_BAND, countOf, lastOfTurn, stepStampOf } from './browserHelpers'
import type { CatFocus } from './browserHelpers'
export type { CatFocus } from './browserHelpers'
export { stepStampOf } from './browserHelpers'
import { MapIcon, makeBrowserTreemap } from './browserTreemap'
import type { MapBlock } from '../treemap'

export interface ContextBrowserProps {
  /** Active UI locale; the picker labels are translated eagerly, so a switch must rebuild them. */
  locale?: string
  data: ContextTimeline
  headers: ContextHeaders | null
  /** Resolved by the caller so the `useChat` seat's hook order lives in exactly one place. */
  convNodes?: readonly ConversationNodeLike[]
  fetchContent?: ContentFetcher
  fetchHeader?: HeaderFetcher
  /** Preview-seq: hover transiently previews that step; the picker's own selection resumes when the pointer leaves the chart. */
  previewSeq?: number | null
  /** Pin-seq: a pin selects that step; pinSeq null returns the browser to the live surface. */
  pinSeq?: number | null
  /** Controlled only when BOTH props arrive; absent (the /context modal) — the browser keeps its own mount-local toggle. */
  dna?: boolean
  onDnaChange?: (on: boolean) => void
  /** One-shot reveal request: `key` is the band key both DNA surfaces share — 'sys' (system prompt),
   * 'tool:<name>' (a tool schema), 'n<seq>' (a message) — so the same bridge serves header bands and message
   * nodes; handed back via `onNodeFocusHandled` so the same row can fire again. */
  nodeFocus?: { step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null
  onNodeFocusHandled?: () => void
  catFocus?: CatFocus | null
  onCatFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onOpenCat?: (cat: string | null) => void
  loadImage?: ImageLoader
  /** On-click opener of one attachment's preview (attachmentSource.ts); absent = metadata only. */
  openAttachment?: AttachmentOpener
  detailState?: DetailState
  onDetailRetry?: () => void
}


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
    // 'live' = the current surface (the NEXT request's context); number = a retained step's seq.
    const [sel, setSel] = useState<'live' | number>('live')
    const [openCat, setOpenCat] = useState<string | null>(null)
    const [openElem, setOpenElem] = useState<string | null>(null)
    // The filter is a lens on the OPEN category: a category switch resets it, a step pick keeps it so the same lens compares epochs.
    const [rowQuery, setRowQuery] = useState('')
    const [rowKind, setRowKind] = useState<RowKind | null>(null)
    // Mount-time default; in-toolbar toggling stays mount-local and never writes back.
    const [toolSort, setToolSort] = useState<DefaultToolSort>(() => settings.defaultToolSort())
    const [dnaLocal, setDnaLocal] = useState(false)
    const dnaLinked = props.dna !== undefined && props.onDnaChange !== undefined
    const dna = dnaLinked ? props.dna === true : dnaLocal
    const setDna = (on: boolean): void => {
      if (dnaLinked) {
        /* v8 ignore next 1 -- `dnaLinked` requires both props, so the handler is always present. */
        props.onDnaChange?.(on)
      } else {
        setDnaLocal(on)
      }
    }
    const [dnaKey, setDnaKey] = useState<string | null>(null)
    // The flat feed's row-hover mirror: hovering a row lights ITS band (exact node key) or band group
    // ('tools'/'system') on the bar. A pointer hover overrides it; it never reports upward.
    const [rowDnaKey, setRowDnaKey] = useState<string | null>(null)
    // The block map is mount-local like the unlinked DNA toggle: a visualization lens, not shared page state.
    const [mapOn, setMapOn] = useState(false)
    const [deltaBase, setDeltaBase] = useState<DefaultDeltaBase>(() => settings.defaultDeltaBase())
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
    const miss = useFetchOnMiss(
      openSeq !== null && !convBySeq.has(openSeq) ? openSeq : null,
      fetchContent,
      'dsh-context: targeted history read failed',
    )
    const bySeq = useMemo(() => {
      if (miss.values.size === 0) return convBySeq
      const m = new Map(convBySeq)
      for (const [seq, n] of miss.values) if (!m.has(seq)) m.set(seq, n)
      return m
    }, [convBySeq, miss.values])
    // Pin linkage: a pinned bar selects its step; unpin returns to live, and only a NEW pin overrides a manual pick.
    const pinSeq = props.pinSeq
    useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setCat(null)
      setOpenElem(null)
    }, [pinSeq, onOpenCat])
    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    // The DNA flat feed can carry thousands of sub-row-sized items; the rows region is a fixed-pitch scroller, so
    // only the visible window is rendered once the card is wide enough for single-line rows.
    const [flatWide, setFlatWide] = useState(false)
    const [flatReady, setFlatReady] = useState(false)
    const focusScrollRef = useRef(false)
    const nodeFocus = props.nodeFocus
    useEffect(() => {
      if (nodeFocus === null || nodeFocus === undefined) return
      setSel(nodeFocus.step)
      setCat(nodeFocus.cat)
      setOpenElem(nodeFocus.key)
      setRowQuery('')
      setRowKind(null)
      focusScrollRef.current = true
      if (props.onNodeFocusHandled !== undefined) props.onNodeFocusHandled()
    }, [nodeFocus, props.onNodeFocusHandled, onOpenCat])
    const catFocus = props.catFocus
    useEffect(() => {
      if (catFocus === null || catFocus === undefined) return
      // A category jump has no landing spot in the DNA flat feed (no category rows): it drops back to the accordion.
      if (dna) setDna(false)
      setSel('live')
      setCat(catFocus.cat)
      setOpenElem(null)
      setRowQuery('')
      setRowKind(catFocus.kind ?? null)
      if (props.onCatFocusHandled !== undefined) props.onCatFocusHandled()
    }, [catFocus, props.onCatFocusHandled, onOpenCat, dna])
    useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      const row = rootRef.current?.querySelector('.lc-br-elem-on') ?? null
      if (row !== null) revealRowInCard(rootRef.current, row)
    })
    // The note an un-joined open row shows, per fetch state (fetchOnMiss.tsx).
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    // One <option> per retained request: rebuilt only when the records or locale inputs change, never on hover.
    const pickOptions = useMemo(
      () => requests.slice().reverse().map(r => (
        <option key={r.seq} value={String(r.seq)}>
          {t('detail.step', { t: r.turn ?? 0, s: r.step ?? 0, n: stepsOf(r.turn) })}
        </option>
      )),
      [requests, stepsOf, t, props.locale],
    )
    const stampOf = useMemo(() => stepStampOf(requests), [requests])
    // The live tail — items no logged request carries yet — rides the NEXT request, following the harness's step loop
    // (`core/agent-loop`'s agent.ts): a newest user message opens a new turn, a text-only final reply ends the turn,
    // anything else continues it. An ESTIMATE (dotted underline) until the request logs and the confirmed stamp replaces it.
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
    // The live surface pairs its next-request estimate with the freshest actual the log holds (highest seq — wire order is not trusted).
    const actual = req ?? requests.reduce<RequestRecord | null>((a, r) => (a === null || r.seq > a.seq ? r : a), null)
    const seq = req !== null ? req.seq : null
    // The browser joins the shared composition hover ONLY while it shows the LIVE step — a pinned/previewed step has a
    // different composition, so its hover must not light the overview (and vice versa).
    const linked = req === null && props.onHoverKey !== undefined
    const linkKey = linked && props.hoverKey !== null && props.hoverKey !== 'free'
      ? props.hoverKey
      : null
    // assemble() is a pure walk over the served projection; memoize it per (projection, step) so a hover
    // preview only pays for the steps it actually shows.
    const view = useMemo(() => assembleCached(data, headers, seq), [data, headers, seq])

    /** The tools group's element keys: the group key itself or any exact tool schema key. */
    const toolsElemOpen = (): boolean => openElem === 'tools' || (openElem !== null && openElem.startsWith('tool:'))

    // The projections carry metadata only, so the selected step's content is fetched on demand (one history read per
    // open section); the system prompt rides the timeline's own `system/message` nodes, the tools the header epoch.
    // Open-content keys: the accordion's open category, or — in the DNA flat feed — the open group/element row.
    const fetchHeader = props.fetchHeader
    const headerSeq = view.header !== null ? view.header.seq : null
    const systemSeq = view.system !== null ? view.system.seq : null
    const sysOpen = openCat === 'system' || openElem === 'sys'
    const toolsOpen = openCat === 'tools' || toolsElemOpen()
    const contentSeq = sysOpen ? systemSeq : toolsOpen ? headerSeq : null
    const epoch = useFetchOnMiss(
      contentSeq,
      fetchHeader,
      'dsh-context: header content fetch failed',
    )
    const headerContent = epoch.values
    const headerNote = fetchMissNote(t, fetchHeader, epoch.state, epoch.retry, 'browser.headerMetaOnly')

    const breakdown = req !== null ? req : data.current
    const parts = partsOf(breakdown)
    const total = breakdown.total
    // The open category stays lit without hover (a pointer hover overrides the pin); dropped when the shown step's
    // composition holds nothing for it, so the bar never reads all-dimmed.
    const pinKey = openCat !== null && (breakdown[openCat as Category | 'system' | 'tools'] || 0) > 0 ? openCat : null
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setCat(null)
      setOpenElem(null)
    }

    // δ baseline: 'step' diffs the immediately preceding record, 'turn' the previous turn's last step — live: the last
    // served request, or this turn's growth so far. A surface with no predecessor falls back to a ZERO baseline.
    const prevRecordOf = (r: RequestRecord): RequestRecord | null => {
      const i = requests.findIndex(x => x.seq === r.seq)
      return i > 0 ? requests[i - 1] : null
    }
    const lastReq = requests.length > 0 ? requests[requests.length - 1] : null
    const turnBaseOf = (r: RequestRecord): RequestRecord | null => lastOfTurn(requests, (r.turn ?? 0) - 1)
    const refReq = req === null
      ? deltaBase === 'step' ? lastReq : lastReq === null ? null : turnBaseOf(lastReq)
      : deltaBase === 'turn' ? turnBaseOf(req) : prevRecordOf(req)
    const zeroBase = refReq === null && lastReq !== null
    const prevView = useMemo(
      () => (refReq !== null ? assembleCached(data, headers, refReq.seq) : null),
      [data, headers, refReq],
    )
    const prevByCat = prevView !== null ? byCatOf(prevView) : null

    const byCat = byCatOf(view)

    // One tool-result node is one completed call — the same accounting as the stats' toolCalls; a reclassified
    // `skill` load keeps its tool stamp and still counts here.
    const toolHits = new Map<string, number>()
    for (const n of view.nodes) {
      if ((n.cat === 'tool' || n.cat === 'skill') && n.tool !== undefined) toolHits.set(n.tool, (toolHits.get(n.tool) ?? 0) + 1)
    }
    const toolHitsOf = (tool: HeaderTool): number => toolHits.get(tool.name) ?? 0

    const dnaLabel = (it: DnaItem): string => {
      const base = dnaBaseLabel(it, t, catLabel)
      return it.time !== undefined ? base + ' · ' + fmtTime(it.time) : base
    }
    const dnaItems = dna ? dnaOf(view) : null
    const dnaByKey = new Map(dnaItems?.map(it => [it.key, it] as const) ?? [])
    const dnaParts = dnaItems?.map(it => ({
      key: it.key,
      color: CAT_COLOR[it.cat],
      value: it.tokens,
      label: dnaLabel(it),
      group: it.cat,
    })) ?? null
    // A band hover is honored only while its key names a RENDERED band: a push can drop the band under a resting pointer
    // without a mouseleave, and a dead key would leave the bar all-dimmed (the same invariant the pin's gate keeps).
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    // A row hover stays live only while DNA mode is on and its item still renders (a push can drop the
    // hovered row and fire no mouseleave — a dead key must not dim the bar, the same invariant as liveDnaKey).
    const rowDnaLive = dna && rowDnaKey !== null
      && (rowDnaKey === 'tools' ? view.header !== null
        : rowDnaKey === 'system' ? view.system !== null
          : dnaByKey.has(rowDnaKey)) ? rowDnaKey : null
    // A band hover brings its echoed row into view — within the rows region's own scrollport and nothing
    // above it: the pointer rests on the bar, and a page scroll would drag it off the band mid-scrub.
    useLayoutEffect(() => {
      if (liveDnaKey === null) return
      /* v8 ignore next 1 -- liveDnaKey non-null implies a mounted card: the ref always resolves. */
      const row = rootRef.current?.querySelector('.lc-br-elem-echo') ?? null
      /* v8 ignore next 1 -- a live band names a rendered item, so its echoed row always exists. */
      if (row !== null) revealRowInCard(rootRef.current, row)
    }, [liveDnaKey])
    const pickDna = (key: string): void => {
      const it = dnaByKey.get(key)
      /* v8 ignore next 1 -- the bar only reports keys of the parts it was handed; defensive. */
      if (it === undefined) return
      openRow(it.cat, key)
    }

    /** One shared land-on-a-row sequence for every bar/map click that opens an exact row. */
    const openRow = (c: string, key: string): void => {
      setCat(c)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(key)
      focusScrollRef.current = true
    }

    const toolCount = (c: string): number => countOf(view, byCat, c)

    // A category holding exactly one item opens that row with the category, so one click lands on the content directly.
    const singleKeyOf = (c: string): string | null => {
      if (c === 'system') return view.system !== null ? 'sys' : null
      if (c === 'tools') {
        const tools = view.header?.tools
        return tools !== undefined && tools.length === 1 ? 'tool:' + tools[0].name : null
      }
      /* v8 ignore next 1 -- reached only through toggleCat's openable guard
         (count > 0 ⟺ byCat[c] exists); the fallback is defensive. */
      const nodes = byCat[c as Category] ?? []
      return nodes.length === 1 ? 'n' + String(nodes[0].seq) : null
    }

    const toggleCat = (c: string) => {
      if (dna) {
        // The flat feed has no category rows: system/tools land on their group rows; message categories are
        // interleaved in the feed, so a bare category pick has no row to open (grouped map blocks filter instead).
        if (c === 'system' && view.system !== null) { setOpenCat(c); setRowQuery(''); setOpenElem('sys') }
        else if (c === 'tools') { setOpenCat(c); setRowQuery(''); setOpenElem('tools') }
        return
      }
      // Empty cats stay shut — except system/tools with no header epoch, which open to explain the degradation note.
      const openable = toolCount(c) > 0
        || ((c === 'system' || c === 'tools') && view.header === null)
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
    // The flat feed's header group rows double as their category's row: opening one pins the category (bar and
    // trend link) exactly like the accordion's category click; the tools group stays open while any of its
    // element keys is. Message rows stay elem-scoped.
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

    /** Block-map picks: a one-item block lands on its exact row (the DNA band pick's path), a multi-item
     * block filters the category's rows to the group's tag, and the "others" fold just opens the category. */
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

    /** Expandable element row; `err` carries the red run-state dot right after the chevron so a failed result scans while collapsed.
     * `opts.open` overrides the `openElem === key` derivation for rows whose key set is wider (the flat feed's tools group);
     * `opts.onHover` lets a DNA feed row light its own band on the composition bar. The reverse echo — a DNA band
     * hover lighting its row — derives straight from the band key: a node or the system prompt matches its own row,
     * a tool-schema band matches the tools group row. */
    const elemRow = (
      key: string, tag: ReactNode | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNode,
      err = false, trailing: ReactNode = null,
      stamp: { turn: number; step: number; pending: boolean } | null = null,
      opts?: { open?: boolean; onHover?: (over: boolean) => void },
    ) => {
      const open = opts?.open ?? openElem === key
      const hover = opts?.onHover
      const echo = dna && liveDnaKey !== null
        && (liveDnaKey === key || (key === 'tools' && liveDnaKey.startsWith('tool:')))
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '') + (echo ? ' lc-br-elem-echo' : '')}>
          <button
            type="button"
            className="lc-br-elem-row hover:bg-(--dsw-alias-interactive-bg-hover)"
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
          {open ? <div className="lc-br-content">{body}</div> : null}
        </div>
      )
    }

    // A row's stamp: its confirmed introducing step, else — LIVE only — the pending estimate (past-step views never speculate).
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

    /** One message row's display facts, shared by the category bodies and the DNA flat feed, so the text
     * filter scans exactly what the rows show — at derivation time, not per keystroke. */
    const nodeRowOf = (n: SurfaceNode) => {
      const conv = bySeq.get(n.seq)
      // A `skill`-tool load reclassifies into the `skill` bucket but stays a tool result — same failure rule.
      const rowErr = (n.cat === 'tool' || n.cat === 'skill') && toolErrOf(n, conv).err
      let tag: string | null = null
      let tagNames: string[] | null = null
      let preview = nodeText(n)
      const id = nodeNameOf(n)
      if (n.cat === 'tool') {
        tag = n.tool ?? '?'
        tagNames = n.tool !== undefined ? [n.tool] : null
        preview = callSummaryOf(conv) ?? t('node.toolResult')
      } else if (n.cat === 'skill') {
        tag = n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : t('form.' + (n.form || 'context'))
        preview = (n.skill === undefined && id !== '' ? id : null)
          ?? (n.text !== undefined && n.text !== '' ? n.text : null)
          ?? callSummaryOf(conv) ?? preview
      } else if (n.cat === 'assistant') {
        // The fold stamps `calls` only on TEXT-LESS replies; a reply carrying both text and calls recovers its
        // breadcrumb through the join.
        const names = Array.isArray(n.calls) && n.calls.length > 0 ? n.calls : callNamesOf(conv)
        if (names.length > 0) {
          tag = names.join(' › ')
          tagNames = names
          preview = (n.text !== undefined && n.text !== '' ? n.text : null)
            ?? blockSummaryOf(conv)
            ?? t('node.empty')
        } else if (n.text === undefined || n.text === '') {
          preview = blockSummaryOf(conv) ?? preview
        }
      } else if (n.cat === 'user') {
        const attCount = attachmentsIn(conv?.content).length
        if (attCount > 0 && openElem !== `n${n.seq}`) {
          tag = t('attach.title') + (attCount > 1 ? ' ×' + String(attCount) : '')
        }
      } else {
        tag = t('form.' + (n.form || 'context'))
        if (id !== '') {
          preview = id
        } else if (n.text !== undefined && n.text !== '') {
          preview = n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
        }
      }
      return {
        n,
        conv,
        rowErr,
        tag,
        tagNames,
        preview,
        reasoning: n.cat === 'assistant' ? reasoningTextOf(conv) : '',
        kinds: msgKindsOf(n, conv),
      }
    }
    type NodeRow = ReturnType<typeof nodeRowOf>

    /** The text lens both row lists share: tag, preview, raw text, and thinking. */
    const rowMatches = (r: NodeRow, q: string): boolean =>
      (r.tag ?? '').toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)
      || (typeof r.n.text === 'string' && r.n.text.toLowerCase().includes(q))
      || r.reasoning.toLowerCase().includes(q)

    /** One expandable message row — the category bodies' and the flat feed's shared renderer; `tag` composes
     * the row's chips (the flat feed adds the category label and the prompt position) and `onHover` lights
     * the row's own band on the bar. */
    const messageRow = (r: NodeRow, tag: ReactNode, onHover?: (over: boolean) => void): ReactElement =>
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
          // Only the open row's body renders, so the miss note is exactly THIS join's fetch state.
          hint={r.conv === undefined ? missNote : t('browser.noContent')}
        />,
        r.rowErr, null, stampFor(r.n.seq), onHover !== undefined ? { onHover } : undefined)

    /** The system row's preview and content body, shared by the category body and the DNA flat feed. */
    const systemPreviewOf = (sys: SystemPromptNode): string =>
      headerContent.get(sys.seq)?.system?.replace(/\s+/g, ' ').trim().slice(0, 80) ?? ''
    const systemBodyOf = (sys: SystemPromptNode): ReactNode => {
      const content = headerContent.get(sys.seq)
      if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
      if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
      return <TextSection label={catLabel('system')} text={content.system} rich={rich} lines={lineLabel} />
    }

    const catBody = (c: string): ReactNode => {
      if (c === 'system') {
        // No prompt in force: the note must name the missing PROJECTION — no headers service versus no epoch yet.
        const sys = view.system
        if (sys === null) {
          return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        }
        const content = headerContent.get(sys.seq)
        if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
        if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
        return elemRow('sys', null, systemPreviewOf(sys), breakdown.system, undefined,
          systemBodyOf(sys), false, null, stampFor(sys.seq))
      }
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        const labels = {
          desc: t('tool.desc'),
          title: t('tool.params'),
          empty: t('tool.paramsEmpty'),
          show: t('tool.jsonToggle'),
          hide: t('tool.jsonHide'),
        }
        const content = headerContent.get(view.header.seq)
        const epochStamp = stampFor(view.header.seq)
        const contentByName = new Map(content?.tools.map(t => [t.name, t]) ?? [])
        const q = rowQuery.trim().toLowerCase()
        const shown = view.header.tools
          .filter((tool: HeaderTool) => {
            if (q === '') return true
            if (tool.name.toLowerCase().includes(q)) return true
            if ((tool.plugin ?? '').toLowerCase().includes(q)) return true
            const row = contentByName.get(tool.name)
            if (row === undefined) return false
            return (row.description ?? '').toLowerCase().includes(q)
              || schemaTextOf(row.schema).toLowerCase().includes(q)
          })
          // Size order mirrors the overview's Top chips; the producer's header order is not meaningful.
          .sort((a, b) => toolSort === 'count'
            ? (toolHitsOf(b) - toolHitsOf(a) || (a.name < b.name ? -1 : 1))
            : toolSort === 'size'
              ? b.tokens - a.tokens
              : (a.name < b.name ? -1 : 1))
        const toolctl = (
          <RowToolbar value={rowQuery} placeholder={t('tool.search')} tip={t('tool.sortTip')} onChange={setRowQuery}>
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
        if (shown.length === 0) {
          return (
            <div>
              {toolctl}
              <div className="lc-br-note">{t('tool.noMatch')}</div>
            </div>
          )
        }
        const toolBody = (tool: HeaderTool): ReactNode => {
          if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
          const row = contentByName.get(tool.name)
          return row === undefined
            ? <div className="lc-br-note">{t('browser.notInLog')}</div>
            : <ToolSchema description={row.description} schema={row.schema} rich={rich} lines={lineLabel} labels={labels} />
        }
        return (
          <div>
            {toolctl}
            {shown.map((tool: HeaderTool) => {
              // Best-effort host attribution (toolSources.ts); a provider predating the attribution hook arrives as the
              // UNKNOWN_TOOL_SOURCE sentinel and renders the localized "unknown plugin" tag.
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
              return elemRow('tool:' + tool.name, null, tool.name, tool.tokens, undefined,
                toolBody(tool),
                false, trailing, epochStamp)
            })}
          </div>
        )
      }
      /* v8 ignore next 1 -- the body renders only when the category is open,
         which requires count > 0 ⟺ byCat[c] exists; defensive. */
      const rows = (byCat[c as Category] ?? []).slice().reverse().map(nodeRowOf)
      const q = rowQuery.trim().toLowerCase()
      // Kind chips count over ALL of the shown step's rows — the step's composition, not the text-lens survivors.
      const kindCounts = c === 'assistant'
        ? ROW_KINDS.map(k => ({ k, n: rows.reduce((acc, r) => acc + (r.kinds[k] ? 1 : 0), 0) }))
        : null
      const shown = q === '' && rowKind === null
        ? rows
        : rows.filter(r =>
          (rowKind === null || r.kinds[rowKind])
          && (q === '' || rowMatches(r, q)))
      const rowctl = kindCounts === null
        ? <RowToolbar value={rowQuery} placeholder={t('browser.search.' + c)} onChange={setRowQuery} />
        : (
          <RowToolbar value={rowQuery} placeholder={t('browser.search.' + c)} tip={t('browser.kindTip')} onChange={setRowQuery}>
            {kindCounts.map(({ k, n }) => (
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
      return (
        <div>
          {rowctl}
          {shown.map(r => messageRow(r, rowTagNode(r.tag, r.tagNames)))}
        </div>
      )
    }

    /** The DNA feed row's category chip: the category's own color as a tinted capsule — the same
     * color-mix idiom the delta badges and the block map's tiles use — so a row maps to its bar band at a glance. */
    const catChip = (cat: Category | 'system' | 'tools'): ReactElement => (
      <span
        className="lc-br-tag"
        style={{
          background: `color-mix(in srgb, ${CAT_COLOR[cat]} 14%, transparent)`,
          borderColor: `color-mix(in srgb, ${CAT_COLOR[cat]} 45%, transparent)`,
        }}
      >{catLabel(cat)}</span>
    )

    /** The DNA feed's header group row: one row for every tool schema, opening into the category body's
     * toolbar and rows. It sits at the feed's bottom — the model reads the header before the messages. */
    const toolsGroupRow = (header: HeaderRecord): ReactElement => {
      const open = toolsElemOpen()
      return elemRow(
        'tools',
        catChip('tools'),
        t('browser.items', { n: header.tools.length }),
        breakdown.tools,
        undefined,
        catBody('tools'),
        false, null,
        stampFor(header.seq),
        { open, onHover: (over) => { setRowDnaKey(over ? 'tools' : null) } },
      )
    }

    const systemRow = (sys: SystemPromptNode): ReactElement =>
      elemRow('sys', catChip('system'), systemPreviewOf(sys),
        breakdown.system, undefined, systemBodyOf(sys), false, null, stampFor(sys.seq),
        { onHover: (over) => { setRowDnaKey(over ? 'system' : null) } })

    /** The DNA feed: every assembled item as one flat row list in the prompt's reading order, presented
     * bottom-up — the model reads oldest-first, so the NEWEST message is the top row and the header groups
     * (tool schemas, system prompt) close the list. One text lens (`rowQuery`) — pinned in the card head —
     * filters the feed's rows and the open tools group's schemas alike. */
    const flatToolbar = (): ReactElement => (
      <RowToolbar value={rowQuery} placeholder={t('browser.search.flat')} onChange={setRowQuery} />
    )

    /* v8 ignore start -- jsdom has no layout/ResizeObserver: the wide gate and the first-paint skeleton are live-only. */
    useEffect(() => {
      if (!dna) {
        setFlatReady(false)
        return
      }
      const el = scrollRef.current
      if (el === null) return
      const sync = (): void => { setFlatWide(el.clientWidth >= 380) }
      sync()
      setFlatReady(true)
      if (typeof ResizeObserver !== 'function') return
      const observer = new ResizeObserver(sync)
      observer.observe(el)
      return () => { observer.disconnect() }
    }, [dna])
    /* v8 ignore stop */

    interface FlatEntry {
      r: NodeRow
      pos: number
    }
    /** Only the visible feed slice becomes React elements: a long session carries over a thousand rows, and
     *  building them all just to render ~30 was the DNA toggle's dominant cost. */
    const flatRows = (): { entries: FlatEntry[]; tail: ReactElement[]; empty: boolean } => {
      const q = rowQuery.trim().toLowerCase()
      // Positions count ascending in reading order; reversing the array must not renumber them.
      const entries: FlatEntry[] = []
      for (let i = view.nodes.length - 1; i >= 0; i--) {
        const r = nodeRowOf(view.nodes[i])
        if (q !== '' && !rowMatches(r, q)) continue
        entries.push({ r, pos: i + 1 })
      }
      // An empty q matches everything (String.includes('') is true), so the lens needs no short-circuit arms.
      // A header-less surface (no epoch served) renders message bands only, so its feed carries no header rows.
      const toolsHit = (view.header?.tools ?? []).some(tool =>
        tool.name.toLowerCase().includes(q) || (tool.plugin ?? '').toLowerCase().includes(q))
      const sys = view.system
      const sysText = sys !== null ? headerContent.get(sys.seq)?.system ?? '' : ''
      const sysHit = sys !== null && (systemPreviewOf(sys).toLowerCase().includes(q) || sysText.toLowerCase().includes(q))
      const tail: ReactElement[] = []
      if (view.header !== null && toolsHit) tail.push(toolsGroupRow(view.header))
      if (sys !== null && sysHit) tail.push(systemRow(sys))
      return { entries, tail, empty: entries.length === 0 && tail.length === 0 }
    }
    const flatRowsModel = dna && flatReady ? flatRows() : null
    // 28px row + 2px flat gap: the pad formula reproduces the full feed height while only the viewport renders.
    const flatRange = useRowWindow(scrollRef, flatRowsModel?.entries.length ?? 0, 30, dna && flatReady && flatWide && openElem === null)
    // A non-DNA render never shows this model; the local keeps the JSX branch-free (the DNA branch owns the rows).
    const flat = flatRowsModel ?? { entries: [] as FlatEntry[], tail: [] as ReactElement[], empty: true }

    return (
      <div className="lc-card lc-br" ref={rootRef}>
        <div className="lc-br-head">
          <div className="lc-card-title">
            <span className="lc-card-title-text">{t('browser.title')}</span>
            <span className="lc-gran lc-br-dna-ctl" role="group" title={t('browser.dnaTip')}>
              <button
                type="button"
                className={'lc-gran-btn' + (dna ? ' lc-gran-on' : '')}
                onClick={() => { setDna(!dna) }}
              >
                {t('browser.dna')}
              </button>
            </span>
            <span className="lc-gran" role="group" title={t('browser.base.tip')}>
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
            <select
              className="lc-br-pick"
              value={seq === null ? 'live' : String(seq)}
              onChange={(e) => { pick(e.target.value) }}
            >
              <option value="live">{t('browser.live')}</option>
              {pickOptions}
            </select>
          </div>

          <div className={'lc-br-bar' + (dna ? ' lc-br-bar-dna' : '')}>
            <div className="lc-br-bar-main">
              <div className="lc-br-meta">
                <b>{req !== null
                  ? t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0, n: stepsOf(req.turn) })
                  : t('browser.liveNow')}</b>
                {req !== null ? <span>{fmtTime(req.time)}</span> : null}
                <span className="lc-est">{t('detail.estTotal', { n: fmt(total) })}</span>
                {actual !== null && actual.prompt !== undefined
                  ? <span>{t('detail.actual', { n: fmt(actual.prompt) })}</span>
                  : null}
              </div>
              <StackedBar
                parts={dnaParts ?? parts}
                height={10}
                // Highlight precedence: pointer hover (local in DNA mode, the shared link otherwise) over the open-category pin. In
                // DNA mode the mirrored link is ONE-WAY: an incoming category key lights that category's bands, while band hovers stay
                // on the bar and never report upward.
                hoverKey={dna ? liveDnaKey ?? rowDnaLive ?? linkKey ?? pinKey : linkKey ?? pinKey}
                onHoverKey={dna ? setDnaKey : linked ? props.onHoverKey : undefined}
                tip={dna}
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
          {view.approximate
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

        {/* The block map sits in the card's fixed zone, right under the head: the rows region below is the
            only scroller, and the map keeps the height it opens at (browser.css). */}
        {mapOn
          ? (
            <BrowserTreemap
              view={view}
              openCat={openCat}
              hoverKey={linkKey}
              // The map reports its category upward only outside DNA mode: there the bar's link is one-way (an
              // incoming category key lights that category's bands; bar hovers stay local), and the map — the
              // bar's companion surface — keeps the same convention so every hover link mirrors the bar's.
              onHoverKey={dna ? undefined : linked ? props.onHoverKey : undefined}
              onPickCat={toggleCat}
              onPickBlock={pickMapBlock}
            />
          )
          : null}

        <div className="lc-br-scroll" ref={scrollRef}>
          {dna
            ? (!flatReady
              /* v8 ignore next 2 -- first paint only; jsdom flushes effect work before assertions. */
              ? <div className="lc-br-flat" style={{ minHeight: 320 }} aria-hidden="true" />
              : (
                <div className="lc-br-flat">
                  {flatRange.from > 0 ? <div className="lc-row-pad" style={{ height: Math.max(0, flatRange.from * 30 - 2) }} aria-hidden="true" /> : null}
                  {flat.entries.slice(flatRange.from, flatRange.to + 1).map(({ r, pos }) => messageRow(r, (
                    <>
                      {catChip(r.n.cat)}
                      <span className="lc-br-pos">#{fmt(pos)}</span>
                      {rowTagNode(r.tag, r.tagNames)}
                    </>
                  ), (over) => { setRowDnaKey(over ? 'n' + String(r.n.seq) : null) }))}
                  {flatRange.to < flat.entries.length - 1
                    ? <div className="lc-row-pad" style={{ height: Math.max(0, (flat.entries.length - 1 - flatRange.to) * 30 - 2) }} aria-hidden="true" />
                    : null}
                  {/* Header groups are the feed's tail: render them AFTER the bottom pad so they stay at the end. */}
                  {flat.tail}
                  {flat.empty ? <div className="lc-br-note">{t('browser.rowNoMatch')}</div> : null}
                </div>
              ))
            : (
              <div className="lc-br-cats">
                {CATS.map((c) => {
                  const count = toolCount(c.key)
                  const v = breakdown[c.key] || 0
                  const prevCount = zeroBase ? 0 : prevView !== null && prevByCat !== null ? countOf(prevView, prevByCat, c.key) : null
                  const countDelta = prevCount !== null ? count - prevCount : null
                  const prevTokens = zeroBase ? 0 : refReq !== null ? (refReq[c.key] || 0) : null
                  const tokenDelta = prevTokens !== null ? v - prevTokens : null
                  const openable = count > 0
                    || ((c.key === 'system' || c.key === 'tools') && view.header === null)
                  const open = openCat === c.key && openable
                  return (
                    <div key={c.key} className={'lc-br-cat' + (openable ? '' : ' lc-br-cat-empty')}>
                      <button
                        type="button"
                        className={'lc-br-cat-row hover:bg-(--dsw-alias-interactive-bg-hover)'
                          + (open ? ' lc-br-cat-open' : '')
                          + (linked && props.hoverKey === c.key ? ' lc-br-cat-on' : '')}
                        /* v8 ignore start -- the handlers exist only when linked,
                           and linked already requires onHoverKey defined (above). */
                        onMouseEnter={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(c.key) } : undefined}
                        onMouseLeave={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) } : undefined}
                        /* v8 ignore stop */
                        onClick={() => { toggleCat(c.key) }}
                      >
                        <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
                        <i style={{ background: c.color }} />
                        <span className="lc-br-cat-label">{catLabel(c.key)}</span>
                        <span className="lc-br-count-grp">
                          <span className="lc-br-cat-count">{t('browser.items', { n: count })}</span>
                          {countDelta !== null && countDelta !== 0 ? (
                            <span className={'lc-br-delta lc-br-delta-' + (countDelta > 0 ? 'up' : 'down')}>
                              {`${countDelta > 0 ? '+' : ''}${countDelta}`}
                            </span>
                          ) : null}
                        </span>
                        <span className="lc-br-tokens-grp">
                          {tokenDelta !== null && tokenDelta !== 0 ? (
                            <span className={'lc-br-tdelta lc-br-tdelta-' + (tokenDelta > 0 ? 'up' : 'down')}>
                              {(tokenDelta > 0 ? '+' : '') + fmt(tokenDelta)}
                            </span>
                          ) : null}
                          <span className="lc-br-tokens">{'≈' + fmt(v)}</span>
                        </span>
                        <span className="lc-br-pct">{total > 0 ? `${Math.round(v / total * 100)}%` : ''}</span>
                      </button>
                      {open ? <div className="lc-br-body">{catBody(c.key)}</div> : null}
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
