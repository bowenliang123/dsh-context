import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { partsOf, CATS } from '../categories'
import { cacheHitPercent } from '../format'
import type { StackedBarProps } from './stackedBar'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface RequestDetailProps {
  request: RequestRecord | null
  /**
   * Delta mode: the record displayed just before this one (null on the first
   * bar). Its PRESENCE switches the panel from cumulative makeup to the signed
   * change against that previous record — the same pairing the chart's
   * deltaOf plots.
   */
  prev?: RequestRecord | null
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
    // Delta mode: per-category SIGNED change vs the previous record (the chart stacks them diverging
    // above/below its zero line); provider usage chips drop out — prompt/output/cacheRead are
    // per-request figures, not deltas.
    const delta = props.prev !== undefined
    const prev = props.prev ?? null
    const deltas = CATS.map(c => delta ? (req[c.key] || 0) - (prev !== null ? prev[c.key] || 0 : 0) : 0)
    let net = 0
    let maxAbs = 0
    if (delta) {
      for (const d of deltas) {
        net += d
        if (Math.abs(d) > maxAbs) maxAbs = Math.abs(d)
      }
    }
    const parts = delta
      ? CATS.map((c, i) => ({ key: c.key, color: c.color, value: Math.abs(deltas[i]) }))
      : partsOf(req)
    return (
      <div className="lc-detail">
        <div className="lc-detail-head">
          <b>{head}</b>
          {marker !== null && markerAt !== null
            ? <span className="lc-detail-marker" title={eventLabel(marker)}>{'✂ ' + markerAt}</span>
            : null}
          {isTurn ? <span className="lc-detail-tag">{t('detail.lastStep')}</span> : null}
          {delta ? <span className="lc-detail-tag">{t('gran.delta')}</span> : null}
          <span className="lc-detail-time">{fmtTime(req.time)}</span>
          {/* Metric chips: one neutral pill per provider figure; the cache figure drops out on hosts
              that do not fold `cacheRead` (and on usage-less requests). */}
          {delta ? (
            <span className={'lc-detail-metric' + (net > 0 ? ' lc-detail-metric-up' : net < 0 ? ' lc-detail-metric-down' : '')}>
              {t('tip.delta', { n: (net > 0 ? '+' : '') + fmt(net) })}
            </span>
          ) : null}
          {!delta && req.prompt !== undefined
            ? <span className="lc-detail-metric">{t('detail.actual', { n: fmt(req.prompt) })}</span>
            : null}
          {!delta && req.output !== undefined
            ? <span className="lc-detail-metric">{t('detail.output', { n: fmt(req.output) })}</span>
            : null}
          {!delta && req.prompt !== undefined && req.cacheRead !== undefined
            ? <span className="lc-detail-metric">{t('detail.cache', { n: cacheHitPercent(req.cacheRead, req.prompt) ?? '—' })}</span>
            : null}
        </div>
        <StackedBar parts={parts} height={10} />
        <div className="lc-detail-rows">
          {CATS.map((c, i) => {
            const v = delta ? deltas[i] : req[c.key] || 0
            const mag = Math.abs(v)
            return (
              <div key={c.key} className="lc-detail-row">
                <i style={{ background: c.color }} />
                <span className="lc-detail-label">{catLabel(c.key)}</span>
                <span className="lc-bar-track">
                  {delta ? (
                    <>
                      {/* Mini diverging bar echoing the chart: zero at the middle, growth fills right,
                          shrinkage fills left, one shared scale across the rows. */}
                      <span className="lc-bar-zero" />
                      {v !== 0 ? (
                        <span
                          className={'lc-bar-fill ' + (v > 0 ? 'lc-bar-fill-up' : 'lc-bar-fill-down')}
                          style={{ width: `${mag / maxAbs * 50}%`, background: c.color }}
                        />
                      ) : null}
                    </>
                  ) : (
                    <span className="lc-bar-fill" style={{ width: `${req.total > 0 ? v / req.total * 100 : 0}%`, background: c.color }} />
                  )}
                </span>
                {delta ? (
                  <span className={'lc-detail-num' + (v > 0 ? ' lc-detail-num-up' : v < 0 ? ' lc-detail-num-down' : '')}>
                    {(v > 0 ? '+' : '') + fmt(v)}
                  </span>
                ) : (
                  <span className="lc-detail-num">{'≈' + fmt(v)}</span>
                )}
                <span className="lc-detail-pct">{!delta && req.total > 0 ? `${Math.round(v / req.total * 100)}%` : ''}</span>
              </div>
            )
          })}
        </div>
      </div>
    )
  }
}
