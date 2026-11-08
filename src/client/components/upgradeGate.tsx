import { useCallback, useState, type ReactElement } from 'react'
import { registerRetentionCleanup, trimRetentionMap } from '../retention'
import type { ViewKit } from '../viewkit'
import { useEscapeClose } from './escapeClose'

const dismissed = new Map<string, true>()

const DISMISSED_SCOPE = 'upgradeDismissed'

registerRetentionCleanup(() => { dismissed.clear() })

export interface UpgradeGateProps {
  sessionId?: string
  current: string
  minimum: string
}

export function makeUpgradeGate(kit: ViewKit): (props: UpgradeGateProps) => ReactElement | null {
  const { t } = kit
  return function UpgradeGate(props: UpgradeGateProps): ReactElement | null {
    const sessionId = typeof props.sessionId === 'string' ? props.sessionId : ''
    const [closedFor, setClosedFor] = useState<string | null>(null)
    const closed = closedFor === sessionId || dismissed.has(sessionId)
    const close = useCallback(() => {
      dismissed.set(sessionId, true)
      trimRetentionMap(dismissed, DISMISSED_SCOPE)
      setClosedFor(sessionId)
    }, [sessionId])

    useEscapeClose(!closed, close)

    if (closed) return null

    return (
      <div className="lc-modal-backdrop" onClick={close}>
        <div className="lc-modal-card lc-gate-card" onClick={(ev) => { ev.stopPropagation() }}>
          <div className="lc-modal-head">
            <span className="lc-modal-title">{t('gate.title')}</span>
            <button className="lc-modal-close hover:text-(--dsw-alias-label-primary) hover:bg-(--dsw-alias-interactive-bg-hover)" aria-label={t('cmd.close')} onClick={close}>×</button>
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
            <button type="button" className="lc-gate-ok hover:brightness-110" onClick={close}>{t('gate.ok')}</button>
          </div>
        </div>
      </div>
    )
  }
}
