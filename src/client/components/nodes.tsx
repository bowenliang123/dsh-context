import type * as ReactNS from 'react'
import type { SurfaceNode } from '../../shared/types'
import { CAT_COLORS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface NodeListProps { nodes: SurfaceNode[]; dropped: number }

export function makeNodeText(kit: ViewKit): (n: SurfaceNode) => string {
  const { t } = kit
  return function nodeText(n: SurfaceNode): string {
    if (n.cat === 'tool') {
      return t('node.toolResult') + (n.tool ? ' ← ' + n.tool : '') + (n.err ? ' ⚠' : '')
    }
    if (n.skill) return 'Skill: ' + n.skill
    if (n.calls) return t('node.calls') + n.calls.join(', ')
    if (n.text) return n.form === 'snapshot' ? t('node.snapshot') + n.text : n.text
    if (n.cat === 'assistant') return t('node.empty')
    if (n.cat === 'inject') return t('form.' + (n.form || 'context'))
    return t('node.nonText')
  }
}

export function makeNodeList(kit: ViewKit): (props: NodeListProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime } = kit
  const nodeText = makeNodeText(kit)

  return function NodeList(props: NodeListProps): ReactNS.ReactElement {
    if (props.nodes.length === 0) {
      return <div className="lc-empty">{t('nodes.empty')}</div>
    }
    const rows = props.nodes.slice().reverse()
    return (
      <div className="lc-nodes">
        {props.dropped > 0
          ? <div className="lc-nodes-more">{t('nodes.more', { n: props.dropped })}</div>
          : null}
        {rows.map((n) => {
          const text = nodeText(n)
          return (
            <div key={n.seq} className="lc-node">
              <i style={{ background: CAT_COLORS[n.cat] || '#999' }} />
              <span className="lc-node-preview" title={text}>{text}</span>
              {typeof n.time === 'number' ? <span className="lc-node-time">{fmtTime(n.time)}</span> : null}
              <span className="lc-node-tokens">{fmt(n.tokens)}</span>
            </div>
          )
        })}
      </div>
    )
  }
}
