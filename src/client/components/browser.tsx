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
import type { Category, ContextHeaders, ContextTimeline, HeaderTool, RequestRecord, SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import { CATS, partsOf } from '../categories'
import { React } from '../react'
import type { ConversationNodeLike, UseSessionLike } from '../services'
import type { ViewKit } from '../viewkit'
import { makeNodeText } from './nodes'
import { imageRefOf, makeImageCard } from './images'
import type { ImageKit } from './images'
import { makeRichText } from './richText'
import type { RichKit, RichMode } from './richText'
import type { StackedBarProps } from './stackedBar'
import type { ImageLoader, ImageRefLike } from '../services'

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
  /**
   * Overview tool-chip bridge: a click on the overview card's "工具定义 Top"
   * label (`tool` omitted) or one of its chips (`tool: name`) asks this
   * browser to reveal that section. A one-shot request — it is applied once
   * (switch to the live surface, open the "tools" category, and when a
   * specific tool is named expand its row), then handed back through
   * `onToolFocusHandled` so the same chip can be clicked again.
   */
  toolFocus?: { tool?: string } | null
  /** Called once a one-shot `toolFocus` request has been applied; the parent clears it. */
  onToolFocusHandled?: () => void
  /**
   * Session-authorized image URL loader (built by the Context view from the
   * harness conversation service). Absent = image cards render metadata only.
   */
  loadImage?: ImageLoader
}

/** The JSON Schema fragment describing one parameter's type, defensively narrowed. */
interface ParamSchema {
  type?: unknown
  description?: unknown
  // JSON Schema vocabulary used by tool inputs the browser needs to display
  // meaningfully: enum values (render as a comma-joined inline list), an
  // array's `items` (render the element type), and `anyOf`/`oneOf` (render
  // the alternation as a `/`-joined list). Anything else falls back to a
  // plain `type` string or `object` if absent.
  enum?: unknown
  items?: unknown
  anyOf?: unknown
  oneOf?: unknown
}

/** Flatten the `anyOf` / `oneOf` alternation into one displayable string. */
function unionTypesOf(p: ParamSchema): string | null {
  const branches: unknown[] = []
  if (Array.isArray(p.anyOf)) branches.push(...p.anyOf as unknown[])
  if (Array.isArray(p.oneOf)) branches.push(...p.oneOf as unknown[])
  if (branches.length === 0) return null
  const parts: string[] = []
  for (const b of branches) {
    if (b !== null && typeof b === 'object') parts.push(typeOf(b))
  }
  return parts.length > 0 ? parts.join(' | ') : null
}

/**
 * Derive a short, human-readable type label from a JSON Schema fragment.
 * Arrays show their element type (`array<number>`); unions fold into
 * `a | b`; enums collapse into `(enum)`. Returns `unknown` when the schema
 * carries no usable signal — the row falls back to its description then.
 */
function typeOf(p: ParamSchema): string {
  const u = unionTypesOf(p)
  if (u !== null) return u
  const t = p.type
  if (t === 'array') {
    const items = p.items
    if (items !== null && typeof items === 'object') {
      const inner = typeOf(items)
      return 'array<' + inner + '>'
    }
    return 'array'
  }
  if (typeof t === 'string') {
    if (t === 'object') {
      const props = (p as { properties?: unknown }).properties
      if (props !== null && typeof props === 'object' && Object.keys(props).length > 0) {
        return `object{${Object.keys(props).length}}`
      }
    }
    if (Array.isArray(p.enum) && p.enum.length > 0) {
      return t + ' (enum)'
    }
    return t
  }
  if (Array.isArray(p.enum) && p.enum.length > 0) return '(enum)'
  return 'unknown'
}

/**
 * Locate the parameter-bearing object inside a raw tool schema. Producers
 * may nest it under `parameters`, `input_schema`, `inputSchema`, or hand
 * the schema as the bare JSON Schema (when `type === 'object'`).
 */
function paramsOf(schema: unknown): ParamSchema | null {
  if (schema === null || typeof schema !== 'object') return null
  const s = schema as Record<string, unknown>
  const candidate = (v: unknown): ParamSchema | null =>
    v !== null && typeof v === 'object' ? v : null
  const nested = candidate(s.parameters) ?? candidate(s.input_schema)
    ?? candidate(s.inputSchema)
  if (nested !== null) return nested
  // Bare JSON Schema: a `{ type: 'object', properties: {...} }` at the root
  // is itself the parameter object — no inner wrapper.
  if (s.type === 'object' && s.properties !== undefined && typeof s.properties === 'object') {
    return s
  }
  return null
}

