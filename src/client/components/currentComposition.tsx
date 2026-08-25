import type * as ReactNS from 'react'
import type { PartsPart } from '../categories'
import type { Headline } from '../headline'
import type { ViewKit } from '../viewkit'
import { AUTO_COMPACT_RATIO } from './stackedBar'
import type { StackedBarProps } from './stackedBar'

import { React } from '../react'

type LegendFn = (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactNS.ReactElement

export interface CurrentCompositionProps {
  head: Headline
  subtitle?: string
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function makeCurrentComposition(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactNS.ReactElement,
  Legend: LegendFn,
): (props: CurrentCompositionProps) => ReactNS.ReactElement {
  const { t, fmt } = kit
  return function CurrentComposition(props: CurrentCompositionProps): ReactNS.ReactElement {
    const head = props.head
    const reserve = head.window != null && head.window > 0
      ? { ratio: AUTO_COMPACT_RATIO, label: t('overview.compactReserve', { pct: Math.round(AUTO_COMPACT_RATIO * 100) }) }
      : undefined
    return (
      <div className="lc-card">
        <div className="lc-card-title">
          <span className="lc-card-title-text">{t('overview.title')}</span>
          {props.subtitle !== undefined && props.subtitle !== ''
            ? <span className="lc-card-sub">{props.subtitle}</span>
            : null}
        </div>
        <div className="lc-overview-num">
          <b>{fmt(head.tokens)}</b>
          <span>
            {head.window
              ? ' / ' + fmt(head.window) + ' tokens'
              : ' ' + t('overview.estimate')}
          </span>
          {head.pct !== null ? (
            <span className="lc-overview-pct">
              <b>{`${head.pct}%`}</b>
              {t('overview.used')}
            </span>
          ) : null}
        </div>
        <StackedBar
          parts={head.parts}
          height={16}
          max={head.window}
          hoverKey={props.hoverKey}
          onHoverKey={props.onHoverKey}
          reserve={reserve}
        />
        <Legend parts={head.parts} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} />
      </div>
    )
  }
}
