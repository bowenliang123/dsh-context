/**
 * RequestDetail — the breakdown panel under the history chart for the
 * active (hovered/pinned/newest) request. The header names the request and,
 * when the bar carries a boundary event, a ✂ chip shows where the event
 * happened (the gap between the request before and after).
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import type { StackedBarProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

const React: typeof ReactNS = require('react')
const h = React.createElement

export interface RequestDetailProps {
  request: RequestRecord | null
  /** The boundary event attached to this request (✂ chip in the header). */
  marker?: ContextEventRecord | null
}

export function makeRequestDetail(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
): (props: RequestDetailProps) => ReactNS.ReactElement | null {
  const { t, tr, fmt, fmtTime, catLabel, eventLabel, eventAt } = kit
  return function RequestDetail(props: RequestDetailProps): ReactNS.ReactElement | null {
    const req = props.request
    if (!req) return null
    // Turn aggregates are labeled with their step count, and the breakdown
    // below is explicitly tagged as the turn's LAST step (that is the record
    // the bar carries).
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? tr('detail.turn', { t: req.turn ?? 0, n: req.stepCount ?? 0 })
      : tr('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
    // When this bar carries a boundary event (compaction/prune), the header
    // also shows WHERE the event happened: the gap between the request
    // before and the request after (e.g. "✂ Turn 49 · Step 2→3").
    const marker = props.marker ?? null
    const markerAt = marker !== null ? eventAt(marker) : null
    return h('div', { className: 'lc-detail' },
      h('div', { className: 'lc-detail-head' },
        h('b', null, head),
        marker !== null && markerAt !== null
          ? h('span', { className: 'lc-detail-marker', title: eventLabel(marker) }, '✂ ' + markerAt)
          : null,
        isTurn ? h('span', { className: 'lc-detail-tag' }, t('detail.lastStep')) : null,
        h('span', null, fmtTime(req.time)),
        h('span', null, tr('detail.estTotal', { n: fmt(req.total) })),
        req.prompt !== undefined ? h('span', { className: 'lc-actual' }, tr('detail.actual', { n: fmt(req.prompt) })) : null,
        req.output !== undefined ? h('span', null, tr('detail.output', { n: fmt(req.output) })) : null),
      h(StackedBar, { parts: partsOf(req), height: 10 }),      h('div', { className: 'lc-detail-rows' },
        CATS.map(c => {
          const v = req[c.key] || 0
          return h('div', { key: c.key, className: 'lc-detail-row' },
            h('i', { style: { background: c.color } }),
            h('span', { className: 'lc-detail-label' }, catLabel(c.key)),
            h('span', { className: 'lc-bar-track' },
              h('span', { className: 'lc-bar-fill', style: { width: (req.total > 0 ? v / req.total * 100 : 0) + '%', background: c.color } })),
            h('span', { className: 'lc-detail-num' }, fmt(v)),
            h('span', { className: 'lc-detail-pct' }, req.total > 0 ? Math.round(v / req.total * 100) + '%' : ''))
        })))
  }
}