/**
 * One row of the parsed parameter table — name (mono-styled, with a
 * required chip), short type label, and the description on its own line
 * (so a long blurb never breaks the name/type rhythm).
 */
function ParamRow(props: {
  name: string
  schema: ParamSchema
  required: boolean
}): ReactNS.ReactElement {
  const typeLabel = typeOf(props.schema)
  const desc = props.schema.description
  return (
    <div className="lc-ts-param-row">
      <span className="lc-ts-param-name">{props.name}</span>
      <span className="lc-ts-param-type">{typeLabel}</span>
      <span className={props.required ? 'lc-ts-param-req' : 'lc-ts-param-req-off'}>
        {props.required ? '✓' : '·'}
      </span>
      {typeof desc === 'string' && desc !== ''
        ? <span className="lc-ts-param-desc">{desc}</span>
        : null}
    </div>
  )
}

/**
 * The full body of one expanded tool row: description, a parsed parameter
 * table (when the schema carries one), and the raw JSON behind a toggle.
 * Owns its own open/closed state for the JSON so two expanded tools stay
 * independent. The description card carries the shared raw/markdown view
 * toggle in its head (per-card state via `rich.useRichMode`).
 */
function ToolSchema(props: {
  description: string | undefined
  schema: unknown
  /** Rich-text toggle kit (description card: raw <pre> vs markdown). */
  rich: RichKit
  /** Localized labels for the card titles, empty-state line, and toggle. */
  labels: {
    desc: string
    title: string
    empty: string
    show: string
    hide: string
  }
}): ReactNS.ReactElement {
  const { rich } = props
  const [jsonOpen, setJsonOpen] = React.useState(false)
  const [descMode, setDescMode] = rich.useRichMode()
  const params = React.useMemo(() => paramsOf(props.schema), [props.schema])
  // Pull `properties` + `required` out of the parameter object as plain
  // values (avoids re-deriving the same shape in every row).
  const rows = React.useMemo<{ name: string; schema: ParamSchema; required: boolean }[]>(() => {
    if (params === null) return []
    const props = (params as { properties?: unknown }).properties
    if (props === null || typeof props !== 'object') return []
    const req = Array.isArray((params as { required?: unknown }).required)
      ? new Set(((params as { required: unknown[] }).required)
        .filter((x): x is string => typeof x === 'string'))
      : new Set<string>()
    const out: { name: string; schema: ParamSchema; required: boolean }[] = []
    for (const k of Object.keys(props)) {
      const v = (props as Record<string, unknown>)[k]
      if (v === null || typeof v !== 'object') continue
      out.push({ name: k, schema: v, required: req.has(k) })
    }
    return out
  }, [params])
  const schemaJson = React.useMemo(
    () => props.schema !== undefined ? JSON.stringify(props.schema, null, 2) : '',
    [props.schema],
  )
  return (
    <>
      {props.description !== undefined ? (
        <div className="lc-ts-card">
          <div className="lc-ts-card-head">
            <b>{props.labels.desc}</b>
            <rich.RichSwitch mode={descMode} onPick={setDescMode} inHead />
          </div>
          <rich.RichText
            text={props.description}
            mode={descMode}
            rawClass="lc-ts-desc-body"
            mdClass="lc-ts-desc-md"
          />
        </div>
      ) : null}
      {params !== null && rows.length > 0 ? (
        <div className="lc-ts-card">
          <div className="lc-ts-card-head">
            <b>{props.labels.title}</b>
            <span className="lc-ts-card-count">{rows.length}</span>
          </div>
          {rows.map(r => <ParamRow key={r.name} name={r.name} schema={r.schema} required={r.required} />)}
        </div>
      ) : params !== null ? (
        <div className="lc-ts-params-empty">{props.labels.empty}</div>
      ) : null}
      {schemaJson !== '' ? (
        <div className="lc-ts-json">
          <button
            type="button"
            className="lc-ts-json-toggle"
            onClick={() => { setJsonOpen(o => !o) }}
          >{(jsonOpen ? '▾ ' : '▸ ') + (jsonOpen ? props.labels.hide : props.labels.show)}</button>
          {jsonOpen ? <pre className="lc-br-pre lc-br-dim">{schemaJson}</pre> : null}
        </div>
      ) : null}
    </>
  )
}

