/**
 * The stats cards' slice rows: the donut's legend with numbers, two tiers
 * per slice — the primary line pairs the color dot and the name with the
 * bold share closing a fixed right column, and the secondary line drops the
 * absolute quantity (plus a qualifier like the call count) under the name in
 * muted small print. No tracks or bars — the donut IS the proportion chart;
 * the rows are its legend. Preformatted strings in, dumb markup out.
 */

import type * as ReactNS from 'react'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export interface SliceRow {
  key: string
  color: string
  label: string
  /** Preformatted leading share ('84%', '<1%', '—'). */
  pct: string
  /** Preformatted secondary line ('204.9k', '4m 0s · 10 calls'); empty renders no line. */
  count: string
  /** A zero-figure slice dims whole — the ring already carries the share. */
  dim?: boolean
}

export function makeSliceList(kit: ViewKit): (props: { rows: SliceRow[] }) => ReactNS.ReactElement {
  void kit
  return function SliceList(props: { rows: SliceRow[] }): ReactNS.ReactElement {
    return (
      <div className="lc-sl">
        {props.rows.map(r => (
          <div key={r.key} className={'lc-sl-row' + (r.dim ? ' lc-sl-row-dim' : '')}>
            <div className="lc-sl-main">
              <i className="lc-sl-dot" style={{ background: r.color }} />
              <span className="lc-sl-label" title={r.label}>{r.label}</span>
              <span className="lc-sl-pct">{r.pct}</span>
            </div>
            {r.count !== '' ? <div className="lc-sl-sub" title={r.count}>{r.count}</div> : null}
          </div>
        ))}
      </div>
    )
  }
}
