/**
 * ContextBrowser — the "Context 浏览器" card: pick the live surface or any
 * retained step and browse what the request was actually assembled from.
 *
 * Layout follows progressive disclosure instead of a flat dump:
 *   step picker + composition bar
 *     → six category sections (accordion: dot, label, element count, tokens)
 *       → element rows (one per message / prompt / tool schema)
 *         → the element's ACTUAL content as a uniform stack of SECTION cards
 *           (Section: labeled head + body) — prose, tool calls, parameter
 *           rows, image grids, and raw JSON all share that one frame.
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
import type { RichKit } from './richText'
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
 * Section — the ONE detail chrome of the Context browser: a labeled card
 * (`lc-ts-card`) whose head carries the section title on the left and the
 * extras on the right (a count badge and/or the Raw/MD switch), with the
 * body below. Every expanded element renders as a stack of these — prose,
 * tool calls, parameter rows, image grids, and raw JSON all share the same
 * frame, so the reader scans one repeating anatomy instead of a different
 * layout per content kind.
 */
function Section(props: {
  label: string
  /** Head class for identifier-style titles (tool-call names: mono, larger). */
  labelClass?: string
  /** Count badge at the head's right edge (omitted when undefined). */
  count?: number
  /** Head actions (the Raw/MD switch), between the title and the count. */
  actions?: ReactNS.ReactNode
  children: ReactNS.ReactNode
}): ReactNS.ReactElement {
  return (
    <div className="lc-ts-card">
      <div className="lc-ts-card-head">
        <b className={props.labelClass}>{props.label}</b>
        {props.actions ?? null}
        {props.count !== undefined ? <span className="lc-ts-card-count">{props.count}</span> : null}
      </div>
      {props.children}
    </div>
  )
}

/**
 * TextSection — a prose Section (system prompt, message/injection/summary
 * body, thinking, answer, tool description): the head's right edge carries
 * the Raw/MD switch and the body follows the per-card mode.
 */
function TextSection(props: { label: string; text: string; rich: RichKit }): ReactNS.ReactElement {
  const { rich } = props
  const [mode, setMode] = rich.useRichMode()
  return (
    <Section label={props.label} actions={<rich.RichSwitch mode={mode} onPick={setMode} />}>
      <rich.RichText text={props.text} mode={mode} />
    </Section>
  )
}

/** RawSection — a dimmed text Section without a view switch (structured payloads: tool results, raw JSON). */
function RawSection(props: { label: string; text: string }): ReactNS.ReactElement {
  return (
    <Section label={props.label}>
      <pre className="lc-ts-desc-body lc-br-dim">{props.text}</pre>
    </Section>
  )
}

/**
 * The full body of one expanded tool row: description, a parsed parameter
 * table (when the schema carries one), and the raw JSON behind a toggle.
 * Owns its own open/closed state for the JSON so two expanded tools stay
 * independent.
 */
function ToolSchema(props: {
  description: string | undefined
  schema: unknown
  /** Rich-text toggle kit (description section: raw <pre> vs markdown). */
  rich: RichKit
  /** Localized labels for the section titles, empty-state line, and toggle. */
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
        <TextSection label={props.labels.desc} text={props.description} rich={rich} />
      ) : null}
      {params !== null && rows.length > 0 ? (
        <Section label={props.labels.title} count={rows.length}>
          {rows.map(r => <ParamRow key={r.name} name={r.name} schema={r.schema} required={r.required} />)}
        </Section>
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
          {jsonOpen ? <pre className="lc-ts-desc-body lc-br-dim">{schemaJson}</pre> : null}
        </div>
      ) : null}
    </>
  )
}

/** Localized section labels for one element body. */
interface DetailLabels {
  thinking: string
  answer: string
  content: string
  result: string
  summary: string
  images: string
  other: string
}

/**
 * Render one message's content blocks as a uniform Section stack. Both
 * block vocabularies normalize here — raw durable blocks (`type`: text /
 * reasoning / tool-call / tool-result / image, arguments) and the
 * conversation snapshot's assistant blocks (`kind`: text / reasoning /
 * tool-call / image, argsRaw). Consecutive images group into one grid
 * section; `richable` bodies (messages, injections) carry the Raw/MD
 * switch while tool-result payloads stay raw (structured data, not prose)
 * and dim; nested tool-result blocks flatten into the same flow.
 */
