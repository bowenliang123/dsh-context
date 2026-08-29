/**
 * The stats cards' slice rows: one line per donut segment — the color dot +
 * label, the trailing quantity (a token count, or call count · duration), and
 * the bold share closing the row at the right edge, where the column of
 * percentages lines up. No tracks or bars — the donut IS the proportion
 * chart; the rows are its legend with numbers. Preformatted strings in, dumb
 * markup out.
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
  /** Preformatted trailing quantity ('204.9k', '16 次 · 29.6秒'); empty renders nothing. */
  count: string
}

export function makeSliceList(kit: ViewKit): (props: { rows: SliceRow[] }) => ReactNS.ReactElement {
  void kit
  return function SliceList(props: { rows: SliceRow[] }): ReactNS.ReactElement {
    return (
      <div className="lc-sl">
        {props.rows.map(r => (
          <div key={r.key} className="lc-sl-row">
            <i className="lc-sl-dot" style={{ background: r.color }} />
            <span className="lc-sl-label">{r.label}</span>
            {r.count !== '' ? <span className="lc-sl-count">{r.count}</span> : null}
            <span className="lc-sl-pct">{r.pct}</span>
          </div>
        ))}
      </div>
    )
  }
}