/** One raw content block (text/reasoning/tool-result/image/…), rendered defensively. */
function RawBlocks(props: { blocks: readonly unknown[]; mode: RichMode; rich: RichKit; img: ImageKit }): ReactNS.ReactElement {
  const { rich, img } = props
  return (
    <>
      {props.blocks.map((b, i) => {
        const blk = b !== null && typeof b === 'object' ? b as { type?: string; text?: unknown; content?: unknown } : null
        if (blk !== null
          && (blk.type === 'text' || blk.type === 'reasoning') && typeof blk.text === 'string') {
          // Reasoning stays raw in either mode (plain model trace, not
          // prose); text blocks follow the card's view mode.
          if (blk.type === 'reasoning') {
            return <pre key={i} className="lc-br-pre lc-br-dim">{blk.text}</pre>
          }
          return <rich.RichText key={i} text={blk.text} mode={props.mode} />
        }
        const image = imageRefOf(b)
        if (image !== null) return <img.Card key={i} attachment={image} load={img.load} />
        if (blk !== null && blk.type === 'tool-result' && Array.isArray(blk.content)) {
          return <RawBlocks key={i} blocks={blk.content as unknown[]} mode={props.mode} rich={rich} img={img} />
        }
        return <pre key={i} className="lc-br-pre lc-br-dim">{JSON.stringify(b, null, 2)}</pre>
      })}
    </>
  )
}

/**
 * One assistant-message block (thinking / answer) as its own card: the
 * title row carries the block label plus the block's OWN raw/markdown
 * switch (per-card state via `rich.useRichMode`, mirroring the tool
 * description card), so a mixed reply's parts toggle independently.
 */
function BlockCard(props: { label: string; text: string; rich: RichKit }): ReactNS.ReactElement {
  const { rich } = props
  const [mode, setMode] = rich.useRichMode()
  return (
    <div className="lc-ts-card">
      <div className="lc-ts-card-head">
        <b>{props.label}</b>
        <rich.RichSwitch mode={mode} onPick={setMode} inHead />
      </div>
      <rich.RichText
        text={props.text}
        mode={mode}
        rawClass="lc-ts-desc-body"
        mdClass="lc-ts-desc-md"
      />
    </div>
  )
}

/**
 * One tool call as its own card, mirroring the tool-definition parameter
 * card: the head names the call target (with the parsed argument count),
 * the body lists the arguments as name/value rows. Arguments that are not
 * a parseable JSON object fall back to the raw payload inside the same
 * card. Shared by assistant tool-call blocks (`→`) and the call half of a
 * tool result (`←`).
 */
function ToolCallCard(props: { name: string; argsRaw: unknown; arrow?: string }): ReactNS.ReactElement {
  const args = React.useMemo<Record<string, unknown> | null>(() => {
    if (typeof props.argsRaw !== 'string' || props.argsRaw === '') return null
    try {
      const parsed: unknown = JSON.parse(props.argsRaw)
      return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null
    } catch {
      return null
    }
  }, [props.argsRaw])
  return (
    <div className="lc-ts-card">
      <div className="lc-ts-card-head">
        <b className="lc-ts-call-name">{(props.arrow ?? '→') + ' ' + props.name}</b>
        {args !== null ? <span className="lc-ts-card-count">{Object.keys(args).length}</span> : null}
      </div>
      {args !== null
        ? Object.keys(args).map(k => <CallArgRow key={k} name={k} value={args[k]} />)
        : typeof props.argsRaw === 'string' && props.argsRaw !== ''
          ? <pre className="lc-br-pre lc-br-dim">{props.argsRaw}</pre>
          : null}
    </div>
  )
}

/** One parsed call argument: the name on the left, the value on the right. */
function CallArgRow(props: { name: string; value: unknown }): ReactNS.ReactElement {
  const v = props.value
  const text = typeof v === 'string' ? v
    : v === undefined ? ''
      : JSON.stringify(v)
  return (
    <div className="lc-ts-arg-row">
      <span className="lc-ts-param-name">{props.name}</span>
      <span className="lc-ts-arg-val">{text}</span>
    </div>
  )
}

