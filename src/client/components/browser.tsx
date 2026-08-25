import type * as ReactNS from 'react'
import type { Category, ContextHeaders, ContextTimeline, HeaderTool, RequestRecord, SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import { CATS, partsOf } from '../categories'
import { React } from '../react'
import type { ConversationNodeLike, UseSessionLike } from '../services'
import type { ViewKit } from '../viewkit'
import { blockSummaryOf, callSummaryOf, parseCallArgs } from '../callSummary'
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
  /** Preview-seq: hover transiently previews that step; the picker's own selection resumes when the pointer leaves the chart. */
  previewSeq?: number | null
  /** Pin-seq: a pin selects that step; pinSeq null returns the browser to the live surface. */
  pinSeq?: number | null
  /**
   * One-shot reveal request from the step brief: select the step, open the category and the node element, scroll it into view;
   * handed back via `onNodeFocusHandled` so the same row can fire again.
   */
  nodeFocus?: { step: number | 'live'; seq: number; cat: Category } | null
  onNodeFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /**
   * Overview '工具定义 Top' label (`tool` omitted) or chip (`tool: name`) asks to reveal that section; applied once, then handed back via
   * `onToolFocusHandled` so the same chip can fire again.
   */
  toolFocus?: { tool?: string } | null
  onToolFocusHandled?: () => void
  loadImage?: ImageLoader
}

interface ParamSchema {
  type?: unknown
  description?: unknown
  enum?: unknown
  items?: unknown
  anyOf?: unknown
  oneOf?: unknown
}

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
 * Tool schemas nest parameters under `parameters`, `input_schema`, or `inputSchema` (producer-dependent), or bare when `type === 'object'`
 * — `{type:'object', properties}` at the root is itself the parameter object.
 */
function paramsOf(schema: unknown): ParamSchema | null {
  if (schema === null || typeof schema !== 'object') return null
  const s = schema as Record<string, unknown>
  const candidate = (v: unknown): ParamSchema | null =>
    v !== null && typeof v === 'object' ? v : null
  const nested = candidate(s.parameters) ?? candidate(s.input_schema)
    ?? candidate(s.inputSchema)
  if (nested !== null) return nested
  if (s.type === 'object' && s.properties !== undefined && typeof s.properties === 'object') {
    return s
  }
  return null
}

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
 * Section — the ONE detail chrome of the browser: every expanded element is a stack of these (labeled head + body), so the reader scans one
 * repeating anatomy per content kind.
 */
function Section(props: {
  label: string
  labelClass?: string
  count?: number
  actions?: ReactNS.ReactNode
  meta?: ReactNS.ReactNode
  children: ReactNS.ReactNode
}): ReactNS.ReactElement {
  const right = props.actions !== undefined || props.meta !== undefined
  return (
    <div className="lc-ts-card">
      <div className="lc-ts-card-head">
        <b className={props.labelClass}>{props.label}</b>
        {right ? <span className="lc-ts-card-right">{props.meta ?? null}{props.actions ?? null}</span> : null}
        {props.count !== undefined ? <span className="lc-ts-card-count">{props.count}</span> : null}
      </div>
      {props.children}
    </div>
  )
}

function lineCountOf(text: string): number {
  // Count logical lines for LF, CRLF, and lone CR output alike.
  return text.split(/\r\n|\r|\n/).length
}

function TextSection(props: {
  label: string
  text: string
  rich: RichKit
  lines: (n: number) => string
}): ReactNS.ReactElement {
  const { rich } = props
  const [mode, setMode] = rich.useRichMode()
  const lineCount = React.useMemo(() => lineCountOf(props.text), [props.text])
  return (
    <Section
      label={props.label}
      actions={<rich.RichSwitch mode={mode} onPick={setMode} />}
      meta={<span className="lc-ts-card-meta">{props.lines(lineCount)}</span>}
    >
      <rich.RichText text={props.text} mode={mode} />
    </Section>
  )
}

function RawSection(props: { label: string; text: string }): ReactNS.ReactElement {
  return (
    <Section label={props.label}>
      <pre className="lc-ts-desc-body lc-br-dim">{props.text}</pre>
    </Section>
  )
}

