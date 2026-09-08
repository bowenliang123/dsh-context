import { type ReactElement, useSyncExternalStore } from 'react'
import type { PartsPart } from '../categories'
import type { ContextSettings, SettingsState } from '../settings'
import type { Headline } from '../headline'
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

/** Store fallbacks for callers without the settings binding (tests, older hosts). */
const noSubscribe = (): (() => void) => () => {}
const nullSnapshot = (): SettingsState | null => null

export function makeCurrentComposition(
  kit: ViewKit,
  StackedBar: (props: StackedBarProps) => ReactElement,
  Legend: LegendFn,
  settings?: Pick<ContextSettings, 'store'>,
): (props: CurrentCompositionProps) => ReactElement {
  const { t, fmt } = kit
  return function CurrentComposition(props: CurrentCompositionProps): ReactElement {
    const head = props.head
    // The reserve line tracks the tune bar's threshold: the tuned ratio while
    // set, the harness default (the constant above) while unset — the same
    // value the tuning pass overlays onto the engines.
    const tuned = useSyncExternalStore(
      settings?.store.subscribe ?? noSubscribe,
      settings !== undefined ? settings.store.getSnapshot : nullSnapshot,
    )
    const ratio = tuned?.threshold ?? AUTO_COMPACT_RATIO
    const reserve = head.window != null && head.window > 0
      ? { ratio, label: t('overview.compactReserve', { pct: Math.round(ratio * 100) }) }
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