/** The actual content of one surface element, joined from the conversation snapshot. */
function NodeContent(props: {
  node: SurfaceNode
  conv: ConversationNodeLike | undefined
  hint: string
  rich: RichKit
  img: ImageKit
  labels: { thinking: string; answer: string; images: string; other: string }
}): ReactNS.ReactElement {
  const { node, conv, rich, img } = props
  // The raw/markdown toggle serves the prose bodies (user / injection text,
  // compaction summaries); assistant thinking/answer blocks each carry
  // their own per-card switch (BlockCard); tool results stay raw
  // (structured payload, not prose).
  const richable = node.cat === 'user' || node.cat === 'assistant' || node.cat === 'inject'
  const wrap = (render: (mode: RichMode) => ReactNS.ReactNode): ReactNS.ReactElement =>
    richable
      ? <rich.RichCard render={render} />
      : <div className="lc-br-content">{render('raw')}</div>

  if (conv === undefined) {
    if (node.text === undefined || node.text === '') {
      return <div className="lc-br-content"><div className="lc-br-note">{props.hint}</div></div>
    }
    return wrap(mode => (
      <>
        <rich.RichText text={node.text ?? ''} mode={mode} />
        <div className="lc-br-note">{props.hint}</div>
      </>
    ))
  }
  if (conv.kind === 'assistant' && Array.isArray(conv.blocks)) {
    // Thinking, answer, and tool-call blocks render as SEPARATE cards (the
    // prose cards own a raw/markdown switch, the call card parses its
    // arguments into rows); images keep their raw form.
    return (
      <div className="lc-br-content">
        {conv.blocks.map((b, i) => {
          const blk = b as { kind?: string; text?: unknown; name?: string; argsRaw?: unknown }
          if (blk.kind === 'text' && typeof blk.text === 'string') {
            return <BlockCard key={i} label={props.labels.answer} text={blk.text} rich={rich} />
          }
          if (blk.kind === 'reasoning' && typeof blk.text === 'string') {
            return <BlockCard key={i} label={props.labels.thinking} text={blk.text} rich={rich} />
          }
          if (blk.kind === 'tool-call') {
            return <ToolCallCard key={i} name={blk.name ?? '?'} argsRaw={blk.argsRaw} />
          }
          const image = imageRefOf(b)
          if (image !== null) return <img.Card key={i} attachment={image} load={img.load} />
          return null
        })}
      </div>
    )
  }
  if (conv.kind === 'tool-result') {
    return (
      <div className="lc-br-content">
        {conv.call != null
          ? <ToolCallCard arrow="←" name={conv.call.name} argsRaw={conv.call.argsRaw} />
          : null}
        {Array.isArray(conv.content) ? <RawBlocks blocks={conv.content} mode="raw" rich={rich} img={img} /> : null}
      </div>
    )
  }
  if (conv.kind === 'compaction') {
    return wrap(mode => (
      <>
        {typeof conv.summary === 'string' && conv.summary !== ''
          ? <rich.RichText text={conv.summary} mode={mode} />
          : null}
      </>
    ))
  }
  if (Array.isArray(conv.content)) {
    const blocks = conv.content as unknown[]
    // User messages get the card layout: prose in the toggle-served text
    // card, durable image refs as attachment cards (thumbnail + name + dims
    // + size), and anything else as a raw JSON card. A text-only message
    // renders exactly as before — one rich card and nothing else.
    if (node.cat !== 'user') {
      return wrap(mode => <RawBlocks blocks={blocks} mode={mode} rich={rich} img={img} />)
    }
    const texts: string[] = []
    const images: ImageRefLike[] = []
    const others: unknown[] = []
    for (const b of blocks) {
      const blk = b as { type?: string; text?: unknown } | null
      if (blk !== null && typeof blk === 'object' && blk.type === 'text' && typeof blk.text === 'string') {
        texts.push(blk.text)
        continue
      }
      const image = imageRefOf(b)
      if (image !== null) { images.push(image); continue }
      others.push(b)
    }
    return (
      <div className="lc-br-content">
        {texts.length > 0 ? (
          // Un-padded RichCard: the outer lc-br-content already owns the
          // body indent, so the text card aligns with the attachment cards
          // instead of sitting one indent deeper.
          <rich.RichCard className="lc-br-rich-inline" render={mode => (
            <>
              {texts.map((text, i) => <rich.RichText key={i} text={text} mode={mode} />)}
            </>
          )} />
        ) : null}
        {images.length > 0 ? (
          <div className="lc-ts-card">
            <div className="lc-ts-card-head">
              <b>{props.labels.images}</b>
              <span className="lc-ts-card-count">{images.length}</span>
            </div>
            <div className="lc-att-grid">
              {images.map((a, i) => <img.Card key={`${a.attachmentId}:${i}`} attachment={a} load={img.load} />)}
            </div>
          </div>
        ) : null}
        {others.length > 0 ? (
          <div className="lc-ts-card">
            <div className="lc-ts-card-head">
              <b>{props.labels.other}</b>
              <span className="lc-ts-card-count">{others.length}</span>
            </div>
            {others.map((b, i) => <pre key={i} className="lc-br-pre lc-br-dim">{JSON.stringify(b, null, 2)}</pre>)}
          </div>
        ) : null}
      </div>
    )
  }
  return <div className="lc-br-content"><div className="lc-br-note">{props.hint}</div></div>
}

