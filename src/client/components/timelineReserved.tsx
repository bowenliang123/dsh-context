import type { ReactElement, ReactNode } from 'react'
import type { Category } from '../../shared/types'
import { CATS } from '../categories'

export function TimelineReserved(props: { children: ReactNode; catLabel: (cat: Category | 'system' | 'tools') => string }): ReactElement {
  return (
    <div className="lc-timeline-lane">
      <div className="lc-timeline-plot">{props.children}</div>
      <div className="lc-detail">
        <div className="lc-detail-head" />
        <div className="lc-brief" />
        <div className="lc-stacked-wrap"><div className="lc-stacked" /></div>
        <div className="lc-legend">
          {CATS.map(c => (
            <span key={c.key} className="lc-chip">
              <i style={{ background: c.color }} />
              <span className="lc-chip-label">{props.catLabel(c.key)}</span>
              <span className="lc-chip-nums" />
            </span>
          ))}
        </div>
      </div>
    </div>
  )
}
