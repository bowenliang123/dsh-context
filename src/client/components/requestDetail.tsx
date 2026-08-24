import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import type { StackedBarProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface RequestDetailProps {
  request: RequestRecord | null
  marker?: ContextEventRecord | null
}

export function makeRequestDetail(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
): (props: RequestDetailProps) => ReactNS.ReactElement | null {
  const { t, fmt, fmtTime, catLabel, eventLabel, eventAt } = kit
  return function RequestDetail(props: RequestDetailProps): ReactNS.ReactElement | null {
    const req = props.request
    if (!req) return null
    const isTurn = req.stepCount !== undefined && req.stepCount > 1
    const head = isTurn
      ? t('detail.turn', { t: req.turn ?? 0, n: req.stepCount ?? 0 })
      : t('detail.step', { t: req.turn ?? 0, s: req.step ?? 0 })
    // When this bar carries a boundary event (compaction/prune), the header
    // also shows WHERE the event happened: the gap between the request
    // before and the request after (e.g. "✂ Turn 49 · Step 2→3").
    const marker = props.marker ?? null
    const markerAt = marker !== null ? eventAt(marker) : null
    return (
      <div className="lc-detail">
        <div className="lc-detail-head">
          <b>{head}</b>
          {marker !== null && markerAt !== null
            ? <span className="lc-detail-marker" title={eventLabel(marker)}>{'✂ ' + markerAt}</span>
            : null}
          {isTurn ? <span className="lc-detail-tag">{t('detail.lastStep')}</span> : null}
          <span>{fmtTime(req.time)}</span>
          <span>{t('detail.estTotal', { n: fmt(req.total) })}</span>
          {req.prompt !== undefined
            ? <span className="lc-actual">{t('detail.actual', { n: fmt(req.prompt) })}</span>
            : null}
          {req.output !== undefined
            ? <span>{t('detail.output', { n: fmt(req.output) })}</span>
            : null}
        </div>
        <StackedBar parts={partsOf(req)} height={10} />
        <div className="lc-detail-rows">
          {CATS.map((c) => {
            const v = req[c.key] || 0
            return (
              <div key={c.key} className="lc-detail-row">
                <i style={{ background: c.color }} />
                <span className="lc-detail-label">{catLabel(c.key)}</span>
                <span className="lc-bar-track">
                  <span className="lc-bar-fill" style={{ width: `${req.total > 0 ? v / req.total * 100 : 0}%`, background: c.color }} />
                </span>
                <span className="lc-detail-num">{'≈' + fmt(v)}</span>
                <span className="lc-detail-pct">{req.total > 0 ? `${Math.round(v / req.total * 100)}%` : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
