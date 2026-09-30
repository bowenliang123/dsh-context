import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ChangeEvent, type ReactElement, type ReactNode } from 'react'
import { UNKNOWN_TOOL_SOURCE, type Category, type ContextHeaders, type ContextTimeline, type HeaderTool, type RequestRecord, type SurfaceNode } from '../../shared/types'
import { assemble } from '../assemble'
import type { Assembled } from '../assemble'
import { CATS, CAT_COLOR, partsOf } from '../categories'
import { dnaBaseLabel, dnaOf } from '../dna'
import type { DnaItem } from '../dna'
import type { ContentFetcher, ConversationNodeLike, HeaderFetcher } from '../services'
import type { ContextSettings, DefaultDeltaBase, DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import { blockSummaryOf, callNamesOf, callSummaryOf, parseCallArgs } from '../callSummary'
import type { DetailState } from '../timelineSource'
import { makeDetailNote } from './detailNote'
import { makeNodeText } from './nodes'
import { turnStepsOf } from './trendChart'
import { fetchMissNote, useFetchOnMiss } from './fetchOnMiss'
import { imageRefOf, makeImageCard } from './images'
import type { ImageKit } from './images'
import { makeRichText } from './richText'
import type { RichKit } from './richText'
import type { StackedBarProps } from './stackedBar'
import type { ImageLoader, ImageRefLike } from '../services'

export interface ContextBrowserProps {
  data: ContextTimeline
  headers: ContextHeaders | null
  /**
   * The conversation-window nodes, resolved by the caller from the `useChat`
   * seat — the browser itself stays seat-free so the hook order lives in
   * exactly one place.
   */
  convNodes?: readonly ConversationNodeLike[]
  /**
   * Targeted full-content fetch for nodes outside the conversation window
   * or summary-only compaction joins: one read per expanded row (absent on older hosts —
   * those keep the preview-plus-hint degradation).
   */
  fetchContent?: ContentFetcher
  /**
   * On-demand CONTENT fetch for the selected step's `contextHeaders` epoch
   * (system prompt text, tool descriptions/schemas) — one seq-anchored
   * history read per epoch, cached per session (absent on older hosts —
   * those keep the metadata-only degradation).
   */
  fetchHeader?: HeaderFetcher
  /** Preview-seq: hover transiently previews that step; the picker's own selection resumes when the pointer leaves the chart. */
  previewSeq?: number | null
  /** Pin-seq: a pin selects that step; pinSeq null returns the browser to the live surface. */
  pinSeq?: number | null
  /**
   * DNA mode's on/off, LINKED across cards: the Context tab passes its trend card's toggle state
   * so both DNA switches move as one. Controlled only when BOTH props arrive; absent (the
   * /context modal) — the browser keeps its own mount-local toggle.
   */
  dna?: boolean
  onDnaChange?: (on: boolean) => void
  /**
   * One-shot reveal request (the step brief's locate, a trend-DNA band pick): select the step, open the
   * item's category and element, scroll it into view. `key` is the band key both DNA surfaces share —
   * 'sys' (system prompt), 'tool:<name>' (a tool schema), 'n<seq>' (a message) — so the same bridge
   * serves header bands and message nodes; handed back via `onNodeFocusHandled` so the same row can
   * fire again.
   */
  nodeFocus?: { step: number | 'live'; key: string; cat: Category | 'system' | 'tools' } | null
  onNodeFocusHandled?: () => void
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /**
   * Reports the open category (null once none opens): the Context tab focuses the trend chart's bars on it.
   * Absent (the /context modal) — the accordion stays purely internal.
   */
  onOpenCat?: (cat: string | null) => void
  loadImage?: ImageLoader
  /**
   * The timeline source's detail state (split generation): while the first
   * detail read is pending or settled without data, a note strip names the
   * state (the picker/sections otherwise show a misleading empty surface).
   */
  detailState?: DetailState
  onDetailRetry?: () => void
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
}): ReactElement {
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
  /** Fold the head's trailing group onto a second line under width pressure (rich-text heads; the call-name head must stay one-line). */
  foldHead?: boolean
  count?: number
  actions?: ReactNode
  meta?: ReactNode
  children: ReactNode
}): ReactElement {
  const right = props.actions !== undefined || props.meta !== undefined
  return (
    <div className="lc-ts-card">
      <div className={'lc-ts-card-head' + (props.foldHead === true ? ' lc-ts-card-head-wrap' : '')}>
        {/* The title recovers an ellipsized label: long mono call names truncate under width pressure. */}
        <b className={props.labelClass} title={props.label}>{props.label}</b>
        {right ? <span className="lc-ts-card-right">{props.meta}{props.actions}</span> : null}
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
}): ReactElement {
  const { rich } = props
  const [mode, setMode] = rich.useRichMode()
  const lineCount = useMemo(() => lineCountOf(props.text), [props.text])
  return (
    <Section
      label={props.label}
      foldHead
      actions={<>
        <rich.RichSwitch mode={mode} onPick={setMode} />
        <rich.RichCopy text={props.text} />
      </>}
      meta={<span className="lc-ts-card-meta">{props.lines(lineCount)}</span>}
    >
      <rich.RichText text={props.text} mode={mode} />
    </Section>
  )
}

