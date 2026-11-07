import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react'
import { assembleCached } from './derivedCache'
import { UNKNOWN_TOOL_SOURCE, type Category, type ContextHeaders, type ContextTimeline, type HeaderRecord, type HeaderTool, type RequestRecord, type SurfaceNode, type SystemPromptNode } from '../../shared/types'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
import type { DnaItem } from '../dna'
import type { ContentFetcher, ConversationNodeLike, HeaderFetcher } from '../services'
import type { ContextSettings, DefaultDeltaBase, DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import { IconBrowse } from '../primitives'
import type { DetailState } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import { makeNodeText } from './nodes'
import { turnStepsOf } from './trendModel'
import { useRowGeometry, useWindowedRows } from './useRowWindow'
import { useElementSize } from './useElementMetrics'
import { fetchMissNote, useFetchOnMiss } from './fetchOnMiss'
import { makeNodeRowOf, rowMatches } from './browserRows'
import type { NodeRow } from './browserRows'
import { makeAttachmentSection } from './attachments'
import { makeRichText } from './richText'
import type { StackedBarProps } from './stackedBar'
import type { AttachmentOpener, ImageLoader } from '../services'
import { TextSection, schemaTextOf, RowToolbar, ToolSchema } from './browserToolCard'
import { revealRowInCard } from '../revealScroll'
import { NodeContent, byCatOf, msgKindsOf, ROW_KINDS } from './browserNodes'
import type { RowKind } from './browserNodes'
import { DNA_MIN_BAND, countOf, lastOfTurn, stepStampOf } from './browserHelpers'
import type { CatFocus } from './browserHelpers'
export type { CatFocus } from './browserHelpers'
export { stepStampOf } from './browserHelpers'
import { MapIcon, makeBrowserTreemap } from './browserTreemap'
import type { MapBlock } from '../treemap'


export interface ContextBrowserProps {
  locale?: string
  data: ContextTimeline
  headers: ContextHeaders | null
  convNodes?: readonly ConversationNodeLike[]
  fetchContent?: ContentFetcher
  fetchHeader?: HeaderFetcher
  previewSeq?: number | null
  pinSeq?: number | null
  dna?: boolean
  onDnaChange?: (on: boolean) => void
  nodeFocus?: { step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null
  onNodeFocusHandled?: () => void
  catFocus?: CatFocus | null
  onCatFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  onOpenCat?: (cat: string | null) => void
  loadImage?: ImageLoader
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
    const [sel, setSel] = useState<'live' | number>('live')
    const [openCat, setOpenCat] = useState<string | null>(null)
    const [openElem, setOpenElem] = useState<string | null>(null)
    const [rowQuery, setRowQuery] = useState('')
    const [rowKind, setRowKind] = useState<RowKind | null>(null)
    const [toolSort, setToolSort] = useState<DefaultToolSort>(() => settings.defaultToolSort())
    const [dnaLocal, setDnaLocal] = useState(false)
    const dnaLinked = props.dna !== undefined && props.onDnaChange !== undefined
    const dna = dnaLinked ? props.dna === true : dnaLocal
    const setDna = (on: boolean): void => {
      if (dnaLinked) {
        /* v8 ignore next 1 */
        props.onDnaChange?.(on)
      } else {
        setDnaLocal(on)
      }
    }
    const [dnaKey, setDnaKey] = useState<string | null>(null)
    const [rowDnaKey, setRowDnaKey] = useState<string | null>(null)
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
    const pinSeq = props.pinSeq
    useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setCat(null)
      setOpenElem(null)
    }, [pinSeq, onOpenCat])
    const rootRef = useRef<HTMLDivElement | null>(null)
    const scrollRef = useRef<HTMLDivElement | null>(null)
    const flatIndexRef = useRef<Map<string, number>>(new Map())
    const flatPitchRef = useRef(30)
    const flatSize = useElementSize(scrollRef, 'client', dna)
    const flatWide = flatSize.width >= 380
    const focusScrollRef = useRef(false)
    const revealFlatKey = useCallback((key: string): boolean => {
      /* v8 ignore next 1 */
      if (!dna || scrollRef.current === null) return false
      const index = flatIndexRef.current.get(key)
      /* v8 ignore next 1 */
      if (index === undefined) return false
      const el = scrollRef.current
      el.scrollTop = Math.max(0, index * flatPitchRef.current - 40)
      el.dispatchEvent(new Event('scroll'))
      const settle = (left: number): void => {
        /* v8 ignore next 1 */
        if (left <= 0) return
        requestAnimationFrame(() => {
          const row = [...el.querySelectorAll<HTMLElement>('[data-lc-key]')].find(node => node.dataset.lcKey === key) ?? null
          if (row !== null) revealRowInCard(rootRef.current, row)
          else settle(left - 1)
        })
      }
      settle(4)
      return true
    }, [dna])
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
      if (dna) setDna(false)
      setSel(catFocus.step ?? 'live')
      setCat(catFocus.cat)
      setOpenElem(null)
      setRowQuery(catFocus.query ?? '')
      setRowKind(catFocus.kind ?? null)
      if (props.onCatFocusHandled !== undefined) props.onCatFocusHandled()
    }, [catFocus, props.onCatFocusHandled, onOpenCat, dna])
    useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      const row = rootRef.current?.querySelector('.lc-br-elem-on') ?? null
      if (row !== null) revealRowInCard(rootRef.current, row)
    })
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const pickOptions = useMemo(
      () => requests.slice().reverse().map(r => (
        <option key={r.seq} value={String(r.seq)}>
          {t('detail.step', { t: r.turn ?? 0, s: r.step ?? 0, n: stepsOf(r.turn) })}
        </option>
      )),
      [requests, stepsOf, t, props.locale],
    )
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
    const linked = req === null && props.onHoverKey !== undefined
    const linkKey = linked && props.hoverKey !== null && props.hoverKey !== 'free'
      ? props.hoverKey
      : null
    const view = useMemo(() => assembleCached(data, headers, seq), [data, headers, seq])

    const toolsElemOpen = (): boolean => openElem === 'tools' || (openElem !== null && openElem.startsWith('tool:'))

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
    const pinKey = openCat !== null && (breakdown[openCat as Category | 'system' | 'tools'] || 0) > 0 ? openCat : null
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setCat(null)
      setOpenElem(null)
    }

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
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    const rowDnaLive = dna && rowDnaKey !== null
      && (rowDnaKey === 'tools' ? view.header !== null
        : rowDnaKey === 'system' ? view.system !== null
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
      focusScrollRef.current = true
    }

    const toolCount = (c: string): number => countOf(view, byCat, c)

    const singleKeyOf = (c: string): string | null => {
      if (c === 'system') return view.system !== null ? 'sys' : null
      if (c === 'tools') {
        const tools = view.header?.tools
        return tools !== undefined && tools.length === 1 ? 'tool:' + tools[0].name : null
      }
      /* v8 ignore next 1 */
      const nodes = byCat[c as Category] ?? []
      return nodes.length === 1 ? 'n' + String(nodes[0].seq) : null
    }

    const toggleCat = (c: string) => {
      if (dna) {
        if (c === 'system' && view.system !== null) { setOpenCat(c); setRowQuery(''); setOpenElem('sys') }
        else if (c === 'tools') { setOpenCat(c); setRowQuery(''); setOpenElem('tools') }
        return
      }
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
      opts?: { open?: boolean; onHover?: (over: boolean) => void },
    ) => {
      const open = opts?.open ?? openElem === key
      const hover = opts?.onHover
      const echo = dna && liveDnaKey !== null
        && (liveDnaKey === key || (key === 'tools' && liveDnaKey.startsWith('tool:')))
      return (
        <div key={key} data-lc-key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '') + (echo ? ' lc-br-elem-echo' : '')}>
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

    const nodeRowOf = makeNodeRowOf(kit, nodeText, bySeq, openElem)

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
          hint={r.conv === undefined ? missNote : t('browser.noContent')}
        />,
        r.rowErr, null, stampFor(r.n.seq), onHover !== undefined ? { onHover } : undefined)

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
          .sort((a, b) => toolSort === 'count'
            ? (toolHitsOf(b) - toolHitsOf(a) || (a.name < b.name ? -1 : 1))
            : toolSort === 'size'
              ? b.tokens - a.tokens
              : (a.name < b.name ? -1 : 1))
        const allPrices = view.header.tools.reduce((sum, tool) => sum + tool.tokens, 0)
        const shownPrices = shown.reduce((sum, tool) => sum + tool.tokens, 0)
        /* v8 ignore next 1 */
        const shownTokens = allPrices > 0 ? Math.round(breakdown.tools * shownPrices / allPrices) : 0
        const toolctl = (
          <RowToolbar
            value={rowQuery}
            placeholder={t('tool.search')}
            clearLabel={t('field.clear')}
            count={shown.length}
            tokens={shownTokens}
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
      /* v8 ignore next 1 */
      const rows = (byCat[c as Category] ?? []).slice().reverse().map(nodeRowOf)
      const q = rowQuery.trim().toLowerCase()
      const matchedRows = q === '' ? rows : rows.filter(r => rowMatches(r, q))
      const kindCounts = c === 'assistant'
        ? ROW_KINDS.map(k => ({ k, n: matchedRows.reduce((acc, r) => acc + (r.kinds[k] ? 1 : 0), 0) }))
        : null
      const shown = rowKind === null ? matchedRows : matchedRows.filter(r => r.kinds[rowKind])
      const shownTokens = shown.length === rows.length
        ? breakdown[c as Category] || 0
        : shown.reduce((sum, r) => sum + r.n.tokens, 0)
      const rowctl = kindCounts === null
        ? (
          <RowToolbar
            value={rowQuery}
            placeholder={t('browser.search.' + c)}
            clearLabel={t('field.clear')}
            count={shown.length}
            tokens={shownTokens}
            onChange={setRowQuery}
          />
        )
        : (
          <RowToolbar
            value={rowQuery}
            placeholder={t('browser.search.' + c)}
            clearLabel={t('field.clear')}
            count={shown.length}
            tokens={shownTokens}
            tip={t('browser.kindTip')}
            onChange={setRowQuery}
          >
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

    interface FlatEntry {
      r: NodeRow
      pos: number
    }
    const flatRows = (): { entries: FlatEntry[]; tail: ReactElement[]; count: number; tokens: number } => {
      const q = rowQuery.trim().toLowerCase()
      const entries: FlatEntry[] = []
      let tokens = 0
      for (let i = view.nodes.length - 1; i >= 0; i--) {
        const r = nodeRowOf(view.nodes[i])
        if (q !== '' && !rowMatches(r, q)) continue
        entries.push({ r, pos: i + 1 })
        tokens += r.n.tokens
      }
      const toolsHit = (view.header?.tools ?? []).some(tool =>
        tool.name.toLowerCase().includes(q) || (tool.plugin ?? '').toLowerCase().includes(q))
      const sys = view.system
      const sysText = sys !== null ? headerContent.get(sys.seq)?.system ?? '' : ''
      const sysHit = sys !== null && (systemPreviewOf(sys).toLowerCase().includes(q) || sysText.toLowerCase().includes(q))
      const tail: ReactElement[] = []
      if (view.header !== null && toolsHit) {
        tail.push(toolsGroupRow(view.header))
        tokens += breakdown.tools
      }
      if (sys !== null && sysHit) {
        tail.push(systemRow(sys))
        tokens += breakdown.system
      }
      const keys = new Map<string, number>()
      for (let i = 0; i < entries.length; i++) keys.set('n' + String(entries[i].r.n.seq), i)
      flatIndexRef.current = keys
      return { entries, tail, count: entries.length + tail.length, tokens }
    }
    const flatRowsModel = dna ? flatRows() : null
    const flat = flatRowsModel ?? { entries: [] as FlatEntry[], tail: [] as ReactElement[], count: 0, tokens: 0 }
    const flatGeometry = useRowGeometry(
      scrollRef,
      dna ? flat.entries.length : 0,
      '.lc-br-flat > [data-lc-key^="n"]',
      `${String(flat.entries.length)}|${rowQuery}|${openElem === null ? '' : 'open'}`,
      dna && openElem === null,
    )
    if (flatGeometry !== null) flatPitchRef.current = flatGeometry.pitch
    const flatRowsOn = dna && flatWide && flatGeometry !== null
    const flatWindow = useWindowedRows(scrollRef, flat.entries.length, flatGeometry, flatRowsOn)
    const flatToolbar = (): ReactElement => (
      <RowToolbar
        value={rowQuery}
        placeholder={t('browser.search.flat')}
        clearLabel={t('field.clear')}
        count={flat.count}
        tokens={flat.tokens}
        onChange={setRowQuery}
      />
    )

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

        {mapOn
          ? (
            <BrowserTreemap
              view={view}
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
              <div className="lc-br-flat">
                {flatWindow.topPad > 0 ? <div className="lc-row-pad" style={{ height: flatWindow.topPad }} aria-hidden="true" /> : null}
                {flat.entries.slice(flatWindow.from, flatWindow.to + 1).map(({ r, pos }) => messageRow(r, (
                  <>
                    {catChip(r.n.cat)}
                    <span className="lc-br-pos">#{fmt(pos)}</span>
                    {rowTagNode(r.tag, r.tagNames)}
                  </>
                ), (over) => { setRowDnaKey(over ? 'n' + String(r.n.seq) : null) }))}
                {flatWindow.bottomPad > 0
                  ? <div className="lc-row-pad" style={{ height: flatWindow.bottomPad }} aria-hidden="true" />
                  : null}
                {flat.tail}
                {flat.count === 0 ? <div className="lc-br-note">{t('browser.rowNoMatch')}</div> : null}
              </div>
            )
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
                        /* v8 ignore start */
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
