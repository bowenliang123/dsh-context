import { formLabelOf } from '../labels'
import type { Category, HeaderEpochContent, HeaderTool, SurfaceNode } from '../../shared/types'
import type { DefaultToolSort } from '../settings'
import type { ViewKit } from '../viewkit'
import type { ConversationNodeLike } from '../services'
import { attachmentsIn } from '../../shared/attachment'
import { blockSummaryOf, callNamesOf, callSummaryOf } from '../callSummary'
import { ROW_KINDS, msgKindsOf, nodeNameOf, reasoningTextOf } from './browserNodes'
import type { RowKind } from './browserNodes'
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
      if (n.agent !== undefined) preview = preview + ' · ' + n.agent
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

export function flatNodesModelOf(
  nodes: readonly SurfaceNode[],
  query: string,
  seqs: ReadonlySet<number> | null,
  nodeRowOf: (n: SurfaceNode) => NodeRow,
): { entries: { r: NodeRow; pos: number }[]; tokens: number } {
  const q = query.trim().toLowerCase()
  const entries: { r: NodeRow; pos: number }[] = []
  let tokens = 0
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i]
    if (seqs !== null && !seqs.has(n.seq)) continue
    const r = nodeRowOf(n)
    if (q !== '' && !rowMatches(r, q)) continue
    entries.push({ r, pos: i + 1 })
    tokens += r.n.tokens
  }
  return { entries, tokens }
}

export interface CatNodesModel {
  c: Category
  rows: NodeRow[]
  matched: NodeRow[]
  shown: NodeRow[]
  kindCounts: readonly { k: RowKind; n: number }[] | null
  shownTokens: number
}

export function catNodesModelOf(
  nodes: readonly SurfaceNode[],
  c: Category,
  query: string,
  rowKind: RowKind | null,
  nodeRowOf: (n: SurfaceNode) => NodeRow,
  fullTokens: number,
): CatNodesModel {
  const rows = nodes.slice().reverse().map(nodeRowOf)
  const q = query.trim().toLowerCase()
  const matched = q === '' ? rows : rows.filter(r => rowMatches(r, q))
  const kindCounts = c === 'assistant'
    ? ROW_KINDS.map(k => ({ k, n: matched.reduce((acc, r) => acc + (r.kinds[k] ? 1 : 0), 0) }))
    : null
  const shown = rowKind === null ? matched : matched.filter(r => r.kinds[rowKind])
  const shownTokens = shown.length === rows.length
    ? fullTokens
    : shown.reduce((sum, r) => sum + r.n.tokens, 0)
  return { c, rows, matched, shown, kindCounts, shownTokens }
}

export interface CatToolsModel {
  shown: HeaderTool[]
  contentByName: Map<string, HeaderEpochContent['tools'][number]>
  shownTokens: number
}

export function catToolsModelOf(
  tools: readonly HeaderTool[],
  content: HeaderEpochContent | undefined,
  query: string,
  sort: DefaultToolSort,
  hitsOf: (tool: HeaderTool) => number,
  fullTokens: number,
  schemaText: (schema: unknown) => string,
): CatToolsModel {
  const contentByName = new Map(content?.tools.map(row => [row.name, row] as const) ?? [])
  const q = query.trim().toLowerCase()
  const shown = tools
    .filter((tool) => {
      if (q === '') return true
      if (tool.name.toLowerCase().includes(q)) return true
      if ((tool.plugin ?? '').toLowerCase().includes(q)) return true
      const row = contentByName.get(tool.name)
      if (row === undefined) return false
      return (row.description ?? '').toLowerCase().includes(q)
        || schemaText(row.schema).toLowerCase().includes(q)
    })
    .sort((a, b) => sort === 'count'
      ? (hitsOf(b) - hitsOf(a) || (a.name < b.name ? -1 : 1))
      : sort === 'size'
        ? b.tokens - a.tokens
        : (a.name < b.name ? -1 : 1))
  const allPrices = tools.reduce((sum, tool) => sum + tool.tokens, 0)
  const shownPrices = shown.reduce((sum, tool) => sum + tool.tokens, 0)
  /* v8 ignore next 1 */
  const shownTokens = allPrices > 0 ? Math.round(fullTokens * shownPrices / allPrices) : 0
  return { shown, contentByName, shownTokens }
}
