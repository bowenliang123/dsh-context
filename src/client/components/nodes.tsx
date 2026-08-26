/** The one-line label cascade shared by the Context browser's element rows. */

import type { SurfaceNode } from '../../shared/types'
import type { ViewKit } from '../viewkit'

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