/**
 * Full tool-row body: description, parsed parameter table (when the schema carries one), raw JSON behind a per-row toggle — the JSON open
 * state is per-row so two expanded tools stay independent.
 */
function ToolSchema(props: {
  description: string | undefined
  schema: unknown
  rich: RichKit
  lines: (n: number) => string
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
        <TextSection label={props.labels.desc} text={props.description} rich={rich} lines={props.lines} />
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

interface DetailLabels {
  thinking: string
  answer: string
  content: string
  result: string
  summary: string
  images: string
  other: string
  lines: (n: number) => string
  callState: (err: boolean, exit: number | null) => ReactNS.ReactNode
}

/**
 * Both block vocabularies normalize here — raw durable blocks (`type`: text/reasoning/tool-call/tool-result/image) and snapshot assistant
 * blocks (`kind`: text/reasoning/tool-call/image, argsRaw). Consecutive images group into one grid; every
 * rich text block carries the Raw/MD switch + line count; nested tool-result blocks flatten into the same flow.
 */
function BlocksBody(props: {
  blocks: readonly unknown[]
  richable: boolean
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
      out.push(<TextSection
        key={out.length}
        label={label}
        text={blk.text}
        rich={rich}
        lines={labels.lines}
      />)
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
 * The trailing status markers dsh shell tools append at the END of a result's text while `isError` stays false
 * (the status is result data, per tool-bash's render: "non-zero exits are reported, not errored"):
 * - one-shot bash/pwsh: `[exit code: N]` (non-zero only), `[killed by signal: X]`
 * - persistent shells: `[shell killed by signal: X]`, `[shell exited: code N]` — riding LAST, after the
 *   `[exit code: N]` of the command whose failure killed the shell, so the command marker is re-checked
 *   on the preceding text
 * - job_output: `[status: killed]` / `[status: failed, detail]` — the tool-jobs status line always terminates
 *   the read; a killed/failed background job settles with `isError` false, so only the line flags the loss
 * End-anchored like dsh's own parseExitStatus, so marker text quoted inside the output (e.g. a cat'ed log)
 * is not a failure. A clean shell exit (code 0 or code-less) or a live/completed job status is a notice,
 * not a failure.
 * The parsed exit code feeds the FAILED run-state pill.
 */
function tailStatusOf(conv: ConversationNodeLike | undefined): { fail: boolean; exit: number | null } {
  if (conv === undefined || !Array.isArray(conv.content)) return { fail: false, exit: null }
  for (const b of conv.content) {
    const text = (b as { text?: unknown } | null)?.text
    if (typeof text !== 'string') continue
    const tail = text.trimEnd()
    const shell = /\[(shell killed by signal: [^\]\n]+|shell exited(?:: code \d+)?)\]$/.exec(tail)
    if (shell !== null) {
      const cmdExit = /\[exit code:\s*(\d+)\]\s*$/.exec(tail.slice(0, shell.index))
      if (cmdExit !== null) return { fail: true, exit: Number(cmdExit[1]) }
      const code = /: code (\d+)$/.exec(shell[1])
      if (code !== null) return { fail: code[1] !== '0', exit: code[1] === '0' ? null : Number(code[1]) }
      return { fail: shell[1].startsWith('shell killed'), exit: null }
    }
    const exit = /\[exit code:\s*(\d+)\]$/.exec(tail)
    if (exit !== null) return { fail: true, exit: Number(exit[1]) }
    if (/\[killed by signal: [^\]\n]+\]$/.test(tail)) return { fail: true, exit: null }
    if (/\[status: (?:killed|failed)(?:, [^\]\n]*)?\]$/.test(tail)) return { fail: true, exit: null }
  }
  return { fail: false, exit: null }
}

/**
 * A tool result's failure: the fold-stamped `err` or the snapshot's `isError` (infrastructure failures — dsh stamps
 * those) OR a trailing status marker (see tailStatusOf). dsh settles a failing COMMAND as a completed call, so the
 * marker is the only failure signal — mirroring the chat row's terminalFailed. A timeout stays a notice, as in the chat.
 */
function toolErrOf(node: SurfaceNode, conv: ConversationNodeLike | undefined): { err: boolean; exit: number | null } {
  const tail = tailStatusOf(conv)
  const err = node.err === true || conv?.isError === true || tail.fail
  return { err, exit: tail.exit }
}

function ToolCallCard(props: {
  name: string
  argsRaw: unknown
  arrow?: string
  status?: ReactNS.ReactNode
}): ReactNS.ReactElement {
  const args = React.useMemo(() => parseCallArgs(props.argsRaw), [props.argsRaw])
  return (
    <Section
      label={(props.arrow ?? '→') + ' ' + props.name}
      labelClass="lc-ts-call-name"
      meta={props.status}
    >
      {args !== null
        ? Object.keys(args).map(k => <CallArgRow key={k} name={k} value={args[k]} />)
        : typeof props.argsRaw === 'string' && props.argsRaw !== ''
          ? <pre className="lc-ts-desc-body lc-br-dim">{props.argsRaw}</pre>
          : null}
    </Section>
  )
}

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
        <TextSection label={labels.content} text={node.text} rich={rich} lines={labels.lines} />
        <div className="lc-br-note">{props.hint}</div>
      </>
    )
  }
  if (conv.kind === 'assistant' && Array.isArray(conv.blocks)) {
    return <BlocksBody blocks={conv.blocks} richable textLabel={labels.answer} rich={rich} img={img} labels={labels} />
  }
  if (conv.kind === 'tool-result') {
    const { err, exit } = toolErrOf(node, conv)
    return (
      <>
        {conv.call != null
          ? <ToolCallCard
            arrow="←"
            name={conv.call.name}
            argsRaw={conv.call.argsRaw}
            status={labels.callState(err, exit)}
          />
          : null}
        {Array.isArray(conv.content)
          ? <BlocksBody blocks={conv.content} richable={false} textLabel={labels.result} rich={rich} img={img} labels={labels} />
          : null}
      </>
    )
  }
  if (conv.kind === 'compaction') {
    return typeof conv.summary === 'string' && conv.summary !== ''
      ? <TextSection label={labels.summary} text={conv.summary} rich={rich} lines={labels.lines} />
      : <></>
  }
  if (Array.isArray(conv.content)) {
    return <BlocksBody blocks={conv.content} richable textLabel={labels.content} rich={rich} img={img} labels={labels} />
  }
  return <div className="lc-br-note">{props.hint}</div>
}

