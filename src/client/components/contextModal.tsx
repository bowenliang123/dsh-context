/**
 * ContextModal — the /context command's centered dialog: the same data as
 * the Context tab (the pushed `contextTimeline` projection) distilled to
 * the overview (headline + composition bar + legend) and the last-10-turn
 * trend chart. Rendered from the `conversation.input.overlay` slot; opens
 * and closes through the per-session modal store (the trigger source flips
 * it, so no message ever enters the session history).
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord, RequestRecord } from '../../shared/types'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import { contextPressureOf, timelineOf } from '../services'
import type { ViewKit } from '../viewkit'
import { makeRequestDetail } from './requestDetail'
import { makeLegend, makeStackedBar } from './stackedBar'
import { aggregateByTurn, attachMarkers, makeTrendChart } from './trendChart'

import { React } from '../react'

/** How many of the most recent turns the modal's trend chart shows. */
const TREND_TURNS = 10

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(ctx: ClientCtx, kit: ViewKit): (props: ContextModalProps) => ReactNS.ReactElement | null {
  const { t, fmt } = kit
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const TrendChart = makeTrendChart(kit)
  const RequestDetail = makeRequestDetail(kit, StackedBar)

  return function ContextModal(props: ContextModalProps): ReactNS.ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    const data = typeof props.useProjection === 'function'
      ? timelineOf(props.useProjection('contextTimeline'))
      : null
    // Provider-anchored occupancy from the official token-meter
    // `contextPressure` projection (same key the chat ring reads); absent
    // value degrades to the derived fallback inside headlineOf.
    const pressure = typeof props.useProjection === 'function'
      ? contextPressureOf(props.useProjection('contextPressure'))
      : null
    const [selectedSeq, setSelectedSeq] = React.useState<number | null>(null)
    const [hoveredSeq, setHoveredSeq] = React.useState<number | null>(null)
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)

    const close = React.useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      // Deferred token consumption: the `/context` token stayed in the
      // composer while the modal was open; consume it now through the scoped
      // input event (a stale guard — the user typed meanwhile — fails soft
      // inside the shell and leaves the draft untouched).
      const guard = takePendingConsume(sessionId)
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [sessionId])

    // Escape closes; on open the current focus (the composer) is captured
    // and restored on close, so typing resumes exactly where it stopped.
    React.useEffect(() => {
      if (!open) return undefined
      const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
      const onKey = (ev: KeyboardEvent) => {
        if (ev.key !== 'Escape') return
        ev.preventDefault()
        ev.stopPropagation()
        close()
      }
      window.addEventListener('keydown', onKey, true)
      return () => {
        window.removeEventListener('keydown', onKey, true)
        if (previous !== null && document.contains(previous)) previous.focus()
      }
    }, [open, close])

    if (!open) return null

    const requests = data !== null ? data.requests || [] : []
    const events = data !== null ? data.events || [] : []
    // One bar per turn (each turn shown by its last step), newest 10 only.
    const turns = aggregateByTurn(requests).slice(-TREND_TURNS)
    const markers = attachMarkers(turns, events)

    let pinnedReq: RequestRecord | null = null
    for (const req of turns) if (req.seq === selectedSeq) pinnedReq = req
    let activeReq: RequestRecord | null = null
    if (hoveredSeq !== null) {
      for (const req of turns) if (req.seq === hoveredSeq) activeReq = req
    }
    if (activeReq === null) activeReq = pinnedReq
    if (activeReq === null && turns.length > 0) activeReq = turns[turns.length - 1]
    const markerOf = (req: RequestRecord): ContextEventRecord | undefined => {
      const i = turns.indexOf(req)
      return i >= 0 ? markers[i] : undefined
    }

    const head = data !== null ? headlineOf(data, pressure) : null

    return (
      <div className="lc-modal-backdrop" onClick={close}>
        <div className="lc-modal-card" onClick={ev => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('tab')}</span>
            {data !== null && (data.model || data.provider) ? (
              <span className="lc-card-sub">
                {(data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '')}
              </span>
            ) : null}
            <button className="lc-modal-close" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {data === null || head === null ? (
            <div className="lc-empty">{t('loading')}</div>
          ) : (
            <div>
              <div className="lc-overview-num">
                <b>{fmt(head.tokens)}</b>
                <span>
                  {head.window
                    ? ' / ' + fmt(head.window) + ' tokens'
                    : ' ' + t('overview.estimate')}
                </span>
                {head.pct !== null ? (
                  <span className="lc-overview-pct">
                    <b>{head.pct + '%'}</b>
                    {t('overview.used')}
                  </span>
                ) : null}
              </div>
              <StackedBar parts={head.parts} height={16} max={head.window} hoverKey={hoverCat} onHoverKey={setHoverCat} />
              <Legend parts={head.parts} hoverKey={hoverCat} onHoverKey={setHoverCat} />

              <div className="lc-card-title lc-modal-trend"><span className="lc-card-title-text">{t('trend.title')}</span></div>
              {turns.length === 0 ? (
                <div className="lc-empty">{t('trend.empty')}</div>
              ) : (
                <div>
                  <TrendChart
                    requests={turns}
                    markers={markers}
                    selectedSeq={pinnedReq !== null ? pinnedReq.seq : null}
                    hoveredSeq={hoveredSeq}
                    activeTurn={null}
                    granularity="turn"
                    onSelect={setSelectedSeq}
                    onHover={setHoveredSeq}
                    onHoverTurn={() => {}}
                  />
                  <RequestDetail request={activeReq} marker={activeReq !== null ? markerOf(activeReq) : undefined} />
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }
}
