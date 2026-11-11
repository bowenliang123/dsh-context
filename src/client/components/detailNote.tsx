import { type ReactElement } from 'react'
import type { ViewKit } from '../viewkit'
import { SkeletonBar } from './skeleton'

export function makeDetailNote(kit: ViewKit): (props: {
  state: 'loading' | 'failed'
  onRetry?: () => void
  className?: string
}) => ReactElement {
  const { t } = kit
  return function DetailNote(props: {
    state: 'loading' | 'failed'
    onRetry?: () => void
    className?: string
  }): ReactElement {
    const cls = props.className ?? 'lc-empty'
    if (props.state === 'loading') {
      return (
        <div className={cls} role="status" aria-busy="true">
          <SkeletonBar className="lc-skel-note" />
        </div>
      )
    }
    return (
      <div className={cls}>
        {props.onRetry !== undefined
          ? <button type="button" className="lc-br-retry hover:brightness-[1.15]" onClick={props.onRetry}>{t('detail.loadFailed')}</button>
          : t('detail.loadFailed')}
      </div>
    )
  }
}
