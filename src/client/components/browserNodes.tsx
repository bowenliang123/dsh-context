import type { ReactElement, ReactNode } from 'react'
import type { Category, SurfaceNode } from '../../shared/types'
import type { Assembled } from '../../shared/assemble'
import type { ConversationNodeLike } from '../services'
import type { AttachmentKit } from './attachments'
import type { RichKit } from './richText'
import { TextSection, BlocksBody, toolErrOf, ToolCallCard } from './browserToolCard'
import type { DetailLabels } from './browserToolCard'

export function NodeContent(props: {
  node: SurfaceNode
  conv: ConversationNodeLike | undefined
  hint: ReactNode
  rich: RichKit
  att: AttachmentKit
  labels: DetailLabels
}): ReactElement {
  const { node, conv, rich, att, labels } = props
  if (conv === undefined) {
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
    return <BlocksBody blocks={conv.blocks} textLabel={labels.answer} rich={rich} att={att} labels={labels} />
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
          ? <BlocksBody blocks={conv.content} textLabel={labels.result} rich={rich} att={att} labels={labels} />
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
    return <BlocksBody blocks={conv.content} textLabel={labels.content} rich={rich} att={att} labels={labels} />
  }
  return <div className="lc-br-note">{props.hint}</div>
}

export function byCatOf(asm: Assembled): Partial<Record<Category, SurfaceNode[]>> {
  const m: Partial<Record<Category, SurfaceNode[]>> = {}
  for (const n of asm.nodes) (m[n.cat] ??= []).push(n)
  return m
}

export function nodeNameOf(n: SurfaceNode): string {
  return typeof n.name === 'string' ? n.name : ''
}

export function msgKindsOf(n: SurfaceNode, conv: ConversationNodeLike | undefined): { think: boolean; tool: boolean; answer: boolean } {
  let think = false
  let tool = false
  for (const blocks of [conv?.blocks, conv?.content]) {
    if (!Array.isArray(blocks)) continue
    for (const b of blocks) {
      const blk = b !== null && typeof b === 'object' ? b as { type?: unknown; kind?: unknown } : null
      const k = blk !== null
        ? typeof blk.kind === 'string' ? blk.kind : typeof blk.type === 'string' ? blk.type : ''
        : ''
      if (k === 'reasoning') think = true
      else if (k === 'tool-call') tool = true
    }
  }
  return {
    think,
    tool: tool || (Array.isArray(n.calls) && n.calls.length > 0),
    answer: typeof n.text === 'string' && n.text !== '',
  }
}

export function reasoningTextOf(conv: ConversationNodeLike | undefined): string {
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

export const ROW_KINDS = ['think', 'tool', 'answer'] as const
export type RowKind = (typeof ROW_KINDS)[number]
