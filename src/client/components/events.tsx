/**
  * Glyphs: inject/model-switch reuse the harness's shared icon set (`@deepseek-ai/dsh-client-ui-primitives`, a platform seed word);
  * compaction/prune keep the ✂ marker — no shared glyph exists for it.
 */

import type * as ReactNS from 'react'
import type { ContextEventRecord } from '../../shared/types'
import { IconBranchOutline16, IconPlusOutline16 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../i18n'
import type { ViewKit } from '../viewkit'

import { React } from '../react'

export const EVENT_ICONS: Record<string, string> = { compaction: '✂', prune: '✂', inject: '＋', model: '⇄', mode: '⇄' }

export interface EventListProps { events: ContextEventRecord[] }

export function makeEventText(t: Translate): {
  eventLabel: (ev: ContextEventRecord) => string
  eventAt: (ev: ContextEventRecord) => string | null
} {
  function eventLabel(ev: ContextEventRecord): string {
    if (ev.kind === 'compaction') return t('ev.compaction', { n: ev.count || 0 })
    if (ev.kind === 'prune') return t('ev.prune')
    if (ev.kind === 'model') return t('ev.model', { a: ev.from || '?', b: ev.to || '?' })
    if (ev.kind === 'mode') return t('ev.mode.' + (ev.name || '?'))
    // The kind union narrows to 'inject' here; a future kind breaks the
    // compile (ev.sub ev.form ev.name are inject-only), forcing a label.
    if (ev.sub === 'skill') return t('ev.skill', { name: ev.name || '?' })
    const base = t('form.' + (ev.form || 'context'))
    let label = ev.name ? base + ' · ' + ev.name : base
    if (ev.detail) label += ' · ' + ev.detail
    return label
  }

  /**
    * Where this event sits in the timeline: boundary events (compaction/prune) label the GAP they sit in — same-turn 'Turn 2 · Step 3→4',
    * cross-turn 'Turn 50 · Step 8 → Turn 51 · Step 1'; other kinds keep their single point; no turn/step (in flight) → null.
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
    // Hooks stay unconditional (Rules of Hooks): events going empty ->
    // non-empty in one mounted instance must not grow the hook count — an
    // early return above these hooks is a React #310 class bug (issue #12).
    const rootRef = React.useRef<HTMLDivElement | null>(null)
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
      return () => { window.removeEventListener('resize', sync) }
    })
    if (props.events.length === 0) {
      return <div className="lc-empty">{t('events.empty')}</div>
    }
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
            <div key={`${ev.seq}-${i}`} className="lc-event">
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
