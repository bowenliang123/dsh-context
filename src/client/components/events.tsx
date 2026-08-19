/**
 * Context events — event text helpers (label + timeline range) and the
 * EventList component that renders the events column.
 *
 * JSX function components: glyphs for injection/model-switch reuse the
 * harness's shared icon set (`@deepseek-ai/dsh-client-ui-primitives`, a
 * platform seed word resolved from the loader module table); compaction and
 * prune keep the ✂ marker (product vocabulary, no shared glyph exists).
 * Each row carries a kind chip (注入/压缩/剪枝/切换) so the classification is
 * readable at a glance; chip color matches the impact direction (+ adds,
 * − frees, ⇄ neutral), mirroring the token sign colors. Long labels truncate
 * with an ellipsis; the native title tooltip is attached only while the
 * label actually overflows (re-measured on every render and on resize).
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranchOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import { fmt } from '../format'
import type { Translate } from '../i18n'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', inject: '＋', model: '⇄' }

export interface EventListProps { events: ContextEventRecord[] }

/** Build the event text helpers bound to the translate function. */
export function makeEventText(t: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return t('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return t('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'inject') {
      if (ev.sub === 'skill') return t('ev.skill', { name: ev.name || '?' })
      const base = t('form.' + (ev.form || 'context'))
      return ev.name ? base + ' · ' + ev.name : base
    }
    return ev.kind
  }

  /**
   * Where this event sits in the request timeline, as a label or null.
   * Boundary events (compaction/prune) show the GAP they sit in: same-turn
   * "Step 2→3", cross-turn "Turn 50 · Step 8 → Turn 51 · Step 1". Injections
   * and model switches belong to one request and keep the single point.
   * Events with no following request (in flight) stay unlabeled.
   */
  function eventAt(ev: ContextEventRecord): string | null {
    if (ev.kind === 'compaction' || ev.kind === 'prune') {
      if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
        if (typeof ev.fromTurn === 'number' && typeof ev.fromStep === 'number') {
          if (ev.fromTurn === ev.turn) return t('events.range', { t: ev.turn, a: ev.fromStep, b: ev.step })
          return t('events.rangeTo', { a: ev.fromTurn, as: ev.fromStep, b: ev.turn, bs: ev.step })
        }
        return t('events.at', { t: ev.turn, s: ev.step })
      }
      return null
    }
    if (typeof ev.turn === 'number' && typeof ev.step === 'number') {
      return t('events.at', { t: ev.turn, s: ev.step })
    }
    return null
  }

  return { eventLabel, eventAt }
}

export function makeEventList(kit: ViewKit): (props: EventListProps) => ReactNS.ReactElement {
  const { t, fmt, fmtTime, eventLabel, eventAt } = kit
  return function EventList(props: EventListProps): ReactNS.ReactElement {
    if (props.events.length === 0) {
      return <div className="lc-empty">{t('events.empty')}</div>
    }
    const rootRef = React.useRef<HTMLDivElement | null>(null)
    // Attach the native tooltip only where the ellipsis actually truncates:
    // re-sync after every render (events/width change) and on window resize,
    // reading scrollWidth vs clientWidth on the live row.
    React.useLayoutEffect(() => {
      const root = rootRef.current
      if (!root) return
      const sync = () => {
        for (const el of root.querySelectorAll<HTMLElement>('.lc-event-label')) {
          el.title = el.scrollWidth > el.clientWidth ? el.textContent || '' : ''
        }
      }
      sync()
      window.addEventListener('resize', sync)
      return () => window.removeEventListener('resize', sync)
    })
    const sorted = props.events.slice().reverse()
    return (
      <div className="lc-events" ref={rootRef}>
        {sorted.map((ev, i) => {
          const label = eventLabel(ev)
          const at = eventAt(ev)
          const glyph = ev.kind === 'inject' ? <IconPlusOutline16 />
            : ev.kind === 'model' ? <IconBranchOutline16 />
            : EVENT_ICONS[ev.kind] || '•'
          return (
            <div key={ev.seq + '-' + i} className="lc-event">
              <span className={'lc-event-icon lc-event-' + ev.kind}>{glyph}</span>
              <span className={'lc-kind lc-kind-' + ev.kind}>{t('kind.' + ev.kind)}</span>
              <span className="lc-event-label">{label}</span>
              {at !== null ? <span className="lc-event-at">{at}</span> : null}
              {ev.tokens ? (
                <span className={'lc-event-tokens' + (ev.kind === 'inject' ? ' lc-up' : ' lc-down')}>
                  {(ev.kind === 'inject' ? '+' : '−') + fmt(ev.tokens)}
                </span>
              ) : null}
              <span className="lc-event-time">{fmtTime(ev.time)}</span>
            </div>
          )
        })}
      </div>
    )
  }
}
