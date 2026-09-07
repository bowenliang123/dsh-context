/**
 * The detail collections' pending/failed note — the split generation's
 * visible loading story (timelineSource.ts): while the first detail read is
 * in flight the detail-driven cards show this strip instead of a misleading
 * empty state, and a settled-without-data read arms the retry button (never
 * a spinner that never resolves, never a silent empty chart). Callers guard
 * the failed state on a retry callback being wired (an unwired failure keeps
 * the plain text).
 */

import { type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'

export function makeDetailNote(kit: ViewKit): (props: {
  /** The pending kind: the first read in flight, or settled without data. */
  state: 'loading' | 'failed'
  /** The retry affordance for the failed read; absent = the note renders inert text. */
  onRetry?: () => void
  /** The container's style class: cards use the shared empty well, the browser its inline note strip. */
  className?: string
}) => ReactElement {
  const { t } = kit
  return function DetailNote(props: {
    state: 'loading' | 'failed'
    onRetry?: () => void
    className?: string
  }): ReactElement {
    const cls = props.className ?? 'lc-empty'
    if (props.state === 'loading') return <div className={cls}>{t('detail.loading')}</div>
    return (
      <div className={cls}>
        {props.onRetry !== undefined
          ? <button type="button" className="lc-br-retry" onClick={props.onRetry}>{t('detail.loadFailed')}</button>
          : t('detail.loadFailed')}
      </div>
    )
  }
}