/** Group an assembled surface's nodes by category (for per-category counts). */
function byCatOf(asm: Assembled): Partial<Record<Category, SurfaceNode[]>> {
  const m: Partial<Record<Category, SurfaceNode[]>> = {}
  for (const n of asm.nodes) (m[n.cat] ??= []).push(n)
  return m
}

/** Count one category's elements in an assembled surface (header cats included). */
function countOf(asm: Assembled, c: string): number {
  if (c === 'system') return asm.header !== null && asm.header.system !== undefined ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCatOf(asm)[c as Category]?.length ?? 0
}

/** The last request of `turn` in a seq-ordered timeline, or null. */
function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

export function makeContextBrowser(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
): (props: ContextBrowserProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, catLabel } = kit
  const nodeText = makeNodeText(kit)
  const rich = makeRichText(kit)
  const ImageCard = makeImageCard(kit)
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
    // Overview tool-link bridge: apply a one-shot request (switch to the LIVE
    // surface — the overview's Top chips rank the current header's tools —
    // open the tools category, expand the clicked tool), then hand it back so
    // the parent can issue the same focus again on the next click.
    const toolFocus = props.toolFocus
    React.useEffect(() => {
      if (toolFocus === null || toolFocus === undefined) return
      setSel('live')
      setOpenCat('tools')
      setOpenElem(toolFocus.tool !== undefined ? 'tool:' + toolFocus.tool : null)
      if (props.onToolFocusHandled !== undefined) props.onToolFocusHandled()
    }, [toolFocus, props.onToolFocusHandled])
    const awaiting = missingSeq !== null && !exhausted && loadOlderHistory !== undefined && hasMore

    const requests = data.requests
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

    // δ baselines against the PREVIOUS TURN's last request — one stable unit
    // whatever step (or live surface) is shown: a step of turn T reads
    // against turn T−1's final step, avoiding the misleading "change" a
    // same-turn neighbour would imply. Live refers to the most recent
    // request, itself a turn's last step.
    const refReq = req === null
      ? requests.length > 0 ? requests[requests.length - 1] : null
      : lastOfTurn(requests, (req.turn ?? 0) - 1)
    const prevView = refReq !== null ? assemble(data, headers, refReq.seq) : null

    const byCat = byCatOf(view)

    const toolCount = (c: string): number => countOf(view, c)

    const toggleCat = (c: string) => {
      // Empty categories stay shut — EXCEPT system/tools with a missing
      // header epoch: those open to explain the degradation note.
      const openable = toolCount(c) > 0
        || ((c === 'system' || c === 'tools') && view.header === null)
      if (!openable) return
      setOpenCat(openCat === c ? null : c)
      setOpenElem(null)
    }
    const toggleElem = (key: string) => { setOpenElem(openElem === key ? null : key) }

    /** One expandable element row (preview line; content when open). */
    const elemRow = (
      key: string, tag: string | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNS.ReactNode,
    ) => {
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
          <rich.RichCard render={mode => <rich.RichText text={system} mode={mode} />} />)
      }
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        // Schemas rank by token price (largest first), mirroring the overview's
        // "工具定义 Top" chips; the producer's header order is not meaningful.
        // Localized labels for the per-tool parameter table / JSON toggle:
        // passed in by the parent so the body component stays a pure function
        // of its props (testable in isolation, no closure over `t`).
        const labels = {
          desc: t('tool.desc'),
          title: t('tool.params'),
          empty: t('tool.paramsEmpty'),
          show: t('tool.jsonToggle'),
          hide: t('tool.jsonHide'),
        }
        return view.header.tools.slice().sort((a, b) => b.tokens - a.tokens).map((tool: HeaderTool) => {
          return elemRow('tool:' + tool.name, null, tool.name, tool.tokens, undefined,
            <div className="lc-br-content">
              <ToolSchema description={tool.description} schema={tool.schema} rich={rich} labels={labels} />
            </div>)
        })
      }
      // Surface-node categories carry per-element timestamps; list them
      // newest first, mirroring the NodeList card.
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      return nodes.map((n) => {
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
        return elemRow(`n${n.seq}`, tag, preview, n.tokens, n.time,
          <NodeContent
            node={n}
            conv={bySeq.get(n.seq)}
            rich={rich}
            img={{ Card: ImageCard, load: props.loadImage }}
            // Localized block/section titles (thinking / answer / image and
            // other-content cards), handed in by the parent so the body
            // stays a pure function of props.
            labels={{
              thinking: t('block.thinking'),
              answer: t('block.answer'),
              images: t('attach.images'),
              other: t('attach.other'),
            }}
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
          <span className="lc-card-title-text">{t('browser.title')}</span>
          <span className="lc-br-hint">{t('browser.deltaHint')}</span>
          <select
            className="lc-br-pick"
            value={seq === null ? 'live' : String(seq)}
            onChange={(e) => { pick(e.target.value) }}
          >
            <option value="live">{t('browser.live')}</option>
            {requests.slice().reverse().map(r => (
              <option key={r.seq} value={String(r.seq)}>
                {t('detail.step', { t: r.turn ?? 0, s: r.step ?? 0 }) + ' · ' + fmtTime(r.time)}
              </option>
            ))}
          </select>
        </div>

        <div className="lc-br-meta">
          <b>{req !== null
            ? t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
            : t('browser.liveNow')}</b>
          {req !== null ? <span>{fmtTime(req.time)}</span> : null}
          {hoverReq !== null ? <span className="lc-card-sub">{t('browser.preview')}</span> : null}
          <span>{t('detail.estTotal', { n: fmt(total) })}</span>
          {req !== null && req.prompt !== undefined
            ? <span className="lc-actual">{t('detail.actual', { n: fmt(req.prompt) })}</span>
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
          ? <div className="lc-br-note">{t('browser.missingLive', { n: view.missingLive })}</div>
          : null}
        {view.approximate
          ? <div className="lc-br-note">{t('browser.approx')}</div>
          : null}

        <div className="lc-br-cats">
          {CATS.map((c) => {
            const count = toolCount(c.key)
            const v = breakdown[c.key] || 0
            // Δ vs the reference step: element-count badge (hidden when the
            // count held), token swing in the badge's tooltip — the same two
            // figures the row already shows, over the deepest step in scope.
            const prevCount = prevView !== null ? countOf(prevView, c.key) : null
            const countDelta = prevCount !== null ? count - prevCount : null
            const prevTokens = refReq !== null ? (refReq[c.key] || 0) : null
            const tokenDelta = prevTokens !== null ? v - prevTokens : null
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
                  {/* Count + Δ pill sit as one attached group (tight inner gap),
                      the group absorbs the row's free space so tokens/percent
                      stay right-aligned. */}
                  <span className="lc-br-count-grp">
                    <span className="lc-br-cat-count">{t('browser.items', { n: count })}</span>
                    {countDelta !== null && countDelta !== 0 ? (
                      <span className={'lc-br-delta lc-br-delta-' + (countDelta > 0 ? 'up' : 'down')}>
                        {`${countDelta > 0 ? '+' : ''}${countDelta}`}
                      </span>
                    ) : null}
                  </span>
                  {/* Token Δ pill hugs the left of the token figure — its own
                      direction-colored pill, hidden while the count held. */}
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