function BlocksBody(props: {
  blocks: readonly unknown[]
  richable: boolean
  /** Section label for prose text blocks (answer / content / result). */
  textLabel: string
  rich: RichKit
  img: ImageKit
  labels: DetailLabels
}): ReactNS.ReactElement {
  const { rich, img, labels } = props
  const out: ReactNS.ReactNode[] = []
  let images: ImageRefLike[] = []
  const flushImages = (): void => {
    if (images.length === 0) return
    const group = images
    images = []
    out.push(
      <Section key={'img' + String(out.length)} label={labels.images} count={group.length}>
        <div className="lc-att-grid">
          {group.map((a, i) => <img.Card key={`${a.attachmentId}:${i}`} attachment={a} load={img.load} />)}
        </div>
      </Section>,
    )
  }
  for (const b of props.blocks) {
    const image = imageRefOf(b)
    if (image !== null) { images.push(image); continue }
    flushImages()
    const blk = b !== null && typeof b === 'object'
      ? b as { type?: unknown; kind?: unknown; text?: unknown; name?: unknown; argsRaw?: unknown; arguments?: unknown; content?: unknown }
      : null
    const blockKind = blk !== null
      ? typeof blk.type === 'string' ? blk.type : typeof blk.kind === 'string' ? blk.kind : ''
      : ''
    if ((blockKind === 'text' || blockKind === 'reasoning') && typeof blk?.text === 'string') {
      const label = blockKind === 'reasoning' ? labels.thinking : props.textLabel
      out.push(props.richable
        ? <TextSection key={out.length} label={label} text={blk.text} rich={rich} />
        : <RawSection key={out.length} label={label} text={blk.text} />)
      continue
    }
    if (blockKind === 'tool-call') {
      out.push(<ToolCallCard
        key={out.length}
        name={typeof blk?.name === 'string' ? blk.name : '?'}
        argsRaw={blk?.argsRaw ?? blk?.arguments}
      />)
      continue
    }
    if (blockKind === 'tool-result' && Array.isArray(blk?.content)) {
      out.push(<BlocksBody
        key={out.length}
        blocks={blk.content as unknown[]}
        richable={false}
        textLabel={labels.result}
        rich={rich}
        img={img}
        labels={labels}
      />)
      continue
    }
    out.push(<RawSection key={out.length} label={labels.other} text={JSON.stringify(b, null, 2)} />)
  }
  flushImages()
  return <>{out}</>
}

/**
 * Parse a call's raw argument payload into an object; null when the payload
 * is missing, malformed, or not a JSON object (callers fall back to the raw
 * text).
 */
function parseArgs(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string' || raw === '') return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null
  } catch {
    return null
  }
}

/**
 * The one-line summary a call's arguments carry about the call: a
 * bash-style `description` says what it does; path-taking tools (edit /
 * read / write) name their target via `file_path`/`path`/`filePath`. Null
 * when the arguments hold neither — the row then falls back to the generic
 * label.
 */
function summaryIn(args: Record<string, unknown> | null): string | null {
  if (args === null) return null
  for (const k of ['description', 'file_path', 'path', 'filePath']) {
    const v = args[k]
    if (typeof v === 'string' && v !== '') return v
  }
  return null
}

/**
 * The summary of a tool result's own call — the collapsed row's preview.
 * Null when the call summarizes to nothing.
 */
function callSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  return summaryIn(parseArgs(conv?.call?.argsRaw))
}

/**
 * The first call summary inside an assistant message's tool-call blocks —
 * the collapsed-row preview for a text-less assistant turn. Null when no
 * block summarizes.
 */
function blockSummaryOf(conv: ConversationNodeLike | undefined): string | null {
  if (conv === undefined || !Array.isArray(conv.blocks)) return null
  for (const b of conv.blocks) {
    const blk = b !== null && typeof b === 'object' ? b as { kind?: string; argsRaw?: unknown } : null
    if (blk === null || blk.kind !== 'tool-call') continue
    const s = summaryIn(parseArgs(blk.argsRaw))
    if (s !== null) return s
  }
  return null
}

/**
 * One tool call as a Section, mirroring the tool-definition parameter
 * card: the head names the call target (mono, with the parsed argument
 * count), the body lists the arguments as name/value rows. Arguments that
 * are not a parseable JSON object fall back to the raw payload inside the
 * same card. Shared by assistant tool-call blocks (`→`) and the call half
 * of a tool result (`←`).
 */
