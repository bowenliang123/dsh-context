import type { CSSProperties, ReactElement } from 'react'
import { MILESTONE_COLOR, MilestoneIcon } from './milestoneIcons'
import { milestoneEntryCount, type MilestoneBandItem } from './timelineMilestones'

export interface TimelineMilestoneBandProps {
  items: MilestoneBandItem[]
  activeKey: string | null
  selectedSeq: number | null
  activeTurn: number | null
  bandLabel: string
  labelOf: (item: MilestoneBandItem) => string
  onHoverItem: (item: MilestoneBandItem) => void
  onLeaveItem: () => void
  onPickItem: (item: MilestoneBandItem) => void
}

export function TimelineMilestoneBand(props: TimelineMilestoneBandProps): ReactElement {
  return (
    <div className="lc-milestones" role="group" aria-label={props.bandLabel}>
      {props.items.map((item) => {
        const group = item.group
        const active = props.activeKey === item.key
        const selected = props.selectedSeq === group.targetSeq
        const inTurn = props.activeTurn !== null && group.targetTurn === props.activeTurn
        const lead = { '--lc-ms-c': MILESTONE_COLOR[group.leadKind] } as CSSProperties
        return (
          <div
            key={item.key}
            className={'lc-ms' + (active ? ' lc-ms-active' : '') + (selected ? ' lc-ms-selected' : '') + (inTurn ? ' lc-ms-in-turn' : '')}
            style={{ left: `${item.x}px`, ...lead }}
            data-anchor={group.anchor}
            data-target-idx={group.targetIdx}
            data-target-seq={group.targetSeq}
            data-align={item.align}
          >
            <button
              type="button"
              className="lc-ms-head"
              aria-label={props.labelOf(item)}
              aria-pressed={selected}
              onClick={(ev) => { ev.stopPropagation(); props.onPickItem(item) }}
              onMouseEnter={() => { props.onHoverItem(item) }}
              onMouseMove={(ev) => { ev.stopPropagation() }}
              onMouseLeave={props.onLeaveItem}
              onFocus={(ev) => { ev.stopPropagation(); props.onHoverItem(item) }}
              onBlur={(ev) => { ev.stopPropagation(); props.onLeaveItem() }}
              onKeyDown={(ev) => {
                ev.stopPropagation()
                if (ev.key !== 'Enter' && ev.key !== ' ') return
                ev.preventDefault()
                props.onPickItem(item)
              }}
            >
              <span className="lc-ms-flags">
                {group.entries.slice(0, item.maxIcons).map((entry) => {
                  const count = milestoneEntryCount(entry)
                  return (
                    <span
                      key={entry.kind}
                      className="lc-ms-flag"
                      data-kind={entry.kind}
                      style={{ '--lc-ms-c': MILESTONE_COLOR[entry.kind] } as CSSProperties}
                    >
                      <MilestoneIcon kind={entry.kind} />
                      {count > 1 ? <span className="lc-ms-count">{count}</span> : null}
                    </span>
                  )
                })}
              </span>
            </button>
            <span className="lc-ms-pole" aria-hidden="true" />
            <span className="lc-ms-foot" aria-hidden="true" />
          </div>
        )
      })}
    </div>
  )
}
