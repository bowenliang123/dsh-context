/**
 * StatsBoard — the session context statistics card above the composition:
 * conversation size (turns/steps), context churn (recycled tokens from
 * compactions/prunes, injection and model-switch counts), and volume
 * (estimated totals plus provider-reported prompt/output sums). All figures
 * cover the retained history window, matching the History chart.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import type { ViewKit } from '../viewkit'

import { React, h } from '../react'

export function makeStatsBoard(kit: ViewKit): (props: {
  requests: RequestRecord[]
  events: ContextEventRecord[]
}) => ReactNS.ReactElement {
  const { t, tr, fmt } = kit
  return function StatsBoard(props: {
    requests: RequestRecord[]
    events: ContextEventRecord[]
  }): ReactNS.ReactElement {
    const turns = new Set<number>()
    let steps = 0, compactions = 0, prunes = 0, injects = 0, switches = 0
    let recycled = 0, est = 0, prompt = 0, output = 0
    for (const req of props.requests) {
      turns.add(req.turn ?? 0)
      steps++
      est += req.total
      if (typeof req.prompt === 'number') prompt += req.prompt
      if (typeof req.output === 'number') output += req.output
    }
    for (const ev of props.events) {
      if (ev.kind === 'compaction') { compactions++; recycled += ev.tokens || 0 }
      else if (ev.kind === 'prune') { prunes++; recycled += ev.tokens || 0 }
      else if (ev.kind === 'inject') injects++
      else if (ev.kind === 'model') switches++
    }
    const cell = (label: string, value: string, sub?: string) =>
      h('div', { className: 'lc-stat' },
        h('span', { className: 'lc-stat-label' }, label),
        h('b', { className: 'lc-stat-value' }, value),
        sub !== undefined ? h('span', { className: 'lc-stat-sub' }, sub) : null)
    return h('div', { className: 'lc-card' },
      h('div', { className: 'lc-card-title' },
        t('stats.title'),
        h('span', { className: 'lc-card-sub' }, t('stats.hint'))),
      h('div', { className: 'lc-stats' },
        cell(t('stats.turns'), fmt(turns.size)),
        cell(t('stats.steps'), fmt(steps)),
        cell(t('stats.recycled'), recycled > 0 ? '−' + fmt(recycled) : '0',
          tr('stats.recycleSub', { c: compactions, p: prunes })),
        cell(t('stats.injects'), fmt(injects)),
        cell(t('stats.switches'), fmt(switches)),
        cell(t('stats.est'), '≈ ' + fmt(est)),
        cell(t('stats.actualPrompt'), fmt(prompt)),
        cell(t('stats.output'), fmt(output))))
  }
}
