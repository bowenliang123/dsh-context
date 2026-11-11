import { useState, type ReactElement } from 'react'
import type { TokenPartTotal } from '../overview'
import type { ViewKit } from '../viewkit'

import { SliceList } from './sliceList'
import type { DonutProps } from './donut'
import { tokenRowsOf } from './tokenRows'
import { IconDatabase } from '../primitives'
import { SkeletonRows } from './skeleton'

export function makeOverviewTokens(kit: ViewKit, Donut: (props: DonutProps) => ReactElement): (props: {
  tokens: { parts: TokenPartTotal[]; total: number } | null
  pending?: boolean
}) => ReactElement {
  const { t, fmt } = kit
  return function OverviewTokens(props: {
    tokens: { parts: TokenPartTotal[]; total: number } | null
    pending?: boolean
  }): ReactElement {
    const [hoverKey, setHoverKey] = useState<string | null>(null)
    const tokens = props.tokens
    const total = tokens?.total ?? 0
    const shown = tokens !== null && total > 0 ? tokens.parts.filter(p => p.value > 0) : []
    const rows = tokenRowsOf(kit, shown, total)
    return (
      <div className="lc-card lc-col-donut flex-1 min-w-[min(360px,100%)]">
        <div className="lc-card-title">
          <span className="lc-card-title-text">
            <IconDatabase size={14} />
            {t('tokens.title')}
          </span>
        </div>
        {shown.length === 0
          ? (props.pending === true
            ? (
              <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
                <span className="lc-skel-donut" aria-hidden="true" />
                <SkeletonRows rows={6} />
              </div>
            )
            : <div className="lc-empty">{t('ov.stats.empty')}</div>)
          : (
            <div className="lc-donut-row flex items-center justify-start gap-3 min-w-0 @max-[320px]/lc-card:gap-2 @max-[240px]/lc-card:flex-wrap">
              <Donut
                segments={shown.map(p => ({ key: p.key, color: p.color, value: p.value }))}
                size={96}
                centerTop={fmt(total)}
                centerSub={t('tokens.total')}
                hoverKey={hoverKey}
                onHoverKey={setHoverKey}
              />
              <SliceList rows={rows} hoverKey={hoverKey} onHoverKey={setHoverKey} />
            </div>
          )}
      </div>
    )
  }
}