function ToolCallCard(props: { name: string; argsRaw: unknown; arrow?: string }): ReactNS.ReactElement {
  const args = React.useMemo(() => parseArgs(props.argsRaw), [props.argsRaw])
  return (
    <Section
      label={(props.arrow ?? '→') + ' ' + props.name}
      labelClass="lc-ts-call-name"
      count={args !== null ? Object.keys(args).length : undefined}
    >
      {args !== null
        ? Object.keys(args).map(k => <CallArgRow key={k} name={k} value={args[k]} />)
        : typeof props.argsRaw === 'string' && props.argsRaw !== ''
          ? <pre className="lc-ts-desc-body lc-br-dim">{props.argsRaw}</pre>
          : null}
    </Section>
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

/**
 * The actual content of one surface element, joined from the conversation
 * snapshot — rendered as a uniform Section stack (see BlocksBody); the
 * element row's open body wraps the stack in `lc-br-content`.
 */
function NodeContent(props: {
  node: SurfaceNode
  conv: ConversationNodeLike | undefined
  hint: string
  rich: RichKit
  img: ImageKit
  labels: DetailLabels
}): ReactNS.ReactElement {
  const { node, conv, rich, img, labels } = props
  if (conv === undefined) {
    // The join missed (node outside the loaded window): the 80-char preview
    // still shows as a plain content section, with the window note below.
    if (node.text === undefined || node.text === '') {
      return <div className="lc-br-note">{props.hint}</div>
    }
    return (
      <>
        <TextSection label={labels.content} text={node.text} rich={rich} />
        <div className="lc-br-note">{props.hint}</div>
      </>
    )
  }
  if (conv.kind === 'assistant' && Array.isArray(conv.blocks)) {
    return <BlocksBody blocks={conv.blocks} richable textLabel={labels.answer} rich={rich} img={img} labels={labels} />
  }
  if (conv.kind === 'tool-result') {
    return (
      <>
        {conv.call != null
          ? <ToolCallCard arrow="←" name={conv.call.name} argsRaw={conv.call.argsRaw} />
          : null}
        {Array.isArray(conv.content)
          ? <BlocksBody blocks={conv.content} richable={false} textLabel={labels.result} rich={rich} img={img} labels={labels} />
          : null}
      </>
    )
  }
  if (conv.kind === 'compaction') {
    return typeof conv.summary === 'string' && conv.summary !== ''
      ? <TextSection label={labels.summary} text={conv.summary} rich={rich} />
      : <></>
  }
  if (Array.isArray(conv.content)) {
    return <BlocksBody blocks={conv.content} richable textLabel={labels.content} rich={rich} img={img} labels={labels} />
  }
  return <div className="lc-br-note">{props.hint}</div>
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

    /** One expandable element row (preview line; the open body is the
     * uniform indented section stack — `lc-br-content`). */
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
          {open ? <div className="lc-br-content">{body}</div> : null}
        </div>
      )
    }

    const catBody = (c: string): ReactNS.ReactNode => {
      if (c === 'system') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        const system = view.header.system
        if (system === undefined) return null
        return elemRow('sys', null, system.replace(/\s+/g, ' ').trim().slice(0, 80), breakdown.system, undefined,
          <TextSection label={catLabel('system')} text={system} rich={rich} />)
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
            <ToolSchema description={tool.description} schema={tool.schema} rich={rich} labels={labels} />)
        })
      }
      // Surface-node categories carry per-element timestamps; list them
      // newest first, mirroring the NodeList card.
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      return nodes.map((n) => {
        // Tag/preview split: the compact chip carries the compact fact (tool
        // name, injection form) — one shared subtle chip style — and the
        // preview line carries the text, each fact shown once.
        let tag: string | null = null
        let preview = nodeText(n)
        if (n.cat === 'tool') {
          // A `skill`-tool result is a loaded skill: label it by NAME (not the
          // generic tool name) so it scans apart from ordinary tool results.
          tag = n.skill ? t('node.skillTag', { name: n.skill }) : (n.tool ?? '?') + (n.err ? ' ⚠' : '')
          // A call that summarizes itself (bash's `description`, the path
          // of an edit/read call) previews with that line in the collapsed
          // row; the generic result label only when the call says nothing.
          preview = callSummaryOf(bySeq.get(n.seq)) ?? (t('node.toolResult') + (n.err ? ' ⚠' : ''))
        } else if (n.cat === 'assistant' && Array.isArray(n.calls) && n.calls.length > 0) {
          // Call targets join as a breadcrumb (`bash › write`); the preview
          // then carries the reply text, or the first call's own summary
          // (description / target path) for a text-less turn.
          tag = n.calls.join(' › ')
          preview = (n.text !== undefined && n.text !== '' ? n.text : null)
            ?? blockSummaryOf(bySeq.get(n.seq))
            ?? t('node.empty')
        } else if (n.cat === 'assistant' && (n.text === undefined || n.text === '')) {
          // No call list on the surface node: a text-less turn can still
          // preview a self-summarizing call found in the conversation join.
          preview = blockSummaryOf(bySeq.get(n.seq)) ?? preview
        } else if (n.cat === 'user') {
          // A user message with image uploads gains an Image chip on its
          // collapsed row (detected via the conversation join, like the
          // expanded body does); expanded, the body shows the grid anyway.
          const conv = bySeq.get(n.seq)
          const imgCount = conv !== undefined && Array.isArray(conv.content)
            ? conv.content.filter(b => imageRefOf(b) !== null).length
            : 0
          if (imgCount > 0 && openElem !== `n${n.seq}`) {
            tag = t('attach.image') + (imgCount > 1 ? ' ×' + String(imgCount) : '')
          }
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
            // Localized section titles (thinking / answer / content /
            // result / summary / image and other-content cards), handed in
            // by the parent so the body stays a pure function of props.
            labels={{
              thinking: t('block.thinking'),
              answer: t('block.answer'),
              content: t('block.content'),
              result: t('block.result'),
              summary: t('block.summary'),
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