function RawSection(props: { label: string; text: string }): ReactElement {
  return (
    <Section label={props.label}>
      <pre className="lc-ts-desc-body lc-br-dim">{props.text}</pre>
    </Section>
  )
}

/**
 * The search text of one tool's raw schema. The schema is log data this view
 * does not own — a hostile value (cyclic, throwing getters) degrades to no
 * matchable text instead of taking the row, or the browser, down.
 */
function schemaTextOf(schema: unknown): string {
  try {
    return JSON.stringify(schema ?? '')
  } catch {
    return ''
  }
}

/**
 * The shared row-filter toolbar of a category body: a text input plus an
 * optional trailing control group (the tools' size/name sort). Stays mounted
 * on an empty match so the filter can always be cleared from the UI.
 */
function RowToolbar(props: {
  value: string
  placeholder: string
  tip?: string
  onChange: (v: string) => void
  children?: ReactNode
}): ReactElement {
  return (
    <div className="lc-br-toolctl">
      <input
        className="lc-br-tool-search focus:border-(--dsw-alias-label-dimmed)"
        value={props.value}
        placeholder={props.placeholder}
        onChange={(ev: ChangeEvent<HTMLInputElement>) => { props.onChange(ev.target.value) }}
      />
      {props.children !== undefined
        ? <span className="lc-gran" role="group" title={props.tip}>{props.children}</span>
        : null}
    </div>
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
}): ReactElement {
  const { rich } = props
  const [jsonOpen, setJsonOpen] = useState(false)
  const params = useMemo(() => paramsOf(props.schema), [props.schema])
  const rows = useMemo<{ name: string; schema: ParamSchema; required: boolean }[]>(() => {
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
  // Pretty-printed only while the row's JSON is open: a tools section lists
  // dozens of schemas, and eager stringification of every collapsed row
  // dominated the section's render cost.
  const schemaJson = useMemo(
    () => jsonOpen ? JSON.stringify(props.schema, null, 2) : '',
    [props.schema, jsonOpen],
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
      <div className="lc-ts-json">
        <button
          type="button"
          className="lc-ts-json-toggle hover:text-(--dsw-alias-label-primary) hover:underline"
          onClick={() => { setJsonOpen(o => !o) }}
        >{(jsonOpen ? '▾ ' : '▸ ') + (jsonOpen ? props.labels.hide : props.labels.show)}</button>
        {jsonOpen ? <pre className="lc-ts-desc-body lc-br-dim">{schemaJson}</pre> : null}
      </div>
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
  callState: (err: boolean, exit: number | null) => ReactNode
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
}): ReactElement {
  const { rich, img, labels } = props
  const out: ReactNode[] = []
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
  status?: ReactNode
}): ReactElement {
  const args = useMemo(() => parseCallArgs(props.argsRaw), [props.argsRaw])
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

function CallArgRow(props: { name: string; value: unknown }): ReactElement {
  const v = props.value
  /* v8 ignore next 2 -- the only caller maps Object.keys of a JSON.parse'd
     object, which never holds undefined values; defensive. */
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
  hint: ReactNode
  rich: RichKit
  img: ImageKit
  labels: DetailLabels
}): ReactElement {
  const { node, conv, rich, img, labels } = props
  if (conv === undefined) {
    // The join missed (node outside the loaded window): the 80-char preview
    // still shows as a plain content section, with the fetch-state note below.
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
    return (
      <>
        {typeof conv.summary === 'string' && conv.summary !== ''
          ? <TextSection label={labels.summary} text={conv.summary} rich={rich} lines={labels.lines} />
          : null}
        {Array.isArray(conv.content)
          ? <BlocksBody
            blocks={conv.content.filter(b => imageRefOf(b) !== null)}
            richable={false} textLabel={labels.content} rich={rich} img={img} labels={labels}
          />
          : props.hint !== null ? <div className="lc-br-note">{props.hint}</div> : null}
      </>
    )
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

/**
 * The producer identity a fold-stamped injection node carries
 * (shared/types.ts SurfaceNode.name): '' when absent or drift-typed — the
 * delivered payload is untrusted, so rows re-prove it before rendering.
 */
function nodeNameOf(n: SurfaceNode): string {
  return typeof n.name === 'string' ? n.name : ''
}

/**
 * The content kinds one assistant message proves, as the assistant category's
 * kind chips count and filter them: thinking (a reasoning block — only the
 * conversation join can prove it), tool calls (join blocks, else the fold's
 * text-less-reply `calls` stamp), and answer text (join blocks, else the
 * node's `text`). Legacy `content` joins classify the same way the body
 * renders them. The flags are independent, so a combined reply lights
 * several chips.
 */
function msgKindsOf(n: SurfaceNode, conv: ConversationNodeLike | undefined): { think: boolean; tool: boolean; answer: boolean } {
  let think = false
  let tool = false
  let answer = false
  for (const blocks of [conv?.blocks, conv?.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object' ? b as { type?: unknown; kind?: unknown } : null
      const k = blk !== null
        ? typeof blk.kind === 'string' ? blk.kind : typeof blk.type === 'string' ? blk.type : ''
        : ''
      if (k === 'reasoning') think = true
      else if (k === 'tool-call') tool = true
      else if (k === 'text') answer = true
    }
  }
  return {
    think,
    tool: tool || (Array.isArray(n.calls) && n.calls.length > 0),
    answer: answer || (typeof n.text === 'string' && n.text !== ''),
  }
}

/**
 * The reasoning texts one assistant row's conversation join proves, concatenated for the row filter's scan —
 * the fold stamps no reasoning on the node, so this is the only scan face the thinking blocks expose. Both block
 * vocabularies classify here (the body renders the same blocks as the Reasoning sections); malformed blocks drop.
 */
function reasoningTextOf(conv: ConversationNodeLike | undefined): string {
  if (conv === undefined) return ''
  let out = ''
  for (const blocks of [conv.blocks, conv.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object' ? b as { type?: unknown; kind?: unknown; text?: unknown } : null
      const k = blk !== null
        ? typeof blk.kind === 'string' ? blk.kind : typeof blk.type === 'string' ? blk.type : ''
        : ''
      if (k === 'reasoning' && typeof blk?.text === 'string') out += blk.text + '\n'
    }
  }
  return out
}

/** The assistant rows' kind chips, in display order. */
const ROW_KINDS = ['think', 'tool', 'answer'] as const
type RowKind = (typeof ROW_KINDS)[number]

function countOf(asm: Assembled, byCat: Partial<Record<Category, SurfaceNode[]>>, c: string): number {
  if (c === 'system') return asm.system !== null ? 1 : 0
  if (c === 'tools') return asm.header !== null ? asm.header.tools.length : 0
  return byCat[c as Category]?.length ?? 0
}

function lastOfTurn(requests: RequestRecord[], turn: number): RequestRecord | null {
  for (let i = requests.length - 1; i >= 0; i--) if ((requests[i].turn ?? 0) === turn) return requests[i]
  return null
}

/**
 * DNA bands keep at least this share of the occupied region, so a tiny item (a 25-token user message in a 40k
 * context) stays a hoverable/clickable filament instead of a sub-pixel sliver. Tooltips still report true shares.
 */
const DNA_MIN_BAND = 0.35

export function makeContextBrowser(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  settings: ContextSettings,
): (props: ContextBrowserProps) => ReactElement {
  const { t, fmt, fmtTime, catLabel } = kit
  const DetailNote = makeDetailNote(kit)
  const nodeText = makeNodeText(kit)
  const rich = makeRichText(kit)
  const ImageCard = makeImageCard(kit)
  // All rich text sections share the same line-count label; hoist it once so tool
  // descriptions, system text, and message bodies stay in sync.
  const lineLabel = (n: number): string => t(n === 1 ? 'block.line' : 'block.lines', { n })

  return function ContextBrowser(props: ContextBrowserProps): ReactElement {
    const { data, headers } = props
    // 'live' = the current surface (the NEXT request's context); number = a retained step's seq.
    const [sel, setSel] = useState<'live' | number>('live')
    const [openCat, setOpenCat] = useState<string | null>(null)
    const [openElem, setOpenElem] = useState<string | null>(null)
    // The open category's row-filter text plus the tools' row order. The
    // filter is a lens on the OPEN category: opening a different one resets
    // it, while step picks (setOpenCat(null) below) keep it so the same lens
    // compares epochs.
    const [rowQuery, setRowQuery] = useState('')
    // The assistant category's picked kind chip (null = none). It follows the
    // text filter's lens rules: reset on a category switch, kept across step
    // picks.
    const [rowKind, setRowKind] = useState<RowKind | null>(null)
    // Mount-time default from the plugin settings card; in-toolbar toggling
    // stays mount-local and never writes back.
    const [toolSort, setToolSort] = useState<DefaultToolSort>(() => settings.defaultToolSort())
    // DNA mode: the composition bar redraws as ONE band per context item in prompt order (dna.ts), hovered/clicked per
    // item. Parent-linked when both props arrive — the Context tab's trend toggle moves this one too; a lone
    // prop is ignored — otherwise mount-local (the /context modal).
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
    // δ baseline toggle: 'step' diffs against the immediately preceding record, 'turn' against the
    // previous turn's last step. Mount default from the plugin settings card; in-toolbar toggling
    // stays mount-local and never writes back.
    const [deltaBase, setDeltaBase] = useState<DefaultDeltaBase>(() => settings.defaultDeltaBase())
    // Every open-category change (toggle, step pick, pin, brief reveal) reports outward so the Context tab
    // can focus the trend chart on the open category.
    const onOpenCat = props.onOpenCat
    const setCat = (c: string | null): void => {
      setOpenCat(c)
      if (onOpenCat !== undefined) onOpenCat(c)
    }

    // Full message content: the conversation-window join first (zero cost),
    // plus nodes fetched on demand for seqs outside the window (node arrays
    // are stable references per snapshot; the map memoizes over them).
    const convNodes = props.convNodes
    const convBySeq = useMemo(() => {
      const m = new Map<number, ConversationNodeLike>()
      for (const n of convNodes ?? []) m.set(n.seq, n)
      return m
    }, [convNodes])

    // The open element's surface-node seq ('sys'/'tool:*' keys never join).
    const openSeq = openElem !== null && openElem.startsWith('n')
      ? Number(openElem.slice(1))
      : null
    // Harness compaction nodes carry only the summary; checkpoint images
    // arrive through the same targeted read as an out-of-window message.
    const openConv = openSeq !== null ? convBySeq.get(openSeq) : undefined
    const contentMissing = openConv === undefined
      || (openConv.kind === 'compaction' && !Array.isArray(openConv.content))
    const fetchContent = props.fetchContent
    const miss = useFetchOnMiss(
      contentMissing ? openSeq : null,
      fetchContent,
      'dsh-context: targeted history read failed',
    )
    const bySeq = useMemo(() => {
      if (miss.values.size === 0) return convBySeq
      const m = new Map(convBySeq)
      for (const [seq, n] of miss.values) {
        const joined = m.get(seq)
        if (joined === undefined) m.set(seq, n)
        else if (joined.kind === 'compaction' && !Array.isArray(joined.content)) {
          m.set(seq, {
            ...joined,
            content: n.content,
            summary: typeof joined.summary === 'string' && joined.summary !== '' ? joined.summary : n.summary,
          })
        }
      }
      return m
    }, [convBySeq, miss.values])
    // Pin linkage: a pinned bar selects its step (same accordion reset as a manual pick); unpin returns to live — a manual pick here is
    // overridden only when a NEW pin lands.
    const pinSeq = props.pinSeq
    useEffect(() => {
      setSel(pinSeq === null || pinSeq === undefined ? 'live' : pinSeq)
      setCat(null)
      setOpenElem(null)
    }, [pinSeq, onOpenCat])
    // Reveal (step brief / trend-DNA pick): select the owning step, open the item's category +
    // element (the pagination effect above already pulls older history for a missing join), clear
    // the row lens so a stale filter cannot hide the revealed row, then arm a one-shot scroll
    // consumed by the layout effect once the row renders.
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
    useLayoutEffect(() => {
      if (!focusScrollRef.current) return
      focusScrollRef.current = false
      rootRef.current?.querySelector('.lc-br-elem-on')?.scrollIntoView({ block: 'nearest' })
    })
    // The note an un-joined open row shows, per fetch state (fetchOnMiss.tsx).
    const missNote = fetchMissNote(t, fetchContent, miss.state, miss.retry, 'browser.noContent')

    const requests = data.requests
    const stepsOf = useMemo(() => turnStepsOf(requests), [requests])
    const hoverReq = props.previewSeq !== null && props.previewSeq !== undefined
      ? requests.find(r => r.seq === props.previewSeq) ?? null
      : null
    const req = hoverReq ?? (sel === 'live' ? null : requests.find(r => r.seq === sel) ?? null)
    // The actual-prompt figure follows the shown step; the live surface pairs its next-request
    // estimate with the freshest actual the log holds (highest seq — wire order is not trusted).
    const actual = req ?? requests.reduce<RequestRecord | null>((a, r) => (a === null || r.seq > a.seq ? r : a), null)
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

    // Header/tool epoch CONTENT (tool descriptions/schemas) and the system
    // prompt TEXT: the projections carry metadata only, so the selected step's
    // sources are fetched on demand — one seq-anchored history read per open
    // section. The system prompt rides the timeline's own `systems` nodes (a
    // `system/message` event), the tools the header epoch; both map through
    // the same fetcher. Content caches per seq — history is immutable.
    const fetchHeader = props.fetchHeader
    const headerSeq = view.header !== null ? view.header.seq : null
    const systemSeq = view.system !== null ? view.system.seq : null
    const contentSeq = openCat === 'system' ? systemSeq : openCat === 'tools' ? headerSeq : null
    const epoch = useFetchOnMiss(
      contentSeq,
      fetchHeader,
      'dsh-context: header content fetch failed',
    )
    const headerContent = epoch.values
    // The note a not-yet-loaded epoch section shows, per fetch state (fetchOnMiss.tsx).
    const headerNote = fetchMissNote(t, fetchHeader, epoch.state, epoch.retry, 'browser.headerMetaOnly')

    const breakdown = req !== null ? req : data.current
    const parts = partsOf(breakdown)
    const total = breakdown.total
    // The open category stays lit in the composition bar (category mode: its segment; DNA mode: its bands' group) even
    // without pointer hover — a pointer hover overrides the pin, the pin resumes on leave. Dropped when the shown
    // step's composition holds nothing for the category, so the bar never reads all-dimmed with nothing lit.
    const pinKey = openCat !== null && (breakdown[openCat as Category | 'system' | 'tools'] || 0) > 0 ? openCat : null
    const pick = (v: string) => {
      setSel(v === 'live' ? 'live' : Number(v))
      setCat(null)
      setOpenElem(null)
    }

    // δ baseline per the picked mode. Picked steps: 'step' = the immediately preceding record, 'turn' =
    // the previous turn's last step. Live: 'step' = the last served request (the next request's direct
    // predecessor); 'turn' = the previous turn's last step — this turn's growth so far. A picked step or
    // a live surface with no predecessor (the log's first step, a first turn) falls back to a ZERO
    // baseline: the whole surface is change, so the pills show the full makeup. A request-less live
    // surface has nothing to compare against at all: no baseline, no pills.
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

    // Per-tool call-hit tally over the shown step's assembled surface: one
    // tool-result node (the fold stamps `tool` on a paired result) is one
    // completed call — the same accounting as the stats' toolCalls. A
    // `skill`-tool load reclassifies its node into the `skill` bucket but
    // keeps the tool stamp, so those calls still count here.
    const toolHits = new Map<string, number>()
    for (const n of view.nodes) {
      if ((n.cat === 'tool' || n.cat === 'skill') && n.tool !== undefined) toolHits.set(n.tool, (toolHits.get(n.tool) ?? 0) + 1)
    }
    const toolHitsOf = (tool: HeaderTool): number => toolHits.get(tool.name) ?? 0

    // DNA mode: per-item bands in prompt order (dna.ts). The band label names the item the way its accordion row would
    // (the shared dnaBaseLabel — skill name, tool name, injection form, else the category label) with its time appended.
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
    // A band hover is honored only while its key names a RENDERED band: a push can drop the band under a resting
    // pointer (compaction, tail slide) without a mouseleave, and a dead key exact-matches nothing — the bar would
    // sit all-dimmed with nothing lit (the same invariant the pin's `breakdown` gate keeps).
    const liveDnaKey = dnaKey !== null && dnaByKey.has(dnaKey) ? dnaKey : null
    // A band click opens its category + element row below (the same reveal the step brief uses) and scrolls it into view.
    const pickDna = (key: string): void => {
      const it = dnaByKey.get(key)
      /* v8 ignore next 1 -- the bar only reports keys of the parts it was handed; defensive. */
      if (it === undefined) return
      setCat(it.cat)
      setRowQuery('')
      setRowKind(null)
      setOpenElem(key)
      focusScrollRef.current = true
    }

    const toolCount = (c: string): number => countOf(view, byCat, c)

    // A category holding exactly one item opens that row with the category, so
    // one click lands on the content directly (the lone prompt / tool schema /
    // surface node).
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
      // A different category opens unfiltered — the lens belongs to the open one.
      setRowQuery('')
      setRowKind(null)
      setOpenElem(singleKeyOf(c))
    }
    const toggleElem = (key: string) => { setOpenElem(openElem === key ? null : key) }

    /**
     * Expandable element row; `err` rows carry the red run-state dot right after the chevron (the chat's failed-tool marker) so a failed
     * result scans while collapsed.
     */
    const elemRow = (
      key: string, tag: ReactNode | null, preview: string,
      tokens: number, time: number | undefined, body: ReactNode,
      err = false, trailing: ReactNode = null,
    ) => {
      const open = openElem === key
      return (
        <div key={key} className={'lc-br-elem' + (open ? ' lc-br-elem-on' : '')}>
          <button type="button" className="lc-br-elem-row hover:bg-(--dsw-alias-interactive-bg-hover)" onClick={() => { toggleElem(key) }}>
            <span className={'lc-br-chev' + (open ? ' lc-br-chev-on' : '')} />
            {err ? <span className="lc-br-err-dot" title={t('node.failed')} /> : null}
            {tag !== null ? <span className="lc-br-tags">{tag}</span> : null}
            <span className="lc-br-preview">{preview}</span>
            {trailing !== null ? trailing : null}
            {time !== undefined ? <span className="lc-br-time">{fmtTime(time)}</span> : null}
            <span className="lc-br-tokens">{'≈' + fmt(tokens)}</span>
          </button>
          {open ? <div className="lc-br-content">{body}</div> : null}
        </div>
      )
    }

    // The row's tag slot: plain tags render as one capsule; tool-named tags render one capsule per distinct call
    // name, in first-appearance order, repeats folded into a ×N multiplier ('bash ×3').
    const rowTagNode = (tag: string | null, names: readonly string[] | null): ReactNode => {
      if (tag === null) return null
      if (names === null) return <span className="lc-br-tag">{tag}</span>
      const counts = new Map<string, number>()
      for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1)
      return [...counts.entries()].map(([name, count]) => (
        <span key={name} className="lc-br-tag">{count > 1 ? name + ' ×' + String(count) : name}</span>
      ))
    }

    const catBody = (c: string): ReactNode => {
      if (c === 'system') {
        // No prompt in force at this step. The category only opens without one
        // when there is no header epoch at all (the openable guard above), so
        // the note names the missing PROJECTION — no headers service versus
        // headers that carried no epoch yet.
        const sys = view.system
        if (sys === null) {
          return <div className="lc-br-note">{t(headers === null ? 'browser.noHeader' : 'browser.noEpoch')}</div>
        }
        const content = headerContent.get(sys.seq)
        // Metadata-only until the prompt's event resolves (fetched when the
        // section opens; the note names the state).
        if (content === undefined) return <div className="lc-br-note">{headerNote}</div>
        if (content.system === undefined) return <div className="lc-br-note">{t('browser.noSystem')}</div>
        return elemRow('sys', null, content.system.replace(/\s+/g, ' ').trim().slice(0, 80), breakdown.system, undefined,
          <TextSection label={catLabel('system')} text={content.system} rich={rich} lines={lineLabel} />)
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
        // The epoch's fetched content, joined onto the metadata rows by tool
        // name (the open row's body renders description/params/JSON from it).
        const content = headerContent.get(view.header.seq)
        const contentByName = new Map(content?.tools.map(t => [t.name, t]) ?? [])
        // The text filter scans everything the rows can say: the name, the
        // producer description, the plugin chip, and the raw parameter JSON —
        // the latter two only once the epoch's content is loaded.
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
          // Size order mirrors the overview's Top chips — the producer's header
          // order is not meaningful; count order ranks by the call-hit tally of
          // the shown step's surface (ties break by name); name order gives
          // lookup instead of ranking (names are unique keys, so a two-way
          // comparison orders them fully).
          .sort((a, b) => toolSort === 'count'
            ? (toolHitsOf(b) - toolHitsOf(a) || (a.name < b.name ? -1 : 1))
            : toolSort === 'size'
              ? b.tokens - a.tokens
              : (a.name < b.name ? -1 : 1))
        // The toolbar stays mounted on an empty match, or the filter could
        // never be cleared from the UI.
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
        // The open row's body: the fetched content's description, parameter
        // table, and raw JSON — or the epoch's fetch-state note.
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
              // The registering plugin (best-effort host attribution — see
              // toolSources.ts) trails the tool name as a standalone chip, so it
              // needs no extra frame around it. A tool whose provider predates
              // the attribution hook arrives with the UNKNOWN_TOOL_SOURCE
              // sentinel and renders a localized "unknown plugin" tag whose
              // tooltip explains why no provider is shown. The hit tally always
              // trails — a zero names a definition the shown step never called.
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
                false, trailing)
            })}
          </div>
        )
      }
      // List surface nodes newest first (the live surface's reading order).
      /* v8 ignore next 1 -- the body renders only when the category is open,
         which requires count > 0 ⟺ byCat[c] exists; defensive. */
      const nodes = (byCat[c as Category] ?? []).slice().reverse()
      // Derive each row's display facts first so the text filter scans exactly
      // what the rows show (tag + preview, plus the assistant join's reasoning)
      // at derivation time, not per keystroke; the survivors render unchanged.
      // Identity-labeled injection rows keep their folded content out of the
      // preview, so the filter scans `text` too.
      const rows = nodes.map((n) => {
        const conv = bySeq.get(n.seq)
        // A `skill`-tool load reclassifies into the `skill` bucket (issue #66)
        // but stays a tool result — its failure marking follows the same rule.
        const rowErr = (n.cat === 'tool' || n.cat === 'skill') && toolErrOf(n, conv).err
        // Tag carries the compact fact (tool name, injection form) — one shared subtle chip style; the preview line carries the text — each
        // fact shown once.
        let tag: string | null = null
        // The tool names the tag carries, when it names tools (tool rows, a call breadcrumb) — they render as one
        // capsule per distinct name; every other tag stays a single capsule.
        let tagNames: string[] | null = null
        let preview = nodeText(n)
        const id = nodeNameOf(n)
        if (n.cat === 'tool') {
          tag = n.tool ?? '?'
          tagNames = n.tool !== undefined ? [n.tool] : null
          preview = callSummaryOf(conv) ?? t('node.toolResult')
        } else if (n.cat === 'skill') {
          // Skill content (issue #66): a load/invocation names itself, and a
          // text-less row (an unjoined load) falls back to the call summary;
          // the catalog digest carries no name — its form label tags it and
          // the stamped source identity (e.g. `skill-catalog`) previews.
          tag = n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : t('form.' + (n.form || 'context'))
          preview = (n.skill === undefined && id !== '' ? id : null)
            ?? (n.text !== undefined && n.text !== '' ? n.text : null)
            ?? callSummaryOf(conv) ?? preview
        } else if (n.cat === 'assistant') {
          // The fold stamps `calls` only on TEXT-LESS replies; a reply carrying both text and calls recovers its breadcrumb through the
          // conversation join — the same recovery the step brief applies. The call names join into the tag's scan
          // text (the filter scans what the rows say) and render as one capsule per distinct name; the preview
          // carries the reply text, else the first call's own summary for a text-less turn.
          const names = Array.isArray(n.calls) && n.calls.length > 0 ? n.calls : callNamesOf(conv)
          if (names.length > 0) {
            tag = names.join(' › ')
            tagNames = names
            preview = (n.text !== undefined && n.text !== '' ? n.text : null)
              ?? blockSummaryOf(conv)
              ?? t('node.empty')
          } else if (n.text === undefined || n.text === '') {
            // A text-less turn can still preview a self-summarizing call from the join even when the node carries no call list.
            preview = blockSummaryOf(conv) ?? preview
          }
        } else if (n.cat === 'user') {
          // User messages with image uploads gain an Image chip on the collapsed row (detected via the conversation join, like the expanded
          // body); expanded, the grid shows anyway.
          const imgCount = conv !== undefined && Array.isArray(conv.content)
            ? conv.content.filter(b => imageRefOf(b) !== null).length
            : 0
          if (imgCount > 0 && openElem !== `n${n.seq}`) {
            tag = t('attach.image') + (imgCount > 1 ? ' ×' + String(imgCount) : '')
          }
        } else {
          // The last category ('inject'): the form label tags the row; the
          // source identity (when stamped) is more scannable than the raw
          // content, which stays one expand away.
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
          // The join's reasoning texts feed the scan (assistant rows only — no other category carries them).
          reasoning: n.cat === 'assistant' ? reasoningTextOf(conv) : '',
          kinds: msgKindsOf(n, conv),
        }
      })
      const q = rowQuery.trim().toLowerCase()
      // The assistant category's kind chips: per-kind message counts over ALL
      // of the shown step's rows (the chips report the step's composition, not
      // the text-lens survivors). A picked kind filters to the rows carrying
      // it, intersected with the text query; picking it again clears.
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
      // The toolbar stays mounted on an empty match, or the filter could
      // never be cleared from the UI.
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
          {shown.map(({ n, conv, rowErr, tag, tagNames, preview }) => elemRow(`n${n.seq}`, rowTagNode(tag, tagNames), preview, n.tokens, n.time,
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
              hint={conv?.kind === 'compaction'
                ? fetchContent !== undefined && !Array.isArray(conv.content) ? missNote : null
                : conv === undefined ? missNote : t('browser.noContent')}
            />,
            rowErr))}
        </div>
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

        <div className={'lc-br-bar' + (dna ? ' lc-br-bar-dna' : '')}>
          <StackedBar
            parts={dnaParts ?? parts}
            height={10}
            // Highlight precedence: pointer hover (local in DNA mode, the shared link otherwise) over the open-category pin.
            // The mirrored link (see `linked` above) works while the browser shows the live surface; it is ONE-WAY in DNA
            // mode — an incoming category key lights that category's BANDS (the parts' `group`), while band hovers stay
            // on the bar and never report upward (the overview keeps showing the live category composition). Tip stays
            // off in category mode: a cross-card hover must not float a second tooltip over a bar the pointer does not
            // rest on — and the group-keyed pin never exact-matches a DNA band, so the pinned highlight floats no tip.
            hoverKey={dna ? liveDnaKey ?? linkKey ?? pinKey : linkKey ?? pinKey}
            onHoverKey={dna ? setDnaKey : linked ? props.onHoverKey : undefined}
            tip={dna}
            onPickKey={dna ? pickDna : undefined}
            minBand={dna ? DNA_MIN_BAND : undefined}
          />
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
