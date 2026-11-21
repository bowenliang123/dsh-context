import { type ReactElement } from 'react'

export interface SliceRow {
  key: string
  color: string
  label: string
  pct: string
  count: string
  tip?: string
  dim?: boolean
}

export interface SliceListProps {
  rows: SliceRow[]
  hoverKey?: string | null
  onHoverKey?: (key: string | null) => void
}

export function SliceList(props: SliceListProps): ReactElement {
  const setHoverKey = props.onHoverKey
  return (
    <div className="lc-sl flex-auto @max-[240px]/lc-card:basis-full" onMouseLeave={() => { setHoverKey?.(null) }}>
      {props.rows.map(r => (
        <div
          key={r.key}
          className={'lc-sl-row'
            + (r.dim ? ' lc-sl-row-dim' : '')
            + (props.hoverKey !== undefined && props.hoverKey === r.key ? ' lc-sl-row-on' : '')}
          title={r.tip}
          {...(setHoverKey === undefined ? {} : {
            tabIndex: 0,
            onFocus: () => { setHoverKey(r.key) },
            onBlur: () => { setHoverKey(null) },
          })}
          onMouseEnter={() => { setHoverKey?.(r.key) }}
        >
          <div className="lc-sl-main">
            <i className="lc-sl-dot" style={{ background: r.color }} />
            <span className="lc-sl-label" title={r.tip ?? r.label}>{r.label}</span>
            <span className="lc-sl-pct">{r.pct}</span>
          </div>
          {r.count !== '' ? <div className="lc-sl-sub" title={r.count}>{r.count}</div> : null}
        </div>
      ))}
    </div>
  )
}
