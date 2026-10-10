/**
 * The shared comms-row rendering for the inspector and the comms timeline: one row's parties
 * (sender button pinning into the inspector, arrow, recipient) and its text — where a
 * `subagent-settled` notice's English boilerplate maps to the localized variant, raw text kept on
 * the tooltip.
 */

import type { ReactElement } from 'react'
import { settledVariantOf, type CommsRow } from '../fleetDetail'
import type { ViewKit } from '../viewkit'

/** The row's display text: the localized settled variant, else the raw excerpt. */
export function commsTextOf(row: CommsRow, t: ViewKit['t']): string {
  const settled = row.kind === 'settled' ? settledVariantOf(row.text) : null
  return settled !== null ? t(`fleet.settled.${settled}`) : row.text
}

/** The `from → to` party chain; an unattested sender leaves just the arrow and the recipient. */
export function CommsParties(props: {
  row: CommsRow
  /** Highlight the current agent's own side as plain text instead of a button. */
  selfId?: string
  labelOf: (id: string) => string
  onPin: (id: string | null) => void
  peerClass: string
}): ReactElement {
  const { row, labelOf } = props
  const from = row.from
  const fromLabel = row.fromName ?? (from !== undefined ? labelOf(from) : undefined)
  const fromIsSelf = from !== undefined && from === props.selfId
  return (
    <>
      {from !== undefined && !fromIsSelf ? (
        <button type="button" className={props.peerClass} onClick={() => { props.onPin(from) }}>
          {fromLabel}
        </button>
      ) : fromLabel !== undefined ? (
        <span className={props.peerClass}>{fromLabel}</span>
      ) : null}
      <span className="lc-comms-arrow">→</span>
      <button type="button" className={props.peerClass} onClick={() => { props.onPin(row.to) }}>
        {labelOf(row.to)}
      </button>
    </>
  )
}
