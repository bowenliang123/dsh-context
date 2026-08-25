/**
 * The /context command's centered dialog — the same data as the Context tab (the pushed `contextTimeline` projection) distilled to the
 * current-composition overview and the shared Context browser; rendered from the `conversation.input.overlay` slot and opened/closed
 * through the per-session modal store, so the trigger flips it and no message ever enters session history.
 */

import type * as ReactNS from 'react'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import { contextBreakdownOf, contextPressureOf, headersOf, timelineOf } from '../services'
import { makeContentFetcher } from '../historyPage'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeErrorBoundary } from './errorBoundary'
import { makeLegend, makeStackedBar } from './stackedBar'

import { React, h } from '../react'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(ctx: ClientCtx, kit: ViewKit): (props: ContextModalProps) => ReactNS.ReactElement | null {
  const { t } = kit
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar)
  const ErrorBoundary = makeErrorBoundary(t)

  function ContextModalBody(props: ContextModalProps): ReactNS.ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const open = typeof props.useContextModal === 'function' ? props.useContextModal(s => s) : false
    const data = typeof props.useProjection === 'function'
      ? timelineOf(props.useProjection('contextTimeline'))
      : null
    const pressure = typeof props.useProjection === 'function'
      ? contextPressureOf(props.useProjection('contextPressure'))
      : null
    const breakdown = typeof props.useProjection === 'function'
      ? contextBreakdownOf(props.useProjection('contextBreakdown'))
      : null
    const headers = typeof props.useProjection === 'function'
      ? headersOf(props.useProjection('contextHeaders'))
      : null
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    // Same targeted content fetch the Context tab wires (one seq-anchored history read per expanded row).
    const fetchContent = React.useMemo(
      () => (sessionId !== '' ? makeContentFetcher(ctx, sessionId) : undefined),
      [ctx, sessionId],
    )

    const close = React.useCallback(() => {
      if (sessionId === '') return
      modalStoreOf(sessionId).set(false)
      // Consume the `/context` token now (it stayed in the composer while the modal was open) via the scoped input event — a stale guard
      // (the user typed meanwhile) fails soft inside the shell and leaves the draft untouched.
      const guard = takePendingConsume(sessionId)
      if (guard === undefined || sessions === undefined) return
      const scope = sessions.scope(sessionId)
      if (scope !== undefined) scope.bail(scope, 'slash/input-consume-token', { guard })
    }, [sessionId])

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

    const head = data !== null ? headlineOf(data, pressure, breakdown) : null
    const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''

    return (
      <div className="lc-modal-backdrop" onClick={close}>
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
                useSession={props.useSession}
                fetchContent={fetchContent}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
              />
            </div>
          )}
        </div>
      </div>
    )
  }

  return function ContextModal(props: ContextModalProps): ReactNS.ReactElement | null {
    return h(ErrorBoundary, null, h(ContextModalBody, props))
  }
}
