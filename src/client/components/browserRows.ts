import { formLabelOf } from '../labels'
import type { SurfaceNode } from '../../shared/types'
import type { ViewKit } from '../viewkit'
import type { ConversationNodeLike } from '../services'
import { attachmentsIn } from '../../shared/attachment'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import { msgKindsOf, nodeNameOf, reasoningTextOf } from './browserNodes'
import { toolErrOf } from './browserToolCard'

export interface NodeRow {
  n: SurfaceNode
  conv: ConversationNodeLike | undefined
  rowErr: boolean
  tag: string | null
  tagNames: string[] | null
  preview: string
  reasoning: string
  kinds: ReturnType<typeof msgKindsOf>
}

export function makeNodeRowOf(
  kit: ViewKit,
  nodeText: (n: SurfaceNode) => string,
  bySeq: ReadonlyMap<number, ConversationNodeLike>,
  openElem: string | null,
): (n: SurfaceNode) => NodeRow {
  const { t } = kit
  return function nodeRowOf(n: SurfaceNode): NodeRow {
    const conv = bySeq.get(n.seq)
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
      tag = n.skill !== undefined ? t('node.skillTag', { name: n.skill }) : formLabelOf(t, n.form)
      preview = (n.skill === undefined && id !== '' ? id : null)
        ?? (n.text !== undefined && n.text !== '' ? n.text : null)
        ?? callSummaryOf(conv) ?? preview
    } else if (n.cat === 'assistant') {
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
      tag = formLabelOf(t, n.form)
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
}

export function rowMatches(r: NodeRow, q: string): boolean {
  return (r.tag ?? '').toLowerCase().includes(q) || r.preview.toLowerCase().includes(q)
    || (typeof r.n.text === 'string' && r.n.text.toLowerCase().includes(q))
    || r.reasoning.toLowerCase().includes(q)
}
