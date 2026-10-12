import { type ReactElement } from 'react'
import type { PartsPart } from '../categories'
import { wireGapOf, type Headline } from '../headline'
import type { ViewKit } from '../viewkit'
import { AUTO_COMPACT_RATIO } from './stackedBar'
import type { StackedBarProps } from './stackedBar'

type LegendFn = (props: {
  parts: PartsPart[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}) => ReactElement

export interface CurrentCompositionProps {
  head: Headline
  subtitle?: string
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function makeCurrentComposition(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  Legend: LegendFn,
): (props: CurrentCompositionProps) => ReactElement {
  const { t, fmt } = kit
  return function CurrentComposition(props: CurrentCompositionProps): ReactElement {
    const head = props.head
    const reserve = head.window != null && head.window > 0
      ? { ratio: AUTO_COMPACT_RATIO, label: t('overview.compactReserve', { pct: Math.round(AUTO_COMPACT_RATIO * 100) }) }
      : undefined
    const gapSampled = wireGapOf(head)
    return (
      <div className="lc-card" data-lc-current>
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
              {/* One decimal: the card's reading of the kernel's occupancy percent (headline.ts). */}
              <b>{`${head.pct.toFixed(1)}%`}</b>
              {t('overview.used')}
            </span>
          ) : null}
          {gapSampled !== null ? (
            <span className="lc-overview-wire" title={t('overview.wireTip')}>
              <b>{fmt(gapSampled)}</b>
              {' '}
              {t('overview.wireCarried')}
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
