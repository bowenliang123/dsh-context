/**
 * The baseline-gate modal: when the host reports the running harness below
 * the supported baseline (the `unsupported` record on the pushed
 * `contextTimeline` value — see host/fallback.ts), the Context tab keeps
 * rendering its (zeroed) cards and this centered dialog names the detected
 * harness version against the required minimum and urges the upgrade.
 *
 * Dismissal is remembered per session in a module-level ledger: tab remounts
 * do not re-pop it, while a fresh app launch does — the gate stays visible
 * until the harness is actually updated.
 */

import type * as ReactNS from 'react'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'

import { React } from '../react'

/** Sessions whose gate the user already dismissed this browser session. */
const dismissed = new Set<string>()

export interface UpgradeGateProps {
  sessionId?: string
  /** The detected harness version (displayed verbatim, already re-proved). */
  current: string
  /** The plugin's minimum supported baseline. */
  minimum: string
}

export function makeUpgradeGate(kit: ViewKit): (props: UpgradeGateProps) => ReactNS.ReactElement | null {
  const { t } = kit
  return function UpgradeGate(props: UpgradeGateProps): ReactNS.ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    // `closedFor` re-renders on dismiss within one mount; the ledger covers
    // remounts and in-place session switches.
    const [closedFor, setClosedFor] = React.useState<string | null>(null)
    const closed = closedFor === sessionId || dismissed.has(sessionId)
    const close = React.useCallback(() => {
      dismissed.add(sessionId)
      setClosedFor(sessionId)
    }, [sessionId])

    // Same overlay contract as the /context modal (escapeClose.ts):
    // capture-phase Escape, and focus returns to the pre-open element.
    useEscapeClose(!closed, close)

    if (closed) return null

    return (
      <div className="lc-modal-backdrop" onClick={close}>
        <div className="lc-modal-card lc-gate-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('gate.title')}</span>
            <button className="lc-modal-close" aria-label={t('cmd.close')} onClick={close}>×</button>
          </div>
          <div className="lc-gate-body">{t('gate.body', { minimum: props.minimum })}</div>
          <div className="lc-gate-versions">
            <span className="lc-gate-version">
              <span className="lc-gate-version-label">{t('gate.current')}</span>
              <span className="lc-gate-version-value">v{props.current}</span>
            </span>
            <span className="lc-gate-version">
              <span className="lc-gate-version-label">{t('gate.minimum')}</span>
              <span className="lc-gate-version-value">
                v{props.minimum}
                <span className="lc-gate-or-newer">{t('gate.orNewer')}</span>
              </span>
            </span>
          </div>
          <div className="lc-gate-actions">
            <button type="button" className="lc-gate-ok" onClick={close}>{t('gate.ok')}</button>
          </div>
        </div>
      </div>
    )
  }
}
