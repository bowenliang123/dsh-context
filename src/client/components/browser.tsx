import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { UNKNOWN_TOOL_SOURCE, type Category, type ContextHeaders, type ContextTimeline, type HeaderTool, type RequestRecord, type SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
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
import { NodeContent, byCatOf, nodeNameOf, msgKindsOf, reasoningTextOf, ROW_KINDS } from './browserNodes'
import type { RowKind } from './browserNodes'
import { MapIcon, makeBrowserTreemap } from './browserTreemap'
import type { MapBlock } from '../treemap'

export interface ContextBrowserProps {
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


export interface CatFocus {
  cat: string
  kind?: RowKind
}

/** One message row's display facts: the row and the text filter read the same derivation, so a filter scans
 * exactly what the rows show. */
interface RowFacts {
  n: SurfaceNode
  conv: ConversationNodeLike | undefined
  rowErr: boolean
  tag: string | null
  tagNames: string[] | null
  preview: string
  reasoning: string
  kinds: ReturnType<typeof msgKindsOf>
}

function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

/** The turn/step marking where a surface item entered the context: the FIRST request logged after the item's seq is
 * the first that carried it (assemble's inclusion rule is `n.seq < R.seq`); no following request stamps null. */
export function stepStampOf(requests: RequestRecord[]): (itemSeq: number) => { turn: number; step: number } | null {
  // Sort a copy: the wire arrives in append order, but the derivation must not depend on it (restored rows can re-order).
  const sorted = requests.slice().sort((a, b) => a.seq - b.seq)
  return (itemSeq) => {
    for (const r of sorted) {
      if (r.seq > itemSeq) {
        return typeof r.turn === 'number' && typeof r.step === 'number' ? { turn: r.turn, step: r.step } : null
      }
    }
    return null
  }
}

/** Bands keep at least this share of the occupied region, so a tiny item stays a hoverable/clickable filament
 * instead of a sub-pixel sliver; tooltips still report true shares. */
const DNA_MIN_BAND = 0.35

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
    // DNA mode folds the epoch's tool schemas into one group, folded until asked for.
    const [toolsOpen, setToolsOpen] = useState(false)
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
      setSel('live')
      setCat(catFocus.cat)
      setOpenElem(null)
      setRowQuery('')
      setRowKind(catFocus.kind ?? null)
      if (props.onCatFocusHandled !== undefined) props.onCatFocusHandled()
    }, [catFocus, props.onCatFocusHandled, onOpenCat])
    useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      rootRef.current?.querySelector('.lc-br-elem-on')?.scrollIntoView({ block: 'nearest' })
    })
    // The note an un-joined open row shows, per fetch state (fetchOnMiss.tsx).
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
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
    const view = assemble(data, headers, seq)

    // The projections carry metadata only, so each section's content is fetched on demand: the system prompt rides
    // the timeline's own `system/message` node, the tool schemas the `request/header` epoch. A fetched value caches
    // under the REQUESTED seq alone, so the two keep one machine each — DNA mode reads both at once (it renders the
    // system prompt and the schemas as rows in their own right), and either one would otherwise show the other's
    // miss as a note that never clears.
    const fetchHeader = props.fetchHeader
    const headerSeq = view.header !== null ? view.header.seq : null
    const systemSeq = view.system !== null ? view.system.seq : null
    const epoch = useFetchOnMiss(
      (openCat === 'system' || dna) ? systemSeq : null,
      fetchHeader,
      'dsh-context: header content fetch failed',
    )
    const toolEpoch = useFetchOnMiss(
      (openCat === 'tools' || dna) ? headerSeq : null,
      fetchHeader,
      'dsh-context: header content fetch failed',
    )

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
    const prevView = refReq !== null ? assemble(data, headers, refReq.seq) : null
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
    // The bar's pointer slot, fed by a band hover on the bar or by a DNA row's own hover; honored only while its key
    // names a RENDERED band: a push can drop the band under a resting pointer without a mouseleave, and a dead key
    // would leave the bar all-dimmed (the same invariant the pin's gate keeps).
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    // An open row keeps its own band lit — the list indexes the bar back; a pointer hover on the bar overrides it.
    const browseKey = dna && openElem !== null && dnaByKey.has(openElem) ? openElem : null
    // An open tool row lives inside the folded group, so it holds that group unfolded.
    const openToolKey = openElem !== null && dnaByKey.get(openElem)?.cat === 'tools' ? openElem : null
    const pickDna = (key: string): void => {
      const it = dnaByKey.get(key)
      /* v8 ignore next 1 -- the bar only reports keys of the parts it was handed; defensive. */
      if (it === undefined) return
      // Reveal a schema before opening its row: the group may still be folded.
      if (it.cat === 'tools') setToolsOpen(true)
      openRow(null, key)
    }

    /** One shared land-on-a-row sequence for every bar/map click that opens an exact row; a `null` category keeps
     * the category view as it is. */
    const openRow = (c: string | null, key: string): void => {
      if (c !== null) setCat(c)
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
    const toggleElem = (key: string) => { setOpenElem(openElem === key ? null : key) }

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

    /** Expandable element row; `err` carries the red run-state dot right after the chevron so a failed result scans while collapsed. */
    const elemRow = (
      key: string, tag: ReactNode | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNode,
      err = false, trailing: ReactNode = null,
      stamp: { turn: number; step: number; pending: boolean } | null = null,
      // A DNA row IS one band: its hover feeds the bar's own hover slot, the same region highlight a category row
      // gets in the category view.
      bandHover = false,
    ) => {
      const open = openElem === key
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '')}>
          <button
            type="button"
            className="lc-br-elem-row hover:bg-(--dsw-alias-interactive-bg-hover)"
            onClick={() => { toggleElem(key) }}
            onMouseEnter={bandHover ? () => { setDnaKey(key) } : undefined}
            onMouseLeave={bandHover ? () => { setDnaKey(null) } : undefined}
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

    // Shared row builders: the category view and the DNA flat list render the SAME rows — only the grouping/ordering differs.
    const systemContent = epoch.values
    const systemNote = fetchMissNote(t, fetchHeader, epoch.state, epoch.retry, 'browser.headerMetaOnly')
    const toolsNote = fetchMissNote(t, fetchHeader, toolEpoch.state, toolEpoch.retry, 'browser.headerMetaOnly')
    const headerRow = view.header !== null ? toolEpoch.values.get(view.header.seq) : undefined
    // One stamp for every tool-schema row: a tool row exists only while the header epoch does.
    const epochStamp = view.header !== null ? stampFor(view.header.seq) : null
    const contentByName = new Map(headerRow?.tools.map(tool => [tool.name, tool] as const) ?? [])
    const toolLabels = {
      desc: t('tool.desc'),
      title: t('tool.params'),
      empty: t('tool.paramsEmpty'),
      show: t('tool.jsonToggle'),
      hide: t('tool.jsonHide'),
    }
    const toolBody = (tool: HeaderTool): ReactNode => {
      if (headerRow === undefined) return <div className="lc-br-note">{toolsNote}</div>
      const row = contentByName.get(tool.name)
      return row === undefined
        ? <div className="lc-br-note">{t('browser.notInLog')}</div>
        : <ToolSchema description={row.description} schema={row.schema} rich={rich} lines={lineLabel} labels={toolLabels} />
    }
    const toolRow = (tool: HeaderTool, tag: ReactNode = null, bandHover = false): ReactNode => {
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
      return elemRow('tool:' + tool.name, tag, tool.name, tool.tokens, undefined,
        toolBody(tool), false, trailing, epochStamp, bandHover)
    }
    const systemRow = (tag: ReactNode = null, bandHover = false): ReactNode => {
      const sys = view.system
      // No prompt in force: the note must name the missing PROJECTION — no headers service versus no epoch yet.
      if (sys === null) {
        return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
      }
      const content = systemContent.get(sys.seq)
      if (content === undefined) return <div className="lc-br-note">{systemNote}</div>
      if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
      return elemRow('sys', tag, content.system.replace(/\s+/g, ' ').trim().slice(0, 80), breakdown.system, undefined,
        <TextSection label={catLabel('system')} text={content.system} rich={rich} lines={lineLabel} />,
        false, null, stampFor(sys.seq), bandHover)
    }
    const rowFactsOf = (n: SurfaceNode) => {
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
    /** The DNA rows annotate every entry with its type — the category view's dot+label echoed per row. */
    const typeTag = (cat: Category | 'system' | 'tools'): ReactNode => (
      <span className="lc-br-tag lc-br-type"><i style={{ background: CAT_COLOR[cat] }} />{catLabel(cat)}</span>
    )
    const msgRow = (r: RowFacts, lead: ReactNode = null, bandHover = false): ReactNode => {
      const tag = rowTagNode(r.tag, r.tagNames)
      return elemRow(`n${r.n.seq}`, lead === null ? tag : <>{lead}{tag}</>, r.preview, r.n.tokens, r.n.time,
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
        r.rowErr, null, stampFor(r.n.seq), bandHover)
    }

    const catBody = (c: string): ReactNode => {
      if (c === 'system') return systemRow()
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
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
        return (
          <div>
            {toolctl}
            {shown.map((tool: HeaderTool) => toolRow(tool))}
          </div>
        )
      }
      /* v8 ignore next 1 -- the body renders only when the category is open,
         which requires count > 0 ⟺ byCat[c] exists; defensive. */
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      // Rows derive their display facts first, so the text filter scans exactly what the rows show — at derivation time, not per keystroke.
      const rows = nodes.map(rowFactsOf)
      const q = rowQuery.trim().toLowerCase()
      // Kind chips count over ALL of the shown step's rows — the step's composition, not the text-lens survivors.
      const kindCounts = c === 'assistant'
        ? ROW_KINDS.map(k => ({ k, n: rows.reduce((acc, r) => acc + (r.kinds[k] ? 1 : 0), 0) }))
        : null
      const shown = q === '' && rowKind === null
        ? rows
        : rows.filter(r =>
          (rowKind === null || r.kinds[rowKind])
          && (q === ''
            || (r.tag ?? '').toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)
            || (typeof r.n.text === 'string' && r.n.text.toLowerCase().includes(q))
            || r.reasoning.toLowerCase().includes(q)))
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
          {shown.map(r => msgRow(r))}
        </div>
      )
    }

    // The DNA flat list: one row per band, read NEWEST message first (the category view's own order) while the strip
    // keeps its prompt order — the bar indexes the list (a band click opens its row) and the list indexes the bar
    // back (a hovered or open row lights its band).
    const promptNoTag = (no: number, tip: string): ReactNode => (
      <span className="lc-br-tag lc-br-idx" title={tip}>#{fmt(no)}</span>
    )
    const toolDnaRow = (key: string, tag: ReactNode): ReactNode => {
      const tool = view.header?.tools.find(tool => 'tool:' + tool.name === key)
      /* v8 ignore next 1 -- dnaOf emits tool bands only from the header's own list; defensive. */
      return tool === undefined ? <div className="lc-br-note">{t('browser.notInLog')}</div> : toolRow(tool, tag, true)
    }
    const dnaSearchOf = (it: DnaItem): string => {
      if (!('node' in it)) {
        if (it.cat === 'system') {
          const sys = view.system
          /* v8 ignore next 1 -- a 'sys' band exists only while the system projection does; defensive. */
          return sys !== null ? systemContent.get(sys.seq)?.system ?? '' : ''
        }
        const tool = view.header?.tools.find(tool => 'tool:' + tool.name === it.key)
        /* v8 ignore next 1 -- dnaOf emits tool bands only from the header's own list; defensive. */
        if (tool === undefined) return ''
        const row = contentByName.get(tool.name)
        return [tool.name, tool.plugin ?? '', row?.description ?? '', row !== undefined ? schemaTextOf(row.schema) : ''].join('\n')
      }
      const f = rowFactsOf(it.node)
      return [(f.tag ?? ''), f.preview, typeof f.n.text === 'string' ? f.n.text : '', f.reasoning].join('\n')
    }
    const dnaRowOf = (it: DnaItem, lead: ReactNode): ReactNode => {
      if (!('node' in it)) return it.cat === 'system' ? systemRow(lead, true) : toolDnaRow(it.key, lead)
      return msgRow(rowFactsOf(it.node), lead, true)
    }
    const dnaList = (): ReactNode => {
      if (dnaItems === null || dnaItems.length === 0) return null
      // The prompt's prefix — the system prompt and the schema group — keeps its seat at the top; the message entries
      // below read newest-first, matching the category view.
      const ordered = [...dnaItems.filter(it => !('node' in it)), ...dnaItems.filter(it => 'node' in it).reverse()]
      // Independent prompt-position counters, stable under the row filter: tool schemas number 1..N in
      // the epoch's producer order, messages 1..M in model-visible order; the system prompt is unnumbered.
      const leads = new Map<string, ReactNode>()
      let toolNo = 0
      let msgNo = 0
      for (const it of dnaItems) {
        if ('node' in it) leads.set(it.key, <>{typeTag(it.cat)}{promptNoTag(++msgNo, t('browser.msgNoTip'))}</>)
        else if (it.cat === 'tools') leads.set(it.key, <>{typeTag('tools')}{promptNoTag(++toolNo, t('browser.toolNoTip'))}</>)
        else leads.set(it.key, typeTag('system'))
      }
      const rowOf = (it: DnaItem): ReactNode => dnaRowOf(it, leads.get(it.key))
      const q = rowQuery.trim().toLowerCase()
      if (q !== '') {
        // A filtered list is flat: a folded group must never hide a hit.
        const hits = ordered.filter(it => dnaSearchOf(it).toLowerCase().includes(q))
        return (
          <>
            <RowToolbar value={rowQuery} placeholder={t('browser.search.dna')} onChange={setRowQuery} />
            {hits.length === 0
              ? <div className="lc-br-note">{t('browser.rowNoMatch')}</div>
              : hits.map(it => <Fragment key={it.key}>{rowOf(it)}</Fragment>)}
          </>
        )
      }
      // The epoch's tool schemas form one contiguous block after the system prompt (dna.ts); fold it by default —
      // reading the message flow rarely needs every schema open.
      const tools = ordered.filter(it => !('node' in it) && it.cat === 'tools')
      const from = ordered.findIndex(it => !('node' in it) && it.cat === 'tools')
      const head = from < 0 ? ordered : ordered.slice(0, from)
      const tail = from < 0 ? [] : ordered.slice(from + tools.length)
      const unfold = toolsOpen || openToolKey !== null
      const toolsTokens = tools.reduce((sum, it) => sum + it.tokens, 0)
      const toggleTools = (): void => {
        // Folding the group takes the tool row it holds with it, so no band stays lit for a hidden row.
        if (openToolKey !== null) setOpenElem(null)
        setToolsOpen(!unfold)
      }
      return (
        <>
          <RowToolbar value={rowQuery} placeholder={t('browser.search.dna')} onChange={setRowQuery} />
          {head.map(it => <Fragment key={it.key}>{rowOf(it)}</Fragment>)}
          {tools.length === 0
            ? null
            : (
              <>
                <div className="lc-br-elem">
                  <button
                    type="button"
                    className="lc-br-elem-row lc-br-fold hover:bg-(--dsw-alias-interactive-bg-hover)"
                    onClick={toggleTools}
                  >
                    <span className={'lc-br-chev' + (unfold ? ' lc-br-chev-on' : '')} />
                    <span className="lc-br-tags">{typeTag('tools')}</span>
                    <span className="lc-br-preview">{t('browser.items', { n: tools.length })}</span>
                    <span className="lc-br-tokens">{'≈' + fmt(toolsTokens)}</span>
                  </button>
                </div>
                {unfold ? tools.map(it => <Fragment key={it.key}>{rowOf(it)}</Fragment>) : null}
              </>
            )}
          {tail.map(it => <Fragment key={it.key}>{rowOf(it)}</Fragment>)}
        </>
      )
    }
    return (
      <div className="lc-card" ref={rootRef}>
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
            {requests.slice().reverse().map(r => (
              <option key={r.seq} value={String(r.seq)}>
                {t('detail.step', { t: r.turn ?? 0, s: r.step ?? 0, n: stepsOf(r.turn) })}
              </option>
            ))}
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
              // Highlight precedence: the pointer (a band on the bar, or the band of the DNA row under it), then the
              // OPEN ROW's own band (the list indexes the bar back), then the open-category pin. In DNA mode the
              // mirrored link is ONE-WAY: an incoming category key lights that category's bands, while band hovers
              // stay local and never report upward.
              hoverKey={dna ? liveDnaKey ?? browseKey ?? linkKey ?? pinKey : linkKey ?? pinKey}
              onHoverKey={dna ? setDnaKey : linked ? props.onHoverKey : undefined}
              // The tooltip belongs to the pointer: a browsed row's lit band floats none (the open row is its own label).
              tip={dna && (liveDnaKey !== null || browseKey === null)}
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

        {/* DNA mode flattens the entries into one list read newest message first; category mode keeps the accordions. */}
        <div className={dna ? 'lc-br-dna-list' : 'lc-br-cats'}>
          {dna ? dnaList() : CATS.map((c) => {
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
      </div>
    )
  }
}
