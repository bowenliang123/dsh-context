import { useMemo, useState, type ReactElement, type ReactNode } from 'react'
import type { SurfaceNode } from '../../shared/types'
import type { ConversationNodeLike } from '../services'
import { parseCallArgs } from '../callSummary'
import { attachmentOf } from '../../shared/attachment'
import type { AttachmentRef } from '../../shared/attachment'
import type { AttachmentKit } from './attachments'
import type { RichKit } from './richText'
import { ClearableInput } from './clearableInput'
import { Section } from './section'
import { typeOf, paramsOf } from './browserSchema'
import type { ParamSchema } from './browserSchema'
import { fmt } from '../format'

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

function lineCountOf(text: string): number {
  return text.split(/\r\n|\r|\n/).length
}

export function TextSection(props: {
  label: string
  text: string
  rich: RichKit
  lines: (n: number) => string
}): ReactElement {
  const { rich } = props
  const view = rich.useRichView(props.text)
  const lineCount = useMemo(() => lineCountOf(props.text), [props.text])
  return (
    <Section
      label={props.label}
      foldHead
      actions={view.tools}
      meta={<span className="lc-ts-card-meta">{props.lines(lineCount)}</span>}
    >
      {view.body}
    </Section>
  )
}

export function schemaTextOf(schema: unknown): string {
  try {
    return JSON.stringify(schema ?? '')
  } catch {
    return ''
  }
}

export function RowToolbar(props: {
  value: string
  placeholder: string
  clearLabel: string
  count: number
  tokens: number
  tip?: string
  onChange: (v: string) => void
  children?: ReactNode
}): ReactElement {
  return (
    <div className="lc-br-toolctl">
      <ClearableInput
        className="lc-br-tool-search"
        value={props.value}
        placeholder={props.placeholder}
        clearLabel={props.clearLabel}
        onChange={props.onChange}
      />
      <span className="lc-br-filter-stat">{'×' + fmt(props.count) + ' ≈' + fmt(props.tokens)}</span>
      {props.children !== undefined
        ? <span className="lc-gran" role="group" title={props.tip}>{props.children}</span>
        : null}
    </div>
  )
}



export function ToolSchema(props: {
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

export interface DetailLabels {
  thinking: string
  answer: string
  content: string
  result: string
  summary: string
  other: string
  lines: (n: number) => string
  callState: (err: boolean, exit: number | null) => ReactNode
}

export function BlocksBody(props: {
  blocks: readonly unknown[]
  textLabel: string
  rich: RichKit
  att: AttachmentKit
  labels: DetailLabels
}): ReactElement {
  const { rich, att, labels } = props
  const out: ReactNode[] = []
  const refs = props.blocks.map(attachmentOf)
  const attachments = refs.filter((ref): ref is AttachmentRef => ref !== null)
  const firstAt = refs.findIndex(ref => ref !== null)
  for (const [i, b] of props.blocks.entries()) {
    if (i === firstAt) {
      out.push(
        <att.Section
          key={'att' + String(out.length)}
          attachments={attachments}
          load={att.load}
          open={att.open}
        />,
      )
    }
    if (refs[i] !== null) continue
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
        textLabel={labels.result}
        rich={rich}
        att={att}
        labels={labels}
      />)
      continue
    }
    out.push(<Section key={out.length} label={labels.other}><pre className="lc-ts-desc-body lc-br-dim">{JSON.stringify(b, null, 2)}</pre></Section>)
  }
  return <>{out}</>
}

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

export function toolErrOf(node: SurfaceNode, conv: ConversationNodeLike | undefined): { err: boolean; exit: number | null } {
  const tail = tailStatusOf(conv)
  const err = node.err === true || conv?.isError === true || tail.fail
  return { err, exit: tail.exit }
}

export function ToolCallCard(props: {
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
  /* v8 ignore next 2 */
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

