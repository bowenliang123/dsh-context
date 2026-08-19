/**
 * CurrentComposition — the "当前构成" card shared by the Context tab and the
 * /context popup: the composition headline (occupancy vs window), the
 * composition bar (with the auto-compaction reserve band), the legend, and —
 * when a tool bridge is wired — the ranked "工具定义 Top" chips that jump the
 * Context browser to a tool section.
 *
 * JSX function component, pure (no state): everything flows through props so
 * either host drives the shared hover link and the tool focus identically.
 */

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
  /** Card subtitle (model / provider); empty hides it. */
  subtitle?: string
  /** Shared hover link (bar + legend + browser while it shows the live step). */
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
  /** Optional ranked tool schemas for the "工具定义 Top" row (absent = no chips). */
  tools?: { name: string; tokens: number }[]
  /** One-shot tool-focus request into the Context browser (omitted = no chips). */
  onToolFocus?: (focus: { tool?: string } | null) => void
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
              <b>{head.pct + '%'}</b>
              {t('overview.used')}
            </span>
          ) : null}
        </div>
        <StackedBar parts={head.parts} height={16} max={head.window} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} reserve={reserve} />
        <Legend parts={head.parts} hoverKey={props.hoverKey} onHoverKey={props.onHoverKey} />
        {props.tools !== undefined && props.tools.length > 0 ? (
          <div className="lc-tools">
            <button type="button" className="lc-tools-label" onClick={() => { if (props.onToolFocus !== undefined) props.onToolFocus({}) }}>
              {t('tools.top')}
            </button>
            {props.tools.slice().sort((a, b) => b.tokens - a.tokens).slice(0, 5).map(tool => (
              <button key={tool.name} type="button" className="lc-tool-chip" onClick={() => { if (props.onToolFocus !== undefined) props.onToolFocus({ tool: tool.name }) }}>
                {tool.name + ' ' + fmt(tool.tokens)}
              </button>
            ))}
            {props.tools.length > 5
              ? (
                <button type="button" className="lc-tools-more" onClick={() => { if (props.onToolFocus !== undefined) props.onToolFocus({}) }}>
                  {t('tools.more', { n: props.tools.length })}
                </button>
              )
              : null}
          </div>
        ) : null}
      </div>
    )
  }
}
