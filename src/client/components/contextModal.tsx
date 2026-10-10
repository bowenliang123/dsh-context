/** The /context command's centered dialog: the same pushed `contextTimeline` data as the Context tab, distilled to the
 * current composition and the shared browser. */

import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { measureDock } from '../dockMeasure'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import type { ContextSettings } from '../settings'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, projectionOf } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(
  ctx: ClientCtx,
  kit: ViewKit,
  settings: ContextSettings,
): (props: ContextModalProps) => ReactElement | null {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar, settings)
  const DetailNote = makeDetailNote(kit)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextModalBody(props: ContextModalProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    // Shares the tab's per-session detail store, so an open tab's detail serves the modal with no refetch.
    const source = useTimelineSource(props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    // Read unconditionally, before the closed early return, so hook order stays stable across open/close.
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [dock, setDock] = useState({ left: 0, right: 0 })
    const backdropRef = useRef<HTMLDivElement | null>(null)
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, sessionId !== '' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // The first render can race the declared inject (a watch rebuild remounts this overlay before the fiber re-fires),
    // so both fetchers below must rebuild when the face lands or is revoked.
    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (sessionId !== '' && historyFace !== undefined ? makeContentFetcher(sessionId) : undefined),
      [sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (sessionId !== '' && historyFace !== undefined ? makeHeaderFetcher(sessionId) : undefined),
      [sessionId, historyFace],
    )

    const close = useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      // The sessions service is read at CLOSE time because capturing it at apply would race the finer module composition.
      const guard = takePendingConsume(sessionId)
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [ctx, sessionId])

    // Capture-phase Escape close + focus restore (the shared overlay contract).
    useEscapeClose(open, close)

    // The sidebar tracks are measured once before first paint, then followed while open: drags, collapse toggles, and
    // narrow-viewport re-solves all rewrite the frame's inline template.
    useLayoutEffect(() => {
      if (!open) return undefined
      const dock = measureDock(backdropRef.current)
      setDock({ left: dock.left, right: dock.right })
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        const next = measureDock(backdropRef.current)
        setDock({ left: next.left, right: next.right })
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [open])

    if (!open) return null

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''

    return (
      <div ref={backdropRef} className="lc-modal-backdrop" style={{ left: dock.left, right: dock.right }} onClick={close}>
        <div className="lc-modal-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('tab.context')}</span>
            <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-bg-layer-2)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {data === null || head === null ? (
            source.detailState === 'failed' ? (
              <DetailNote state="failed" onRetry={source.retryDetail} />
            ) : (
              <div className="lc-empty">{t('loading')}</div>
            )
          ) : (
            <div>
              <CurrentComposition
                head={head}
                subtitle={subtitle}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
              />
              <ContextBrowser
                data={data}
                headers={headers}
                convNodes={convNodes}
                fetchContent={fetchContent}
                fetchHeader={fetchHeader}
                loadImage={loadImage}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
                detailState={source.detailState}
                onDetailRetry={source.retryDetail}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return function ContextModal(props: ContextModalProps): ReactElement | null {
    return h(ErrorBoundary, null, h(ContextModalBody, props))
  }
}
