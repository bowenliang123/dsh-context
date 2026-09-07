/**
 * The /context command's centered dialog — the same data as the Context tab (the pushed `contextTimeline` projection) distilled to the
 * current-composition overview and the shared Context browser; rendered from the `conversation.input.overlay` slot and opened/closed
 * through the per-session modal store, so the trigger flips it and no message ever enters session history.
 */

import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { measureDock } from '../dockMeasure'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, projectionOf } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(ctx: ClientCtx, kit: ViewKit): (props: ContextModalProps) => ReactElement | null {
  const { t } = kit
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextModalBody(props: ContextModalProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    // The timeline source (timelineSource.ts) — shares the tab's per-session
    // detail store, so an open tab's detail serves the modal with no refetch.
    const source = useTimelineSource(ctx, props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    // Conversation-window join for the browser (the seat is a real hook —
    // read unconditionally here, before the closed early return, so the hook
    // order stays stable across open/close).
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    // Dock the mask beside the shell sidebar: 0 until the frame measure lands
    // (the layout effect below resolves it before first paint).
    const [dockLeft, setDockLeft] = useState(0)
    const backdropRef = useRef<HTMLDivElement | null>(null)
    // Session-authorized durable-image loader for the browser's attachment cards, resolved through the harness `uiConversation` service
    // (`imageUrl`); absent service/session degrades the cards to metadata-only, never an error. Same parity as the Context tab.
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, sessionId !== '' ? sessionId : undefined),
      [ctx, sessionId],
    )

    // The gateway page face, as a React seat: the first render can race the declared inject (a watch rebuild remounts this overlay before
    // the fiber re-fires), and both fetchers below must rebuild — not stick to the static degradation — when the face lands or is revoked.
    const historyFace = useHistoryFace()

    // Same targeted content fetch the Context tab wires (one seq-anchored history read per expanded row), plus the on-demand header
    // epoch content read for the browser's system/tools sections.
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
      // Consume the `/context` token now (it stayed in the composer while the modal was open) via the scoped input event — a stale guard
      // (the user typed meanwhile) fails soft inside the shell and leaves the draft untouched. The sessions service is read at CLOSE time:
      // capturing it at apply would race the finer module composition (`ctx.get` is the inject-free reflect read — undefined, never a
      // throw, when the service is not composed).
      const guard = takePendingConsume(sessionId)
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [ctx, sessionId])

    // Capture-phase Escape close + focus restore (the shared overlay contract).
    useEscapeClose(open, close)

    // Dock the mask to the main column: measure the sidebar track once before
    // first paint, then follow the frame's inline template while open (sidebar
    // drags, collapse toggles and narrow-viewport re-solves all rewrite it).
    // An unresolved frame keeps the full-viewport mask.
    useLayoutEffect(() => {
      if (!open) return undefined
      const dock = measureDock(backdropRef.current)
      setDockLeft(dock.left)
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        setDockLeft(measureDock(backdropRef.current).left)
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [open])

    if (!open) return null

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''

    return (
      <div ref={backdropRef} className="lc-modal-backdrop" style={{ left: dockLeft }} onClick={close}>
        <div className="lc-modal-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('tab')}</span>
            <button className="lc-modal-close" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {data === null || head === null ? (
            <div className="lc-empty">{t('loading')}</div>
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