function byCatOf(asm: Assembled): Partial<Record<Category, SurfaceNode[]>> {
  const m: Partial<Record<Category, SurfaceNode[]>> = {}
  for (const n of asm.nodes) (m[n.cat] ??= []).push(n)
  return m
}

function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.header !== null && asm.header.system !== undefined ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

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
  // All rich text sections share the same line-count label; hoist it once so tool
  // descriptions, system text, and message bodies stay in sync.
  const lineLabel = (n: number): string => t(n === 1 ? 'block.line' : 'block.lines', { n })

  // Auto-load ceiling: a guard against seqs that never land in the conversation snapshot (pages pull until the seq joins, history runs out,
  // or the cap is hit).
  const MAX_AUTO_PAGES = 20

  return function ContextBrowser(props: ContextBrowserProps): ReactNS.ReactElement {
    const { data, headers } = props
    // 'live' = the current surface (the NEXT request's context); number = a retained step's seq.
    const [sel, setSel] = React.useState<'live' | number>('live')
    const [openCat, setOpenCat] = React.useState<string | null>(null)
    const [openElem, setOpenElem] = React.useState<string | null>(null)

    // Full message content joined from the conversation snapshot by surface seq (`s.nodes` is a stable reference per snapshot; the bySeq
    // map memoizes over it).
    const convNodes = typeof props.useSession === 'function'
      ? props.useSession(s => s.nodes)
      : undefined
    const bySeq = React.useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    // On-demand pagination flags as primitive selectors, so the component re-renders only when a page actually lands or runs out.
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
    // Auto-load pages older history until the open seq joins (one page in flight, sequenced by loadingOlder); `exhausted` latches
    // cap/history-end so the hint falls back to the static note instead of 'loading' forever.
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
      if (!hasMore && missingSeq !== null && !exhausted) setExhausted(true)
    }, [hasMore, missingSeq, exhausted])
    // Pin linkage: a pinned bar selects its step (same accordion reset as a manual pick); unpin returns to live — a manual pick here is
    // overridden only when a NEW pin lands.
    const pinSeq = props.pinSeq
    React.useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setOpenCat(null)
      setOpenElem(null)
    }, [pinSeq])
    // Tool-link bridge: apply the one-shot request on the LIVE surface — the overview's Top chips rank the current header's tools — then
    // hand it back via `onToolFocusHandled` so the same chip can trigger again.
    const toolFocus = props.toolFocus
    React.useEffect(() => {
      if (toolFocus === null || toolFocus === undefined) return
      setSel('live')
      setOpenCat('tools')
      setOpenElem(toolFocus.tool !== undefined ? 'tool:' + toolFocus.tool : null)
      if (props.onToolFocusHandled !== undefined) props.onToolFocusHandled()
    }, [toolFocus, props.onToolFocusHandled])
    // Step-brief reveal: select the owning step, open the node's category + element (the pagination effect above already pulls older
    // history for a missing join), then arm a one-shot scroll consumed by the layout effect once the row renders.
    const rootRef = React.useRef<HTMLDivElement | null>(null)
    const focusScrollRef = React.useRef(false)
    const nodeFocus = props.nodeFocus
    React.useEffect(() => {
      if (nodeFocus === null || nodeFocus === undefined) return
      setSel(nodeFocus.step)
      setOpenCat(nodeFocus.cat)
      setOpenElem('n' + String(nodeFocus.seq))
      focusScrollRef.current = true
      if (props.onNodeFocusHandled !== undefined) props.onNodeFocusHandled()
    }, [nodeFocus, props.onNodeFocusHandled])
    React.useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      rootRef.current?.querySelector('.lc-br-elem-on')?.scrollIntoView({ block: 'nearest' })
    })
    const awaiting = missingSeq !== null && !exhausted && loadOlderHistory !== undefined && hasMore

    const requests = data.requests
    const hoverReq = props.previewSeq !== null && props.previewSeq !== undefined
      ? requests.find(r => r.seq === props.previewSeq) ?? null
      : null
    const req = hoverReq ?? (sel === 'live' ? null : requests.find(r => r.seq === sel) ?? null)
    // A pinned step trimmed out of retention falls back to live.
    const seq = req !== null ? req.seq : null
    // The browser joins the shared composition hover ONLY while it shows the LIVE step — a pinned/previewed step has a different
    // composition, so its hover must not light the overview (and vice versa); the mirror filter drops the overview's 'free' key, which has
    // no segment in this bar.
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

    // δ baselines against the PREVIOUS TURN's last request — one stable unit whatever step/live surface is shown (turn T reads against turn
    // T−1's final step), avoiding the misleading 'change' a same-turn neighbour would imply.
    const refReq = req === null
      ? requests.length > 0 ? requests[requests.length - 1] : null
      : lastOfTurn(requests, (req.turn ?? 0) - 1)
    const prevView = refReq !== null ? assemble(data, headers, refReq.seq) : null
    const prevByCat = prevView !== null ? byCatOf(prevView) : null

    const byCat = byCatOf(view)

    const toolCount = (c: string): number => countOf(view, byCat, c)

    const toggleCat = (c: string) => {
      // Empty cats stay shut — except system/tools with no header epoch, which open to explain the degradation note.
      const openable = toolCount(c) > 0
        || ((c === 'system' || c === 'tools') && view.header === null)
      if (!openable) return
      if (openCat === c) {
        setOpenCat(null)
        setOpenElem(null)
        return
      }
      setOpenCat(c)
      // The system prompt's single row opens by default, so one category click lands on the text directly.
      setOpenElem(c === 'system' && view.header?.system !== undefined ? 'sys' : null)
    }
    const toggleElem = (key: string) => { setOpenElem(openElem === key ? null : key) }

    /**
     * Expandable element row; `err` rows carry the red run-state dot right after the chevron (the chat's failed-tool marker) so a failed
     * result scans while collapsed.
     */
    const elemRow = (
      key: string, tag: string | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNS.ReactNode,
      err = false,
    ) => {
      const open = openElem === key
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '')}>
          <button type="button" className="lc-br-elem-row" onClick={() => { toggleElem(key) }}>
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')}>{'▸'}</span>
            {err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
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
          <TextSection label={catLabel('system')} text={system} rich={rich} lines={lineLabel} />)
      }
      if (c === 'tools') {
        if (view.header === null) return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        // Schemas rank by token price (largest first) to mirror the overview's Top chips — the producer's header order is not meaningful.
        const labels = {
          desc: t('tool.desc'),
          title: t('tool.params'),
          empty: t('tool.paramsEmpty'),
          show: t('tool.jsonToggle'),
          hide: t('tool.jsonHide'),
        }
        return view.header.tools.slice().sort((a, b) => b.tokens - a.tokens).map((tool: HeaderTool) => {
          return elemRow('tool:' + tool.name, null, tool.name, tool.tokens, undefined,
            <ToolSchema description={tool.description} schema={tool.schema} rich={rich} lines={lineLabel} labels={labels} />)
        })
      }
      // List surface nodes newest first, mirroring the NodeList card.
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      return nodes.map((n) => {
        const conv = bySeq.get(n.seq)
        const rowErr = n.cat === 'tool' && toolErrOf(n, conv).err
        // Tag carries the compact fact (tool name, injection form) — one shared subtle chip style; the preview line carries the text — each
        // fact shown once.
        let tag: string | null = null
        let preview = nodeText(n)
        if (n.cat === 'tool') {
          // A `skill`-tool result is a loaded skill: label it by NAME so it scans apart from ordinary results; the red dot already marks
          // failures — no ⚠ suffix needed.
          tag = n.skill ? t('node.skillTag', { name: n.skill }) : (n.tool ?? '?')
          preview = callSummaryOf(conv) ?? t('node.toolResult')
        } else if (n.cat === 'assistant' && Array.isArray(n.calls) && n.calls.length > 0) {
          // Call targets join as a breadcrumb (`bash › write`); the preview carries the reply text, else the first call's own summary for a
          // text-less turn.
          tag = n.calls.join(' › ')
          preview = (n.text !== undefined && n.text !== '' ? n.text : null)
            ?? blockSummaryOf(conv)
            ?? t('node.empty')
        } else if (n.cat === 'assistant' && (n.text === undefined || n.text === '')) {
          // A text-less turn can still preview a self-summarizing call from the join even when the node carries no call list.
          preview = blockSummaryOf(conv) ?? preview
        } else if (n.cat === 'user') {
          // User messages with image uploads gain an Image chip on the collapsed row (detected via the conversation join, like the expanded
          // body); expanded, the grid shows anyway.
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
            conv={conv}
            rich={rich}
            img={{ Card: ImageCard, load: props.loadImage }}
            // Localized section titles handed in by the parent so the body stays a pure function of props.
            labels={{
              thinking: t('block.thinking'),
              answer: t('block.answer'),
              content: t('block.content'),
              result: t('block.result'),
              summary: t('block.summary'),
              images: t('attach.images'),
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
            // Only the open row's body renders, so `awaiting` (open seq missing, pagination armed) is exactly THIS join being pulled for.
            hint={conv === undefined && awaiting
              ? t('browser.loading')
              : t('browser.noContent')}
          />,
          rowErr)
      })
    }

    return (
      <div className="lc-card" ref={rootRef}>
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
            // Mirrored hover link (see `linked` above): while the browser shows the live surface, its bar highlights the shared category
            // key and reports hovers back to the overview; tip stays off — a cross-card hover must not float a second tooltip over a bar
            // the pointer does not rest on.
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
            const prevCount = prevView !== null && prevByCat !== null ? countOf(prevView, prevByCat, c.key) : null
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
