import { createElement as h, useCallback, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { providerModelLabelOf } from '../agentTree'
import { makeAttachmentOpener } from '../attachmentSource'
import { measureDock } from '../dockMeasure'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import type { ContextSettings } from '../settings'
import { contextBreakdownOf, contextPressureOf, conversationNodesOf, headersOf, imageLoaderOf, projectionOf, seatKeyOf, seatOf, sessionAddressOf, workspaceOf } from '../services'
import { makeContentFetcher, makeHeaderFetcher, useHistoryFace } from '../historyPage'
import { useSessionDetailWarm } from '../prefetch'
import { useTimelineSource } from '../timelineSource'
import type { ViewKit } from '../viewkit'
import { useConversationSurface } from './useConversationSurface'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeDetailNote } from './detailNote'
import { makeErrorBoundary } from './errorBoundary'
import { useEscapeClose } from './escapeClose'
import { makeLegend, makeStackedBar } from './stackedBar'

export interface ContextModalProps extends SessionStandardProps {
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
  warm?: boolean
}

type ModalSeat = NonNullable<ContextModalProps['useContextModal']>

const NO_MODAL: ModalSeat = () => false

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

  function activeLocale(): string {
    const locale = ctx.locale
    /* v8 ignore next 1 */
    return typeof locale.getLocale === 'function' ? locale.getLocale().active : 'en'
  }

  function ContextModalGate(props: ContextModalProps): ReactElement | null {
    const warm = props.warm === true
    const open = seatOf(props.useContextModal, NO_MODAL)
    useSessionDetailWarm(warm ? props.sessionId : undefined, warm ? props.useProjection : undefined)
    return open(s => s) ? h(ContextModalBody, props) : null
  }

  function ContextModalBody(props: ContextModalProps): ReactElement {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const source = useTimelineSource(props)
    const data = source.data
    const pressure = projectionOf(props, 'contextPressure', contextPressureOf)
    const breakdown = projectionOf(props, 'contextBreakdown', contextBreakdownOf)
    const headers = projectionOf(props, 'contextHeaders', headersOf)
    const convNodes = conversationNodesOf(props)
    const [hoverCat, setHoverCat] = useState<string | null>(null)
    const [dock, setDock] = useState({ left: 0, right: 0 })
    const backdropRef = useRef<HTMLDivElement | null>(null)
    useConversationSurface(backdropRef, 'modal')
    const loadImage = useMemo(
      () => imageLoaderOf(ctx, sessionId !== '' ? sessionId : undefined),
      [ctx, sessionId],
    )
    const openAttachment = useMemo(
      () => makeAttachmentOpener(ctx, sessionId !== '' ? sessionId : undefined, workspaceOf(ctx, sessionId !== '' ? sessionId : undefined)),
      [ctx, sessionId],
    )

    const historyFace = useHistoryFace()

    const fetchContent = useMemo(
      () => (sessionId !== '' && historyFace !== undefined
        ? makeContentFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )
    const fetchHeader = useMemo(
      () => (sessionId !== '' && historyFace !== undefined
        ? makeHeaderFetcher(() => sessionAddressOf(ctx, sessionId))
        : undefined),
      [ctx, sessionId, historyFace],
    )

    const close = useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      const guard = takePendingConsume(sessionId)
      const sessions = ctx.get('sessions') as SessionsFace | undefined
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [ctx, sessionId])

    useEscapeClose(true, close)

    useLayoutEffect(() => {
      const dock = measureDock(backdropRef.current)
      setDock({ left: dock.left, right: dock.right })
      if (dock.frame === null) return undefined
      const observer = new MutationObserver(() => {
        const next = measureDock(backdropRef.current)
        setDock({ left: next.left, right: next.right })
      })
      observer.observe(dock.frame, { attributes: true, attributeFilter: ['style'] })
      return () => { observer.disconnect() }
    }, [])

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? providerModelLabelOf(data.provider, data.model, data.reasoningEffort) : ''

    return (
      <div ref={backdropRef} className="lc-modal-backdrop" style={{ left: dock.left, right: dock.right }} onClick={close}>
        <div className="lc-modal-card lc-modal-fill" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('tab.context')}</span>
            <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-interactive-bg-hover)" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>

          {data === null || head === null ? (
            source.detailState === 'failed' ? (
              <DetailNote state="failed" onRetry={source.retryDetail} />
            ) : (
              <div className="lc-empty">{t('loading')}</div>
            )
          ) : (
            <div className="lc-modal-body">
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
                openAttachment={openAttachment}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
                detailState={source.detailState}
                onDetailRetry={source.retryDetail}
                locale={activeLocale()}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return function ContextModal(props: ContextModalProps): ReactElement | null {
    const key = `${props.warm === true ? 'warm' : 'cold'}:${seatKeyOf(props)}`
    return h(ErrorBoundary, null, h(ContextModalGate, { ...props, key }))
  }
}
