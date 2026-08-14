/**
 * NodeList — the current model-visible message list (newest first).
 */

import type * as ReactNS from 'react'
import type { SurfaceNode } from '../../shared/types'
import { CATS } from '../categories'
import type { ViewKit } from '../viewkit'

import { React, h } from '../react'

export interface NodeListProps { nodes: SurfaceNode[]; dropped: number }

export function makeNodeList(kit: ViewKit): (props: NodeListProps) => ReactNS.ReactElement {
  const { t, tr, fmt, fmtTime } = kit

  function nodeText(n: SurfaceNode): string {
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

  return function NodeList(props: NodeListProps): ReactNS.ReactElement {
    if (props.nodes.length === 0) {
      return h('div', { className: 'lc-empty' }, t('nodes.empty'))
    }
    const catColor: Record<string, string> = {}
    for (const c of CATS) catColor[c.key] = c.color
    const rows = props.nodes.slice().reverse()
    return h('div', { className: 'lc-nodes' },
      props.dropped > 0 ? h('div', { className: 'lc-nodes-more' }, tr('nodes.more', { n: props.dropped })) : null,
      rows.map(n => {
        const text = nodeText(n)
        return h('div', { key: n.seq, className: 'lc-node' },
          h('i', { style: { background: catColor[n.cat] || '#999' } }),
          h('span', { className: 'lc-node-preview', title: text }, text),
          // Timestamp when the host event carried one.
          typeof n.time === 'number' ? h('span', { className: 'lc-node-time' }, fmtTime(n.time)) : null,
          h('span', { className: 'lc-node-tokens' }, fmt(n.tokens)))
      }))
  }
}
