/**
 * ContextBrowser — the "Context 浏览器" card: pick the live surface or any
 * retained step and browse what the request was actually assembled from.
 *
 * Layout follows progressive disclosure instead of a flat dump:
 *   step picker + composition bar
 *     → six category sections (accordion: dot, label, element count, tokens)
 *       → element rows (one per message / prompt / tool schema)
 *         → the element's ACTUAL content, rendered per kind (text, reasoning,
 *           tool call + result, injection notice, system prompt, JSON schema).
 *
 * Data sources: the `contextTimeline` projection (structure + token prices,
 * per-step reconstruction via the removed-node archive), the `contextHeaders`
 * projection (full system prompt + tool schemas — absent on older hosts,
 * degrading those two sections to tokens-only), and the framework
 * conversation snapshot (full message content joined by event seq; nodes
 * outside the loaded window fall back to the 80-char preview with a note).
 */

import type * as ReactNS from 'react'
import type { Category, ContextHeaders, ContextTimeline, HeaderTool, SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import { CATS, partsOf } from '../categories'
import { React } from '../react'
import type { ConversationNodeLike, UseSessionLike } from '../services'
import type { ViewKit } from '../viewkit'
import { makeNodeText } from './nodes'
import type { StackedBarProps } from './stackedBar'

export interface ContextBrowserProps {
  data: ContextTimeline
  headers: ContextHeaders | null
  useSession?: UseSessionLike
  /** History-pagination verb contributed via `sessions.provide` (absent on older hosts). */
  loadOlderHistory?: () => Promise<void>
  /**
   * Trend-chart hover linkage: the seq of the bar under the pointer. While
   * set, the browser transiently previews that step; the picker's own
   * selection resumes when the pointer leaves the chart.
   */
  previewSeq?: number | null
  /**
   * Trend-chart pin linkage: the seq of the bar pinned by a click. The
   * browser's own step picker follows it — a pin selects that step, an
   * unpin (pinSeq back to null) returns the browser to the live surface.
   */
  pinSeq?: number | null
  /**
   * Current-composition hover link, shared with the Current Composition card
   * (its bar + legend): the active category key, reported via onHoverKey.
   * The browser joins the link ONLY while it shows the LIVE step — a pinned
   * or previewed step's composition differs, so its hover must not light the
   * overview (and the overview's hover must not highlight another step).
   */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

/** One raw content block (text/reasoning/tool-result/…), rendered defensively. */
function RawBlocks(props: { blocks: readonly unknown[] }): ReactNS.ReactElement {
  return (
    <>
      {props.blocks.map((b, i) => {
        const blk = b as { type?: string; text?: unknown; content?: unknown }
        if (blk !== null && typeof blk === 'object'
          && (blk.type === 'text' || blk.type === 'reasoning') && typeof blk.text === 'string') {
          return <pre key={i} className={'lc-br-pre' + (blk.type === 'reasoning' ? ' lc-br-dim' : '')}>{blk.text}</pre>
        }
        if (blk !== null && typeof blk === 'object' && blk.type === 'tool-result' && Array.isArray(blk.content)) {
          return <RawBlocks key={i} blocks={blk.content as unknown[]} />
        }
        return <pre key={i} className="lc-br-pre lc-br-dim">{JSON.stringify(b, null, 2)}</pre>
      })}
    </>
  )
}

/** The actual content of one surface element, joined from the conversation snapshot. */
function NodeContent(props: { node: SurfaceNode; conv: ConversationNodeLike | undefined; hint: string }): ReactNS.ReactElement {
  const { node, conv } = props
  if (conv === undefined) {
    return (
      <div className="lc-br-content">
        {node.text !== undefined && node.text !== '' ? <pre className="lc-br-pre">{node.text}</pre> : null}
        <div className="lc-br-note">{props.hint}</div>
      </div>
    )
  }
  if (conv.kind === 'assistant' && Array.isArray(conv.blocks)) {
    return (
      <div className="lc-br-content">
        {conv.blocks.map((b, i) => {
          const blk = b as { kind?: string; text?: unknown; name?: unknown; argsRaw?: unknown }
          if (blk.kind === 'text' && typeof blk.text === 'string') {
            return <pre key={i} className="lc-br-pre">{blk.text}</pre>
          }
          if (blk.kind === 'reasoning' && typeof blk.text === 'string') {
            return <pre key={i} className="lc-br-pre lc-br-dim">{blk.text}</pre>
          }
          if (blk.kind === 'tool-call') {
            return (
              <div key={i} className="lc-br-call">
                <span className="lc-br-tag">{'→ ' + String(blk.name ?? '?')}</span>
                {typeof blk.argsRaw === 'string' && blk.argsRaw !== ''
                  ? <pre className="lc-br-pre lc-br-dim">{blk.argsRaw}</pre>
                  : null}
              </div>
            )
          }
          return null
        })}
      </div>
    )
  }
  if (conv.kind === 'tool-result') {
    return (
      <div className="lc-br-content">
        {conv.call != null
          ? (
            <div className="lc-br-call">
              <span className="lc-br-tag">{'← ' + conv.call.name}</span>
              {conv.call.argsRaw !== '' ? <pre className="lc-br-pre lc-br-dim">{conv.call.argsRaw}</pre> : null}
            </div>
          )
          : null}
        {Array.isArray(conv.content) ? <RawBlocks blocks={conv.content} /> : null}
      </div>
    )
  }
  if (conv.kind === 'compaction') {
    return (
      <div className="lc-br-content">
        {typeof conv.summary === 'string' && conv.summary !== ''
          ? <pre className="lc-br-pre">{conv.summary}</pre>
          : null}
      </div>
    )
  }
  if (Array.isArray(conv.content)) {
    return <div className="lc-br-content"><RawBlocks blocks={conv.content} /></div>
  }
  return <div className="lc-br-content"><div className="lc-br-note">{props.hint}</div></div>
}

export function makeContextBrowser(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
): (props: ContextBrowserProps) => ReactNS.ReactElement {
  const { t, tr, fmt, fmtTime, catLabel } = kit
  const nodeText = makeNodeText(kit)
  const catColor: Record<string, string> = {}
  for (const c of CATS) catColor[c.key] = c.color

  // Auto-load ceiling: one expand pulls older pages (50 events each) until
  // the element's seq enters the window, history runs out, or this cap is
  // hit — a guard against seqs that never land in the conversation snapshot.
  const MAX_AUTO_PAGES = 20

  return function ContextBrowser(props: ContextBrowserProps): ReactNS.ReactElement {
    const { data, headers } = props
    // 'live' = the current surface (the NEXT request's context); a number =
    // the seq of a retained request record (a past step).
    const [sel, setSel] = React.useState<'live' | number>('live')
    const [openCat, setOpenCat] = React.useState<string | null>(null)
    const [openElem, setOpenElem] = React.useState<string | null>(null)

    // Full message content, joined from the conversation snapshot by the
    // surface event seq. `s.nodes` is a stable reference per snapshot; the
    // seq map is memoized over it.
    const convNodes = typeof props.useSession === 'function'
      ? props.useSession(s => s.nodes)
      : undefined
    const bySeq = React.useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    // Window state for on-demand history pagination (primitive selectors, so
    // the component re-renders only when a page actually lands or runs out).
    const hasMore = typeof props.useSession === 'function'
      ? props.useSession(s => s.hasMore === true)
      : false
    const loadingOlder = typeof props.useSession === 'function'
      ? props.useSession(s => s.loadingOlder === true)
      : false

    // The open element's surface-node seq ('sys'/'tool:*' keys never join).
    const openSeq = openElem !== null && openElem.startsWith('n')
      ? Number(openElem.slice(1))
      : null
    const missingSeq = openSeq !== null && !bySeq.has(openSeq) ? openSeq : null
    // Auto-load: expanding an out-of-window element pages older history in
    // until its seq joins (one page in flight, sequenced by the snapshot's
    // own loadingOlder flag). `exhausted` latches the cap/history-end so the
    // hint falls back to the static note instead of "loading" forever.
    const [exhausted, setExhausted] = React.useState(false)
    const pagesRef = React.useRef(0)
    React.useEffect(() => {
      pagesRef.current = 0
      setExhausted(false)
    }, [openElem])
    const loadOlderHistory = props.loadOlderHistory
    React.useEffect(() => {
      if (missingSeq === null || !hasMore || loadingOlder || exhausted) return
      if (loadOlderHistory === undefined) return
      if (pagesRef.current >= MAX_AUTO_PAGES) {
        setExhausted(true)
        return
      }
      pagesRef.current += 1
      void loadOlderHistory()
    }, [missingSeq, hasMore, loadingOlder, exhausted, bySeq, loadOlderHistory])
    React.useEffect(() => {
      // History ran out with the seq still missing: stop showing "loading".
      if (!hasMore && missingSeq !== null && !exhausted) setExhausted(true)
    }, [hasMore, missingSeq, exhausted])
    // History-chart pin linkage: a pinned bar selects its step in the picker,
    // an unpin returns to live — the same accordion reset a manual pick
    // performs. (Live is also the right target while unpinned: a manual pick
    // made here is overridden only when a NEW pin lands.)
    const pinSeq = props.pinSeq
    React.useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setOpenCat(null)
      setOpenElem(null)
    }, [pinSeq])
    const awaiting = missingSeq !== null && !exhausted && loadOlderHistory !== undefined && hasMore

    const requests = data.requests || []
    // Trend-chart hover linkage: the bar under the pointer transiently
    // previews its step (unknown seq = trimmed out of retention, ignored);
    // the picker's own selection resumes when the pointer leaves the chart.
    const hoverReq = props.previewSeq !== null && props.previewSeq !== undefined
      ? requests.find(r => r.seq === props.previewSeq) ?? null
      : null
    const req = hoverReq ?? (sel === 'live' ? null : requests.find(r => r.seq === sel) ?? null)
    // A pinned step trimmed out of retention falls back to live.
    const seq = req !== null ? req.seq : null
    // Current-composition hover link: the browser joins the Current
    // Composition card's shared hover only while it shows the LIVE step —
    // a pinned/previewed step has a different composition, so its hover must
    // not light the overview (and the overview's hover must not highlight
    // this step's parts). The mirror filter drops the overview's FREE-track
    // key, which has no segment in the browser's bar.
    const linked = req === null && props.onHoverKey !== undefined
    const linkKey = linked && props.hoverKey !== null && props.hoverKey !== 'free'
      ? props.hoverKey
      : null
    const view = assemble(data, headers, seq)
    const breakdown = req !== null ? req : data.current
    const parts = partsOf(breakdown)
    const total = breakdown.total
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setOpenCat(null)
      setOpenElem(null)
    }

    const byCat: Partial<Record<Category, SurfaceNode[]>> = {}
    for (const n of view.nodes) (byCat[n.cat] ??= []).push(n)

    const toolCount = (c: string): number => {
      if (c === 'system') return view.header !== null && view.header.system !== undefined ? 1 : 0
      if (c === 'tools') return view.header !== null ? view.header.tools.length : 0
      return byCat[c as Category]?.length ?? 0
    }

    const toggleCat = (c: string) => {
      // Empty categories stay shut — EXCEPT system/tools with a missing
      // header epoch: those open to explain the degradation note.
      const openable = toolCount(c) > 0
        || ((c === 'system' || c === 'tools') && view.header === null)
      if (!openable) return
      setOpenCat(openCat === c ? null : c)
      setOpenElem(null)
    }
    const toggleElem = (key: string) => setOpenElem(openElem === key ? null : key)

    /** One expandable element row (preview line; content when open). */
    const elemRow = (key: string, tag: string | null, preview: string, tokens: number, time: number | undefined, body: ReactNS.ReactNode) => {
      const open = openElem === key
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '')}>
          <button type="button" className="lc-br-elem-row" onClick={() => { toggleElem(key) }}>
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')}>{'▸'}</span>
            {tag !== null ? <span className="lc-br-tag">{tag}</span> : null}
            <span className="lc-br-preview">{preview}</span>
            {time !== undefined ? <span className="lc-br-time">{fmtTime(time)}</span> : null}
            <span className="lc-br-tokens">{'≈' + fmt(tokens)}</span>
          </button>
          {open ? body : null}
        </div>
      )
    }

    const catBody = (c: string): ReactNS.ReactNode => {
      if (c === 'system') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        const system = view.header.system
        if (system === undefined) return null
        return elemRow('sys', null, system.replace(/\s+/g, ' ').trim().slice(0, 80), breakdown.system, undefined,
          <div className="lc-br-content"><pre className="lc-br-pre">{system}</pre></div>)
      }
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        return view.header.tools.map((tool: HeaderTool) => {
          const schema = tool.schema !== undefined ? JSON.stringify(tool.schema, null, 2) : ''
          return elemRow('tool:' + tool.name, null, tool.name, tool.tokens, undefined,
            <div className="lc-br-content">
              {tool.description !== undefined ? <pre className="lc-br-pre">{tool.description}</pre> : null}
              {schema !== '' ? <pre className="lc-br-pre lc-br-dim">{schema}</pre> : null}
            </div>)
        })
      }
      const nodes = byCat[c as Category] ?? []
      return nodes.map(n => {
        // Tag/preview split: the compact chip carries the compact fact (tool
        // name, injection form), the preview line carries the text — each
        // fact shown once. Skill/calls previews already name themselves.
        let tag: string | null = null
        let preview = nodeText(n)
        if (n.cat === 'tool') {
          tag = (n.tool ?? '?') + (n.err ? ' ⚠' : '')
          preview = t('node.toolResult') + (n.err ? ' ⚠' : '')
        } else if (n.cat === 'inject' && !n.skill) {
          tag = t('form.' + (n.form || 'context'))
          if (n.text !== undefined && n.text !== '') {
            preview = n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
          }
        }
        return elemRow('n' + n.seq, tag, preview, n.tokens, n.time,
          <NodeContent
            node={n}
            conv={bySeq.get(n.seq)}
            // This row's body renders only while it is the open element, so
            // `awaiting` (open seq missing, pagination armed) means THIS join
            // is the one pages are being pulled for.
            hint={bySeq.get(n.seq) === undefined && awaiting
              ? t('browser.loading')
              : t('browser.noContent')}
          />)
      })
    }

    return (
      <div className="lc-card">
        <div className="lc-card-title">
          {t('browser.title')}
          <select
            className="lc-br-pick"
            value={seq === null ? 'live' : String(seq)}
            onChange={e => { pick(e.target.value) }}
          >
            <option value="live">{t('browser.live')}</option>
            {requests.slice().reverse().map(r => (
              <option key={r.seq} value={String(r.seq)}>
                {tr('detail.step', { t: r.turn ?? 0, s: r.step ?? 0 }) + ' · ' + fmtTime(r.time)}
              </option>
            ))}
          </select>
        </div>

        <div className="lc-br-meta">
          <b>{req !== null
            ? tr('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
            : t('browser.liveNow')}</b>
          {req !== null ? <span>{fmtTime(req.time)}</span> : null}
          {hoverReq !== null ? <span className="lc-card-sub">{t('browser.preview')}</span> : null}
          <span>{tr('detail.estTotal', { n: fmt(total) })}</span>
          {req !== null && req.prompt !== undefined
            ? <span className="lc-actual">{tr('detail.actual', { n: fmt(req.prompt) })}</span>
            : null}
        </div>

        <div className="lc-br-bar">
          <StackedBar
            parts={parts}
            height={10}
            // Mirrored hover link (see `linked` above): while the browser
            // shows the live surface, its bar highlights the shared category
            // key and reports its own hovers back to the Current Composition
            // card. The tip stays off — a cross-card hover must not float a
            // second tooltip over a bar the pointer does not rest on.
            hoverKey={linked ? linkKey : undefined}
            onHoverKey={linked ? props.onHoverKey : undefined}
            tip={false}
          />
        </div>

        {view.missingLive > 0
          ? <div className="lc-br-note">{tr('browser.missingLive', { n: view.missingLive })}</div>
          : null}
        {view.approximate
          ? <div className="lc-br-note">{t('browser.approx')}</div>
          : null}

        <div className="lc-br-cats">
          {CATS.map(c => {
            const count = toolCount(c.key)
            const v = breakdown[c.key] || 0
            const openable = count > 0
              || ((c.key === 'system' || c.key === 'tools') && view.header === null)
            const open = openCat === c.key && openable
            return (
              <div key={c.key} className={'lc-br-cat' + (openable ? '' : ' lc-br-cat-empty')}>
                <button
                  type="button"
                  className={'lc-br-cat-row' + (linked && props.hoverKey === c.key ? ' lc-br-cat-on' : '')}
                  onMouseEnter={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(c.key) } : undefined}
                  onMouseLeave={linked ? () => { if (props.onHoverKey !== undefined) props.onHoverKey(null) } : undefined}
                  onClick={() => { toggleCat(c.key) }}
                >
                  <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')}>{'▸'}</span>
                  <i style={{ background: c.color }} />
                  <span className="lc-br-cat-label">{catLabel(c.key)}</span>
                  <span className="lc-br-cat-count">{tr('browser.items', { n: count })}</span>
                  <span className="lc-br-tokens">{'≈' + fmt(v)}</span>
                  <span className="lc-br-pct">{total > 0 ? Math.round(v / total * 100) + '%' : ''}</span>
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
