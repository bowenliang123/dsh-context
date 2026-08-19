/**
 * ContextModal — the /context command's centered dialog: the same data as
 * the Context tab (the pushed `contextTimeline` projection) distilled to
 * the current-composition overview (headline + composition bar + legend)
 * and the shared Context browser (browse any retained step's assembled
 * surface). Rendered from the `conversation.input.overlay` slot; opens and
 * closes through the per-session modal store (the trigger source flips it,
 * so no message ever enters the session history).
 */

import type * as ReactNS from 'react'
import { headlineOf } from '../headline'
import { modalStoreOf, takePendingConsume } from '../modalStore'
import type { ClientCtx, SessionStandardProps, SessionsFace } from '../services'
import { contextPressureOf, headersOf, timelineOf } from '../services'
import type { ViewKit } from '../viewkit'
import { makeContextBrowser } from './browser'
import { makeCurrentComposition } from './currentComposition'
import { makeLegend, makeStackedBar } from './stackedBar'

import { React } from '../react'

export interface ContextModalProps extends SessionStandardProps {
  /** Bound selector hook over the per-session open flag (hooks compartment). */
  useContextModal?: (sel: (open: boolean) => boolean) => boolean
}

export function makeContextModal(ctx: ClientCtx, kit: ViewKit): (props: ContextModalProps) => ReactNS.ReactElement | null {
  const { t } = kit
  const sessions = ctx.get('sessions') as SessionsFace | undefined
  const StackedBar = makeStackedBar(kit)
  const Legend = makeLegend(kit)
  // The /context popup reuses the SAME cards as the Context tab — no
  // duplicated browsing logic; picking, accordion, reconstruction and paging
  // all ride the shared components (joining the modal overview's hover link
  // while the browser shows the live step, and the tool chips jumping it).
  const CurrentComposition = makeCurrentComposition(kit, StackedBar, Legend)
  const ContextBrowser = makeContextBrowser(kit, StackedBar)

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
    // Header-content epochs for the browser's system/tools sections (absent
    // on older hosts -> tokens-only degradation, same as the Context tab).
    const headers = typeof props.useProjection === 'function'
      ? headersOf(props.useProjection('contextHeaders'))
      : null
    const [hoverCat, setHoverCat] = React.useState<string | null>(null)
    // One-shot tool-focus from the CurrentComposition card's chips into the
    // embedded Context browser (label = category-only, chip = specific tool).
    const [toolFocus, setToolFocus] = React.useState<{ tool?: string } | null>(null)

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

    const head = data !== null ? headlineOf(data, pressure) : null
    // The composition card carries the model/provider subtitle; keep the
    // dialog header to just the title + close (model/provider below once).
    const subtitle = data !== null ? (data.model ? data.model : '') + (data.provider ? ' · ' + data.provider : '') : ''

    return (
      <div className="lc-modal-backdrop" onClick={close}>
        <div className="lc-modal-card" onClick={ev => { ev.stopPropagation() }}>
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
                tools={data.toolList}
                onToolFocus={setToolFocus}
              />
              <ContextBrowser
                data={data}
                headers={headers}
                useSession={props.useSession}
                loadOlderHistory={props.loadOlderHistory}
                hoverKey={hoverCat}
                onHoverKey={setHoverCat}
                toolFocus={toolFocus}
                onToolFocusHandled={() => { setToolFocus(null) }}
              />
            </div>
          )}
        </div>
      </div>
    )
  }
}
